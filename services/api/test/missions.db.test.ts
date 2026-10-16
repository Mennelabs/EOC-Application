/**
 * Missions and assignments against a real PostgreSQL (layer-4 task C;
 * MIS-01–04, CALL-01, BRD:FR-02.01–02.06, FR-06.01–06.07, FR-07.01–07.06,
 * PPL-01, RULE-03, RULE-05, RULE-14, AC-02A/B/C, AC-04C, AC-06A/B/C/D,
 * AC-07A/B/C, PER-02, DSP-09, SEC-18): a call-taker's intake save opens a
 * mission with a reference, encrypted caller block and timeline; a retry
 * with the same key makes no second record; a missing prerequisite keeps a
 * draft; a lock refuses another person's edits; assignment of a team records
 * assigned only, with conflicts as warnings an override accepts; dispatch,
 * acknowledgement and arrival are separate facts; a priority change needs a
 * reason; closure needs a disposition and releases the team; narratives and
 * amendments keep the history; people involved mask restricted details by
 * category and audit reads; a partner dispatcher sees only its own work.
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

interface Mission {
  id: string;
  version: number;
  reference: string;
  state: string;
  priority: string;
  lock: { by: string } | null;
  caller?: { name?: string; phone?: string } | null;
  location: { line1: string | null; position: { lat: number; lon: number } | null } | null;
  dispatchBlockers: string[];
  assignments?: Assignment[];
  timeline?: {
    kind: string;
    narrativeRole: string | null;
    body: string | null;
    amendsEventId: string | null;
  }[];
}
interface Assignment {
  id: string;
  version: number;
  state: string;
  teamId: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  onSceneAt: string | null;
  releasedAt: string | null;
  conflicts: { kind: string }[];
}
interface ErrorBody {
  code: string;
  fields?: { name: string }[];
  details?: { conflicts?: { conflicts: { kind: string }[] }[] };
}

describe.skipIf(!appUrl || !workerUrl)('missions and assignments (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let tenants: Record<string, string>;
  let emsPersonnel = '';
  let subjects: Record<string, AccountSubject>;
  let eventId: string;
  let teams: Record<string, string>;
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${who}`,
    ...extra,
  });
  const confirmed = (reason: string, version?: number) => ({
    'x-confirm': 'true',
    'x-reason': reason,
    ...(version !== undefined ? { 'if-match': String(version) } : {}),
  });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    tenants = seeded.tenants;
    const paths = Object.fromEntries(
      (
        await dbWorker
          .selectFrom('cg.tenant')
          .select(['id', 'path', 'kind'])
          .where('id', 'in', Object.values(tenants))
          .execute()
      ).map((t) => [t.id, t]),
    );
    const event = await dbWorker
      .selectFrom('cg.event')
      .select('id')
      .where('tenant_id', '=', tenants['county']!)
      .where('intake_slug', '=', 'westwind')
      .executeTakeFirstOrThrow();
    eventId = event.id;
    // FL:FR-02: an EMS worker with their own account and roster entry.
    const emsAccount = (
      await dbWorker
        .insertInto('cg.account')
        .values({
          tenant_id: tenants['county']!,
          email: `ems-${randomUUID().slice(0, 8)}@example.org`,
          display_name: 'Exercise EMS medic',
          status: 'active',
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    emsPersonnel = (
      await dbWorker
        .insertInto('cg.personnel')
        .values({
          tenant_id: tenants['county']!,
          name: 'Exercise EMS medic',
          account_id: emsAccount,
          duty_status: 'on_duty',
          availability: 'available',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const subjectFor = (tenantKey: string, templateKey: string, accountId: string) => {
      const t = roleTemplates.find((r) => r.key === templateKey)!;
      const tenantId = tenants[tenantKey]!;
      return {
        kind: 'account' as const,
        accountId,
        tenantId,
        tenantPath: paths[tenantId]!.path,
        tenantKind: paths[tenantId]!.kind,
        status: 'active' as const,
        // Partner and field templates scope mission grants to assigned events (events: 'assigned').
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
      calltaker: subjectFor('county', 'dispatcher_call_taker', randomUUID()),
      tomas: subjectFor(
        'county',
        'public_information_officer',
        seeded.accounts['tomas.pio@example.org']!,
      ),
      counselor: subjectFor('county', 'crisis_counselor', randomUUID()),
      admin: subjectFor('county', 'tenant_admin', randomUUID()),
      ems: subjectFor('county', 'ems_medical_assist', emsAccount),
      saw: subjectFor(
        'cleanup',
        'agency_dispatcher',
        seeded.accounts['admin.cleanup@example.org']!,
      ),
      canteen: subjectFor(
        'canteen',
        'agency_dispatcher',
        seeded.accounts['ruth.canteen@example.org']!,
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
    const rows = await dbWorker.selectFrom('cg.team').select(['id', 'key']).execute();
    teams = Object.fromEntries(rows.map((r) => [r.key, r.id]));
  });

  afterAll(async () => {
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

  let mission: Mission;
  let assignment: Assignment;

  it('CALL-01: an intake save opens a mission with a reference, an encrypted caller block and a timeline; the same key replays, never a second record (AC-02A)', async () => {
    const key = randomUUID();
    const payload = {
      eventId,
      kind: 'welfare_check',
      source: 'call',
      priority: 'high',
      urgency: 'now',
      summary: 'Neighbour has not answered since the storm; oxygen concentrator at home.',
      caller: { name: 'Pat Example', phone: '+13145550177', role: 'neighbour' },
      callerLanguage: 'es',
      interpreterNeeded: true,
      location: {
        line1: '140 Cedar Ct',
        city: 'Harmon City',
        postal: '63002',
        position: { lat: 38.795, lon: -90.87 },
        state: 'approximate',
      },
      requiredCredentials: ['damage_assessor'],
    };
    const created = await call('calltaker', 'POST', '/api/v1/missions', payload, {
      'idempotency-key': key,
    });
    expect(created.status, created.body).toBe(201);
    mission = created.json<Mission>();
    expect(mission.reference).toMatch(/^M-\d{5}$/);
    expect(mission.state).toBe('open');
    expect(mission.caller?.name).toBe('Pat Example');
    expect(mission.dispatchBlockers).toEqual([]);
    const again = await call('calltaker', 'POST', '/api/v1/missions', payload, {
      'idempotency-key': key,
    });
    expect(again.status).toBe(201);
    expect(again.json<Mission>().id).toBe(mission.id);
    const stored = await dbWorker
      .selectFrom('cg.mission')
      .select(['caller_enc', 'summary'])
      .where('id', '=', mission.id)
      .executeTakeFirstOrThrow();
    expect(stored.caller_enc).not.toBeNull();
    expect(stored.caller_enc!.toString('utf8')).not.toContain('Pat Example');
    const read = await call('priya', 'GET', `/api/v1/missions/${mission.id}`);
    expect(read.status).toBe(200);
    const full = read.json<Mission>();
    expect(full.timeline!.map((t) => t.kind)).toEqual(['created', 'state_changed']);
    expect(full.caller?.phone).toBe('+13145550177');
    // The PIO holds no mission grant: nothing, not even existence (default deny).
    expect((await call('tomas', 'GET', `/api/v1/missions/${mission.id}`)).status).toBe(404);
    // A restricted read of the caller block is audited (SEC-18).
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('classification_read')
      .where('target_id', '=', mission.id)
      .where('action', '=', 'mission.read')
      .execute();
    expect(audited.some((a) => (a.classification_read as string[]).includes('contact'))).toBe(true);
  });

  it('AC-02B: a missing prerequisite blocks the intake save and leaves a draft that can open later; the draft cannot be dispatched', async () => {
    const res = await call(
      'calltaker',
      'POST',
      '/api/v1/missions',
      { eventId, kind: 'delivery', source: 'staff' },
      { 'idempotency-key': randomUUID() },
    );
    expect(res.status).toBe(422);
    const err = res.json<ErrorBody & { details: { missionId: string; state: string } }>();
    expect(err.code).toBe('dispatch_prerequisites');
    expect(err.fields!.map((f) => f.name).sort()).toEqual(['location', 'summary']);
    expect(err.details.state).toBe('draft');
    const draft = await call('priya', 'GET', `/api/v1/missions/${err.details.missionId}`);
    expect(draft.json<Mission>().state).toBe('draft');
    const assign = await call(
      'priya',
      'POST',
      `/api/v1/missions/${err.details.missionId}/assignments`,
      { resources: [{ kind: 'team', id: teams['da-2'] }] },
      { 'idempotency-key': randomUUID() },
    );
    expect(assign.status).toBe(422);
    const explicit = await call(
      'calltaker',
      'POST',
      '/api/v1/missions',
      { eventId, kind: 'delivery', source: 'staff', save: 'draft', summary: 'Water to Oak Hollow' },
      { 'idempotency-key': randomUUID() },
    );
    expect(explicit.status).toBe(201);
    expect(explicit.json<Mission>().state).toBe('draft');
  });

  it('RULE-05 / AC-02C: a locked mission refuses another person’s edits through every path, and a priority change needs a confirmed reason (MIS-03)', async () => {
    const lock = await call('priya', 'POST', `/api/v1/missions/${mission.id}/lock`, {
      reason: 'Working the call-back',
    });
    expect(lock.status).toBe(200);
    mission = lock.json<Mission>();
    expect(mission.lock?.by).toBe(subjects['priya']!.accountId);
    const other = await call(
      'calltaker',
      'PATCH',
      `/api/v1/missions/${mission.id}`,
      { summary: 'changed' },
      { 'if-match': String(mission.version) },
    );
    expect(other.status).toBe(423);
    const noReason = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/priority`,
      { priority: 'urgent' },
      { 'if-match': String(mission.version) },
    );
    expect(noReason.status).toBe(428);
    const changed = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/priority`,
      { priority: 'urgent' },
      confirmed('Oxygen-dependent resident; power still out', mission.version),
    );
    expect(changed.status, changed.body).toBe(200);
    mission = changed.json<Mission>();
    expect(mission.priority).toBe('urgent');
    const unlock = await call('priya', 'DELETE', `/api/v1/missions/${mission.id}/lock`, {});
    expect(unlock.status).toBe(200);
    mission = unlock.json<Mission>();
    expect(mission.lock).toBeNull();
  });

  it('assignment is a fact of its own (AC-06B, RULE-03); conflicts warn and an override accepts them with a reason (AC-06C, PER-02); one transaction (AC-06A)', async () => {
    // DA-1 is already on a verification route from the seed: double-booked; and a requirement it lacks.
    const conflicting = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/assignments`,
      { resources: [{ kind: 'team', id: teams['da-1'] }] },
      { 'idempotency-key': randomUUID() },
    );
    expect(conflicting.status, conflicting.body).toBe(409);
    const err = conflicting.json<ErrorBody>();
    expect(err.code).toBe('assignment_conflicts');
    expect(err.details!.conflicts![0]!.conflicts.map((c) => c.kind)).toContain('double_booked');
    const none = await dbWorker
      .selectFrom('cg.assignment')
      .select('id')
      .where('mission_id', '=', mission.id)
      .execute();
    expect(none).toHaveLength(0);
    const overridden = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/assignments`,
      {
        resources: [{ kind: 'team', id: teams['da-1'] }],
        overrideReason: 'DA-1 is two streets away; the route can wait',
      },
      {
        'idempotency-key': randomUUID(),
        ...confirmed('DA-1 is two streets away; the route can wait'),
      },
    );
    expect(overridden.status, overridden.body).toBe(201);
    assignment = overridden.json<Assignment[]>()[0]!;
    expect(assignment.state).toBe('assigned');
    expect(assignment.dispatchedAt).toBeNull();
    expect(assignment.onSceneAt).toBeNull();
    expect(assignment.conflicts.map((c) => c.kind)).toContain('double_booked');
    const twice = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/assignments`,
      { resources: [{ kind: 'team', id: teams['da-1'] }], overrideReason: 'again' },
      { 'idempotency-key': randomUUID(), ...confirmed('again') },
    );
    expect(twice.status).toBe(409);
    expect(twice.json<ErrorBody>().code).toBe('already_assigned');
    const stillOpen = await call('priya', 'GET', `/api/v1/missions/${mission.id}`);
    expect(stillOpen.json<Mission>().state).toBe('open'); // assignment never changes the mission's state
  });

  it('dispatch, delivery, acknowledgement and arrival are separate facts; a location suggestion is recorded, never applied (FR-06.05/06.06, DSP-05)', async () => {
    const dispatched = await call(
      'priya',
      'POST',
      `/api/v1/assignments/${assignment.id}/dispatch`,
      { method: 'radio' },
      { 'if-match': String(assignment.version) },
    );
    expect(dispatched.status, dispatched.body).toBe(200);
    assignment = dispatched.json<Assignment>();
    expect(assignment.state).toBe('dispatched');
    expect(assignment.dispatchedAt).not.toBeNull();
    expect(assignment.deliveredAt).toBeNull();
    const suggested = await call(
      'priya',
      'POST',
      `/api/v1/assignments/${assignment.id}/status`,
      { to: 'on_scene', suggested: true },
      { 'if-match': String(assignment.version) },
    );
    expect(suggested.status).toBe(200);
    assignment = suggested.json<Assignment>();
    expect(assignment.state).toBe('dispatched');
    expect(assignment.onSceneAt).toBeNull();
    const ack = await call(
      'priya',
      'POST',
      `/api/v1/assignments/${assignment.id}/acknowledge`,
      { accept: true },
      { 'if-match': String(assignment.version) },
    );
    expect(ack.status).toBe(200);
    assignment = ack.json<Assignment>();
    expect(assignment.acknowledgedAt).not.toBeNull();
    const arrived = await call(
      'priya',
      'POST',
      `/api/v1/assignments/${assignment.id}/status`,
      { to: 'on_scene' },
      { 'if-match': String(assignment.version) },
    );
    expect(arrived.status).toBe(200);
    assignment = arrived.json<Assignment>();
    expect(assignment.onSceneAt).not.toBeNull();
    const history = await dbWorker
      .selectFrom('cg.assignment_event')
      .select('kind')
      .where('assignment_id', '=', assignment.id)
      .orderBy('occurred_at')
      .execute();
    expect(history.map((h) => h.kind)).toEqual([
      'assigned',
      'override',
      'dispatched',
      'suggested_status',
      'acknowledged',
      'on_scene',
    ]);
    const stale = await call(
      'priya',
      'POST',
      `/api/v1/assignments/${assignment.id}/status`,
      { to: 'cleared' },
      { 'if-match': '1' },
    );
    expect(stale.status).toBe(409);
  });

  it('narratives by role and attributable amendments keep the history; an editable summary does not replace it (FR-07.01, AC-07A)', async () => {
    const note = await call('priya', 'POST', `/api/v1/missions/${mission.id}/narratives`, {
      role: 'responder',
      body: 'Door answered; resident on oxygen, generator running.',
    });
    expect(note.status).toBe(201);
    const noteId = note.json<{ id: string }>().id;
    const amend = await call('priya', 'POST', `/api/v1/missions/${mission.id}/narratives`, {
      role: 'supervisor',
      body: 'Correction: generator fuel for 6 hours only.',
      amendsEventId: noteId,
    });
    expect(amend.status).toBe(201);
    const current = await call('priya', 'GET', `/api/v1/missions/${mission.id}`);
    const m = current.json<Mission>();
    const summary = await call(
      'priya',
      'PATCH',
      `/api/v1/missions/${mission.id}`,
      { summary: 'Welfare check done; fuel resupply needed.' },
      { 'if-match': String(m.version) },
    );
    expect(summary.status, summary.body).toBe(200);
    const after = (await call('priya', 'GET', `/api/v1/missions/${mission.id}`)).json<Mission>();
    const kinds = after.timeline!.map((t) => t.kind);
    expect(kinds).toContain('narrative');
    expect(kinds).toContain('amendment');
    expect(after.timeline!.find((t) => t.kind === 'amendment')?.amendsEventId).toBe(noteId);
    expect(after.timeline!.find((t) => t.kind === 'narrative')?.body).toContain('Door answered');

    // AC-08A: a narrative written after the fact keeps when it happened and when it was
    // recorded; a time ahead of now is refused.
    const happened = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const lateNote = await call('priya', 'POST', `/api/v1/missions/${mission.id}/narratives`, {
      role: 'responder',
      body: 'Earlier: checked the neighbour too; no one home.',
      occurredAt: happened,
    });
    expect(lateNote.status, lateNote.body).toBe(201);
    const late = lateNote.json<{ id: string; occurredAt: string; recordedAt: string }>();
    expect(late.occurredAt).toBe(happened);
    expect(new Date(late.recordedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const listed = (await call('priya', 'GET', `/api/v1/missions/${mission.id}`))
      .json<{ timeline: { id: string; recordedAt: string }[] }>()
      .timeline.find((t) => t.id === late.id)!;
    expect(listed.recordedAt).toBe(late.recordedAt);
    const ahead = await call('priya', 'POST', `/api/v1/missions/${mission.id}/narratives`, {
      role: 'responder',
      body: 'Dated an hour ahead by a fast clock.',
      occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(ahead.status).toBe(400);
  });

  it('people involved: restricted details by category, behavioural health only for counseling, every restricted read audited (PPL-01, AC-04C, SEC-18)', async () => {
    const added = await call('priya', 'POST', `/api/v1/missions/${mission.id}/people`, {
      role: 'survivor',
      displayLabel: 'resident',
      details: { name: 'R. Example', phone: '+13145550188' },
      injury: 'none',
      behavioralHealth: 'Anxious; asked for someone to talk with.',
    });
    expect(added.status, added.body).toBe(201);
    const coordinatorRead = await call('priya', 'GET', `/api/v1/missions/${mission.id}/people`);
    expect(coordinatorRead.status, coordinatorRead.body).toBe(200);
    const asCoordinator =
      coordinatorRead.json<{ details?: unknown; behavioralHealth?: string }[]>();
    expect(asCoordinator[0]!.details).toEqual({ name: 'R. Example', phone: '+13145550188' });
    expect(asCoordinator[0]!.behavioralHealth).toBeUndefined();
    const asCounselor = (
      await call('counselor', 'GET', `/api/v1/missions/${mission.id}/people`)
    ).json<{ details?: unknown; behavioralHealth?: string }[]>();
    expect(asCounselor[0]!.behavioralHealth).toContain('Anxious');
    const stored = await dbWorker
      .selectFrom('cg.mission_person')
      .select(['details_enc', 'behavioral_health_enc'])
      .where('mission_id', '=', mission.id)
      .executeTakeFirstOrThrow();
    expect(stored.details_enc!.toString('utf8')).not.toContain('Example');
    expect(stored.behavioral_health_enc!.toString('utf8')).not.toContain('Anxious');
    const reads = await dbWorker
      .selectFrom('cg.audit_event')
      .select('classification_read')
      .where('action', '=', 'mission.person.read')
      .where('target_id', '=', mission.id)
      .execute();
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('closure needs a disposition (AC-07C) and releases what is still assigned, keeping the history (AC-06D, FR-06.07); reopening needs a reason', async () => {
    let m = (await call('priya', 'GET', `/api/v1/missions/${mission.id}`)).json<Mission>();
    const missing = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/close`,
      {},
      confirmed('Done on scene', m.version),
    );
    expect(missing.status).toBe(400);
    expect(missing.json<ErrorBody>().fields!.map((f) => f.name)).toContain('disposition');
    const closed = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/close`,
      { disposition: 'completed', dispositionNote: 'Resident safe; fuel delivered by DA-1.' },
      confirmed('Done on scene', m.version),
    );
    expect(closed.status, closed.body).toBe(200);
    m = closed.json<Mission>();
    expect(m.state).toBe('closed');
    const released = (
      await call('priya', 'GET', `/api/v1/assignments?missionId=${mission.id}`)
    ).json<Assignment[]>();
    expect(released[0]!.state).toBe('released');
    expect(released[0]!.onSceneAt).not.toBeNull(); // history kept
    const reopened = await call(
      'priya',
      'POST',
      `/api/v1/missions/${mission.id}/reopen`,
      {},
      confirmed('Resident called back: generator failed', m.version),
    );
    expect(reopened.status, reopened.body).toBe(200);
    expect(reopened.json<Mission>().state).toBe('open');
  });

  it('DSP-09: an agency dispatcher sees only the missions its organization owns or works, and assigns only its own teams', async () => {
    const sawList = (await call('saw', 'GET', `/api/v1/missions?eventId=${eventId}`)).json<
      Mission[]
    >();
    expect(sawList.length).toBeGreaterThanOrEqual(1); // the seeded cleanup work order it owns
    expect(sawList.every((x) => x.id !== mission.id)).toBe(true);
    expect((await call('saw', 'GET', `/api/v1/missions/${mission.id}`)).status).toBe(404);
    const canteenList = (await call('canteen', 'GET', `/api/v1/missions?eventId=${eventId}`)).json<
      Mission[]
    >();
    expect(canteenList.map((x) => x.id)).not.toContain(sawList[0]!.id);
    // The county assigns a partner's team; the partner then sees the mission and works the assignment.
    const m = (await call('priya', 'GET', `/api/v1/missions/${mission.id}`)).json<Mission>();
    const assigned = await call(
      'priya',
      'POST',
      `/api/v1/missions/${m.id}/assignments`,
      {
        resources: [{ kind: 'team', id: teams['chainsaw-b'] }],
        overrideReason: 'Needs a saw crew for the downed tree',
      },
      { 'idempotency-key': randomUUID(), ...confirmed('Needs a saw crew for the downed tree') },
    );
    expect(assigned.status, assigned.body).toBe(201);
    const theirs = (await call('saw', 'GET', `/api/v1/missions/${mission.id}`)).json<Mission>();
    expect(theirs.id).toBe(mission.id);
    expect(theirs.caller).toBeUndefined(); // no caller block for the partner's reading
    const a = assigned.json<Assignment[]>()[0]!;
    const ack = await call(
      'saw',
      'POST',
      `/api/v1/assignments/${a.id}/acknowledge`,
      { accept: true },
      { 'if-match': String(a.version) },
    );
    expect(ack.status, ack.body).toBe(200);
    // The partner cannot assign the county's team to its own work order.
    const own = sawList[0]!;
    const foreign = await call(
      'saw',
      'POST',
      `/api/v1/missions/${own.id}/assignments`,
      { resources: [{ kind: 'team', id: teams['da-3'] }] },
      { 'idempotency-key': randomUUID() },
    );
    expect([400, 422]).toContain(foreign.status);
  });

  it('RULE-04, BRD:FR-06.04, MIS-02: the status moves along its graph only; cleared is not closed, and closing after it needs a disposition; a move the graph does not allow is refused; cancel needs a reason and ends the mission', async () => {
    const make = async (summary: string) => {
      const res = await call(
        'calltaker',
        'POST',
        '/api/v1/missions',
        {
          eventId,
          kind: 'delivery',
          source: 'call',
          priority: 'normal',
          urgency: 'soon',
          summary,
          location: {
            line1: '9 Exercise Row',
            city: 'Harmon City',
            postal: '63002',
            position: { lat: 38.79, lon: -90.86 },
            state: 'approximate',
          },
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(res.status, res.body).toBe(201);
      return res.json<Mission>();
    };
    const move = (m: Mission, to: string) =>
      call(
        'priya',
        'POST',
        `/api/v1/missions/${m.id}/transitions`,
        { to },
        { 'if-match': String(m.version) },
      );

    let m = await make('Exercise: water to the clinic.');
    for (const to of ['en_route', 'on_scene', 'cleared']) {
      const r = await move(m, to);
      expect(r.status, `${to}: ${r.body}`).toBe(200);
      m = r.json<Mission>();
      expect(m.state).toBe(to);
    }
    // Cleared is the crew's word, not the end: the mission stays open to close.
    const back = await move(m, 'en_route');
    expect(back.status).toBe(400);
    expect(back.json<ErrorBody>().fields?.[0]?.name).toBe('to');
    const closed = await call(
      'priya',
      'POST',
      `/api/v1/missions/${m.id}/close`,
      { disposition: 'completed' },
      confirmed('Exercise: delivered and signed for', m.version),
    );
    expect(closed.status, closed.body).toBe(200);
    m = closed.json<Mission>();
    expect(m.state).toBe('closed');
    expect((await move(m, 'on_scene')).status).toBe(400);

    // Cancel: a reason first, then the mission ends and nothing moves it.
    let c = await make('Exercise: duplicate call about the clinic.');
    const unreasoned = await call(
      'priya',
      'POST',
      `/api/v1/missions/${c.id}/cancel`,
      {},
      { 'if-match': String(c.version) },
    );
    expect(unreasoned.status).toBe(428);
    const canceled = await call(
      'priya',
      'POST',
      `/api/v1/missions/${c.id}/cancel`,
      {},
      confirmed('Exercise: the same call came in twice', c.version),
    );
    expect(canceled.status, canceled.body).toBe(200);
    c = canceled.json<Mission>();
    expect(c.state).toBe('canceled');
    expect((await move(c, 'open')).status).toBe(400);
    const twice = await call(
      'priya',
      'POST',
      `/api/v1/missions/${c.id}/cancel`,
      {},
      confirmed('Exercise: again', c.version),
    );
    expect(twice.status).toBe(400);
  });

  it('BRD:FR-05.05, AC-05B: an archived person and an archived team stay readable with their history; assigning the archived person is a conflict only an override with a reason accepts', async () => {
    const person = await dbWorker
      .insertInto('cg.personnel')
      .values({
        tenant_id: tenants['county']!,
        name: `Exercise Archived Person ${randomUUID().slice(0, 6)}`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const archived = await call(
      'admin',
      'POST',
      `/api/v1/personnel/${person.id}/archive`,
      {},
      confirmed('Exercise: moved out of the county', person.version),
    );
    expect(archived.status, archived.body).toBe(200);
    const read = await call('admin', 'GET', `/api/v1/personnel/${person.id}`);
    expect(read.status).toBe(200);
    expect(read.json<{ status: string; name: string }>()).toMatchObject({
      status: 'archived',
      name: person.name,
    });
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'reason'])
      .where('target_id', '=', person.id)
      .execute();
    expect(audited).toContainEqual({
      action: 'personnel.archive',
      reason: 'Exercise: moved out of the county',
    });

    const team = await dbWorker
      .insertInto('cg.team')
      .values({
        tenant_id: tenants['county']!,
        key: `ex-arch-${randomUUID().slice(0, 6)}`,
        name: 'Exercise archived crew',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const teamArchived = await call(
      'priya',
      'POST',
      `/api/v1/teams/${team.id}/archive`,
      {},
      confirmed('Exercise: crew disbanded', team.version),
    );
    expect(teamArchived.status, teamArchived.body).toBe(200);
    const history = await call('priya', 'GET', `/api/v1/teams/${team.id}`);
    expect(history.status).toBe(200);
    const t = history.json<{
      status: string;
      history?: { status: string; note: string | null }[];
    }>();
    expect(t.status).toBe('archived');
    expect(t.history?.[0]).toMatchObject({
      status: 'out_of_service',
      note: 'Exercise: crew disbanded',
    });

    // AC-05B: the archived person is a conflict; only an override with a reason accepts it.
    const m = (
      await call(
        'calltaker',
        'POST',
        '/api/v1/missions',
        {
          eventId,
          kind: 'welfare_check',
          source: 'call',
          priority: 'normal',
          urgency: 'soon',
          summary: "Exercise: check on the archived volunteer's old route.",
          location: {
            line1: '3 Exercise Lane',
            city: 'Harmon City',
            postal: '63002',
            position: { lat: 38.791, lon: -90.861 },
            state: 'approximate',
          },
        },
        { 'idempotency-key': randomUUID() },
      )
    ).json<Mission>();
    const refused = await call(
      'priya',
      'POST',
      `/api/v1/missions/${m.id}/assignments`,
      { resources: [{ kind: 'person', id: person.id }] },
      { 'idempotency-key': randomUUID() },
    );
    expect(refused.status, refused.body).toBe(409);
    expect(
      refused.json<ErrorBody>().details!.conflicts![0]!.conflicts.map((c) => c.kind),
    ).toContain('inactive');
    const accepted = await call(
      'priya',
      'POST',
      `/api/v1/missions/${m.id}/assignments`,
      {
        resources: [{ kind: 'person', id: person.id }],
        overrideReason: 'Exercise: they agreed to help one last time',
      },
      {
        'idempotency-key': randomUUID(),
        ...confirmed('Exercise: they agreed to help one last time'),
      },
    );
    expect(accepted.status, accepted.body).toBe(201);
    const a = accepted.json<Assignment[]>()[0]!;
    expect(a.conflicts.map((c) => c.kind)).toContain('inactive');
  });

  it('FL:FR-02, DSP-13: EMS sees only the missions it is assigned to, and on them the people involved by injury and transport, never their details or health notes; it creates and dispatches nothing', async () => {
    const make = async (summary: string) =>
      (
        await call(
          'calltaker',
          'POST',
          '/api/v1/missions',
          {
            eventId,
            kind: 'welfare_check',
            source: 'call',
            priority: 'high',
            urgency: 'now',
            summary,
            location: {
              line1: '21 Exercise Ct',
              city: 'Harmon City',
              postal: '63002',
              position: { lat: 38.793, lon: -90.865 },
              state: 'approximate',
            },
          },
          { 'idempotency-key': randomUUID() },
        )
      ).json<Mission>();
    const theirs = await make('Exercise: fall at home, needs a medic.');
    const other = await make('Exercise: unrelated welfare check.');
    const assigned = await call(
      'priya',
      'POST',
      `/api/v1/missions/${theirs.id}/assignments`,
      {
        resources: [{ kind: 'person', id: emsPersonnel }],
        overrideReason: 'Exercise: the medic is closest',
      },
      { 'idempotency-key': randomUUID(), ...confirmed('Exercise: the medic is closest') },
    );
    expect(assigned.status, assigned.body).toBe(201);
    const person = await call('priya', 'POST', `/api/v1/missions/${theirs.id}/people`, {
      role: 'survivor',
      displayLabel: 'resident',
      details: { name: 'E. Example', phone: '+13145550133' },
      injury: 'minor',
      transport: 'ems',
      behavioralHealth: 'Exercise: shaken after the fall.',
    });
    expect(person.status, person.body).toBe(201);

    expect((await call('ems', 'GET', `/api/v1/missions/${theirs.id}`)).status).toBe(200);
    expect((await call('ems', 'GET', `/api/v1/missions/${other.id}`)).status).toBe(404);
    const people = await call('ems', 'GET', `/api/v1/missions/${theirs.id}/people`);
    expect(people.status, people.body).toBe(200);
    const seen = people.json<Record<string, unknown>[]>()[0]!;
    expect(seen).toMatchObject({ injury: 'minor', transport: 'ems' });
    expect(seen['details']).toBeUndefined();
    expect(seen['behavioralHealth']).toBeUndefined();
    // No mission of its own, no dispatch board, no 911-style dispatch (DSP-13).
    expect(
      (
        await call(
          'ems',
          'POST',
          '/api/v1/missions',
          { eventId, kind: 'welfare_check', source: 'call', summary: 'Exercise' },
          { 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(403);
    expect((await call('ems', 'GET', '/api/v1/dispatch/board')).status).toBe(403);
  });

  it('AC-03B: a location said to be unknown is kept as words only, never as a point, even when a point is sent; the board shows the mission with no position and says the location is unknown', async () => {
    const res = await call(
      'calltaker',
      'POST',
      '/api/v1/missions',
      {
        eventId,
        kind: 'welfare_check',
        source: 'call',
        priority: 'high',
        urgency: 'now',
        summary: 'Exercise: caller unsure where they are, somewhere along the river.',
        location: {
          landmark: 'Exercise: somewhere along the river road',
          position: { lat: 38.8, lon: -90.88 },
          state: 'unknown',
        },
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(res.status, res.body).toBe(201);
    const m = res.json<Mission>();
    expect(m.location?.position).toBeNull();
    const geom = await dbWorker
      .selectFrom('cg.mission as mi')
      .innerJoin('cg.location as l', 'l.id', 'mi.location_id')
      .select(sql<boolean>`l.geom is null`.as('none'))
      .where('mi.id', '=', m.id)
      .executeTakeFirstOrThrow();
    expect(geom.none).toBe(true);
    const board = await call('priya', 'GET', `/api/v1/dispatch/board?eventId=${eventId}`);
    expect(board.status, board.body).toBe(200);
    const b = board.json<{
      queue: { id: string; position: unknown; locationState: string }[];
      active: { id: string; position: unknown; locationState: string }[];
    }>();
    const shown = [...b.queue, ...b.active].find((x) => x.id === m.id);
    expect(shown).toMatchObject({ position: null, locationState: 'unknown' });
  });
});
