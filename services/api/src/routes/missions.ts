/**
 * Missions and assignments (layer-4 plan §3, task C; MIS-01–04, CALL-01,
 * BRD:FR-02.01–02.06, FR-06.01–06.07, FR-07.01–07.06, PPL-01, RULE-03,
 * RULE-04, RULE-05, RULE-06, RULE-14, AC-02A/B/C, AC-05B, AC-06A/B/C/D,
 * AC-07A/B/C, PER-02, DSP-09).
 *
 * A mission is any unit of field work inside an activated event. Draft-save
 * needs an event and a kind; intake-save (state open) needs a summary and a
 * location or an explicit unknown; dispatch needs an open mission. The
 * reference comes from the database counter and is never reused. Locks apply
 * to every write path alike. Assignments are rows of facts: assigning never
 * dispatches, dispatching never delivers, and nothing sets an arrival but a
 * person. Conflicts (double-booked, off duty, over hours, missing credential,
 * inactive) are warnings an authorized override can accept with a reason.
 * Closure needs a disposition and releases what is still assigned, keeping
 * the history. Partner dispatchers work in the county's records but see only
 * what their organization owns or is assigned to (DSP-09).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Insertable, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import { decide, type FieldDescriptor } from '@cg/authz';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso, listQuery, pickDefined, stamped, uuidParam } from './helpers.ts';

type MissionRow = Selectable<Database['cg.mission']>;
type AssignmentRow = Selectable<Database['cg.assignment']>;
type PersonRow = Selectable<Database['cg.mission_person']>;
type Trx = Transaction<Database>;

const kinds = [
  'welfare_check',
  'verification_route',
  'cleanup_work_order',
  'delivery',
  'outreach_sweep',
  'site_staffing',
  'search',
  'road_clearance',
  'traffic_control',
  'debris',
  'other',
] as const;
const states = ['draft', 'open', 'en_route', 'on_scene', 'cleared', 'closed', 'canceled'] as const;
const priorities = ['low', 'normal', 'high', 'urgent'] as const;
const urgencies = ['routine', 'soon', 'now'] as const;
const sources = ['need', 'report', 'call', 'walk_in', 'field', 'staff', 'board'] as const;
const dispositions = [
  'completed',
  'referred',
  'no_action_needed',
  'unable_to_locate',
  'canceled',
  'duplicate',
  'transferred',
  'other',
] as const;
const locationStates = ['verified', 'approximate', 'manual', 'unknown'] as const;
const narrativeRoles = [
  'call_taker',
  'dispatcher',
  'responder',
  'supervisor',
  'follow_up',
] as const;
const assignmentStates = [
  'assigned',
  'dispatched',
  'acknowledged',
  'declined',
  'en_route',
  'on_scene',
  'cleared',
  'released',
] as const;
const dispatchMethods = ['app', 'text', 'radio', 'phone', 'in_person'] as const;
const personRoles = [
  'survivor',
  'reporting_party',
  'witness',
  'subject',
  'victim',
  'caregiver',
  'property_owner',
  'other',
] as const;
const injuries = ['none', 'minor', 'serious', 'critical', 'deceased', 'unknown'] as const;
const transports = ['none', 'ems', 'own', 'shelter_transport', 'other', 'unknown'] as const;
const mediaKinds = [
  'photo',
  'document',
  'audio',
  'video',
  'bodycam_reference',
  'live_feed_reference',
] as const;

/** The allowed state graph (MIS-02, FR-06.04, B6): cancel, close and reopen have their own routes. */
const TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['open'],
  open: ['en_route', 'on_scene', 'cleared'],
  en_route: ['on_scene', 'cleared', 'open'],
  on_scene: ['cleared', 'en_route'],
  cleared: ['on_scene'],
  closed: [],
  canceled: [],
};

const callerIn = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  email: z.email().optional(),
  address: z.string().max(400).optional(),
  role: z.string().max(80).optional(),
});
const positionIn = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
const locationIn = z.object({
  line1: z.string().max(200).nullable().optional(),
  unit: z.string().max(60).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  stateCode: z.string().max(40).nullable().optional(),
  postal: z.string().max(12).nullable().optional(),
  crossStreets: z.string().max(200).nullable().optional(),
  landmark: z.string().max(300).nullable().optional(),
  position: positionIn.nullable().optional(),
  /** FR-03.03: approximate and unknown are states of their own; 0,0 is never a substitute. */
  state: z.enum(locationStates).optional(),
});

const missionFields = {
  eventId: z.uuid(),
  kind: z.enum(kinds),
  subcategory: z.string().max(80).nullable(),
  priority: z.enum(priorities),
  urgency: z.enum(urgencies),
  source: z.enum(sources),
  summary: z.string().max(4000).nullable(),
  conditions: z.string().max(4000).nullable(),
  caller: callerIn.nullable(),
  callerLanguage: z.string().max(10).nullable(),
  interpreterNeeded: z.boolean(),
  location: locationIn.nullable(),
  needId: z.uuid().nullable(),
  reportId: z.uuid().nullable(),
  siteId: z.uuid().nullable(),
  route: z.record(z.string(), z.unknown()).nullable(),
  owningTenantId: z.uuid().nullable(),
  requiredCredentials: z.array(z.string().max(60)).max(20),
  reportRequired: z.boolean(),
  caseReference: z.string().max(120).nullable(),
};

const assignmentOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  missionId: z.uuid(),
  resourceKind: z.enum(['person', 'team']),
  personnelId: z.uuid().nullable(),
  teamId: z.uuid().nullable(),
  state: z.enum(assignmentStates),
  assignedAt: z.iso.datetime(),
  assignedBy: z.uuid().nullable(),
  suggested: z.boolean(),
  conflicts: z.array(z.object({ kind: z.string(), detail: z.string() })),
  overrideReason: z.string().nullable(),
  dispatchedAt: z.iso.datetime().nullable(),
  dispatchMethod: z.enum(dispatchMethods).nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  declinedAt: z.iso.datetime().nullable(),
  declinedReason: z.string().nullable(),
  enRouteAt: z.iso.datetime().nullable(),
  onSceneAt: z.iso.datetime().nullable(),
  clearedAt: z.iso.datetime().nullable(),
  releasedAt: z.iso.datetime().nullable(),
  releaseReason: z.string().nullable(),
});
type AssignmentOut = z.infer<typeof assignmentOut>;

const timelineOut = z.object({
  id: z.uuid(),
  kind: z.string(),
  narrativeRole: z.string().nullable(),
  fromState: z.string().nullable(),
  toState: z.string().nullable(),
  actorAccountId: z.uuid().nullable(),
  reason: z.string().nullable(),
  body: z.string().nullable(),
  amendsEventId: z.uuid().nullable(),
  detail: z.record(z.string(), z.unknown()),
  occurredAt: z.iso.datetime(),
});

const missionOut = z.object({
  ...stamped,
  tenantId: z.uuid(),
  eventId: z.uuid(),
  reference: z.string(),
  kind: z.enum(kinds),
  subcategory: z.string().nullable(),
  state: z.enum(states),
  priority: z.enum(priorities),
  urgency: z.enum(urgencies),
  source: z.enum(sources),
  summary: z.string().nullable(),
  conditions: z.string().nullable(),
  /** Present only when the caller may see contact details (restricted, CALL-01). */
  caller: callerIn.nullable().optional(),
  callerLanguage: z.string().nullable(),
  interpreterNeeded: z.boolean(),
  location: z
    .object({
      line1: z.string().nullable(),
      unit: z.string().nullable(),
      city: z.string().nullable(),
      stateCode: z.string().nullable(),
      postal: z.string().nullable(),
      landmark: z.string().nullable(),
      position: positionIn.nullable(),
      precision: z.string(),
      usng: z.string().nullable(),
    })
    .nullable(),
  locationState: z.enum(locationStates),
  needId: z.uuid().nullable(),
  reportId: z.uuid().nullable(),
  siteId: z.uuid().nullable(),
  route: z.record(z.string(), z.unknown()).nullable(),
  owningTenantId: z.uuid().nullable(),
  requiredCredentials: z.array(z.string()),
  lock: z.object({ by: z.uuid(), at: z.iso.datetime(), reason: z.string().nullable() }).nullable(),
  disposition: z.enum(dispositions).nullable(),
  dispositionNote: z.string().nullable(),
  caseReference: z.string().nullable(),
  reportRequired: z.boolean(),
  reportGenerated: z.boolean(),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  openedAt: z.iso.datetime().nullable(),
  clearedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closedReason: z.string().nullable(),
  reopenedCount: z.number().int(),
  /** FR-02.02: what still blocks dispatch (empty once the mission can be dispatched). */
  dispatchBlockers: z.array(z.string()),
  /**
   * SEC-12, ADR-0038: law-enforcement details are held in the CJIS enclave. Console
   * readers see only that they are restricted; holders of mission.cji.open also get the
   * opaque reference and the enclave address to open it there. Never sent to phones or
   * partner organizations.
   */
  cjis: z
    .object({
      restricted: z.literal(true),
      ref: z.string().optional(),
      url: z.string().optional(),
      linkedAt: z.iso.datetime().optional(),
    })
    .nullable()
    .optional(),
  assignments: z.array(assignmentOut).optional(),
  timeline: z.array(timelineOut).optional(),
});
type MissionOut = z.infer<typeof missionOut>;

const personOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  missionId: z.uuid(),
  role: z.enum(personRoles),
  displayLabel: z.string().nullable(),
  /** Restricted (contact category): name, demographics, contact, address. */
  details: z.record(z.string(), z.unknown()).nullable().optional(),
  injury: z.enum(injuries).nullable(),
  /** Restricted (health category). */
  injuryDetail: z.string().nullable().optional(),
  transport: z.enum(transports).nullable(),
  transportDestination: z.string().nullable(),
  transportStartedAt: z.iso.datetime().nullable(),
  transportEndedAt: z.iso.datetime().nullable(),
  /** Restricted (counseling category, AC-04C). */
  behavioralHealth: z.string().nullable().optional(),
  partyId: z.uuid().nullable(),
  status: z.enum(['active', 'removed']),
  removedReason: z.string().nullable(),
});

const mediaOut = z.object({
  id: z.uuid(),
  missionId: z.uuid(),
  kind: z.enum(mediaKinds),
  photoId: z.uuid().nullable(),
  originalName: z.string().nullable(),
  contentType: z.string().nullable(),
  bytes: z.number().int().nullable(),
  description: z.string().nullable(),
  source: z.string(),
  accessClass: z.enum(['internal', 'restricted']),
  uploadedBy: z.uuid().nullable(),
  uploadedAt: z.iso.datetime(),
  removedAt: z.iso.datetime().nullable(),
  removedReason: z.string().nullable(),
});

const PERSON_FIELDS: FieldDescriptor[] = [
  { name: 'role', category: 'basic', classification: 'internal' },
  { name: 'displayLabel', category: 'basic', classification: 'sensitive' },
  { name: 'details', category: 'contact', classification: 'restricted' },
  { name: 'injury', category: 'basic', classification: 'sensitive' },
  { name: 'injuryDetail', category: 'health', classification: 'restricted' },
  { name: 'transport', category: 'basic', classification: 'internal' },
  { name: 'behavioralHealth', category: 'counseling', classification: 'restricted' },
  // Law-enforcement roles and details live only in the CJIS enclave (SEC-12, PPL-01, migration 0041).
];
const MISSION_FIELDS: FieldDescriptor[] = [
  { name: 'summary', category: 'basic', classification: 'sensitive' },
  { name: 'caller', category: 'contact', classification: 'restricted' },
  { name: 'location', category: 'location_exact', classification: 'sensitive' },
];

const locked = (by: string) =>
  new ApiError(423, 'mission_locked', 'This mission is locked by another person.', {
    details: { lockedBy: by },
  });
const notAllowed = (from: string, to: string) =>
  errors.validation([{ name: 'to', message: `cannot go from ${from} to ${to}` }]);

/** Where browsers reach the CJIS enclave (ADR-0038); absent: the link carries no address. */
export interface MissionDeps {
  cjisPublicUrl?: string;
}

/** A random 256-bit opaque reference, 43 base64url characters (migration 0041). */
export const newCjiRef = (): string => randomBytes(32).toString('base64url');

export const missionRoutesWith =
  (deps: MissionDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    /**
     * DSP-09: a partner organization works in its county's records, limited to the
     * missions it owns or is assigned to; the county works in its own.
     */
    interface Scope {
      tenantId: string;
      partnerId: string | null;
      teamIds: string[];
      personnelIds: string[];
      /** FLD-14: the caller's own personnel records and current teams; a grant with `records: 'own'` reaches only work they hold. */
      holder: { personnelIds: string[]; teamIds: string[] };
    }
    async function holderOf(trx: Trx, accountId: string): Promise<Scope['holder']> {
      const people = await trx
        .selectFrom('cg.personnel')
        .select('id')
        .where('account_id', '=', accountId)
        .execute();
      const personnelIds = people.map((p) => p.id);
      const teams = personnelIds.length
        ? await trx
            .selectFrom('cg.team_member')
            .select('team_id')
            .where('personnel_id', 'in', personnelIds)
            .where('left_at', 'is', null)
            .execute()
        : [];
      return { personnelIds, teamIds: [...new Set(teams.map((t) => t.team_id))] };
    }
    async function scopeOf(request: FastifyRequest): Promise<Scope> {
      const s = account(request);
      return request.tx(async (trx) => {
        const holder = await holderOf(trx, s.accountId);
        if (s.tenantKind !== 'partner_org')
          return { tenantId: s.tenantId, partnerId: null, teamIds: [], personnelIds: [], holder };
        const me = await trx
          .selectFrom('cg.tenant')
          .select('parent_id')
          .where('id', '=', s.tenantId)
          .executeTakeFirst();
        const teams = await trx.selectFrom('cg.team').select('id').execute();
        const people = await trx.selectFrom('cg.personnel').select('id').execute();
        return {
          tenantId: me?.parent_id ?? s.tenantId,
          partnerId: s.tenantId,
          teamIds: teams.map((t) => t.id),
          personnelIds: people.map((p) => p.id),
          holder,
        };
      });
    }
    /** Whether an active assignment on the mission is held by the caller or one of the caller's teams (FLD-14). */
    const heldFilter = (holder: Scope['holder'], fallback: string) => ({
      teamIds: holder.teamIds.length ? holder.teamIds : [fallback],
      personnelIds: holder.personnelIds.length ? holder.personnelIds : [fallback],
    });
    const run = <T>(request: FastifyRequest, scope: Scope, fn: (trx: Trx) => Promise<T>) =>
      scope.partnerId ? request.txAs(scope.tenantId, fn) : request.tx(fn);

    type Joined = MissionRow & {
      line1: string | null;
      unit: string | null;
      city: string | null;
      address_state: string | null;
      postal: string | null;
      landmark: string | null;
      precision: string | null;
      usng: string | null;
      lat: number | string | null;
      lon: number | string | null;
      /** Set by load(): the caller holds an active assignment on it (FLD-14). */
      held?: boolean;
    };

    const query = (trx: Trx) =>
      trx
        .selectFrom('cg.mission as m')
        .leftJoin('cg.location as l', 'l.id', 'm.location_id')
        .selectAll('m')
        .select([
          'l.line1',
          'l.unit',
          'l.city',
          'l.state as address_state',
          'l.postal',
          'l.landmark',
          'l.precision',
          'l.usng',
          sql<number | null>`ST_Y(l.geom)`.as('lat'),
          sql<number | null>`ST_X(l.geom)`.as('lon'),
        ]);

    function dispatchBlockers(r: MissionRow): string[] {
      const out: string[] = [];
      if (!r.summary || r.summary.trim().length < 3) out.push('summary');
      if (r.location_state === 'unknown' && !r.location_id) out.push('location');
      if (r.state === 'draft') out.push('state:draft');
      if (r.state === 'closed' || r.state === 'canceled') out.push(`state:${r.state}`);
      return out;
    }

    async function toOut(
      r: Joined,
      opts: { caller?: boolean; location?: boolean; cjisMarker?: boolean } = {},
    ): Promise<MissionOut> {
      let caller: z.infer<typeof callerIn> | null | undefined;
      if (opts.caller) {
        caller = r.caller_enc
          ? (JSON.parse(await app.fieldCrypto.decrypt(r.tenant_id, r.caller_enc)) as z.infer<
              typeof callerIn
            >)
          : null;
      }
      const exact = opts.location !== false;
      return {
        id: r.id,
        version: r.version,
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        tenantId: r.tenant_id,
        eventId: r.event_id,
        reference: r.reference,
        kind: r.kind,
        subcategory: r.subcategory,
        state: r.state,
        priority: r.priority,
        urgency: r.urgency,
        source: r.source,
        summary: r.summary,
        conditions: r.conditions,
        ...(caller !== undefined ? { caller } : {}),
        callerLanguage: r.caller_language,
        interpreterNeeded: r.interpreter_needed,
        location: r.location_id
          ? {
              line1: exact ? r.line1 : null,
              unit: exact ? r.unit : null,
              city: r.city,
              stateCode: exact ? r.address_state : null,
              postal: r.postal,
              landmark: r.landmark,
              position:
                exact && r.lat !== null && r.lon !== null
                  ? { lat: Number(r.lat), lon: Number(r.lon) }
                  : null,
              precision: r.precision ?? 'unknown',
              usng: exact ? r.usng : null,
            }
          : null,
        locationState: r.location_state,
        needId: r.need_id,
        reportId: r.report_id,
        siteId: r.site_id,
        route: (r.route as Record<string, unknown> | null) ?? null,
        owningTenantId: r.owning_tenant_id,
        requiredCredentials: r.required_credentials,
        lock: r.lock_by ? { by: r.lock_by, at: iso(r.lock_at)!, reason: r.lock_reason } : null,
        disposition: r.disposition,
        dispositionNote: r.disposition_note,
        caseReference: r.case_reference,
        reportRequired: r.report_required,
        reportGenerated: r.report_generated,
        reviewedBy: r.reviewed_by,
        reviewedAt: iso(r.reviewed_at),
        openedAt: iso(r.opened_at),
        clearedAt: iso(r.cleared_at),
        closedAt: iso(r.closed_at),
        closedReason: r.closed_reason,
        reopenedCount: r.reopened_count,
        dispatchBlockers: dispatchBlockers(r),
        ...(opts.cjisMarker ? { cjis: r.cji_ref ? { restricted: true as const } : null } : {}),
      };
    }

    /**
     * SEC-12: only console staff who read missions broadly see that a mission is linked
     * to the CJIS enclave; phones (own-records grants) and partner organizations never do.
     */
    const showsCjisMarker = (scope: Scope, recordScope: 'all' | 'own') =>
      !scope.partnerId && recordScope === 'all';

    /** The enclave address for a linked mission (ADR-0038): the enclave app opens the record there. */
    async function cjisLink(trx: Trx, r: MissionRow, tenantId: string) {
      if (!r.cji_ref) return null;
      const t = await trx
        .selectFrom('cg.tenant')
        .select('slug')
        .where('id', '=', tenantId)
        .executeTakeFirst();
      const url = deps.cjisPublicUrl
        ? `${deps.cjisPublicUrl.replace(/\/$/, '')}/records/${r.cji_ref}?${new URLSearchParams({
            mission: r.reference,
            county: String(t?.slug ?? ''),
          }).toString()}`
        : undefined;
      return {
        restricted: true as const,
        ref: r.cji_ref,
        ...(url ? { url } : {}),
        ...(r.cji_linked_at ? { linkedAt: iso(r.cji_linked_at)! } : {}),
      };
    }

    const assignmentToOut = (a: AssignmentRow): AssignmentOut => ({
      id: a.id,
      version: a.version,
      missionId: a.mission_id,
      resourceKind: a.resource_kind,
      personnelId: a.personnel_id,
      teamId: a.team_id,
      state: a.state,
      assignedAt: iso(a.assigned_at)!,
      assignedBy: a.assigned_by,
      suggested: a.suggested,
      conflicts: (a.conflicts as unknown as { kind: string; detail: string }[] | null) ?? [],
      overrideReason: a.override_reason,
      dispatchedAt: iso(a.dispatched_at),
      dispatchMethod: a.dispatch_method,
      deliveredAt: iso(a.delivered_at),
      acknowledgedAt: iso(a.acknowledged_at),
      declinedAt: iso(a.declined_at),
      declinedReason: a.declined_reason,
      enRouteAt: iso(a.en_route_at),
      onSceneAt: iso(a.on_scene_at),
      clearedAt: iso(a.cleared_at),
      releasedAt: iso(a.released_at),
      releaseReason: a.release_reason,
    });

    /** Loads a mission inside the scope; a partner only sees what it owns or works. */
    async function load(request: FastifyRequest, scope: Scope, id: string): Promise<Joined> {
      const row = await run(request, scope, async (trx) => {
        const r = (await query(trx).where('m.id', '=', id).executeTakeFirst()) as
          Joined | undefined;
        if (!r) return r;
        const h = heldFilter(scope.holder, id);
        r.held = !!(await trx
          .selectFrom('cg.assignment')
          .select('id')
          .where('mission_id', '=', id)
          .where('released_at', 'is', null)
          .where((eb) =>
            eb.or([eb('team_id', 'in', h.teamIds), eb('personnel_id', 'in', h.personnelIds)]),
          )
          .executeTakeFirst());
        if (!scope.partnerId) return r;
        if (r.owning_tenant_id === scope.partnerId) return r;
        const mine = await trx
          .selectFrom('cg.assignment')
          .select('id')
          .where('mission_id', '=', id)
          .where('released_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('team_id', 'in', scope.teamIds.length ? scope.teamIds : [id]),
              eb('personnel_id', 'in', scope.personnelIds.length ? scope.personnelIds : [id]),
            ]),
          )
          .executeTakeFirst();
        return mine ? r : undefined;
      });
      if (!row) throw errors.notFound();
      return row;
    }

    const resourceOf = (
      s: { tenantId: string },
      r: MissionRow & { held?: boolean },
      fields?: FieldDescriptor[],
    ) => ({
      type: 'mission',
      id: r.id,
      tenantId: s.tenantId,
      eventId: r.event_id,
      ...(r.held !== undefined ? { heldBySubject: r.held } : {}),
      ...(fields ? { fields } : {}),
    });

    /** RULE-05: a lock holds against every write path, manual or command, except for its holder. */
    function assertUnlocked(r: MissionRow, accountId: string): void {
      if (r.lock_by && r.lock_by !== accountId) throw locked(r.lock_by);
    }

    async function saveLocation(
      trx: Trx,
      tenantId: string,
      existing: string | null,
      loc: z.infer<typeof locationIn> | null | undefined,
      accountId: string,
    ): Promise<{ id: string | null; state: (typeof locationStates)[number] }> {
      if (loc === undefined) return { id: existing, state: 'unknown' };
      if (loc === null) return { id: null, state: 'unknown' };
      const hasPoint = !!loc.position;
      const state: (typeof locationStates)[number] =
        loc.state ?? (hasPoint ? 'approximate' : loc.line1 || loc.landmark ? 'manual' : 'unknown');
      const precision =
        state === 'verified'
          ? 'exact'
          : state === 'approximate'
            ? 'approximate'
            : state === 'manual'
              ? 'area'
              : 'unknown';
      const values = {
        line1: loc.line1 ?? null,
        unit: loc.unit ?? null,
        city: loc.city ?? null,
        state: loc.stateCode ?? null,
        postal: loc.postal ?? null,
        landmark: [loc.landmark, loc.crossStreets].filter(Boolean).join(' / ') || null,
        geom: loc.position
          ? sql`ST_SetSRID(ST_MakePoint(${loc.position.lon}, ${loc.position.lat}), 4326)`
          : null,
        precision: precision as 'exact' | 'approximate' | 'area' | 'unknown',
        source: 'reviewer' as const,
        no_fixed_address: !loc.line1,
      };
      if (existing) {
        await trx
          .updateTable('cg.location')
          .set({ ...values, updated_by: accountId })
          .where('id', '=', existing)
          .execute();
        return { id: existing, state };
      }
      const row = await trx
        .insertInto('cg.location')
        .values({ tenant_id: tenantId, created_by: accountId, updated_by: accountId, ...values })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: row.id, state };
    }

    async function timelineEntry(
      trx: Trx,
      tenantId: string,
      missionId: string,
      entry: Partial<Insertable<Database['cg.mission_event']>> & {
        kind: Database['cg.mission_event']['kind'];
      },
    ) {
      await trx
        .insertInto('cg.mission_event')
        .values({ tenant_id: tenantId, mission_id: missionId, ...entry } as never)
        .execute();
    }

    async function significant(
      trx: Trx,
      tenantId: string,
      eventId: string,
      kind: Database['cg.significant_event']['kind'],
      summary: string,
      missionId: string,
      actor: string,
      teamId: string | null = null,
    ) {
      await trx
        .insertInto('cg.significant_event')
        .values({
          tenant_id: tenantId,
          event_id: eventId,
          kind,
          summary,
          mission_id: missionId,
          team_id: teamId,
          actor_account_id: actor,
        })
        .execute();
    }

    async function activity(
      trx: Trx,
      tenantId: string,
      eventId: string,
      a: AssignmentRow,
      kind: Database['cg.activity_entry']['kind'],
      summary: string,
      actor: string,
    ) {
      await trx
        .insertInto('cg.activity_entry')
        .values({
          tenant_id: tenantId,
          event_id: eventId,
          personnel_id: a.personnel_id,
          team_id: a.team_id,
          kind,
          summary,
          ref_kind: 'assignment',
          ref_id: a.id,
          actor_account_id: actor,
        })
        .execute();
    }

    const columnMap = {
      kind: 'kind',
      subcategory: 'subcategory',
      priority: 'priority',
      urgency: 'urgency',
      source: 'source',
      summary: 'summary',
      conditions: 'conditions',
      callerLanguage: 'caller_language',
      interpreterNeeded: 'interpreter_needed',
      needId: 'need_id',
      reportId: 'report_id',
      siteId: 'site_id',
      owningTenantId: 'owning_tenant_id',
      requiredCredentials: 'required_credentials',
      reportRequired: 'report_required',
      caseReference: 'case_reference',
    } as const;

    type MissionBody = {
      [K in keyof typeof missionFields]?: z.infer<(typeof missionFields)[K]> | undefined;
    };
    async function columns(tenantId: string, b: MissionBody) {
      const out = pickDefined(b as Record<string, unknown>, columnMap);
      if (b.route !== undefined) out['route'] = b.route === null ? null : JSON.stringify(b.route);
      if (b.caller !== undefined)
        out['caller_enc'] =
          b.caller && Object.values(b.caller).some(Boolean)
            ? await app.fieldCrypto.encrypt(tenantId, JSON.stringify(b.caller))
            : null;
      return out;
    }

    // ------------------------------------------------------------------ list
    app.get(
      '/missions',
      {
        schema: {
          tags: ['missions'],
          querystring: listQuery.extend({
            eventId: z.uuid().optional(),
            state: z.enum(states).optional(),
            kind: z.enum(kinds).optional(),
            priority: z.enum(priorities).optional(),
            owningTenantId: z.uuid().optional(),
            open: z.coerce.boolean().optional(),
            unassigned: z.coerce.boolean().optional(),
          }),
          response: { 200: z.array(missionOut) },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const decision = await request.authorize('mission.read', {
          type: 'mission',
          tenantId: s.tenantId,
          ...(request.query.eventId ? { eventId: request.query.eventId } : {}),
          fields: MISSION_FIELDS,
        });
        const q = request.query;
        const rows = await run(request, scope, async (trx) => {
          let x = query(trx)
            .orderBy('m.priority', 'desc')
            .orderBy('m.created_at', 'desc')
            .limit(q.limit)
            .offset(q.offset);
          if (q.eventId) x = x.where('m.event_id', '=', q.eventId);
          if (q.state) x = x.where('m.state', '=', q.state);
          if (q.kind) x = x.where('m.kind', '=', q.kind);
          if (q.priority) x = x.where('m.priority', '=', q.priority);
          if (q.owningTenantId) x = x.where('m.owning_tenant_id', '=', q.owningTenantId);
          if (q.open) x = x.where('m.state', 'in', ['open', 'en_route', 'on_scene']);
          if (q.unassigned)
            x = x.where(({ not, exists, selectFrom }) =>
              not(
                exists(
                  selectFrom('cg.assignment as a')
                    .select('a.id')
                    .whereRef('a.mission_id', '=', 'm.id')
                    .where('a.released_at', 'is', null),
                ),
              ),
            );
          if (decision.recordScope === 'own') {
            const h = heldFilter(scope.holder, s.accountId);
            x = x.where(({ exists, selectFrom }) =>
              exists(
                selectFrom('cg.assignment as a')
                  .select('a.id')
                  .whereRef('a.mission_id', '=', 'm.id')
                  .where('a.released_at', 'is', null)
                  .where((e) =>
                    e.or([
                      e('a.team_id', 'in', h.teamIds),
                      e('a.personnel_id', 'in', h.personnelIds),
                    ]),
                  ),
              ),
            );
          }
          if (scope.partnerId) {
            const teamIds = scope.teamIds.length ? scope.teamIds : [scope.partnerId];
            const peopleIds = scope.personnelIds.length ? scope.personnelIds : [scope.partnerId];
            x = x.where(({ or, eb, exists, selectFrom }) =>
              or([
                eb('m.owning_tenant_id', '=', scope.partnerId!),
                exists(
                  selectFrom('cg.assignment as a')
                    .select('a.id')
                    .whereRef('a.mission_id', '=', 'm.id')
                    .where('a.released_at', 'is', null)
                    .where((e) =>
                      e.or([e('a.team_id', 'in', teamIds), e('a.personnel_id', 'in', peopleIds)]),
                    ),
                ),
              ]),
            );
          }
          return x.execute();
        });
        const exact = decision.fields.includes('location');
        const cjisMarker = showsCjisMarker(scope, decision.recordScope);
        return Promise.all(
          (rows as Joined[]).map((r) => toOut(r, { location: exact, cjisMarker })),
        );
      },
    );

    // ------------------------------------------------------------------ read
    app.get(
      '/missions/:id',
      { schema: { tags: ['missions'], params: uuidParam, response: { 200: missionOut } } },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const row = await load(request, scope, request.params.id);
        const decision = await request.authorize(
          'mission.read',
          resourceOf(s, row, MISSION_FIELDS),
          {
            asNotFound: true,
          },
        );
        const withCaller = decision.fields.includes('caller');
        const cjisMarker = showsCjisMarker(scope, decision.recordScope);
        // SEC-12: the reference and the enclave address only for holders of mission.cji.open.
        const mayOpenCjis =
          cjisMarker &&
          !!row.cji_ref &&
          decide(s, 'mission.cji.open', resourceOf(s, row)).effect === 'allow';
        const [assignments, timeline, cjisOpen] = await run(request, scope, async (trx) => {
          const a = await trx
            .selectFrom('cg.assignment')
            .selectAll()
            .where('mission_id', '=', row.id)
            .orderBy('assigned_at')
            .execute();
          const t = await trx
            .selectFrom('cg.mission_event')
            .selectAll()
            .where('mission_id', '=', row.id)
            .orderBy('occurred_at')
            .execute();
          if (withCaller && row.caller_enc)
            await request.audit(trx, {
              tenantId: scope.tenantId,
              action: 'mission.read',
              targetType: 'mission',
              targetId: row.id,
              classificationRead: ['contact'],
            });
          let link = null;
          if (mayOpenCjis) {
            link = await cjisLink(trx, row, scope.tenantId);
            await request.audit(trx, {
              tenantId: scope.tenantId,
              action: 'mission.cji.open',
              targetType: 'mission',
              targetId: row.id,
              reason: 'enclave reference shown',
            });
          }
          return [a, t, link] as const;
        });
        const out = await toOut(row, {
          caller: withCaller,
          location: decision.fields.includes('location'),
          cjisMarker,
        });
        return {
          ...out,
          ...(cjisOpen ? { cjis: cjisOpen } : {}),
          assignments: assignments.map(assignmentToOut),
          timeline: timeline.map((e) => ({
            id: e.id,
            kind: e.kind,
            narrativeRole: e.narrative_role,
            fromState: e.from_state,
            toState: e.to_state,
            actorAccountId: e.actor_account_id,
            reason: e.reason,
            body: e.body,
            amendsEventId: e.amends_event_id,
            detail: (e.detail as Record<string, unknown>) ?? {},
            occurredAt: iso(e.occurred_at)!,
          })),
        };
      },
    );

    // --------------------------------------------------------- CJIS enclave link
    /**
     * SEC-12, ADR-0038: a liaison links the mission to the CJIS enclave. The platform keeps
     * only a random opaque reference; the enclave keys its record by it. Linking twice
     * answers the same reference. A partner organization never links its county's mission.
     */
    app.post(
      '/missions/:id/cji-link',
      {
        schema: {
          tags: ['missions'],
          params: uuidParam,
          response: {
            200: z.object({
              restricted: z.literal(true),
              ref: z.string(),
              url: z.string().optional(),
              linkedAt: z.iso.datetime().optional(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        if (scope.partnerId) throw errors.forbidden();
        const row = await load(request, scope, request.params.id);
        const d = await request.authorize('mission.cji.link', resourceOf(s, row), {
          asNotFound: true,
        });
        assertUnlocked(row, s.accountId);
        const reason = request.confirmation().reason;
        return run(request, scope, async (trx) => {
          if (row.cji_ref) return (await cjisLink(trx, row, scope.tenantId))!;
          const linked = await trx
            .updateTable('cg.mission')
            .set({
              cji_ref: newCjiRef(),
              cji_linked_at: new Date(),
              cji_linked_by: s.accountId,
              updated_by: s.accountId,
            })
            .where('id', '=', row.id)
            .where('cji_ref', 'is', null)
            .returningAll()
            .executeTakeFirst();
          // A concurrent link won the race: answer the reference it set.
          const current =
            linked ??
            (await trx
              .selectFrom('cg.mission')
              .selectAll()
              .where('id', '=', row.id)
              .executeTakeFirstOrThrow());
          if (linked) {
            await timelineEntry(trx, scope.tenantId, row.id, {
              kind: 'updated',
              narrative_role: 'system',
              actor_account_id: s.accountId,
              reason,
              detail: JSON.stringify({ cjis: 'linked' }),
            });
            await request.audit(trx, {
              tenantId: scope.tenantId,
              action: 'mission.cji.link',
              targetType: 'mission',
              targetId: row.id,
              targetVersion: linked.version,
              reason: `${d.reason}: ${reason ?? ''}`,
            });
          }
          return (await cjisLink(trx, current, scope.tenantId))!;
        });
      },
    );

    // ---------------------------------------------------------------- create
    app.post(
      '/missions',
      {
        config: { idempotent: true },
        schema: {
          tags: ['missions'],
          body: z.object({
            ...missionFields,
            subcategory: missionFields.subcategory.optional(),
            priority: missionFields.priority.default('normal'),
            urgency: missionFields.urgency.default('routine'),
            source: missionFields.source.default('staff'),
            summary: missionFields.summary.optional(),
            conditions: missionFields.conditions.optional(),
            caller: missionFields.caller.optional(),
            callerLanguage: missionFields.callerLanguage.optional(),
            interpreterNeeded: missionFields.interpreterNeeded.default(false),
            location: missionFields.location.optional(),
            needId: missionFields.needId.optional(),
            reportId: missionFields.reportId.optional(),
            siteId: missionFields.siteId.optional(),
            route: missionFields.route.optional(),
            owningTenantId: missionFields.owningTenantId.optional(),
            requiredCredentials: missionFields.requiredCredentials.default([]),
            reportRequired: missionFields.reportRequired.default(false),
            caseReference: missionFields.caseReference.optional(),
            /** FR-02.02: a draft keeps what is known; an intake save must be dispatchable. */
            save: z.enum(['draft', 'intake']).default('intake'),
          }),
          response: { 201: missionOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const scope = await scopeOf(request);
        await request.authorize('mission.create', {
          type: 'mission',
          tenantId: s.tenantId,
          eventId: request.body.eventId,
        });
        const b = request.body;
        const row = await run(request, scope, async (trx) => {
          const event = await trx
            .selectFrom('cg.event')
            .select(['id', 'status'])
            .where('id', '=', b.eventId)
            .executeTakeFirst();
          if (!event) throw errors.validation([{ name: 'eventId', message: 'unknown event' }]);
          if (event.status !== 'active')
            throw errors.validation([
              {
                name: 'eventId',
                message: 'missions exist only inside an activated event (SCL-02)',
              },
            ]);
          const loc = await saveLocation(trx, scope.tenantId, null, b.location, s.accountId);
          const ref = await sql<{
            r: string;
          }>`select cg.next_mission_reference(${scope.tenantId}::uuid) as r`.execute(trx);
          const values = {
            tenant_id: scope.tenantId,
            event_id: b.eventId,
            reference: ref.rows[0]!.r,
            ...(await columns(scope.tenantId, b)),
            kind: b.kind,
            source: b.source,
            location_id: loc.id,
            location_state: loc.state,
            owning_tenant_id: b.owningTenantId ?? scope.partnerId ?? scope.tenantId,
            state: 'draft' as const,
            execution_id: request.executionId,
            created_by: s.accountId,
            updated_by: s.accountId,
          };
          const inserted = await trx
            .insertInto('cg.mission')
            .values(values as never)
            .returningAll()
            .executeTakeFirstOrThrow();
          await timelineEntry(trx, scope.tenantId, inserted.id, {
            kind: 'created',
            narrative_role:
              b.source === 'call' || b.source === 'walk_in' ? 'call_taker' : 'dispatcher',
            to_state: 'draft',
            actor_account_id: s.accountId,
          });
          let current = inserted;
          // FR-02.02, AC-02B: an intake save with a missing prerequisite keeps the draft (this
          // transaction commits) and answers 422 naming what is missing, after the commit.
          const blockers =
            b.save === 'intake'
              ? dispatchBlockers({ ...inserted, state: 'open' }).filter(
                  (x) => !x.startsWith('state:'),
                )
              : [];
          if (b.save === 'intake' && blockers.length === 0) {
            current = await trx
              .updateTable('cg.mission')
              .set({ state: 'open', opened_at: new Date(), updated_by: s.accountId })
              .where('id', '=', inserted.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await timelineEntry(trx, scope.tenantId, inserted.id, {
              kind: 'state_changed',
              narrative_role: 'dispatcher',
              from_state: 'draft',
              to_state: 'open',
              actor_account_id: s.accountId,
            });
            await significant(
              trx,
              scope.tenantId,
              b.eventId,
              'mission_opened',
              `${inserted.reference} opened (${b.kind})`,
              inserted.id,
              s.accountId,
            );
          }
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.create',
            targetType: 'mission',
            targetId: current.id,
            targetVersion: current.version,
            changes: diffForAudit(
              null,
              { ...current, caller_enc: current.caller_enc ? '[encrypted]' : null } as Record<
                string,
                unknown
              >,
              classifierFor('mission'),
            ),
          });
          return {
            saved: (await query(trx)
              .where('m.id', '=', current.id)
              .executeTakeFirstOrThrow()) as Joined,
            blockers,
          };
        });
        if (row.blockers.length > 0)
          throw new ApiError(
            422,
            'dispatch_prerequisites',
            'The mission is saved as a draft until these are known.',
            {
              fields: row.blockers.map((name) => ({ name, message: 'needed before dispatch' })),
              details: { missionId: row.saved.id, reference: row.saved.reference, state: 'draft' },
            },
          );
        return reply.code(201).send(await toOut(row.saved, { caller: true }));
      },
    );

    // ---------------------------------------------------------------- update
    app.patch(
      '/missions/:id',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            subcategory: missionFields.subcategory.optional(),
            urgency: missionFields.urgency.optional(),
            summary: missionFields.summary.optional(),
            conditions: missionFields.conditions.optional(),
            caller: missionFields.caller.optional(),
            callerLanguage: missionFields.callerLanguage.optional(),
            interpreterNeeded: missionFields.interpreterNeeded.optional(),
            location: missionFields.location.optional(),
            needId: missionFields.needId.optional(),
            reportId: missionFields.reportId.optional(),
            siteId: missionFields.siteId.optional(),
            route: missionFields.route.optional(),
            owningTenantId: missionFields.owningTenantId.optional(),
            requiredCredentials: missionFields.requiredCredentials.optional(),
            reportRequired: missionFields.reportRequired.optional(),
            caseReference: missionFields.caseReference.optional(),
          }),
          response: { 200: missionOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const expected = request.expectedVersion();
        const current = await load(request, scope, request.params.id);
        await request.authorize('mission.update', resourceOf(s, current), { asNotFound: true });
        assertUnlocked(current, s.accountId);
        if (current.state === 'closed' || current.state === 'canceled')
          throw errors.validation([{ name: 'state', message: 'reopen the mission first' }]);
        const b = request.body;
        const row = await run(request, scope, async (trx) => {
          const loc = await saveLocation(
            trx,
            scope.tenantId,
            current.location_id,
            b.location,
            s.accountId,
          );
          const updated = assertUpdated(
            await trx
              .updateTable('cg.mission')
              .set({
                ...(await columns(scope.tenantId, b)),
                ...(b.location !== undefined
                  ? { location_id: loc.id, location_state: loc.state }
                  : {}),
                updated_by: s.accountId,
              } as never)
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            await toOut(current),
          );
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'updated',
            actor_account_id: s.accountId,
            detail: JSON.stringify({ fields: Object.keys(b) }),
          });
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.update',
            targetType: 'mission',
            targetId: updated.id,
            targetVersion: updated.version,
            changes: diffForAudit(
              { ...current, caller_enc: current.caller_enc ? '[encrypted]' : null } as Record<
                string,
                unknown
              >,
              { ...updated, caller_enc: updated.caller_enc ? '[encrypted]' : null } as Record<
                string,
                unknown
              >,
              classifierFor('mission'),
            ),
          });
          return (await query(trx)
            .where('m.id', '=', updated.id)
            .executeTakeFirstOrThrow()) as Joined;
        });
        return toOut(row);
      },
    );

    // ----------------------------------------------------------- transitions
    app.post(
      '/missions/:id/transitions',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            to: z.enum(['open', 'en_route', 'on_scene', 'cleared']),
            reason: z.string().max(500).optional(),
          }),
          response: { 200: missionOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const expected = request.expectedVersion();
        const current = await load(request, scope, request.params.id);
        await request.authorize('mission.transition', resourceOf(s, current), { asNotFound: true });
        assertUnlocked(current, s.accountId);
        const to = request.body.to;
        if (!(TRANSITIONS[current.state] ?? []).includes(to)) throw notAllowed(current.state, to);
        if (to === 'open') {
          const blockers = dispatchBlockers({ ...current, state: 'open' }).filter(
            (x) => !x.startsWith('state:'),
          );
          if (blockers.length > 0)
            throw new ApiError(422, 'dispatch_prerequisites', 'Not yet dispatchable.', {
              fields: blockers.map((name) => ({ name, message: 'needed before dispatch' })),
            });
        }
        const row = await run(request, scope, async (trx) => {
          const updated = assertUpdated(
            await trx
              .updateTable('cg.mission')
              .set({
                state: to,
                ...(to === 'open' && !current.opened_at ? { opened_at: new Date() } : {}),
                ...(to === 'cleared' ? { cleared_at: new Date() } : {}),
                updated_by: s.accountId,
              })
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            await toOut(current),
          );
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'state_changed',
            narrative_role: 'dispatcher',
            from_state: current.state,
            to_state: to,
            actor_account_id: s.accountId,
            reason: request.body.reason ?? null,
          });
          if (to === 'open')
            await significant(
              trx,
              scope.tenantId,
              current.event_id,
              'mission_opened',
              `${current.reference} opened`,
              current.id,
              s.accountId,
            );
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.transition',
            targetType: 'mission',
            targetId: current.id,
            targetVersion: updated.version,
            reason: request.body.reason ?? null,
            changes: { fields: [{ name: 'state', from: current.state, to }] },
          });
          return (await query(trx)
            .where('m.id', '=', current.id)
            .executeTakeFirstOrThrow()) as Joined;
        });
        return toOut(row);
      },
    );

    /** Shared by priority, cancel, close, reopen: a consequential change with its reason (RULE-14, MIS-03). */
    async function consequential(
      request: FastifyRequest,
      action: 'mission.priority' | 'mission.cancel' | 'mission.close' | 'mission.reopen',
      apply: (
        trx: Trx,
        current: Joined,
        reason: string,
        scope: Scope,
        accountId: string,
      ) => Promise<Record<string, unknown>>,
    ): Promise<MissionOut> {
      const s = account(request);
      const scope = await scopeOf(request);
      const expected = request.expectedVersion();
      const current = await load(request, scope, (request.params as { id: string }).id);
      await request.authorize(action, resourceOf(s, current), { asNotFound: true });
      assertUnlocked(current, s.accountId);
      const reason = request.confirmation().reason!;
      const row = await run(request, scope, async (trx) => {
        const set = await apply(trx, current, reason, scope, s.accountId);
        const updated = assertUpdated(
          await trx
            .updateTable('cg.mission')
            .set({ ...set, updated_by: s.accountId } as never)
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          await toOut(current),
        );
        await request.audit(trx, {
          tenantId: scope.tenantId,
          action,
          targetType: 'mission',
          targetId: current.id,
          targetVersion: updated.version,
          reason,
          changes: diffForAudit(
            { ...current, caller_enc: null } as Record<string, unknown>,
            { ...updated, caller_enc: null } as Record<string, unknown>,
            classifierFor('mission'),
          ),
        });
        return (await query(trx)
          .where('m.id', '=', current.id)
          .executeTakeFirstOrThrow()) as Joined;
      });
      return toOut(row);
    }

    app.post(
      '/missions/:id/priority',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({ priority: z.enum(priorities), urgency: z.enum(urgencies).optional() }),
          response: { 200: missionOut },
        },
      },
      async (request) =>
        consequential(request, 'mission.priority', async (trx, current, reason, scope, actor) => {
          const b = request.body;
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'priority_changed',
            actor_account_id: actor,
            reason,
            detail: JSON.stringify({ from: current.priority, to: b.priority }),
          });
          await significant(
            trx,
            scope.tenantId,
            current.event_id,
            'mission_priority',
            `${current.reference} priority ${current.priority} → ${b.priority}: ${reason}`,
            current.id,
            actor,
          );
          return { priority: b.priority, ...(b.urgency ? { urgency: b.urgency } : {}) };
        }),
    );

    app.post(
      '/missions/:id/cancel',
      {
        config: { requiresVersion: true },
        schema: { tags: ['missions'], params: uuidParam, response: { 200: missionOut } },
      },
      async (request) =>
        consequential(request, 'mission.cancel', async (trx, current, reason, scope, actor) => {
          if (current.state === 'closed' || current.state === 'canceled')
            throw notAllowed(current.state, 'canceled');
          await releaseAll(trx, scope, current, `mission canceled: ${reason}`, actor);
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'canceled',
            from_state: current.state,
            to_state: 'canceled',
            actor_account_id: actor,
            reason,
          });
          return {
            state: 'canceled',
            closed_at: new Date(),
            closed_reason: reason,
            disposition: 'canceled',
          };
        }),
    );

    app.post(
      '/missions/:id/close',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            disposition: z.enum(dispositions).optional(),
            dispositionNote: z.string().max(2000).optional(),
            caseReference: z.string().max(120).optional(),
            reportRequired: z.boolean().optional(),
            reportGenerated: z.boolean().optional(),
          }),
          response: { 200: missionOut },
        },
      },
      async (request) =>
        consequential(request, 'mission.close', async (trx, current, reason, scope, actor) => {
          const b = request.body;
          if (!['cleared', 'on_scene', 'open', 'en_route'].includes(current.state))
            throw notAllowed(current.state, 'closed');
          const disposition = b.disposition ?? current.disposition;
          // AC-07C: closure without the required disposition is refused with what is missing.
          const missing: { name: string; message: string }[] = [];
          if (!disposition) missing.push({ name: 'disposition', message: 'required to close' });
          if (
            (b.reportRequired ?? current.report_required) &&
            !(b.reportGenerated ?? current.report_generated)
          )
            missing.push({
              name: 'reportGenerated',
              message: 'a required report is not yet generated',
            });
          if (missing.length > 0) throw errors.validation(missing);
          await releaseAll(trx, scope, current, `mission closed: ${reason}`, actor); // AC-06D
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'disposition',
            narrative_role: 'supervisor',
            actor_account_id: actor,
            reason,
            detail: JSON.stringify({ disposition, note: b.dispositionNote ?? null }),
          });
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'state_changed',
            from_state: current.state,
            to_state: 'closed',
            actor_account_id: actor,
            reason,
          });
          await significant(
            trx,
            scope.tenantId,
            current.event_id,
            'mission_closed',
            `${current.reference} closed: ${disposition}`,
            current.id,
            actor,
          );
          return {
            state: 'closed',
            disposition,
            ...(b.dispositionNote !== undefined ? { disposition_note: b.dispositionNote } : {}),
            ...(b.caseReference !== undefined ? { case_reference: b.caseReference } : {}),
            ...(b.reportRequired !== undefined ? { report_required: b.reportRequired } : {}),
            ...(b.reportGenerated !== undefined ? { report_generated: b.reportGenerated } : {}),
            closed_at: new Date(),
            closed_reason: reason,
            reviewed_by: actor,
            reviewed_at: new Date(),
            ...(current.cleared_at ? {} : { cleared_at: new Date() }),
          };
        }),
    );

    app.post(
      '/missions/:id/reopen',
      {
        config: { requiresVersion: true },
        schema: { tags: ['missions'], params: uuidParam, response: { 200: missionOut } },
      },
      async (request) =>
        consequential(request, 'mission.reopen', async (trx, current, reason, scope, actor) => {
          if (current.state !== 'closed' && current.state !== 'canceled')
            throw notAllowed(current.state, 'open');
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'reopened',
            from_state: current.state,
            to_state: 'open',
            actor_account_id: actor,
            reason,
          });
          return {
            state: 'open',
            closed_at: null,
            closed_reason: null,
            reopened_count: current.reopened_count + 1,
          };
        }),
    );

    // ------------------------------------------------------------------ lock
    app.post(
      '/missions/:id/lock',
      {
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({ reason: z.string().min(3).max(500) }),
          response: { 200: missionOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        await request.authorize('mission.lock', resourceOf(s, current), { asNotFound: true });
        if (current.lock_by && current.lock_by !== s.accountId) throw locked(current.lock_by);
        const row = await run(request, scope, async (trx) => {
          await trx
            .updateTable('cg.mission')
            .set({
              lock_by: s.accountId,
              lock_at: new Date(),
              lock_reason: request.body.reason,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .execute();
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'locked',
            actor_account_id: s.accountId,
            reason: request.body.reason,
          });
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.lock',
            targetType: 'mission',
            targetId: current.id,
            reason: request.body.reason,
          });
          return (await query(trx)
            .where('m.id', '=', current.id)
            .executeTakeFirstOrThrow()) as Joined;
        });
        return toOut(row);
      },
    );
    app.delete(
      '/missions/:id/lock',
      {
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({ reason: z.string().min(3).max(500).optional() }).optional(),
          response: { 200: missionOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        await request.authorize('mission.lock', resourceOf(s, current), { asNotFound: true });
        // Another person's lock comes off only with a reason (RULE-05, audited).
        if (current.lock_by && current.lock_by !== s.accountId && !request.body?.reason)
          throw errors.validation([
            { name: 'reason', message: 'needed to remove another person’s lock' },
          ]);
        const row = await run(request, scope, async (trx) => {
          await trx
            .updateTable('cg.mission')
            .set({ lock_by: null, lock_at: null, lock_reason: null, updated_by: s.accountId })
            .where('id', '=', current.id)
            .execute();
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'unlocked',
            actor_account_id: s.accountId,
            reason: request.body?.reason ?? null,
            detail: JSON.stringify({ previousHolder: current.lock_by }),
          });
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.lock',
            targetType: 'mission',
            targetId: current.id,
            reason: request.body?.reason ?? 'unlock',
          });
          return (await query(trx)
            .where('m.id', '=', current.id)
            .executeTakeFirstOrThrow()) as Joined;
        });
        return toOut(row);
      },
    );

    // ------------------------------------------------------------ narratives
    app.post(
      '/missions/:id/narratives',
      {
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            role: z.enum(narrativeRoles),
            body: z.string().min(1).max(8000),
            amendsEventId: z.uuid().optional(),
            occurredAt: z.iso.datetime().optional(),
          }),
          response: { 201: timelineOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        await request.authorize('mission.narrative', resourceOf(s, current), { asNotFound: true });
        assertUnlocked(current, s.accountId);
        const b = request.body;
        const row = await run(request, scope, async (trx) => {
          if (b.amendsEventId) {
            const target = await trx
              .selectFrom('cg.mission_event')
              .select(['id', 'kind'])
              .where('id', '=', b.amendsEventId)
              .where('mission_id', '=', current.id)
              .executeTakeFirst();
            if (!target || !['narrative', 'amendment'].includes(target.kind))
              throw errors.validation([
                { name: 'amendsEventId', message: 'not a narrative on this mission' },
              ]);
          }
          const inserted = await trx
            .insertInto('cg.mission_event')
            .values({
              tenant_id: scope.tenantId,
              mission_id: current.id,
              kind: b.amendsEventId ? 'amendment' : 'narrative',
              narrative_role: b.role,
              actor_account_id: s.accountId,
              body: b.body,
              amends_event_id: b.amendsEventId ?? null,
              ...(b.occurredAt ? { occurred_at: new Date(b.occurredAt) } : {}),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.narrative',
            targetType: 'mission',
            targetId: current.id,
            changes: {
              fields: [{ name: b.amendsEventId ? 'amendment' : 'narrative', to: b.role }],
            },
          });
          return inserted;
        });
        return reply.code(201).send({
          id: row.id,
          kind: row.kind,
          narrativeRole: row.narrative_role,
          fromState: row.from_state,
          toState: row.to_state,
          actorAccountId: row.actor_account_id,
          reason: row.reason,
          body: row.body,
          amendsEventId: row.amends_event_id,
          detail: (row.detail as Record<string, unknown>) ?? {},
          occurredAt: iso(row.occurred_at)!,
        });
      },
    );

    // -------------------------------------------------------- people involved
    async function personToOut(r: PersonRow, fields: string[]): Promise<z.infer<typeof personOut>> {
      const dec = async (buf: Buffer | null) =>
        buf ? app.fieldCrypto.decrypt(r.tenant_id, buf) : null;
      return {
        id: r.id,
        version: r.version,
        missionId: r.mission_id,
        role: r.role,
        displayLabel: r.display_label,
        ...(fields.includes('details')
          ? {
              details: r.details_enc
                ? (JSON.parse((await dec(r.details_enc))!) as Record<string, unknown>)
                : null,
            }
          : {}),
        injury: r.injury,
        ...(fields.includes('injuryDetail')
          ? { injuryDetail: await dec(r.injury_detail_enc) }
          : {}),
        transport: r.transport,
        transportDestination: r.transport_destination,
        transportStartedAt: iso(r.transport_started_at),
        transportEndedAt: iso(r.transport_ended_at),
        ...(fields.includes('behavioralHealth')
          ? { behavioralHealth: await dec(r.behavioral_health_enc) }
          : {}),
        partyId: r.party_id,
        status: r.status,
        removedReason: r.removed_reason,
      };
    }

    app.get(
      '/missions/:id/people',
      { schema: { tags: ['missions'], params: uuidParam, response: { 200: z.array(personOut) } } },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        const decision = await request.authorize(
          'mission.person.read',
          {
            type: 'mission_person',
            id: current.id,
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
            fields: PERSON_FIELDS,
          },
          { asNotFound: true },
        );
        const rows = await run(request, scope, async (trx) => {
          const list = await trx
            .selectFrom('cg.mission_person')
            .selectAll()
            .where('mission_id', '=', current.id)
            .orderBy('created_at')
            .execute();
          if (decision.restrictedRead.length > 0 && list.length > 0)
            await request.audit(trx, {
              tenantId: scope.tenantId,
              action: 'mission.person.read',
              targetType: 'mission',
              targetId: current.id,
              classificationRead: decision.restrictedRead,
            });
          return list;
        });
        return Promise.all(rows.map((r) => personToOut(r, decision.fields)));
      },
    );

    const personBody = z.object({
      role: z.enum(personRoles),
      displayLabel: z.string().max(120).nullable().optional(),
      details: z.record(z.string(), z.unknown()).nullable().optional(),
      injury: z.enum(injuries).nullable().optional(),
      injuryDetail: z.string().max(2000).nullable().optional(),
      transport: z.enum(transports).nullable().optional(),
      transportDestination: z.string().max(200).nullable().optional(),
      transportStartedAt: z.iso.datetime().nullable().optional(),
      transportEndedAt: z.iso.datetime().nullable().optional(),
      behavioralHealth: z.string().max(2000).nullable().optional(),
      partyId: z.uuid().nullable().optional(),
    });

    type PersonBody = z.infer<typeof personBody>;
    async function personColumns(
      tenantId: string,
      b: { [K in keyof PersonBody]?: PersonBody[K] | undefined },
    ) {
      const enc = async (v: string | null | undefined) =>
        v === undefined ? undefined : v === null ? null : app.fieldCrypto.encrypt(tenantId, v);
      const out: Record<string, unknown> = {};
      if (b.role !== undefined) out['role'] = b.role;
      if (b.displayLabel !== undefined) out['display_label'] = b.displayLabel;
      if (b.details !== undefined)
        out['details_enc'] = await enc(b.details === null ? null : JSON.stringify(b.details));
      if (b.injury !== undefined) out['injury'] = b.injury;
      if (b.injuryDetail !== undefined) out['injury_detail_enc'] = await enc(b.injuryDetail);
      if (b.transport !== undefined) out['transport'] = b.transport;
      if (b.transportDestination !== undefined)
        out['transport_destination'] = b.transportDestination;
      if (b.transportStartedAt !== undefined)
        out['transport_started_at'] = b.transportStartedAt ? new Date(b.transportStartedAt) : null;
      if (b.transportEndedAt !== undefined)
        out['transport_ended_at'] = b.transportEndedAt ? new Date(b.transportEndedAt) : null;
      if (b.behavioralHealth !== undefined)
        out['behavioral_health_enc'] = await enc(b.behavioralHealth);
      if (b.partyId !== undefined) out['party_id'] = b.partyId;
      return out;
    }

    app.post(
      '/missions/:id/people',
      {
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: personBody,
          response: { 201: personOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        await request.authorize(
          'mission.person.edit',
          {
            type: 'mission_person',
            id: current.id,
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
          },
          { asNotFound: true },
        );
        assertUnlocked(current, s.accountId);
        const row = await run(request, scope, async (trx) => {
          const inserted = await trx
            .insertInto('cg.mission_person')
            .values({
              tenant_id: scope.tenantId,
              mission_id: current.id,
              ...(await personColumns(scope.tenantId, request.body)),
              created_by: s.accountId,
              updated_by: s.accountId,
            } as never)
            .returningAll()
            .executeTakeFirstOrThrow();
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'person_added',
            actor_account_id: s.accountId,
            detail: JSON.stringify({ personId: inserted.id, role: inserted.role }),
          });
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.person.edit',
            targetType: 'mission_person',
            targetId: inserted.id,
            changes: {
              fields: [
                { name: 'role', to: inserted.role },
                {
                  name: 'restricted_fields',
                  to: Object.keys(request.body).filter((k) =>
                    ['details', 'injuryDetail', 'behavioralHealth'].includes(k),
                  ),
                },
              ],
            },
          });
          return inserted;
        });
        return reply
          .code(201)
          .send(await personToOut(row, ['details', 'injuryDetail', 'behavioralHealth']));
      },
    );

    app.patch(
      '/missions/:id/people/:personId',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam.extend({ personId: z.uuid() }),
          body: personBody.partial().extend({ removedReason: z.string().max(500).optional() }),
          response: { 200: personOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const expected = request.expectedVersion();
        const current = await load(request, scope, request.params.id);
        await request.authorize(
          'mission.person.edit',
          {
            type: 'mission_person',
            id: current.id,
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
          },
          { asNotFound: true },
        );
        assertUnlocked(current, s.accountId);
        const { removedReason, ...rest } = request.body;
        const row = await run(request, scope, async (trx) => {
          const person = await trx
            .selectFrom('cg.mission_person')
            .selectAll()
            .where('id', '=', request.params.personId)
            .where('mission_id', '=', current.id)
            .executeTakeFirst();
          if (!person) throw errors.notFound();
          const updated = assertUpdated(
            await trx
              .updateTable('cg.mission_person')
              .set({
                ...(await personColumns(scope.tenantId, rest)),
                ...(removedReason ? { status: 'removed', removed_reason: removedReason } : {}),
                updated_by: s.accountId,
              } as never)
              .where('id', '=', person.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            await personToOut(person, []),
          );
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: removedReason ? 'person_removed' : 'person_updated',
            actor_account_id: s.accountId,
            reason: removedReason ?? null,
            detail: JSON.stringify({ personId: person.id, fields: Object.keys(rest) }),
          });
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.person.edit',
            targetType: 'mission_person',
            targetId: person.id,
            targetVersion: updated.version,
            reason: removedReason ?? null,
            changes: { fields: Object.keys(rest).map((name) => ({ name })) },
          });
          return updated;
        });
        return personToOut(row, ['details', 'injuryDetail', 'behavioralHealth']);
      },
    );

    // ----------------------------------------------------------------- media
    const mediaToOut = (m: Selectable<Database['cg.mission_media']>): z.infer<typeof mediaOut> => ({
      id: m.id,
      missionId: m.mission_id,
      kind: m.kind,
      photoId: m.photo_id,
      originalName: m.original_name,
      contentType: m.content_type,
      bytes: m.bytes === null ? null : Number(m.bytes),
      description: m.description,
      source: m.source,
      accessClass: m.access_class,
      uploadedBy: m.uploaded_by,
      uploadedAt: iso(m.uploaded_at)!,
      removedAt: iso(m.removed_at),
      removedReason: m.removed_reason,
    });

    app.get(
      '/missions/:id/media',
      { schema: { tags: ['missions'], params: uuidParam, response: { 200: z.array(mediaOut) } } },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        const decision = await request.authorize(
          'mission.media.read',
          {
            type: 'mission_media',
            id: current.id,
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
            fields: [{ name: 'restricted', category: 'evidence', classification: 'restricted' }],
          },
          { asNotFound: true },
        );
        const rows = await run(request, scope, (trx) =>
          trx
            .selectFrom('cg.mission_media')
            .selectAll()
            .where('mission_id', '=', current.id)
            .orderBy('uploaded_at')
            .execute(),
        );
        // Restricted media show only to the evidence category; the object key never leaves the server (AC-07B).
        return rows
          .filter((m) => m.access_class === 'internal' || decision.fields.includes('restricted'))
          .map(mediaToOut);
      },
    );

    app.post(
      '/missions/:id/media',
      {
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            kind: z.enum(mediaKinds),
            photoId: z.uuid().optional(),
            objectKey: z.string().max(400).optional(),
            originalName: z.string().max(200).optional(),
            contentType: z.string().max(120).optional(),
            bytes: z.number().int().min(0).optional(),
            description: z.string().max(1000).optional(),
            source: z
              .enum(['field', 'console', 'resident', 'partner', 'external'])
              .default('console'),
            accessClass: z.enum(['internal', 'restricted']).default('internal'),
          }),
          response: { 201: mediaOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        await request.authorize(
          'mission.media.add',
          {
            type: 'mission_media',
            id: current.id,
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
          },
          { asNotFound: true },
        );
        assertUnlocked(current, s.accountId);
        const b = request.body;
        // SEC-12, BRD:FR-07.04: body-camera references are CJI and live only in the enclave.
        if (b.kind === 'bodycam_reference')
          throw new ApiError(
            422,
            'cji_in_enclave',
            'Body-camera references are recorded in the CJIS enclave, not here.',
            { fields: [{ name: 'kind', message: 'recorded in the CJIS enclave' }] },
          );
        if (!b.photoId && !b.objectKey && b.kind !== 'live_feed_reference')
          throw errors.validation([
            { name: 'photoId', message: 'a photo or an object reference is needed' },
          ]);
        const row = await run(request, scope, async (trx) => {
          const inserted = await trx
            .insertInto('cg.mission_media')
            .values({
              tenant_id: scope.tenantId,
              mission_id: current.id,
              kind: b.kind,
              photo_id: b.photoId ?? null,
              object_key: b.objectKey ?? null,
              original_name: b.originalName ?? null,
              content_type: b.contentType ?? null,
              bytes: b.bytes ?? null,
              description: b.description ?? null,
              source: b.source,
              access_class: b.accessClass,
              uploaded_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'media_added',
            actor_account_id: s.accountId,
            detail: JSON.stringify({ mediaId: inserted.id, kind: b.kind }),
          });
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.media.add',
            targetType: 'mission_media',
            targetId: inserted.id,
            changes: {
              fields: [
                { name: 'kind', to: b.kind },
                { name: 'access_class', to: b.accessClass },
              ],
            },
          });
          return inserted;
        });
        return reply.code(201).send(mediaToOut(row));
      },
    );

    app.delete(
      '/missions/:id/media/:mediaId',
      {
        schema: {
          tags: ['missions'],
          params: uuidParam.extend({ mediaId: z.uuid() }),
          body: z.object({ reason: z.string().min(3).max(500) }),
          response: { 200: mediaOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        await request.authorize(
          'mission.media.add',
          {
            type: 'mission_media',
            id: current.id,
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
          },
          { asNotFound: true },
        );
        const row = await run(request, scope, async (trx) => {
          const updated = await trx
            .updateTable('cg.mission_media')
            .set({
              removed_at: new Date(),
              removed_by: s.accountId,
              removed_reason: request.body.reason,
            })
            .where('id', '=', request.params.mediaId)
            .where('mission_id', '=', current.id)
            .where('removed_at', 'is', null)
            .returningAll()
            .executeTakeFirst();
          if (!updated) throw errors.notFound();
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'media_removed',
            actor_account_id: s.accountId,
            reason: request.body.reason,
            detail: JSON.stringify({ mediaId: updated.id }),
          });
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: 'mission.media.add',
            targetType: 'mission_media',
            targetId: updated.id,
            reason: request.body.reason,
            changes: { fields: [{ name: 'removed', to: true }] },
          });
          return updated;
        });
        return mediaToOut(row);
      },
    );

    // ----------------------------------------------------------- assignments
    interface Conflict {
      kind:
        | 'double_booked'
        | 'off_duty'
        | 'over_hours'
        | 'missing_credential'
        | 'inactive'
        | 'unknown_resource';
      detail: string;
    }

    /** PER-02, AC-05B, AC-06C: the warnings an authorized override may accept with a reason. */
    async function conflictsFor(
      trx: Trx,
      mission: MissionRow,
      resource: { kind: 'person' | 'team'; id: string },
    ): Promise<Conflict[]> {
      const out: Conflict[] = [];
      const busy = await trx
        .selectFrom('cg.assignment as a')
        .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
        .select(['m.reference', 'a.state'])
        .where(resource.kind === 'person' ? 'a.personnel_id' : 'a.team_id', '=', resource.id)
        .where('a.released_at', 'is', null)
        .where('a.mission_id', '<>', mission.id)
        .where('m.state', 'in', ['open', 'en_route', 'on_scene'])
        .execute();
      for (const b of busy)
        out.push({ kind: 'double_booked', detail: `${b.reference} (${b.state})` });
      const required = mission.required_credentials;
      if (resource.kind === 'person') {
        const p = await trx
          .selectFrom('cg.personnel')
          .select(['status', 'duty_status', 'hours_limit', 'name'])
          .where('id', '=', resource.id)
          .executeTakeFirst();
        if (!p)
          return [{ kind: 'unknown_resource', detail: 'no such person in your organization' }];
        if (p.status !== 'active')
          out.push({ kind: 'inactive', detail: `${p.name} is ${p.status}` });
        if (p.duty_status === 'off_duty')
          out.push({ kind: 'off_duty', detail: `${p.name} is off duty` });
        const shift = await trx
          .selectFrom('cg.check_in')
          .select('started_at')
          .where('personnel_id', '=', resource.id)
          .where('ended_at', 'is', null)
          .executeTakeFirst();
        if (shift && p.hours_limit !== null) {
          const hours = (Date.now() - new Date(shift.started_at).getTime()) / 3_600_000;
          if (hours > p.hours_limit)
            out.push({
              kind: 'over_hours',
              detail: `${hours.toFixed(1)} h on shift, limit ${p.hours_limit} h`,
            });
        }
        if (required.length > 0) {
          const held = await trx
            .selectFrom('cg.credential')
            .select('kind')
            .where('personnel_id', '=', resource.id)
            .where('status', '=', 'verified')
            .where((eb) =>
              eb.or([eb('expires_at', 'is', null), eb('expires_at', '>=', new Date())]),
            )
            .execute();
          const kinds = new Set(held.map((h) => h.kind as string));
          for (const r of required)
            if (!kinds.has(r))
              out.push({ kind: 'missing_credential', detail: `${p.name}: ${r} not recorded` });
        }
      } else {
        const t = await trx
          .selectFrom('cg.team')
          .select(['status', 'name', 'id'])
          .where('id', '=', resource.id)
          .executeTakeFirst();
        if (!t)
          return [
            {
              kind: 'unknown_resource',
              detail: 'no such team in your organization or its partners',
            },
          ];
        if (t.status !== 'active')
          out.push({ kind: 'inactive', detail: `${t.name} is ${t.status.replace('_', ' ')}` });
        const latest = await trx
          .selectFrom('cg.team_status')
          .select('status')
          .where('team_id', '=', t.id)
          .where('fact', '=', 'confirmed')
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        if (latest?.status === 'out_of_service')
          out.push({ kind: 'off_duty', detail: `${t.name} is out of service` });
        if (required.length > 0) {
          const held = await trx
            .selectFrom('cg.team_member as tm')
            .innerJoin('cg.credential as c', 'c.personnel_id', 'tm.personnel_id')
            .select('c.kind')
            .where('tm.team_id', '=', t.id)
            .where('tm.left_at', 'is', null)
            .where('c.status', '=', 'verified')
            .where((eb) =>
              eb.or([eb('c.expires_at', 'is', null), eb('c.expires_at', '>=', new Date())]),
            )
            .execute();
          const kinds = new Set(held.map((h) => h.kind as string));
          for (const r of required)
            if (!kinds.has(r))
              out.push({
                kind: 'missing_credential',
                detail: `${t.name}: no member with ${r} recorded`,
              });
        }
      }
      return out;
    }

    /** AC-06D, FR-06.07: closing or canceling releases what is still assigned; the rows stay. */
    async function releaseAll(
      trx: Trx,
      scope: Scope,
      mission: MissionRow,
      reason: string,
      actor: string,
    ) {
      const open = await trx
        .selectFrom('cg.assignment')
        .selectAll()
        .where('mission_id', '=', mission.id)
        .where('released_at', 'is', null)
        .execute();
      for (const a of open) {
        const updated = await trx
          .updateTable('cg.assignment')
          .set({
            state: 'released',
            released_at: new Date(),
            released_by: actor,
            release_reason: reason,
            updated_by: actor,
          })
          .where('id', '=', a.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.assignment_event')
          .values({
            tenant_id: scope.tenantId,
            assignment_id: a.id,
            kind: 'released',
            from_state: a.state,
            to_state: 'released',
            actor_account_id: actor,
            reason,
          })
          .execute();
        await activity(
          trx,
          scope.tenantId,
          mission.event_id,
          updated,
          'released',
          `Released from ${mission.reference}: ${reason}`,
          actor,
        );
      }
    }

    app.get(
      '/assignments',
      {
        schema: {
          tags: ['missions'],
          querystring: listQuery.extend({
            missionId: z.uuid().optional(),
            teamId: z.uuid().optional(),
            personnelId: z.uuid().optional(),
            open: z.coerce.boolean().optional(),
          }),
          response: { 200: z.array(assignmentOut) },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const decision = await request.authorize('assignment.read', {
          type: 'assignment',
          tenantId: s.tenantId,
        });
        const q = request.query;
        const rows = await run(request, scope, (trx) => {
          let x = trx
            .selectFrom('cg.assignment')
            .selectAll()
            .orderBy('assigned_at', 'desc')
            .limit(q.limit)
            .offset(q.offset);
          if (q.missionId) x = x.where('mission_id', '=', q.missionId);
          if (q.teamId) x = x.where('team_id', '=', q.teamId);
          if (q.personnelId) x = x.where('personnel_id', '=', q.personnelId);
          if (q.open) x = x.where('released_at', 'is', null);
          if (decision.recordScope === 'own') {
            const h = heldFilter(scope.holder, s.accountId);
            x = x.where((eb) =>
              eb.or([eb('team_id', 'in', h.teamIds), eb('personnel_id', 'in', h.personnelIds)]),
            );
          }
          if (scope.partnerId)
            x = x.where((eb) =>
              eb.or([
                eb('team_id', 'in', scope.teamIds.length ? scope.teamIds : [scope.partnerId!]),
                eb(
                  'personnel_id',
                  'in',
                  scope.personnelIds.length ? scope.personnelIds : [scope.partnerId!],
                ),
              ]),
            );
          return x.execute();
        });
        return rows.map(assignmentToOut);
      },
    );

    app.post(
      '/missions/:id/assignments',
      {
        config: { idempotent: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            resources: z
              .array(z.object({ kind: z.enum(['person', 'team']), id: z.uuid() }))
              .min(1)
              .max(20),
            dispatch: z.object({ method: z.enum(dispatchMethods) }).optional(),
            /** AC-06C: accepted conflicts; needs assignment.override and a confirmation with a reason. */
            overrideReason: z.string().min(3).max(500).optional(),
            suggested: z.boolean().default(false),
            suggestionReasons: z.array(z.string().max(120)).max(10).default([]),
          }),
          response: { 201: z.array(assignmentOut) },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const scope = await scopeOf(request);
        const current = await load(request, scope, request.params.id);
        await request.authorize(
          'assignment.create',
          {
            type: 'assignment',
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
          },
          { asNotFound: true },
        );
        assertUnlocked(current, s.accountId);
        if (current.state === 'draft')
          throw new ApiError(
            422,
            'dispatch_prerequisites',
            'A draft cannot be dispatched; open the mission first.',
            {
              fields: dispatchBlockers(current).map((name) => ({
                name,
                message: 'needed before dispatch',
              })),
            },
          );
        if (current.state === 'closed' || current.state === 'canceled')
          throw notAllowed(current.state, 'assigned');
        const b = request.body;
        if (b.overrideReason)
          await request.authorize('assignment.override', {
            type: 'assignment',
            tenantId: s.tenantId,
            eventId: current.event_id,
            heldBySubject: current.held ?? false,
          });
        if (scope.partnerId) {
          for (const r of b.resources) {
            const own =
              r.kind === 'team' ? scope.teamIds.includes(r.id) : scope.personnelIds.includes(r.id);
            if (!own)
              throw errors.validation([
                {
                  name: 'resources',
                  message: 'you can assign only your own people and teams (DSP-09)',
                },
              ]);
          }
        }
        // AC-06A: one transaction for the mission and every assignment; nothing half-written.
        const rows = await run(request, scope, async (trx) => {
          const found: Conflict[][] = [];
          for (const r of b.resources) found.push(await conflictsFor(trx, current, r));
          const unknown = found.flat().filter((c) => c.kind === 'unknown_resource');
          if (unknown.length > 0)
            throw errors.validation(unknown.map((u) => ({ name: 'resources', message: u.detail })));
          const all = found.flat();
          if (all.length > 0 && !b.overrideReason)
            throw new ApiError(
              409,
              'assignment_conflicts',
              'These resources have conflicts; an authorized override with a reason can accept them.',
              {
                details: {
                  conflicts: b.resources.map((r, i) => ({ resource: r, conflicts: found[i] })),
                },
              },
            );
          const out: AssignmentRow[] = [];
          for (const [i, r] of b.resources.entries()) {
            const inserted = await trx
              .insertInto('cg.assignment')
              .values({
                tenant_id: scope.tenantId,
                mission_id: current.id,
                resource_kind: r.kind,
                personnel_id: r.kind === 'person' ? r.id : null,
                team_id: r.kind === 'team' ? r.id : null,
                state: b.dispatch ? 'dispatched' : 'assigned',
                assigned_by: s.accountId,
                suggested: b.suggested,
                suggestion_reasons: b.suggestionReasons,
                conflicts: JSON.stringify(found[i] ?? []),
                override_reason: found[i]?.length ? (b.overrideReason ?? null) : null,
                override_by: found[i]?.length ? s.accountId : null,
                dispatched_at: b.dispatch ? new Date() : null,
                dispatched_by: b.dispatch ? s.accountId : null,
                dispatch_method: b.dispatch?.method ?? null,
                execution_id: request.executionId,
                created_by: s.accountId,
                updated_by: s.accountId,
              })
              .returningAll()
              .executeTakeFirstOrThrow()
              .catch((err: { code?: string; constraint?: string }) => {
                if (err.code === '23505')
                  throw new ApiError(
                    409,
                    'already_assigned',
                    'This resource is already on the mission.',
                    { details: { resource: r } },
                  );
                throw err;
              });
            await trx
              .insertInto('cg.assignment_event')
              .values([
                {
                  tenant_id: scope.tenantId,
                  assignment_id: inserted.id,
                  kind: 'assigned',
                  to_state: 'assigned',
                  actor_account_id: s.accountId,
                },
                ...(found[i]?.length
                  ? [
                      {
                        tenant_id: scope.tenantId,
                        assignment_id: inserted.id,
                        kind: 'override' as const,
                        actor_account_id: s.accountId,
                        reason: b.overrideReason ?? null,
                        evidence: JSON.stringify(found[i]),
                      },
                    ]
                  : []),
                ...(b.dispatch
                  ? [
                      {
                        tenant_id: scope.tenantId,
                        assignment_id: inserted.id,
                        kind: 'dispatched' as const,
                        from_state: 'assigned',
                        to_state: 'dispatched',
                        method: b.dispatch.method,
                        actor_account_id: s.accountId,
                      },
                    ]
                  : []),
              ])
              .execute();
            await activity(
              trx,
              scope.tenantId,
              current.event_id,
              inserted,
              b.dispatch ? 'dispatched' : 'assigned',
              b.dispatch
                ? `${current.reference}: dispatched by ${b.dispatch.method}, awaiting acknowledgement`
                : `${current.reference}: assigned, not yet dispatched`,
              s.accountId,
            );
            out.push(inserted);
          }
          await timelineEntry(trx, scope.tenantId, current.id, {
            kind: 'assignment',
            narrative_role: 'dispatcher',
            actor_account_id: s.accountId,
            reason: b.overrideReason ?? null,
            detail: JSON.stringify({ resources: b.resources, dispatch: b.dispatch ?? null }),
          });
          if (b.dispatch)
            await significant(
              trx,
              scope.tenantId,
              current.event_id,
              'dispatch',
              `${current.reference}: ${b.resources.length} resource(s) dispatched by ${b.dispatch.method}`,
              current.id,
              s.accountId,
              out[0]?.team_id ?? null,
            );
          await request.audit(trx, {
            tenantId: scope.tenantId,
            action: b.overrideReason ? 'assignment.override' : 'assignment.create',
            targetType: 'mission',
            targetId: current.id,
            reason: b.overrideReason ?? null,
            changes: {
              fields: [
                { name: 'assignments', to: out.map((a) => a.id) },
                { name: 'conflicts', to: all.length },
              ],
            },
          });
          return out;
        });
        return reply.code(201).send(rows.map(assignmentToOut));
      },
    );

    async function loadAssignment(request: FastifyRequest, scope: Scope, id: string) {
      const a = await run(request, scope, (trx) =>
        trx.selectFrom('cg.assignment').selectAll().where('id', '=', id).executeTakeFirst(),
      );
      if (!a) throw errors.notFound();
      if (scope.partnerId) {
        const own =
          (a.team_id && scope.teamIds.includes(a.team_id)) ||
          (a.personnel_id && scope.personnelIds.includes(a.personnel_id));
        if (!own) throw errors.notFound();
      }
      const mission = await load(request, scope, a.mission_id);
      return { a, mission };
    }

    /** One fact at a time, each with its own time and actor; never inferred from another (RULE-03, FR-06.05). */
    interface FactPlan {
      set: Record<string, unknown>;
      event: Partial<Insertable<Database['cg.assignment_event']>> & {
        kind: Database['cg.assignment_event']['kind'];
      };
      activityKind: Database['cg.activity_entry']['kind'];
      summary: string;
      significantKind?: Database['cg.significant_event']['kind'];
    }
    async function recordFact(
      request: FastifyRequest,
      action:
        | 'assignment.dispatch'
        | 'assignment.acknowledge'
        | 'assignment.status'
        | 'assignment.release',
      apply: (a: AssignmentRow, mission: Joined) => FactPlan,
    ): Promise<AssignmentOut> {
      const s = account(request);
      const scope = await scopeOf(request);
      const expected = request.expectedVersion();
      const { a, mission } = await loadAssignment(
        request,
        scope,
        (request.params as { id: string }).id,
      );
      const heldBySubject =
        (!!a.personnel_id && scope.holder.personnelIds.includes(a.personnel_id)) ||
        (!!a.team_id && scope.holder.teamIds.includes(a.team_id));
      await request.authorize(
        action,
        {
          type: 'assignment',
          id: a.id,
          tenantId: s.tenantId,
          eventId: mission.event_id,
          heldBySubject,
        },
        { asNotFound: true },
      );
      if (action !== 'assignment.acknowledge') assertUnlocked(mission, s.accountId);
      if (a.released_at)
        throw errors.validation([{ name: 'state', message: 'this assignment was released' }]);
      const plan = apply(a, mission);
      const row = await run(request, scope, async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.assignment')
            .set({ ...plan.set, updated_by: s.accountId } as never)
            .where('id', '=', a.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          assignmentToOut(a),
        );
        await trx
          .insertInto('cg.assignment_event')
          .values({
            tenant_id: scope.tenantId,
            assignment_id: a.id,
            actor_account_id: s.accountId,
            from_state: a.state,
            to_state: updated.state,
            ...plan.event,
          } as never)
          .execute();
        await activity(
          trx,
          scope.tenantId,
          mission.event_id,
          updated,
          plan.activityKind,
          `${mission.reference}: ${plan.summary}`,
          s.accountId,
        );
        if (plan.significantKind)
          await significant(
            trx,
            scope.tenantId,
            mission.event_id,
            plan.significantKind,
            `${mission.reference}: ${plan.summary}`,
            mission.id,
            s.accountId,
            a.team_id,
          );
        await request.audit(trx, {
          tenantId: scope.tenantId,
          action,
          targetType: 'assignment',
          targetId: a.id,
          targetVersion: updated.version,
          reason: (plan.event.reason as string | null | undefined) ?? null,
          changes: {
            fields: [
              { name: 'state', from: a.state, to: updated.state },
              ...Object.keys(plan.set).map((name) => ({ name })),
            ],
          },
        });
        return updated;
      });
      return assignmentToOut(row);
    }

    app.post(
      '/assignments/:id/dispatch',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            method: z.enum(dispatchMethods),
            /** FR-06.06: proof of delivery is its own fact; the method alone never sets it. */
            delivered: z
              .object({
                at: z.iso.datetime().optional(),
                evidence: z.record(z.string(), z.unknown()),
              })
              .optional(),
          }),
          response: { 200: assignmentOut },
        },
      },
      async (request) =>
        recordFact(request, 'assignment.dispatch', (a) => {
          if (!['assigned', 'dispatched', 'declined'].includes(a.state))
            throw notAllowed(a.state, 'dispatched');
          const b = request.body;
          return {
            set: {
              state: 'dispatched',
              dispatched_at: new Date(),
              dispatched_by: null,
              dispatch_method: b.method,
              ...(b.delivered
                ? {
                    delivered_at: b.delivered.at ? new Date(b.delivered.at) : new Date(),
                    delivery_evidence: JSON.stringify(b.delivered.evidence),
                  }
                : {}),
            },
            event: {
              kind: 'dispatched',
              method: b.method,
              evidence: b.delivered ? JSON.stringify(b.delivered.evidence) : null,
            },
            activityKind: 'dispatched',
            summary: `dispatched by ${b.method}${b.delivered ? ', delivery confirmed' : ', awaiting acknowledgement'}`,
            significantKind: 'dispatch',
          };
        }),
    );

    app.post(
      '/assignments/:id/acknowledge',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            accept: z.boolean().default(true),
            reason: z.string().max(500).optional(),
          }),
          response: { 200: assignmentOut },
        },
      },
      async (request) =>
        recordFact(request, 'assignment.acknowledge', (a) => {
          const b = request.body;
          if (!['assigned', 'dispatched'].includes(a.state))
            throw notAllowed(a.state, b.accept ? 'acknowledged' : 'declined');
          if (!b.accept && !b.reason)
            throw errors.validation([
              { name: 'reason', message: 'say why the assignment is declined' },
            ]);
          const plan: FactPlan = b.accept
            ? {
                set: {
                  state: 'acknowledged',
                  acknowledged_at: new Date(),
                  acknowledged_by: null,
                  delivered_at: a.delivered_at ?? new Date(),
                },
                event: { kind: 'acknowledged' },
                activityKind: 'acknowledged',
                summary: 'acknowledged',
              }
            : {
                set: { state: 'declined', declined_at: new Date(), declined_reason: b.reason },
                event: { kind: 'declined', reason: b.reason ?? null },
                activityKind: 'note',
                summary: `declined: ${b.reason}`,
              };
          return plan;
        }),
    );

    app.post(
      '/assignments/:id/status',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['missions'],
          params: uuidParam,
          body: z.object({
            to: z.enum(['en_route', 'on_scene', 'cleared']),
            /** DSP-05: a suggestion from location is recorded, never applied, until a person confirms. */
            suggested: z.boolean().default(false),
            at: z.iso.datetime().optional(),
            note: z.string().max(500).optional(),
          }),
          response: { 200: assignmentOut },
        },
      },
      async (request) =>
        recordFact(request, 'assignment.status', (a) => {
          const b = request.body;
          const at = b.at ? new Date(b.at) : new Date();
          if (b.suggested)
            return {
              set: {},
              event: {
                kind: 'suggested_status',
                reason: b.note ?? null,
                evidence: JSON.stringify({ to: b.to, at }),
              },
              activityKind: 'note',
              summary: `location suggests ${b.to.replace('_', ' ')}; awaiting confirmation`,
            };
          const order = [
            'assigned',
            'dispatched',
            'acknowledged',
            'en_route',
            'on_scene',
            'cleared',
          ];
          if (
            order.indexOf(b.to) <= order.indexOf(a.state) &&
            !(a.state === 'on_scene' && b.to === 'en_route')
          )
            throw notAllowed(a.state, b.to);
          if (a.state === 'declined') throw notAllowed(a.state, b.to);
          const column =
            b.to === 'en_route'
              ? 'en_route_at'
              : b.to === 'on_scene'
                ? 'on_scene_at'
                : 'cleared_at';
          return {
            set: {
              state: b.to,
              [column]: at,
              ...(b.to === 'on_scene' ? { on_scene_confirmed_by: null } : {}),
            },
            event: { kind: b.to, reason: b.note ?? null, occurred_at: at },
            activityKind: b.to,
            summary: b.to.replace('_', ' '),
            ...(b.to === 'on_scene' ? { significantKind: 'arrival' as const } : {}),
          };
        }),
    );

    app.post(
      '/assignments/:id/release',
      {
        config: { requiresVersion: true },
        schema: { tags: ['missions'], params: uuidParam, response: { 200: assignmentOut } },
      },
      async (request) =>
        recordFact(request, 'assignment.release', () => {
          const reason = request.confirmation().reason!;
          return {
            set: {
              state: 'released',
              released_at: new Date(),
              released_by: null,
              release_reason: reason,
            },
            event: { kind: 'released', reason },
            activityKind: 'released',
            summary: `released: ${reason}`,
          };
        }),
    );
  };

export const missionRoutes: FastifyPluginAsync = missionRoutesWith();
