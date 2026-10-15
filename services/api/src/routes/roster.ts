/**
 * The field roster (layer-4 plan §3, task D; PER-01, PER-02, BRD:FR-05.01–05.06,
 * AC-05A/B, DSP-01, DSP-02, DSP-05, DSP-07, DSP-08, DSP-09, FLD-02, FLD-03,
 * FLD-16, FL-17, RULE-03): credentials recorded and verified (never
 * inferred), skill search that answers only from recorded credentials,
 * teams and units with members over time, team status as confirmed facts
 * apart from suggestions, check-in by event code or QR with the credentials
 * in force, check-out, registered app installs with remote wipe, positions
 * accepted only while checked in and shown to dispatch and safety roles at
 * the tenant's precision, and safety alerts that carry the exact position
 * whatever that precision is.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { configValue } from '../public/submit.ts';
import { classifierFor, iso, listQuery, pickDefined, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type TeamRow = Selectable<Database['cg.team']>;
type CheckInRow = Selectable<Database['cg.check_in']>;
type AlertRow = Selectable<Database['cg.safety_alert']>;

export const credentialKinds = [
  'damage_assessor',
  'chainsaw',
  'spanish_speaker',
  'chaplain',
  'ham_operator',
  'medical',
  'cert',
  'driver_cdl',
  'heavy_equipment',
  'shelter_management',
  'food_safety',
  'child_safeguarding',
  'mental_health_first_aid',
  'background_check',
  'other',
] as const;
const teamKinds = ['team', 'unit', 'canteen', 'crew', 'strike_team', 'net'] as const;
const teamStatuses = [
  'available',
  'en_route',
  'on_task',
  'break',
  'out_of_service',
  'overdue',
] as const;
const memberRoles = ['lead', 'member', 'driver', 'operator', 'medic'] as const;
const alertKinds = [
  'help_button',
  'missed_check_in',
  'unacknowledged_assignment',
  'hazard_entry',
  'device_lost',
] as const;

const dateOnly = (d: Date | string | null): string | null =>
  d === null ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

const credentialOut = z.object({
  ...stamped,
  personnelId: z.uuid(),
  kind: z.enum(credentialKinds),
  label: z.string().nullable(),
  issuer: z.string().nullable(),
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  status: z.enum(['recorded', 'verified', 'expired', 'revoked']),
  verifiedBy: z.uuid().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  /** Verified and not past its expiry: what counts for an assignment (FR-05.06). */
  inForce: z.boolean(),
});
type CredentialOut = z.infer<typeof credentialOut>;

const statusOut = z.object({
  status: z.enum(teamStatuses),
  fact: z.enum(['confirmed', 'suggested']),
  source: z.string(),
  at: z.iso.datetime(),
  note: z.string().nullable(),
});

const memberOut = z.object({
  personnelId: z.uuid(),
  name: z.string(),
  role: z.enum(memberRoles),
  joinedAt: z.iso.datetime(),
  checkedIn: z.boolean(),
  credentials: z.array(z.string()),
});

const teamOut = z.object({
  ...stamped,
  tenantId: z.uuid(),
  eventId: z.uuid().nullable(),
  key: z.string(),
  name: z.string(),
  kind: z.enum(teamKinds),
  agencyTenantId: z.uuid().nullable(),
  agency: z.string().nullable(),
  callsign: z.string().nullable(),
  leadPersonnelId: z.uuid().nullable(),
  skills: z.array(z.string()),
  equipment: z.array(z.string()),
  capacity: z.number().int().nullable(),
  /** REC-06: a canteen's declared serving rate. */
  mealsPerHour: z.number().int().nullable(),
  checkInIntervalMinutes: z.number().int(),
  status: z.enum(['active', 'stood_down', 'archived']),
  notes: z.string().nullable(),
  current: statusOut.nullable(),
  suggested: statusOut.nullable(),
  memberCount: z.number().int(),
  checkedInCount: z.number().int(),
  /** DSP-07: when the next check-in is due, from the last confirmed status. */
  checkInDueAt: z.iso.datetime().nullable(),
  members: z.array(memberOut).optional(),
  history: z.array(statusOut).optional(),
});
type TeamOut = z.infer<typeof teamOut>;

const checkInOut = z.object({
  id: z.uuid(),
  personnelId: z.uuid(),
  personnelName: z.string().nullable(),
  eventId: z.uuid(),
  teamId: z.uuid().nullable(),
  agencyTenantId: z.uuid().nullable(),
  method: z.enum(['qr', 'event_code', 'net_control', 'console']),
  credentials: z.array(z.object({ kind: z.string(), status: z.string() })),
  deviceId: z.uuid().nullable(),
  locationSharing: z.boolean(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  endReason: z.string().nullable(),
  hours: z.number().nullable(),
});

const deviceOut = z.object({
  ...stamped,
  accountId: z.uuid(),
  installId: z.string(),
  platform: z.enum(['ios', 'android', 'web']),
  managed: z.boolean(),
  model: z.string().nullable(),
  appVersion: z.string().nullable(),
  status: z.enum(['active', 'wipe_requested', 'wiped', 'revoked']),
  registeredAt: z.iso.datetime(),
  lastContactAt: z.iso.datetime().nullable(),
  wipeRequestedAt: z.iso.datetime().nullable(),
  wipeConfirmedAt: z.iso.datetime().nullable(),
  /** FLD-02: what the app must do on its next contact. */
  wipeRequired: z.boolean(),
});

const positionOut = z.object({
  personnelId: z.uuid(),
  teamId: z.uuid().nullable(),
  checkInId: z.uuid(),
  lat: z.number(),
  lon: z.number(),
  accuracyM: z.number().nullable(),
  recordedAt: z.iso.datetime(),
  source: z.string(),
  /** Metres the tenant rounds positions to for this role; 0 is exact (DSP-08). */
  precisionM: z.number(),
  /** FR-03.05: older than the staleness window. */
  stale: z.boolean(),
});

const alertOut = z.object({
  ...stamped,
  eventId: z.uuid(),
  kind: z.enum(alertKinds),
  personnelId: z.uuid().nullable(),
  teamId: z.uuid().nullable(),
  checkInId: z.uuid().nullable(),
  assignmentId: z.uuid().nullable(),
  hazardId: z.uuid().nullable(),
  position: z
    .object({
      lat: z.number(),
      lon: z.number(),
      accuracyM: z.number().nullable(),
      at: z.iso.datetime().nullable(),
    })
    .nullable(),
  note: z.string().nullable(),
  state: z.enum(['open', 'acknowledged', 'escalated', 'resolved', 'false_alarm']),
  raisedAt: z.iso.datetime(),
  raisedBy: z.uuid().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  acknowledgedBy: z.uuid().nullable(),
  escalatedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  resolution: z.string().nullable(),
});

export const rosterRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  /** The personnel record linked to the signed-in account, for self-service routes (ACCT-01). */
  async function ownPersonnel(
    request: FastifyRequest,
  ): Promise<{ id: string; tenant_id: string; name: string }> {
    const s = account(request);
    const row = await request.tx((trx) =>
      trx
        .selectFrom('cg.personnel')
        .select(['id', 'tenant_id', 'name'])
        .where('account_id', '=', s.accountId)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    if (!row)
      throw new ApiError(
        409,
        'no_personnel_record',
        'Your account is not linked to a personnel record; ask your coordinator.',
      );
    return row;
  }

  // ----------------------------------------------------------- credentials
  const toCredential = (r: Selectable<Database['cg.credential']>): CredentialOut => {
    const expires = r.expires_at ? new Date(r.expires_at) : null;
    return {
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      personnelId: r.personnel_id,
      kind: r.kind,
      label: r.label,
      issuer: r.issuer,
      issuedAt: dateOnly(r.issued_at),
      expiresAt: dateOnly(r.expires_at),
      status: r.status,
      verifiedBy: r.verified_by,
      verifiedAt: iso(r.verified_at),
      note: r.note,
      inForce:
        r.status === 'verified' && (!expires || expires.getTime() >= Date.now() - 86_400_000),
    };
  };

  app.get(
    '/personnel/:id/credentials',
    { schema: { tags: ['roster'], params: uuidParam, response: { 200: z.array(credentialOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('credential.read', { type: 'credential', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.credential')
          .selectAll()
          .where('personnel_id', '=', request.params.id)
          .orderBy('kind')
          .execute(),
      );
      return rows.map(toCredential);
    },
  );

  app.post(
    '/personnel/:id/credentials',
    {
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object({
          kind: z.enum(credentialKinds),
          label: z.string().max(120).optional(),
          issuer: z.string().max(200).optional(),
          issuedAt: z.iso.date().optional(),
          expiresAt: z.iso.date().optional(),
          evidenceKey: z.string().max(400).optional(),
          note: z.string().max(500).optional(),
          /** Recording and verifying at once needs credential.verify as well. */
          verified: z.boolean().default(false),
        }),
        response: { 201: credentialOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const person = await request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .select(['id', 'tenant_id', 'status'])
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!person) throw errors.notFound();
      await request.authorize(
        'credential.record',
        { type: 'credential', tenantId: person.tenant_id },
        { asNotFound: true },
      );
      if (request.body.verified)
        await request.authorize('credential.verify', {
          type: 'credential',
          tenantId: person.tenant_id,
        });
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.credential')
          .values({
            tenant_id: person.tenant_id,
            personnel_id: person.id,
            kind: b.kind,
            label: b.label ?? null,
            issuer: b.issuer ?? null,
            issued_at: b.issuedAt ?? null,
            expires_at: b.expiresAt ?? null,
            evidence_key: b.evidenceKey ?? null,
            note: b.note ?? null,
            status: b.verified ? 'verified' : 'recorded',
            verified_by: b.verified ? s.accountId : null,
            verified_at: b.verified ? new Date() : null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        // PER-01: the person's skills list mirrors recorded credentials, never the other way round.
        await sql`update cg.personnel set skills = (select array_agg(distinct kind order by kind) from cg.credential where personnel_id = ${person.id} and status in ('recorded', 'verified')), updated_by = ${s.accountId}::uuid where id = ${person.id}`.execute(
          trx,
        );
        await request.audit(trx, {
          tenantId: person.tenant_id,
          action: b.verified ? 'credential.verify' : 'credential.record',
          targetType: 'credential',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            {
              kind: inserted.kind,
              status: inserted.status,
              expires_at: inserted.expires_at,
              issuer: inserted.issuer,
            },
            classifierFor('credential'),
          ),
        });
        return inserted;
      });
      return reply.code(201).send(toCredential(row));
    },
  );

  async function credentialAction(
    request: FastifyRequest,
    action: 'credential.verify' | 'credential.revoke',
  ) {
    const s = account(request);
    const { id } = request.params as { id: string };
    const expected = request.expectedVersion();
    const current = await request.tx((trx) =>
      trx.selectFrom('cg.credential').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!current) throw errors.notFound();
    await request.authorize(
      action,
      { type: 'credential', id: current.id, tenantId: current.tenant_id },
      { asNotFound: true },
    );
    const reason = request.confirmation().reason;
    const body = (request.body ?? {}) as { note?: string; expiresAt?: string };
    const row = await request.tx(async (trx) => {
      const updated = assertUpdated(
        await trx
          .updateTable('cg.credential')
          .set(
            action === 'credential.verify'
              ? {
                  status: 'verified',
                  verified_by: s.accountId,
                  verified_at: new Date(),
                  ...(body.expiresAt ? { expires_at: body.expiresAt } : {}),
                  ...(body.note !== undefined ? { note: body.note } : {}),
                  updated_by: s.accountId,
                }
              : { status: 'revoked', note: reason ?? body.note ?? null, updated_by: s.accountId },
          )
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst(),
        toCredential(current),
      );
      if (action === 'credential.revoke')
        await sql`update cg.personnel set skills = coalesce((select array_agg(distinct kind order by kind) from cg.credential where personnel_id = ${current.personnel_id} and status in ('recorded', 'verified')), '{}'), updated_by = ${s.accountId}::uuid where id = ${current.personnel_id}`.execute(
          trx,
        );
      await request.audit(trx, {
        tenantId: current.tenant_id,
        action,
        targetType: 'credential',
        targetId: current.id,
        targetVersion: updated.version,
        reason: reason ?? null,
        changes: diffForAudit(
          { status: current.status, expires_at: current.expires_at },
          { status: updated.status, expires_at: updated.expires_at },
          classifierFor('credential'),
        ),
      });
      return updated;
    });
    return toCredential(row);
  }

  app.post(
    '/credentials/:id/verify',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z
          .object({ expiresAt: z.iso.date().optional(), note: z.string().max(500).optional() })
          .optional(),
        response: { 200: credentialOut },
      },
    },
    (request) => credentialAction(request, 'credential.verify'),
  );
  app.post(
    '/credentials/:id/revoke',
    {
      config: { requiresVersion: true },
      schema: { tags: ['roster'], params: uuidParam, response: { 200: credentialOut } },
    },
    (request) => credentialAction(request, 'credential.revoke'),
  );

  // AC-05A: a skill search answers only from recorded credentials in force, never from a role or a past assignment.
  app.get(
    '/personnel/search',
    {
      schema: {
        tags: ['roster'],
        querystring: listQuery.extend({
          skill: z.enum(credentialKinds),
          available: z.coerce.boolean().optional(),
          checkedIn: z.coerce.boolean().optional(),
        }),
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              name: z.string(),
              agency: z.string().nullable(),
              tenantId: z.uuid(),
              status: z.string(),
              dutyStatus: z.string(),
              availability: z.string(),
              credentials: z.array(z.string()),
              checkedIn: z.boolean(),
              teamIds: z.array(z.uuid()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('personnel.read', { type: 'personnel', tenantId: s.tenantId });
      await request.authorize('credential.read', { type: 'credential', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.personnel as p')
          .select([
            'p.id',
            'p.name',
            'p.agency',
            'p.tenant_id',
            'p.status',
            'p.duty_status',
            'p.availability',
          ])
          .where('p.status', '=', 'active')
          .where(({ exists, selectFrom }) =>
            exists(
              selectFrom('cg.credential as c')
                .select('c.id')
                .whereRef('c.personnel_id', '=', 'p.id')
                .where('c.kind', '=', q.skill)
                .where('c.status', '=', 'verified')
                .where((eb) =>
                  eb.or([eb('c.expires_at', 'is', null), eb('c.expires_at', '>=', new Date())]),
                ),
            ),
          )
          .orderBy('p.name')
          .limit(q.limit)
          .offset(q.offset);
        if (q.available) x = x.where('p.availability', '=', 'available');
        if (q.checkedIn)
          x = x.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('cg.check_in as ci')
                .select('ci.id')
                .whereRef('ci.personnel_id', '=', 'p.id')
                .where('ci.ended_at', 'is', null),
            ),
          );
        const people = await x.execute();
        if (people.length === 0) return [];
        const ids = people.map((p) => p.id);
        const creds = await trx
          .selectFrom('cg.credential')
          .select(['personnel_id', 'kind'])
          .where('personnel_id', 'in', ids)
          .where('status', '=', 'verified')
          .execute();
        const open = await trx
          .selectFrom('cg.check_in')
          .select('personnel_id')
          .where('personnel_id', 'in', ids)
          .where('ended_at', 'is', null)
          .execute();
        const members = await trx
          .selectFrom('cg.team_member')
          .select(['personnel_id', 'team_id'])
          .where('personnel_id', 'in', ids)
          .where('left_at', 'is', null)
          .execute();
        return people.map((p) => ({
          id: p.id,
          name: p.name,
          agency: p.agency,
          tenantId: p.tenant_id,
          status: p.status,
          dutyStatus: p.duty_status,
          availability: p.availability,
          credentials: creds.filter((c) => c.personnel_id === p.id).map((c) => c.kind as string),
          checkedIn: open.some((o) => o.personnel_id === p.id),
          teamIds: members.filter((m) => m.personnel_id === p.id).map((m) => m.team_id),
        }));
      });
      return rows;
    },
  );

  // ----------------------------------------------------------------- teams
  const statusRow = (r: {
    status: (typeof teamStatuses)[number];
    fact: 'confirmed' | 'suggested';
    source: string;
    created_at: Date;
    note: string | null;
  }) => ({
    status: r.status,
    fact: r.fact,
    source: r.source,
    at: iso(r.created_at)!,
    note: r.note,
  });

  async function teamOutOf(trx: Trx, t: TeamRow, detail = false): Promise<TeamOut> {
    const latest = await trx
      .selectFrom('cg.team_status')
      .selectAll()
      .where('team_id', '=', t.id)
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute();
    const current = latest.find((x) => x.fact === 'confirmed') ?? null;
    const lastSuggested = latest.find((x) => x.fact === 'suggested') ?? null;
    const suggested =
      lastSuggested &&
      (!current || new Date(lastSuggested.created_at) > new Date(current.created_at))
        ? lastSuggested
        : null;
    const members = await trx
      .selectFrom('cg.team_member as tm')
      .innerJoin('cg.personnel as p', 'p.id', 'tm.personnel_id')
      .select(['tm.personnel_id', 'tm.role', 'tm.joined_at', 'p.name'])
      .where('tm.team_id', '=', t.id)
      .where('tm.left_at', 'is', null)
      .orderBy('tm.joined_at')
      .execute();
    const open = members.length
      ? await trx
          .selectFrom('cg.check_in')
          .select('personnel_id')
          .where('team_id', '=', t.id)
          .where('ended_at', 'is', null)
          .execute()
      : [];
    const due =
      current && open.length > 0
        ? new Date(new Date(current.created_at).getTime() + t.check_in_interval_minutes * 60_000)
        : null;
    const base: TeamOut = {
      id: t.id,
      version: t.version,
      createdAt: iso(t.created_at)!,
      updatedAt: iso(t.updated_at)!,
      tenantId: t.tenant_id,
      eventId: t.event_id,
      key: t.key,
      name: t.name,
      kind: t.kind,
      agencyTenantId: t.agency_tenant_id,
      agency: t.agency,
      callsign: t.callsign,
      leadPersonnelId: t.lead_personnel_id,
      skills: t.skills,
      equipment: t.equipment,
      capacity: t.capacity,
      mealsPerHour: t.meals_per_hour,
      checkInIntervalMinutes: t.check_in_interval_minutes,
      status: t.status,
      notes: t.notes,
      current: current ? statusRow(current) : null,
      suggested: suggested ? statusRow(suggested) : null,
      memberCount: members.length,
      checkedInCount: open.length,
      checkInDueAt: iso(due),
    };
    if (!detail) return base;
    const creds = members.length
      ? await trx
          .selectFrom('cg.credential')
          .select(['personnel_id', 'kind'])
          .where(
            'personnel_id',
            'in',
            members.map((m) => m.personnel_id),
          )
          .where('status', '=', 'verified')
          .execute()
      : [];
    return {
      ...base,
      members: members.map((m) => ({
        personnelId: m.personnel_id,
        name: m.name,
        role: m.role,
        joinedAt: iso(m.joined_at)!,
        checkedIn: open.some((o) => o.personnel_id === m.personnel_id),
        credentials: creds
          .filter((c) => c.personnel_id === m.personnel_id)
          .map((c) => c.kind as string),
      })),
      history: latest.map(statusRow),
    };
  }

  async function loadTeam(request: FastifyRequest, id: string): Promise<TeamRow> {
    const row = await request.tx((trx) =>
      trx.selectFrom('cg.team').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!row) throw errors.notFound();
    return row;
  }

  app.get(
    '/teams',
    {
      schema: {
        tags: ['roster'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          agencyTenantId: z.uuid().optional(),
          status: z.enum(teamStatuses).optional(),
          skill: z.string().max(60).optional(),
          checkedIn: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(teamOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('team.read', { type: 'team', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx(async (trx) => {
        // RLS shows the caller's organization and, for an ancestor, its partners (DSP-09).
        let x = trx
          .selectFrom('cg.team')
          .selectAll()
          .where('status', '<>', 'archived')
          .orderBy('name')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId)
          x = x.where((eb) => eb.or([eb('event_id', '=', q.eventId!), eb('event_id', 'is', null)]));
        if (q.agencyTenantId) x = x.where('agency_tenant_id', '=', q.agencyTenantId);
        if (q.skill)
          x = x.where(sql<boolean>`${sql.ref('skills')} @> ${sql.val([q.skill])}::text[]`);
        const teams = await x.execute();
        const out: TeamOut[] = [];
        for (const t of teams) out.push(await teamOutOf(trx, t));
        return out;
      });
      return rows
        .filter((t) => (q.status ? t.current?.status === q.status : true))
        .filter((t) => (q.checkedIn ? t.checkedInCount > 0 : true));
    },
  );

  app.get(
    '/teams/:id',
    { schema: { tags: ['roster'], params: uuidParam, response: { 200: teamOut } } },
    async (request) => {
      const s = account(request);
      const t = await loadTeam(request, request.params.id);
      await request.authorize(
        'team.read',
        { type: 'team', id: t.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      return request.tx((trx) => teamOutOf(trx, t, true));
    },
  );

  const teamFields = {
    eventId: z.uuid().nullable(),
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(120),
    kind: z.enum(teamKinds),
    agency: z.string().max(200).nullable(),
    callsign: z.string().max(40).nullable(),
    leadPersonnelId: z.uuid().nullable(),
    skills: z.array(z.string().max(60)).max(20),
    equipment: z.array(z.string().max(120)).max(40),
    capacity: z.number().int().min(0).nullable(),
    mealsPerHour: z.number().int().min(0).max(5000).nullable(),
    checkInIntervalMinutes: z.number().int().min(5).max(480),
    notes: z.string().max(2000).nullable(),
  };
  const teamColumns = {
    eventId: 'event_id',
    key: 'key',
    name: 'name',
    kind: 'kind',
    agency: 'agency',
    callsign: 'callsign',
    leadPersonnelId: 'lead_personnel_id',
    skills: 'skills',
    equipment: 'equipment',
    capacity: 'capacity',
    mealsPerHour: 'meals_per_hour',
    checkInIntervalMinutes: 'check_in_interval_minutes',
    notes: 'notes',
  } as const;

  app.post(
    '/teams',
    {
      schema: {
        tags: ['roster'],
        body: z.object({
          ...teamFields,
          eventId: teamFields.eventId.optional(),
          kind: teamFields.kind.default('team'),
          agency: teamFields.agency.optional(),
          callsign: teamFields.callsign.optional(),
          leadPersonnelId: teamFields.leadPersonnelId.optional(),
          skills: teamFields.skills.default([]),
          equipment: teamFields.equipment.default([]),
          capacity: teamFields.capacity.optional(),
          mealsPerHour: teamFields.mealsPerHour.optional(),
          checkInIntervalMinutes: teamFields.checkInIntervalMinutes.default(60),
          notes: teamFields.notes.optional(),
          members: z
            .array(z.object({ personnelId: z.uuid(), role: z.enum(memberRoles).default('member') }))
            .max(50)
            .default([]),
        }),
        response: { 201: teamOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('team.manage', { type: 'team', tenantId: s.tenantId });
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const taken = await trx
          .selectFrom('cg.team')
          .select('id')
          .where('tenant_id', '=', s.tenantId)
          .where('key', '=', b.key)
          .executeTakeFirst();
        if (taken)
          throw errors.validation([{ name: 'key', message: 'already used by another team' }]);
        const inserted = await trx
          .insertInto('cg.team')
          .values({
            tenant_id: s.tenantId,
            agency_tenant_id: s.tenantId,
            ...pickDefined(b as Record<string, unknown>, teamColumns),
            key: b.key,
            name: b.name,
            created_by: s.accountId,
            updated_by: s.accountId,
          } as never)
          .returningAll()
          .executeTakeFirstOrThrow();
        for (const m of b.members) {
          await trx
            .insertInto('cg.team_member')
            .values({
              tenant_id: s.tenantId,
              team_id: inserted.id,
              personnel_id: m.personnelId,
              role: m.role,
              created_by: s.accountId,
            })
            .execute();
        }
        await trx
          .insertInto('cg.team_status')
          .values({
            tenant_id: s.tenantId,
            team_id: inserted.id,
            status: 'out_of_service',
            fact: 'confirmed',
            source: 'console',
            set_by_account_id: s.accountId,
            note: 'Created',
          })
          .execute();
        await request.audit(trx, {
          action: 'team.manage',
          targetType: 'team',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            { ...inserted, members: b.members.length } as Record<string, unknown>,
            classifierFor('team'),
          ),
        });
        return teamOutOf(trx, inserted, true);
      });
      return reply.code(201).send(row);
    },
  );

  app.patch(
    '/teams/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object(
          Object.fromEntries(
            Object.entries(teamFields)
              .filter(([k]) => k !== 'key')
              .map(([k, v]) => [k, v.optional()]),
          ) as {
            [K in Exclude<keyof typeof teamFields, 'key'>]: z.ZodOptional<(typeof teamFields)[K]>;
          },
        ),
        response: { 200: teamOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await loadTeam(request, request.params.id);
      await request.authorize(
        'team.manage',
        { type: 'team', id: current.id, tenantId: current.tenant_id },
        { asNotFound: true },
      );
      const row = await request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.team')
            .set({
              ...pickDefined(request.body as Record<string, unknown>, teamColumns),
              updated_by: s.accountId,
            } as never)
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          await teamOutOf(trx, current),
        );
        await request.audit(trx, {
          tenantId: current.tenant_id,
          action: 'team.manage',
          targetType: 'team',
          targetId: updated.id,
          targetVersion: updated.version,
          changes: diffForAudit(
            current as Record<string, unknown>,
            updated as Record<string, unknown>,
            classifierFor('team'),
          ),
        });
        return teamOutOf(trx, updated, true);
      });
      return row;
    },
  );

  app.post(
    '/teams/:id/members',
    {
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object({ personnelId: z.uuid(), role: z.enum(memberRoles).default('member') }),
        response: { 200: teamOut },
      },
    },
    async (request) => {
      const s = account(request);
      const t = await loadTeam(request, request.params.id);
      await request.authorize(
        'team.manage',
        { type: 'team', id: t.id, tenantId: t.tenant_id },
        { asNotFound: true },
      );
      const row = await request.tx(async (trx) => {
        const person = await trx
          .selectFrom('cg.personnel')
          .select(['id', 'status', 'tenant_id'])
          .where('id', '=', request.body.personnelId)
          .executeTakeFirst();
        if (!person)
          throw errors.validation([
            { name: 'personnelId', message: 'no such person in your organization' },
          ]);
        if (person.status !== 'active')
          throw errors.validation([
            { name: 'personnelId', message: `this person is ${person.status}` },
          ]);
        await trx
          .insertInto('cg.team_member')
          .values({
            tenant_id: t.tenant_id,
            team_id: t.id,
            personnel_id: person.id,
            role: request.body.role,
            created_by: s.accountId,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        if (request.body.role === 'lead')
          await trx
            .updateTable('cg.team')
            .set({ lead_personnel_id: person.id, updated_by: s.accountId })
            .where('id', '=', t.id)
            .execute();
        await request.audit(trx, {
          tenantId: t.tenant_id,
          action: 'team.manage',
          targetType: 'team',
          targetId: t.id,
          changes: {
            fields: [
              { name: 'member_added', to: person.id },
              { name: 'role', to: request.body.role },
            ],
          },
        });
        const fresh = await trx
          .selectFrom('cg.team')
          .selectAll()
          .where('id', '=', t.id)
          .executeTakeFirstOrThrow();
        return teamOutOf(trx, fresh, true);
      });
      return row;
    },
  );

  app.delete(
    '/teams/:id/members/:personnelId',
    {
      schema: {
        tags: ['roster'],
        params: uuidParam.extend({ personnelId: z.uuid() }),
        body: z.object({ reason: z.string().max(300).optional() }).optional(),
        response: { 200: teamOut },
      },
    },
    async (request) => {
      const s = account(request);
      const t = await loadTeam(request, request.params.id);
      await request.authorize(
        'team.manage',
        { type: 'team', id: t.id, tenantId: t.tenant_id },
        { asNotFound: true },
      );
      const row = await request.tx(async (trx) => {
        const left = await trx
          .updateTable('cg.team_member')
          .set({ left_at: new Date(), left_reason: request.body?.reason ?? null })
          .where('team_id', '=', t.id)
          .where('personnel_id', '=', request.params.personnelId)
          .where('left_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!left) throw errors.notFound();
        if (t.lead_personnel_id === request.params.personnelId)
          await trx
            .updateTable('cg.team')
            .set({ lead_personnel_id: null, updated_by: s.accountId })
            .where('id', '=', t.id)
            .execute();
        await request.audit(trx, {
          tenantId: t.tenant_id,
          action: 'team.manage',
          targetType: 'team',
          targetId: t.id,
          reason: request.body?.reason ?? null,
          changes: { fields: [{ name: 'member_left', to: request.params.personnelId }] },
        });
        const fresh = await trx
          .selectFrom('cg.team')
          .selectAll()
          .where('id', '=', t.id)
          .executeTakeFirstOrThrow();
        return teamOutOf(trx, fresh, true);
      });
      return row;
    },
  );

  /** DSP-05, RULE-03: a confirmed status is a fact the team or the board set; a suggested one waits for them. */
  app.post(
    '/teams/:id/status',
    {
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object({
          status: z.enum(teamStatuses),
          suggested: z.boolean().default(false),
          source: z.enum(['app', 'console', 'net_control']).default('console'),
          note: z.string().max(300).optional(),
        }),
        response: { 200: teamOut },
      },
    },
    async (request) => {
      const s = account(request);
      const t = await loadTeam(request, request.params.id);
      await request.authorize(
        'team.status',
        { type: 'team', id: t.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      const b = request.body;
      if (b.status === 'overdue' && !b.suggested)
        throw errors.validation([
          { name: 'status', message: 'overdue is set by the timer, not by hand' },
        ]);
      const row = await request.tx(async (trx) => {
        const checkIn = await trx
          .selectFrom('cg.check_in')
          .select('id')
          .where('team_id', '=', t.id)
          .where('ended_at', 'is', null)
          .orderBy('started_at')
          .executeTakeFirst();
        await trx
          .insertInto('cg.team_status')
          .values({
            tenant_id: t.tenant_id,
            team_id: t.id,
            status: b.status,
            fact: b.suggested ? 'suggested' : 'confirmed',
            source: b.source,
            set_by_account_id: s.accountId,
            check_in_id: checkIn?.id ?? null,
            note: b.note ?? null,
          })
          .execute();
        if (!b.suggested) {
          // Answering the timer resolves an open missed-check-in alert for the team (DSP-07).
          const resolved = await trx
            .updateTable('cg.safety_alert')
            .set({
              state: 'resolved',
              resolved_at: new Date(),
              resolved_by: s.accountId,
              resolution: `Team reported ${b.status.replace('_', ' ')}`,
            })
            .where('team_id', '=', t.id)
            .where('kind', '=', 'missed_check_in')
            .where('state', 'in', ['open', 'acknowledged', 'escalated'])
            .returning('id')
            .execute();
          if (t.event_id)
            await trx
              .insertInto('cg.activity_entry')
              .values({
                tenant_id: t.tenant_id,
                event_id: t.event_id,
                team_id: t.id,
                kind: 'status',
                summary: `${b.status.replace('_', ' ')}${b.note ? `: ${b.note}` : ''}${resolved.length ? ' (overdue cleared)' : ''}`,
                ref_kind: 'team',
                ref_id: t.id,
                actor_account_id: s.accountId,
              })
              .execute();
        }
        await request.audit(trx, {
          tenantId: t.tenant_id,
          action: 'team.status',
          targetType: 'team',
          targetId: t.id,
          changes: {
            fields: [
              { name: b.suggested ? 'suggested_status' : 'status', to: b.status },
              { name: 'source', to: b.source },
            ],
          },
        });
        return teamOutOf(trx, t, true);
      });
      return row;
    },
  );

  app.post(
    '/teams/:id/archive',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object({ standDown: z.boolean().default(false) }).optional(),
        response: { 200: teamOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const t = await loadTeam(request, request.params.id);
      await request.authorize(
        'team.archive',
        { type: 'team', id: t.id, tenantId: t.tenant_id },
        { asNotFound: true },
      );
      const reason = request.confirmation().reason!;
      const to = request.body?.standDown ? 'stood_down' : 'archived';
      const row = await request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.team')
            .set({ status: to, updated_by: s.accountId })
            .where('id', '=', t.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          await teamOutOf(trx, t),
        );
        await trx
          .insertInto('cg.team_status')
          .values({
            tenant_id: t.tenant_id,
            team_id: t.id,
            status: 'out_of_service',
            fact: 'confirmed',
            source: 'console',
            set_by_account_id: s.accountId,
            note: reason,
          })
          .execute();
        await request.audit(trx, {
          tenantId: t.tenant_id,
          action: 'team.archive',
          targetType: 'team',
          targetId: t.id,
          targetVersion: updated.version,
          reason,
          changes: { fields: [{ name: 'status', from: t.status, to }] },
        });
        return teamOutOf(trx, updated);
      });
      return row;
    },
  );

  // -------------------------------------------------------------- check-in
  const toCheckIn = (
    r: CheckInRow & { personnel_name?: string | null },
  ): z.infer<typeof checkInOut> => ({
    id: r.id,
    personnelId: r.personnel_id,
    personnelName: r.personnel_name ?? null,
    eventId: r.event_id,
    teamId: r.team_id,
    agencyTenantId: r.agency_tenant_id,
    method: r.method,
    credentials: (r.credentials_snapshot as { kind: string; status: string }[]) ?? [],
    deviceId: r.device_id,
    locationSharing: r.location_sharing,
    startedAt: iso(r.started_at)!,
    endedAt: iso(r.ended_at),
    endReason: r.end_reason,
    hours: r.hours === null ? null : Number(r.hours),
  });

  async function startCheckIn(
    request: FastifyRequest,
    trx: Trx,
    person: { id: string; tenant_id: string },
    b: {
      eventCode?: string | undefined;
      eventId?: string | undefined;
      teamId?: string | undefined;
      deviceId?: string | undefined;
      locationSharing?: boolean | undefined;
      method: 'qr' | 'event_code' | 'net_control' | 'console';
    },
    actor: string,
  ): Promise<CheckInRow> {
    let event: { id: string; status: string } | undefined;
    if (b.eventId)
      event = await trx
        .selectFrom('cg.event')
        .select(['id', 'status'])
        .where('id', '=', b.eventId)
        .executeTakeFirst();
    else if (b.eventCode)
      event = await trx
        .selectFrom('cg.event')
        .select(['id', 'status'])
        .where(sql`upper(check_in_code)`, '=', b.eventCode.trim().toUpperCase())
        .where('status', '=', 'active')
        .executeTakeFirst();
    if (!event || event.status !== 'active')
      throw errors.validation([
        { name: b.eventCode ? 'eventCode' : 'eventId', message: 'no active event with that code' },
      ]);
    const open = await trx
      .selectFrom('cg.check_in')
      .select('id')
      .where('personnel_id', '=', person.id)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    if (open)
      throw new ApiError(
        409,
        'already_checked_in',
        'This person is already checked in; check out first.',
        { details: { checkInId: open.id } },
      );
    let teamId: string | null;
    if (b.teamId) {
      const member = await trx
        .selectFrom('cg.team_member')
        .select('team_id')
        .where('team_id', '=', b.teamId)
        .where('personnel_id', '=', person.id)
        .where('left_at', 'is', null)
        .executeTakeFirst();
      if (!member)
        throw errors.validation([{ name: 'teamId', message: 'not a member of that team' }]);
      teamId = member.team_id;
    } else {
      const member = await trx
        .selectFrom('cg.team_member')
        .select('team_id')
        .where('personnel_id', '=', person.id)
        .where('left_at', 'is', null)
        .orderBy('joined_at', 'desc')
        .executeTakeFirst();
      teamId = member?.team_id ?? null;
    }
    const creds = await trx
      .selectFrom('cg.credential')
      .select(['kind', 'status', 'expires_at'])
      .where('personnel_id', '=', person.id)
      .where('status', 'in', ['recorded', 'verified'])
      .execute();
    const inserted = await trx
      .insertInto('cg.check_in')
      .values({
        tenant_id: person.tenant_id,
        personnel_id: person.id,
        event_id: event.id,
        team_id: teamId,
        agency_tenant_id: person.tenant_id,
        method: b.method,
        credentials_snapshot: JSON.stringify(
          creds.map((c) => ({ kind: c.kind, status: c.status, expiresAt: dateOnly(c.expires_at) })),
        ),
        device_id: b.deviceId ?? null,
        location_sharing: b.locationSharing ?? true,
        created_by: actor,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('cg.personnel')
      .set({ duty_status: 'on_duty', updated_by: actor })
      .where('id', '=', person.id)
      .execute();
    await trx
      .insertInto('cg.activity_entry')
      .values({
        tenant_id: person.tenant_id,
        event_id: event.id,
        personnel_id: person.id,
        team_id: teamId,
        kind: 'check_in',
        summary: `Checked in by ${b.method.replace('_', ' ')}${teamId ? ' with the team' : ''}`,
        ref_kind: 'check_in',
        ref_id: inserted.id,
        actor_account_id: actor,
      })
      .execute();
    if (teamId) {
      // The first check-in of the day puts the team on the board as available (DSP-01).
      const others = await trx
        .selectFrom('cg.check_in')
        .select('id')
        .where('team_id', '=', teamId)
        .where('ended_at', 'is', null)
        .where('id', '<>', inserted.id)
        .executeTakeFirst();
      if (!others)
        await trx
          .insertInto('cg.team_status')
          .values({
            tenant_id: person.tenant_id,
            team_id: teamId,
            status: 'available',
            fact: 'confirmed',
            source: b.method === 'net_control' ? 'net_control' : 'app',
            set_by_account_id: actor,
            check_in_id: inserted.id,
            note: 'Checked in',
          })
          .execute();
    }
    return inserted;
  }

  app.post(
    '/check-ins',
    {
      schema: {
        tags: ['roster'],
        body: z.object({
          eventCode: z.string().min(3).max(40).optional(),
          eventId: z.uuid().optional(),
          teamId: z.uuid().optional(),
          deviceId: z.uuid().optional(),
          locationSharing: z.boolean().default(true),
          /** Set by a coordinator or net control for someone else; the caller checks themself in otherwise. */
          personnelId: z.uuid().optional(),
          method: z.enum(['qr', 'event_code', 'net_control', 'console']).default('event_code'),
        }),
        response: { 201: checkInOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      if (!b.eventCode && !b.eventId)
        throw errors.validation([{ name: 'eventCode', message: 'the event code or id is needed' }]);
      let person: { id: string; tenant_id: string };
      if (b.personnelId) {
        await request.authorize('check_in.manage', { type: 'check_in', tenantId: s.tenantId });
        const p = await request.tx((trx) =>
          trx
            .selectFrom('cg.personnel')
            .select(['id', 'tenant_id', 'status'])
            .where('id', '=', b.personnelId!)
            .executeTakeFirst(),
        );
        if (!p || p.status !== 'active')
          throw errors.validation([
            { name: 'personnelId', message: 'no active person with that id' },
          ]);
        person = p;
      } else {
        await request.authorize('check_in.create', { type: 'check_in', tenantId: s.tenantId });
        person = await ownPersonnel(request);
      }
      const row = await request.tx(async (trx) => {
        const inserted = await startCheckIn(request, trx, person, b, s.accountId);
        await request.audit(trx, {
          tenantId: person.tenant_id,
          action: b.personnelId ? 'check_in.manage' : 'check_in.create',
          targetType: 'check_in',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'personnel', to: person.id },
              { name: 'team', to: inserted.team_id },
              { name: 'method', to: b.method },
            ],
          },
        });
        return inserted;
      });
      return reply.code(201).send(toCheckIn(row));
    },
  );

  app.get(
    '/check-ins',
    {
      schema: {
        tags: ['roster'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          teamId: z.uuid().optional(),
          open: z.coerce.boolean().optional(),
          mine: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(checkInOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const q = request.query;
      if (q.mine) {
        await request.authorize('me.read', { type: 'account', tenantId: s.tenantId });
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.check_in as c')
            .innerJoin('cg.personnel as p', 'p.id', 'c.personnel_id')
            .selectAll('c')
            .select('p.name as personnel_name')
            .where('p.account_id', '=', s.accountId)
            .orderBy('c.started_at', 'desc')
            .limit(q.limit)
            .execute(),
        );
        return rows.map(toCheckIn);
      }
      await request.authorize('check_in.read', { type: 'check_in', tenantId: s.tenantId });
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.check_in as c')
          .innerJoin('cg.personnel as p', 'p.id', 'c.personnel_id')
          .selectAll('c')
          .select('p.name as personnel_name')
          .orderBy('c.started_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('c.event_id', '=', q.eventId);
        if (q.teamId) x = x.where('c.team_id', '=', q.teamId);
        if (q.open) x = x.where('c.ended_at', 'is', null);
        return x.execute();
      });
      return rows.map(toCheckIn);
    },
  );

  app.post(
    '/check-ins/:id/end',
    {
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z
          .object({
            reason: z
              .enum(['checked_out', 'shift_end', 'coordinator', 'timeout', 'wipe'])
              .default('checked_out'),
          })
          .optional(),
        response: { 200: checkInOut },
      },
    },
    async (request) => {
      const s = account(request);
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.check_in')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      const mine = await request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .select('id')
          .where('id', '=', current.personnel_id)
          .where('account_id', '=', s.accountId)
          .executeTakeFirst(),
      );
      await request.authorize(
        mine ? 'check_in.end' : 'check_in.manage',
        { type: 'check_in', id: current.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      if (current.ended_at)
        throw errors.validation([{ name: 'id', message: 'already checked out' }]);
      const row = await request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cg.check_in')
          .set({
            ended_at: new Date(),
            ended_by: s.accountId,
            end_reason: request.body?.reason ?? 'checked_out',
          })
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('cg.personnel')
          .set({ duty_status: 'off_duty', updated_by: s.accountId })
          .where('id', '=', current.personnel_id)
          .execute();
        await trx
          .insertInto('cg.activity_entry')
          .values({
            tenant_id: current.tenant_id,
            event_id: current.event_id,
            personnel_id: current.personnel_id,
            team_id: current.team_id,
            kind: 'check_out',
            summary: `Checked out (${updated.end_reason}); ${updated.hours ?? '0'} h on shift`,
            ref_kind: 'check_in',
            ref_id: current.id,
            actor_account_id: s.accountId,
          })
          .execute();
        if (current.team_id) {
          const others = await trx
            .selectFrom('cg.check_in')
            .select('id')
            .where('team_id', '=', current.team_id)
            .where('ended_at', 'is', null)
            .executeTakeFirst();
          if (!others)
            await trx
              .insertInto('cg.team_status')
              .values({
                tenant_id: current.tenant_id,
                team_id: current.team_id,
                status: 'out_of_service',
                fact: 'confirmed',
                source: 'app',
                set_by_account_id: s.accountId,
                note: 'Everyone checked out',
              })
              .execute();
        }
        await request.audit(trx, {
          tenantId: current.tenant_id,
          action: mine ? 'check_in.end' : 'check_in.manage',
          targetType: 'check_in',
          targetId: current.id,
          changes: {
            fields: [
              { name: 'ended', to: updated.end_reason },
              { name: 'hours', to: updated.hours },
            ],
          },
        });
        return updated;
      });
      return toCheckIn(row);
    },
  );

  // --------------------------------------------------------------- devices
  const toDevice = (d: Selectable<Database['cg.field_device']>): z.infer<typeof deviceOut> => ({
    id: d.id,
    version: d.version,
    createdAt: iso(d.created_at)!,
    updatedAt: iso(d.updated_at)!,
    accountId: d.account_id,
    installId: d.install_id,
    platform: d.platform,
    managed: d.managed,
    model: d.model,
    appVersion: d.app_version,
    status: d.status,
    registeredAt: iso(d.registered_at)!,
    lastContactAt: iso(d.last_contact_at),
    wipeRequestedAt: iso(d.wipe_requested_at),
    wipeConfirmedAt: iso(d.wipe_confirmed_at),
    wipeRequired: d.status === 'wipe_requested' || d.status === 'revoked',
  });

  app.post(
    '/devices',
    {
      schema: {
        tags: ['roster'],
        body: z.object({
          installId: z.string().min(8).max(120),
          platform: z.enum(['ios', 'android', 'web']),
          managed: z.boolean().default(false),
          model: z.string().max(120).optional(),
          appVersion: z.string().max(40).optional(),
        }),
        response: { 200: deviceOut, 201: deviceOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('device.register', { type: 'field_device', tenantId: s.tenantId });
      const b = request.body;
      const { row, created } = await request.tx(async (trx) => {
        const existing = await trx
          .selectFrom('cg.field_device')
          .selectAll()
          .where('install_id', '=', b.installId)
          .executeTakeFirst();
        if (existing) {
          if (existing.account_id !== s.accountId)
            throw errors.validation([
              {
                name: 'installId',
                message: 'this install belongs to another account; sign out there first',
              },
            ]);
          const updated = await trx
            .updateTable('cg.field_device')
            .set({
              platform: b.platform,
              managed: b.managed,
              model: b.model ?? existing.model,
              app_version: b.appVersion ?? existing.app_version,
              last_contact_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return { row: updated, created: false };
        }
        const inserted = await trx
          .insertInto('cg.field_device')
          .values({
            tenant_id: s.tenantId,
            account_id: s.accountId,
            install_id: b.installId,
            platform: b.platform,
            managed: b.managed,
            model: b.model ?? null,
            app_version: b.appVersion ?? null,
            last_contact_at: new Date(),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'device.register',
          targetType: 'field_device',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'platform', to: b.platform },
              { name: 'managed', to: b.managed },
            ],
          },
        });
        return { row: inserted, created: true };
      });
      return reply.code(created ? 201 : 200).send(toDevice(row));
    },
  );

  app.get(
    '/devices',
    {
      schema: {
        tags: ['roster'],
        querystring: listQuery.extend({
          accountId: z.uuid().optional(),
          status: z.enum(['active', 'wipe_requested', 'wiped', 'revoked']).optional(),
        }),
        response: { 200: z.array(deviceOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('device.read', { type: 'field_device', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.field_device')
          .selectAll()
          .orderBy('last_contact_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.accountId) x = x.where('account_id', '=', q.accountId);
        if (q.status) x = x.where('status', '=', q.status);
        return x.execute();
      });
      return rows.map(toDevice);
    },
  );

  app.post(
    '/devices/:id/wipe',
    { schema: { tags: ['roster'], params: uuidParam, response: { 200: deviceOut } } },
    async (request) => {
      const s = account(request);
      const d = await request.tx((trx) =>
        trx
          .selectFrom('cg.field_device')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!d) throw errors.notFound();
      await request.authorize(
        'device.wipe',
        { type: 'field_device', id: d.id, tenantId: d.tenant_id },
        { asNotFound: true },
      );
      const reason = request.confirmation().reason!;
      const row = await request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cg.field_device')
          .set({
            status: 'wipe_requested',
            wipe_requested_at: new Date(),
            wipe_requested_by: s.accountId,
            wipe_reason: reason,
            updated_by: s.accountId,
          })
          .where('id', '=', d.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        // FLD-14: the person's open shift ends with the wipe, so positions stop and resident details leave the phone.
        await trx
          .updateTable('cg.check_in')
          .set({ ended_at: new Date(), ended_by: s.accountId, end_reason: 'wipe' })
          .where('device_id', '=', d.id)
          .where('ended_at', 'is', null)
          .execute();
        await request.audit(trx, {
          tenantId: d.tenant_id,
          action: 'device.wipe',
          targetType: 'field_device',
          targetId: d.id,
          reason,
          changes: { fields: [{ name: 'status', from: d.status, to: 'wipe_requested' }] },
        });
        return updated;
      });
      return toDevice(row);
    },
  );

  /** The app confirms the wipe (or reports a lost device) on its own behalf (FLD-02). */
  app.post(
    '/devices/:id/confirm',
    {
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object({ wiped: z.boolean() }),
        response: { 200: deviceOut },
      },
    },
    async (request) => {
      const s = account(request);
      const d = await request.tx((trx) =>
        trx
          .selectFrom('cg.field_device')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!d || d.account_id !== s.accountId) throw errors.notFound();
      await request.authorize('device.register', {
        type: 'field_device',
        id: d.id,
        tenantId: d.tenant_id,
      });
      const row = await request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cg.field_device')
          .set({
            ...(request.body.wiped ? { status: 'wiped', wipe_confirmed_at: new Date() } : {}),
            last_contact_at: new Date(),
            updated_by: s.accountId,
          })
          .where('id', '=', d.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (request.body.wiped)
          await request.audit(trx, {
            tenantId: d.tenant_id,
            action: 'device.register',
            targetType: 'field_device',
            targetId: d.id,
            changes: { fields: [{ name: 'status', from: d.status, to: 'wiped' }] },
          });
        return updated;
      });
      return toDevice(row);
    },
  );

  // ------------------------------------------------------------- positions
  const positionIn = z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000).optional(),
    speedMps: z.number().min(0).optional(),
    heading: z.number().min(0).max(360).optional(),
    recordedAt: z.iso.datetime(),
  });

  /** DSP-08: positions are accepted only from a person with an open check-in that shares location. */
  app.post(
    '/positions',
    {
      schema: {
        tags: ['roster'],
        body: z.object({
          positions: z.array(positionIn).min(1).max(500),
          deviceId: z.uuid().optional(),
          source: z.enum(['app', 'manual']).default('app'),
        }),
        response: {
          202: z.object({
            accepted: z.number().int(),
            rejected: z.number().int(),
            checkInId: z.uuid(),
          }),
        },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('position.record', { type: 'position', tenantId: s.tenantId });
      const person = await ownPersonnel(request);
      const result = await request.tx(async (trx) => {
        const open = await trx
          .selectFrom('cg.check_in')
          .select(['id', 'team_id', 'location_sharing'])
          .where('personnel_id', '=', person.id)
          .where('ended_at', 'is', null)
          .executeTakeFirst();
        if (!open)
          throw new ApiError(409, 'not_checked_in', 'Positions are shared only while checked in.');
        if (!open.location_sharing)
          throw new ApiError(
            409,
            'location_sharing_off',
            'Location sharing is off for this shift.',
          );
        let accepted = 0;
        let rejected = 0;
        for (const p of request.body.positions) {
          // FR-03.03: 0,0 is never a position; a fix older than the shift or in the future is refused.
          const at = new Date(p.recordedAt);
          if (
            (p.lat === 0 && p.lon === 0) ||
            at.getTime() > Date.now() + 5 * 60_000 ||
            Number.isNaN(at.getTime())
          ) {
            rejected += 1;
            continue;
          }
          await sql`select cg.ensure_position_partition(${at.toISOString().slice(0, 10)}::date)`.execute(
            trx,
          );
          await trx
            .insertInto('cg.position')
            .values({
              tenant_id: person.tenant_id,
              check_in_id: open.id,
              personnel_id: person.id,
              team_id: open.team_id,
              geom: sql`ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)`,
              accuracy_m: p.accuracyM ?? null,
              speed_mps: p.speedMps ?? null,
              heading: p.heading ?? null,
              source: request.body.source,
              recorded_at: at,
            })
            .execute();
          accepted += 1;
        }
        if (request.body.deviceId)
          await trx
            .updateTable('cg.field_device')
            .set({ last_contact_at: new Date() })
            .where('id', '=', request.body.deviceId)
            .where('account_id', '=', s.accountId)
            .execute();
        // One feed row per batch, not per fix, so the board learns the team moved (ADR-0022, 0036).
        if (accepted > 0)
          await trx
            .insertInto('cg.change_feed')
            .values({
              tenant_id: person.tenant_id,
              scope_kind: open.team_id ? 'team' : 'person',
              scope_id: open.team_id ?? person.id,
              record_type: 'position',
              record_id: open.team_id ?? person.id,
              record_version: null,
              op: 'upsert',
            })
            .execute();
        return { accepted, rejected, checkInId: open.id };
      });
      return reply.code(202).send(result);
    },
  );

  /** Rounds a coordinate to a grid of `metres` (0 = exact), the tenant's precision for this role (DSP-08). */
  function roundTo(lat: number, lon: number, metres: number): { lat: number; lon: number } {
    if (metres <= 0) return { lat, lon };
    const dLat = metres / 111_320;
    const dLon = metres / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
    return { lat: Math.round(lat / dLat) * dLat, lon: Math.round(lon / dLon) * dLon };
  }

  app.get(
    '/positions/latest',
    {
      schema: {
        tags: ['roster'],
        querystring: z.object({
          eventId: z.uuid().optional(),
          teamId: z.uuid().optional(),
          staleMinutes: z.coerce.number().int().min(1).max(1440).default(15),
        }),
        response: { 200: z.array(positionOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('position.read', { type: 'position', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx(async (trx) => {
        const precision =
          Number((await configValue<number | string>(trx, 'field.position_precision_m')) ?? 0) || 0;
        let x = trx
          .selectFrom('cg.position as p')
          .innerJoin('cg.check_in as c', 'c.id', 'p.check_in_id')
          .select([
            'p.personnel_id',
            'p.team_id',
            'p.check_in_id',
            'p.accuracy_m',
            'p.recorded_at',
            'p.source',
            sql<number>`ST_Y(p.geom)`.as('lat'),
            sql<number>`ST_X(p.geom)`.as('lon'),
          ])
          .distinctOn('p.check_in_id')
          .where('c.ended_at', 'is', null)
          .where('c.location_sharing', '=', true)
          .orderBy('p.check_in_id')
          .orderBy('p.recorded_at', 'desc');
        if (q.eventId) x = x.where('c.event_id', '=', q.eventId);
        if (q.teamId) x = x.where('p.team_id', '=', q.teamId);
        const list = await x.execute();
        return list.map((r) => {
          const rounded = roundTo(Number(r.lat), Number(r.lon), precision);
          return {
            personnelId: r.personnel_id,
            teamId: r.team_id,
            checkInId: r.check_in_id,
            lat: rounded.lat,
            lon: rounded.lon,
            accuracyM: precision > 0 ? Math.max(r.accuracy_m ?? 0, precision) : r.accuracy_m,
            recordedAt: iso(r.recorded_at)!,
            source: r.source,
            precisionM: precision,
            stale: Date.now() - new Date(r.recorded_at).getTime() > q.staleMinutes * 60_000,
          };
        });
      });
      return rows;
    },
  );

  // ---------------------------------------------------------- safety alerts
  const toAlert = (
    a: AlertRow & { lat?: number | null; lon?: number | null },
  ): z.infer<typeof alertOut> => ({
    id: a.id,
    version: a.version,
    createdAt: iso(a.created_at)!,
    updatedAt: iso(a.updated_at)!,
    eventId: a.event_id,
    kind: a.kind,
    personnelId: a.personnel_id,
    teamId: a.team_id,
    checkInId: a.check_in_id,
    assignmentId: a.assignment_id,
    hazardId: a.hazard_id,
    position:
      a.lat !== null && a.lat !== undefined && a.lon !== null && a.lon !== undefined
        ? {
            lat: Number(a.lat),
            lon: Number(a.lon),
            accuracyM: a.accuracy_m,
            at: iso(a.position_at),
          }
        : null,
    note: a.note,
    state: a.state,
    raisedAt: iso(a.raised_at)!,
    raisedBy: a.raised_by,
    acknowledgedAt: iso(a.acknowledged_at),
    acknowledgedBy: a.acknowledged_by,
    escalatedAt: iso(a.escalated_at),
    resolvedAt: iso(a.resolved_at),
    resolution: a.resolution,
  });
  const alertQuery = (trx: Trx) =>
    trx
      .selectFrom('cg.safety_alert')
      .selectAll()
      .select([sql<number | null>`ST_Y(geom)`.as('lat'), sql<number | null>`ST_X(geom)`.as('lon')]);

  /** FLD-16, plan §12.1: the help button carries the exact position whatever the precision setting; queued on the phone with a client id so a resend changes nothing. */
  app.post(
    '/safety-alerts',
    {
      schema: {
        tags: ['roster'],
        body: z.object({
          kind: z.enum(['help_button', 'hazard_entry', 'device_lost']).default('help_button'),
          clientUuid: z.uuid(),
          position: z
            .object({
              lat: z.number(),
              lon: z.number(),
              accuracyM: z.number().optional(),
              at: z.iso.datetime().optional(),
            })
            .optional(),
          note: z.string().max(500).optional(),
          hazardId: z.uuid().optional(),
        }),
        response: { 201: alertOut, 200: alertOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('safety_alert.raise', { type: 'safety_alert', tenantId: s.tenantId });
      const person = await ownPersonnel(request);
      const b = request.body;
      const { row, created } = await request.tx(async (trx) => {
        const existing = await alertQuery(trx)
          .where('client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (existing) return { row: existing, created: false };
        const open = await trx
          .selectFrom('cg.check_in')
          .select(['id', 'team_id', 'event_id'])
          .where('personnel_id', '=', person.id)
          .where('ended_at', 'is', null)
          .executeTakeFirst();
        const event =
          open?.event_id ??
          (
            await trx
              .selectFrom('cg.event')
              .select('id')
              .where('status', '=', 'active')
              .orderBy('opened_at', 'desc')
              .executeTakeFirst()
          )?.id;
        if (!event) throw errors.validation([{ name: 'event', message: 'no active event' }]);
        const inserted = await trx
          .insertInto('cg.safety_alert')
          .values({
            tenant_id: person.tenant_id,
            event_id: event,
            kind: b.kind,
            personnel_id: person.id,
            team_id: open?.team_id ?? null,
            check_in_id: open?.id ?? null,
            hazard_id: b.hazardId ?? null,
            geom: b.position
              ? sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`
              : null,
            accuracy_m: b.position?.accuracyM ?? null,
            position_at: b.position?.at ? new Date(b.position.at) : b.position ? new Date() : null,
            note: b.note ?? null,
            raised_by: s.accountId,
            client_uuid: b.clientUuid,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.activity_entry')
          .values({
            tenant_id: person.tenant_id,
            event_id: event,
            personnel_id: person.id,
            team_id: open?.team_id ?? null,
            kind: 'alert',
            summary: `${b.kind.replace(/_/g, ' ')} alert raised${b.note ? `: ${b.note}` : ''}`,
            ref_kind: 'safety_alert',
            ref_id: inserted.id,
            actor_account_id: s.accountId,
          })
          .execute();
        await trx
          .insertInto('cg.significant_event')
          .values({
            tenant_id: person.tenant_id,
            event_id: event,
            kind: 'safety_alert',
            summary: `${person.name}: ${b.kind.replace(/_/g, ' ')} alert`,
            team_id: open?.team_id ?? null,
            ref_kind: 'safety_alert',
            ref_id: inserted.id,
            actor_account_id: s.accountId,
          })
          .execute();
        await request.audit(trx, {
          tenantId: person.tenant_id,
          action: 'safety_alert.raise',
          targetType: 'safety_alert',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'kind', to: b.kind },
              { name: 'team', to: open?.team_id ?? null },
            ],
          },
        });
        return {
          row: await alertQuery(trx).where('id', '=', inserted.id).executeTakeFirstOrThrow(),
          created: true,
        };
      });
      return reply.code(created ? 201 : 200).send(toAlert(row));
    },
  );

  app.get(
    '/safety-alerts',
    {
      schema: {
        tags: ['roster'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          open: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(alertOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('safety_alert.read', { type: 'safety_alert', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = alertQuery(trx).orderBy('raised_at', 'desc').limit(q.limit).offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.open) x = x.where('state', 'in', ['open', 'acknowledged', 'escalated']);
        return x.execute();
      });
      return rows.map(toAlert);
    },
  );

  async function alertAction(
    request: FastifyRequest,
    action: 'safety_alert.acknowledge' | 'safety_alert.resolve',
  ) {
    const s = account(request);
    const { id } = request.params as { id: string };
    const expected = request.expectedVersion();
    const current = await request.tx((trx) =>
      alertQuery(trx).where('id', '=', id).executeTakeFirst(),
    );
    if (!current) throw errors.notFound();
    await request.authorize(
      action,
      { type: 'safety_alert', id: current.id, tenantId: current.tenant_id },
      { asNotFound: true },
    );
    const body = (request.body ?? {}) as {
      resolution?: string;
      falseAlarm?: boolean;
      escalate?: boolean;
    };
    const reason = request.confirmation().reason;
    const row = await request.tx(async (trx) => {
      const set =
        action === 'safety_alert.acknowledge'
          ? body.escalate
            ? {
                state: 'escalated' as const,
                escalated_at: new Date(),
                escalated_to_role: 'safety_officer',
                acknowledged_at: current.acknowledged_at ?? new Date(),
                acknowledged_by: current.acknowledged_by ?? s.accountId,
              }
            : {
                state: 'acknowledged' as const,
                acknowledged_at: new Date(),
                acknowledged_by: s.accountId,
              }
          : {
              state: body.falseAlarm ? ('false_alarm' as const) : ('resolved' as const),
              resolved_at: new Date(),
              resolved_by: s.accountId,
              resolution: body.resolution ?? reason ?? null,
            };
      const updated = assertUpdated(
        await trx
          .updateTable('cg.safety_alert')
          .set({ ...set, updated_by: s.accountId })
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst(),
        toAlert(current),
      );
      await trx
        .insertInto('cg.activity_entry')
        .values({
          tenant_id: current.tenant_id,
          event_id: current.event_id,
          personnel_id: current.personnel_id,
          team_id: current.team_id,
          kind: 'alert',
          summary: `Alert ${updated.state.replace('_', ' ')}${updated.resolution ? `: ${updated.resolution}` : ''}`,
          ref_kind: 'safety_alert',
          ref_id: current.id,
          actor_account_id: s.accountId,
        })
        .execute();
      await request.audit(trx, {
        tenantId: current.tenant_id,
        action,
        targetType: 'safety_alert',
        targetId: current.id,
        targetVersion: updated.version,
        reason: reason ?? null,
        changes: { fields: [{ name: 'state', from: current.state, to: updated.state }] },
      });
      return alertQuery(trx).where('id', '=', current.id).executeTakeFirstOrThrow();
    });
    return toAlert(row);
  }

  app.post(
    '/safety-alerts/:id/acknowledge',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z.object({ escalate: z.boolean().default(false) }).optional(),
        response: { 200: alertOut },
      },
    },
    (request) => alertAction(request, 'safety_alert.acknowledge'),
  );
  app.post(
    '/safety-alerts/:id/resolve',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['roster'],
        params: uuidParam,
        body: z
          .object({
            resolution: z.string().max(500).optional(),
            falseAlarm: z.boolean().default(false),
          })
          .optional(),
        response: { 200: alertOut },
      },
    },
    (request) => alertAction(request, 'safety_alert.resolve'),
  );
};
