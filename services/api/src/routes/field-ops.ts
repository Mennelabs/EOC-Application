/**
 * Field operations beyond missions and the roster (layer-4 plan §3, task E;
 * HAZ-01, BRD:FR-04.01–04.05, AC-04A/B/C, FLD-11; DSP-06, FL:FR-17.05;
 * REM-01, BRD:FR-09.01–09.06, AC-09A/B/C; BDG-01, BDG-02, BRD:FR-13.01–13.06,
 * AC-13A/B/C, RULE-11, FL:FR-03; DSP-10, DSP-11, FLD-17):
 * - hazards with reported, confirmed, corrected and cleared kept apart, an
 *   AI suggestion unverified until a person accepts it, restricted details
 *   encrypted and masked by category, history kept on clearing;
 * - messages to a person, team, agency, area or the whole event with a
 *   receipt per recipient (delivered, read, acknowledged from the app) and a
 *   text fallback for people without a recent app contact, through the
 *   message pipeline that keeps provider evidence;
 * - reminders (F09): shared state with owner and due time, snooze, reset,
 *   acknowledge apart from complete, completion only against a persisted
 *   update, history, escalation configuration;
 * - badges with an access label apart from permissions, a state per fact
 *   (generated ≠ print requested ≠ print confirmed ≠ failed ≠ handed out), a
 *   hashed code, revocation visible to verification, and a checkpoint check
 *   that answers valid, expired, revoked or unknown with name, agency and
 *   label only;
 * - net control's ICS 309 log, where a status or position heard lands on
 *   the team; the ICS 214 activity entries and the significant events log.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Insertable, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { FieldDescriptor } from '@cg/authz';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { configValue } from '../public/submit.ts';
import {
  classifierFor,
  enqueueOutbox,
  iso,
  listQuery,
  occurredAtOf,
  stamped,
  uuidParam,
} from './helpers.ts';

type Trx = Transaction<Database>;
type HazardRow = Selectable<Database['cg.hazard']>;
type ReminderRow = Selectable<Database['cg.reminder']>;
type BadgeRow = Selectable<Database['cg.badge']>;

const hazardKinds = [
  'downed_line',
  'gas_leak',
  'blocked_road',
  'unsafe_structure',
  'flooding',
  'debris',
  'weapons',
  'hazmat',
  'medical_emergency',
  'mental_health_crisis',
  'violence',
  'child_or_elder_involved',
  'language_barrier',
  'utility_risk',
  'weather',
  'public_health',
  'animal',
  'missing_person_concern',
  'other',
] as const;
const hazardStates = ['reported', 'confirmed', 'corrected', 'cleared'] as const;
const severities = ['info', 'caution', 'danger', 'critical'] as const;
const reminderKinds = [
  'call_back',
  'site_reconfirm',
  'renew_agreement',
  'revisit',
  'follow_up',
  'check_in_timer',
  'custom',
] as const;
const reminderStates = ['active', 'overdue', 'acknowledged', 'completed', 'canceled'] as const;
const badgeStates = [
  'generated',
  'print_requested',
  'print_confirmed',
  'print_failed',
  'handed_out',
  'revoked',
  'expired',
  'replaced',
] as const;

const positionIn = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const HAZARD_FIELDS: FieldDescriptor[] = [
  { name: 'summary', category: 'basic', classification: 'sensitive' },
  // FR-04.04, AC-04C: behavioural-health and other sensitive hazard details are counseling-category.
  { name: 'details', category: 'counseling', classification: 'restricted' },
  { name: 'position', category: 'location_exact', classification: 'sensitive' },
];

const hazardOut = z.object({
  ...stamped,
  eventId: z.uuid(),
  missionId: z.uuid().nullable(),
  kind: z.enum(hazardKinds),
  state: z.enum(hazardStates),
  severity: z.enum(severities),
  summary: z.string().nullable(),
  restricted: z.boolean(),
  /** Present only for the counseling category (AC-04C). */
  details: z.string().nullable().optional(),
  position: positionIn.nullable(),
  radiusM: z.number().nullable(),
  source: z.string(),
  /** AC-04A: an AI suggestion stays unverified until a person accepts it. */
  aiSuggested: z.boolean(),
  unverified: z.boolean(),
  acceptedBy: z.uuid().nullable(),
  reportedAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime().nullable(),
  clearedAt: z.iso.datetime().nullable(),
  clearedReason: z.string().nullable(),
  history: z
    .array(
      z.object({
        kind: z.string(),
        fromState: z.string().nullable(),
        toState: z.string().nullable(),
        reason: z.string().nullable(),
        actorAccountId: z.uuid().nullable(),
        occurredAt: z.iso.datetime(),
      }),
    )
    .optional(),
});

const receiptOut = z.object({
  personnelId: z.uuid(),
  channel: z.string(),
  deliveredAt: z.iso.datetime().nullable(),
  readAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  smsMessageId: z.uuid().nullable(),
});
const messageOut = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  kind: z.string(),
  template: z.string().nullable(),
  body: z.string(),
  lang: z.string(),
  priority: z.string(),
  audience: z.object({
    kind: z.string(),
    personnelId: z.uuid().nullable(),
    teamId: z.uuid().nullable(),
    tenantId: z.uuid().nullable(),
  }),
  missionId: z.uuid().nullable(),
  hazardId: z.uuid().nullable(),
  requiresAck: z.boolean(),
  sentBy: z.uuid().nullable(),
  sentAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  recipientCount: z.number().int(),
  receipts: z.array(receiptOut).optional(),
  /** For the reader: their own receipt. */
  mine: receiptOut.nullable().optional(),
});

const reminderOut = z.object({
  ...stamped,
  eventId: z.uuid().nullable(),
  kind: z.enum(reminderKinds),
  title: z.string(),
  note: z.string().nullable(),
  ownerAccountId: z.uuid().nullable(),
  ownerTeamId: z.uuid().nullable(),
  missionId: z.uuid().nullable(),
  subject: z.object({ kind: z.string(), id: z.uuid() }).nullable(),
  dueAt: z.iso.datetime(),
  recurrence: z.enum(['daily', 'weekly']).nullable(),
  state: z.enum(reminderStates),
  /** FR-09.05: overdue is a state and a time, never a colour or a sound alone. */
  overdue: z.boolean(),
  snoozedUntil: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
  acknowledgedBy: z.uuid().nullable(),
  completedAt: z.iso.datetime().nullable(),
  completedBy: z.uuid().nullable(),
  completion: z.object({ kind: z.string(), id: z.uuid() }).nullable(),
  canceledAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  escalateToRole: z.string().nullable(),
  escalateAfterMinutes: z.number().int().nullable(),
  escalatedAt: z.iso.datetime().nullable(),
  history: z
    .array(
      z.object({
        kind: z.string(),
        actorAccountId: z.uuid().nullable(),
        detail: z.record(z.string(), z.unknown()),
        occurredAt: z.iso.datetime(),
      }),
    )
    .optional(),
});

const badgeOut = z.object({
  ...stamped,
  personnelId: z.uuid(),
  eventId: z.uuid().nullable(),
  template: z.string(),
  displayName: z.string(),
  agency: z.string().nullable(),
  roleLabel: z.string().nullable(),
  accessLabel: z.string().nullable(),
  photoKey: z.string().nullable(),
  credentials: z.array(z.string()),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  state: z.enum(badgeStates),
  /** Only on generation: the code printed on the badge; never stored in clear (BDG-01). */
  code: z.string().optional(),
  replacesBadgeId: z.uuid().nullable(),
  printRequestedAt: z.iso.datetime().nullable(),
  printConfirmedAt: z.iso.datetime().nullable(),
  printFailedReason: z.string().nullable(),
  handedOutAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokeReason: z.string().nullable(),
  history: z
    .array(
      z.object({
        kind: z.string(),
        actorAccountId: z.uuid().nullable(),
        detail: z.record(z.string(), z.unknown()),
        occurredAt: z.iso.datetime(),
      }),
    )
    .optional(),
});

const commsOut = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  net: z.string(),
  entryAt: z.iso.datetime(),
  fromStation: z.string().nullable(),
  toStation: z.string().nullable(),
  teamId: z.uuid().nullable(),
  kind: z.string(),
  message: z.string().nullable(),
  operatorAccountId: z.uuid().nullable(),
  teamStatusId: z.uuid().nullable(),
  positionRecordedAt: z.iso.datetime().nullable(),
});

const activityOut = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  personnelId: z.uuid().nullable(),
  teamId: z.uuid().nullable(),
  occurredAt: z.iso.datetime(),
  /** AC-08A: when the server recorded it (later than occurredAt for an entry made after the fact). */
  recordedAt: z.iso.datetime(),
  kind: z.string(),
  summary: z.string(),
  refKind: z.string().nullable(),
  refId: z.uuid().nullable(),
  actorAccountId: z.uuid().nullable(),
});
const significantOut = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime(),
  /** AC-08A: when the server recorded it (later than occurredAt for an entry made after the fact). */
  recordedAt: z.iso.datetime(),
  kind: z.string(),
  summary: z.string(),
  missionId: z.uuid().nullable(),
  teamId: z.uuid().nullable(),
  refKind: z.string().nullable(),
  refId: z.uuid().nullable(),
  actorAccountId: z.uuid().nullable(),
});

/** Badge codes: 12 unambiguous characters, hashed at rest; the clear code is on the badge only. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newBadgeCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}
export const hashCode = (tenantId: string, code: string): Buffer =>
  createHash('sha256')
    .update(`${tenantId}:${code.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`)
    .digest();

export const fieldOpsRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  async function activity(
    trx: Trx,
    tenantId: string,
    eventId: string,
    personnelId: string | null,
    teamId: string | null,
    kind: Database['cg.activity_entry']['kind'],
    summary: string,
    refKind: string,
    refId: string,
    actor: string | null,
  ): Promise<void> {
    if (!personnelId && !teamId) return;
    await trx
      .insertInto('cg.activity_entry')
      .values({
        tenant_id: tenantId,
        event_id: eventId,
        personnel_id: personnelId,
        team_id: teamId,
        kind,
        summary,
        ref_kind: refKind,
        ref_id: refId,
        actor_account_id: actor,
      })
      .execute();
  }
  async function significant(
    trx: Trx,
    tenantId: string,
    eventId: string,
    kind: Database['cg.significant_event']['kind'],
    summary: string,
    extra: { missionId?: string | null; teamId?: string | null; refKind?: string; refId?: string },
    actor: string | null,
  ): Promise<void> {
    await trx
      .insertInto('cg.significant_event')
      .values({
        tenant_id: tenantId,
        event_id: eventId,
        kind,
        summary,
        mission_id: extra.missionId ?? null,
        team_id: extra.teamId ?? null,
        ref_kind: extra.refKind ?? null,
        ref_id: extra.refId ?? null,
        actor_account_id: actor,
      })
      .execute();
  }

  // ---------------------------------------------------------------- hazards
  type HazardJoined = HazardRow & { lat: number | null; lon: number | null };
  const hazardQuery = (trx: Trx) =>
    trx
      .selectFrom('cg.hazard')
      .selectAll()
      .select([
        sql<number | null>`ST_Y(ST_Centroid(geom))`.as('lat'),
        sql<number | null>`ST_X(ST_Centroid(geom))`.as('lon'),
      ]);

  async function hazardToOut(
    trx: Trx,
    r: HazardJoined,
    fields: string[],
    withHistory = false,
  ): Promise<z.infer<typeof hazardOut>> {
    const out: z.infer<typeof hazardOut> = {
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      eventId: r.event_id,
      missionId: r.mission_id,
      kind: r.kind,
      state: r.state,
      severity: r.severity,
      summary: r.summary,
      restricted: r.restricted,
      position:
        r.lat !== null && r.lon !== null && fields.includes('position')
          ? { lat: Number(r.lat), lon: Number(r.lon) }
          : null,
      radiusM: r.radius_m,
      source: r.source,
      aiSuggested: r.ai_suggested,
      unverified: r.ai_suggested && !r.accepted_at,
      acceptedBy: r.accepted_by,
      reportedAt: iso(r.reported_at)!,
      confirmedAt: iso(r.confirmed_at),
      clearedAt: iso(r.cleared_at),
      clearedReason: r.cleared_reason,
    };
    if (fields.includes('details'))
      out.details = r.details_enc
        ? await app.fieldCrypto.decrypt(r.tenant_id, r.details_enc)
        : null;
    if (withHistory) {
      const h = await trx
        .selectFrom('cg.hazard_event')
        .selectAll()
        .where('hazard_id', '=', r.id)
        .orderBy('occurred_at')
        .execute();
      out.history = h.map((e) => ({
        kind: e.kind,
        fromState: e.from_state,
        toState: e.to_state,
        reason: e.reason,
        actorAccountId: e.actor_account_id,
        occurredAt: iso(e.occurred_at)!,
      }));
    }
    return out;
  }

  app.get(
    '/hazards',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          missionId: z.uuid().optional(),
          state: z.enum(hazardStates).optional(),
          open: z.coerce.boolean().optional(),
          near: z
            .string()
            .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+$/)
            .optional(),
        }),
        response: { 200: z.array(hazardOut) },
      },
    },
    async (request) => {
      const s = account(request);
      const decision = await request.authorize('hazard.read', {
        type: 'hazard',
        tenantId: s.tenantId,
        ...(request.query.eventId ? { eventId: request.query.eventId } : {}),
        fields: HAZARD_FIELDS,
      });
      const q = request.query;
      const rows = await request.tx(async (trx) => {
        let x = hazardQuery(trx)
          .orderBy('severity', 'desc')
          .orderBy('reported_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.missionId) x = x.where('mission_id', '=', q.missionId);
        if (q.state) x = x.where('state', '=', q.state);
        if (q.open) x = x.where('state', 'in', ['reported', 'confirmed', 'corrected']);
        if (q.near) {
          const [lat, lon, m] = q.near.split(',').map(Number) as [number, number, number];
          x = x.where(
            sql<boolean>`ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${m} + coalesce(radius_m, 0))`,
          );
        }
        const list = (await x.execute()) as HazardJoined[];
        if (decision.restrictedRead.length > 0 && list.some((h) => h.details_enc))
          await request.audit(trx, {
            action: 'hazard.read',
            targetType: 'hazard',
            targetId: list
              .filter((h) => h.details_enc)
              .map((h) => h.id)
              .join(','),
            classificationRead: decision.restrictedRead,
          });
        return Promise.all(list.map((h) => hazardToOut(trx, h, decision.fields)));
      });
      return rows;
    },
  );

  app.get(
    '/hazards/:id',
    { schema: { tags: ['field'], params: uuidParam, response: { 200: hazardOut } } },
    async (request) => {
      const s = account(request);
      const row = (await request.tx((trx) =>
        hazardQuery(trx).where('id', '=', request.params.id).executeTakeFirst(),
      )) as HazardJoined | undefined;
      if (!row) throw errors.notFound();
      const decision = await request.authorize(
        'hazard.read',
        {
          type: 'hazard',
          id: row.id,
          tenantId: s.tenantId,
          eventId: row.event_id,
          fields: HAZARD_FIELDS,
        },
        { asNotFound: true },
      );
      return request.tx(async (trx) => {
        if (decision.restrictedRead.length > 0 && row.details_enc)
          await request.audit(trx, {
            action: 'hazard.read',
            targetType: 'hazard',
            targetId: row.id,
            classificationRead: decision.restrictedRead,
          });
        return hazardToOut(trx, row, decision.fields, true);
      });
    },
  );

  const hazardBody = z.object({
    eventId: z.uuid(),
    missionId: z.uuid().optional(),
    kind: z.enum(hazardKinds),
    severity: z.enum(severities).default('caution'),
    summary: z.string().max(1000).optional(),
    /** Sensitive detail (behavioural health, violence): encrypted, counseling category (AC-04C). */
    details: z.string().max(4000).optional(),
    position: positionIn.optional(),
    radiusM: z.number().min(0).max(50_000).optional(),
    source: z
      .enum(['field', 'console', 'call', 'net_control', 'resident_report', 'ai_suggested'])
      .default('console'),
    photoId: z.uuid().optional(),
    clientUuid: z.uuid().optional(),
  });

  app.post(
    '/hazards',
    { schema: { tags: ['field'], body: hazardBody, response: { 201: hazardOut } } },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('hazard.report', {
        type: 'hazard',
        tenantId: s.tenantId,
        eventId: request.body.eventId,
      });
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const own = await trx
          .selectFrom('cg.personnel')
          .select('id')
          .where('account_id', '=', s.accountId)
          .executeTakeFirst();
        const inserted = await trx
          .insertInto('cg.hazard')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            mission_id: b.missionId ?? null,
            kind: b.kind,
            severity: b.severity,
            summary: b.summary ?? null,
            restricted:
              Boolean(b.details) ||
              ['mental_health_crisis', 'violence', 'weapons', 'child_or_elder_involved'].includes(
                b.kind,
              ),
            details_enc: b.details ? await app.fieldCrypto.encrypt(s.tenantId, b.details) : null,
            geom: b.position
              ? sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`
              : null,
            radius_m: b.radiusM ?? null,
            source: b.source,
            ai_suggested: b.source === 'ai_suggested',
            reported_by: s.accountId,
            reported_personnel_id: own?.id ?? null,
            photo_id: b.photoId ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.hazard_event')
          .values({
            tenant_id: s.tenantId,
            hazard_id: inserted.id,
            kind: 'reported',
            to_state: 'reported',
            actor_account_id: s.accountId,
            actor_personnel_id: own?.id ?? null,
          })
          .execute();
        if (b.missionId)
          await trx
            .insertInto('cg.mission_event')
            .values({
              tenant_id: s.tenantId,
              mission_id: b.missionId,
              kind: 'hazard',
              actor_account_id: s.accountId,
              detail: JSON.stringify({ hazardId: inserted.id, kind: b.kind, severity: b.severity }),
            })
            .execute();
        if (b.severity === 'danger' || b.severity === 'critical')
          await significant(
            trx,
            s.tenantId,
            b.eventId,
            'hazard',
            `${b.kind.replace(/_/g, ' ')} reported (${b.severity})${b.summary ? `: ${b.summary}` : ''}`,
            { missionId: b.missionId ?? null, refKind: 'hazard', refId: inserted.id },
            s.accountId,
          );
        await request.audit(trx, {
          action: 'hazard.report',
          targetType: 'hazard',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'kind', to: b.kind },
              { name: 'severity', to: b.severity },
              { name: 'source', to: b.source },
              { name: 'restricted_detail', to: Boolean(b.details) },
            ],
          },
        });
        return (await hazardQuery(trx)
          .where('id', '=', inserted.id)
          .executeTakeFirstOrThrow()) as HazardJoined;
      });
      return reply
        .code(201)
        .send(await request.tx((trx) => hazardToOut(trx, row, ['details', 'position'])));
    },
  );

  /** FR-04.03: reported, confirmed, corrected and cleared are different facts, each with its reason. */
  async function hazardTransition(
    request: FastifyRequest,
    action: 'hazard.confirm' | 'hazard.report' | 'hazard.clear',
    apply: (h: HazardJoined) => {
      set: Record<string, unknown>;
      kind: Database['cg.hazard_event']['kind'];
      to: (typeof hazardStates)[number];
      reason: string | null;
      detail?: Record<string, unknown>;
    },
  ) {
    const s = account(request);
    const { id } = request.params as { id: string };
    const expected = request.expectedVersion();
    const current = (await request.tx((trx) =>
      hazardQuery(trx).where('id', '=', id).executeTakeFirst(),
    )) as HazardJoined | undefined;
    if (!current) throw errors.notFound();
    await request.authorize(
      action,
      { type: 'hazard', id: current.id, tenantId: s.tenantId, eventId: current.event_id },
      { asNotFound: true },
    );
    const plan = apply(current);
    const row = await request.tx(async (trx) => {
      const updated = assertUpdated(
        await trx
          .updateTable('cg.hazard')
          .set({ ...plan.set, state: plan.to, updated_by: s.accountId } as never)
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst(),
        await hazardToOut(trx, current, []),
      );
      await trx
        .insertInto('cg.hazard_event')
        .values({
          tenant_id: s.tenantId,
          hazard_id: current.id,
          kind: plan.kind,
          from_state: current.state,
          to_state: plan.to,
          actor_account_id: s.accountId,
          reason: plan.reason,
          detail: JSON.stringify(plan.detail ?? {}),
        })
        .execute();
      await request.audit(trx, {
        action,
        targetType: 'hazard',
        targetId: current.id,
        targetVersion: updated.version,
        reason: plan.reason,
        changes: diffForAudit(
          { state: current.state, severity: current.severity },
          { state: updated.state, severity: updated.severity },
          classifierFor('hazard'),
        ),
      });
      const fresh = (await hazardQuery(trx)
        .where('id', '=', current.id)
        .executeTakeFirstOrThrow()) as HazardJoined;
      return hazardToOut(trx, fresh, ['position'], true);
    });
    return row;
  }

  app.post(
    '/hazards/:id/confirm',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z
          .object({ severity: z.enum(severities).optional(), note: z.string().max(500).optional() })
          .optional(),
        response: { 200: hazardOut },
      },
    },
    (request) =>
      hazardTransition(request, 'hazard.confirm', (h) => {
        if (h.state === 'cleared')
          throw errors.validation([
            { name: 'state', message: 'cleared; report it again if it is back' },
          ]);
        const b = request.body ?? {};
        const s = account(request);
        return {
          // AC-04A: accepting an AI suggestion is a person's confirmation; the flag stays as provenance.
          set: {
            confirmed_at: new Date(),
            confirmed_by: s.accountId,
            ...(h.ai_suggested && !h.accepted_at
              ? { accepted_at: new Date(), accepted_by: s.accountId }
              : {}),
            ...(b.severity ? { severity: b.severity } : {}),
          },
          kind: h.ai_suggested && !h.accepted_at ? 'accepted' : 'confirmed',
          to: 'confirmed',
          reason: b.note ?? null,
        };
      }),
  );

  app.post(
    '/hazards/:id/correct',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({
          kind: z.enum(hazardKinds).optional(),
          severity: z.enum(severities).optional(),
          summary: z.string().max(1000).optional(),
          position: positionIn.nullable().optional(),
          radiusM: z.number().min(0).optional(),
          reason: z.string().min(3).max(500),
        }),
        response: { 200: hazardOut },
      },
    },
    (request) =>
      hazardTransition(request, 'hazard.report', (h) => {
        if (h.state === 'cleared')
          throw errors.validation([
            { name: 'state', message: 'cleared hazards are not corrected; report again' },
          ]);
        const b = request.body;
        return {
          set: {
            ...(b.kind ? { kind: b.kind } : {}),
            ...(b.severity ? { severity: b.severity } : {}),
            ...(b.summary !== undefined ? { summary: b.summary } : {}),
            ...(b.position !== undefined
              ? {
                  geom: b.position
                    ? sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`
                    : null,
                }
              : {}),
            ...(b.radiusM !== undefined ? { radius_m: b.radiusM } : {}),
          },
          kind: 'corrected',
          to: 'corrected',
          reason: b.reason,
          detail: { from: { kind: h.kind, severity: h.severity, summary: h.summary } },
        };
      }),
  );

  app.post(
    '/hazards/:id/clear',
    {
      config: { requiresVersion: true },
      schema: { tags: ['field'], params: uuidParam, response: { 200: hazardOut } },
    },
    (request) =>
      hazardTransition(request, 'hazard.clear', (h) => {
        if (h.state === 'cleared')
          throw errors.validation([{ name: 'state', message: 'already cleared' }]);
        const reason = request.confirmation().reason!;
        // AC-04B: the original entry and its history stay; clearing adds its own fact and reason.
        return {
          set: {
            cleared_at: new Date(),
            cleared_by: account(request).accountId,
            cleared_reason: reason,
          },
          kind: 'cleared',
          to: 'cleared',
          reason,
        };
      }),
  );

  // -------------------------------------------------------- field messages
  type MessageRow = Selectable<Database['cg.field_message']>;
  type ReceiptRow = Selectable<Database['cg.field_message_receipt']>;
  const receiptToOut = (r: ReceiptRow): z.infer<typeof receiptOut> => ({
    personnelId: r.personnel_id,
    channel: r.channel,
    deliveredAt: iso(r.delivered_at),
    readAt: iso(r.read_at),
    acknowledgedAt: iso(r.acknowledged_at),
    smsMessageId: r.sms_message_id,
  });
  const messageToOut = (
    m: MessageRow,
    receipts?: ReceiptRow[],
    mine?: ReceiptRow | null,
  ): z.infer<typeof messageOut> => ({
    id: m.id,
    eventId: m.event_id,
    kind: m.kind,
    template: m.template,
    body: m.body,
    lang: m.lang,
    priority: m.priority,
    audience: {
      kind: m.audience_kind,
      personnelId: m.audience_personnel_id,
      teamId: m.audience_team_id,
      tenantId: m.audience_tenant_id,
    },
    missionId: m.mission_id,
    hazardId: m.hazard_id,
    requiresAck: m.requires_ack,
    sentBy: m.sent_by,
    sentAt: iso(m.sent_at)!,
    expiresAt: iso(m.expires_at),
    recipientCount: m.recipient_count,
    ...(receipts ? { receipts: receipts.map(receiptToOut) } : {}),
    ...(mine !== undefined ? { mine: mine ? receiptToOut(mine) : null } : {}),
  });

  /** Who a message reaches: the people checked in or on the team, in the agency, in the area, or the event's whole roster. */
  async function resolveAudience(
    trx: Trx,
    tenantId: string,
    eventId: string,
    b: {
      audience: {
        kind: 'person' | 'team' | 'agency' | 'area' | 'event';
        personnelId?: string | undefined;
        teamId?: string | undefined;
        tenantId?: string | undefined;
        area?: { lat: number; lon: number; radiusM: number } | undefined;
      };
    },
  ): Promise<string[]> {
    const a = b.audience;
    if (a.kind === 'person' && a.personnelId) return [a.personnelId];
    if (a.kind === 'team' && a.teamId) {
      const members = await trx
        .selectFrom('cg.team_member')
        .select('personnel_id')
        .where('team_id', '=', a.teamId)
        .where('left_at', 'is', null)
        .execute();
      return members.map((m) => m.personnel_id);
    }
    if (a.kind === 'agency' && a.tenantId) {
      const people = await trx
        .selectFrom('cg.check_in')
        .select('personnel_id')
        .distinct()
        .where('event_id', '=', eventId)
        .where('agency_tenant_id', '=', a.tenantId)
        .where('ended_at', 'is', null)
        .execute();
      return people.map((p) => p.personnel_id);
    }
    if (a.kind === 'area' && a.area) {
      const rows = await sql<{ personnel_id: string }>`
        select distinct on (p.check_in_id) p.personnel_id from cg.position p
        join cg.check_in c on c.id = p.check_in_id and c.ended_at is null and c.event_id = ${eventId}
        where p.recorded_at > now() - interval '2 hours'
          and ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint(${a.area.lon}, ${a.area.lat}), 4326)::geography, ${a.area.radiusM})
        order by p.check_in_id, p.recorded_at desc`.execute(trx);
      return rows.rows.map((r) => r.personnel_id);
    }
    const everyone = await trx
      .selectFrom('cg.check_in')
      .select('personnel_id')
      .distinct()
      .where('event_id', '=', eventId)
      .where('ended_at', 'is', null)
      .execute();
    return everyone.map((p) => p.personnel_id);
  }

  app.post(
    '/field-messages',
    {
      config: { idempotent: true },
      schema: {
        tags: ['field'],
        body: z.object({
          eventId: z.uuid(),
          kind: z
            .enum(['message', 'assignment_notice', 'safety_warning', 'hazard_warning', 'broadcast'])
            .default('message'),
          template: z.string().max(60).optional(),
          body: z.string().min(1).max(1000),
          lang: z.string().max(10).default('en'),
          priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
          audience: z.object({
            kind: z.enum(['person', 'team', 'agency', 'area', 'event']),
            personnelId: z.uuid().optional(),
            teamId: z.uuid().optional(),
            tenantId: z.uuid().optional(),
            area: z
              .object({ lat: z.number(), lon: z.number(), radiusM: z.number().min(10).max(50_000) })
              .optional(),
          }),
          missionId: z.uuid().optional(),
          hazardId: z.uuid().optional(),
          requiresAck: z.boolean().default(false),
          expiresAt: z.iso.datetime().optional(),
          /** DSP-06: people without a recent app contact get the text through the message pipeline. */
          textFallback: z.boolean().default(true),
        }),
        response: { 201: messageOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('field_message.send', {
        type: 'field_message',
        tenantId: s.tenantId,
        eventId: request.body.eventId,
      });
      const b = request.body;
      const recentContact =
        Number(
          (await request.tx((trx) =>
            configValue<number | string>(trx, 'field.app_contact_minutes'),
          )) ?? 30,
        ) || 30;
      const result = await request.tx(async (trx) => {
        const recipients = await resolveAudience(trx, s.tenantId, b.eventId, b);
        if (recipients.length === 0)
          throw errors.validation([
            { name: 'audience', message: 'nobody is reachable in that audience right now' },
          ]);
        const inserted = await trx
          .insertInto('cg.field_message')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            kind: b.kind,
            template: b.template ?? null,
            body: b.body,
            lang: b.lang,
            priority: b.priority,
            audience_kind: b.audience.kind,
            audience_personnel_id: b.audience.personnelId ?? null,
            audience_team_id: b.audience.teamId ?? null,
            audience_tenant_id: b.audience.tenantId ?? null,
            audience_geom: b.audience.area
              ? sql`ST_Buffer(ST_SetSRID(ST_MakePoint(${b.audience.area.lon}, ${b.audience.area.lat}), 4326)::geography, ${b.audience.area.radiusM})::geometry`
              : null,
            mission_id: b.missionId ?? null,
            hazard_id: b.hazardId ?? null,
            requires_ack: b.requiresAck,
            sent_by: s.accountId,
            expires_at: b.expiresAt ? new Date(b.expiresAt) : null,
            recipient_count: recipients.length,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const people = await trx
          .selectFrom('cg.personnel')
          .select(['id', 'account_id', 'contact_enc', 'name'])
          .where('id', 'in', recipients)
          .execute();
        const devices = await trx
          .selectFrom('cg.field_device')
          .select(['account_id', 'id'])
          .where(
            'account_id',
            'in',
            people
              .map((p) => p.account_id)
              .filter((x): x is string => Boolean(x))
              .concat(['00000000-0000-0000-0000-000000000000']),
          )
          .where('status', '=', 'active')
          .where('last_contact_at', '>', new Date(Date.now() - recentContact * 60_000))
          .execute();
        const tenant = await trx
          .selectFrom('cg.tenant')
          .select('name')
          .where('id', '=', s.tenantId)
          .executeTakeFirstOrThrow();
        const receipts: ReceiptRow[] = [];
        let texts = 0;
        for (const p of people) {
          const device = devices.find((d) => d.account_id === p.account_id);
          const viaApp = Boolean(device);
          let phone: string | null = null;
          if (!viaApp && b.textFallback && p.contact_enc) {
            const contact = JSON.parse(
              await app.fieldCrypto.decrypt(s.tenantId, p.contact_enc),
            ) as { phone?: string };
            phone = contact.phone ?? null;
          }
          const receipt = await trx
            .insertInto('cg.field_message_receipt')
            .values({
              tenant_id: s.tenantId,
              message_id: inserted.id,
              personnel_id: p.id,
              account_id: p.account_id,
              device_id: device?.id ?? null,
              channel: viaApp ? 'app' : phone ? 'sms' : 'app',
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          if (!viaApp && phone) {
            texts += 1;
            await enqueueOutbox(
              trx,
              s.tenantId,
              'message.send',
              {
                template: 'field_message',
                channel: 'sms',
                toEnc: (await app.fieldCrypto.encrypt(s.tenantId, phone)).toString('base64'),
                language: b.lang,
                fieldReceiptId: receipt.id,
                variables: { text: b.body, sender: tenant.name, county: tenant.name },
              },
              request.executionId,
            );
          }
          receipts.push(receipt);
          await activity(
            trx,
            s.tenantId,
            b.eventId,
            p.id,
            b.audience.teamId ?? null,
            'message',
            `Message ${viaApp ? 'to the app' : phone ? 'by text' : 'queued'}: ${b.body.slice(0, 80)}`,
            'field_message',
            inserted.id,
            s.accountId,
          );
        }
        if (b.priority === 'urgent' || b.kind === 'safety_warning' || b.kind === 'hazard_warning')
          await significant(
            trx,
            s.tenantId,
            b.eventId,
            'message',
            `${b.kind.replace(/_/g, ' ')} to ${b.audience.kind}: ${b.body.slice(0, 120)}`,
            {
              missionId: b.missionId ?? null,
              teamId: b.audience.teamId ?? null,
              refKind: 'field_message',
              refId: inserted.id,
            },
            s.accountId,
          );
        await request.audit(trx, {
          action: 'field_message.send',
          targetType: 'field_message',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'audience', to: b.audience.kind },
              { name: 'recipients', to: recipients.length },
              { name: 'texts', to: texts },
            ],
          },
        });
        return { message: inserted, receipts };
      });
      return reply.code(201).send(messageToOut(result.message, result.receipts));
    },
  );

  app.get(
    '/field-messages',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          mine: z.coerce.boolean().optional(),
          unread: z.coerce.boolean().optional(),
          teamId: z.uuid().optional(),
        }),
        response: { 200: z.array(messageOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('field_message.read', {
        type: 'field_message',
        tenantId: s.tenantId,
        ...(request.query.eventId ? { eventId: request.query.eventId } : {}),
      });
      const q = request.query;
      return request.tx(async (trx) => {
        if (q.mine) {
          const own = await trx
            .selectFrom('cg.personnel')
            .select('id')
            .where('account_id', '=', s.accountId)
            .executeTakeFirst();
          if (!own) return [];
          let x = trx
            .selectFrom('cg.field_message_receipt as r')
            .innerJoin('cg.field_message as m', 'm.id', 'r.message_id')
            .selectAll('m')
            .select(['r.id as receipt_id'])
            .where('r.personnel_id', '=', own.id)
            .orderBy('m.sent_at', 'desc')
            .limit(q.limit)
            .offset(q.offset);
          if (q.unread) x = x.where('r.read_at', 'is', null);
          if (q.eventId) x = x.where('m.event_id', '=', q.eventId);
          const rows = await x.execute();
          const receipts = rows.length
            ? await trx
                .selectFrom('cg.field_message_receipt')
                .selectAll()
                .where(
                  'id',
                  'in',
                  rows.map((r) => r.receipt_id),
                )
                .execute()
            : [];
          return rows.map((r) =>
            messageToOut(
              r as unknown as MessageRow,
              undefined,
              receipts.find((x) => x.id === r.receipt_id) ?? null,
            ),
          );
        }
        let x = trx
          .selectFrom('cg.field_message')
          .selectAll()
          .orderBy('sent_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.teamId) x = x.where('audience_team_id', '=', q.teamId);
        const rows = await x.execute();
        const receipts = rows.length
          ? await trx
              .selectFrom('cg.field_message_receipt')
              .selectAll()
              .where(
                'message_id',
                'in',
                rows.map((r) => r.id),
              )
              .execute()
          : [];
        return rows.map((m) =>
          messageToOut(
            m,
            receipts.filter((r) => r.message_id === m.id),
          ),
        );
      });
    },
  );

  /** From the app: delivered, read and acknowledged are the recipient's own facts (DSP-06). */
  app.post(
    '/field-messages/:id/receipt',
    {
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({
          delivered: z.boolean().optional(),
          read: z.boolean().optional(),
          acknowledged: z.boolean().optional(),
          deviceId: z.uuid().optional(),
        }),
        response: { 200: receiptOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('field_message.receipt', {
        type: 'field_message',
        id: request.params.id,
        tenantId: s.tenantId,
      });
      const row = await request.tx(async (trx) => {
        const own = await trx
          .selectFrom('cg.personnel')
          .select('id')
          .where('account_id', '=', s.accountId)
          .executeTakeFirst();
        if (!own) throw errors.notFound();
        const receipt = await trx
          .selectFrom('cg.field_message_receipt')
          .selectAll()
          .where('message_id', '=', request.params.id)
          .where('personnel_id', '=', own.id)
          .executeTakeFirst();
        if (!receipt) throw errors.notFound();
        const b = request.body;
        const now = new Date();
        const updated = await trx
          .updateTable('cg.field_message_receipt')
          .set({
            ...(b.delivered || b.read || b.acknowledged
              ? { delivered_at: receipt.delivered_at ?? now }
              : {}),
            ...(b.read || b.acknowledged ? { read_at: receipt.read_at ?? now } : {}),
            ...(b.acknowledged ? { acknowledged_at: receipt.acknowledged_at ?? now } : {}),
            ...(b.deviceId ? { device_id: b.deviceId } : {}),
          })
          .where('id', '=', receipt.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (b.deviceId)
          await trx
            .updateTable('cg.field_device')
            .set({ last_contact_at: now })
            .where('id', '=', b.deviceId)
            .where('account_id', '=', s.accountId)
            .execute();
        return updated;
      });
      return receiptToOut(row);
    },
  );

  // -------------------------------------------------------------- reminders
  async function reminderToOut(
    trx: Trx,
    r: ReminderRow,
    withHistory = false,
  ): Promise<z.infer<typeof reminderOut>> {
    const out: z.infer<typeof reminderOut> = {
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      eventId: r.event_id,
      kind: r.kind,
      title: r.title,
      note: r.note,
      ownerAccountId: r.owner_account_id,
      ownerTeamId: r.owner_team_id,
      missionId: r.mission_id,
      subject: r.subject_kind && r.subject_id ? { kind: r.subject_kind, id: r.subject_id } : null,
      dueAt: iso(r.due_at)!,
      recurrence: r.recurrence,
      state: r.state,
      overdue:
        r.state === 'overdue' ||
        (r.state === 'active' && !r.snoozed_until && new Date(r.due_at).getTime() < Date.now()) ||
        (r.state === 'active' &&
          !!r.snoozed_until &&
          new Date(r.snoozed_until).getTime() < Date.now()),
      snoozedUntil: iso(r.snoozed_until),
      acknowledgedAt: iso(r.acknowledged_at),
      acknowledgedBy: r.acknowledged_by,
      completedAt: iso(r.completed_at),
      completedBy: r.completed_by,
      completion:
        r.completion_ref_kind && r.completion_ref_id
          ? { kind: r.completion_ref_kind, id: r.completion_ref_id }
          : null,
      canceledAt: iso(r.canceled_at),
      cancelReason: r.cancel_reason,
      escalateToRole: r.escalate_to_role,
      escalateAfterMinutes: r.escalate_after_minutes,
      escalatedAt: iso(r.escalated_at),
    };
    if (withHistory) {
      const h = await trx
        .selectFrom('cg.reminder_event')
        .selectAll()
        .where('reminder_id', '=', r.id)
        .orderBy('occurred_at')
        .execute();
      out.history = h.map((e) => ({
        kind: e.kind,
        actorAccountId: e.actor_account_id,
        detail: (e.detail as Record<string, unknown>) ?? {},
        occurredAt: iso(e.occurred_at)!,
      }));
    }
    return out;
  }

  app.get(
    '/reminders',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          missionId: z.uuid().optional(),
          mine: z.coerce.boolean().optional(),
          open: z.coerce.boolean().optional(),
          overdue: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(reminderOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('reminder.read', { type: 'reminder', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.reminder')
          .selectAll()
          .orderBy('due_at')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.missionId) x = x.where('mission_id', '=', q.missionId);
        if (q.mine) x = x.where('owner_account_id', '=', s.accountId);
        if (q.open) x = x.where('state', 'in', ['active', 'overdue', 'acknowledged']);
        if (q.overdue) x = x.where('state', '=', 'overdue');
        const list = await x.execute();
        return Promise.all(list.map((r) => reminderToOut(trx, r)));
      });
      return rows;
    },
  );

  app.get(
    '/reminders/:id',
    { schema: { tags: ['field'], params: uuidParam, response: { 200: reminderOut } } },
    async (request) => {
      const s = account(request);
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.reminder')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      await request.authorize(
        'reminder.read',
        { type: 'reminder', id: row.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      return request.tx((trx) => reminderToOut(trx, row, true));
    },
  );

  app.post(
    '/reminders',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          eventId: z.uuid().optional(),
          kind: z.enum(reminderKinds).default('custom'),
          title: z.string().min(1).max(200),
          note: z.string().max(2000).optional(),
          ownerAccountId: z.uuid().optional(),
          ownerTeamId: z.uuid().optional(),
          missionId: z.uuid().optional(),
          subject: z.object({ kind: z.string().max(40), id: z.uuid() }).optional(),
          dueAt: z.iso.datetime(),
          /** FR-09.01: recurrence only where approved; the approver is recorded. */
          recurrence: z.enum(['daily', 'weekly']).optional(),
          escalateToRole: z.string().max(60).optional(),
          escalateAfterMinutes: z.number().int().min(1).max(10_080).optional(),
        }),
        response: { 201: reminderOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('reminder.manage', {
        type: 'reminder',
        tenantId: s.tenantId,
        ...(request.body.eventId ? { eventId: request.body.eventId } : {}),
      });
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.reminder')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId ?? null,
            kind: b.kind,
            title: b.title,
            note: b.note ?? null,
            owner_account_id: b.ownerAccountId ?? s.accountId,
            owner_team_id: b.ownerTeamId ?? null,
            mission_id: b.missionId ?? null,
            subject_kind: b.subject?.kind ?? null,
            subject_id: b.subject?.id ?? null,
            due_at: new Date(b.dueAt),
            recurrence: b.recurrence ?? null,
            recurrence_approved_by: b.recurrence ? s.accountId : null,
            escalate_to_role: b.escalateToRole ?? null,
            escalate_after_minutes: b.escalateAfterMinutes ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.reminder_event')
          .values({
            tenant_id: s.tenantId,
            reminder_id: inserted.id,
            kind: 'created',
            actor_account_id: s.accountId,
            detail: JSON.stringify({ dueAt: b.dueAt, recurrence: b.recurrence ?? null }),
          })
          .execute();
        if (b.missionId)
          await trx
            .insertInto('cg.mission_event')
            .values({
              tenant_id: s.tenantId,
              mission_id: b.missionId,
              kind: 'reminder',
              actor_account_id: s.accountId,
              detail: JSON.stringify({ reminderId: inserted.id, title: b.title, dueAt: b.dueAt }),
            })
            .execute();
        await request.audit(trx, {
          action: 'reminder.manage',
          targetType: 'reminder',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: {
            fields: [
              { name: 'kind', to: b.kind },
              { name: 'due_at', to: b.dueAt },
            ],
          },
        });
        return reminderToOut(trx, inserted);
      });
      return reply.code(201).send(row);
    },
  );

  /** FR-09.02: snooze, reset, cancel, acknowledge and complete, each with actor and history. */
  async function reminderAction(
    request: FastifyRequest,
    action: 'reminder.manage' | 'reminder.acknowledge' | 'reminder.complete',
    apply: (
      r: ReminderRow,
      trx: Trx,
    ) => Promise<{
      set: Record<string, unknown>;
      kind: Database['cg.reminder_event']['kind'];
      detail?: Record<string, unknown>;
      reason?: string | null;
    }>,
  ) {
    const s = account(request);
    const { id } = request.params as { id: string };
    const expected = request.expectedVersion();
    const current = await request.tx((trx) =>
      trx.selectFrom('cg.reminder').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!current) throw errors.notFound();
    await request.authorize(
      action,
      {
        type: 'reminder',
        id: current.id,
        tenantId: s.tenantId,
        ...(current.event_id ? { eventId: current.event_id } : {}),
      },
      { asNotFound: true },
    );
    if (current.state === 'completed' || current.state === 'canceled')
      throw errors.validation([{ name: 'state', message: `the reminder is ${current.state}` }]);
    return request.tx(async (trx) => {
      const plan = await apply(current, trx);
      // AC-09C: two people completing the same reminder: the second sees a version conflict, no second effect.
      const updated = assertUpdated(
        await trx
          .updateTable('cg.reminder')
          .set({ ...plan.set, updated_by: s.accountId } as never)
          .where('id', '=', current.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst(),
        await reminderToOut(trx, current),
      );
      await trx
        .insertInto('cg.reminder_event')
        .values({
          tenant_id: s.tenantId,
          reminder_id: current.id,
          kind: plan.kind,
          actor_account_id: s.accountId,
          detail: JSON.stringify(plan.detail ?? {}),
        })
        .execute();
      await request.audit(trx, {
        action,
        targetType: 'reminder',
        targetId: current.id,
        targetVersion: updated.version,
        reason: plan.reason ?? null,
        changes: diffForAudit(
          { state: current.state, due_at: current.due_at, snoozed_until: current.snoozed_until },
          { state: updated.state, due_at: updated.due_at, snoozed_until: updated.snoozed_until },
          classifierFor('reminder'),
        ),
      });
      return reminderToOut(trx, updated, true);
    });
  }

  app.post(
    '/reminders/:id/snooze',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({
          until: z.iso.datetime().optional(),
          minutes: z.number().int().min(1).max(10_080).optional(),
        }),
        response: { 200: reminderOut },
      },
    },
    (request) =>
      reminderAction(request, 'reminder.manage', async (r) => {
        const b = request.body;
        const until = b.until
          ? new Date(b.until)
          : new Date(
              Math.max(Date.now(), new Date(r.due_at).getTime()) + (b.minutes ?? 15) * 60_000,
            );
        return {
          set: { snoozed_until: until, state: 'active', escalated_at: null },
          kind: 'snoozed',
          detail: { until: until.toISOString() },
        };
      }),
  );
  app.post(
    '/reminders/:id/reset',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({ dueAt: z.iso.datetime() }),
        response: { 200: reminderOut },
      },
    },
    (request) =>
      reminderAction(request, 'reminder.manage', async () => ({
        set: {
          due_at: new Date(request.body.dueAt),
          snoozed_until: null,
          state: 'active',
          acknowledged_at: null,
          acknowledged_by: null,
          escalated_at: null,
        },
        kind: 'reset',
        detail: { dueAt: request.body.dueAt },
      })),
  );
  app.post(
    '/reminders/:id/cancel',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({ reason: z.string().min(3).max(500) }),
        response: { 200: reminderOut },
      },
    },
    (request) =>
      reminderAction(request, 'reminder.manage', async () => ({
        set: {
          state: 'canceled',
          canceled_at: new Date(),
          canceled_by: account(request).accountId,
          cancel_reason: request.body.reason,
        },
        kind: 'canceled',
        reason: request.body.reason,
      })),
  );
  /** FR-09.03: an acknowledgement is not a completion; the reminder stays open and visible. */
  app.post(
    '/reminders/:id/acknowledge',
    {
      config: { requiresVersion: true },
      schema: { tags: ['field'], params: uuidParam, response: { 200: reminderOut } },
    },
    (request) =>
      reminderAction(request, 'reminder.acknowledge', async () => ({
        set: {
          state: 'acknowledged',
          acknowledged_at: new Date(),
          acknowledged_by: account(request).accountId,
        },
        kind: 'acknowledged',
      })),
  );
  /** FR-09.04, AC-09B: completion names the persisted update it rests on; a missing one leaves the reminder open. */
  app.post(
    '/reminders/:id/complete',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({
          completion: z.object({
            kind: z.enum([
              'mission_event',
              'need_event',
              'site_confirmation',
              'canvass_visit',
              'note',
            ]),
            id: z.uuid().optional(),
            note: z.string().max(1000).optional(),
          }),
        }),
        response: { 200: reminderOut },
      },
    },
    (request) =>
      reminderAction(request, 'reminder.complete', async (r, trx) => {
        const c = request.body.completion;
        let refId: string | null = c.id ?? null;
        if (c.kind === 'note') {
          if (!c.note)
            throw errors.validation([{ name: 'completion.note', message: 'say what was done' }]);
          // The note is the update: it persists first, as a reminder event the completion points to.
          const note = await trx
            .insertInto('cg.reminder_event')
            .values({
              tenant_id: r.tenant_id,
              reminder_id: r.id,
              kind: 'completed',
              actor_account_id: account(request).accountId,
              detail: JSON.stringify({ note: c.note, stage: 'update' }),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          refId = note.id;
        } else {
          if (!refId)
            throw errors.validation([
              { name: 'completion.id', message: 'the persisted update is needed' },
            ]);
          const table =
            c.kind === 'mission_event'
              ? 'cg.mission_event'
              : c.kind === 'need_event'
                ? 'cg.need_event'
                : c.kind === 'canvass_visit'
                  ? 'cg.canvass_visit'
                  : 'cg.site';
          const exists = await trx
            .selectFrom(table as 'cg.mission_event')
            .select('id')
            .where('id', '=', refId)
            .executeTakeFirst();
          if (!exists)
            throw new ApiError(
              409,
              'update_not_persisted',
              'The update this completion rests on is not saved; the reminder stays open.',
              { details: { completion: c } },
            );
        }
        const next = r.recurrence
          ? new Date(new Date(r.due_at).getTime() + (r.recurrence === 'daily' ? 1 : 7) * 86_400_000)
          : null;
        return {
          set: next
            ? {
                due_at: next,
                snoozed_until: null,
                state: 'active',
                acknowledged_at: null,
                acknowledged_by: null,
                escalated_at: null,
              }
            : {
                state: 'completed',
                completed_at: new Date(),
                completed_by: account(request).accountId,
                completion_ref_kind: c.kind,
                completion_ref_id: refId,
              },
          kind: next ? 'recurred' : 'completed',
          detail: {
            completion: { kind: c.kind, id: refId },
            ...(next ? { nextDueAt: next.toISOString() } : {}),
          },
        };
      }),
  );

  // ----------------------------------------------------------------- badges
  async function badgeToOut(
    trx: Trx,
    b: BadgeRow,
    withHistory = false,
    code?: string,
  ): Promise<z.infer<typeof badgeOut>> {
    const out: z.infer<typeof badgeOut> = {
      id: b.id,
      version: b.version,
      createdAt: iso(b.created_at)!,
      updatedAt: iso(b.updated_at)!,
      personnelId: b.personnel_id,
      eventId: b.event_id,
      template: b.template,
      displayName: b.display_name,
      agency: b.agency,
      roleLabel: b.role_label,
      accessLabel: b.access_label,
      photoKey: b.photo_key,
      credentials: ((b.credentials_snapshot as unknown as { kind: string }[] | null) ?? []).map(
        (c) => c.kind,
      ),
      validFrom: iso(b.valid_from)!,
      validTo: iso(b.valid_to)!,
      state: b.state,
      ...(code ? { code } : {}),
      replacesBadgeId: b.replaces_badge_id,
      printRequestedAt: iso(b.print_requested_at),
      printConfirmedAt: iso(b.print_confirmed_at),
      printFailedReason: b.print_failed_reason,
      handedOutAt: iso(b.handed_out_at),
      revokedAt: iso(b.revoked_at),
      revokeReason: b.revoke_reason,
    };
    if (withHistory) {
      const h = await trx
        .selectFrom('cg.badge_event')
        .selectAll()
        .where('badge_id', '=', b.id)
        .orderBy('occurred_at')
        .execute();
      out.history = h.map((e) => ({
        kind: e.kind,
        actorAccountId: e.actor_account_id,
        detail: (e.detail as Record<string, unknown>) ?? {},
        occurredAt: iso(e.occurred_at)!,
      }));
    }
    return out;
  }

  app.get(
    '/badges',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          personnelId: z.uuid().optional(),
          state: z.enum(badgeStates).optional(),
        }),
        response: { 200: z.array(badgeOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('badge.read', { type: 'badge', tenantId: s.tenantId });
      const q = request.query;
      return request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.badge')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.personnelId) x = x.where('personnel_id', '=', q.personnelId);
        if (q.state) x = x.where('state', '=', q.state);
        const rows = await x.execute();
        return Promise.all(rows.map((b) => badgeToOut(trx, b)));
      });
    },
  );

  app.get(
    '/badges/:id',
    { schema: { tags: ['field'], params: uuidParam, response: { 200: badgeOut } } },
    async (request) => {
      const s = account(request);
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.badge')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      await request.authorize(
        'badge.read',
        { type: 'badge', id: row.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      return request.tx((trx) => badgeToOut(trx, row, true));
    },
  );

  /** FR-13.01: generated from the personnel record; the code returns once, to print (AC-13C: the text is printed too). */
  app.post(
    '/badges',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          personnelId: z.uuid(),
          eventId: z.uuid().optional(),
          template: z.string().max(40).default('standard'),
          roleLabel: z.string().max(80).optional(),
          /** FR-13.03: printed text, never a permission. */
          accessLabel: z.string().max(80).optional(),
          validDays: z.number().int().min(1).max(366).default(14),
          replacesBadgeId: z.uuid().optional(),
        }),
        response: { 201: badgeOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('badge.generate', { type: 'badge', tenantId: s.tenantId });
      const b = request.body;
      const { row, code } = await request.tx(async (trx) => {
        const person = await trx
          .selectFrom('cg.personnel')
          .select(['id', 'name', 'agency', 'operational_role', 'status', 'photo_key'])
          .where('id', '=', b.personnelId)
          .executeTakeFirst();
        if (!person || person.status !== 'active')
          throw errors.validation([
            { name: 'personnelId', message: 'no active person with that id' },
          ]);
        const creds = await trx
          .selectFrom('cg.credential')
          .select(['kind', 'expires_at'])
          .where('personnel_id', '=', person.id)
          .where('status', '=', 'verified')
          .execute();
        const code = newBadgeCode();
        const inserted = await trx
          .insertInto('cg.badge')
          .values({
            tenant_id: s.tenantId,
            personnel_id: person.id,
            event_id: b.eventId ?? null,
            template: b.template,
            display_name: person.name,
            agency: person.agency,
            role_label: b.roleLabel ?? person.operational_role,
            access_label: b.accessLabel ?? null,
            // BRD:FR-13.01: only the person's approved photo is printed; a request cannot name another.
            photo_key: person.photo_key,
            credentials_snapshot: JSON.stringify(
              creds.map((c) => ({ kind: c.kind, expiresAt: c.expires_at })),
            ),
            valid_to: new Date(Date.now() + b.validDays * 86_400_000),
            code_hash: hashCode(s.tenantId, code),
            replaces_badge_id: b.replacesBadgeId ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.badge_event')
          .values({
            tenant_id: s.tenantId,
            badge_id: inserted.id,
            kind: 'generated',
            actor_account_id: s.accountId,
            detail: JSON.stringify({ template: b.template, validDays: b.validDays }),
          })
          .execute();
        if (b.replacesBadgeId) {
          await trx
            .updateTable('cg.badge')
            .set({ state: 'replaced', updated_by: s.accountId })
            .where('id', '=', b.replacesBadgeId)
            .where('state', 'not in', ['revoked', 'replaced'])
            .execute();
          await trx
            .insertInto('cg.badge_event')
            .values({
              tenant_id: s.tenantId,
              badge_id: b.replacesBadgeId,
              kind: 'replaced',
              actor_account_id: s.accountId,
              detail: JSON.stringify({ by: inserted.id }),
            })
            .execute();
        }
        await request.audit(trx, {
          action: 'badge.generate',
          targetType: 'badge',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'personnel', to: person.id },
              { name: 'access_label', to: b.accessLabel ?? null },
              { name: 'valid_to', to: inserted.valid_to },
            ],
          },
        });
        return { row: inserted, code };
      });
      return reply.code(201).send(await request.tx((trx) => badgeToOut(trx, row, false, code)));
    },
  );

  /** FR-13.06, RULE-11: print requested, confirmed by a person, failed, handed out — never equated. */
  app.post(
    '/badges/:id/print',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['field'],
        params: uuidParam,
        body: z.object({
          outcome: z.enum(['requested', 'confirmed', 'failed', 'handed_out']),
          reason: z.string().max(300).optional(),
        }),
        response: { 200: badgeOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.badge')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'badge.print',
        { type: 'badge', id: current.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      if (['revoked', 'replaced', 'expired'].includes(current.state))
        throw errors.validation([{ name: 'state', message: `the badge is ${current.state}` }]);
      const b = request.body;
      const allowed: Record<string, string[]> = {
        requested: ['generated', 'print_failed', 'print_requested'],
        confirmed: ['print_requested', 'print_failed'],
        failed: ['print_requested'],
        handed_out: ['print_confirmed'],
      };
      if (!allowed[b.outcome]!.includes(current.state))
        throw errors.validation([
          { name: 'outcome', message: `cannot record ${b.outcome} from ${current.state}` },
        ]);
      if (b.outcome === 'failed' && !b.reason)
        throw errors.validation([{ name: 'reason', message: 'say what failed' }]);
      const set =
        b.outcome === 'requested'
          ? { state: 'print_requested' as const, print_requested_at: new Date() }
          : b.outcome === 'confirmed'
            ? {
                state: 'print_confirmed' as const,
                print_confirmed_at: new Date(),
                print_confirmed_by: s.accountId,
                print_failed_reason: null,
              }
            : b.outcome === 'failed'
              ? { state: 'print_failed' as const, print_failed_reason: b.reason ?? null }
              : { state: 'handed_out' as const, handed_out_at: new Date() };
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.badge')
            .set({ ...set, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          await badgeToOut(trx, current),
        );
        await trx
          .insertInto('cg.badge_event')
          .values({
            tenant_id: s.tenantId,
            badge_id: current.id,
            kind: set.state,
            actor_account_id: s.accountId,
            detail: JSON.stringify({ reason: b.reason ?? null }),
          })
          .execute();
        await request.audit(trx, {
          action: 'badge.print',
          targetType: 'badge',
          targetId: current.id,
          targetVersion: updated.version,
          reason: b.reason ?? null,
          changes: { fields: [{ name: 'state', from: current.state, to: set.state }] },
        });
        return badgeToOut(trx, updated, true);
      });
    },
  );

  app.post(
    '/badges/:id/revoke',
    {
      config: { requiresVersion: true },
      schema: { tags: ['field'], params: uuidParam, response: { 200: badgeOut } },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.badge')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'badge.revoke',
        { type: 'badge', id: current.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      const reason = request.confirmation().reason!;
      return request.tx(async (trx) => {
        const updated = assertUpdated(
          await trx
            .updateTable('cg.badge')
            .set({
              state: 'revoked',
              revoked_at: new Date(),
              revoked_by: s.accountId,
              revoke_reason: reason,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          await badgeToOut(trx, current),
        );
        await trx
          .insertInto('cg.badge_event')
          .values({
            tenant_id: s.tenantId,
            badge_id: current.id,
            kind: 'revoked',
            actor_account_id: s.accountId,
            detail: JSON.stringify({ reason }),
          })
          .execute();
        await request.audit(trx, {
          action: 'badge.revoke',
          targetType: 'badge',
          targetId: current.id,
          targetVersion: updated.version,
          reason,
          changes: { fields: [{ name: 'state', from: current.state, to: 'revoked' }] },
        });
        return badgeToOut(trx, updated, true);
      });
    },
  );

  /** FL:FR-03, AC-13B: a checkpoint answers valid, expired, revoked or unknown with name, agency and label only. */
  app.post(
    '/badges/verify',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          code: z.string().min(8).max(20),
          checkpoint: z.string().max(120).optional(),
        }),
        response: {
          200: z.object({
            result: z.enum([
              'valid',
              'expired',
              'revoked',
              'not_yet_printed',
              'not_yet_valid',
              'unknown',
            ]),
            /** FL:FR-03: a staff badge, or a resident's re-entry pass. */
            kind: z.enum(['badge', 'reentry']).optional(),
            displayName: z.string().optional(),
            agency: z.string().nullable().optional(),
            roleLabel: z.string().nullable().optional(),
            accessLabel: z.string().nullable().optional(),
            validTo: z.iso.datetime().optional(),
            /** A re-entry pass: the zone, how many people, and (to match an ID) who and which home. */
            zone: z.string().optional(),
            people: z.number().int().optional(),
            holderName: z.string().optional(),
            address: z.string().optional(),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('badge.verify', { type: 'badge', tenantId: s.tenantId });
      const hash = hashCode(s.tenantId, request.body.code);
      return request.tx(async (trx) => {
        const badge = await trx
          .selectFrom('cg.badge')
          .selectAll()
          .where('code_hash', '=', hash)
          .executeTakeFirst();
        // FL:FR-03: not a badge? Perhaps a resident's re-entry pass.
        const pass = badge
          ? undefined
          : await trx
              .selectFrom('cg.reentry_pass')
              .selectAll()
              .where('code_hash', '=', hash)
              .executeTakeFirst();
        if (pass) {
          const now = Date.now();
          const passResult: 'valid' | 'expired' | 'revoked' | 'not_yet_valid' =
            pass.state === 'revoked'
              ? 'revoked'
              : new Date(pass.valid_to).getTime() < now
                ? 'expired'
                : new Date(pass.valid_from).getTime() > now
                  ? 'not_yet_valid'
                  : 'valid';
          await trx
            .insertInto('cg.reentry_check')
            .values({
              tenant_id: pass.tenant_id,
              event_id: pass.event_id,
              pass_id: pass.id,
              checkpoint: request.body.checkpoint ?? null,
              result: passResult,
              checked_by: s.accountId,
            })
            .execute();
          // Who and which home only for a valid pass and a role that checks passes (restricted).
          const mayCheck =
            passResult === 'valid' &&
            (await request
              .authorize('reentry_pass.verify', {
                type: 'reentry_pass',
                tenantId: s.tenantId,
                eventId: pass.event_id,
              })
              .then(
                () => true,
                () => false,
              ));
          await request.audit(trx, {
            action: 'badge.verify',
            targetType: 'reentry_pass',
            targetId: pass.id,
            changes: {
              fields: [
                { name: 'result', to: passResult },
                { name: 'checkpoint', to: request.body.checkpoint ?? null },
                { name: 'holder_shown', to: mayCheck },
              ],
            },
          });
          const shown = mayCheck
            ? {
                holderName: await app.fieldCrypto
                  .decrypt(pass.tenant_id, pass.holder_name_enc)
                  .catch(() => undefined),
                address: await app.fieldCrypto
                  .decrypt(pass.tenant_id, pass.address_enc)
                  .catch(() => undefined),
              }
            : {};
          return {
            result: passResult,
            kind: 'reentry' as const,
            zone: pass.zone,
            people: pass.people,
            validTo: iso(pass.valid_to)!,
            ...(shown.holderName ? { holderName: shown.holderName } : {}),
            ...(shown.address ? { address: shown.address } : {}),
          };
        }
        const result: 'valid' | 'expired' | 'revoked' | 'not_yet_printed' | 'unknown' = !badge
          ? 'unknown'
          : badge.state === 'revoked' || badge.state === 'replaced'
            ? 'revoked'
            : new Date(badge.valid_to).getTime() < Date.now() || badge.state === 'expired'
              ? 'expired'
              : badge.state === 'generated' ||
                  badge.state === 'print_requested' ||
                  badge.state === 'print_failed'
                ? 'not_yet_printed'
                : 'valid';
        if (badge) {
          await trx
            .insertInto('cg.badge_event')
            .values({
              tenant_id: badge.tenant_id,
              badge_id: badge.id,
              kind: 'verified',
              actor_account_id: s.accountId,
              detail: JSON.stringify({ result, checkpoint: request.body.checkpoint ?? null }),
            })
            .execute();
          if (result === 'expired' && badge.state !== 'expired')
            await trx
              .updateTable('cg.badge')
              .set({ state: 'expired', updated_by: s.accountId })
              .where('id', '=', badge.id)
              .execute();
        }
        await request.audit(trx, {
          action: 'badge.verify',
          targetType: 'badge',
          targetId: badge?.id ?? 'unknown',
          changes: {
            fields: [
              { name: 'result', to: result },
              { name: 'checkpoint', to: request.body.checkpoint ?? null },
            ],
          },
        });
        return badge && result !== 'unknown'
          ? {
              result,
              kind: 'badge' as const,
              displayName: badge.display_name,
              agency: badge.agency,
              roleLabel: badge.role_label,
              accessLabel: badge.access_label,
              validTo: iso(badge.valid_to)!,
            }
          : { result };
      });
    },
  );

  // ------------------------------------------------------------ net control
  const commsToOut = (c: Selectable<Database['cg.comms_log']>): z.infer<typeof commsOut> => ({
    id: c.id,
    eventId: c.event_id,
    net: c.net,
    entryAt: iso(c.entry_at)!,
    fromStation: c.from_station,
    toStation: c.to_station,
    teamId: c.team_id,
    kind: c.kind,
    message: c.message,
    operatorAccountId: c.operator_account_id,
    teamStatusId: c.team_status_id,
    positionRecordedAt: iso(c.position_recorded_at),
  });

  app.get(
    '/comms-log',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          net: z.string().max(80).optional(),
          teamId: z.uuid().optional(),
        }),
        response: { 200: z.array(commsOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('comms_log.read', { type: 'comms_log', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.comms_log')
          .selectAll()
          .orderBy('entry_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.net) x = x.where('net', '=', q.net);
        if (q.teamId) x = x.where('team_id', '=', q.teamId);
        return x.execute();
      });
      return rows.map(commsToOut);
    },
  );

  /** DSP-10, FLD-17: what net control heard, against the right team; status and position land on it. */
  app.post(
    '/comms-log',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          eventId: z.uuid(),
          net: z.string().min(1).max(80),
          kind: z.enum([
            'status_heard',
            'position_heard',
            'message',
            'check_in',
            'check_out',
            'traffic',
            'net_open',
            'net_close',
          ]),
          fromStation: z.string().max(40).optional(),
          toStation: z.string().max(40).optional(),
          teamId: z.uuid().optional(),
          message: z.string().max(1000).optional(),
          status: z
            .enum(['available', 'en_route', 'on_task', 'break', 'out_of_service'])
            .optional(),
          position: positionIn.extend({ accuracyM: z.number().min(0).optional() }).optional(),
          /** A USNG grid reference read over the air; kept in the message when no point is given (FLD-05). */
          usng: z.string().max(40).optional(),
          entryAt: z.iso.datetime().optional(),
        }),
        response: { 201: commsOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('comms_log.write', {
        type: 'comms_log',
        tenantId: s.tenantId,
        eventId: request.body.eventId,
      });
      const b = request.body;
      if ((b.kind === 'status_heard' || b.kind === 'position_heard') && !b.teamId)
        throw errors.validation([
          { name: 'teamId', message: 'a status or position heard is logged against a team' },
        ]);
      const row = await request.tx(async (trx) => {
        const at = b.entryAt ? new Date(b.entryAt) : new Date();
        let teamStatusId: string | null = null;
        let positionAt: Date | null = null;
        const team = b.teamId
          ? await trx
              .selectFrom('cg.team')
              .select(['id', 'tenant_id', 'name'])
              .where('id', '=', b.teamId)
              .executeTakeFirst()
          : null;
        if (b.teamId && !team)
          throw errors.validation([{ name: 'teamId', message: 'no such team' }]);
        if (b.kind === 'status_heard' && team) {
          if (!b.status)
            throw errors.validation([{ name: 'status', message: 'the status heard is needed' }]);
          const st = await trx
            .insertInto('cg.team_status')
            .values({
              tenant_id: team.tenant_id,
              team_id: team.id,
              status: b.status,
              fact: 'confirmed',
              source: 'net_control',
              set_by_account_id: s.accountId,
              note: `Heard on ${b.net}${b.fromStation ? ` from ${b.fromStation}` : ''}`,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          teamStatusId = st.id;
          await trx
            .updateTable('cg.safety_alert')
            .set({
              state: 'resolved',
              resolved_at: at,
              resolved_by: s.accountId,
              resolution: `Net control heard ${b.status.replace('_', ' ')} on ${b.net}`,
            })
            .where('team_id', '=', team.id)
            .where('kind', '=', 'missed_check_in')
            .where('state', 'in', ['open', 'acknowledged', 'escalated'])
            .execute();
          await activity(
            trx,
            s.tenantId,
            b.eventId,
            null,
            team.id,
            'status',
            `${b.status.replace('_', ' ')} (heard on ${b.net})`,
            'comms_log',
            team.id,
            s.accountId,
          );
        }
        if (b.kind === 'position_heard' && team) {
          if (!b.position && !b.usng)
            throw errors.validation([
              { name: 'position', message: 'a point or a USNG reference is needed' },
            ]);
          const open = await trx
            .selectFrom('cg.check_in')
            .select(['id', 'personnel_id'])
            .where('team_id', '=', team.id)
            .where('ended_at', 'is', null)
            .orderBy('started_at')
            .executeTakeFirst();
          if (!open)
            throw new ApiError(
              409,
              'team_not_checked_in',
              'Nobody on this team is checked in; check the team in from the net first.',
            );
          if (b.position) {
            await sql`select cg.ensure_position_partition(${at.toISOString().slice(0, 10)}::date)`.execute(
              trx,
            );
            await trx
              .insertInto('cg.position')
              .values({
                tenant_id: team.tenant_id,
                check_in_id: open.id,
                personnel_id: open.personnel_id,
                team_id: team.id,
                geom: sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`,
                accuracy_m: b.position.accuracyM ?? 100,
                source: 'net_control',
                recorded_at: at,
              })
              .execute();
            positionAt = at;
          }
          await activity(
            trx,
            s.tenantId,
            b.eventId,
            null,
            team.id,
            'note',
            `Position heard on ${b.net}${b.usng ? ` (${b.usng})` : ''}`,
            'comms_log',
            team.id,
            s.accountId,
          );
        }
        const inserted = await trx
          .insertInto('cg.comms_log')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            net: b.net,
            entry_at: at,
            from_station: b.fromStation ?? null,
            to_station: b.toStation ?? null,
            team_id: team?.id ?? null,
            kind: b.kind,
            message:
              [b.message, b.usng ? `USNG ${b.usng}` : null].filter(Boolean).join(' — ') || null,
            operator_account_id: s.accountId,
            team_status_id: teamStatusId,
            position_recorded_at: positionAt,
            check_in_id: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'comms_log.write',
          targetType: 'comms_log',
          targetId: inserted.id,
          changes: {
            fields: [
              { name: 'kind', to: b.kind },
              { name: 'net', to: b.net },
              { name: 'team', to: team?.id ?? null },
            ],
          },
        });
        return inserted;
      });
      return reply.code(201).send(commsToOut(row));
    },
  );

  // ------------------------------------------------------ activity and log
  app.get(
    '/activity',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          teamId: z.uuid().optional(),
          personnelId: z.uuid().optional(),
          mine: z.coerce.boolean().optional(),
        }),
        response: { 200: z.array(activityOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('activity.read', { type: 'activity_entry', tenantId: s.tenantId });
      const q = request.query;
      const rows = await request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.activity_entry')
          .selectAll()
          .orderBy('occurred_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.teamId) x = x.where('team_id', '=', q.teamId);
        if (q.personnelId) x = x.where('personnel_id', '=', q.personnelId);
        if (q.mine) {
          const own = await trx
            .selectFrom('cg.personnel')
            .select('id')
            .where('account_id', '=', s.accountId)
            .executeTakeFirst();
          if (!own) return [];
          const teams = await trx
            .selectFrom('cg.team_member')
            .select('team_id')
            .where('personnel_id', '=', own.id)
            .where('left_at', 'is', null)
            .execute();
          x = x.where((eb) =>
            eb.or([
              eb('personnel_id', '=', own.id),
              eb('team_id', 'in', teams.length ? teams.map((t) => t.team_id) : [own.id]),
            ]),
          );
        }
        return x.execute();
      });
      return rows.map((a) => ({
        id: a.id,
        eventId: a.event_id,
        personnelId: a.personnel_id,
        teamId: a.team_id,
        occurredAt: iso(a.occurred_at)!,
        recordedAt: iso(a.created_at)!,
        kind: a.kind,
        summary: a.summary,
        refKind: a.ref_kind,
        refId: a.ref_id,
        actorAccountId: a.actor_account_id,
      }));
    },
  );

  app.post(
    '/activity',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          eventId: z.uuid(),
          teamId: z.uuid().optional(),
          personnelId: z.uuid().optional(),
          summary: z.string().min(1).max(500),
          occurredAt: z.iso.datetime().optional(),
        }),
        response: { 201: activityOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('activity.write', {
        type: 'activity_entry',
        tenantId: s.tenantId,
        eventId: request.body.eventId,
      });
      const b = request.body;
      const occurredAt = occurredAtOf(b.occurredAt);
      const row = await request.tx(async (trx) => {
        const own = b.personnelId
          ? null
          : await trx
              .selectFrom('cg.personnel')
              .select('id')
              .where('account_id', '=', s.accountId)
              .executeTakeFirst();
        const personnelId = b.personnelId ?? own?.id ?? null;
        if (!personnelId && !b.teamId)
          throw errors.validation([
            { name: 'teamId', message: 'a note is about a person or a team' },
          ]);
        return trx
          .insertInto('cg.activity_entry')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            team_id: b.teamId ?? null,
            personnel_id: personnelId,
            kind: 'note',
            summary: b.summary,
            actor_account_id: s.accountId,
            ...(occurredAt ? { occurred_at: occurredAt } : {}),
          } as Insertable<Database['cg.activity_entry']>)
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      return reply.code(201).send({
        id: row.id,
        eventId: row.event_id,
        personnelId: row.personnel_id,
        teamId: row.team_id,
        occurredAt: iso(row.occurred_at)!,
        recordedAt: iso(row.created_at)!,
        kind: row.kind,
        summary: row.summary,
        refKind: row.ref_kind,
        refId: row.ref_id,
        actorAccountId: row.actor_account_id,
      });
    },
  );

  app.get(
    '/significant-events',
    {
      schema: {
        tags: ['field'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          since: z.iso.datetime().optional(),
        }),
        response: { 200: z.array(significantOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('significant_event.read', {
        type: 'significant_event',
        tenantId: s.tenantId,
      });
      const q = request.query;
      const rows = await request.tx((trx) => {
        let x = trx
          .selectFrom('cg.significant_event')
          .selectAll()
          .orderBy('occurred_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.since) x = x.where('occurred_at', '>=', new Date(q.since));
        return x.execute();
      });
      return rows.map((e) => ({
        id: e.id,
        eventId: e.event_id,
        occurredAt: iso(e.occurred_at)!,
        recordedAt: iso(e.created_at)!,
        kind: e.kind,
        summary: e.summary,
        missionId: e.mission_id,
        teamId: e.team_id,
        refKind: e.ref_kind,
        refId: e.ref_id,
        actorAccountId: e.actor_account_id,
      }));
    },
  );

  app.post(
    '/significant-events',
    {
      schema: {
        tags: ['field'],
        body: z.object({
          eventId: z.uuid(),
          summary: z.string().min(1).max(500),
          kind: z.enum(['briefing', 'note', 'site', 'hazard']).default('note'),
          missionId: z.uuid().optional(),
          teamId: z.uuid().optional(),
          occurredAt: z.iso.datetime().optional(),
        }),
        response: { 201: significantOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('significant_event.write', {
        type: 'significant_event',
        tenantId: s.tenantId,
        eventId: request.body.eventId,
      });
      const b = request.body;
      const occurredAt = occurredAtOf(b.occurredAt);
      const row = await request.tx((trx) =>
        trx
          .insertInto('cg.significant_event')
          .values({
            tenant_id: s.tenantId,
            event_id: b.eventId,
            kind: b.kind,
            summary: b.summary,
            mission_id: b.missionId ?? null,
            team_id: b.teamId ?? null,
            actor_account_id: s.accountId,
            ...(occurredAt ? { occurred_at: occurredAt } : {}),
          } as Insertable<Database['cg.significant_event']>)
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      return reply.code(201).send({
        id: row.id,
        eventId: row.event_id,
        occurredAt: iso(row.occurred_at)!,
        recordedAt: iso(row.created_at)!,
        kind: row.kind,
        summary: row.summary,
        missionId: row.mission_id,
        teamId: row.team_id,
        refKind: row.ref_kind,
        refId: row.ref_id,
        actorAccountId: row.actor_account_id,
      });
    },
  );
};
