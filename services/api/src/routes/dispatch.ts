/**
 * The dispatch board and the live stream (layer-4 plan §3 and §6, task F;
 * DSP-01, DSP-02, DSP-03, DSP-05, DSP-07, DSP-08, DSP-09, DSP-12, NFR-07,
 * CON-15, ADR-0022): one snapshot of teams by status with their last
 * position at the tenant's precision, the unassigned work queue sorted by
 * priority, active hazards, open sites and open safety alerts, all "as of"
 * one moment; a suggestion of the nearest qualified available team with its
 * reasons (a person assigns, never the suggestion); a replay of the facts in
 * a time window for briefings; and `GET /stream`, Server-Sent Events that
 * carry a record's type, id and version only — the client refetches through
 * the normal API, so the stream never bypasses authorization. The stream is
 * woken by the fan-out exchange the worker feeds from `cg.change_feed` and
 * falls back to polling the feed when the broker is away (SCL-06). A partner
 * organization's dispatcher sees its own teams and the work it holds (DSP-09).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { QueueConnection } from '@cg/adapters';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';
import { configValue } from '../public/submit.ts';
import { iso } from './helpers.ts';

type Trx = Transaction<Database>;

export interface DispatchDeps {
  /** The API's broker connection; absent in unit tests and while the broker is down. */
  getQueue?: () => QueueConnection | undefined;
  /** Poll interval for the stream when the broker is away, and the floor between wakes. */
  pollMs?: number;
  /** Keep-alive comment interval (proxies drop idle connections). */
  keepAliveMs?: number;
}

/** What the worker publishes for each feed row (jobs/changes.ts) and the API wakes streams with. */
export interface ChangeNotice {
  seq: number;
  tenantId: string;
  tenantPath: string;
}

export const CHANGES_EXCHANGE = 'cg.changes';

const teamStatuses = [
  'available',
  'en_route',
  'on_task',
  'break',
  'out_of_service',
  'overdue',
] as const;

const point = z.object({ lat: z.number(), lon: z.number() });

const boardTeam = z.object({
  id: z.uuid(),
  version: z.number().int(),
  key: z.string(),
  name: z.string(),
  kind: z.string(),
  agencyTenantId: z.uuid().nullable(),
  agency: z.string().nullable(),
  callsign: z.string().nullable(),
  skills: z.array(z.string()),
  equipment: z.array(z.string()),
  status: z.enum(teamStatuses).nullable(),
  statusAt: z.string().nullable(),
  suggestedStatus: z.enum(teamStatuses).nullable(),
  checkedInCount: z.number().int(),
  memberCount: z.number().int(),
  checkInDueAt: z.string().nullable(),
  /** Null when the caller may not read positions or nobody on the team is sharing (DSP-08). */
  position: point
    .extend({ accuracyM: z.number().nullable(), recordedAt: z.string(), stale: z.boolean() })
    .nullable(),
  /** The open work the team holds. */
  assignments: z.array(
    z.object({
      id: z.uuid(),
      missionId: z.uuid(),
      reference: z.string(),
      state: z.string(),
    }),
  ),
});

const boardMission = z.object({
  id: z.uuid(),
  version: z.number().int(),
  reference: z.string(),
  kind: z.string(),
  state: z.string(),
  priority: z.string(),
  urgency: z.string(),
  summary: z.string().nullable(),
  requiredCredentials: z.array(z.string()),
  position: point.nullable(),
  locationState: z.string(),
  owningTenantId: z.uuid().nullable(),
  siteId: z.uuid().nullable(),
  needId: z.uuid().nullable(),
  assignedCount: z.number().int(),
  createdAt: z.string(),
  openedAt: z.string().nullable(),
});

const boardOut = z.object({
  asOf: z.string(),
  eventId: z.uuid(),
  /** The feed position at this snapshot: `GET /stream?lastEventId=` continues from here (NFR-07). */
  cursor: z.number().int(),
  positionPrecisionM: z.number(),
  teams: z.array(boardTeam),
  /** DSP-03: open missions nobody active holds, by priority, urgency and age. */
  queue: z.array(boardMission),
  /** Open missions with active assignments. */
  active: z.array(boardMission),
  hazards: z.array(
    z.object({
      id: z.uuid(),
      version: z.number().int(),
      kind: z.string(),
      state: z.string(),
      severity: z.string(),
      summary: z.string().nullable(),
      position: point.nullable(),
      radiusM: z.number().nullable(),
      reportedAt: z.string(),
    }),
  ),
  sites: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.string(),
      status: z.string(),
      position: point.nullable(),
      capacity: z.number().int().nullable(),
      occupancy: z.number().int().nullable(),
    }),
  ),
  alerts: z.array(
    z.object({
      id: z.uuid(),
      version: z.number().int(),
      kind: z.string(),
      state: z.string(),
      teamId: z.uuid().nullable(),
      personnelId: z.uuid().nullable(),
      raisedAt: z.string(),
      /** FLD-16, §12.1: the help button's position is exact whatever the precision setting. */
      position: point.nullable(),
    }),
  ),
  counts: z.object({
    teamsByStatus: z.record(z.string(), z.number().int()),
    queue: z.number().int(),
    active: z.number().int(),
    hazards: z.number().int(),
    openAlerts: z.number().int(),
  }),
});

const suggestionOut = z.object({
  missionId: z.uuid(),
  asOf: z.string(),
  /** Best first. A person assigns through POST /missions/:id/assignments; nothing here changes a record. */
  suggestions: z.array(
    z.object({
      teamId: z.uuid(),
      name: z.string(),
      agency: z.string().nullable(),
      status: z.enum(teamStatuses).nullable(),
      distanceM: z.number().nullable(),
      etaMinutes: z.number().nullable(),
      credentials: z.array(z.string()),
      reasons: z.array(z.string()),
      cautions: z.array(z.string()),
      score: z.number(),
    }),
  ),
});

const replayOut = z.object({
  eventId: z.uuid(),
  from: z.string(),
  to: z.string(),
  /** Team statuses in force at `from`, so a client can start the picture before the first fact. */
  initial: z.array(
    z.object({
      teamId: z.uuid(),
      status: z.enum(teamStatuses).nullable(),
      at: z.string().nullable(),
    }),
  ),
  facts: z.array(
    z.object({
      at: z.string(),
      kind: z.string(),
      recordType: z.string(),
      recordId: z.uuid(),
      teamId: z.uuid().nullable(),
      personnelId: z.uuid().nullable(),
      missionId: z.uuid().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      position: point.nullable(),
      summary: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

/** Haversine distance in metres. */
export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The scoring the suggestion uses (plan §3: "nearest qualified available team
 * with its reasons"). Pure so the unit tests can pin it: credentials first,
 * then availability, then distance; a team that is busy or lacks a credential
 * is still listed, with the caution, because the dispatcher decides.
 */
export function scoreTeam(input: {
  status: string | null;
  required: string[];
  held: string[];
  distanceM: number | null;
  checkedIn: number;
  busy: number;
}): { score: number; reasons: string[]; cautions: string[] } {
  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = 0;
  const missing = input.required.filter((c) => !input.held.includes(c));
  if (input.required.length && missing.length === 0) {
    score += 50;
    reasons.push(`holds ${input.required.map((c) => c.replace(/_/g, ' ')).join(', ')}`);
  } else if (missing.length) {
    score -= 100;
    cautions.push(`missing ${missing.map((c) => c.replace(/_/g, ' ')).join(', ')}`);
  }
  if (input.checkedIn === 0) {
    score -= 60;
    cautions.push('nobody checked in');
  } else reasons.push(`${input.checkedIn} checked in`);
  if (input.status === 'available') {
    score += 30;
    reasons.push('available');
  } else if (input.status === 'overdue') {
    score -= 80;
    cautions.push('overdue on check-in');
  } else if (input.status === 'out_of_service') {
    score -= 70;
    cautions.push('out of service');
  } else if (input.status) {
    score -= 20;
    cautions.push(input.status.replace(/_/g, ' '));
  } else cautions.push('no status yet');
  if (input.busy > 0) {
    score -= 25 * input.busy;
    cautions.push(`already on ${input.busy} mission${input.busy > 1 ? 's' : ''}`);
  }
  if (input.distanceM !== null) {
    const km = input.distanceM / 1000;
    score += Math.max(0, 20 - km * 2);
    reasons.push(`${km < 1 ? `${Math.round(input.distanceM)} m` : `${km.toFixed(1)} km`} away`);
  } else cautions.push('no recent position');
  return { score, reasons, cautions };
}

/** Rounds a position to the tenant's precision grid (DSP-08), as /positions/latest does. */
export function roundTo(lat: number, lon: number, metres: number): { lat: number; lon: number } {
  if (!metres || metres <= 0) return { lat, lon };
  const deg = metres / 111_320;
  return { lat: Math.round(lat / deg) * deg, lon: Math.round(lon / deg) * deg };
}

/** SSE framing for one feed row. */
export function sseFrame(row: {
  seq: number;
  record_type: string;
  record_id: string;
  record_version: number | null;
  op: string;
  tenant_id: string;
  scope_kind: string;
  scope_id: string | null;
}): string {
  const data = JSON.stringify({
    recordType: row.record_type,
    recordId: row.record_id,
    version: row.record_version,
    op: row.op,
    tenantId: row.tenant_id,
    scope: { kind: row.scope_kind, id: row.scope_id },
  });
  return `id: ${row.seq}\nevent: change\ndata: ${data}\n\n`;
}

/**
 * One broker consumer per API process: an exclusive queue bound to the
 * fan-out exchange; each notice wakes the streams whose tenant subtree
 * covers the changed tenant. Rebinds when the connection changes.
 */
export class ChangeWaker {
  private readonly listeners = new Set<(n: ChangeNotice) => void>();
  private readonly getQueue: () => QueueConnection | undefined;
  private boundTo: QueueConnection | undefined;
  private binding: Promise<void> | undefined;

  constructor(getQueue: () => QueueConnection | undefined) {
    this.getQueue = getQueue;
  }

  /** True when the broker is feeding wakes right now. */
  get live(): boolean {
    return this.boundTo !== undefined && this.boundTo === this.getQueue();
  }

  subscribe(fn: (n: ChangeNotice) => void): () => void {
    this.listeners.add(fn);
    void this.ensureBound();
    return () => this.listeners.delete(fn);
  }

  /** For tests and the in-process path: deliver a notice to every stream. */
  notify(n: ChangeNotice): void {
    for (const l of this.listeners) l(n);
  }

  async ensureBound(): Promise<void> {
    const q = this.getQueue();
    if (!q || this.boundTo === q) return;
    if (this.binding) return this.binding;
    this.binding = (async () => {
      try {
        const ch = await q.connection.createChannel();
        await ch.assertExchange(CHANGES_EXCHANGE, 'fanout', { durable: true });
        const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
        await ch.bindQueue(queue, CHANGES_EXCHANGE, '');
        await ch.consume(
          queue,
          (raw) => {
            if (!raw) return;
            try {
              this.notify(JSON.parse(raw.content.toString('utf8')) as ChangeNotice);
            } catch {
              // a malformed notice wakes nobody; the poll fallback still runs
            }
          },
          { noAck: true },
        );
        q.connection.once('close', () => {
          if (this.boundTo === q) this.boundTo = undefined;
        });
        this.boundTo = q;
      } catch {
        this.boundTo = undefined;
      } finally {
        this.binding = undefined;
      }
    })();
    return this.binding;
  }
}

export const dispatchRoutes =
  (deps: DispatchDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const waker = new ChangeWaker(deps.getQueue ?? (() => undefined));
    const pollMs = deps.pollMs ?? 2_000;
    const keepAliveMs = deps.keepAliveMs ?? 15_000;

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    /** DSP-09: a partner works in the county's records limited to its own teams and the work it holds. */
    interface Scope {
      tenantId: string;
      partnerId: string | null;
    }
    async function scopeOf(request: FastifyRequest): Promise<Scope> {
      const s = account(request);
      if (s.tenantKind !== 'partner_org') return { tenantId: s.tenantId, partnerId: null };
      const me = await request.tx((trx) =>
        trx
          .selectFrom('cg.tenant')
          .select('parent_id')
          .where('id', '=', s.tenantId)
          .executeTakeFirst(),
      );
      return { tenantId: me?.parent_id ?? s.tenantId, partnerId: s.tenantId };
    }
    const run = <T>(request: FastifyRequest, scope: Scope, fn: (trx: Trx) => Promise<T>) =>
      scope.partnerId ? request.txAs(scope.tenantId, fn) : request.tx(fn);

    async function latestStatuses(trx: Trx, teamIds: string[]) {
      if (!teamIds.length)
        return new Map<string, { status: string; at: Date; suggested: string | null }>();
      const rows = await trx
        .selectFrom('cg.team_status')
        .select(['team_id', 'status', 'fact', 'created_at'])
        .where('team_id', 'in', teamIds)
        .orderBy('team_id')
        .orderBy('created_at', 'desc')
        .execute();
      const out = new Map<string, { status: string; at: Date; suggested: string | null }>();
      const seenSuggested = new Map<string, { status: string; at: Date }>();
      for (const r of rows) {
        if (r.fact === 'confirmed') {
          if (!out.has(r.team_id)) {
            const sg = seenSuggested.get(r.team_id);
            out.set(r.team_id, {
              status: r.status,
              at: new Date(r.created_at),
              suggested: sg && sg.at > new Date(r.created_at) ? sg.status : null,
            });
          }
        } else if (!seenSuggested.has(r.team_id) && !out.has(r.team_id)) {
          seenSuggested.set(r.team_id, { status: r.status, at: new Date(r.created_at) });
        }
      }
      return out;
    }

    async function teamPositions(trx: Trx, eventId: string, precision: number, staleMs: number) {
      const rows = await trx
        .selectFrom('cg.position as p')
        .innerJoin('cg.check_in as c', 'c.id', 'p.check_in_id')
        .select([
          'p.team_id',
          'p.accuracy_m',
          'p.recorded_at',
          sql<number>`ST_Y(p.geom)`.as('lat'),
          sql<number>`ST_X(p.geom)`.as('lon'),
        ])
        .distinctOn('p.team_id')
        .where('c.ended_at', 'is', null)
        .where('c.location_sharing', '=', true)
        .where('c.event_id', '=', eventId)
        .where('p.team_id', 'is not', null)
        .orderBy('p.team_id')
        .orderBy('p.recorded_at', 'desc')
        .execute();
      const out = new Map<
        string,
        { lat: number; lon: number; accuracyM: number | null; recordedAt: string; stale: boolean }
      >();
      for (const r of rows) {
        if (!r.team_id) continue;
        const rounded = roundTo(Number(r.lat), Number(r.lon), precision);
        out.set(r.team_id, {
          ...rounded,
          accuracyM: precision > 0 ? Math.max(r.accuracy_m ?? 0, precision) : r.accuracy_m,
          recordedAt: iso(r.recorded_at)!,
          stale: Date.now() - new Date(r.recorded_at).getTime() > staleMs,
        });
      }
      return out;
    }

    const missionSelect = (trx: Trx) =>
      trx
        .selectFrom('cg.mission as m')
        .leftJoin('cg.location as l', 'l.id', 'm.location_id')
        .select([
          'm.id',
          'm.version',
          'm.reference',
          'm.kind',
          'm.state',
          'm.priority',
          'm.urgency',
          'm.summary',
          'm.required_credentials',
          'm.location_state',
          'm.owning_tenant_id',
          'm.site_id',
          'm.need_id',
          'm.created_at',
          'm.opened_at',
          'm.event_id',
          sql<number | null>`ST_Y(l.geom)`.as('lat'),
          sql<number | null>`ST_X(l.geom)`.as('lon'),
        ]);
    type MissionSel = Awaited<ReturnType<ReturnType<typeof missionSelect>['execute']>>[number];
    const toBoardMission = (m: MissionSel, assigned: number): z.infer<typeof boardMission> => ({
      id: m.id,
      version: m.version,
      reference: m.reference,
      kind: m.kind,
      state: m.state,
      priority: m.priority,
      urgency: m.urgency,
      summary: m.summary,
      requiredCredentials: m.required_credentials,
      position:
        m.lat !== null && m.lon !== null ? { lat: Number(m.lat), lon: Number(m.lon) } : null,
      locationState: m.location_state,
      owningTenantId: m.owning_tenant_id,
      siteId: m.site_id,
      needId: m.need_id,
      assignedCount: assigned,
      createdAt: iso(m.created_at)!,
      openedAt: iso(m.opened_at),
    });
    const PRIORITY = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    const URGENCY = { now: 0, soon: 1, routine: 2 } as const;
    const byPriority = (a: z.infer<typeof boardMission>, b: z.infer<typeof boardMission>) =>
      PRIORITY[a.priority as keyof typeof PRIORITY] -
        PRIORITY[b.priority as keyof typeof PRIORITY] ||
      URGENCY[a.urgency as keyof typeof URGENCY] - URGENCY[b.urgency as keyof typeof URGENCY] ||
      a.createdAt.localeCompare(b.createdAt);

    async function eventFor(trx: Trx, eventId: string | undefined): Promise<string> {
      if (eventId) {
        const e = await trx
          .selectFrom('cg.event')
          .select('id')
          .where('id', '=', eventId)
          .executeTakeFirst();
        if (!e) throw errors.notFound();
        return e.id;
      }
      const e = await trx
        .selectFrom('cg.event')
        .select('id')
        .where('status', '=', 'active')
        .orderBy('opened_at', 'desc')
        .executeTakeFirst();
      if (!e) throw errors.validation([{ name: 'eventId', message: 'no active event' }]);
      return e.id;
    }

    // ------------------------------------------------------------- board
    app.get(
      '/dispatch/board',
      {
        schema: {
          tags: ['dispatch'],
          querystring: z.object({
            eventId: z.uuid().optional(),
            staleMinutes: z.coerce.number().int().min(1).max(1440).default(15),
          }),
          response: { 200: boardOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        await request.authorize('dispatch.read', { type: 'dispatch', tenantId: s.tenantId });
        // DSP-08: positions only for roles that hold position.read; the board still shows the team.
        const mayReadPositions = await request
          .authorize('position.read', { type: 'position', tenantId: s.tenantId })
          .then(
            () => true,
            () => false,
          );
        const q = request.query;
        return run(request, scope, async (trx) => {
          const eventId = await eventFor(trx, q.eventId);
          const asOf = new Date();
          const cursor = await trx
            .selectFrom('cg.change_feed')
            .select(sql<string>`coalesce(max(seq), 0)`.as('seq'))
            .executeTakeFirstOrThrow();
          const precision =
            Number((await configValue<number | string>(trx, 'field.position_precision_m')) ?? 0) ||
            0;
          let teamQuery = trx
            .selectFrom('cg.team')
            .selectAll()
            .where('status', '=', 'active')
            .where((eb) => eb.or([eb('event_id', '=', eventId), eb('event_id', 'is', null)]))
            .orderBy('name');
          if (scope.partnerId)
            teamQuery = teamQuery.where('agency_tenant_id', '=', scope.partnerId);
          const teams = await teamQuery.execute();
          const teamIds = teams.map((t) => t.id);
          const statuses = await latestStatuses(trx, teamIds);
          const positions = mayReadPositions
            ? await teamPositions(trx, eventId, precision, q.staleMinutes * 60_000)
            : new Map<string, never>();
          const open = teamIds.length
            ? await trx
                .selectFrom('cg.check_in')
                .select(['team_id', sql<string>`count(*)`.as('n')])
                .where('team_id', 'in', teamIds)
                .where('ended_at', 'is', null)
                .groupBy('team_id')
                .execute()
            : [];
          const members = teamIds.length
            ? await trx
                .selectFrom('cg.team_member')
                .select(['team_id', sql<string>`count(*)`.as('n')])
                .where('team_id', 'in', teamIds)
                .where('left_at', 'is', null)
                .groupBy('team_id')
                .execute()
            : [];
          const openAssignments = await trx
            .selectFrom('cg.assignment as a')
            .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
            .select([
              'a.id',
              'a.mission_id',
              'a.team_id',
              'a.personnel_id',
              'a.state',
              'm.reference',
            ])
            .where('a.released_at', 'is', null)
            .where('a.state', 'not in', ['declined', 'released', 'cleared'])
            .where('m.event_id', '=', eventId)
            .where('m.state', 'in', ['open', 'en_route', 'on_scene'])
            .execute();
          let missions = missionSelect(trx)
            .where('m.event_id', '=', eventId)
            .where('m.state', 'in', ['open', 'en_route', 'on_scene']);
          if (scope.partnerId) {
            const held = new Set(
              openAssignments
                .filter((a) => a.team_id && teamIds.includes(a.team_id))
                .map((a) => a.mission_id),
            );
            missions = missions.where((eb) =>
              eb.or([
                eb('m.owning_tenant_id', '=', scope.partnerId!),
                ...(held.size ? [eb('m.id', 'in', [...held])] : []),
              ]),
            );
          }
          const missionRows = await missions.execute();
          const assignedCount = new Map<string, number>();
          for (const a of openAssignments)
            assignedCount.set(a.mission_id, (assignedCount.get(a.mission_id) ?? 0) + 1);
          const queue: z.infer<typeof boardMission>[] = [];
          const active: z.infer<typeof boardMission>[] = [];
          for (const m of missionRows) {
            const n = assignedCount.get(m.id) ?? 0;
            (n === 0 ? queue : active).push(toBoardMission(m, n));
          }
          queue.sort(byPriority);
          active.sort(byPriority);

          const hazards = await trx
            .selectFrom('cg.hazard')
            .select([
              'id',
              'version',
              'kind',
              'state',
              'severity',
              'summary',
              'radius_m',
              'reported_at',
              sql<number | null>`ST_Y(geom)`.as('lat'),
              sql<number | null>`ST_X(geom)`.as('lon'),
            ])
            .where('event_id', '=', eventId)
            .where('state', '<>', 'cleared')
            .orderBy('reported_at', 'desc')
            .execute();
          const sites = scope.partnerId
            ? []
            : await trx
                .selectFrom('cg.site as s')
                .leftJoin('cg.location as l', 'l.id', 's.location_id')
                .select([
                  's.id',
                  's.name',
                  's.kind',
                  's.status',
                  's.capacity',
                  's.occupancy',
                  sql<number | null>`ST_Y(l.geom)`.as('lat'),
                  sql<number | null>`ST_X(l.geom)`.as('lon'),
                ])
                .where((eb) =>
                  eb.or([eb('s.event_id', '=', eventId), eb('s.event_id', 'is', null)]),
                )
                .where('s.status', 'in', ['open', 'limited', 'full'])
                .where('s.confidential', '=', false)
                .orderBy('s.name')
                .execute();
          let alertQuery = trx
            .selectFrom('cg.safety_alert')
            .select([
              'id',
              'version',
              'kind',
              'state',
              'team_id',
              'personnel_id',
              'raised_at',
              sql<number | null>`ST_Y(geom)`.as('lat'),
              sql<number | null>`ST_X(geom)`.as('lon'),
            ])
            .where('event_id', '=', eventId)
            .where('state', 'in', ['open', 'acknowledged', 'escalated'])
            .orderBy('raised_at', 'desc');
          if (scope.partnerId)
            alertQuery = alertQuery.where(
              'team_id',
              'in',
              teamIds.length ? teamIds : [scope.partnerId],
            );
          const alerts = await alertQuery.execute();

          const teamsOut = teams.map((t): z.infer<typeof boardTeam> => {
            const st = statuses.get(t.id) ?? null;
            const checkedIn = Number(open.find((o) => o.team_id === t.id)?.n ?? 0);
            const due =
              st && checkedIn > 0
                ? new Date(st.at.getTime() + t.check_in_interval_minutes * 60_000)
                : null;
            return {
              id: t.id,
              version: t.version,
              key: t.key,
              name: t.name,
              kind: t.kind,
              agencyTenantId: t.agency_tenant_id,
              agency: t.agency,
              callsign: t.callsign,
              skills: t.skills,
              equipment: t.equipment,
              status: (st?.status as (typeof teamStatuses)[number] | undefined) ?? null,
              statusAt: st ? iso(st.at) : null,
              suggestedStatus:
                (st?.suggested as (typeof teamStatuses)[number] | null | undefined) ?? null,
              checkedInCount: checkedIn,
              memberCount: Number(members.find((m) => m.team_id === t.id)?.n ?? 0),
              checkInDueAt: iso(due),
              position: positions.get(t.id) ?? null,
              assignments: openAssignments
                .filter((a) => a.team_id === t.id)
                .map((a) => ({
                  id: a.id,
                  missionId: a.mission_id,
                  reference: a.reference,
                  state: a.state,
                })),
            };
          });
          const teamsByStatus: Record<string, number> = {};
          for (const t of teamsOut) {
            const k = t.status ?? 'unknown';
            teamsByStatus[k] = (teamsByStatus[k] ?? 0) + 1;
          }
          return {
            asOf: asOf.toISOString(),
            eventId,
            cursor: Number(cursor.seq),
            positionPrecisionM: precision,
            teams: teamsOut,
            queue,
            active,
            hazards: hazards.map((h) => ({
              id: h.id,
              version: h.version,
              kind: h.kind,
              state: h.state,
              severity: h.severity,
              summary: h.summary,
              position:
                h.lat !== null && h.lon !== null
                  ? { lat: Number(h.lat), lon: Number(h.lon) }
                  : null,
              radiusM: h.radius_m,
              reportedAt: iso(h.reported_at)!,
            })),
            sites: sites.map((x) => ({
              id: x.id,
              name: x.name,
              kind: x.kind,
              status: x.status,
              position:
                x.lat !== null && x.lon !== null
                  ? { lat: Number(x.lat), lon: Number(x.lon) }
                  : null,
              capacity: x.capacity,
              occupancy: x.occupancy,
            })),
            alerts: alerts.map((a) => ({
              id: a.id,
              version: a.version,
              kind: a.kind,
              state: a.state,
              teamId: a.team_id,
              personnelId: a.personnel_id,
              raisedAt: iso(a.raised_at)!,
              position:
                a.lat !== null && a.lon !== null
                  ? { lat: Number(a.lat), lon: Number(a.lon) }
                  : null,
            })),
            counts: {
              teamsByStatus,
              queue: queue.length,
              active: active.length,
              hazards: hazards.length,
              openAlerts: alerts.length,
            },
          };
        });
      },
    );

    // -------------------------------------------------------- suggestions
    app.get(
      '/dispatch/suggest',
      {
        schema: {
          tags: ['dispatch'],
          querystring: z.object({
            missionId: z.uuid(),
            limit: z.coerce.number().int().min(1).max(20).default(5),
          }),
          response: { 200: suggestionOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        await request.authorize('dispatch.read', { type: 'dispatch', tenantId: s.tenantId });
        const q = request.query;
        return run(request, scope, async (trx) => {
          const mission = await missionSelect(trx)
            .where('m.id', '=', q.missionId)
            .executeTakeFirst();
          if (!mission) throw errors.notFound();
          let teamQuery = trx
            .selectFrom('cg.team')
            .select(['id', 'name', 'agency', 'agency_tenant_id'])
            .where('status', '=', 'active')
            .where((eb) =>
              eb.or([eb('event_id', '=', mission.event_id), eb('event_id', 'is', null)]),
            );
          if (scope.partnerId)
            teamQuery = teamQuery.where('agency_tenant_id', '=', scope.partnerId);
          const teams = await teamQuery.execute();
          const teamIds = teams.map((t) => t.id);
          if (!teamIds.length)
            return { missionId: mission.id, asOf: new Date().toISOString(), suggestions: [] };
          const statuses = await latestStatuses(trx, teamIds);
          // Distance is computed from the exact fix and only reported as a distance (DSP-08).
          const positions = await teamPositions(trx, mission.event_id, 0, 30 * 60_000);
          const open = await trx
            .selectFrom('cg.check_in')
            .select(['team_id', sql<string>`count(*)`.as('n')])
            .where('team_id', 'in', teamIds)
            .where('ended_at', 'is', null)
            .groupBy('team_id')
            .execute();
          const busy = await trx
            .selectFrom('cg.assignment as a')
            .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
            .select(['a.team_id', sql<string>`count(*)`.as('n')])
            .where('a.team_id', 'in', teamIds)
            .where('a.released_at', 'is', null)
            .where('a.mission_id', '<>', mission.id)
            .where('m.state', 'in', ['open', 'en_route', 'on_scene'])
            .groupBy('a.team_id')
            .execute();
          // Credentials in force among the members (PER-01); expired ones do not count.
          const today = new Date().toISOString().slice(0, 10);
          const creds = await trx
            .selectFrom('cg.team_member as tm')
            .innerJoin('cg.credential as c', 'c.personnel_id', 'tm.personnel_id')
            .select(['tm.team_id', 'c.kind'])
            .where('tm.team_id', 'in', teamIds)
            .where('tm.left_at', 'is', null)
            .where('c.status', '=', 'verified')
            .where((eb) =>
              eb.or([eb('c.expires_at', 'is', null), eb('c.expires_at', '>=', new Date(today))]),
            )
            .execute();
          const target =
            mission.lat !== null && mission.lon !== null
              ? { lat: Number(mission.lat), lon: Number(mission.lon) }
              : null;
          const suggestions = teams
            .map((t) => {
              const held = [
                ...new Set(creds.filter((c) => c.team_id === t.id).map((c) => c.kind as string)),
              ];
              const pos = positions.get(t.id);
              const d = target && pos && !pos.stale ? distanceM(target, pos) : null;
              const st = statuses.get(t.id)?.status ?? null;
              const scored = scoreTeam({
                status: st,
                required: mission.required_credentials,
                held,
                distanceM: d,
                checkedIn: Number(open.find((o) => o.team_id === t.id)?.n ?? 0),
                busy: Number(busy.find((b) => b.team_id === t.id)?.n ?? 0),
              });
              return {
                teamId: t.id,
                name: t.name,
                agency: t.agency,
                status: st as (typeof teamStatuses)[number] | null,
                distanceM: d === null ? null : Math.round(d),
                etaMinutes: d === null ? null : Math.max(1, Math.round(d / 1000 / 0.5)), // 30 km/h on storm roads
                credentials: held,
                reasons: scored.reasons,
                cautions: scored.cautions,
                score: scored.score,
              };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, q.limit);
          return { missionId: mission.id, asOf: new Date().toISOString(), suggestions };
        });
      },
    );

    // ------------------------------------------------------------- replay
    app.get(
      '/dispatch/replay',
      {
        schema: {
          tags: ['dispatch'],
          querystring: z.object({
            eventId: z.uuid().optional(),
            from: z.iso.datetime(),
            to: z.iso.datetime(),
            limit: z.coerce.number().int().min(1).max(5000).default(2000),
          }),
          response: { 200: replayOut },
        },
      },
      async (request) => {
        const s = account(request);
        const scope = await scopeOf(request);
        await request.authorize('dispatch.read', { type: 'dispatch', tenantId: s.tenantId });
        const mayReadPositions = await request
          .authorize('position.read', { type: 'position', tenantId: s.tenantId })
          .then(
            () => true,
            () => false,
          );
        const q = request.query;
        const from = new Date(q.from);
        const to = new Date(q.to);
        if (to <= from) throw errors.validation([{ name: 'to', message: 'must be after from' }]);
        if (to.getTime() - from.getTime() > 7 * 24 * 3_600_000)
          throw errors.validation([{ name: 'to', message: 'a replay covers at most seven days' }]);
        return run(request, scope, async (trx) => {
          const eventId = await eventFor(trx, q.eventId);
          let teamQuery = trx
            .selectFrom('cg.team')
            .select('id')
            .where((eb) => eb.or([eb('event_id', '=', eventId), eb('event_id', 'is', null)]));
          if (scope.partnerId)
            teamQuery = teamQuery.where('agency_tenant_id', '=', scope.partnerId);
          const teamIds = (await teamQuery.execute()).map((t) => t.id);
          type Fact = z.infer<typeof replayOut>['facts'][number];
          const facts: Fact[] = [];
          const initial: z.infer<typeof replayOut>['initial'] = [];
          if (teamIds.length) {
            const before = await trx
              .selectFrom('cg.team_status')
              .select(['team_id', 'status', 'created_at'])
              .distinctOn('team_id')
              .where('team_id', 'in', teamIds)
              .where('fact', '=', 'confirmed')
              .where('created_at', '<=', from)
              .orderBy('team_id')
              .orderBy('created_at', 'desc')
              .execute();
            for (const id of teamIds) {
              const b = before.find((x) => x.team_id === id);
              initial.push({
                teamId: id,
                status: (b?.status as (typeof teamStatuses)[number] | undefined) ?? null,
                at: iso(b?.created_at ?? null),
              });
            }
            const statusFacts = await trx
              .selectFrom('cg.team_status')
              .select(['id', 'team_id', 'status', 'fact', 'source', 'created_at'])
              .where('team_id', 'in', teamIds)
              .where('created_at', '>', from)
              .where('created_at', '<=', to)
              .orderBy('created_at')
              .limit(q.limit)
              .execute();
            for (const f of statusFacts)
              facts.push({
                at: iso(f.created_at)!,
                kind: f.fact === 'confirmed' ? 'team_status' : 'team_status_suggested',
                recordType: 'team_status',
                recordId: f.id,
                teamId: f.team_id,
                personnelId: null,
                missionId: null,
                from: null,
                to: f.status,
                position: null,
                summary: `${f.source.replace(/_/g, ' ')}: ${f.status.replace(/_/g, ' ')}`,
              });
          }
          let assignmentFacts = trx
            .selectFrom('cg.assignment_event as e')
            .innerJoin('cg.assignment as a', 'a.id', 'e.assignment_id')
            .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
            .select([
              'e.id',
              'e.kind',
              'e.from_state',
              'e.to_state',
              'e.occurred_at',
              'a.team_id',
              'a.personnel_id',
              'a.mission_id',
              'm.reference',
            ])
            .where('m.event_id', '=', eventId)
            .where('e.occurred_at', '>', from)
            .where('e.occurred_at', '<=', to)
            .orderBy('e.occurred_at')
            .limit(q.limit);
          if (scope.partnerId)
            assignmentFacts = assignmentFacts.where((eb) =>
              eb.or([
                eb('m.owning_tenant_id', '=', scope.partnerId!),
                eb('a.team_id', 'in', teamIds.length ? teamIds : [scope.partnerId!]),
              ]),
            );
          for (const f of await assignmentFacts.execute())
            facts.push({
              at: iso(f.occurred_at)!,
              kind: `assignment_${f.kind}`,
              recordType: 'assignment',
              recordId: f.id,
              teamId: f.team_id,
              personnelId: f.personnel_id,
              missionId: f.mission_id,
              from: f.from_state,
              to: f.to_state,
              position: null,
              summary: `${f.reference}: ${f.kind.replace(/_/g, ' ')}`,
            });
          let missionFacts = trx
            .selectFrom('cg.mission_event as e')
            .innerJoin('cg.mission as m', 'm.id', 'e.mission_id')
            .select([
              'e.id',
              'e.kind',
              'e.from_state',
              'e.to_state',
              'e.occurred_at',
              'm.id as mission_id',
              'm.reference',
            ])
            .where('m.event_id', '=', eventId)
            .where('e.kind', 'in', [
              'created',
              'state_changed',
              'priority_changed',
              'canceled',
              'reopened',
            ])
            .where('e.occurred_at', '>', from)
            .where('e.occurred_at', '<=', to)
            .orderBy('e.occurred_at')
            .limit(q.limit);
          if (scope.partnerId)
            missionFacts = missionFacts.where('m.owning_tenant_id', '=', scope.partnerId);
          for (const f of await missionFacts.execute())
            facts.push({
              at: iso(f.occurred_at)!,
              kind: `mission_${f.kind}`,
              recordType: 'mission',
              recordId: f.id,
              teamId: null,
              personnelId: null,
              missionId: f.mission_id,
              from: f.from_state,
              to: f.to_state,
              position: null,
              summary: `${f.reference}: ${f.kind.replace(/_/g, ' ')}`,
            });
          const hazardFacts = await trx
            .selectFrom('cg.hazard_event as e')
            .innerJoin('cg.hazard as h', 'h.id', 'e.hazard_id')
            .select([
              'e.id',
              'e.kind',
              'e.from_state',
              'e.to_state',
              'e.occurred_at',
              'h.id as hazard_id',
              'h.kind as hazard_kind',
              'h.severity',
              sql<number | null>`ST_Y(h.geom)`.as('lat'),
              sql<number | null>`ST_X(h.geom)`.as('lon'),
            ])
            .where('h.event_id', '=', eventId)
            .where('e.occurred_at', '>', from)
            .where('e.occurred_at', '<=', to)
            .orderBy('e.occurred_at')
            .limit(q.limit)
            .execute();
          for (const f of hazardFacts)
            facts.push({
              at: iso(f.occurred_at)!,
              kind: `hazard_${f.kind}`,
              recordType: 'hazard',
              recordId: f.hazard_id,
              teamId: null,
              personnelId: null,
              missionId: null,
              from: f.from_state,
              to: f.to_state,
              position:
                f.lat !== null && f.lon !== null
                  ? { lat: Number(f.lat), lon: Number(f.lon) }
                  : null,
              summary: `${f.hazard_kind.replace(/_/g, ' ')} (${f.severity}): ${f.kind}`,
            });
          let alertFacts = trx
            .selectFrom('cg.safety_alert')
            .select([
              'id',
              'kind',
              'state',
              'team_id',
              'personnel_id',
              'raised_at',
              'acknowledged_at',
              'resolved_at',
            ])
            .where('event_id', '=', eventId)
            .where('raised_at', '>', from)
            .where('raised_at', '<=', to)
            .orderBy('raised_at')
            .limit(q.limit);
          if (scope.partnerId)
            alertFacts = alertFacts.where(
              'team_id',
              'in',
              teamIds.length ? teamIds : [scope.partnerId],
            );
          for (const a of await alertFacts.execute()) {
            facts.push({
              at: iso(a.raised_at)!,
              kind: 'alert_raised',
              recordType: 'safety_alert',
              recordId: a.id,
              teamId: a.team_id,
              personnelId: a.personnel_id,
              missionId: null,
              from: null,
              to: 'open',
              position: null,
              summary: `${a.kind.replace(/_/g, ' ')} alert raised`,
            });
            if (a.acknowledged_at && new Date(a.acknowledged_at) <= to)
              facts.push({
                at: iso(a.acknowledged_at)!,
                kind: 'alert_acknowledged',
                recordType: 'safety_alert',
                recordId: a.id,
                teamId: a.team_id,
                personnelId: a.personnel_id,
                missionId: null,
                from: 'open',
                to: 'acknowledged',
                position: null,
                summary: `${a.kind.replace(/_/g, ' ')} alert acknowledged`,
              });
            if (a.resolved_at && new Date(a.resolved_at) <= to)
              facts.push({
                at: iso(a.resolved_at)!,
                kind: 'alert_resolved',
                recordType: 'safety_alert',
                recordId: a.id,
                teamId: a.team_id,
                personnelId: a.personnel_id,
                missionId: null,
                from: null,
                to: a.state,
                position: null,
                summary: `${a.kind.replace(/_/g, ' ')} alert ${a.state.replace(/_/g, ' ')}`,
              });
          }
          // DSP-08, DSP-12: the trail at the tenant's precision, thinned to one fix per team per minute.
          if (mayReadPositions && teamIds.length) {
            const precision =
              Number(
                (await configValue<number | string>(trx, 'field.position_precision_m')) ?? 0,
              ) || 0;
            const trail = await trx
              .selectFrom('cg.position')
              .select([
                'id',
                'team_id',
                'personnel_id',
                sql<Date>`date_trunc('minute', recorded_at)`.as('minute'),
                sql<number>`ST_Y(geom)`.as('lat'),
                sql<number>`ST_X(geom)`.as('lon'),
              ])
              .distinctOn(['team_id', sql`date_trunc('minute', recorded_at)`])
              .where('team_id', 'in', teamIds)
              .where('recorded_at', '>', from)
              .where('recorded_at', '<=', to)
              .orderBy('team_id')
              .orderBy(sql`date_trunc('minute', recorded_at)`)
              .orderBy('recorded_at', 'desc')
              .limit(q.limit)
              .execute();
            for (const p of trail)
              facts.push({
                at: iso(p.minute)!,
                kind: 'position',
                recordType: 'position',
                recordId: p.id,
                teamId: p.team_id,
                personnelId: p.personnel_id,
                missionId: null,
                from: null,
                to: null,
                position: roundTo(Number(p.lat), Number(p.lon), precision),
                summary: null,
              });
          }
          facts.sort((a, b) => a.at.localeCompare(b.at));
          const truncated = facts.length > q.limit;
          return {
            eventId,
            from: from.toISOString(),
            to: to.toISOString(),
            initial,
            facts: truncated ? facts.slice(0, q.limit) : facts,
            truncated,
          };
        });
      },
    );

    // ------------------------------------------------------------- stream
    /**
     * Server-Sent Events (ADR-0022, NFR-07). `Last-Event-ID` (or
     * `?lastEventId=`) resumes from a feed position, so a reconnecting board
     * misses nothing; each frame names a record and its version only. The
     * feed is read under the caller's row-level security, so a partner's
     * dispatcher learns only of its own tenant's changes and the county of
     * its whole subtree (DSP-09).
     */
    app.get(
      '/stream',
      {
        schema: {
          tags: ['dispatch'],
          querystring: z.object({
            lastEventId: z.coerce.number().int().min(0).optional(),
            /** Record types the client cares about; everything when absent. */
            types: z.string().max(400).optional(),
            /** Tests and probes: close after this many milliseconds. */
            maxMs: z.coerce.number().int().min(100).max(3_600_000).optional(),
          }),
        },
      },
      async (request, reply) => {
        const s = account(request);
        await request.authorize('stream.read', { type: 'stream', tenantId: s.tenantId });
        const header = request.headers['last-event-id'];
        let last =
          request.query.lastEventId ??
          (typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : undefined);
        const types = request.query.types
          ? new Set(request.query.types.split(',').filter(Boolean))
          : null;
        const subtree = s.tenantPath;

        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        reply.hijack();
        const res = reply.raw;
        let closed = false;
        const write = (chunk: string) => {
          if (!closed) res.write(chunk);
        };

        if (last === undefined) {
          // No resume point: start from the present and say so.
          const head = await request.tx((trx) =>
            trx
              .selectFrom('cg.change_feed')
              .select(sql<string>`coalesce(max(seq), 0)`.as('seq'))
              .executeTakeFirstOrThrow(),
          );
          last = Number(head.seq);
        }
        write(
          `retry: 3000\nevent: ready\ndata: ${JSON.stringify({ cursor: last, live: waker.live, asOf: new Date().toISOString() })}\n\n`,
        );

        let pending = false;
        let running = false;
        const drain = async () => {
          if (running) {
            pending = true;
            return;
          }
          running = true;
          try {
            do {
              pending = false;
              const rows = await request.tx((trx) =>
                trx
                  .selectFrom('cg.change_feed')
                  .select([
                    'seq',
                    'tenant_id',
                    'scope_kind',
                    'scope_id',
                    'record_type',
                    'record_id',
                    'record_version',
                    'op',
                  ])
                  .where('seq', '>', last!)
                  .orderBy('seq')
                  .limit(500)
                  .execute(),
              );
              for (const r of rows) {
                last = Number(r.seq);
                if (types && !types.has(r.record_type)) continue;
                write(sseFrame({ ...r, seq: Number(r.seq) }));
              }
            } while (pending && !closed);
          } catch (err) {
            request.log.warn({ err }, 'stream drain failed');
          } finally {
            running = false;
          }
        };

        const unsubscribe = waker.subscribe((n) => {
          // A notice from this tenant or a descendant (the county board follows its partners).
          if (n.tenantId === s.tenantId || n.tenantPath.startsWith(`${subtree}.`)) void drain();
        });
        const poll = setInterval(() => {
          if (!waker.live) void drain();
        }, pollMs);
        const keepAlive = setInterval(
          () => write(`: keep-alive ${new Date().toISOString()}\n\n`),
          keepAliveMs,
        );
        const stop = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          clearInterval(poll);
          clearInterval(keepAlive);
          if (limit) clearTimeout(limit);
          res.end();
        };
        const limit = request.query.maxMs ? setTimeout(stop, request.query.maxMs) : null;
        request.raw.on('close', stop);
        res.on('error', stop);
        await drain();
      },
    );
  };
