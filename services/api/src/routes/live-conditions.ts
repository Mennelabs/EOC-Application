/**
 * Live conditions (CON-14; layer-8 plan §6): road closures and work zones,
 * hazards, traffic and utility outages from the county's feeds (WZDx from a
 * state DOT, the Waze for Cities partner feed, a utility's outages), each
 * shown with its source and age and marked stale when a feed has not spoken
 * for two of its periods; and staff entries, which override feeds for their
 * area until they lapse or are cleared. Feeds are the county's sources:
 * added, switched on or off, pulled on demand (the worker reaches only hosts
 * the deployment allows; development and CI replay recorded synthetic
 * feeds) or fed by file import when a county has no feed. Items describe
 * the road network or a utility area, never a home.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@cg/db';
import { applyLiveItems, LIVE_PARSERS } from '@cg/refdata';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { enqueueOutbox, iso, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type SourceRow = Selectable<Database['cg.live_source']>;

const KINDS = ['road_closure', 'work_zone', 'hazard', 'traffic', 'outage'] as const;
const SEVERITIES = ['info', 'minor', 'major'] as const;
const SOURCE_KINDS = ['wzdx', 'waze', 'utility', 'file'] as const;
const FORMATS = ['wzdx', 'waze', 'utility'] as const;
/** A staff entry with no end is shown as stale after this long. */
const STAFF_STALE_MS = 12 * 3_600_000;

const conditionOut = z.object({
  ...stamped,
  kind: z.enum(KINDS),
  summary: z.string(),
  road: z.string().nullable(),
  severity: z.enum(SEVERITIES),
  position: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  geometry: z.unknown().nullable(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  asOf: z.iso.datetime(),
  ageSeconds: z.number().int(),
  stale: z.boolean(),
  active: z.boolean(),
  override: z.boolean(),
  source: z.object({
    id: z.uuid().nullable(),
    name: z.string(),
    kind: z.string(),
  }),
  enteredBy: z.string().nullable(),
  clearedAt: z.iso.datetime().nullable(),
});
type ConditionOut = z.infer<typeof conditionOut>;
const sourceOut = z.object({
  ...stamped,
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  url: z.string().nullable(),
  enabled: z.boolean(),
  refreshMs: z.number().int(),
  lastPulledAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(['never', 'ok', 'failed']),
  lastError: z.string().nullable(),
  lastCount: z.number().int().nullable(),
  activeItems: z.number().int(),
});
const sourceView = (r: SourceRow, activeItems: number): z.infer<typeof sourceOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  kind: r.kind,
  name: r.name,
  url: r.url,
  enabled: r.enabled,
  refreshMs: r.refresh_ms,
  lastPulledAt: iso(r.last_pulled_at),
  lastStatus: r.last_status,
  lastError: r.last_error,
  lastCount: r.last_count,
  activeItems,
});

const httpsUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((u) => {
    try {
      return new URL(u).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'an https address');

export const liveConditionRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  /** Every condition of the organization with its source, position and age. */
  async function listConditions(
    trx: Trx,
    tenantId: string,
    q: { eventId?: string | undefined; includeCleared: boolean },
    now: Date,
  ): Promise<ConditionOut[]> {
    let x = trx
      .selectFrom('cg.live_condition as c')
      .leftJoin('cg.live_source as s', 's.id', 'c.source_id')
      .leftJoin('cg.account as a', 'a.id', 'c.entered_by')
      .select([
        'c.id',
        'c.version',
        'c.created_at',
        'c.updated_at',
        'c.kind',
        'c.summary',
        'c.road',
        'c.severity',
        'c.starts_at',
        'c.ends_at',
        'c.as_of',
        'c.override',
        'c.cleared_at',
        'c.source_id',
        's.name as source_name',
        's.kind as source_kind',
        's.refresh_ms',
        's.last_pulled_at',
        'a.display_name as entered_by_name',
        sql<number | null>`ST_Y(ST_Centroid(c.geom))`.as('lat'),
        sql<number | null>`ST_X(ST_Centroid(c.geom))`.as('lon'),
        sql<string | null>`ST_AsGeoJSON(c.geom)`.as('geojson'),
      ])
      .where('c.tenant_id', '=', tenantId)
      .orderBy(sql`case c.severity when 'major' then 0 when 'minor' then 1 else 2 end`)
      .orderBy('c.as_of', 'desc')
      .limit(500);
    if (!q.includeCleared) x = x.where('c.cleared_at', 'is', null);
    if (q.eventId)
      x = x.where((eb) => eb.or([eb('c.event_id', '=', q.eventId!), eb('c.event_id', 'is', null)]));
    const rows = await x.execute();
    return rows.map((r) => {
      const asOf = r.as_of.getTime();
      const age = Math.max(0, Math.round((now.getTime() - asOf) / 1000));
      const lapsed = r.ends_at !== null && r.ends_at.getTime() <= now.getTime();
      const stale = r.source_id
        ? now.getTime() - (r.last_pulled_at?.getTime() ?? asOf) >
          2 * (r.refresh_ms ?? 300_000) + 60_000
        : r.ends_at === null && now.getTime() - asOf > STAFF_STALE_MS;
      return {
        id: r.id,
        version: r.version,
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        kind: r.kind,
        summary: r.summary,
        road: r.road,
        severity: r.severity,
        position:
          r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
        geometry: r.geojson ? (JSON.parse(r.geojson) as unknown) : null,
        startsAt: iso(r.starts_at),
        endsAt: iso(r.ends_at),
        asOf: iso(r.as_of)!,
        ageSeconds: age,
        stale,
        active: r.cleared_at === null && !lapsed,
        override: r.override,
        source: {
          id: r.source_id,
          name: r.source_name ?? 'Staff entry',
          kind: r.source_kind ?? 'staff',
        },
        enteredBy: r.entered_by_name,
        clearedAt: iso(r.cleared_at),
      };
    });
  }

  app.get(
    '/live-conditions',
    {
      schema: {
        tags: ['live conditions'],
        querystring: z.object({
          eventId: z.uuid().optional(),
          includeCleared: z.coerce.boolean().default(false),
        }),
        response: { 200: z.array(conditionOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('live_condition.read', {
        type: 'live_condition',
        tenantId: s.tenantId,
        ...(request.query.eventId ? { eventId: request.query.eventId } : {}),
      });
      return request.tx((trx) => listConditions(trx, s.tenantId, request.query, new Date()));
    },
  );

  /** A staff entry: the override for its area until it lapses or is cleared. */
  app.post(
    '/live-conditions',
    {
      schema: {
        tags: ['live conditions'],
        body: z.object({
          eventId: z.uuid().optional(),
          kind: z.enum(KINDS),
          summary: z.string().trim().min(1).max(500),
          road: z.string().trim().max(200).optional(),
          severity: z.enum(SEVERITIES).default('minor'),
          position: z
            .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
            .optional(),
          line: z
            .array(
              z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
            )
            .min(2)
            .max(500)
            .optional(),
          endsAt: z.iso.datetime().optional(),
        }),
        response: { 201: conditionOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('live_condition.write', {
        type: 'live_condition',
        tenantId: s.tenantId,
        ...(b.eventId ? { eventId: b.eventId } : {}),
      });
      const geometry = b.line
        ? { type: 'LineString', coordinates: b.line.map((p) => [p.lon, p.lat]) }
        : b.position
          ? { type: 'Point', coordinates: [b.position.lon, b.position.lat] }
          : null;
      const now = new Date();
      const out = await request.tx(async (trx) => {
        if (b.eventId) {
          const ev = await trx
            .selectFrom('cg.event')
            .select('id')
            .where('id', '=', b.eventId)
            .where('tenant_id', '=', s.tenantId)
            .executeTakeFirst();
          if (!ev)
            throw errors.validation([
              { name: 'eventId', message: 'an event of this organization' },
            ]);
        }
        const r = await trx
          .insertInto('cg.live_condition')
          .values({
            tenant_id: s.tenantId,
            source_id: null,
            event_id: b.eventId ?? null,
            kind: b.kind,
            external_id: null,
            summary: b.summary,
            road: b.road || null,
            geom: geometry
              ? sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)`
              : null,
            severity: b.severity,
            starts_at: now,
            ends_at: b.endsAt ? new Date(b.endsAt) : null,
            as_of: now,
            source_ref: null,
            override: true,
            entered_by: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'live_condition.entered',
          targetType: 'live_condition',
          targetId: r.id,
          changes: {
            fields: [
              { name: 'kind', to: b.kind },
              { name: 'summary', to: b.summary },
            ],
          },
        });
        const list = await listConditions(trx, s.tenantId, { includeCleared: true }, now);
        return list.find((c) => c.id === r.id)!;
      });
      return reply.code(201).send(out);
    },
  );

  /** Clears a staff entry; a feed item is cleared by its feed, or overridden by an entry. */
  app.post(
    '/live-conditions/:id/clear',
    {
      config: { requiresVersion: true },
      schema: { tags: ['live conditions'], params: uuidParam, response: { 200: conditionOut } },
    },
    async (request) => {
      const s = account(request);
      const found = await request.tx((trx) =>
        trx
          .selectFrom('cg.live_condition')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!found || found.tenant_id !== s.tenantId) throw errors.notFound();
      await request.authorize(
        'live_condition.write',
        {
          type: 'live_condition',
          id: found.id,
          tenantId: found.tenant_id,
          ...(found.event_id ? { eventId: found.event_id } : {}),
        },
        { asNotFound: true },
      );
      if (!found.override)
        throw new ApiError(
          409,
          'feed_item',
          'A feed item is cleared by its feed; enter a condition to override it.',
        );
      if (found.cleared_at)
        throw new ApiError(409, 'already_cleared', 'This entry is already cleared.');
      const expected = request.expectedVersion();
      const now = new Date();
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.live_condition')
            .set({ cleared_at: now, cleared_by: s.accountId, updated_by: s.accountId })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await request.audit(trx, {
          action: 'live_condition.cleared',
          targetType: 'live_condition',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: [{ name: 'cleared_at' }] },
        });
        const list = await listConditions(trx, s.tenantId, { includeCleared: true }, now);
        return list.find((c) => c.id === updated.id)!;
      });
    },
  );

  // ------------------------------------------------------------ sources
  const activeCounts = async (trx: Trx, tenantId: string) => {
    const rows = await trx
      .selectFrom('cg.live_condition')
      .select(['source_id', sql<string>`count(*)`.as('n')])
      .where('tenant_id', '=', tenantId)
      .where('cleared_at', 'is', null)
      .where('source_id', 'is not', null)
      .groupBy('source_id')
      .execute();
    return new Map(rows.map((r) => [r.source_id!, Number(r.n)]));
  };
  const loadSource = async (request: FastifyRequest, id: string): Promise<SourceRow> => {
    const s = account(request);
    const r = await request.tx((trx) =>
      trx.selectFrom('cg.live_source').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!r || r.tenant_id !== s.tenantId) throw errors.notFound();
    await request.authorize(
      'live_source.manage',
      { type: 'live_source', id: r.id, tenantId: r.tenant_id },
      { asNotFound: true },
    );
    return r;
  };

  app.get(
    '/live-sources',
    { schema: { tags: ['live conditions'], response: { 200: z.array(sourceOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('live_condition.read', { type: 'live_source', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const [rows, counts] = await Promise.all([
          trx
            .selectFrom('cg.live_source')
            .selectAll()
            .where('tenant_id', '=', s.tenantId)
            .orderBy('name')
            .execute(),
          activeCounts(trx, s.tenantId),
        ]);
        return rows.map((r) => sourceView(r, counts.get(r.id) ?? 0));
      });
    },
  );

  const sourceIn = z.object({
    kind: z.enum(SOURCE_KINDS),
    name: z.string().trim().min(1).max(120),
    url: httpsUrl.optional(),
    enabled: z.boolean().default(false),
    refreshMs: z.number().int().min(60_000).max(86_400_000).default(300_000),
  });

  app.post(
    '/live-sources',
    { schema: { tags: ['live conditions'], body: sourceIn, response: { 201: sourceOut } } },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('live_source.manage', { type: 'live_source', tenantId: s.tenantId });
      if ((b.kind === 'file') !== !b.url)
        throw errors.validation([
          {
            name: 'url',
            message: b.kind === 'file' ? 'no address for a file source' : 'the feed address',
          },
        ]);
      const out = await request.tx(async (trx) => {
        const r = await trx
          .insertInto('cg.live_source')
          .values({
            tenant_id: s.tenantId,
            kind: b.kind,
            name: b.name,
            url: b.url ?? null,
            enabled: b.enabled,
            refresh_ms: b.refreshMs,
            last_error: null,
            last_count: null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'live_source.added',
          targetType: 'live_source',
          targetId: r.id,
          targetVersion: r.version,
          changes: {
            fields: [
              { name: 'kind', to: r.kind },
              { name: 'name', to: r.name },
              { name: 'url', to: r.url ?? '' },
            ],
          },
        });
        if (r.enabled && r.url)
          await enqueueOutbox(
            trx,
            s.tenantId,
            'live.pull',
            { sourceId: r.id, requestedBy: s.accountId },
            null,
          );
        return sourceView(r, 0);
      });
      return reply.code(201).send(out);
    },
  );

  app.patch(
    '/live-sources/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['live conditions'],
        params: uuidParam,
        body: sourceIn.omit({ kind: true }).partial(),
        response: { 200: sourceOut },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await loadSource(request, request.params.id);
      const b = request.body;
      if (found.kind === 'file' && b.url)
        throw errors.validation([{ name: 'url', message: 'no address for a file source' }]);
      const expected = request.expectedVersion();
      const set = {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.url !== undefined ? { url: b.url } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.refreshMs !== undefined ? { refresh_ms: b.refreshMs } : {}),
      };
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.live_source')
            .set({ ...set, updated_by: s.accountId })
            .where('id', '=', found.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          found,
        );
        await request.audit(trx, {
          action: 'live_source.changed',
          targetType: 'live_source',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: { fields: Object.keys(set).map((name) => ({ name })) },
        });
        if (!updated.enabled && found.enabled) {
          // Switched off: its items leave the board at once, never silently.
          await trx
            .updateTable('cg.live_condition')
            .set({ cleared_at: new Date(), cleared_by: s.accountId, updated_by: s.accountId })
            .where('source_id', '=', updated.id)
            .where('cleared_at', 'is', null)
            .execute();
        }
        const counts = await activeCounts(trx, s.tenantId);
        return sourceView(updated, counts.get(updated.id) ?? 0);
      });
    },
  );

  /** Asks the worker to pull now; the result shows on the source. */
  app.post(
    '/live-sources/:id/pull',
    {
      schema: {
        tags: ['live conditions'],
        params: uuidParam,
        response: { 202: z.object({ queued: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const found = await loadSource(request, request.params.id);
      if (found.kind === 'file' || !found.url)
        throw new ApiError(409, 'file_source', 'A file source is fed by import, not pulled.');
      await request.tx((trx) =>
        enqueueOutbox(
          trx,
          s.tenantId,
          'live.pull',
          { sourceId: found.id, requestedBy: s.accountId },
          null,
        ),
      );
      return reply.code(202).send({ queued: true });
    },
  );

  /** File import: the feed document in its source's format, applied at once (ADR-0041 fallback). */
  app.post(
    '/live-sources/:id/import',
    {
      schema: {
        tags: ['live conditions'],
        params: uuidParam,
        body: z.object({ format: z.enum(FORMATS).optional(), document: z.unknown() }),
        response: {
          200: sourceOut.extend({
            upserted: z.number().int(),
            cleared: z.number().int(),
            skipped: z.number().int(),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      const found = await loadSource(request, request.params.id);
      const format =
        found.kind === 'file' ? request.body.format : (found.kind as (typeof FORMATS)[number]);
      if (!format) throw errors.validation([{ name: 'format', message: 'wzdx, waze or utility' }]);
      const now = new Date();
      const parsed = LIVE_PARSERS[format](request.body.document, now);
      return request.tx(async (trx) => {
        const applied = await applyLiveItems(trx, found, parsed.items, now, s.accountId);
        const updated = await trx
          .updateTable('cg.live_source')
          .set({
            last_pulled_at: now,
            last_status: 'ok',
            last_error: null,
            last_count: applied.upserted,
            updated_by: s.accountId,
          })
          .where('id', '=', found.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'live_source.imported',
          targetType: 'live_source',
          targetId: updated.id,
          changes: {
            format,
            upserted: applied.upserted,
            cleared: applied.cleared,
            skipped: parsed.skipped.length,
          },
        });
        const counts = await activeCounts(trx, s.tenantId);
        return {
          ...sourceView(updated, counts.get(updated.id) ?? 0),
          upserted: applied.upserted,
          cleared: applied.cleared,
          skipped: parsed.skipped.length,
        };
      });
    },
  );
};
