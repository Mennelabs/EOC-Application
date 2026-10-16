/**
 * Walk-up volunteers register themselves by QR (FL:FR-20). Reception opens a
 * link for the event and shows or prints its code; a volunteer opens it on
 * their own phone, reads the county's waiver (when the county gave its text)
 * and says which skills they have, from a fixed list. Their request waits at
 * the desk under a four-character desk code, the only thing the answer gives
 * back. Reception completes the registration (background-check status,
 * team, check-in, badge) or declines it.
 *
 * The name and contact are encrypted and erased once reception decides. An
 * unknown, closed or expired link, or one whose event has closed, is simply
 * not found. Requests are limited per address and per link, and a retried
 * submission makes no second request.
 */
import { createHash, randomInt } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errors } from '../errors.ts';
import { WindowCounter } from './abuse.ts';

/** Skills a volunteer can name for themselves; reception verifies them later (PER-01). */
export const VOLUNTEER_SKILLS = [
  'chainsaw',
  'spanish_speaker',
  'cert',
  'ham_operator',
  'medical',
  'driver_cdl',
  'heavy_equipment',
  'shelter_management',
  'food_safety',
  'child_safeguarding',
  'mental_health_first_aid',
] as const;

/** Desk codes avoid letters and digits that look alike (0/O, 1/I/L). */
const DESK_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const deskCode = () =>
  Array.from({ length: 4 }, () => DESK_ALPHABET[randomInt(DESK_ALPHABET.length)]).join('');

export const signupTokenHash = (token: string) => createHash('sha256').update(token).digest();

/** At most this many requests through one link; a desk cannot work through more. */
const PER_LINK = 500;

const params = z.object({
  tenant: z.string().min(2).max(60),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const volunteerSignupRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const perAddress = new WindowCounter(60 * 60_000);
  const lookups = new WindowCounter(10 * 60_000);
  const tenantOf = (request: FastifyRequest) => {
    const t = (request as FastifyRequest & { publicTenant?: { id: string } }).publicTenant;
    if (!t) throw errors.notFound();
    return t;
  };
  const gone = () =>
    new ApiError(
      404,
      'not_found',
      'This sign-up code has closed. Please ask at the volunteer desk.',
    );
  /** The open link a token names, with its event still open. */
  const openLink = (request: FastifyRequest, tenantId: string, token: string) =>
    request.tx((trx) =>
      trx
        .selectFrom('cg.volunteer_signup_link as k')
        .innerJoin('cg.event as e', 'e.id', 'k.event_id')
        .select([
          'k.id',
          'k.event_id',
          'k.waiver_version',
          'k.waiver_text',
          'k.expires_at',
          'e.name as event_name',
        ])
        .where('k.tenant_id', '=', tenantId)
        .where('k.token_hash', '=', signupTokenHash(token))
        .where('k.closed_at', 'is', null)
        .where('k.expires_at', '>', new Date())
        .where('e.status', '=', 'active')
        .executeTakeFirst(),
    );

  app.get(
    '/volunteers/:tenant/join/:token',
    {
      schema: {
        tags: ['public volunteers'],
        params,
        querystring: z.object({ lang: z.string().min(2).max(10).optional() }),
        response: {
          200: z.object({
            eventName: z.string(),
            waiverVersion: z.string(),
            /** The county's waiver in the asked language, else English; null means sign at the desk. */
            waiver: z.string().nullable(),
            waiverLang: z.string().nullable(),
            skills: z.array(z.string()),
            expiresAt: z.iso.datetime(),
          }),
        },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      await request.authorize('volunteer.self_register', {
        type: 'volunteer_signup',
        tenantId: tenant.id,
      });
      if (request.ip && lookups.hit(request.ip) > 60)
        throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Please try later.', {
          retryable: true,
        });
      const link = await openLink(request, tenant.id, request.params.token);
      if (!link) throw gone();
      const texts = link.waiver_text ?? {};
      const lang = request.query.lang?.slice(0, 2);
      const waiverLang = lang && texts[lang] ? lang : texts['en'] ? 'en' : null;
      return {
        eventName: link.event_name,
        waiverVersion: link.waiver_version,
        waiver: waiverLang ? texts[waiverLang]! : null,
        waiverLang,
        skills: [...VOLUNTEER_SKILLS],
        expiresAt: link.expires_at.toISOString(),
      };
    },
  );

  app.post(
    '/volunteers/:tenant/join/:token',
    {
      schema: {
        tags: ['public volunteers'],
        params,
        body: z.object({
          executionId: z.uuid(),
          person: z.object({
            name: z.string().trim().min(2).max(120),
            phone: z.string().trim().min(7).max(20).optional(),
            email: z.email().max(200).optional(),
            agency: z.string().trim().max(200).optional(),
          }),
          skills: z
            .array(z.enum(VOLUNTEER_SKILLS))
            .max(VOLUNTEER_SKILLS.length)
            .default([])
            .transform((s) => [...new Set(s)]),
          /** Required when the link shows the county's waiver text. */
          waiverAccepted: z.literal(true).optional(),
        }),
        response: {
          202: z.object({
            received: z.literal(true),
            deskCode: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      await request.authorize('volunteer.self_register', {
        type: 'volunteer_signup',
        tenantId: tenant.id,
      });
      if (request.ip && perAddress.hit(request.ip) > 30)
        throw new ApiError(
          429,
          'too_many_signups',
          'Too many sign-ups from here. Please ask at the volunteer desk.',
          { retryable: true },
        );
      const link = await openLink(request, tenant.id, request.params.token);
      if (!link) throw gone();
      const b = request.body;
      const withText = Object.values(link.waiver_text ?? {}).some((t) => t.trim());
      if (withText && !b.waiverAccepted)
        throw errors.validation([
          { name: 'waiverAccepted', message: 'read and accept the waiver to continue' },
        ]);
      const earlier = () =>
        request.tx((trx) =>
          trx
            .selectFrom('cg.volunteer_signup')
            .select('desk_code')
            .where('tenant_id', '=', tenant.id)
            .where('execution_id', '=', b.executionId)
            .executeTakeFirst(),
        );
      const answer = (code: string) =>
        reply.code(202).send({
          received: true,
          deskCode: code,
          message: 'Thank you. Show this code at the volunteer desk to finish signing up.',
        });
      const seen = await earlier();
      if (seen) return answer(seen.desk_code);
      const details = await base.fieldCrypto.encrypt(tenant.id, JSON.stringify(b.person));
      // A new desk code on the rare clash with one already given through this link.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const code = deskCode();
        try {
          const made = await request.tx(async (trx) => {
            const used = await trx
              .selectFrom('cg.volunteer_signup')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('link_id', '=', link.id)
              .executeTakeFirstOrThrow();
            if (Number(used.n) >= PER_LINK)
              throw new ApiError(
                429,
                'desk_full',
                'The volunteer desk has a long list. Please ask a staff member.',
                { retryable: true },
              );
            const row = await trx
              .insertInto('cg.volunteer_signup')
              .values({
                tenant_id: tenant.id,
                event_id: link.event_id,
                link_id: link.id,
                execution_id: b.executionId,
                desk_code: code,
                details_enc: details,
                skills: b.skills,
                waiver_version: link.waiver_version,
                waiver_accepted_at: withText ? new Date() : null,
              })
              .onConflict((oc) => oc.columns(['tenant_id', 'execution_id']).doNothing())
              .returning(['id', 'version', 'desk_code'])
              .executeTakeFirst();
            if (row)
              await request.audit(trx, {
                action: 'volunteer.self_registered',
                targetType: 'volunteer_signup',
                targetId: row.id,
                targetVersion: row.version,
                executionId: b.executionId,
              });
            return row;
          });
          if (made) return answer(made.desk_code);
          const again = await earlier();
          if (again) return answer(again.desk_code);
        } catch (err) {
          if ((err as { code?: string }).code !== '23505') throw err;
        }
      }
      throw new ApiError(503, 'try_again', 'Please try again.', { retryable: true });
    },
  );
};
