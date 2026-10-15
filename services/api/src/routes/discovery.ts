/**
 * Resource discovery (layer-7 task F; REC-13, REC-14). The county names its
 * own sources (an HSDS service directory, an open-data CSV or GeoJSON feed;
 * web search where the AI register allows it); the worker reads them with the
 * services partners posted, on the tenant's schedule or when asked. Places
 * found wait in the review queue with their source links, what is known, what
 * is unknown and the pre-check; a person qualifies each in or out with a
 * reason. Qualifying a place in enters it in the registry (county EM, who
 * approves the registry); a change to a registered place (closed, updated) is
 * applied the same way. Nothing changes the registry without that decision.
 * A rejected place stays rejected until something about it changes.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { feedUrlProblem } from '@cg/adapters';
import type { Database, DiscoveryCandidateTable, DiscoverySourceTable } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type SourceRow = Selectable<DiscoverySourceTable>;
type CandidateRow = Selectable<DiscoveryCandidateTable>;

const kinds = [
  'school',
  'place_of_worship',
  'community_center',
  'parking_lot',
  'government',
  'commercial',
  'other',
] as const;

const sourceOut = z.object({
  ...stamped,
  kind: z.enum(['hsds', 'csv', 'geojson', 'web_search']),
  name: z.string(),
  url: z.string().nullable(),
  enabled: z.boolean(),
  lastRunAt: z.iso.datetime().nullable(),
  lastOutcome: z.string().nullable(),
});
const sourceToOut = (r: SourceRow): z.infer<typeof sourceOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  kind: r.kind,
  name: r.name,
  url: r.url,
  enabled: r.enabled,
  lastRunAt: iso(r.last_run_at),
  lastOutcome: r.last_outcome,
});

const runOut = z.object({
  ...stamped,
  state: z.enum(['requested', 'running', 'done', 'failed']),
  requestedBy: z.uuid().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  summary: z.record(z.string(), z.unknown()),
});

const candidateOut = z.object({
  ...stamped,
  state: z.enum(['pending', 'accepted', 'rejected']),
  change: z.enum(['new', 'update', 'closed']),
  sourceKind: z.string(),
  sourceName: z.string().nullable(),
  facilityId: z.uuid().nullable(),
  facilityName: z.string().nullable(),
  name: z.string(),
  kind: z.enum(kinds),
  address: z
    .object({
      line1: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postal: z.string().nullable(),
    })
    .nullable(),
  position: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  attributes: z.record(z.string(), z.unknown()),
  unknown: z.array(z.string()),
  sourceLinks: z.array(z.string()),
  precheck: z.record(z.string(), z.unknown()),
  note: z.string().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  seenCount: z.number().int(),
  nearUnmetNeed: z.boolean(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
});
type CandidateOut = z.infer<typeof candidateOut>;

const candidateToOut = (
  r: CandidateRow,
  names: { source: string | null; facility: string | null },
): CandidateOut => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  state: r.state,
  change: r.change,
  sourceKind: r.source_kind,
  sourceName: names.source,
  facilityId: r.facility_id,
  facilityName: names.facility,
  name: r.name,
  kind: r.kind,
  address: r.address,
  position: r.lat !== null && r.lon !== null ? { lat: r.lat, lon: r.lon } : null,
  attributes: r.attributes,
  unknown: r.unknown,
  sourceLinks: r.source_links,
  precheck: r.precheck,
  note: r.note,
  firstSeenAt: iso(r.first_seen_at)!,
  lastSeenAt: iso(r.last_seen_at)!,
  seenCount: r.seen_count,
  nearUnmetNeed: r.near_unmet_need,
  decidedBy: r.decided_by,
  decidedAt: iso(r.decided_at),
  decisionReason: r.decision_reason,
});

async function namesFor(trx: Trx, rows: CandidateRow[]) {
  const sourceIds = [...new Set(rows.map((r) => r.source_id).filter((x): x is string => !!x))];
  const facilityIds = [...new Set(rows.map((r) => r.facility_id).filter((x): x is string => !!x))];
  const sources = sourceIds.length
    ? await trx
        .selectFrom('cg.discovery_source')
        .select(['id', 'name'])
        .where('id', 'in', sourceIds)
        .execute()
    : [];
  const facilities = facilityIds.length
    ? await trx
        .selectFrom('cg.facility')
        .select(['id', 'name'])
        .where('id', 'in', facilityIds)
        .execute()
    : [];
  return (r: CandidateRow) => ({
    source:
      r.source_kind === 'partner_post'
        ? 'Partner posts'
        : (sources.find((s) => s.id === r.source_id)?.name ?? null),
    facility: facilities.find((f) => f.id === r.facility_id)?.name ?? null,
  });
}

/** What a candidate states, as registry columns (nothing guessed: REC-10). */
function registryColumns(a: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  const pick: [string, string, (v: unknown) => unknown][] = [
    ['sqft', 'sqft', num],
    ['ada', 'ada', bool],
    ['powerBackup', 'power_backup', (v) => (typeof v === 'string' ? v : undefined)],
    ['kitchen', 'kitchen', bool],
    ['showers', 'showers', num],
    ['petPolicy', 'pet_policy', (v) => (typeof v === 'string' ? v : undefined)],
    ['parkingSpaces', 'parking_spaces', num],
    ['truckAccess', 'truck_access', bool],
  ];
  for (const [k, col, f] of pick) {
    const v = f(a[k]);
    if (v !== undefined) out[col] = v;
  }
  return out;
}

const noteFor = (c: CandidateRow) => {
  const a = c.attributes;
  const parts = [
    typeof a['hours'] === 'string' ? `Hours: ${a['hours']}` : null,
    typeof a['website'] === 'string' ? `Website: ${a['website']}` : null,
    c.note,
    c.source_links.length ? `Found at: ${c.source_links.slice(0, 3).join(', ')}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join('\n').slice(0, 2000) : null;
};

export const discoveryRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  // ---------------------------------------------------------------- sources (discovery.manage)
  app.get(
    '/discovery/sources',
    { schema: { tags: ['discovery'], response: { 200: z.array(sourceOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('discovery.manage', {
        type: 'discovery_source',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx.selectFrom('cg.discovery_source').selectAll().orderBy('created_at').execute(),
      );
      return rows.map(sourceToOut);
    },
  );

  app.post(
    '/discovery/sources',
    {
      config: { idempotent: true },
      schema: {
        tags: ['discovery'],
        body: z
          .object({
            kind: z.enum(['hsds', 'csv', 'geojson', 'web_search']),
            name: z.string().trim().min(2).max(120),
            url: z.string().trim().max(500).optional(),
          })
          .refine(
            (b) => (b.kind === 'web_search') === !b.url,
            'a feed needs its address; web search has none',
          ),
        response: { 201: sourceOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('discovery.manage', {
        type: 'discovery_source',
        tenantId: s.tenantId,
      });
      const b = request.body;
      if (b.url) {
        const problem = feedUrlProblem(b.url);
        if (problem) throw errors.validation([{ name: 'url', message: problem }]);
      }
      const row = await request.tx(async (trx) => {
        if (b.kind === 'web_search') {
          const has = await trx
            .selectFrom('cg.discovery_source')
            .select('id')
            .where('kind', '=', 'web_search')
            .executeTakeFirst();
          if (has)
            throw new ApiError(409, 'already_listed', 'Web search is already a source here.');
        }
        const inserted = await trx
          .insertInto('cg.discovery_source')
          .values({
            tenant_id: s.tenantId,
            kind: b.kind,
            name: b.name,
            url: b.url ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'discovery.source_added',
          targetType: 'discovery_source',
          targetId: inserted.id,
          targetVersion: inserted.version,
          reason: `${b.kind}: ${b.name}`,
        });
        return inserted;
      });
      return reply.code(201).send(sourceToOut(row));
    },
  );

  app.patch(
    '/discovery/sources/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['discovery'],
        params: uuidParam,
        body: z.object({
          enabled: z.boolean().optional(),
          name: z.string().trim().min(2).max(120).optional(),
        }),
        response: { 200: sourceOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('discovery.manage', {
        type: 'discovery_source',
        tenantId: s.tenantId,
      });
      const b = request.body;
      return sourceToOut(
        await request.tx(async (trx) => {
          const cur = await trx
            .selectFrom('cg.discovery_source')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!cur) throw errors.notFound();
          if (cur.version !== request.expectedVersion()) throw errors.conflict(sourceToOut(cur));
          const row = await trx
            .updateTable('cg.discovery_source')
            .set({
              ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
              ...(b.name !== undefined ? { name: b.name } : {}),
              updated_by: s.accountId,
            })
            .where('id', '=', cur.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'discovery.source_changed',
            targetType: 'discovery_source',
            targetId: row.id,
            targetVersion: row.version,
            changes: {
              fields: [
                ...(b.enabled !== undefined
                  ? [{ name: 'enabled', from: cur.enabled, to: row.enabled }]
                  : []),
                ...(b.name !== undefined ? [{ name: 'name', from: cur.name, to: row.name }] : []),
              ],
            },
          });
          return row;
        }),
      );
    },
  );

  // ---------------------------------------------------------------- runs (discovery.review)
  app.post(
    '/discovery/runs',
    {
      config: { idempotent: true },
      schema: { tags: ['discovery'], response: { 202: runOut } },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('discovery.review', {
        type: 'discovery_candidate',
        tenantId: s.tenantId,
      });
      const row = await request.tx(async (trx) => {
        const open = await trx
          .selectFrom('cg.discovery_run')
          .selectAll()
          .where('state', 'in', ['requested', 'running'])
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        if (open) return open;
        const inserted = await trx
          .insertInto('cg.discovery_run')
          .values({
            tenant_id: s.tenantId,
            state: 'requested',
            requested_by: s.accountId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'discovery.run_requested',
          targetType: 'discovery_run',
          targetId: inserted.id,
          targetVersion: inserted.version,
        });
        return inserted;
      });
      return reply.code(202).send({
        id: row.id,
        version: row.version,
        createdAt: iso(row.created_at)!,
        updatedAt: iso(row.updated_at)!,
        state: row.state,
        requestedBy: row.requested_by,
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        summary: row.summary,
      });
    },
  );

  app.get(
    '/discovery/runs',
    {
      schema: { tags: ['discovery'], querystring: listQuery, response: { 200: z.array(runOut) } },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('discovery.review', {
        type: 'discovery_candidate',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.discovery_run')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map((r) => ({
        id: r.id,
        version: r.version,
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        state: r.state,
        requestedBy: r.requested_by,
        startedAt: iso(r.started_at),
        finishedAt: iso(r.finished_at),
        summary: r.summary,
      }));
    },
  );

  // ---------------------------------------------------------------- candidates (discovery.review)
  app.get(
    '/discovery/candidates',
    {
      schema: {
        tags: ['discovery'],
        querystring: listQuery.extend({
          state: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
        }),
        response: { 200: z.array(candidateOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('discovery.review', {
        type: 'discovery_candidate',
        tenantId: s.tenantId,
      });
      const q = request.query;
      return request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cg.discovery_candidate')
          .selectAll()
          .where('state', '=', q.state)
          // High-value candidates near unmet need first (REC-14), then the newest.
          .orderBy('near_unmet_need', 'desc')
          .orderBy(q.state === 'pending' ? 'created_at' : 'decided_at', 'desc')
          .limit(q.limit)
          .offset(q.offset)
          .execute();
        const names = await namesFor(trx, rows);
        return rows.map((r) => candidateToOut(r, names(r)));
      });
    },
  );

  app.get(
    '/discovery/candidates/:id',
    { schema: { tags: ['discovery'], params: uuidParam, response: { 200: candidateOut } } },
    async (request) => {
      const s = account(request);
      await request.authorize('discovery.review', {
        type: 'discovery_candidate',
        tenantId: s.tenantId,
      });
      return request.tx(async (trx) => {
        const r = await trx
          .selectFrom('cg.discovery_candidate')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!r) throw errors.notFound();
        return candidateToOut(r, (await namesFor(trx, [r]))(r));
      });
    },
  );

  app.post(
    '/discovery/candidates/:id/decision',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['discovery'],
        params: uuidParam,
        body: z.object({
          decision: z.enum(['accept', 'reject']),
          reason: z.string().trim().min(3).max(500),
          /** Accepting a new place: the reviewer may correct its name or kind. */
          name: z.string().trim().min(2).max(200).optional(),
          kind: z.enum(kinds).optional(),
        }),
        response: { 200: candidateOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('discovery.review', {
        type: 'discovery_candidate',
        tenantId: s.tenantId,
      });
      const b = request.body;
      // Qualifying a place in changes the registry: only those who approve it may.
      if (b.decision === 'accept')
        await request.authorize('facility.approve', { type: 'facility', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const c = await trx
          .selectFrom('cg.discovery_candidate')
          .selectAll()
          .where('id', '=', request.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!c) throw errors.notFound();
        if (c.version !== request.expectedVersion())
          throw errors.conflict(candidateToOut(c, (await namesFor(trx, [c]))(c)));
        if (c.state !== 'pending')
          throw new ApiError(409, 'already_decided', 'This place was already decided.');
        let facilityId = c.facility_id;
        if (b.decision === 'accept') {
          if (c.change === 'new') {
            const loc =
              c.address || (c.lat !== null && c.lon !== null)
                ? await trx
                    .insertInto('cg.location')
                    .values({
                      tenant_id: s.tenantId,
                      line1: c.address?.line1 ?? null,
                      city: c.address?.city ?? null,
                      state: c.address?.state ?? null,
                      postal: c.address?.postal ?? null,
                      no_fixed_address: !c.address?.line1,
                      geom:
                        c.lat !== null && c.lon !== null
                          ? sql`ST_SetSRID(ST_MakePoint(${c.lon}, ${c.lat}), 4326)`
                          : null,
                      precision: c.lat !== null ? 'exact' : 'unknown',
                      source: 'reviewer',
                      created_by: s.accountId,
                      updated_by: s.accountId,
                    })
                    .returning('id')
                    .executeTakeFirstOrThrow()
                : null;
            const f = await trx
              .insertInto('cg.facility')
              .values({
                tenant_id: s.tenantId,
                name: b.name ?? c.name,
                kind: b.kind ?? c.kind,
                location_id: loc?.id ?? null,
                ...registryColumns(c.attributes),
                notes: noteFor(c),
                contacts_enc: null,
                owner_tenant_id: null,
                mou_expires_on: null,
                source: 'discovery',
                approved_by: s.accountId,
                approved_at: new Date(),
                created_by: s.accountId,
                updated_by: s.accountId,
              } as never)
              .returning(['id', 'version'])
              .executeTakeFirstOrThrow();
            facilityId = f.id;
            await request.audit(trx, {
              action: 'facility.create',
              targetType: 'facility',
              targetId: f.id,
              targetVersion: f.version,
              reason: `qualified in from discovery ${c.id}: ${b.reason}`,
            });
          } else if (c.facility_id) {
            const f = await trx
              .updateTable('cg.facility')
              .set({
                ...(c.change === 'closed'
                  ? { status: 'retired' as const }
                  : (registryColumns(c.attributes) as never)),
                updated_by: s.accountId,
              })
              .where('id', '=', c.facility_id)
              .returning(['id', 'version'])
              .executeTakeFirst();
            if (!f) throw errors.notFound();
            await request.audit(trx, {
              action: c.change === 'closed' ? 'facility.retire' : 'facility.update',
              targetType: 'facility',
              targetId: f.id,
              targetVersion: f.version,
              reason: `from discovery ${c.id}: ${b.reason}`,
            });
          }
        }
        const decided = await trx
          .updateTable('cg.discovery_candidate')
          .set({
            state: b.decision === 'accept' ? 'accepted' : 'rejected',
            decided_by: s.accountId,
            decided_at: new Date(),
            decision_reason: b.reason,
            facility_id: facilityId,
            updated_by: s.accountId,
          })
          .where('id', '=', c.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: `discovery.${b.decision}`,
          targetType: 'discovery_candidate',
          targetId: decided.id,
          targetVersion: decided.version,
          reason: b.reason,
        });
        return candidateToOut(decided, (await namesFor(trx, [decided]))(decided));
      });
    },
  );
};
