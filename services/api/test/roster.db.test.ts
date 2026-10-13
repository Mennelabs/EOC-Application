/**
 * Field roster schema against a real PostgreSQL (layer-4 task A; DSP-02,
 * PER-01, FR-05.06, FLD-03, FLD-04, DSP-08, SEC-05, SEC-13, FL-17): the seed
 * loads teams with leads, members and verified credentials per organization,
 * the exercise event carries its check-in code, parcels cover the synthetic
 * grid; a partner tenant sees only its own teams, credentials and positions;
 * positions live in daily partitions that drop whole once older than the
 * trail period; a check-in's hours come from the row and a person has one
 * open check-in at a time. Runs only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Database } from '@cg/db';
import { roleTemplates } from '@cg/authz';
import { sql, type Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { teams as teamSpecs } from '../../../tools/seed/src/county.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)('field roster schema and seed (database-backed)', () => {
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let tenants: Record<string, string>;
  const checkInIds: string[] = [];

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    tenants = (await loadSeed(dbWorker)).tenants;
  });

  afterAll(async () => {
    if (checkInIds.length > 0) {
      await dbWorker.deleteFrom('cg.position').where('check_in_id', 'in', checkInIds).execute();
      await dbWorker.deleteFrom('cg.check_in').where('id', 'in', checkInIds).execute();
    }
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('seeds every team with a lead, members, verified credentials and an available status; the event has its check-in code; parcels cover the grid', async () => {
    for (const spec of teamSpecs) {
      const tenantId = tenants[spec.tenant]!;
      const team = await dbWorker
        .selectFrom('cg.team')
        .select(['id', 'lead_personnel_id', 'agency_tenant_id', 'kind'])
        .where('tenant_id', '=', tenantId)
        .where('key', '=', spec.key)
        .executeTakeFirstOrThrow();
      expect(team.lead_personnel_id, spec.key).not.toBeNull();
      expect(team.agency_tenant_id).toBe(tenantId);
      expect(team.kind).toBe(spec.kind);
      const members = await dbWorker
        .selectFrom('cg.team_member')
        .select(['personnel_id', 'role'])
        .where('team_id', '=', team.id)
        .where('left_at', 'is', null)
        .execute();
      expect(members, spec.key).toHaveLength(spec.members.length);
      expect(members.filter((m) => m.role === 'lead')).toHaveLength(1);
      // The seed's own credential rows (the field suites record and revoke credentials of their own).
      const credentials = await dbWorker
        .selectFrom('cg.credential')
        .select(['kind', 'status'])
        .where(
          'personnel_id',
          'in',
          members.map((m) => m.personnel_id),
        )
        .where('issuer', '=', 'Exercise WESTWIND (synthetic)')
        .execute();
      expect(credentials.length).toBe(spec.members.reduce((n, m) => n + m.credentials.length, 0));
      expect(credentials.every((c) => c.status === 'verified')).toBe(true);
      // The seed's own status row (later suites move the team around; the seed fact stays).
      const status = await dbWorker
        .selectFrom('cg.team_status')
        .select(['status', 'fact'])
        .where('team_id', '=', team.id)
        .where('source', '=', 'seed')
        .orderBy('created_at')
        .executeTakeFirstOrThrow();
      expect(status).toEqual({ status: 'available', fact: 'confirmed' });
    }
    // Credentials are recorded, never inferred: no person carries a skill without a credential row (PER-01, AC-05A).
    const unbacked = await sql<{ n: string }>`
      select count(*)::text as n from cg.personnel p
      where p.home_tenant_id is not null
        and exists (select 1 from unnest(p.skills) s
                    where not exists (select 1 from cg.credential c where c.personnel_id = p.id and c.kind = s))`.execute(
      dbWorker,
    );
    expect(unbacked.rows[0]?.n).toBe('0');
    const event = await dbWorker
      .selectFrom('cg.event')
      .select('check_in_code')
      .where('tenant_id', '=', tenants['county']!)
      .where('intake_slug', '=', 'westwind')
      .executeTakeFirstOrThrow();
    expect(event.check_in_code).toBe('WESTWIND');
    const parcels = await dbWorker
      .selectFrom('cg.parcel')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenants['county']!)
      .executeTakeFirstOrThrow();
    expect(Number(parcels.n)).toBeGreaterThan(500);
    const centroid = await sql<{ inside: boolean }>`
      select ST_Within(centroid, geom) as inside from cg.parcel
      where tenant_id = ${tenants['county']}::uuid limit 1`.execute(dbWorker);
    expect(centroid.rows[0]?.inside).toBe(true);
  });

  it('a partner organization sees only its own teams and credentials (DSP-09, SEC-05)', async () => {
    const seen = await withTenant(dbApp, { tenantId: tenants['cleanup']! }, async (trx) => {
      const teams = await trx.selectFrom('cg.team').select(['key', 'tenant_id']).execute();
      const credentials = await trx.selectFrom('cg.credential').select('tenant_id').execute();
      const members = await trx.selectFrom('cg.team_member').select('tenant_id').execute();
      return { teams, credentials, members };
    });
    expect(seen.teams.map((t) => t.key).sort()).toEqual(['chainsaw-a', 'chainsaw-b']);
    expect(seen.credentials.length).toBeGreaterThan(0);
    expect(seen.credentials.every((c) => c.tenant_id === tenants['cleanup'])).toBe(true);
    expect(seen.members.every((m) => m.tenant_id === tenants['cleanup'])).toBe(true);
  });

  it('positions: daily partitions carry the tenant policy, and a day older than the trail period drops whole (DSP-08, SEC-13)', async () => {
    const countyId = tenants['county']!;
    const person = await dbWorker
      .selectFrom('cg.personnel')
      .select('id')
      .where('tenant_id', '=', countyId)
      .where('department', '=', 'Damage Assessment Team 1')
      .executeTakeFirstOrThrow();
    const checkInId = randomUUID();
    checkInIds.push(checkInId);
    const old = new Date(Date.now() - 40 * 86_400_000);
    const created = await sql<{ p: string | null }>`
      select cg.ensure_position_partition(${old.toISOString().slice(0, 10)}::date) as p`.execute(
      dbWorker,
    );
    expect(created.rows[0]?.p).toMatch(/^position_p_\d{8}$/);
    const oldPartition = created.rows[0]!.p!;
    // The partition got the parent's row-level security (SEC-05).
    const rls = await sql<{ forced: boolean }>`
      select relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'cg' and c.relname = ${oldPartition}`.execute(dbWorker);
    expect(rls.rows[0]?.forced).toBe(true);
    const point = sql`ST_SetSRID(ST_MakePoint(-90.87, 38.795), 4326)`;
    await dbWorker
      .insertInto('cg.position')
      .values([
        {
          tenant_id: countyId,
          check_in_id: checkInId,
          personnel_id: person.id,
          geom: point,
          accuracy_m: 8,
          source: 'app',
          recorded_at: old,
        },
        {
          tenant_id: countyId,
          check_in_id: checkInId,
          personnel_id: person.id,
          geom: point,
          accuracy_m: 5,
          source: 'app',
          recorded_at: new Date(),
        },
      ])
      .execute();
    const mine = await withTenant(dbApp, { tenantId: countyId }, (trx) =>
      trx.selectFrom('cg.position').select('id').where('check_in_id', '=', checkInId).execute(),
    );
    expect(mine).toHaveLength(2);
    const theirs = await withTenant(dbApp, { tenantId: tenants['cleanup']! }, (trx) =>
      trx.selectFrom('cg.position').select('id').where('check_in_id', '=', checkInId).execute(),
    );
    expect(theirs).toHaveLength(0);

    // The system role counts what will leave before the drop (the worker logs it per tenant).
    const leaving = await dbWorker
      .selectFrom('cg.position')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('check_in_id', '=', checkInId)
      .where('recorded_at', '<', new Date(Date.now() - 30 * 86_400_000))
      .executeTakeFirstOrThrow();
    expect(leaving.n).toBe('1');
    const dropped = await sql<{ partition_name: string }>`
      select partition_name from cg.drop_position_partitions(interval '30 days')`.execute(dbWorker);
    expect(dropped.rows.map((r) => r.partition_name)).toContain(oldPartition);
    const left = await dbWorker
      .selectFrom('cg.position')
      .select('accuracy_m')
      .where('check_in_id', '=', checkInId)
      .execute();
    expect(left.map((r) => r.accuracy_m)).toEqual([5]);
    const again = await sql<{ partition_name: string }>`
      select partition_name from cg.drop_position_partitions(interval '30 days')`.execute(dbWorker);
    expect(again.rows).toHaveLength(0);
    // Today's partition stays, and the look-ahead exists for the worker's inserts (SCL-06).
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const partitions = await sql<{ relname: string }>`
      select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent where p.relname = 'position'`.execute(dbWorker);
    expect(partitions.rows.map((r) => r.relname)).toContain(`position_p_${today}`);
  });

  it('a check-in computes its hours and a person has one open check-in at a time (FLD-03, FL-17)', async () => {
    const countyId = tenants['county']!;
    const event = await dbWorker
      .selectFrom('cg.event')
      .select('id')
      .where('tenant_id', '=', countyId)
      .where('intake_slug', '=', 'westwind')
      .executeTakeFirstOrThrow();
    const member = await dbWorker
      .selectFrom('cg.team_member')
      .innerJoin('cg.team', 'cg.team.id', 'cg.team_member.team_id')
      .select(['cg.team_member.personnel_id as personnel_id', 'cg.team.id as team_id'])
      .where('cg.team.tenant_id', '=', countyId)
      .where('cg.team.key', '=', 'cert-canvass')
      .where('cg.team_member.role', '=', 'member')
      .executeTakeFirstOrThrow();
    const started = new Date(Date.now() - 3 * 3_600_000);
    const open = await dbWorker
      .insertInto('cg.check_in')
      .values({
        tenant_id: countyId,
        personnel_id: member.personnel_id,
        event_id: event.id,
        team_id: member.team_id,
        agency_tenant_id: countyId,
        method: 'event_code',
        credentials_snapshot: JSON.stringify([{ kind: 'cert', status: 'verified' }]),
        started_at: started,
      })
      .returning(['id', 'hours'])
      .executeTakeFirstOrThrow();
    checkInIds.push(open.id);
    expect(open.hours).toBeNull();
    await expect(
      dbWorker
        .insertInto('cg.check_in')
        .values({
          tenant_id: countyId,
          personnel_id: member.personnel_id,
          event_id: event.id,
          method: 'qr',
        })
        .execute(),
    ).rejects.toThrow(/check_in_open_idx/);
    const ended = await dbWorker
      .updateTable('cg.check_in')
      .set({ ended_at: new Date(started.getTime() + 2.5 * 3_600_000), end_reason: 'checked_out' })
      .where('id', '=', open.id)
      .returning('hours')
      .executeTakeFirstOrThrow();
    expect(Number(ended.hours)).toBeCloseTo(2.5, 2);
  });

  it('missions (task B): references are unique under concurrent creation and never reused; the seed assigns without inferring dispatch or arrival (FR-02.04, AC-02A, AC-06B, RULE-03, AC-07C)', async () => {
    const countyId = tenants['county']!;
    // Two connections take a reference at the same time: distinct, sequential, never repeated.
    const takes = await Promise.all(
      [1, 2, 3].map(() =>
        sql<{ r: string }>`select cg.next_mission_reference(${countyId}::uuid) as r`.execute(
          dbWorker,
        ),
      ),
    );
    const refs = takes.map((t) => t.rows[0]!.r);
    expect(new Set(refs).size).toBe(3);
    for (const r of refs) expect(r).toMatch(/^M-\d{5}$/);
    const numbers = refs.map((r) => Number(r.slice(2))).sort((a, b) => a - b);
    expect(numbers[2]! - numbers[0]!).toBe(2);
    const missions = await dbWorker
      .selectFrom('cg.mission')
      .select(['id', 'reference', 'kind', 'state', 'source', 'owning_tenant_id', 'caller_enc'])
      .where('tenant_id', '=', countyId)
      .orderBy('reference')
      .execute();
    expect(missions.length).toBeGreaterThanOrEqual(8);
    expect(new Set(missions.map((m) => m.reference)).size).toBe(missions.length);
    expect(
      missions.filter((m) => m.kind === 'verification_route' && m.state === 'open'),
    ).toHaveLength(4);
    expect(missions.find((m) => m.kind === 'cleanup_work_order')?.owning_tenant_id).toBe(
      tenants['cleanup'],
    );
    expect(missions.find((m) => m.source === 'call')?.caller_enc).toBeNull();
    const assignments = await dbWorker
      .selectFrom('cg.assignment')
      .innerJoin('cg.mission', 'cg.mission.id', 'cg.assignment.mission_id')
      .select([
        'cg.assignment.id as id',
        'cg.assignment.state as state',
        'cg.assignment.dispatched_at as dispatched_at',
        'cg.assignment.dispatch_method as dispatch_method',
        'cg.assignment.delivered_at as delivered_at',
        'cg.assignment.acknowledged_at as acknowledged_at',
        'cg.assignment.on_scene_at as on_scene_at',
        'cg.mission.kind as kind',
        'cg.assignment.mission_id as mission_id',
        'cg.assignment.team_id as team_id',
      ])
      .where('cg.assignment.tenant_id', '=', countyId)
      .execute();
    const routes = assignments.filter((a) => a.kind === 'verification_route');
    expect(routes).toHaveLength(4);
    for (const a of routes) {
      expect(a.state).toBe('assigned');
      expect(a.dispatched_at).toBeNull();
      expect(a.on_scene_at).toBeNull();
    }
    const traffic = assignments.find((a) => a.kind === 'traffic_control')!;
    expect(traffic.state).toBe('dispatched');
    expect(traffic.dispatch_method).toBe('radio');
    expect(traffic.delivered_at).toBeNull(); // the method is not the proof (FR-06.06)
    expect(traffic.acknowledged_at).toBeNull();
    // One active assignment per team and mission (RULE-06).
    await expect(
      dbWorker
        .insertInto('cg.assignment')
        .values({
          tenant_id: countyId,
          mission_id: routes[0]!.mission_id,
          resource_kind: 'team',
          team_id: routes[0]!.team_id,
        })
        .execute(),
    ).rejects.toThrow(/assignment_active_team_idx/);
    // A mission cannot close without a disposition (AC-07C), and a dispatch needs its method.
    await expect(
      dbWorker
        .updateTable('cg.mission')
        .set({ state: 'closed', closed_at: new Date() })
        .where('id', '=', missions[0]!.id)
        .execute(),
    ).rejects.toThrow(/mission_check|check constraint/);
    await expect(
      dbWorker
        .updateTable('cg.assignment')
        .set({ dispatched_at: new Date() })
        .where('id', '=', routes[0]!.id)
        .execute(),
    ).rejects.toThrow(/assignment_check|check constraint/);
    // The partner that owns the work order does not see the county's other missions through RLS.
    const partnerView = await withTenant(dbApp, { tenantId: tenants['cleanup']! }, (trx) =>
      trx.selectFrom('cg.mission').select('id').execute(),
    );
    expect(partnerView).toHaveLength(0);
    // Hazard, reminder (F09) and the logs came with the seed; the ledger is now notice_log.
    // The seed's downed line on the welfare check (other suites report and clear hazards of their own).
    const hazard = await dbWorker
      .selectFrom('cg.hazard')
      .select(['severity', 'ai_suggested', 'source'])
      .where('tenant_id', '=', countyId)
      .where('kind', '=', 'downed_line')
      .where('source', '=', 'call')
      .orderBy('created_at')
      .executeTakeFirstOrThrow();
    expect(hazard).toEqual({ severity: 'danger', ai_suggested: false, source: 'call' });
    const reminder = await dbWorker
      .selectFrom('cg.reminder')
      .select(['state', 'kind', 'escalate_to_role'])
      .where('tenant_id', '=', countyId)
      .where('kind', '=', 'call_back')
      .executeTakeFirstOrThrow();
    expect(reminder).toEqual({
      state: 'active',
      kind: 'call_back',
      escalate_to_role: 'field_coordinator',
    });
    const activity = await dbWorker
      .selectFrom('cg.activity_entry')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', countyId)
      .executeTakeFirstOrThrow();
    expect(Number(activity.n)).toBeGreaterThanOrEqual(5);
    const ledger = await sql<{ n: string }>`
      select count(*)::text as n from information_schema.tables
      where table_schema = 'cg' and table_name in ('notice_log', 'reminder', 'reminder_event')`.execute(
      dbWorker,
    );
    expect(ledger.rows[0]?.n).toBe('3');
    // Retention categories of the layer (SEC-13) and the job aids as exercise drafts (FL-15).
    const categories = await dbWorker
      .selectFrom('cg.retention_policy')
      .select('data_category')
      .where('tenant_id', '=', countyId)
      .execute();
    expect(categories.map((c) => c.data_category)).toEqual(
      expect.arrayContaining(['field_records', 'safety', 'comms', 'badges', 'child_records']),
    );
    const aids = await dbWorker
      .selectFrom('cg.job_aid')
      .select(['lang', 'status'])
      .where('tenant_id', '=', countyId)
      .execute();
    expect(aids).toHaveLength(6);
    expect(aids.every((a) => a.status === 'exercise_draft')).toBe(true);
    // Every shipped template exists as a role in the county (ADM-04), the new ones included.
    const roles = await dbWorker
      .selectFrom('cg.role')
      .select('template_key')
      .where('tenant_id', '=', countyId)
      .execute();
    const keys = new Set(roles.map((r) => r.template_key));
    for (const t of roleTemplates) expect(keys.has(t.key), t.key).toBe(true);
  });
});
