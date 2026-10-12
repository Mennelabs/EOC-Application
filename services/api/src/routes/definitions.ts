/**
 * Governed definitions (BRD:FR-00.10, FR-18.05), retention policies and
 * legal holds (SEC-13). Definitions are versioned and never edited in
 * place; retention for audit can never drop below seven years (plan §8.3);
 * legal holds override deletion until released.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { diffForAudit } from '@cg/audit';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso, stamped, uuidParam } from './helpers.ts';

const AUDIT_FLOOR_DAYS = 7 * 365;

const definitionOut = z.object({
  key: z.string(),
  version: z.number().int(),
  value: z.unknown(),
  reason: z.string().nullable(),
  effectiveFrom: z.iso.datetime(),
  createdBy: z.uuid().nullable(),
});

const retentionOut = z.object({
  dataCategory: z.string(),
  keepForDays: z.number().int().nullable(),
  rule: z.enum(['duration', 'on_confirm', 'external']),
  note: z.string().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});

const holdOut = z.object({
  ...stamped,
  scope: z.record(z.string(), z.unknown()),
  reason: z.string(),
  placedBy: z.uuid(),
  placedAt: z.iso.datetime(),
  releasedBy: z.uuid().nullable(),
  releasedAt: z.iso.datetime().nullable(),
});

const keyParam = z.object({
  key: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_.-]+$/),
});

/** Postgres interval text → whole days (what the API exposes). */
function intervalToDays(v: string | null): number | null {
  if (!v) return null;
  const m = /(\d+)\s*year/.exec(v);
  const d = /(\d+)\s*day/.exec(v);
  const mons = /(\d+)\s*mon/.exec(v);
  let days = 0;
  if (m?.[1]) days += Number(m[1]) * 365;
  if (mons?.[1]) days += Number(mons[1]) * 30;
  if (d?.[1]) days += Number(d[1]);
  return days || null;
}

export const definitionRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  // --- governed definitions ---------------------------------------------------
  app.get(
    '/definitions',
    { schema: { tags: ['definitions'], response: { 200: z.array(definitionOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('definition.read', {
        type: 'governed_definition',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        sql<{
          key: string;
          version: number;
          value: unknown;
          reason: string | null;
          effective_from: Date;
          created_by: string | null;
        }>`select key, version, value, reason, effective_from, created_by
           from cg.governed_definition_current where tenant_id = ${s.tenantId} order by key`.execute(
          trx,
        ),
      );
      return rows.rows.map((r) => ({
        key: r.key,
        version: r.version,
        value: r.value,
        reason: r.reason,
        effectiveFrom: iso(r.effective_from)!,
        createdBy: r.created_by,
      }));
    },
  );

  app.get(
    '/definitions/:key',
    {
      schema: {
        tags: ['definitions'],
        params: keyParam,
        response: { 200: z.array(definitionOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('definition.read', {
        type: 'governed_definition',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.governed_definition')
          .selectAll()
          .where('key', '=', request.params.key)
          .orderBy('version', 'desc')
          .execute(),
      );
      if (rows.length === 0) throw errors.notFound();
      return rows.map((r) => ({
        key: r.key,
        version: r.version,
        value: r.value,
        reason: r.reason,
        effectiveFrom: iso(r.effective_from)!,
        createdBy: r.created_by,
      }));
    },
  );

  app.put(
    '/definitions/:key',
    {
      config: { idempotent: false },
      schema: {
        tags: ['definitions'],
        params: keyParam,
        body: z.object({ value: z.unknown(), effectiveFrom: z.iso.datetime().optional() }),
        response: { 201: definitionOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('definition.write', {
        type: 'governed_definition',
        tenantId: s.tenantId,
      });
      const { reason } = request.confirmation();
      const row = await request.tx(async (trx) => {
        const last = await trx
          .selectFrom('cg.governed_definition')
          .select((eb) => eb.fn.max('version').as('max'))
          .where('key', '=', request.params.key)
          .executeTakeFirstOrThrow();
        const previous = last.max
          ? await trx
              .selectFrom('cg.governed_definition')
              .select('value')
              .where('key', '=', request.params.key)
              .where('version', '=', Number(last.max))
              .executeTakeFirst()
          : undefined;
        const inserted = await trx
          .insertInto('cg.governed_definition')
          .values({
            tenant_id: s.tenantId,
            key: request.params.key,
            version: Number(last.max ?? 0) + 1,
            value: JSON.stringify(request.body.value ?? null),
            reason,
            ...(request.body.effectiveFrom
              ? { effective_from: new Date(request.body.effectiveFrom) }
              : {}),
            created_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'definition.write',
          targetType: 'governed_definition',
          targetId: request.params.key,
          targetVersion: inserted.version,
          changes: diffForAudit(
            { value: previous?.value },
            { value: inserted.value },
            classifierFor('governed_definition'),
          ),
          reason,
        });
        return inserted;
      });
      return reply.code(201).send({
        key: row.key,
        version: row.version,
        value: row.value,
        reason: row.reason,
        effectiveFrom: iso(row.effective_from)!,
        createdBy: row.created_by,
      });
    },
  );

  // --- retention (SEC-13) -------------------------------------------------------
  app.get(
    '/retention',
    { schema: { tags: ['retention'], response: { 200: z.array(retentionOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('retention.read', { type: 'retention_policy', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx.selectFrom('cg.retention_policy').selectAll().orderBy('data_category').execute(),
      );
      return rows.map((r) => ({
        dataCategory: r.data_category,
        keepForDays: intervalToDays(r.keep_for),
        rule: r.rule,
        note: r.note,
        version: r.version,
        updatedAt: iso(r.updated_at)!,
      }));
    },
  );

  app.put(
    '/retention/:category',
    {
      schema: {
        tags: ['retention'],
        params: z.object({
          category: z
            .string()
            .min(1)
            .max(60)
            .regex(/^[a-z_]+$/),
        }),
        body: z.object({
          keepForDays: z.number().int().min(1).max(36500).nullable(),
          rule: z.enum(['duration', 'on_confirm', 'external']).default('duration'),
          note: z.string().max(500).optional(),
        }),
        response: { 200: retentionOut },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('retention.write', {
        type: 'retention_policy',
        tenantId: s.tenantId,
      });
      const { reason } = request.confirmation();
      const { category } = request.params;
      const body = request.body;
      if ((body.rule === 'duration') !== (body.keepForDays !== null)) {
        throw errors.validation([
          { name: 'keepForDays', message: 'required for rule=duration, absent otherwise' },
        ]);
      }
      if (
        category === 'audit' &&
        (body.rule !== 'duration' || (body.keepForDays ?? 0) < AUDIT_FLOOR_DAYS)
      ) {
        throw errors.validation([
          {
            name: 'keepForDays',
            message: 'audit retention cannot be shorter than 7 years (SEC-13)',
          },
        ]);
      }
      if (category === 'cji') {
        throw errors.validation([
          { name: 'category', message: 'CJIS retention is governed in the enclave (SEC-12)' },
        ]);
      }
      const keepFor = body.keepForDays === null ? null : `${body.keepForDays} days`;
      const row = await request.tx(async (trx) => {
        const existing = await trx
          .selectFrom('cg.retention_policy')
          .selectAll()
          .where('data_category', '=', category)
          .executeTakeFirst();
        let saved;
        if (existing) {
          const expected = request.expectedVersion();
          saved = assertUpdated(
            await trx
              .updateTable('cg.retention_policy')
              .set({
                keep_for: keepFor,
                rule: body.rule,
                note: body.note ?? null,
                updated_by: s.accountId,
              })
              .where('tenant_id', '=', s.tenantId)
              .where('data_category', '=', category)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            { dataCategory: category, version: existing.version },
          );
        } else {
          saved = await trx
            .insertInto('cg.retention_policy')
            .values({
              tenant_id: s.tenantId,
              data_category: category,
              keep_for: keepFor,
              rule: body.rule,
              note: body.note ?? null,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        await request.audit(trx, {
          action: 'retention.write',
          targetType: 'retention_policy',
          targetId: category,
          targetVersion: saved.version,
          changes: diffForAudit(
            existing ? { keep_for: existing.keep_for, rule: existing.rule } : null,
            { keep_for: saved.keep_for, rule: saved.rule },
            classifierFor('retention_policy'),
          ),
          reason,
        });
        return saved;
      });
      return {
        dataCategory: row.data_category,
        keepForDays: intervalToDays(row.keep_for),
        rule: row.rule,
        note: row.note,
        version: row.version,
        updatedAt: iso(row.updated_at)!,
      };
    },
  );

  // --- legal holds (SEC-13: holds override deletion) ----------------------------
  const toHold = (r: {
    id: string;
    version: number;
    created_at: Date;
    updated_at: Date;
    scope: unknown;
    reason: string;
    placed_by: string;
    placed_at: Date;
    released_by: string | null;
    released_at: Date | null;
  }): z.infer<typeof holdOut> => ({
    id: r.id,
    version: r.version,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    scope: (r.scope as Record<string, unknown>) ?? {},
    reason: r.reason,
    placedBy: r.placed_by,
    placedAt: iso(r.placed_at)!,
    releasedBy: r.released_by,
    releasedAt: iso(r.released_at),
  });

  app.get(
    '/legal-holds',
    { schema: { tags: ['retention'], response: { 200: z.array(holdOut) } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('legal_hold.read', { type: 'legal_hold', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx.selectFrom('cg.legal_hold').selectAll().orderBy('placed_at', 'desc').execute(),
      );
      return rows.map(toHold);
    },
  );

  app.post(
    '/legal-holds',
    {
      config: { idempotent: true },
      schema: {
        tags: ['retention'],
        body: z.object({
          scope: z
            .object({
              targetType: z.string().max(60).optional(),
              targetId: z.string().max(200).optional(),
              eventId: z.uuid().optional(),
              dataCategory: z.string().max(60).optional(),
            })
            .refine(
              (sc) => Object.values(sc).some((v) => v !== undefined),
              'scope needs at least one selector',
            ),
          reason: z.string().min(10).max(1000),
        }),
        response: { 201: holdOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('legal_hold.place', { type: 'legal_hold', tenantId: s.tenantId });
      const { reason } = request.confirmation();
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.legal_hold')
          .values({
            tenant_id: s.tenantId,
            scope: JSON.stringify(request.body.scope),
            reason: request.body.reason,
            placed_by: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'legal_hold.place',
          targetType: 'legal_hold',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(null, { scope: request.body.scope }, classifierFor('legal_hold')),
          reason: `${request.body.reason} | confirmation: ${reason ?? ''}`,
        });
        return inserted;
      });
      return reply.code(201).send(toHold(row));
    },
  );

  app.post(
    '/legal-holds/:id/release',
    {
      config: { requiresVersion: true },
      schema: { tags: ['retention'], params: uuidParam, response: { 200: holdOut } },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.legal_hold')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'legal_hold.release',
        { type: 'legal_hold', id: current.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      const { reason } = request.confirmation();
      if (current.released_at) throw errors.conflict(toHold(current));
      const updated = await request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.legal_hold')
            .set({ released_at: new Date(), released_by: s.accountId, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toHold(current),
        );
        await request.audit(trx, {
          action: 'legal_hold.release',
          targetType: 'legal_hold',
          targetId: row.id,
          targetVersion: row.version,
          reason,
        });
        return row;
      });
      return toHold(updated);
    },
  );
};
