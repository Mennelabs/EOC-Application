/**
 * The facility registry (layer-7 task D; REC-01, REC-10, docs/02 "How the
 * console recommends places and setups"). County EM approves entries; others
 * with `facility.manage` propose (the COAD, planning, mass care) and their
 * proposals wait in the approval queue for a named approver, who can never be
 * the person who proposed (the self-review rule of A7 applied to the
 * registry). Attributes the county does not know stay unknown (null), never
 * guessed (REC-10). Contacts are encrypted and shown only to roles that may
 * see contact details, with the read audited (SEC-10, SEC-18). Every entry is
 * re-checked every 12 months; past that it is listed as stale until someone
 * confirms it (REC-01).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { decide, type FieldDescriptor } from '@cg/authz';
import { diffForAudit } from '@cg/audit';
import type { Database, FacilityChangeTable, FacilityTable } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type Row = Selectable<FacilityTable>;
type ChangeRow = Selectable<FacilityChangeTable>;

/** REC-01: re-checked every 12 months. */
export const RECHECK_DAYS = 365;

const FIELDS: FieldDescriptor[] = [
  { name: 'contacts', category: 'contact', classification: 'restricted' },
];

const kinds = [
  'school',
  'place_of_worship',
  'community_center',
  'parking_lot',
  'government',
  'commercial',
  'other',
] as const;

const contactIn = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.email().max(200).optional(),
});

/** Every attribute may be unknown (null): REC-10 never invents a capacity. */
export const attributesIn = z.object({
  name: z.string().trim().min(2).max(200),
  kind: z.enum(kinds),
  address: z
    .object({
      line1: z.string().trim().max(200).nullable(),
      unit: z.string().trim().max(40).nullable().optional(),
      city: z.string().trim().max(120).nullable(),
      state: z.string().trim().max(40).nullable().optional(),
      postal: z.string().trim().max(20).nullable(),
    })
    .nullable()
    .optional(),
  position: z
    .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
    .nullable()
    .optional(),
  sqft: z.number().int().min(0).max(10_000_000).nullable().optional(),
  ada: z.boolean().nullable().optional(),
  powerBackup: z.enum(['none', 'generator', 'transfer_switch']).nullable().optional(),
  kitchen: z.boolean().nullable().optional(),
  showers: z.number().int().min(0).max(1000).nullable().optional(),
  petPolicy: z
    .enum(['none', 'service_animals', 'pets_inside', 'pets_outside_area'])
    .nullable()
    .optional(),
  parkingSpaces: z.number().int().min(0).max(100_000).nullable().optional(),
  truckAccess: z.boolean().nullable().optional(),
  floodplain: z.enum(['in', 'out']).nullable().optional(),
  mouStatus: z.enum(['none', 'pending', 'signed', 'expired']).optional(),
  mouExpiresOn: z.iso.date().nullable().optional(),
  communities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  contacts: z.array(contactIn).max(10).optional(),
});
export type Attributes = z.infer<typeof attributesIn>;
/** A partial update as the schema parses it (optional keys may hold undefined). */
export type AttrPatch = { [K in keyof Attributes]?: Attributes[K] | undefined };

const facilityOut = z.object({
  ...stamped,
  name: z.string(),
  kind: z.enum(kinds),
  status: z.enum(['approved', 'retired']),
  address: z
    .object({
      line1: z.string().nullable(),
      unit: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postal: z.string().nullable(),
    })
    .nullable(),
  position: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  sqft: z.number().int().nullable(),
  ada: z.boolean().nullable(),
  powerBackup: z.string().nullable(),
  kitchen: z.boolean().nullable(),
  showers: z.number().int().nullable(),
  petPolicy: z.string().nullable(),
  parkingSpaces: z.number().int().nullable(),
  truckAccess: z.boolean().nullable(),
  floodplain: z.string().nullable(),
  mouStatus: z.string(),
  mouExpiresOn: z.string().nullable(),
  communities: z.array(z.string()),
  notes: z.string().nullable(),
  ownerTenantId: z.uuid().nullable(),
  source: z.string(),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  lastConfirmedAt: z.iso.datetime(),
  confirmDueAt: z.iso.datetime(),
  stale: z.boolean(),
  /** What is not known about the place (REC-10). */
  unknown: z.array(z.string()),
  /** Null when the role may not see contact details. */
  contacts: z.array(contactIn).nullable(),
});
type FacilityOut = z.infer<typeof facilityOut>;

const changeOut = z.object({
  ...stamped,
  facilityId: z.uuid().nullable(),
  facilityName: z.string().nullable(),
  change: z.enum(['create', 'update', 'retire']),
  proposed: z.record(z.string(), z.unknown()),
  source: z.string(),
  proposedBy: z.uuid().nullable(),
  proposedByTenantId: z.uuid().nullable(),
  state: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
});

/** The attributes the recommendation engine needs that are still unknown. */
const UNKNOWABLE = [
  ['sqft', 'sqft'],
  ['ada', 'ada'],
  ['power_backup', 'powerBackup'],
  ['kitchen', 'kitchen'],
  ['showers', 'showers'],
  ['pet_policy', 'petPolicy'],
  ['parking_spaces', 'parkingSpaces'],
  ['truck_access', 'truckAccess'],
  ['floodplain', 'floodplain'],
] as const;

/** Attribute names in the API → columns. */
export function columnsOf(a: AttrPatch): Partial<Record<keyof Row, unknown>> {
  const out: Partial<Record<keyof Row, unknown>> = {};
  const map: [keyof Attributes, keyof Row][] = [
    ['name', 'name'],
    ['kind', 'kind'],
    ['sqft', 'sqft'],
    ['ada', 'ada'],
    ['powerBackup', 'power_backup'],
    ['kitchen', 'kitchen'],
    ['showers', 'showers'],
    ['petPolicy', 'pet_policy'],
    ['parkingSpaces', 'parking_spaces'],
    ['truckAccess', 'truck_access'],
    ['floodplain', 'floodplain'],
    ['mouStatus', 'mou_status'],
    ['mouExpiresOn', 'mou_expires_on'],
    ['communities', 'communities'],
    ['notes', 'notes'],
  ];
  for (const [k, c] of map) if (a[k] !== undefined) out[c] = a[k];
  return out;
}

export const facilityRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const canApprove = (request: FastifyRequest) => {
    const s = account(request);
    return (
      decide(s, 'facility.approve', { type: 'facility', tenantId: s.tenantId }).effect === 'allow'
    );
  };

  async function saveLocation(
    trx: Trx,
    tenantId: string,
    existing: string | null,
    a: Pick<Attributes, 'address' | 'position'>,
    accountId: string | null,
  ): Promise<string | null> {
    if (a.address === undefined && a.position === undefined) return existing;
    const values = {
      ...(a.address !== undefined
        ? {
            line1: a.address?.line1 ?? null,
            unit: a.address?.unit ?? null,
            city: a.address?.city ?? null,
            state: a.address?.state ?? null,
            postal: a.address?.postal ?? null,
            no_fixed_address: !a.address?.line1,
          }
        : {}),
      ...(a.position !== undefined
        ? {
            geom: a.position
              ? sql`ST_SetSRID(ST_MakePoint(${a.position.lon}, ${a.position.lat}), 4326)`
              : null,
            precision: a.position ? ('exact' as const) : ('unknown' as const),
          }
        : {}),
    };
    if (existing) {
      await trx
        .updateTable('cg.location')
        .set({ ...values, updated_by: accountId })
        .where('id', '=', existing)
        .execute();
      return existing;
    }
    const row = await trx
      .insertInto('cg.location')
      .values({
        tenant_id: tenantId,
        source: 'reviewer',
        created_by: accountId,
        updated_by: accountId,
        ...values,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const encryptContacts = async (tenantId: string, contacts: Attributes['contacts']) =>
    contacts === undefined
      ? undefined
      : contacts.length
        ? await base.fieldCrypto.encrypt(tenantId, JSON.stringify(contacts))
        : null;

  async function toOut(trx: Trx, r: Row, showContacts: boolean): Promise<FacilityOut> {
    const loc = r.location_id
      ? await trx
          .selectFrom('cg.location')
          .select([
            'line1',
            'unit',
            'city',
            'state',
            'postal',
            sql<number | null>`ST_Y(geom::geometry)`.as('lat'),
            sql<number | null>`ST_X(geom::geometry)`.as('lon'),
          ])
          .where('id', '=', r.location_id)
          .executeTakeFirst()
      : undefined;
    const due = new Date(r.last_confirmed_at.getTime() + RECHECK_DAYS * 86_400_000);
    return {
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      name: r.name,
      kind: r.kind,
      status: r.status,
      address: loc
        ? { line1: loc.line1, unit: loc.unit, city: loc.city, state: loc.state, postal: loc.postal }
        : null,
      position: loc && loc.lat !== null && loc.lon !== null ? { lat: loc.lat, lon: loc.lon } : null,
      sqft: r.sqft,
      ada: r.ada,
      powerBackup: r.power_backup,
      kitchen: r.kitchen,
      showers: r.showers,
      petPolicy: r.pet_policy,
      parkingSpaces: r.parking_spaces,
      truckAccess: r.truck_access,
      floodplain: r.floodplain,
      mouStatus: r.mou_status,
      mouExpiresOn: r.mou_expires_on ? r.mou_expires_on.toISOString().slice(0, 10) : null,
      communities: r.communities,
      notes: r.notes,
      ownerTenantId: r.owner_tenant_id,
      source: r.source,
      approvedBy: r.approved_by,
      approvedAt: iso(r.approved_at),
      lastConfirmedAt: iso(r.last_confirmed_at)!,
      confirmDueAt: due.toISOString(),
      stale: due.getTime() < Date.now(),
      unknown: UNKNOWABLE.filter(([c]) => r[c] === null).map(([, k]) => k),
      contacts:
        showContacts && r.contacts_enc
          ? (JSON.parse(
              await base.fieldCrypto.decrypt(r.tenant_id, r.contacts_enc),
            ) as FacilityOut['contacts'])
          : showContacts
            ? []
            : null,
    };
  }

  const changeToOut = (c: ChangeRow, name: string | null): z.infer<typeof changeOut> => ({
    id: c.id,
    version: c.version,
    createdAt: iso(c.created_at)!,
    updatedAt: iso(c.updated_at)!,
    facilityId: c.facility_id,
    facilityName: name,
    change: c.change,
    proposed: c.proposed,
    source: c.source,
    proposedBy: c.proposed_by,
    proposedByTenantId: c.proposed_by_tenant_id,
    state: c.state,
    decidedBy: c.decided_by,
    decidedAt: iso(c.decided_at),
    decisionReason: c.decision_reason,
  });

  /** Where a proposal comes from: the COAD chair's, a partner's, or county staff's. */
  const sourceOf = (request: FastifyRequest): ChangeRow['source'] => {
    const s = account(request);
    if (s.tenantKind === 'partner_org') return 'owner';
    return s.roles.some((r) => r.templateKey === 'coad_chair') ? 'coad' : 'county';
  };

  /** Applies approved attributes to an entry (or a new one) and returns it. */
  async function apply(
    trx: Trx,
    tenantId: string,
    current: Row | null,
    a: AttrPatch,
    contactsEnc: Buffer | null | undefined,
    actor: string,
    extra: Partial<Record<keyof Row, unknown>> = {},
  ): Promise<Row> {
    const locationId = await saveLocation(trx, tenantId, current?.location_id ?? null, a, actor);
    const cols = {
      ...columnsOf(a),
      ...(contactsEnc !== undefined ? { contacts_enc: contactsEnc } : {}),
      location_id: locationId,
      ...extra,
    };
    if (current)
      return trx
        .updateTable('cg.facility')
        .set({ ...cols, updated_by: actor } as never)
        .where('id', '=', current.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    return trx
      .insertInto('cg.facility')
      .values({
        tenant_id: tenantId,
        created_by: actor,
        updated_by: actor,
        ...cols,
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  const proposedOf = (a: AttrPatch) => {
    const { contacts: _contacts, ...rest } = a;
    void _contacts;
    return rest;
  };

  // ---------------------------------------------------------------- read
  app.get(
    '/facilities',
    {
      schema: {
        tags: ['facilities'],
        querystring: listQuery.extend({
          kind: z.enum(kinds).optional(),
          status: z.enum(['approved', 'retired']).default('approved'),
          stale: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(facilityOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('facility.read', { type: 'facility', tenantId: s.tenantId });
      const q = request.query;
      return request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.facility')
          .selectAll()
          .where('status', '=', q.status)
          .orderBy('name')
          .limit(q.limit)
          .offset(q.offset);
        if (q.kind) x = x.where('kind', '=', q.kind);
        if (q.stale !== undefined)
          x = x.where(
            'last_confirmed_at',
            q.stale ? '<' : '>=',
            new Date(Date.now() - RECHECK_DAYS * 86_400_000),
          );
        const rows = await x.execute();
        // The list never carries contacts; one entry at a time, audited.
        return Promise.all(rows.map((r) => toOut(trx, r, false)));
      });
    },
  );

  app.get(
    '/facilities/:id',
    { schema: { tags: ['facilities'], params: uuidParam, response: { 200: facilityOut } } },
    async (request) => {
      const s = account(request);
      const decision = await request.authorize(
        'facility.read',
        { type: 'facility', tenantId: s.tenantId, id: request.params.id, fields: FIELDS },
        { asNotFound: true },
      );
      const show = decision.fields.includes('contacts');
      return request.tx(async (trx) => {
        const row = await trx
          .selectFrom('cg.facility')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!row) throw errors.notFound();
        if (show && decision.restrictedRead.length > 0 && row.contacts_enc)
          await request.audit(trx, {
            action: 'facility.read_contacts',
            targetType: 'facility',
            targetId: row.id,
            targetVersion: row.version,
            classificationRead: decision.restrictedRead,
          });
        return toOut(trx, row, show);
      });
    },
  );

  // ---------------------------------------------------------------- create or propose
  app.post(
    '/facilities',
    {
      config: { idempotent: true },
      schema: {
        tags: ['facilities'],
        body: attributesIn,
        response: { 201: facilityOut, 202: changeOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('facility.manage', { type: 'facility', tenantId: s.tenantId });
      const b = request.body;
      const contactsEnc = await encryptContacts(s.tenantId, b.contacts);
      if (canApprove(request)) {
        // County EM enters it straight into the registry, as its approver.
        const out = await request.tx(async (trx) => {
          const row = await apply(trx, s.tenantId, null, b, contactsEnc, s.accountId, {
            source: 'county',
            approved_by: s.accountId,
            approved_at: new Date(),
          });
          await request.audit(trx, {
            action: 'facility.create',
            targetType: 'facility',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(null, proposedOf(b), classifierFor('facility')),
          });
          return toOut(trx, row, true);
        });
        return reply.code(201).send(out);
      }
      const change = await request.tx(async (trx) => {
        const c = await trx
          .insertInto('cg.facility_change')
          .values({
            tenant_id: s.tenantId,
            facility_id: null,
            change: 'create',
            proposed: JSON.stringify(proposedOf(b)),
            contacts_enc: contactsEnc ?? null,
            source: sourceOf(request),
            proposed_by: s.accountId,
            proposed_by_tenant_id: s.tenantId,
            execution_id: request.executionId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'facility.propose',
          targetType: 'facility_change',
          targetId: c.id,
          targetVersion: c.version,
          changes: diffForAudit(null, proposedOf(b), classifierFor('facility')),
        });
        return c;
      });
      return reply.code(202).send(changeToOut(change, b.name));
    },
  );

  // ---------------------------------------------------------------- update or propose a change
  app.patch(
    '/facilities/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['facilities'],
        params: uuidParam,
        body: attributesIn.partial(),
        response: { 200: facilityOut, 202: changeOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('facility.manage', {
        type: 'facility',
        tenantId: s.tenantId,
        id: request.params.id,
      });
      const b = request.body;
      const contactsEnc = await encryptContacts(s.tenantId, b.contacts);
      const direct = canApprove(request);
      const result = await request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.facility')
          .selectAll()
          .where('id', '=', request.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw errors.notFound();
        if (current.version !== request.expectedVersion())
          throw errors.conflict(await toOut(trx, current, false));
        if (direct) {
          const row = await apply(trx, s.tenantId, current, b, contactsEnc, s.accountId);
          const after = columnsOf(proposedOf(b)) as Record<string, unknown>;
          const before = Object.fromEntries(
            Object.keys(after).map((k) => [k, (current as Record<string, unknown>)[k]]),
          );
          await request.audit(trx, {
            action: 'facility.update',
            targetType: 'facility',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(before, after, classifierFor('facility')),
          });
          return { kind: 'applied' as const, out: await toOut(trx, row, true) };
        }
        const c = await trx
          .insertInto('cg.facility_change')
          .values({
            tenant_id: s.tenantId,
            facility_id: current.id,
            change: 'update',
            proposed: JSON.stringify(proposedOf(b)),
            contacts_enc: contactsEnc ?? null,
            source: sourceOf(request),
            proposed_by: s.accountId,
            proposed_by_tenant_id: s.tenantId,
            execution_id: request.executionId,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'facility.propose',
          targetType: 'facility_change',
          targetId: c.id,
          targetVersion: c.version,
        });
        return { kind: 'proposed' as const, out: changeToOut(c, current.name) };
      });
      return result.kind === 'applied' ? result.out : reply.code(202).send(result.out);
    },
  );

  // ---------------------------------------------------------------- re-check (REC-01)
  app.post(
    '/facilities/:id/confirm',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['facilities'],
        params: uuidParam,
        body: z.object({ note: z.string().trim().max(500).optional() }),
        response: { 200: facilityOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('facility.manage', {
        type: 'facility',
        tenantId: s.tenantId,
        id: request.params.id,
      });
      return request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.facility')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!current) throw errors.notFound();
        const row = assertUpdated(
          await trx
            .updateTable('cg.facility')
            .set({ last_confirmed_at: new Date(), updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', request.expectedVersion())
            .returningAll()
            .executeTakeFirst(),
          await toOut(trx, current, false),
        );
        await request.audit(trx, {
          action: 'facility.confirm',
          targetType: 'facility',
          targetId: row.id,
          targetVersion: row.version,
          reason: request.body.note ?? null,
        });
        return toOut(trx, row, false);
      });
    },
  );

  // ---------------------------------------------------------------- approval queue
  app.get(
    '/facility-changes',
    {
      schema: {
        tags: ['facilities'],
        querystring: listQuery.extend({
          state: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending'),
        }),
        response: { 200: z.array(changeOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('facility.read', { type: 'facility', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.facility_change as c')
          .leftJoin('cg.facility as f', 'f.id', 'c.facility_id')
          .selectAll('c')
          .select('f.name as facility_name')
          .where('c.state', '=', request.query.state)
          .orderBy('c.created_at')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map((r) =>
        changeToOut(
          r,
          r.facility_name ?? (typeof r.proposed['name'] === 'string' ? r.proposed['name'] : null),
        ),
      );
    },
  );

  app.post(
    '/facility-changes/:id/decision',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['facilities'],
        params: uuidParam,
        body: z.object({
          decision: z.enum(['approve', 'reject']),
          reason: z.string().trim().min(3).max(500),
        }),
        response: { 200: changeOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('facility.approve', { type: 'facility', tenantId: s.tenantId });
      const b = request.body;
      return request.tx(async (trx) => {
        const c = await trx
          .selectFrom('cg.facility_change')
          .selectAll()
          .where('id', '=', request.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!c) throw errors.notFound();
        if (c.version !== request.expectedVersion()) throw errors.conflict(changeToOut(c, null));
        if (c.state !== 'pending')
          throw new ApiError(409, 'already_decided', 'This proposal was already decided.');
        // A7 applied to the registry: nobody approves their own proposal.
        if (c.proposed_by && c.proposed_by === s.accountId)
          throw new ApiError(
            403,
            'own_proposal',
            'Someone other than the person who proposed it must decide.',
          );
        let name: string | null = null;
        if (b.decision === 'approve') {
          const a = c.proposed as AttrPatch;
          const current = c.facility_id
            ? ((await trx
                .selectFrom('cg.facility')
                .selectAll()
                .where('id', '=', c.facility_id)
                .forUpdate()
                .executeTakeFirst()) ?? null)
            : null;
          if (c.facility_id && !current) throw errors.notFound();
          const row = await apply(
            trx,
            s.tenantId,
            current,
            c.change === 'retire' ? {} : a,
            c.contacts_enc ?? undefined,
            s.accountId,
            c.change === 'create'
              ? {
                  source: c.source === 'owner' ? 'owner' : c.source,
                  owner_tenant_id: c.source === 'owner' ? c.proposed_by_tenant_id : null,
                  approved_by: s.accountId,
                  approved_at: new Date(),
                }
              : c.change === 'retire'
                ? { status: 'retired' }
                : // REC-01: an owner's re-check, approved, starts the entry's next yearly cycle.
                  c.source === 'owner_link'
                  ? { last_confirmed_at: new Date() }
                  : {},
          );
          name = row.name;
          await request.audit(trx, {
            action: `facility.${c.change}`,
            targetType: 'facility',
            targetId: row.id,
            targetVersion: row.version,
            reason: `approved proposal ${c.id}: ${b.reason}`,
          });
        }
        const decided = await trx
          .updateTable('cg.facility_change')
          .set({
            state: b.decision === 'approve' ? 'approved' : 'rejected',
            decided_by: s.accountId,
            decided_at: new Date(),
            decision_reason: b.reason,
            updated_by: s.accountId,
          })
          .where('id', '=', c.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: `facility_change.${b.decision}`,
          targetType: 'facility_change',
          targetId: c.id,
          targetVersion: decided.version,
          reason: b.reason,
        });
        return changeToOut(
          decided,
          name ?? (typeof c.proposed['name'] === 'string' ? c.proposed['name'] : null),
        );
      });
    },
  );
};
