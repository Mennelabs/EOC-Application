/**
 * Inbound channel webhooks (CHN-03/04/05, BRD:FR-17.05, SEC-17, docs/06):
 * Twilio texts, calls and delivery receipts, each checked against the
 * account signature and resolved to a tenant by the county number it was
 * sent to; and, on synthetic data only, a simulator that plays the phone so
 * the whole flow runs on a laptop without a carrier (SCL-11, SCL-12).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { normalisePhone } from '@cg/crypto';
import { ApiError, errors } from '../errors.ts';
import type { TenantResolver } from '../public/tenant-resolver.ts';
import type { ChannelSessions, ChannelTenant, VoiceStep } from './session.ts';
import { spokenLines, twimlMessages, twimlVoice, verifyTwilioSignature } from './twilio.ts';

export interface WebhookDeps {
  resolver: TenantResolver;
  sessions: ChannelSessions;
  /** Without an auth token no Twilio request can be verified, so none is accepted. */
  twilio?: { authToken: string } | undefined;
  /** The base Twilio was configured with, when the gateway reports another (signature check). */
  publicBase?: string | undefined;
  /** The simulator exists only on synthetic data (SCL-12). */
  simulator: boolean;
}

const twilioText = z
  .object({
    From: z.string().min(3),
    To: z.string().min(3),
    Body: z.string().default(''),
    NumMedia: z.coerce.number().int().min(0).default(0),
    MessageSid: z.string().optional(),
  })
  .loose();

const twilioVoice = z
  .object({
    From: z.string().min(3),
    To: z.string().min(3),
    CallSid: z.string().optional(),
    Digits: z.string().optional(),
    SpeechResult: z.string().optional(),
  })
  .loose();

const twilioStatus = z
  .object({
    MessageSid: z.string().min(1),
    MessageStatus: z.string().min(1),
    From: z.string().min(3),
    To: z.string().optional(),
    ErrorCode: z.string().optional(),
  })
  .loose();

const voiceStep = z.object({
  step: z
    .enum([
      'start',
      'language',
      'answer',
      'repeat',
      'sites_en',
      'sites_es',
      'sites_menu_en',
      'sites_menu_es',
    ])
    .default('start'),
});

export const VOICE_PATH = '/api/webhooks/twilio/voice';

export const webhookRoutes =
  (deps: WebhookDeps): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();

    // Twilio posts forms; the rest of the API speaks JSON.
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err as Error);
        }
      },
    );

    function requestUrl(request: FastifyRequest): string {
      const base = deps.publicBase ?? `${request.protocol}://${request.hostname}`;
      return `${base}${request.raw.url ?? request.url}`;
    }

    /** Every Twilio request proves it came from the account (docs/06); anything else is refused. */
    function verify(request: FastifyRequest): void {
      if (!deps.twilio) throw new ApiError(403, 'twilio_not_configured', 'Forbidden.');
      const params = (request.body ?? {}) as Record<string, unknown>;
      const flat = Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
      );
      const signature = request.headers['x-twilio-signature'];
      const ok = verifyTwilioSignature(
        deps.twilio.authToken,
        requestUrl(request),
        flat,
        typeof signature === 'string' ? signature : undefined,
      );
      if (!ok) throw new ApiError(403, 'bad_signature', 'Forbidden.');
    }

    async function tenantFor(request: FastifyRequest, number: string): Promise<ChannelTenant> {
      const tenant = await deps.resolver.byNumber(normalisePhone(number));
      if (tenant.status !== 'active') throw errors.notFound();
      const s = request.subject;
      if (s.kind === 'public') request.subject = { ...s, tenantId: tenant.id };
      await request.authorize('intake.submit', { type: 'report', tenantId: tenant.id });
      return tenant;
    }

    function mediaOf(body: Record<string, unknown>, count: number) {
      const media: { url: string; contentType: string }[] = [];
      for (let i = 0; i < Math.min(count, 10); i++) {
        const url = body[`MediaUrl${i}`];
        const contentType = body[`MediaContentType${i}`];
        if (typeof url === 'string' && typeof contentType === 'string')
          media.push({ url, contentType });
      }
      return media;
    }

    // ----------------------------------------------------------- Twilio
    app.post(
      '/twilio/sms',
      { schema: { tags: ['channels'], body: twilioText } },
      async (request, reply) => {
        verify(request);
        const tenant = await tenantFor(request, request.body.To);
        const replies = await deps.sessions.handleText(request, tenant, {
          from: request.body.From,
          body: request.body.Body,
          media: mediaOf(request.body as Record<string, unknown>, request.body.NumMedia),
          provider: 'twilio',
        });
        return reply.type('text/xml').send(twimlMessages(replies));
      },
    );

    app.post(
      '/twilio/voice',
      { schema: { tags: ['channels'], body: twilioVoice, querystring: voiceStep } },
      async (request, reply) => {
        verify(request);
        const tenant = await tenantFor(request, request.body.To);
        const call: VoiceStep = {
          from: request.body.From,
          step: request.query.step,
          digits: request.body.Digits,
          speech: request.body.SpeechResult,
          actionBase: VOICE_PATH,
        };
        const body = await deps.sessions.handleVoice(request, tenant, call);
        return reply.type('text/xml').send(twimlVoice(body));
      },
    );

    /** Delivery receipts: the message row follows the carrier's word (BRD:FR-17.05). */
    app.post(
      '/twilio/status',
      { schema: { tags: ['channels'], body: twilioStatus } },
      async (request, reply) => {
        verify(request);
        const tenant = await tenantFor(request, request.body.From);
        const status = request.body.MessageStatus;
        const patch =
          status === 'delivered'
            ? { state: 'delivered' as const, delivered_at: new Date() }
            : status === 'failed' || status === 'undelivered'
              ? {
                  state: 'failed' as const,
                  failed_at: new Date(),
                  error: `twilio:${status}${request.body.ErrorCode ? ` ${request.body.ErrorCode}` : ''}`,
                }
              : null;
        if (patch) {
          await request.tx(async (trx) => {
            const res = await trx
              .updateTable('cg.message')
              .set(patch)
              .where('tenant_id', '=', tenant.id)
              .where('provider', '=', 'twilio')
              .where('provider_message_id', '=', request.body.MessageSid)
              .where('state', 'in', ['queued', 'sent'])
              .executeTakeFirst();
            if (Number(res.numUpdatedRows ?? 0) > 0)
              await request.audit(trx, {
                action: 'message.status',
                targetType: 'message',
                targetId: request.body.MessageSid,
                changes: { fields: [{ name: 'state', to: patch.state }] },
              });
          });
        }
        return reply.code(204).send();
      },
    );

    // -------------------------------------------------------- simulator
    if (!deps.simulator) return;

    const simulatorText = z.object({
      from: z.string().min(3),
      /** The county number; the tenant slug is accepted instead. */
      to: z.string().optional(),
      tenant: z.string().optional(),
      body: z.string().default(''),
      media: z
        .array(z.object({ contentType: z.string(), dataBase64: z.string() }))
        .max(5)
        .default([]),
    });

    async function simulatorTenant(request: FastifyRequest, to?: string, slug?: string) {
      const tenant = to
        ? await deps.resolver.byNumber(normalisePhone(to))
        : slug
          ? await deps.resolver.bySlug(slug)
          : null;
      if (!tenant)
        throw new ApiError(400, 'tenant_required', 'Give "to" (the county number) or "tenant".');
      const s = request.subject;
      if (s.kind === 'public') request.subject = { ...s, tenantId: tenant.id };
      await request.authorize('intake.submit', { type: 'report', tenantId: tenant.id });
      return tenant;
    }

    /** Plays the phone: one text in, the replies out (what a resident would see). */
    app.post(
      '/simulator/sms',
      { schema: { tags: ['channels (simulator)'], body: simulatorText } },
      async (request) => {
        const tenant = await simulatorTenant(request, request.body.to, request.body.tenant);
        const replies = await deps.sessions.handleText(request, tenant, {
          from: request.body.from,
          body: request.body.body,
          media: request.body.media.map((m) => ({
            url: `data:${m.contentType};base64,${m.dataBase64}`,
            contentType: m.contentType,
          })),
          provider: 'simulator',
        });
        return { replies };
      },
    );

    app.post(
      '/simulator/voice',
      {
        schema: {
          tags: ['channels (simulator)'],
          body: z.object({
            from: z.string().min(3),
            to: z.string().optional(),
            tenant: z.string().optional(),
            step: z
              .enum([
                'start',
                'language',
                'answer',
                'repeat',
                'sites_en',
                'sites_es',
                'sites_menu_en',
                'sites_menu_es',
              ])
              .default('start'),
            digits: z.string().optional(),
            speech: z.string().optional(),
          }),
        },
      },
      async (request) => {
        const tenant = await simulatorTenant(request, request.body.to, request.body.tenant);
        const body = await deps.sessions.handleVoice(request, tenant, {
          from: request.body.from,
          step: request.body.step,
          digits: request.body.digits,
          speech: request.body.speech,
          actionBase: VOICE_PATH,
        });
        const twiml = twimlVoice(body);
        const hangup = twiml.includes('<Hangup');
        const next = twiml.match(/step=(\w+)"/)?.[1] ?? (hangup ? null : 'repeat');
        return { twiml, say: spokenLines(twiml), nextStep: next, hangup };
      },
    );
  };
