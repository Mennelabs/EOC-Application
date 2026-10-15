/**
 * The facility registry against a real PostgreSQL (layer-7 task D; REC-01,
 * REC-10, SEC-10, SEC-18, A7): county EM enters a facility straight into the
 * registry; what is not known stays unknown and is listed as such; contacts
 * are encrypted, left out of lists, and their read is audited; the COAD and
 * mass care propose, and a named approver decides, never on their own
 * proposal; changes need the version they were made against; an entry not
 * re-checked in 12 months is stale until confirmed; a role without the
 * registry sees nothing; the seed's WESTWIND facilities are there. Runs on a
 * county of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routesWith } from '../src/routes/index.ts';
import { remindFacilityRechecks } from '../../worker/src/jobs/facilities.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Facility {
  id: string;
  version: number;
  name: string;
  source: string;
  approvedBy: string | null;
  stale: boolean;
  unknown: string[];
  contacts: { name: string; phone?: string }[] | null;
  floodplain: string | null;
}
interface Change {
  id: string;
  version: number;
  state: string;
  change: string;
  facilityName: string | null;
}

describe.skipIf(!appUrl || !workerUrl)('the facility registry (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let seededCounty = '';
  let slug = '';
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PATCH',
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
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const audits = (action: string) =>
    dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'classification_read', 'actor_account_id'])
      .where('tenant_id', '=', county)
      .where('action', '=', action)
      .execute();

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    seededCounty = seeded.tenants['county']!;
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-facilities-${run}`,
        name: `Exercise facilities county ${run}`,
        status: 'provisioning',
        security_contact_email: `facilities-${run}@example.org`,
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    slug = `exercise-facilities-${run}`;
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
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects['em'] = as('county_em_director');
    subjects['coad'] = as('coad_chair');
    subjects['mc'] = as('mass_care_coordinator');
    subjects['pio'] = as('public_information_officer');
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
      fieldCrypto: crypto,
      subjects: loader,
      routes: routesWith(),
      publicRoutes: [
        publicRoutes({
          resolver: new TenantResolver(dbApp),
          codes: new ReferenceCodeLeaser(dbApp, 'test'),
          risk: new RiskScorer(),
          getQueue: () => undefined,
          residentTokenSecret: 'test-secret-'.repeat(4),
          defaultGraph: westwindGraph,
        }),
      ],
    });
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

  let gym: Facility;

  it('REC-01, REC-10: county EM enters a facility directly; unknowns stay unknown; contacts are encrypted, out of lists, and audited when read', async () => {
    const made = await call('em', 'POST', '/facilities', {
      name: 'Exercise Middle School gym',
      kind: 'school',
      address: { line1: '10 Exercise Ave', city: 'Westwind', postal: '63003' },
      position: { lat: 38.8, lon: -90.86 },
      sqft: 8000,
      ada: true,
      powerBackup: 'transfer_switch',
      kitchen: true,
      showers: null,
      mouStatus: 'signed',
      communities: ['Westwind families'],
      contacts: [{ name: 'Exercise Custodian', role: 'Head custodian', phone: '+13145550123' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    gym = made.body as Facility;
    expect(gym).toMatchObject({ source: 'county', approvedBy: subjects['em']!.accountId });
    expect(gym.unknown).toEqual(
      expect.arrayContaining([
        'showers',
        'petPolicy',
        'parkingSpaces',
        'truckAccess',
        'floodplain',
      ]),
    );
    const stored = await dbWorker
      .selectFrom('cg.facility')
      .select('contacts_enc')
      .where('id', '=', gym.id)
      .executeTakeFirstOrThrow();
    expect(stored.contacts_enc!.toString('utf8')).not.toContain('Custodian');
    const list = (await call('em', 'GET', '/facilities')).body as Facility[];
    expect(list.map((f) => f.name)).toContain('Exercise Middle School gym');
    expect(list.every((f) => f.contacts === null)).toBe(true);
    const one = (await call('em', 'GET', `/facilities/${gym.id}`)).body as Facility;
    expect(one.contacts).toEqual([
      { name: 'Exercise Custodian', role: 'Head custodian', phone: '+13145550123' },
    ]);
    expect(await audits('facility.read_contacts')).toEqual([
      expect.objectContaining({ classification_read: ['contact'] }),
    ]);
    // The COAD reads the registry, but not the contacts.
    expect(
      ((await call('coad', 'GET', `/facilities/${gym.id}`)).body as Facility).contacts,
    ).toBeNull();
    // A role without the registry sees nothing.
    expect((await call('pio', 'GET', '/facilities')).status).toBe(403);
  });

  it('REC-01, A7: the COAD and mass care propose; a named approver decides, never on their own proposal', async () => {
    const proposed = await call('coad', 'POST', '/facilities', {
      name: 'Exercise Grace Church hall',
      kind: 'place_of_worship',
      sqft: 3000,
      kitchen: true,
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
    const change = proposed.body as Change;
    expect(change).toMatchObject({ state: 'pending', change: 'create' });
    const queue = (await call('em', 'GET', '/facility-changes')).body as Change[];
    expect(queue.map((c) => c.facilityName)).toContain('Exercise Grace Church hall');
    expect(
      (
        await call(
          'coad',
          'POST',
          `/facility-changes/${change.id}/decision`,
          { decision: 'approve', reason: 'Exercise: my own' },
          { 'if-match': `"${change.version}"` },
        )
      ).status,
    ).toBe(403);
    const approved = await call(
      'em',
      'POST',
      `/facility-changes/${change.id}/decision`,
      { decision: 'approve', reason: 'Exercise: walked it with the pastor' },
      { 'if-match': `"${change.version}"` },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const hall = ((await call('em', 'GET', '/facilities')).body as Facility[]).find(
      (f) => f.name === 'Exercise Grace Church hall',
    )!;
    expect(hall).toMatchObject({ source: 'coad', approvedBy: subjects['em']!.accountId });

    // Mass care proposes a change to the gym; it waits; approved, it applies.
    const upd = await call(
      'mc',
      'PATCH',
      `/facilities/${gym.id}`,
      { showers: 6, petPolicy: 'service_animals' },
      { 'if-match': `"${gym.version}"` },
    );
    expect(upd.status, JSON.stringify(upd.body)).toBe(202);
    expect(((await call('em', 'GET', `/facilities/${gym.id}`)).body as Facility).unknown).toContain(
      'showers',
    );
    const u = upd.body as Change;
    await call(
      'em',
      'POST',
      `/facility-changes/${u.id}/decision`,
      { decision: 'approve', reason: 'Exercise: counted the showers' },
      { 'if-match': `"${u.version}"` },
    );
    const after = (await call('em', 'GET', `/facilities/${gym.id}`)).body as Facility;
    expect(after.unknown).not.toContain('showers');

    // An approver never decides a proposal of their own.
    const own = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.facility_change')
        .values({
          tenant_id: county,
          facility_id: null,
          change: 'create',
          proposed: JSON.stringify({ name: 'Exercise own proposal', kind: 'other' }),
          source: 'county',
          proposed_by: subjects['em']!.accountId,
        } as never)
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow(),
    );
    const refused = await call(
      'em',
      'POST',
      `/facility-changes/${own.id}/decision`,
      { decision: 'approve', reason: 'Exercise: should not pass' },
      { 'if-match': `"${own.version}"` },
    );
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('own_proposal');
    expect((await audits('facility_change.approve')).length).toBe(2);
  });

  it('BRD:FR-00.05: a change made against an old version is refused with the current entry', async () => {
    const stale = await call(
      'em',
      'PATCH',
      `/facilities/${gym.id}`,
      { sqft: 8200 },
      { 'if-match': `"${gym.version}"` },
    );
    expect(stale.status).toBe(409);
  });

  it('REC-01: an entry not re-checked in 12 months is stale until someone confirms it', async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.facility')
        .set({ last_confirmed_at: new Date(Date.now() - 400 * 86_400_000) })
        .where('id', '=', gym.id)
        .execute(),
    );
    const stale = (await call('em', 'GET', '/facilities?stale=true')).body as Facility[];
    expect(stale.map((f) => f.id)).toEqual([gym.id]);
    expect(stale[0]!.stale).toBe(true);
    const current = (await call('em', 'GET', `/facilities/${gym.id}`)).body as Facility;
    const confirmed = await call(
      'mc',
      'POST',
      `/facilities/${gym.id}/confirm`,
      { note: 'Exercise: called the school' },
      { 'if-match': `"${current.version}"` },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect((confirmed.body as Facility).stale).toBe(false);
    expect((await audits('facility.confirm')).length).toBe(1);
  });

  it('the seed puts the WESTWIND facilities in the registry, with their unknowns', async () => {
    const rows = await dbWorker
      .selectFrom('cg.facility')
      .select(['name', 'floodplain', 'source'])
      .where('tenant_id', '=', seededCounty)
      .orderBy('name')
      .execute();
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'County fairgrounds lot',
        'Harmon High School gym',
        'Iglesia Nueva Esperanza fellowship hall',
        'Westwind Community Center',
      ]),
    );
    expect(rows.find((r) => r.name.startsWith('Iglesia'))!.floodplain).toBeNull();
  });

  it('REC-01: a place offered through the public form waits in the queue; a retry makes no second offer; approved, its contact comes along', async () => {
    const executionId = randomUUID();
    const offer = {
      executionId,
      facility: {
        name: 'Exercise Lakeside Lodge',
        kind: 'commercial',
        address: { line1: '9 Lake Rd', city: 'Westwind', postal: '63003' },
        sqft: 5000,
        kitchen: true,
      },
      submitter: {
        name: 'Exercise Owner',
        organization: 'Lakeside Lodge',
        email: `lodge-${run}@example.org`,
      },
      authorized: true,
    };
    const post = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/public/facilities/${slug}/register`,
        payload: body as Record<string, unknown>,
      });
    const first = await post(offer);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.body).not.toContain('Exercise Owner');
    expect((await post(offer)).statusCode).toBe(202);
    expect(
      (await post({ ...offer, executionId: randomUUID(), authorized: false })).statusCode,
    ).toBe(400);
    const rows = await dbWorker
      .selectFrom('cg.facility_change')
      .select(['id', 'version', 'source', 'submitter_enc', 'proposed_by'])
      .where('tenant_id', '=', county)
      .where('source', '=', 'self_registration')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposed_by).toBeNull();
    expect(rows[0]!.submitter_enc!.toString('utf8')).not.toContain('Exercise Owner');
    const decided = await call(
      'em',
      'POST',
      `/facility-changes/${rows[0]!.id}/decision`,
      { decision: 'approve', reason: 'Exercise: visited the lodge' },
      { 'if-match': `"${rows[0]!.version}"` },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const lodge = ((await call('em', 'GET', '/facilities')).body as Facility[]).find(
      (f) => f.name === 'Exercise Lakeside Lodge',
    )!;
    expect(lodge.source).toBe('self_registration');
    const full = (await call('em', 'GET', `/facilities/${lodge.id}`)).body as Facility;
    expect(full.contacts).toEqual([
      { name: 'Exercise Owner', role: 'Lakeside Lodge', email: `lodge-${run}@example.org` },
    ]);
    // Offers are limited per address.
    let limited = false;
    for (let i = 0; i < 6 && !limited; i++)
      limited = (await post({ ...offer, executionId: randomUUID() })).statusCode === 429;
    expect(limited).toBe(true);
  });

  it('REC-01: a month before the yearly re-check, the facility contact and the approvers hear once', async () => {
    const lodge = await dbWorker
      .selectFrom('cg.facility')
      .select('id')
      .where('tenant_id', '=', county)
      .where('name', '=', 'Exercise Lakeside Lodge')
      .executeTakeFirstOrThrow();
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.facility')
        .set({ last_confirmed_at: new Date(Date.now() - 340 * 86_400_000) })
        .where('id', '=', lodge.id)
        .execute(),
    );
    const ctx = {
      db: dbWorker,
      crypto,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    } as unknown as JobContext;
    expect(await remindFacilityRechecks(ctx)).toBeGreaterThanOrEqual(2);
    expect(await remindFacilityRechecks(ctx)).toBe(0);
    const notices = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.notice_log')
        .select(['kind', 'subject_id', 'recipient_count'])
        .where('tenant_id', '=', county)
        .where('kind', '=', 'facility_recheck')
        .execute(),
    );
    expect(notices).toEqual([
      { kind: 'facility_recheck', subject_id: lodge.id, recipient_count: 2 },
    ]);
    const sent = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', county)
      .where('topic', '=', 'message.send')
      .execute();
    expect(sent.map((m) => (m.payload as { template: string }).template)).toEqual([
      'facility_recheck',
      'facility_recheck',
    ]);
    const read = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['actor_kind'])
      .where('tenant_id', '=', county)
      .where('action', '=', 'facility.read_contacts')
      .where('actor_kind', '=', 'system')
      .execute();
    expect(read).toHaveLength(1);
  });
});
