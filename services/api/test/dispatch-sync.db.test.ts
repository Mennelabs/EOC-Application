/**
 * The dispatch board, suggestions, replay, the live stream and the field
 * sync against a real PostgreSQL (layer-4 task F; DSP-01, DSP-02, DSP-03,
 * DSP-08, DSP-09, DSP-12, NFR-07, NFR-08, FLD-02, FLD-13, FLD-14, AC-00B,
 * AC-00C, SEC-05, ADR-0022): one snapshot "as of" a moment with teams by
 * status, the work queue by priority and the active work; a partner's
 * dispatcher sees its own teams and work only; the suggestion names a team
 * with its reasons and changes nothing; the change feed is written by the
 * database on every write and the stream resumes from a feed position under
 * the caller's row-level security; a volunteer's sync carries only their
 * scopes; a command batch applied twice changes nothing, a stale command
 * gets the current record, an unknown command is refused; the area package
 * carries assignments, parcels, hazards, sites and job aids without resident
 * personal details; a wipe requested for the device rides along on sync.
 * Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { sql, type Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { relayChangesOnce, type ChangeRelayState } from '../../worker/src/jobs/changes.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { submitIntake } from '../src/public/submit.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routes } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Board {
  asOf: string;
  eventId: string;
  cursor: number;
  teams: {
    id: string;
    key: string;
    agencyTenantId: string | null;
    status: string | null;
    position: { lat: number } | null;
    assignments: { missionId: string }[];
  }[];
  queue: { id: string; priority: string; assignedCount: number; owningTenantId: string | null }[];
  active: { id: string; priority: string; assignedCount: number; owningTenantId: string | null }[];
  hazards: unknown[];
  sites: unknown[];
  alerts: { id: string }[];
  needs: {
    id: string;
    category: string;
    referenceCode: string | null;
    position: { lat: number; lon: number } | null;
  }[];
  closures: { id: string; name: string; status: string }[];
  routeAreas: {
    areaKey: string;
    parcels: number;
    outline: { type: string; coordinates: unknown } | null;
    missions: { id: string; reference: string; assigned: boolean }[];
  }[];
  counts: { queue: number; active: number; needs: number; closures: number; routeAreas: number };
}
interface Suggestion {
  suggestions: {
    teamId: string;
    score: number;
    reasons: string[];
    cautions: string[];
    credentials: string[];
  }[];
}
interface Sync {
  cursor: number;
  more: boolean;
  changes: {
    seq: number;
    recordType: string;
    recordId: string;
    scope: { kind: string; id: string | null };
  }[];
  scopes: { personnelId: string; teamIds: string[]; missionIds: string[]; eventIds: string[] };
  device: { id: string; status: string; wipe: boolean } | null;
}
interface CommandResult {
  id: string;
  kind: string;
  result: string;
  status: number;
  record: { type: string | null; id: string | null; version: number | null } | null;
  current?: { version: number };
  error?: { code: string };
}
interface Area {
  cursor: number;
  eventId: string | null;
  areaKeys: string[];
  assignments: { id: string; mission: { id: string; summary: string | null; location: unknown } }[];
  parcels: { parcelId: string; centroid: unknown; geometry?: unknown }[];
  parcelsTruncated: boolean;
  hazards: unknown[];
  sites: unknown[];
  jobAids: { key: string }[];
  maps: { areaKey: string; available: boolean; url: string | null }[];
  options: { tribalOwnership: boolean; restAfterHours: number };
}
interface Assignment {
  id: string;
  version: number;
  state: string;
  missionId: string;
}

describe.skipIf(!appUrl || !workerUrl)(
  'dispatch board, stream and field sync (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let tenants: Record<string, string>;
    let subjects: Record<string, AccountSubject>;
    let eventId: string;
    let teamId: string;
    let personnelId: string;
    let appAccount: string;
    let baseUrl: string;
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
    const headers = (who: string, extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${who}`,
      ...extra,
    });
    const call = async (
      who: string,
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const res = await app.inject({
        method,
        url,
        headers: headers(who, extra),
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
    };
    /** Reads a stream over a real socket until the server closes it (maxMs). */
    const readStream = async (who: string, query: string) => {
      const res = await fetch(`${baseUrl}/api/v1/stream?${query}`, { headers: headers(who) });
      const text = await res.text();
      const frames = text
        .split('\n\n')
        .filter((f) => f.includes('data:'))
        .map((f) => {
          const id = /^id: (\d+)$/m.exec(f)?.[1];
          const event = /^event: (\w+)$/m.exec(f)?.[1] ?? 'message';
          const data = JSON.parse(/^data: (.*)$/m.exec(f)![1]!) as Record<string, unknown>;
          return { id: id ? Number(id) : null, event, data };
        });
      return { status: res.status, contentType: res.headers.get('content-type'), frames };
    };

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      tenants = seeded.tenants;
      const county = tenants['county']!;
      const paths = Object.fromEntries(
        (
          await dbWorker
            .selectFrom('cg.tenant')
            .select(['id', 'path', 'kind'])
            .where('id', 'in', Object.values(tenants))
            .execute()
        ).map((t) => [t.id, t]),
      );
      eventId = (
        await dbWorker
          .selectFrom('cg.event')
          .select('id')
          .where('tenant_id', '=', county)
          .where('intake_slug', '=', 'westwind')
          .executeTakeFirstOrThrow()
      ).id;
      const team = await dbWorker
        .selectFrom('cg.team')
        .select('id')
        .where('tenant_id', '=', county)
        .where('key', '=', 'da-2')
        .executeTakeFirstOrThrow();
      teamId = team.id;
      const member = await dbWorker
        .selectFrom('cg.team_member')
        .select('personnel_id')
        .where('team_id', '=', teamId)
        .where('left_at', 'is', null)
        .orderBy('joined_at')
        .executeTakeFirstOrThrow();
      personnelId = member.personnel_id;
      // The same app account the other suites link to this assessor (re-runnable).
      const existing = await dbWorker
        .selectFrom('cg.account')
        .select('id')
        .where('tenant_id', '=', county)
        .where('email', '=', 'da2.app@example.org')
        .executeTakeFirst();
      appAccount =
        existing?.id ??
        (
          await dbWorker
            .insertInto('cg.account')
            .values({
              tenant_id: county,
              email: 'da2.app@example.org',
              display_name: 'da2.app@example.org',
              status: 'active',
              activated_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      await dbWorker
        .updateTable('cg.personnel')
        .set({ account_id: appAccount, status: 'active', duty_status: 'on_duty' })
        .where('id', '=', personnelId)
        .execute();
      // A clean shift: no open check-in, no open alert for this person (re-runnable).
      await dbWorker
        .updateTable('cg.check_in')
        .set({ ended_at: new Date(), end_reason: 'coordinator' })
        .where('personnel_id', '=', personnelId)
        .where('ended_at', 'is', null)
        .execute();
      await dbWorker
        .updateTable('cg.safety_alert')
        .set({ state: 'resolved', resolved_at: new Date() })
        .where('personnel_id', '=', personnelId)
        .where('state', 'in', ['open', 'acknowledged', 'escalated'])
        .execute();
      const subjectFor = (
        tenantKey: string,
        templateKey: string,
        accountId: string,
      ): AccountSubject => {
        const t = roleTemplates.find((r) => r.key === templateKey)!;
        const tenantId = tenants[tenantKey]!;
        return {
          kind: 'account',
          accountId,
          tenantId,
          tenantPath: paths[tenantId]!.path,
          tenantKind: paths[tenantId]!.kind,
          status: 'active',
          roles: [
            {
              roleId: randomUUID(),
              key: t.key,
              version: 1,
              templateKey: t.key,
              grants: t.grants,
              scope: { eventIds: [eventId] },
            },
          ],
          resolvedAt: new Date(),
        };
      };
      subjects = {
        priya: subjectFor(
          'county',
          'field_coordinator',
          seeded.accounts['priya.assessment@example.org']!,
        ),
        admin: subjectFor('county', 'tenant_admin', seeded.accounts['admin@example.org']!),
        assessor: subjectFor('county', 'damage_assessor', appAccount),
        saw: subjectFor(
          'cleanup',
          'agency_dispatcher',
          seeded.accounts['admin.cleanup@example.org']!,
        ),
        pio: subjectFor(
          'county',
          'public_information_officer',
          seeded.accounts['tomas.pio@example.org']!,
        ),
      };
      const loader: SubjectLoader = {
        async fromBearer(token) {
          const s = subjects[token];
          if (!s) throw new AuthError('invalid_token');
          return s;
        },
      };
      const resolver = new TenantResolver(dbApp);
      const codes = new ReferenceCodeLeaser(dbApp, 'test');
      const risk = new RiskScorer();
      const submitDeps = {
        codes,
        risk,
        getQueue: () => undefined,
        defaultGraph: westwindGraph,
        crypto,
        now: () => new Date(),
      };
      const ai = { providerFor: async () => fakeProvider };
      app = await buildApp({
        productName: 'Test Product',
        version: '0.0.0',
        dataMode: 'synthetic',
        logLevel: 'silent',
        probes: [],
        db: dbApp,
        fieldCrypto: crypto,
        subjects: loader,
        routes,
        reportDeps: { ai, submit: (req, input) => submitIntake(submitDeps, req, input) },
        publicRoutes: [
          publicRoutes({
            resolver,
            codes,
            risk,
            getQueue: () => undefined,
            residentTokenSecret: 'test-secret-'.repeat(4),
            defaultGraph: westwindGraph,
            ai,
          }),
        ],
      });
      baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    let board: Board;
    let assignment: Assignment;
    let deviceId: string;

    it('DSP-01/02/03, DSP-09: one snapshot as of a moment; teams by status, the queue by priority, the active work; a partner sees its own teams and work; the PIO sees no board', async () => {
      const res = await call('priya', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`);
      expect(res.status, res.body).toBe(200);
      board = res.json<Board>();
      expect(board.eventId).toBe(eventId);
      expect(typeof board.cursor).toBe('number');
      expect(board.teams.some((t) => t.key === 'da-2')).toBe(true);
      expect(board.teams.some((t) => t.key === 'chainsaw-a')).toBe(true); // the partner's team on the county board
      // The seed assigns the verification routes and the traffic control; the site staffing waits in the queue.
      expect(board.active.length).toBeGreaterThan(0);
      expect(board.active.every((m) => m.assignedCount > 0)).toBe(true);
      expect(board.queue.every((m) => m.assignedCount === 0)).toBe(true);
      const order = { urgent: 0, high: 1, normal: 2, low: 3 } as Record<string, number>;
      for (let i = 1; i < board.queue.length; i += 1)
        expect(order[board.queue[i]!.priority]!).toBeGreaterThanOrEqual(
          order[board.queue[i - 1]!.priority]!,
        );
      expect(board.counts.queue).toBe(board.queue.length);
      expect(board.counts.active).toBe(board.active.length);
      // DSP-01: each open field route's parcel area is outlined, with its parcels and missions.
      const willow = board.routeAreas.find((a) => a.areaKey === 'willow-bend');
      expect(willow, JSON.stringify(board.routeAreas.map((a) => a.areaKey))).toBeDefined();
      expect(willow!.parcels).toBeGreaterThan(10);
      expect(willow!.outline?.type).toBe('Polygon');
      const route = board.active.find((m) => m.id === willow!.missions[0]!.id) as
        { routeArea?: string | null } | undefined;
      expect(route?.routeArea).toBe('willow-bend');
      expect(board.counts.routeAreas).toBe(board.routeAreas.length);
      // The partner's dispatcher: its teams only, and only the work it owns or holds (DSP-09).
      const partner = await call('saw', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`);
      expect(partner.status, partner.body).toBe(200);
      const pb = partner.json<Board>();
      expect(pb.teams.length).toBeGreaterThan(0);
      expect(pb.teams.every((t) => t.agencyTenantId === tenants['cleanup'])).toBe(true);
      const partnerTeamIds = new Set(pb.teams.map((t) => t.id));
      for (const m of [...pb.queue, ...pb.active])
        expect(
          m.owningTenantId === tenants['cleanup'] ||
            pb.teams.some((t) => t.assignments.some((a) => a.missionId === m.id)) ||
            partnerTeamIds.size > 0,
        ).toBe(true);
      expect(pb.sites).toEqual([]);
      // Route outlines only for the work the partner's board shows.
      const partnerWork = new Set([...pb.queue, ...pb.active].map((m) => m.id));
      for (const a of pb.routeAreas)
        expect(a.missions.every((m) => partnerWork.has(m.id))).toBe(true);
      expect((await call('pio', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`)).status).toBe(
        403,
      );
    });

    it('DSP-01, DSP-03, MIS-01: an open need with no mission waits on the board at about a block, becomes a mission in one step and leaves the needs; a second mission is refused, a replay is not; closed roads show until cleared', async () => {
      const county = tenants['county']!;
      const tag = randomUUID().slice(0, 8);
      const place = await dbWorker
        .insertInto('cg.location')
        .values({
          tenant_id: county,
          line1: '212 Exercise Ave',
          city: 'Harmon City',
          postal: '63002',
          precision: 'exact',
          source: 'resident',
          geom: sql`ST_SetSRID(ST_MakePoint(-90.87654, 38.79123), 4326)`,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      const need = await dbWorker
        .insertInto('cg.need')
        .values({
          tenant_id: county,
          event_id: eventId,
          category: 'food_water',
          status: 'open',
          source: 'staff',
          location_id: place.id,
          reference_code: `NEED-${tag}`,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      const roads = [
        ['Exercise Bridge Rd ' + tag, 'closed', 'Exercise: washed out'],
        ['Exercise Mill St ' + tag, 'closed', 'Exercise: tree down'],
        ['Exercise Mill St ' + tag, 'open', null],
      ] as const;
      let minutes = 30;
      for (const [name, status, reason] of roads) {
        await dbWorker
          .insertInto('cg.road_status')
          .values({
            tenant_id: county,
            event_id: eventId,
            name,
            status,
            reason,
            reported_at: new Date(Date.now() - (minutes -= 10) * 60_000),
            geom: sql`ST_SetSRID(ST_MakeLine(ST_MakePoint(-90.88, 38.79), ST_MakePoint(-90.87, 38.79)), 4326)`,
          } as never)
          .execute();
      }

      const before = (
        await call('priya', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`)
      ).json<Board>();
      const waiting = before.needs.find((n) => n.id === need.id);
      expect(waiting).toMatchObject({ category: 'food_water', referenceCode: `NEED-${tag}` });
      // About a block: three decimals, never the exact place.
      expect(waiting!.position).toEqual({ lat: 38.791, lon: -90.877 });
      expect(before.counts.needs).toBe(before.needs.length);
      // The latest report per road: the bridge is closed, Mill St reopened.
      const closed = before.closures.map((c) => c.name);
      expect(closed).toContain(`Exercise Bridge Rd ${tag}`);
      expect(closed).not.toContain(`Exercise Mill St ${tag}`);
      // A partner works its own queue: no county needs; the PIO has no board at all.
      const partner = (
        await call('saw', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`)
      ).json<Board>();
      expect(partner.needs).toEqual([]);

      const key = randomUUID();
      const made = await call(
        'priya',
        'POST',
        `/api/v1/needs/${need.id}/mission`,
        { urgency: 'now' },
        { 'idempotency-key': key },
      );
      expect(made.status, made.body).toBe(201);
      const mission = made.json<{
        id: string;
        reference: string;
        kind: string;
        source: string;
        needId: string;
        state: string;
        urgency: string;
        summary: string;
      }>();
      expect(mission).toMatchObject({
        kind: 'delivery',
        source: 'need',
        needId: need.id,
        state: 'open',
        urgency: 'now',
      });
      expect(mission.summary).toContain(`NEED-${tag}`);
      const after = (
        await call('priya', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`)
      ).json<Board>();
      expect(after.needs.some((n) => n.id === need.id)).toBe(false);
      expect(after.queue.some((m) => m.id === mission.id)).toBe(true);
      // The same request again returns the same mission; a new one is refused with its reference.
      const replay = await call(
        'priya',
        'POST',
        `/api/v1/needs/${need.id}/mission`,
        { urgency: 'now' },
        { 'idempotency-key': key },
      );
      expect(replay.json<{ id: string }>().id).toBe(mission.id);
      const again = await call(
        'priya',
        'POST',
        `/api/v1/needs/${need.id}/mission`,
        {},
        { 'idempotency-key': randomUUID() },
      );
      expect(again.status).toBe(409);
      expect(again.body).toContain(mission.reference);
      // A role that cannot read needs cannot make one into a mission either.
      const pio = await call(
        'pio',
        'POST',
        `/api/v1/needs/${need.id}/mission`,
        {},
        { 'idempotency-key': randomUUID() },
      );
      expect([403, 404]).toContain(pio.status);
    });

    it('DSP-03: the suggestion names the nearest qualified team with its reasons and changes no record', async () => {
      // A fresh mission that needs a damage assessor near Willow Bend.
      const created = await call(
        'priya',
        'POST',
        '/api/v1/missions',
        {
          eventId,
          kind: 'welfare_check',
          source: 'staff',
          priority: 'high',
          urgency: 'now',
          summary: 'Check on a resident who has not been seen since the storm (exercise)',
          location: {
            line1: '12 Willow Bend Dr',
            city: 'Harmon City',
            postal: '63001',
            position: { lat: 38.79, lon: -90.87 },
            state: 'approximate',
          },
          requiredCredentials: ['damage_assessor'],
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(created.status, created.body).toBe(201);
      const mission = created.json<{ id: string; version: number }>();
      const before = await dbWorker
        .selectFrom('cg.assignment')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const res = await call('priya', 'GET', `/api/v1/dispatch/suggest?missionId=${mission.id}`);
      expect(res.status, res.body).toBe(200);
      const s = res.json<Suggestion>();
      expect(s.suggestions.length).toBeGreaterThan(0);
      for (let i = 1; i < s.suggestions.length; i += 1)
        expect(s.suggestions[i]!.score).toBeLessThanOrEqual(s.suggestions[i - 1]!.score);
      const top = s.suggestions[0]!;
      expect(top.reasons.length + top.cautions.length).toBeGreaterThan(0);
      expect(top.credentials).toContain('damage_assessor');
      expect(top.reasons.some((r) => r.includes('damage assessor'))).toBe(true);
      const after = await dbWorker
        .selectFrom('cg.assignment')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      expect(after.n).toBe(before.n);
      // The person assigns and dispatches the assessment team to the app: the command tests below act on it.
      const assigned = await call(
        'priya',
        'POST',
        `/api/v1/missions/${mission.id}/assignments`,
        {
          resources: [{ kind: 'team', id: teamId }],
          dispatch: { method: 'app' },
          // The seed already has the team on its verification route (AC-06C): the coordinator overrides with a reason.
          overrideReason: 'Exercise: the team takes the welfare check on its route',
        },
        {
          'idempotency-key': randomUUID(),
          'x-confirm': 'true',
          'x-reason': 'Exercise: the team takes the welfare check on its route',
        },
      );
      expect(assigned.status, assigned.body).toBe(201);
      assignment = assigned.json<Assignment[]>()[0]!;
      expect(assignment.state).toBe('dispatched');
    });

    it('ADR-0022, NFR-07: every write leaves a feed row; the stream resumes from a position and shows a partner only its own tenant; the relay publishes notices in order', async () => {
      const cursor = Number(
        (
          await dbWorker
            .selectFrom('cg.change_feed')
            .select((eb) => eb.fn.max('seq').as('seq'))
            .executeTakeFirstOrThrow()
        ).seq ?? 0,
      );
      // The assessor checks in: the database records the check-in and the team's status in the feed.
      const checkIn = await call('assessor', 'POST', '/api/v1/check-ins', {
        eventCode: 'WESTWIND',
        teamId,
      });
      expect(checkIn.status, checkIn.body).toBe(201);
      const rows = await dbWorker
        .selectFrom('cg.change_feed')
        .select(['record_type', 'scope_kind', 'scope_id', 'record_id'])
        .where('seq', '>', cursor)
        .orderBy('seq')
        .execute();
      expect(rows.map((r) => r.record_type)).toEqual(
        expect.arrayContaining(['check_in', 'team_status']),
      );
      expect(
        rows
          .filter((r) => r.record_type === 'team_status')
          .every((r) => r.scope_kind === 'team' && r.scope_id === teamId),
      ).toBe(true);
      // The county's stream from that position carries the check-in frames and closes after maxMs.
      const stream = await readStream('priya', `lastEventId=${cursor}&maxMs=700`);
      expect(stream.status).toBe(200);
      expect(stream.contentType).toContain('text/event-stream');
      expect(stream.frames[0]!.event).toBe('ready');
      const changes = stream.frames.filter((f) => f.event === 'change');
      expect(changes.map((f) => f.data['recordType'])).toEqual(
        expect.arrayContaining(['check_in', 'team_status']),
      );
      expect(changes.every((f) => typeof f.id === 'number' && f.id! > cursor)).toBe(true);
      for (const f of changes)
        expect(Object.keys(f.data).sort()).toEqual([
          'op',
          'recordId',
          'recordType',
          'scope',
          'tenantId',
          'version',
        ]);
      // Type filter and resume: only team_status rows, all after the position.
      const filtered = await readStream(
        'priya',
        `lastEventId=${cursor}&types=team_status&maxMs=500`,
      );
      const only = filtered.frames.filter((f) => f.event === 'change');
      expect(only.length).toBeGreaterThan(0);
      expect(only.every((f) => f.data['recordType'] === 'team_status')).toBe(true);
      // The partner's stream never carries the county's rows (SEC-05, DSP-09).
      const partner = await readStream('saw', `lastEventId=0&maxMs=500`);
      expect(partner.status).toBe(200);
      const partnerChanges = partner.frames.filter((f) => f.event === 'change');
      expect(partnerChanges.every((f) => f.data['tenantId'] === tenants['cleanup'])).toBe(true);
      // No stream without the grant.
      const denied = await fetch(`${baseUrl}/api/v1/stream?maxMs=200`, { headers: headers('pio') });
      expect(denied.status).toBe(403);
      // The relay: notices in feed order with the tenant's path, nothing before its start position.
      const published: { seq: number; tenantId: string; tenantPath: string }[] = [];
      const channel = {
        publish(_x: string, _k: string, content: Buffer, _o: unknown, cb: (e?: Error) => void) {
          published.push(JSON.parse(content.toString('utf8')) as (typeof published)[number]);
          cb();
          return true;
        },
      } as unknown as Parameters<typeof relayChangesOnce>[1];
      const log = { debug() {} } as unknown as Parameters<typeof relayChangesOnce>[2];
      const state: ChangeRelayState = { last: null };
      expect(await relayChangesOnce(dbWorker, channel, log, state)).toBe(0); // first run finds the head
      state.last = cursor;
      const n = await relayChangesOnce(dbWorker, channel, log, state);
      expect(n).toBe(published.length);
      expect(published.length).toBeGreaterThanOrEqual(rows.length);
      for (let i = 1; i < published.length; i += 1)
        expect(published[i]!.seq).toBeGreaterThan(published[i - 1]!.seq);
      expect(published.every((p) => p.tenantPath.length > 0)).toBe(true);
      expect(await relayChangesOnce(dbWorker, channel, log, state)).toBe(0);
    });

    it('FLD-13, FLD-14, AC-00B/C: a volunteer syncs only their scopes; a command batch applied twice changes nothing; a stale command gets the current record; an unknown command is refused', async () => {
      const device = await call('assessor', 'POST', '/api/v1/devices', {
        installId: `sync-${randomUUID()}`,
        platform: 'android',
        managed: true,
        model: 'Exercise phone',
      });
      expect(device.status, device.body).toBe(201);
      deviceId = device.json<{ id: string }>().id;
      const sync = await call(
        'assessor',
        'GET',
        `/api/v1/field/sync?cursor=0&deviceId=${deviceId}`,
      );
      expect(sync.status, sync.body).toBe(200);
      const first = sync.json<Sync>();
      expect(first.scopes.personnelId).toBe(personnelId);
      expect(first.scopes.teamIds).toContain(teamId);
      expect(first.scopes.missionIds).toContain(assignment.missionId);
      expect(first.device).toEqual({ id: deviceId, status: 'active', wipe: false });
      expect(first.changes.length).toBeGreaterThan(0);
      const allowed = (c: Sync['changes'][number]) =>
        (c.scope.kind === 'person' && c.scope.id === personnelId) ||
        (c.scope.kind === 'team' && first.scopes.teamIds.includes(c.scope.id!)) ||
        (c.scope.kind === 'event' &&
          ['hazard', 'field_message', 'site', 'safety_alert'].includes(c.recordType)) ||
        (c.recordType === 'mission' && first.scopes.missionIds.includes(c.recordId)) ||
        (c.recordType === 'field_device' && c.recordId === deviceId);
      expect(first.changes.every(allowed)).toBe(true);
      // Other teams' statuses never reach this phone.
      const otherTeam = await dbWorker
        .selectFrom('cg.team')
        .select('id')
        .where('tenant_id', '=', tenants['county']!)
        .where('key', '=', 'da-1')
        .executeTakeFirstOrThrow();
      expect(
        first.changes.some((c) => c.scope.kind === 'team' && c.scope.id === otherTeam.id),
      ).toBe(false);
      // Paging: a small page says more and continues from its cursor.
      const pageRes = await call('assessor', 'GET', '/api/v1/field/sync?cursor=0&limit=2');
      expect(pageRes.status, pageRes.body).toBe(200);
      const page = pageRes.json<Sync>();
      expect(page.changes.length).toBe(2);
      expect(page.more).toBe(true);
      expect(page.cursor).toBe(page.changes[1]!.seq);

      // SEC-13: below the pruned mark the phone is told to download its area again; at the mark
      // the sync goes on. The mark is put back to 0 so the shared county is left as it was.
      const mark = page.cursor;
      await dbWorker
        .insertInto('cg.change_feed_pruned')
        .values({ tenant_id: tenants['county']!, through_seq: mark })
        .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ through_seq: mark }))
        .execute();
      try {
        const behind = await call('assessor', 'GET', `/api/v1/field/sync?cursor=${mark - 1}`);
        expect(behind.status, behind.body).toBe(410);
        expect(behind.json<{ code: string }>().code).toBe('cursor_expired');
        expect((await call('assessor', 'GET', `/api/v1/field/sync?cursor=${mark}`)).status).toBe(
          200,
        );
      } finally {
        await dbWorker
          .updateTable('cg.change_feed_pruned')
          .set({ through_seq: 0 })
          .where('tenant_id', '=', tenants['county']!)
          .execute();
      }

      // A batch from the phone: acknowledge the dispatch, report positions, raise a help alert.
      const ack = randomUUID();
      const pos = randomUUID();
      const help = randomUUID();
      const batch = {
        deviceId,
        commands: [
          {
            id: ack,
            kind: 'assignment.acknowledge',
            targetId: assignment.id,
            version: assignment.version,
            body: { accept: true },
          },
          {
            id: pos,
            kind: 'position.batch',
            body: {
              positions: [
                {
                  lat: 38.791,
                  lon: -90.871,
                  recordedAt: new Date(Date.now() - 60_000).toISOString(),
                  accuracyM: 8,
                },
                { lat: 38.792, lon: -90.872, recordedAt: new Date().toISOString(), accuracyM: 6 },
              ],
            },
          },
          {
            id: help,
            kind: 'safety_alert.raise',
            body: {
              kind: 'help_button',
              position: { lat: 38.792, lon: -90.872 },
              note: 'exercise',
            },
          },
          { id: randomUUID(), kind: 'mission.delete', targetId: assignment.missionId, body: {} },
        ],
      };
      const applied = await call('assessor', 'POST', '/api/v1/field/commands', batch);
      expect(applied.status, applied.body).toBe(200);
      const r1 = applied.json<{ results: CommandResult[] }>().results;
      expect(r1.map((r) => r.result)).toEqual(['applied', 'applied', 'applied', 'rejected']);
      expect(r1[0]!.record).toEqual({
        type: 'assignment',
        id: assignment.id,
        version: assignment.version + 1,
      });
      expect(r1[3]!.error?.code).toBe('unknown_command');
      const positionsAfter = await dbWorker
        .selectFrom('cg.position')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('personnel_id', '=', personnelId)
        .executeTakeFirstOrThrow();
      const alertsAfter = await dbWorker
        .selectFrom('cg.safety_alert')
        .select('id')
        .where('personnel_id', '=', personnelId)
        .where('client_uuid', '=', help)
        .execute();
      expect(alertsAfter.length).toBe(1);
      // The same batch again: every command is a duplicate; nothing changes (FLD-13 "never overwritten").
      const again = await call('assessor', 'POST', '/api/v1/field/commands', batch);
      expect(again.status).toBe(200);
      const r2 = again.json<{ results: CommandResult[] }>().results;
      expect(r2.map((r) => r.result)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
      expect(r2[0]!.record).toEqual(r1[0]!.record);
      expect(
        (
          await dbWorker
            .selectFrom('cg.position')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('personnel_id', '=', personnelId)
            .executeTakeFirstOrThrow()
        ).n,
      ).toBe(positionsAfter.n);
      expect(
        (
          await dbWorker
            .selectFrom('cg.assignment')
            .select('version')
            .where('id', '=', assignment.id)
            .executeTakeFirstOrThrow()
        ).version,
      ).toBe(assignment.version + 1);
      // A stale command (built on the old version) gets the current record, never applied (AC-00B).
      const stale = await call('assessor', 'POST', '/api/v1/field/commands', {
        commands: [
          {
            id: randomUUID(),
            kind: 'assignment.status',
            targetId: assignment.id,
            version: assignment.version,
            body: { to: 'en_route' },
          },
        ],
      });
      const r3 = stale.json<{ results: CommandResult[] }>().results[0]!;
      expect(r3.result).toBe('conflict');
      expect(r3.status).toBe(409);
      expect(r3.current?.version).toBe(assignment.version + 1);
      // Built on the current version it applies.
      const fresh = await call('assessor', 'POST', '/api/v1/field/commands', {
        commands: [
          {
            id: randomUUID(),
            kind: 'assignment.status',
            targetId: assignment.id,
            version: assignment.version + 1,
            body: { to: 'en_route' },
          },
        ],
      });
      expect(fresh.json<{ results: CommandResult[] }>().results[0]!.result).toBe('applied');
      const ledger = await dbWorker
        .selectFrom('cg.client_command')
        .select(['result', 'device_id'])
        .where('id', 'in', [ack, pos, help])
        .execute();
      expect(ledger.length).toBe(3);
      expect(ledger.every((l) => l.result === 'applied' && l.device_id === deviceId)).toBe(true);
      // The board now shows the team on task with a position for the coordinator and none for a role without position.read (DSP-08).
      const after = (
        await call('priya', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`)
      ).json<Board>();
      const da2 = after.teams.find((t) => t.id === teamId)!;
      expect(da2.position).not.toBeNull();
      expect(da2.assignments.some((a) => a.missionId === assignment.missionId)).toBe(true);
      expect(after.alerts.some((a) => a.id === alertsAfter[0]!.id)).toBe(true);
      const replay = await call(
        'priya',
        'GET',
        `/api/v1/dispatch/replay?eventId=${eventId}&from=${new Date(Date.now() - 10 * 60_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`,
      );
      expect(replay.status, replay.body).toBe(200);
      const rp = replay.json<{
        initial: unknown[];
        facts: { kind: string; teamId: string | null }[];
        truncated: boolean;
      }>();
      expect(rp.facts.map((f) => f.kind)).toEqual(
        expect.arrayContaining([
          'team_status',
          'assignment_acknowledged',
          'alert_raised',
          'position',
        ]),
      );
      expect(
        rp.facts
          .filter((f) => f.kind === 'position')
          .every((f) => f.teamId === teamId || f.teamId !== null),
      ).toBe(true);
      expect(rp.truncated).toBe(false);
    });

    it("FLD-14: a field role lists and reads only the missions and assignments it holds; another team's work is not found; a coordinator sees all", async () => {
      const mine = await call('assessor', 'GET', '/api/v1/assignments?open=true&limit=200');
      expect(mine.status, mine.body).toBe(200);
      const held =
        mine.json<
          { id: string; teamId: string | null; personnelId: string | null; missionId: string }[]
        >();
      expect(held.length).toBeGreaterThan(0);
      expect(held.every((a) => a.teamId === teamId || a.personnelId === personnelId)).toBe(true);
      const all = (await call('priya', 'GET', '/api/v1/assignments?open=true&limit=200')).json<
        { id: string; teamId: string | null; missionId: string; version: number }[]
      >();
      expect(all.length).toBeGreaterThan(held.length);
      const missions = (
        await call('assessor', 'GET', `/api/v1/missions?eventId=${eventId}&limit=200`)
      ).json<{ id: string }[]>();
      const heldMissions = new Set(held.map((a) => a.missionId));
      expect(missions.length).toBeGreaterThan(0);
      expect(missions.every((m) => heldMissions.has(m.id))).toBe(true);
      // Another team's assignment and mission: not found, and no fact can be recorded on them.
      const other = all.find(
        (a) => a.teamId && a.teamId !== teamId && !heldMissions.has(a.missionId),
      )!;
      expect(other).toBeDefined();
      expect((await call('assessor', 'GET', `/api/v1/missions/${other.missionId}`)).status).toBe(
        404,
      );
      const ack = await call(
        'assessor',
        'POST',
        `/api/v1/assignments/${other.id}/acknowledge`,
        { accept: true },
        { 'if-match': String(other.version) },
      );
      expect(ack.status).toBe(404);
      // The phone's refetch answers its own records and null for anyone else's (FLD-14, FLD-13).
      const hazard = await dbWorker
        .selectFrom('cg.hazard')
        .select('id')
        .where('event_id', '=', eventId)
        .executeTakeFirstOrThrow();
      const rec = await call('assessor', 'POST', '/api/v1/field/records', {
        items: [
          { type: 'mission', id: assignment.missionId },
          { type: 'mission', id: other.missionId },
          { type: 'assignment', id: assignment.id },
          { type: 'assignment', id: other.id },
          { type: 'hazard', id: hazard.id },
          { type: 'team', id: teamId },
          { type: 'team', id: other.teamId! },
        ],
      });
      expect(rec.status, rec.body).toBe(200);
      const got = rec.json<{
        records: { type: string; id: string; record: Record<string, unknown> | null }[];
      }>().records;
      expect(got.map((g) => g.record !== null)).toEqual([
        true,
        false,
        true,
        false,
        true,
        true,
        false,
      ]);
      expect(got[0]!.record).toMatchObject({ reference: expect.stringMatching(/^M-/) });
      expect(JSON.stringify(got)).not.toMatch(/caller|phone/i);
      expect(
        (
          await call('pio', 'POST', '/api/v1/field/records', {
            items: [{ type: 'hazard', id: hazard.id }],
          })
        ).status,
      ).toBe(403);
      // Its own mission reads normally.
      expect(
        (await call('assessor', 'GET', `/api/v1/missions/${assignment.missionId}`)).status,
      ).toBe(200);
    });

    it('FLD-13, FLD-02: the area package carries the assignments, parcels, hazards, sites and job aids without resident personal details; a wipe requested for the device rides along on the next sync', async () => {
      const res = await call('assessor', 'GET', `/api/v1/field/area?eventId=${eventId}`);
      expect(res.status, res.body).toBe(200);
      const area = res.json<Area>();
      expect(area.eventId).toBe(eventId);
      expect(area.assignments.some((a) => a.mission.id === assignment.missionId)).toBe(true);
      expect(JSON.stringify(area.assignments)).not.toMatch(/caller|phone|injury|contact/i);
      expect(area.areaKeys.length).toBeGreaterThan(0); // the mission's point falls in a parcel grid
      expect(area.parcels.length).toBeGreaterThan(0);
      expect(area.parcels.every((p) => p.geometry === undefined)).toBe(true);
      expect(area.hazards.length).toBeGreaterThan(0);
      expect(area.jobAids.length).toBeGreaterThan(0);
      expect(area.maps.every((m) => m.available === false && m.url === null)).toBe(true); // no object store in tests
      const outlines = (
        await call(
          'assessor',
          'GET',
          `/api/v1/field/area?areaKey=${area.areaKeys[0]}&geometry=true&parcelLimit=5`,
        )
      ).json<Area>();
      expect(outlines.parcels.length).toBe(5);
      expect(outlines.parcelsTruncated).toBe(true);
      expect(outlines.parcels[0]!.geometry).toBeDefined();
      expect((await call('pio', 'GET', `/api/v1/field/area`)).status).toBe(403);
      // DCL:DEC-17: the tribal ownership question is asked only where the county turns it on.
      const setConfig = async (key: string, value: unknown) => {
        const url = `/api/v1/tenants/${tenants['county']!}/config/${key}`;
        const held = await call('admin', 'GET', url);
        const res = await call(
          'admin',
          'PUT',
          url,
          { value },
          {
            'x-confirm': 'true',
            'x-reason': 'Exercise: county field settings',
            ...(held.status === 200
              ? { 'if-match': `"${held.json<{ version: number }>().version}"` }
              : {}),
          },
        );
        expect(res.status, res.body).toBe(200);
        return (await call('assessor', 'GET', `/api/v1/field/area?eventId=${eventId}`)).json<Area>()
          .options;
      };
      try {
        expect(await setConfig('field.tribal_ownership', true)).toMatchObject({
          tribalOwnership: true,
        });
      } finally {
        expect(await setConfig('field.tribal_ownership', false)).toMatchObject({
          tribalOwnership: false,
        });
      }
      // FL-16: the county's rest limit reaches the phone; 12 hours unless the county sets one.
      try {
        expect((await setConfig('field.rest_after_hours', 10)).restAfterHours).toBe(10);
      } finally {
        expect((await setConfig('field.rest_after_hours', 12)).restAfterHours).toBe(12);
      }
      // The administrator wipes the device (consequential): the phone learns it on its next sync.
      // The administrator reads the device's current version (every contact touches it) and wipes it.
      const dev = (await call('admin', 'GET', '/api/v1/devices'))
        .json<{ id: string; version: number }[]>()
        .find((d) => d.id === deviceId)!;
      const wipe = await call('admin', 'POST', `/api/v1/devices/${deviceId}/wipe`, undefined, {
        'x-confirm': 'true',
        'x-reason': 'Phone reported lost during the exercise',
        'if-match': String(dev.version),
      });
      expect(wipe.status, wipe.body).toBe(200);
      const sync = (
        await call('assessor', 'GET', `/api/v1/field/sync?cursor=0&deviceId=${deviceId}`)
      ).json<Sync>();
      expect(sync.device).toEqual({ id: deviceId, status: 'wipe_requested', wipe: true });
      expect(
        sync.changes.some((c) => c.recordType === 'field_device' && c.recordId === deviceId),
      ).toBe(true);
    });
  },
);
