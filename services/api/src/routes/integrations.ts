/**
 * API keys and webhooks (layer-6 task H; SCL-09, ADM-05, GATE-04).
 *
 * - An administrator asks for a key (name, scopes, expiry of at most a
 *   year) and sees it once; it works only after a second administrator
 *   approves it, never the one who asked (G6). Either may revoke it.
 * - A webhook is an HTTPS receiver for named events; its signing secret is
 *   shown once and kept encrypted. It sends nothing until a second
 *   administrator approves it; it can be disabled.
 * - Everything is consequential (confirmed with a reason) and audited;
 *   neither a key nor a secret is ever written to the audit or a log.
 * - Frozen during break-glass, like every other grant of access (G6).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newWebhookSecret, WEBHOOK_EVENTS, webhookUrlProblem } from '@cg/adapters';
import { newApiKey } from '@cg/crypto';
import { errors, ApiError } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, uuidParam } from './helpers.ts';

const SCOPES = ['pda.read', 'eoc.read', 'resource_request.update'] as const;
const MAX_KEY_DAYS = 365;

const keyOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(SCOPES)),
  status: z.enum(['pending', 'active', 'declined', 'revoked', 'expired']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  askedByYou: z.boolean(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedReason: z.string().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
});
type KeyOut = z.infer<typeof keyOut>;

const webhookOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  status: z.enum(['pending', 'active', 'declined', 'disabled']),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  askedByYou: z.boolean(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  disabledReason: z.string().nullable(),
  deliveries: z.object({ pending: z.number(), delivered: z.number(), failed: z.number() }),
});
type WebhookOut = z.infer<typeof webhookOut>;

const deliveryOut = z.object({
  id: z.uuid(),
  event: z.enum(WEBHOOK_EVENTS),
  subjectId: z.uuid(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number().int(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

interface KeyRow {
  id: string;
  version: number;
  name: string;
  prefix: string;
  scopes: (typeof SCOPES)[number][];
  status: 'pending' | 'active' | 'declined' | 'revoked';
  expires_at: Date;
  created_at: Date;
  created_by: string;
  decided_at: Date | null;
  decision_reason: string | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  last_used_at: Date | null;
}

interface WebhookRow {
  id: string;
  version: number;
  name: string;
  url: string;
  events: (typeof WEBHOOK_EVENTS)[number][];
  status: 'pending' | 'active' | 'declined' | 'disabled';
  created_at: Date;
  created_by: string;
  decided_at: Date | null;
  decision_reason: string | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

type Names = Map<string, string>;

const keyView = (
  r: KeyRow & { decided_by?: string | null },
  names: Names,
  me: string,
  now = new Date(),
): KeyOut => ({
  id: r.id,
  version: r.version,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  // An approved key past its date reads as expired; the row keeps its decision.
  status:
    (r.status === 'active' || r.status === 'pending') && r.expires_at.getTime() <= now.getTime()
      ? 'expired'
      : r.status,
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
  createdBy: names.get(r.created_by) ?? null,
  askedByYou: r.created_by === me,
  decidedBy: r.decided_by ? (names.get(r.decided_by) ?? null) : null,
  decidedAt: iso(r.decided_at),
  decisionReason: r.decision_reason,
  revokedAt: iso(r.revoked_at),
  revokedReason: r.revoked_reason,
  lastUsedAt: iso(r.last_used_at),
});

const webhookView = (
  r: WebhookRow & { decided_by?: string | null },
  names: Names,
  me: string,
  counts: WebhookOut['deliveries'] = { pending: 0, delivered: 0, failed: 0 },
): WebhookOut => ({
  id: r.id,
  version: r.version,
  name: r.name,
  url: r.url,
  events: r.events,
  status: r.status,
  createdAt: iso(r.created_at)!,
  createdBy: names.get(r.created_by) ?? null,
  askedByYou: r.created_by === me,
  decidedBy: r.decided_by ? (names.get(r.decided_by) ?? null) : null,
  decidedAt: iso(r.decided_at),
  decisionReason: r.decision_reason,
  disabledAt: iso(r.disabled_at),
  disabledReason: r.disabled_reason,
  deliveries: counts,
});

export const integrationRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  type Trx = Parameters<Parameters<FastifyRequest['tx']>[0]>[0];
  const namesOf = async (trx: Trx, ids: (string | null | undefined)[]): Promise<Names> => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return new Map();
    const rows = await trx
      .selectFrom('cg.account')
      .select(['id', 'display_name'])
      .where('id', 'in', wanted)
      .execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  };

  // ------------------------------------------------------------------ API keys
  app.get(
    '/api-keys',
    { schema: { tags: ['integrations'], response: { 200: z.object({ keys: z.array(keyOut) }) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('api_key.read', { type: 'api_key', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cg.api_key')
          .selectAll()
          .where('tenant_id', '=', s.tenantId)
          .orderBy('created_at', 'desc')
          .limit(200)
          .execute();
        const names = await namesOf(
          trx,
          rows.flatMap((r) => [r.created_by, r.decided_by]),
        );
        return { keys: rows.map((r) => keyView(r as KeyRow, names, s.accountId)) };
      });
    },
  );

  app.post(
    '/api-keys',
    {
      schema: {
        tags: ['integrations'],
        body: z.object({
          name: z.string().trim().min(1).max(120),
          scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
          expiresInDays: z.number().int().min(1).max(MAX_KEY_DAYS),
        }),
        response: { 201: keyOut.extend({ key: z.string() }) },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('api_key.manage', { type: 'api_key', tenantId: s.tenantId });
      const { reason } = request.confirmation();
      const fresh = newApiKey();
      const out = await request.tx(async (trx) => {
        const row = await trx
          .insertInto('cg.api_key')
          .values({
            tenant_id: s.tenantId,
            name: request.body.name,
            prefix: fresh.prefix,
            secret_hash: fresh.hash,
            scopes: [...new Set(request.body.scopes)],
            expires_at: new Date(Date.now() + request.body.expiresInDays * 86_400_000),
            created_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        // The key itself is never audited or logged; the prefix names it.
        await request.audit(trx, {
          action: 'api_key.manage',
          targetType: 'api_key',
          targetId: row.id,
          targetVersion: row.version,
          changes: {
            op: 'ask',
            name: row.name,
            prefix: row.prefix,
            scopes: row.scopes,
            expiresAt: iso(row.expires_at),
          },
          reason,
        });
        const names = await namesOf(trx, [s.accountId]);
        return keyView(row as KeyRow, names, s.accountId);
      });
      return reply.code(201).send({ ...out, key: fresh.key });
    },
  );

  for (const op of ['approve', 'decline', 'revoke'] as const) {
    app.post(
      `/api-keys/:id/${op}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['integrations'], params: uuidParam, response: { 200: keyOut } },
      },
      async (request) => {
        const s = account(request);
        const expected = request.expectedVersion();
        const current = await request.tx((trx) =>
          trx
            .selectFrom('cg.api_key')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!current) throw errors.notFound();
        await request.authorize(
          'api_key.read',
          { type: 'api_key', id: current.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        // G6: approving or declining names who asked, so it is never the same person.
        await request.authorize('api_key.manage', {
          type: 'api_key',
          id: current.id,
          tenantId: s.tenantId,
          ...(op === 'revoke' ? {} : { requestedBy: current.created_by }),
        });
        const { reason } = request.confirmation();
        const now = new Date();
        const view = () => keyView(current as KeyRow, new Map(), s.accountId, now);
        if (
          op === 'revoke'
            ? current.status === 'revoked' || current.status === 'declined'
            : current.status !== 'pending'
        )
          throw errors.conflict(view());
        if (op === 'approve' && current.expires_at.getTime() <= now.getTime())
          throw new ApiError(
            409,
            'expired',
            'This key has passed its expiry date. Ask for a new one.',
          );
        return request.tx(async (trx) => {
          const row = assertUpdated(
            await trx
              .updateTable('cg.api_key')
              .set(
                op === 'revoke'
                  ? {
                      status: 'revoked',
                      revoked_by: s.accountId,
                      revoked_at: now,
                      revoked_reason: reason,
                    }
                  : {
                      status: op === 'approve' ? 'active' : 'declined',
                      decided_by: s.accountId,
                      decided_at: now,
                      decision_reason: reason,
                    },
              )
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            view(),
          );
          await request.audit(trx, {
            action: 'api_key.manage',
            targetType: 'api_key',
            targetId: row.id,
            targetVersion: row.version,
            changes: { op, prefix: row.prefix, from: current.status, to: row.status },
            reason,
          });
          const names = await namesOf(trx, [row.created_by, row.decided_by]);
          return keyView(row as KeyRow, names, s.accountId, now);
        });
      },
    );
  }

  // ------------------------------------------------------------------ webhooks
  const deliveryCounts = async (trx: Trx, ids: string[]) => {
    const out = new Map<string, WebhookOut['deliveries']>();
    if (!ids.length) return out;
    const rows = await trx
      .selectFrom('cg.webhook_delivery')
      .select(['webhook_id', 'status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('webhook_id', 'in', ids)
      .groupBy(['webhook_id', 'status'])
      .execute();
    for (const r of rows) {
      const c = out.get(r.webhook_id) ?? { pending: 0, delivered: 0, failed: 0 };
      c[r.status] = Number(r.n);
      out.set(r.webhook_id, c);
    }
    return out;
  };

  app.get(
    '/webhooks',
    {
      schema: {
        tags: ['integrations'],
        response: {
          200: z.object({ webhooks: z.array(webhookOut), events: z.array(z.enum(WEBHOOK_EVENTS)) }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('webhook.read', { type: 'webhook', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cg.webhook')
          .select([
            'id',
            'version',
            'name',
            'url',
            'events',
            'status',
            'created_at',
            'created_by',
            'decided_by',
            'decided_at',
            'decision_reason',
            'disabled_at',
            'disabled_reason',
          ])
          .where('tenant_id', '=', s.tenantId)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute();
        const names = await namesOf(
          trx,
          rows.flatMap((r) => [r.created_by, r.decided_by]),
        );
        const counts = await deliveryCounts(
          trx,
          rows.map((r) => r.id),
        );
        return {
          webhooks: rows.map((r) =>
            webhookView(r as WebhookRow, names, s.accountId, counts.get(r.id)),
          ),
          events: [...WEBHOOK_EVENTS],
        };
      });
    },
  );

  app.get(
    '/webhooks/:id/deliveries',
    {
      schema: {
        tags: ['integrations'],
        params: uuidParam,
        response: { 200: z.object({ deliveries: z.array(deliveryOut) }) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize(
        'webhook.read',
        { type: 'webhook', id: request.params.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      return request.tx(async (trx) => {
        const hook = await trx
          .selectFrom('cg.webhook')
          .select('id')
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!hook) throw errors.notFound();
        const rows = await trx
          .selectFrom('cg.webhook_delivery')
          .selectAll()
          .where('webhook_id', '=', hook.id)
          .orderBy('created_at', 'desc')
          .limit(50)
          .execute();
        return {
          deliveries: rows.map((d) => ({
            id: d.id,
            event: d.event,
            subjectId: d.subject_id,
            status: d.status,
            attempts: d.attempts,
            lastStatus: d.last_status,
            lastError: d.last_error,
            lastAttemptAt: iso(d.last_attempt_at),
            nextAttemptAt: iso(d.next_attempt_at),
            deliveredAt: iso(d.delivered_at),
            createdAt: iso(d.created_at)!,
          })),
        };
      });
    },
  );

  app.post(
    '/webhooks',
    {
      schema: {
        tags: ['integrations'],
        body: z.object({
          name: z.string().trim().min(1).max(120),
          url: z.string().trim().max(500),
          events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
        }),
        response: { 201: webhookOut.extend({ secret: z.string() }) },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const problem = webhookUrlProblem(request.body.url);
      if (problem) throw errors.validation([{ name: 'url', message: problem }]);
      await request.authorize('webhook.manage', { type: 'webhook', tenantId: s.tenantId });
      const { reason } = request.confirmation();
      const secret = newWebhookSecret();
      const secretEnc = await app.fieldCrypto.encrypt(s.tenantId, secret);
      const out = await request.tx(async (trx) => {
        const row = await trx
          .insertInto('cg.webhook')
          .values({
            tenant_id: s.tenantId,
            name: request.body.name,
            url: request.body.url,
            events: [...new Set(request.body.events)],
            secret_enc: secretEnc,
            created_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'webhook.manage',
          targetType: 'webhook',
          targetId: row.id,
          targetVersion: row.version,
          changes: { op: 'ask', name: row.name, url: row.url, events: row.events },
          reason,
        });
        const names = await namesOf(trx, [s.accountId]);
        return webhookView(row as WebhookRow, names, s.accountId);
      });
      return reply.code(201).send({ ...out, secret });
    },
  );

  for (const op of ['approve', 'decline', 'disable'] as const) {
    app.post(
      `/webhooks/:id/${op}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['integrations'], params: uuidParam, response: { 200: webhookOut } },
      },
      async (request) => {
        const s = account(request);
        const expected = request.expectedVersion();
        const current = await request.tx((trx) =>
          trx
            .selectFrom('cg.webhook')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!current) throw errors.notFound();
        await request.authorize(
          'webhook.read',
          { type: 'webhook', id: current.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        await request.authorize('webhook.manage', {
          type: 'webhook',
          id: current.id,
          tenantId: s.tenantId,
          ...(op === 'disable' ? {} : { requestedBy: current.created_by }),
        });
        const { reason } = request.confirmation();
        const view = () => webhookView(current as WebhookRow, new Map(), s.accountId);
        if (
          op === 'disable'
            ? current.status === 'disabled' || current.status === 'declined'
            : current.status !== 'pending'
        )
          throw errors.conflict(view());
        const now = new Date();
        return request.tx(async (trx) => {
          const row = assertUpdated(
            await trx
              .updateTable('cg.webhook')
              .set(
                op === 'disable'
                  ? {
                      status: 'disabled',
                      disabled_by: s.accountId,
                      disabled_at: now,
                      disabled_reason: reason,
                    }
                  : {
                      status: op === 'approve' ? 'active' : 'declined',
                      decided_by: s.accountId,
                      decided_at: now,
                      decision_reason: reason,
                    },
              )
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            view(),
          );
          await request.audit(trx, {
            action: 'webhook.manage',
            targetType: 'webhook',
            targetId: row.id,
            targetVersion: row.version,
            changes: { op, from: current.status, to: row.status },
            reason,
          });
          const names = await namesOf(trx, [row.created_by, row.decided_by]);
          const counts = await deliveryCounts(trx, [row.id]);
          return webhookView(row as WebhookRow, names, s.accountId, counts.get(row.id));
        });
      },
    );
  }
};
