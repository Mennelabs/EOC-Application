/**
 * The command window's engine against a real PostgreSQL (layer-7 task B;
 * ADR-0044; CMD-08, CMD-09, CMD-12, CMD-21–CMD-28, CMD-37, BRD:FR-C03–C07,
 * AC-C02, AC-C04, AC-C05, AC-C06, AC-C08, AC-02C, Section 30.2). Lookups run
 * at once; a change waits for a confirmation bound to its plan; confirming
 * twice changes nothing twice; a record changed in between makes the plan
 * stale; a role lost in between blocks it; a locked mission refuses the
 * command as it refuses the screen; undo is a linked execution, once, inside
 * its window; free text leaves the execution record once it has run; phases
 * beyond 1 and 2 are off until the county turns them on. Runs on a county of
 * its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Execution {
  id: string | null;
  executionId: string;
  status: string;
  message: string;
  plan: {
    description: string;
    args: Record<string, unknown>;
    target: { id: string; version: number } | null;
  } | null;
  planHash: string | null;
  options: { id: string; label: string }[];
  result: { state: string; summary: string | null; records: { kind: string; id: string }[] } | null;
  error: { status: number; code: string } | null;
  undoUntil: string | null;
  undoneBy: string | null;
  reversalOf: string | null;
  commands: { name: string; enabled: boolean; allowed: boolean }[];
}

describe.skipIf(!appUrl || !workerUrl)('the command window engine (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const ref = (n: number) => `CMD${run.slice(0, 4).toUpperCase()}${n}`.slice(0, 12);

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  const command = async (who: string, input: string, extra: Record<string, unknown> = {}) => {
    const r = await call(who, 'POST', '/commands', { executionId: randomUUID(), input, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as unknown as Execution;
  };
  const confirm = async (who: string, e: Execution, headers: Record<string, string> = {}) =>
    call(who, 'POST', `/commands/${e.id}/confirm`, { planHash: e.planHash }, headers);
  const need = (id: string) =>
    dbWorker
      .selectFrom('cg.need')
      .select(['status', 'claimed_by_tenant_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const stored = (id: string) =>
    dbWorker
      .selectFrom('cg.command_execution')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const needIds: string[] = [];
  let missionId = '';
  let missionRef = '';

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-commands-${run}`,
        name: `Exercise commands county ${run}`,
        status: 'provisioning',
        timezone: 'America/Chicago',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      eventId = (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise commands storm ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      for (const [i, category] of ['food', 'water'].entries())
        needIds.push(
          (
            await trx
              .insertInto('cg.need')
              .values({
                tenant_id: county,
                event_id: eventId,
                category,
                detail: null,
                source: 'staff',
                reference_code: ref(i + 1),
                report_id: null,
                subject_party_id: null,
                claimed_by_tenant_id: null,
                claimed_by_account_id: null,
                claimed_at: null,
                assigned_by_account_id: null,
                released_at: null,
                done_at: null,
                done_note: null,
                location_id: null,
                contact_party_id: null,
                execution_id: null,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id,
        );
    });
    const as = (template: string): AccountSubject => {
      const t = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId: randomUUID(),
        tenantId: county,
        tenantPath: c.path,
        tenantKind: c.kind,
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
    subjects['mc'] = as('mass_care_coordinator');
    subjects['mc2'] = as('mass_care_coordinator');
    subjects['field'] = as('field_coordinator');
    subjects['calltaker'] = as('dispatcher_call_taker');
    subjects['pio'] = as('public_information_officer');
    subjects['admin'] = as('tenant_admin');
    subjects['planner'] = as('reporting_planning');
    const loader: SubjectLoader = {
      async fromBearer(token) {
        const s = subjects[token];
        if (!s) throw new AuthError('invalid_token');
        return s;
      },
    };
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      subjects: loader,
      routes: routesWith(),
    });
    const m = await call('calltaker', 'POST', '/missions', {
      eventId,
      kind: 'welfare_check',
      source: 'call',
      priority: 'high',
      urgency: 'now',
      summary: 'Exercise: check on a neighbour after the storm.',
      location: {
        line1: '12 Exercise Way',
        city: 'Harmon City',
        postal: '63002',
        position: { lat: 38.79, lon: -90.87 },
        state: 'approximate',
      },
    });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    missionId = m.body['id'] as string;
    missionRef = m.body['reference'] as string;
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', county)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('CMD-12: only catalogued shorthand runs; plain language without the assistant and unknown verbs are answered as unsupported, never as done', async () => {
    expect((await command('mc', 'please claim the food need')).status).toBe('unsupported');
    const unknown = await command('mc', '/dispatch everyone');
    expect(unknown.status).toBe('unsupported');
    expect(unknown.message).toContain('/help');
    const help = await command('mc', '/ayuda');
    expect(help.status).toBe('help');
    expect(help.commands.find((c) => c.name === 'need.claim')).toMatchObject({
      enabled: true,
      allowed: true,
    });
    // Section 30.2: phase 3 is off until the county turns it on.
    expect(help.commands.find((c) => c.name === 'mission.status')?.enabled).toBe(false);
  });

  it('Section 30.2: lookups and drafts run at once, with results from the operation itself (CMD-26)', async () => {
    const found = await command('mc', `/needs ${ref(1)}`);
    expect(found.status, found.message).toBe('succeeded');
    expect(found.result?.records.map((r) => r.id)).toEqual([needIds[0]]);
    expect(found.message).toContain(ref(1));
    const missions = await command('field', '/misiones abiertas');
    expect(missions.status).toBe('succeeded');
    expect(missions.result?.records.map((r) => r.id)).toContain(missionId);
    // The execution record keeps which records, not what the lookup said.
    const row = await stored(found.id!);
    expect((row.result as { verified: { summary: string } }).verified.summary).toBe('');
    const draft = await command('planner', '/sitrep 6');
    expect(draft.status, draft.message).toBe('succeeded');
    expect(draft.result?.state).toBe('drafted');
    expect(draft.message).toContain('not issued');
  });

  it('CMD-21: a role without the action is refused before anything is planned', async () => {
    const r = await command('pio', `/need ${ref(1)} claim`);
    expect(r.status).toBe('denied');
    expect(r.id).toBeNull();
  });

  it('AC-C06, CMD-25: a change waits for a confirmation bound to its plan; confirming twice claims once; the same execution id returns the same execution', async () => {
    const executionId = randomUUID();
    const prepared = (
      await call('mc', 'POST', '/commands', {
        executionId,
        input: `/need ${ref(1)} claim note:"Exercise: our pantry has it"`,
      })
    ).body as unknown as Execution;
    expect(prepared.status).toBe('awaiting_confirmation');
    expect(prepared.plan?.description).toContain(ref(1));
    expect((await need(needIds[0]!)).status).toBe('open');
    const again = (
      await call('mc', 'POST', '/commands', { executionId, input: `/need ${ref(1)} claim` })
    ).body as unknown as Execution;
    expect(again.id).toBe(prepared.id);
    // A different plan than the one shown is refused.
    const wrong = await call('mc', 'POST', `/commands/${prepared.id}/confirm`, {
      planHash: '0'.repeat(64),
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body['code']).toBe('plan_changed');
    const done = await confirm('mc', prepared);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body['status']).toBe('succeeded');
    expect(await need(needIds[0]!)).toMatchObject({
      status: 'claimed',
      claimed_by_tenant_id: county,
    });
    const twice = await confirm('mc', prepared);
    expect(twice.body['status']).toBe('succeeded');
    const claims = await dbWorker
      .selectFrom('cg.need_event')
      .select('kind')
      .where('need_id', '=', needIds[0]!)
      .where('kind', '=', 'claimed')
      .execute();
    expect(claims).toHaveLength(1);
    // CMD-37: the execution is audited; the note left the execution record once it ran.
    const row = await stored(prepared.id!);
    expect(row).toMatchObject({ state: 'succeeded', confirmed_by: subjects['mc']!.accountId });
    expect(JSON.stringify(row.plan)).not.toContain('pantry');
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', county)
      .where('target_id', '=', prepared.id!)
      .execute();
    expect(audited.map((a) => a.action)).toEqual(['command.execute']);
  });

  it('AC-C08, CMD-28: undo is a linked execution, once, inside its window', async () => {
    const claimed = (await call('mc', 'GET', '/commands?limit=50')).body as unknown as Execution[];
    const original = claimed.find((e) => e.status === 'succeeded' && e.undoUntil)!;
    expect(original).toBeTruthy();
    const executionId = randomUUID();
    const undone = await call('mc', 'POST', `/commands/${original.id}/undo`, { executionId });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body).toMatchObject({ status: 'succeeded', reversalOf: original.id });
    expect((await need(needIds[0]!)).status).toBe('open');
    expect((await stored(original.id!)).undone_by).toBe(undone.body['id']);
    // The same undo again returns the same execution; a new one is refused.
    const replay = await call('mc', 'POST', `/commands/${original.id}/undo`, { executionId });
    expect(replay.body['id']).toBe(undone.body['id']);
    const another = await call('mc', 'POST', `/commands/${original.id}/undo`, {
      executionId: randomUUID(),
    });
    expect(another.status).toBe(409);
    expect(another.body['code']).toBe('undo_unavailable');
  });

  it('AC-C04, CMD-09: a record changed between the plan and the confirmation makes the plan stale; nothing runs', async () => {
    const prepared = await command('mc', `/need ${ref(2)} claim`);
    expect(prepared.status).toBe('awaiting_confirmation');
    // Someone else claims it by hand in between.
    const byHand = await call('mc2', 'POST', `/needs/${needIds[1]}/claim`, {});
    expect(byHand.status).toBe(200);
    const late = await confirm('mc', prepared);
    expect(late.status).toBe(409);
    expect(late.body['code']).toBe('plan_stale');
    expect((await stored(prepared.id!)).state).toBe('stale');
    await call('mc2', 'POST', `/needs/${needIds[1]}/release`, {});
  });

  it('AC-C05, CMD-21: a role taken away between the plan and the confirmation blocks the execution', async () => {
    const prepared = await command('mc', `/need ${ref(2)} claim`);
    expect(prepared.status).toBe('awaiting_confirmation');
    const before = subjects['mc']!;
    subjects['mc'] = { ...before, roles: [] };
    try {
      expect((await confirm('mc', prepared)).status).toBe(403);
    } finally {
      subjects['mc'] = before;
    }
    expect((await need(needIds[1]!)).status).toBe('open');
    expect((await stored(prepared.id!)).state).toBe('awaiting_confirmation');
  });

  it('CMD-27: a plan can be cancelled before it runs, and its free text goes with it', async () => {
    const prepared = await command('field', `/mission ${missionRef} note Exercise: private detail`);
    expect(prepared.status).toBe('awaiting_confirmation');
    const canceled = await call('field', 'POST', `/commands/${prepared.id}/cancel`);
    expect(canceled.body['status']).toBe('canceled');
    expect(JSON.stringify((await stored(prepared.id!)).plan)).not.toContain('private detail');
    expect((await confirm('field', prepared)).body['status']).toBe('canceled');
  });

  it('CMD-08, AC-C02: more than one match asks which one, among records the person may see', async () => {
    for (const title of ['Exercise check generator', 'Exercise check generator fuel'])
      expect((await command('field', `/remind in 30m ${title}`)).status).toBe(
        'awaiting_confirmation',
      );
    const pending = (await call('field', 'GET', '/commands?limit=50'))
      .body as unknown as Execution[];
    for (const e of pending.filter(
      (x) => x.status === 'awaiting_confirmation' && x.plan?.description.includes('generator'),
    ))
      expect((await confirm('field', e)).body['status']).toBe('succeeded');
    const ask = await command('field', '/reminder generator done Exercise: refuelled');
    expect(ask.status).toBe('clarify');
    expect(ask.options).toHaveLength(2);
    const chosen = ask.options.find((o) => o.label.includes('fuel'))!;
    const done = await command('field', '/reminder generator done Exercise: refuelled', {
      targetId: chosen.id,
    });
    expect(done.status).toBe('awaiting_confirmation');
    expect((await confirm('field', done)).body['status']).toBe('succeeded');
    // Someone else's reminders are not matched at all.
    expect((await command('mc', '/reminder generator done Exercise: refuelled')).status).toBe(
      'not_found',
    );
  });

  it('CMD-10: "14:30" is read on the organization\'s clock', async () => {
    const r = await command('field', '/remind 14:30 Exercise shift change');
    expect(r.status).toBe('awaiting_confirmation');
    const due = new Date(r.plan!.args['dueAt'] as string);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(due);
    expect(local).toBe('14:30');
    await call('field', 'POST', `/commands/${r.id}/cancel`);
  });

  it('Section 30.2 phase 3 and AC-02C: status changes once the county turns them on; a locked mission refuses the command as it refuses the screen', async () => {
    expect((await command('field', `/mission ${missionRef} status en_route`)).status).toBe(
      'unsupported',
    );
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'command.phases', value: JSON.stringify([1, 2, 3]) })
        .execute(),
    );
    const locked = await call('admin', 'POST', `/missions/${missionId}/lock`, {
      reason: 'Exercise: editing the call',
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    const blocked = await command('field', `/mission ${missionRef} status on_scene`);
    expect(blocked.status).toBe('awaiting_confirmation');
    const refused = await confirm('field', blocked);
    expect(refused.body['status']).toBe('failed');
    expect((refused.body['error'] as { status: number }).status).toBeGreaterThanOrEqual(400);
    const state = await dbWorker
      .selectFrom('cg.mission')
      .select('state')
      .where('id', '=', missionId)
      .executeTakeFirstOrThrow();
    expect(state.state).toBe('open');
    await call('admin', 'DELETE', `/missions/${missionId}/lock`, {});
    const moved = await command('field', `/mision ${missionRef.toLowerCase()} estado en_sitio`);
    expect(moved.status, moved.message).toBe('awaiting_confirmation');
    const ok = await confirm('field', moved);
    expect(ok.body['status'], JSON.stringify(ok.body)).toBe('succeeded');
    expect(ok.body['message']).toContain('on scene');
  });
});
