/**
 * The needs board (CON-08, CON-15, CON-04, NED-02, NED-07, AC-17B,
 * BRD:FR-16.01–16.04, SEC-05/06, SEC-18, ADR-0030): open, claimed, in
 * progress and met needs with filters; claim, assign, release, done and
 * reopen with a note and an append-only history; overlap warnings when
 * another organization holds a claim on the same household or address; who
 * sees whose claims as configured per event; CSV export with an audit row;
 * the key counts for the console home.
 *
 * County staff see their county's needs. A partner organization sees only
 * the needs a share grant covers, reads them in the county's context for
 * exactly those ids, and acts on one of them (claim, release, done) inside
 * the county's context attributed to its own account. No partner reads a
 * county table any other way.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { AccountSubject, FieldDescriptor } from '@cg/authz';
import type { Database, NeedEventKind } from '@cg/db';
import { toCsv } from '@cg/reporting';
import { errors } from '../errors.ts';
import { iso, listQuery, uuidParam } from './helpers.ts';

type NeedRow = Selectable<Database['cg.need']>;
type Trx = Transaction<Database>;
type Sees = 'own' | 'consented' | 'all';

const statuses = ['open', 'claimed', 'in_progress', 'met', 'closed', 'withdrawn'] as const;

/** What a role may see of a need beyond the basics (RULE-16): the note and the exact place. */
const FIELDS: FieldDescriptor[] = [
  { name: 'detail', category: 'free_text', classification: 'sensitive' },
  { name: 'address', category: 'location_exact', classification: 'sensitive' },
];

const claimOut = z
  .object({
    tenantId: z.uuid(),
    tenantName: z.string(),
    accountId: z.uuid().nullable(),
    assignedByAccountId: z.uuid().nullable(),
    at: z.iso.datetime().nullable(),
  })
  .nullable();

const needOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  reportId: z.uuid().nullable(),
  referenceCode: z.string().nullable(),
  eventId: z.uuid().nullable(),
  category: z.string(),
  status: z.enum(statuses),
  source: z.enum(['report', 'standalone', 'staff']),
  detail: z.string().nullable(),
  area: z.object({ city: z.string().nullable(), postal: z.string().nullable() }).nullable(),
  address: z
    .object({
      line1: z.string().nullable(),
      unit: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postal: z.string().nullable(),
      landmark: z.string().nullable(),
    })
    .nullable(),
  /** True whenever someone holds the need; who is shown as visibility allows (CON-15). */
  claimed: z.boolean(),
  claim: claimOut,
  /** Partner organizations holding an active grant on this need (county view only). */
  sharedWith: z.array(z.object({ tenantId: z.uuid(), name: z.string() })),
  releasedAt: z.iso.datetime().nullable(),
  doneAt: z.iso.datetime().nullable(),
  doneNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
type NeedOut = z.infer<typeof needOut>;

const eventOut = z.object({
  id: z.uuid(),
  kind: z.string(),
  actorAccountId: z.uuid().nullable(),
  actorTenantId: z.uuid().nullable(),
  actorTenantName: z.string().nullable(),
  note: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
  at: z.iso.datetime(),
});

const warningOut = z.object({
  kind: z.enum(['same_household', 'same_address']),
  needId: z.uuid(),
  category: z.string(),
  claimedByTenantName: z.string().nullable(),
});

const actionOut = z.object({ need: needOut, warnings: z.array(warningOut) });

const visibilityOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  eventId: z.uuid().nullable(),
  scope: z.enum(['role', 'agency', 'person']),
  subjectKey: z.string(),
  sees: z.enum(['own', 'consented', 'all']),
  reason: z.string(),
  updatedAt: z.iso.datetime(),
});

const countsOut = z.object({
  asOf: z.iso.datetime(),
  eventId: z.uuid().nullable(),
  reports: z.object({
    total: z.number().int(),
    byState: z.record(z.string(), z.number().int()),
    danger: z.number().int(),
  }),
  needs: z.object({
    total: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    byCategory: z.record(z.string(), z.number().int()),
    standalone: z.number().int(),
  }),
  sites: z.object({
    byStatus: z.record(z.string(), z.number().int()),
    published: z.number().int(),
  }),
  sharing: z.object({ activeGrants: z.number().int(), partners: z.number().int() }),
  claims: z.array(z.object({ tenantId: z.uuid(), name: z.string(), count: z.number().int() })),
});

interface Loaded {
  need: NeedRow;
  /** The county that owns the need; equals the subject's tenant for county staff. */
  countyId: string;
  /** True when the subject reaches the need through a share grant (a partner). */
  viaGrant: boolean;
}

export const needRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest): AccountSubject => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  /** Runs fn in the county's context: the subject's own transaction for county staff, txAs for a partner. */
  const inCounty = <T>(request: FastifyRequest, countyId: string, fn: (trx: Trx) => Promise<T>) =>
    account(request).tenantId === countyId ? request.tx(fn) : request.txAs(countyId, fn);

  /** Need ids a partner may see, per county, from its active grants (NED-04). */
  async function grantedNeedIds(request: FastifyRequest): Promise<Map<string, Set<string>>> {
    const s = account(request);
    const grants = await request.tx((trx) =>
      trx
        .selectFrom('cg.share_grant')
        .select(['tenant_id', 'need_id', 'projection', 'sections'])
        .where('to_tenant_id', '=', s.tenantId)
        .where('revoked_at', 'is', null)
        .where(sql<boolean>`'need' = any(sections)`)
        .execute(),
    );
    const out = new Map<string, Set<string>>();
    for (const g of grants) {
      const set = out.get(g.tenant_id) ?? new Set<string>();
      if (g.need_id) set.add(g.need_id);
      const needs = (g.projection as { needs?: { id?: string }[] }).needs ?? [];
      for (const n of needs) if (n.id) set.add(n.id);
      out.set(g.tenant_id, set);
    }
    return out;
  }

  /** CON-15: the most specific rule wins (person, role, agency; event-specific over default). */
  async function visibilityFor(
    trx: Trx,
    countyId: string,
    s: AccountSubject,
    eventId: string | null,
  ): Promise<Sees> {
    const rows = await trx
      .selectFrom('cg.board_visibility')
      .select(['event_id', 'scope', 'subject_key', 'sees'])
      .where('tenant_id', '=', countyId)
      .where((eb) =>
        eventId
          ? eb.or([eb('event_id', 'is', null), eb('event_id', '=', eventId)])
          : eb('event_id', 'is', null),
      )
      .execute();
    const rank = (r: (typeof rows)[number]) => {
      const scope = r.scope === 'person' ? 3 : r.scope === 'role' ? 2 : 1;
      return scope * 2 + (r.event_id ? 1 : 0);
    };
    const roleKeys = new Set(s.roles.map((r) => r.key));
    const matching = rows.filter(
      (r) =>
        (r.scope === 'person' && r.subject_key === s.accountId) ||
        (r.scope === 'role' && roleKeys.has(r.subject_key)) ||
        (r.scope === 'agency' && r.subject_key === s.tenantId),
    );
    matching.sort((a, b) => rank(b) - rank(a));
    if (matching[0]) return matching[0].sees;
    return s.tenantId === countyId ? 'all' : 'consented';
  }

  type Joined = NeedRow & {
    ref: string | null;
    city: string | null;
    postal: string | null;
    line1: string | null;
    unit: string | null;
    state: string | null;
    landmark: string | null;
    claimer_name: string | null;
  };

  function baseQuery(trx: Trx) {
    return trx
      .selectFrom('cg.need as n')
      .leftJoin('cg.report as r', 'r.id', 'n.report_id')
      .leftJoin('cg.location as l', (join) =>
        join.on('l.id', '=', sql<string>`coalesce(n.location_id, r.location_id)`),
      )
      .leftJoin('cg.tenant as ct', 'ct.id', 'n.claimed_by_tenant_id')
      .selectAll('n')
      .select([
        sql<string | null>`coalesce(n.reference_code, r.reference_code)`.as('ref'),
        'l.city as city',
        'l.postal as postal',
        'l.line1 as line1',
        'l.unit as unit',
        'l.state as state',
        'l.landmark as landmark',
        'ct.name as claimer_name',
      ]);
  }

  async function sharedWithFor(trx: Trx, needs: Joined[]) {
    if (needs.length === 0) return new Map<string, { tenantId: string; name: string }[]>();
    const rows = await trx
      .selectFrom('cg.share_grant as g')
      .innerJoin('cg.tenant as t', 't.id', 'g.to_tenant_id')
      .select(['g.need_id', 'g.report_id', 'g.projection', 't.id as tenant_id', 't.name as name'])
      .where('g.revoked_at', 'is', null)
      .where(sql<boolean>`'need' = any(g.sections)`)
      .where((eb) =>
        eb.or([
          eb(
            'g.need_id',
            'in',
            needs.map((n) => n.id),
          ),
          eb(
            'g.report_id',
            'in',
            needs
              .map((n) => n.report_id)
              .filter((x): x is string => x !== null)
              .concat(['00000000-0000-0000-0000-000000000000']),
          ),
        ]),
      )
      .execute();
    const out = new Map<string, { tenantId: string; name: string }[]>();
    const add = (needId: string, partner: { tenantId: string; name: string }) => {
      const list = out.get(needId) ?? [];
      if (!list.some((p) => p.tenantId === partner.tenantId)) list.push(partner);
      out.set(needId, list);
    };
    for (const g of rows) {
      const partner = { tenantId: g.tenant_id, name: g.name };
      if (g.need_id) add(g.need_id, partner);
      for (const n of (g.projection as { needs?: { id?: string }[] }).needs ?? [])
        if (n.id) add(n.id, partner);
    }
    return out;
  }

  function render(
    n: Joined,
    s: AccountSubject,
    sees: Sees,
    fields: string[],
    sharedWith: { tenantId: string; name: string }[],
    viaGrant: boolean,
  ): NeedOut {
    const claimed = n.claimed_by_tenant_id !== null;
    const mine = n.claimed_by_tenant_id === s.tenantId;
    const showClaim =
      claimed &&
      (sees === 'all' ||
        mine ||
        (sees === 'consented' && !viaGrant) ||
        (viaGrant && sees !== 'own'));
    return {
      id: n.id,
      version: n.version,
      reportId: n.report_id,
      referenceCode: n.ref,
      eventId: n.event_id,
      category: n.category,
      status: n.status,
      source: n.source,
      detail: fields.includes('detail') ? n.detail : null,
      area: n.city || n.postal ? { city: n.city, postal: n.postal } : null,
      address:
        fields.includes('address') && (n.line1 || n.landmark)
          ? {
              line1: n.line1,
              unit: n.unit,
              city: n.city,
              state: n.state,
              postal: n.postal,
              landmark: n.landmark,
            }
          : null,
      claimed,
      claim: showClaim
        ? {
            tenantId: n.claimed_by_tenant_id!,
            tenantName: n.claimer_name ?? '',
            accountId: n.claimed_by_account_id,
            assignedByAccountId: n.assigned_by_account_id,
            at: iso(n.claimed_at),
          }
        : null,
      sharedWith: viaGrant ? [] : sharedWith,
      releasedAt: iso(n.released_at),
      doneAt: iso(n.done_at),
      doneNote: n.done_note,
      createdAt: iso(n.created_at)!,
      updatedAt: iso(n.updated_at)!,
    };
  }

  /** Loads one need the subject may act on: its own county's, or one a grant covers. */
  async function load(request: FastifyRequest, id: string): Promise<Loaded> {
    const s = account(request);
    const own = await request.tx((trx) =>
      trx.selectFrom('cg.need').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (own && own.tenant_id === s.tenantId)
      return { need: own, countyId: own.tenant_id, viaGrant: false };
    const granted = await grantedNeedIds(request);
    for (const [countyId, ids] of granted) {
      if (!ids.has(id)) continue;
      const need = await request.txAs(countyId, (trx) =>
        trx.selectFrom('cg.need').selectAll().where('id', '=', id).executeTakeFirst(),
      );
      if (need) return { need, countyId, viaGrant: true };
    }
    throw errors.notFound();
  }

  async function record(
    request: FastifyRequest,
    trx: Trx,
    countyId: string,
    need: NeedRow,
    kind: NeedEventKind,
    note: string | null,
    detail: Record<string, unknown>,
  ) {
    const s = account(request);
    await trx
      .insertInto('cg.need_event')
      .values({
        tenant_id: countyId,
        need_id: need.id,
        kind,
        actor_account_id: s.accountId,
        actor_tenant_id: s.tenantId,
        note,
        detail: JSON.stringify(detail),
      })
      .execute();
    await request.audit(trx, {
      tenantId: countyId,
      action: `need.${kind}`,
      targetType: 'need',
      targetId: need.id,
      targetVersion: need.version,
      reason: note,
      changes: {
        fields: [
          { name: 'status', from: need.status },
          ...Object.entries(detail).map(([name, to]) => ({ name, to })),
        ],
      },
    });
  }

  /** AC-17B: another organization already holds a claim on the same household or address. */
  async function overlaps(trx: Trx, need: NeedRow, actorTenantId: string) {
    const rows = await trx
      .selectFrom('cg.need as o')
      .leftJoin('cg.report as r', 'r.id', 'o.report_id')
      .leftJoin('cg.location as l', (join) =>
        join.on('l.id', '=', sql<string>`coalesce(o.location_id, r.location_id)`),
      )
      .leftJoin('cg.tenant as t', 't.id', 'o.claimed_by_tenant_id')
      .select([
        'o.id as id',
        'o.category as category',
        'o.report_id as report_id',
        'l.address_key as address_key',
        't.name as claimer',
      ])
      .where('o.id', '<>', need.id)
      .where('o.status', 'in', ['claimed', 'in_progress'])
      .where('o.claimed_by_tenant_id', 'is not', null)
      .where('o.claimed_by_tenant_id', '<>', actorTenantId)
      .where((eb) => {
        const parts = [];
        if (need.report_id) parts.push(eb('o.report_id', '=', need.report_id));
        parts.push(
          sql<boolean>`l.address_key is not null and l.address_key = (select coalesce(ml.address_key, rl.address_key) from cg.need mn left join cg.report mr on mr.id = mn.report_id left join cg.location ml on ml.id = mn.location_id left join cg.location rl on rl.id = mr.location_id where mn.id = ${need.id})`,
        );
        return eb.or(parts);
      })
      .limit(10)
      .execute();
    return rows.map((r) => ({
      kind: (need.report_id && r.report_id === need.report_id
        ? 'same_household'
        : 'same_address') as 'same_household' | 'same_address',
      needId: r.id,
      category: r.category,
      claimedByTenantName: r.claimer,
    }));
  }

  async function fetchOne(request: FastifyRequest, loaded: Loaded): Promise<NeedOut> {
    const s = account(request);
    const decision = await request.authorize('need.read', {
      type: 'need',
      id: loaded.need.id,
      tenantId: s.tenantId,
      ...(loaded.need.event_id && !loaded.viaGrant ? { eventId: loaded.need.event_id } : {}),
      fields: FIELDS,
    });
    return inCounty(request, loaded.countyId, async (trx) => {
      const row = (await baseQuery(trx)
        .where('n.id', '=', loaded.need.id)
        .executeTakeFirstOrThrow()) as Joined;
      const sees = await visibilityFor(trx, loaded.countyId, s, row.event_id);
      const shared = loaded.viaGrant ? new Map() : await sharedWithFor(trx, [row]);
      return render(row, s, sees, decision.fields, shared.get(row.id) ?? [], loaded.viaGrant);
    });
  }

  // ------------------------------------------------------------------ board
  const boardQuery = listQuery.extend({
    eventId: z.uuid().optional(),
    status: z.enum(statuses).optional(),
    category: z.string().max(60).optional(),
    postal: z.string().max(12).optional(),
    claimedBy: z.uuid().optional(),
    source: z.enum(['report', 'standalone', 'staff']).optional(),
    reference: z.string().min(6).max(12).optional(),
    includeWithdrawn: z.coerce.boolean().default(false),
  });
  type BoardQuery = z.infer<typeof boardQuery>;

  async function board(request: FastifyRequest, q: BoardQuery): Promise<NeedOut[]> {
    const s = account(request);
    const decision = await request.authorize('need.read', {
      type: 'need',
      tenantId: s.tenantId,
      ...(q.eventId ? { eventId: q.eventId } : {}),
      fields: FIELDS,
    });
    const apply = (query: ReturnType<typeof baseQuery>) => {
      let x = query;
      if (q.eventId) x = x.where('n.event_id', '=', q.eventId);
      if (q.status) x = x.where('n.status', '=', q.status);
      if (q.category) x = x.where('n.category', '=', q.category);
      if (q.postal) x = x.where('l.postal', '=', q.postal);
      if (q.claimedBy) x = x.where('n.claimed_by_tenant_id', '=', q.claimedBy);
      if (q.source) x = x.where('n.source', '=', q.source);
      if (q.reference)
        x = x.where(
          sql`coalesce(n.reference_code, r.reference_code)`,
          '=',
          q.reference.toUpperCase(),
        );
      if (!q.includeWithdrawn) x = x.where('n.status', '<>', 'withdrawn');
      return x.orderBy('n.created_at', 'asc').limit(q.limit).offset(q.offset);
    };
    // County staff: the county's board.
    const own = await request.tx(async (trx) => {
      const rows = (await apply(baseQuery(trx)).execute()) as Joined[];
      const sees = await visibilityFor(trx, s.tenantId, s, q.eventId ?? null);
      const shared = await sharedWithFor(trx, rows);
      return rows.map((r) => render(r, s, sees, decision.fields, shared.get(r.id) ?? [], false));
    });
    // Partners: only what their grants cover, read in each county's context for those ids.
    const granted = await grantedNeedIds(request);
    const viaGrants: NeedOut[] = [];
    for (const [countyId, ids] of granted) {
      if (ids.size === 0) continue;
      const rows = await request.txAs(countyId, async (trx) => {
        const list = (await apply(
          baseQuery(trx).where('n.id', 'in', [...ids]),
        ).execute()) as Joined[];
        const sees = await visibilityFor(trx, countyId, s, q.eventId ?? null);
        return list.map((r) => render(r, s, sees, decision.fields, [], true));
      });
      viaGrants.push(...rows);
    }
    return [...own, ...viaGrants];
  }

  app.get(
    '/needs',
    { schema: { tags: ['needs'], querystring: boardQuery, response: { 200: z.array(needOut) } } },
    async (request) => board(request, request.query),
  );

  app.get(
    '/needs/:id',
    {
      schema: {
        tags: ['needs'],
        params: uuidParam,
        response: { 200: needOut.extend({ history: z.array(eventOut) }) },
      },
    },
    async (request) => {
      const loaded = await load(request, request.params.id);
      const out = await fetchOne(request, loaded);
      const history = await inCounty(request, loaded.countyId, (trx) =>
        trx
          .selectFrom('cg.need_event as e')
          .leftJoin('cg.tenant as t', 't.id', 'e.actor_tenant_id')
          .select([
            'e.id',
            'e.kind',
            'e.actor_account_id',
            'e.actor_tenant_id',
            't.name as actor_name',
            'e.note',
            'e.detail',
            'e.created_at',
          ])
          .where('e.need_id', '=', loaded.need.id)
          .orderBy('e.created_at', 'asc')
          .execute(),
      );
      const s = account(request);
      const sees = out.claim || !out.claimed ? 'all' : 'own';
      return {
        ...out,
        history: history
          .filter((h) => sees === 'all' || h.actor_tenant_id === s.tenantId || h.kind === 'created')
          .map((h) => ({
            id: h.id,
            kind: h.kind,
            actorAccountId: h.actor_account_id,
            actorTenantId: h.actor_tenant_id,
            actorTenantName: h.actor_name,
            note: h.note,
            detail: (h.detail ?? {}) as Record<string, unknown>,
            at: iso(h.created_at)!,
          })),
      };
    },
  );

  // ---------------------------------------------------------------- actions
  const noteBody = z.object({ note: z.string().max(500).optional() });

  app.post(
    '/needs/:id/claim',
    {
      schema: { tags: ['needs'], params: uuidParam, body: noteBody, response: { 200: actionOut } },
    },
    async (request) => {
      const s = account(request);
      const loaded = await load(request, request.params.id);
      await request.authorize('need.claim', {
        type: 'need',
        id: loaded.need.id,
        tenantId: s.tenantId,
      });
      const warnings = await inCounty(request, loaded.countyId, async (trx) => {
        const current = await trx
          .selectFrom('cg.need')
          .selectAll()
          .where('id', '=', loaded.need.id)
          .executeTakeFirstOrThrow();
        if (current.status === 'withdrawn' || current.status === 'closed')
          throw errors.conflict({ status: current.status });
        if (current.claimed_by_tenant_id && current.claimed_by_tenant_id !== s.tenantId)
          throw errors.conflict({ status: current.status, claimed: true });
        const found = await overlaps(trx, current, s.tenantId);
        await trx
          .updateTable('cg.need')
          .set({
            status: current.status === 'in_progress' ? 'in_progress' : 'claimed',
            claimed_by_tenant_id: s.tenantId,
            claimed_by_account_id: s.accountId,
            claimed_at: new Date(),
            assigned_by_account_id: null,
            released_at: null,
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .execute();
        await record(request, trx, loaded.countyId, current, 'claimed', request.body.note ?? null, {
          claimedByTenantId: s.tenantId,
        });
        if (found.length > 0)
          await record(request, trx, loaded.countyId, current, 'overlap_warned', null, {
            overlaps: found.map((w) => w.needId),
          });
        return found;
      });
      return { need: await fetchOne(request, loaded), warnings };
    },
  );

  app.post(
    '/needs/:id/assign',
    {
      schema: {
        tags: ['needs'],
        params: uuidParam,
        body: noteBody.extend({ toTenantId: z.uuid() }),
        response: { 200: actionOut },
      },
    },
    async (request) => {
      const s = account(request);
      const loaded = await load(request, request.params.id);
      if (loaded.viaGrant) throw errors.forbidden(); // the county assigns; a partner claims
      await request.authorize('need.assign', {
        type: 'need',
        id: loaded.need.id,
        tenantId: s.tenantId,
      });
      const warnings = await request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.need')
          .selectAll()
          .where('id', '=', loaded.need.id)
          .executeTakeFirstOrThrow();
        if (current.status === 'withdrawn' || current.status === 'closed')
          throw errors.conflict({ status: current.status });
        // Only an organization the resident consented to (an active grant) can be handed the need (NED-04).
        const grant = await trx
          .selectFrom('cg.share_grant')
          .select('id')
          .where('to_tenant_id', '=', request.body.toTenantId)
          .where('revoked_at', 'is', null)
          .where(sql<boolean>`'need' = any(sections)`)
          .where((eb) =>
            eb.or([
              eb('need_id', '=', current.id),
              ...(current.report_id ? [eb('report_id', '=', current.report_id)] : []),
            ]),
          )
          .executeTakeFirst();
        if (!grant)
          throw errors.validation([
            {
              name: 'toTenantId',
              message: 'the resident has not consented to sharing with this organization',
            },
          ]);
        const found = await overlaps(trx, current, request.body.toTenantId);
        await trx
          .updateTable('cg.need')
          .set({
            status: 'claimed',
            claimed_by_tenant_id: request.body.toTenantId,
            claimed_by_account_id: null,
            claimed_at: new Date(),
            assigned_by_account_id: s.accountId,
            released_at: null,
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .execute();
        await record(
          request,
          trx,
          loaded.countyId,
          current,
          'assigned',
          request.body.note ?? null,
          { toTenantId: request.body.toTenantId },
        );
        if (found.length > 0)
          await record(request, trx, loaded.countyId, current, 'overlap_warned', null, {
            overlaps: found.map((w) => w.needId),
          });
        return found;
      });
      return { need: await fetchOne(request, loaded), warnings };
    },
  );

  app.post(
    '/needs/:id/release',
    {
      schema: { tags: ['needs'], params: uuidParam, body: noteBody, response: { 200: actionOut } },
    },
    async (request) => {
      const s = account(request);
      const loaded = await load(request, request.params.id);
      await request.authorize('need.release', {
        type: 'need',
        id: loaded.need.id,
        tenantId: s.tenantId,
      });
      await inCounty(request, loaded.countyId, async (trx) => {
        const current = await trx
          .selectFrom('cg.need')
          .selectAll()
          .where('id', '=', loaded.need.id)
          .executeTakeFirstOrThrow();
        if (!current.claimed_by_tenant_id) throw errors.conflict({ status: current.status });
        if (loaded.viaGrant && current.claimed_by_tenant_id !== s.tenantId)
          throw errors.forbidden();
        await trx
          .updateTable('cg.need')
          .set({
            status: 'open',
            claimed_by_tenant_id: null,
            claimed_by_account_id: null,
            claimed_at: null,
            assigned_by_account_id: null,
            released_at: new Date(),
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .execute();
        await record(
          request,
          trx,
          loaded.countyId,
          current,
          'released',
          request.body.note ?? null,
          { from: current.claimed_by_tenant_id },
        );
      });
      return { need: await fetchOne(request, loaded), warnings: [] };
    },
  );

  app.post(
    '/needs/:id/done',
    {
      schema: {
        tags: ['needs'],
        params: uuidParam,
        body: z.object({ note: z.string().min(3).max(500) }),
        response: { 200: actionOut },
      },
    },
    async (request) => {
      const s = account(request);
      const loaded = await load(request, request.params.id);
      await request.authorize('need.done', {
        type: 'need',
        id: loaded.need.id,
        tenantId: s.tenantId,
      });
      await inCounty(request, loaded.countyId, async (trx) => {
        const current = await trx
          .selectFrom('cg.need')
          .selectAll()
          .where('id', '=', loaded.need.id)
          .executeTakeFirstOrThrow();
        if (current.status === 'met' || current.status === 'withdrawn')
          throw errors.conflict({ status: current.status });
        if (loaded.viaGrant && current.claimed_by_tenant_id !== s.tenantId)
          throw errors.forbidden();
        await trx
          .updateTable('cg.need')
          .set({
            status: 'met',
            done_at: new Date(),
            done_note: request.body.note,
            ...(current.claimed_by_tenant_id
              ? {}
              : {
                  claimed_by_tenant_id: s.tenantId,
                  claimed_by_account_id: s.accountId,
                  claimed_at: new Date(),
                }),
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .execute();
        await record(request, trx, loaded.countyId, current, 'done', request.body.note, {
          by: s.tenantId,
        });
      });
      return { need: await fetchOne(request, loaded), warnings: [] };
    },
  );

  app.post(
    '/needs/:id/reopen',
    {
      schema: {
        tags: ['needs'],
        params: uuidParam,
        body: z.object({ note: z.string().min(3).max(500) }),
        response: { 200: actionOut },
      },
    },
    async (request) => {
      const s = account(request);
      const loaded = await load(request, request.params.id);
      if (loaded.viaGrant) throw errors.forbidden();
      await request.authorize('need.update', {
        type: 'need',
        id: loaded.need.id,
        tenantId: s.tenantId,
      });
      await request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.need')
          .selectAll()
          .where('id', '=', loaded.need.id)
          .executeTakeFirstOrThrow();
        if (current.status === 'open') throw errors.conflict({ status: current.status });
        await trx
          .updateTable('cg.need')
          .set({
            status: 'open',
            done_at: null,
            done_note: null,
            claimed_by_tenant_id: null,
            claimed_by_account_id: null,
            claimed_at: null,
            assigned_by_account_id: null,
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .execute();
        await record(request, trx, loaded.countyId, current, 'reopened', request.body.note, {});
      });
      return { need: await fetchOne(request, loaded), warnings: [] };
    },
  );

  // ----------------------------------------------------------------- export
  app.get(
    '/needs.csv',
    { schema: { tags: ['needs'], querystring: boardQuery.omit({ limit: true, offset: true }) } },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('need.export', { type: 'need', tenantId: s.tenantId });
      const rows = await board(request, { ...request.query, limit: 200, offset: 0 } as BoardQuery);
      // One board page per export keeps the file bounded; the audit names the count (NED-07).
      // BRD:FR-14.06: the shared writer guards against formulas and opens cleanly in Excel.
      const header = [
        'id',
        'reference',
        'category',
        'status',
        'source',
        'city',
        'postal',
        'claimed_by',
        'claimed_at',
        'done_at',
        'created_at',
      ];
      const csv = toCsv(
        header,
        rows.map((n) => [
          n.id,
          n.referenceCode,
          n.category,
          n.status,
          n.source,
          n.area?.city,
          n.area?.postal,
          n.claim?.tenantName ?? (n.claimed ? 'claimed' : ''),
          n.claim?.at,
          n.doneAt,
          n.createdAt,
        ]),
      );
      const { reason } = request.confirmation();
      await request.tx(async (trx) => {
        for (const n of rows.filter((r) => !r.sharedWith || true).slice(0, 200))
          if (n.reportId !== undefined)
            await trx
              .insertInto('cg.need_event')
              .values({
                tenant_id: s.tenantId,
                need_id: n.id,
                kind: 'exported',
                actor_account_id: s.accountId,
                actor_tenant_id: s.tenantId,
                note: reason,
                detail: JSON.stringify({ format: 'csv' }),
              })
              .onConflict((oc) => oc.doNothing())
              .execute()
              .catch(() => undefined);
        await request.audit(trx, {
          action: 'need.export',
          targetType: 'need',
          targetId: 'board',
          reason,
          changes: {
            fields: [
              { name: 'format', to: 'csv' },
              { name: 'count', to: rows.length },
            ],
          },
        });
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="needs.csv"')
        .send(csv);
    },
  );

  // ------------------------------------------------------------- visibility
  app.get(
    '/board-visibility',
    {
      schema: {
        tags: ['needs'],
        querystring: z.object({ eventId: z.uuid().optional() }),
        response: { 200: z.array(visibilityOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('board.read', {
        type: 'board_visibility',
        tenantId: s.tenantId,
      });
      const rows = await request.tx((trx) => {
        let q = trx.selectFrom('cg.board_visibility').selectAll().orderBy('created_at');
        if (request.query.eventId)
          q = q.where((eb) =>
            eb.or([eb('event_id', 'is', null), eb('event_id', '=', request.query.eventId!)]),
          );
        return q.execute();
      });
      return rows.map((r) => ({
        id: r.id,
        version: r.version,
        eventId: r.event_id,
        scope: r.scope,
        subjectKey: r.subject_key,
        sees: r.sees,
        reason: r.reason,
        updatedAt: iso(r.updated_at)!,
      }));
    },
  );

  app.put(
    '/board-visibility',
    {
      schema: {
        tags: ['needs'],
        body: z.object({
          eventId: z.uuid().nullable().default(null),
          scope: z.enum(['role', 'agency', 'person']),
          subjectKey: z.string().min(1).max(80),
          sees: z.enum(['own', 'consented', 'all']),
          reason: z.string().min(3).max(500),
        }),
        response: { 200: visibilityOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('board.configure', {
        type: 'board_visibility',
        tenantId: s.tenantId,
      });
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const existing = await trx
          .selectFrom('cg.board_visibility')
          .selectAll()
          .where((eb) => (b.eventId ? eb('event_id', '=', b.eventId) : eb('event_id', 'is', null)))
          .where('scope', '=', b.scope)
          .where('subject_key', '=', b.subjectKey)
          .executeTakeFirst();
        const saved = existing
          ? await trx
              .updateTable('cg.board_visibility')
              .set({ sees: b.sees, reason: b.reason, updated_by: s.accountId })
              .where('id', '=', existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('cg.board_visibility')
              .values({
                tenant_id: s.tenantId,
                event_id: b.eventId,
                scope: b.scope,
                subject_key: b.subjectKey,
                sees: b.sees,
                reason: b.reason,
                created_by: s.accountId,
                updated_by: s.accountId,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'board.configure',
          targetType: 'board_visibility',
          targetId: saved.id,
          targetVersion: saved.version,
          reason: request.confirmation().reason ?? b.reason,
          changes: {
            fields: [
              { name: 'sees', from: existing?.sees ?? null, to: b.sees },
              { name: 'scope', to: b.scope },
              { name: 'subject_key', to: b.subjectKey },
            ],
          },
        });
        return saved;
      });
      return {
        id: row.id,
        version: row.version,
        eventId: row.event_id,
        scope: row.scope,
        subjectKey: row.subject_key,
        sees: row.sees,
        reason: row.reason,
        updatedAt: iso(row.updated_at)!,
      };
    },
  );

  // ------------------------------------------------------------- key counts
  app.get(
    '/dashboard/counts',
    {
      schema: {
        tags: ['dashboard'],
        querystring: z.object({ eventId: z.uuid().optional() }),
        response: { 200: countsOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('dashboard.read', { type: 'dashboard', tenantId: s.tenantId });
      const eventId = request.query.eventId ?? null;
      return request.tx(async (trx) => {
        const count = (rows: { k: string | null; n: string | number }[]) =>
          Object.fromEntries(rows.map((r) => [r.k ?? 'unknown', Number(r.n)]));
        let reports = trx
          .selectFrom('cg.report')
          .select([sql<string>`review_state`.as('k'), sql<string>`count(*)`.as('n')])
          .where('withdrawn_at', 'is', null)
          .groupBy('review_state');
        if (eventId) reports = reports.where('event_id', '=', eventId);
        const byState = count(await reports.execute());
        let danger = trx
          .selectFrom('cg.report')
          .select(sql<string>`count(*)`.as('n'))
          .where('withdrawn_at', 'is', null)
          .where('danger_flag', '=', true);
        if (eventId) danger = danger.where('event_id', '=', eventId);
        let needs = trx
          .selectFrom('cg.need')
          .select([sql<string>`status`.as('k'), sql<string>`count(*)`.as('n')])
          .groupBy('status');
        if (eventId) needs = needs.where('event_id', '=', eventId);
        const byStatus = count(await needs.execute());
        let cats = trx
          .selectFrom('cg.need')
          .select([sql<string>`category`.as('k'), sql<string>`count(*)`.as('n')])
          .where('status', '<>', 'withdrawn')
          .groupBy('category');
        if (eventId) cats = cats.where('event_id', '=', eventId);
        let standalone = trx
          .selectFrom('cg.need')
          .select(sql<string>`count(*)`.as('n'))
          .where('source', '=', 'standalone')
          .where('status', '<>', 'withdrawn');
        if (eventId) standalone = standalone.where('event_id', '=', eventId);
        let sites = trx
          .selectFrom('cg.site')
          .select([sql<string>`status`.as('k'), sql<string>`count(*)`.as('n')])
          .groupBy('status');
        if (eventId) sites = sites.where('event_id', '=', eventId);
        let published = trx
          .selectFrom('cg.site')
          .select(sql<string>`count(*)`.as('n'))
          .where('published_at', 'is not', null)
          .where('unpublished_at', 'is', null);
        if (eventId) published = published.where('event_id', '=', eventId);
        const grants = await trx
          .selectFrom('cg.share_grant')
          .select([
            sql<string>`count(*)`.as('n'),
            sql<string>`count(distinct to_tenant_id)`.as('p'),
          ])
          .where('revoked_at', 'is', null)
          .executeTakeFirstOrThrow();
        let claims = trx
          .selectFrom('cg.need as n')
          .innerJoin('cg.tenant as t', 't.id', 'n.claimed_by_tenant_id')
          .select(['t.id as tenantId', 't.name as name', sql<string>`count(*)`.as('n')])
          .where('n.status', 'in', ['claimed', 'in_progress'])
          .groupBy(['t.id', 't.name']);
        if (eventId) claims = claims.where('n.event_id', '=', eventId);
        const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
        return {
          asOf: new Date().toISOString(),
          eventId,
          reports: {
            total: total(byState),
            byState,
            danger: Number((await danger.executeTakeFirstOrThrow()).n),
          },
          needs: {
            total: total(byStatus),
            byStatus,
            byCategory: count(await cats.execute()),
            standalone: Number((await standalone.executeTakeFirstOrThrow()).n),
          },
          sites: {
            byStatus: count(await sites.execute()),
            published: Number((await published.executeTakeFirstOrThrow()).n),
          },
          sharing: { activeGrants: Number(grants.n), partners: Number(grants.p) },
          claims: (await claims.execute()).map((c) => ({
            tenantId: c.tenantId,
            name: c.name,
            count: Number(c.n),
          })),
        };
      });
    },
  );
};
