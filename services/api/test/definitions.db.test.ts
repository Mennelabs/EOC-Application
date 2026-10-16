/**
 * Governed definitions, retention policies and legal holds through the API
 * (BRD:FR-00.10, FR-18.05, SEC-13, ADM-05). A definition is published as a new
 * version with a reason, never edited in place; a version that starts later
 * does not replace the current one until its time; readers see the history
 * newest first; a role without the grant is refused; another county never
 * sees this county's definitions. Audit retention cannot drop below seven
 * years and CJIS retention is not set here. Runs on counties of its own,
 * only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)('governed definitions, retention and legal holds', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  const counties: string[] = [];
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const KEY = `damage.categories-${run}`;
  const confirm = { 'x-confirm': 'true', 'x-reason': 'Exercise: county adopts the FEMA levels' };

  const call = async (
    who: string,
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${who}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const audited = async (county: string, action: string) =>
    dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'target_id', 'target_version', 'reason', 'actor_account_id'])
      .where('tenant_id', '=', county)
      .where('action', '=', action)
      .orderBy('seq')
      .execute();

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    for (const n of ['a', 'b']) {
      const c = await dbWorker
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-defs-${n}-${run}`,
          name: `Exercise definitions county ${n} ${run}`,
          status: 'provisioning',
        })
        .returning(['id', 'path', 'kind'])
        .executeTakeFirstOrThrow();
      counties.push(c.id);
      const as = (template: string): AccountSubject => {
        const t = roleTemplates.find((x) => x.key === template)!;
        return {
          kind: 'account',
          accountId: randomUUID(),
          tenantId: c.id,
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
      subjects[`director-${n}`] = as('county_em_director');
      subjects[`planner-${n}`] = as('planning_gis_lead');
      subjects[`canvasser-${n}`] = as('canvasser');
      subjects[`security-${n}`] = as('security_admin');
    }
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
      routes: routesWith({}),
    });
  });

  afterAll(async () => {
    await app?.close();
    for (const id of counties) {
      await dbWorker
        ?.updateTable('cg.tenant')
        .set({ status: 'closed' })
        .where('id', '=', id)
        .execute();
    }
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('BRD:FR-00.10: a definition is published as numbered versions with a reason; a later start date waits its turn; the history reads newest first', async () => {
    const first = { levels: ['affected', 'minor', 'major', 'destroyed'] };
    // Publishing is consequential: no confirmation and reason, nothing is written.
    const unconfirmed = await call('director-a', 'PUT', `/definitions/${KEY}`, { value: first });
    expect(unconfirmed.status).toBe(428);
    expect((unconfirmed.body as { code: string }).code).toBe('confirmation_required');
    const noReason = await call(
      'director-a',
      'PUT',
      `/definitions/${KEY}`,
      { value: first },
      { 'x-confirm': 'true' },
    );
    expect(noReason.status).toBe(428);
    expect((await call('planner-a', 'GET', `/definitions/${KEY}`)).status).toBe(404);

    const v1 = await call('director-a', 'PUT', `/definitions/${KEY}`, { value: first }, confirm);
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    expect(v1.body).toMatchObject({
      key: KEY,
      version: 1,
      value: first,
      reason: confirm['x-reason'],
      createdBy: subjects['director-a']!.accountId,
    });

    const second = { levels: ['affected', 'minor', 'major', 'destroyed', 'inaccessible'] };
    const v2 = await call('director-a', 'PUT', `/definitions/${KEY}`, { value: second }, confirm);
    expect(v2.status).toBe(201);
    expect((v2.body as { version: number }).version).toBe(2);

    // Version 3 starts next week: version 2 stays the current one until then.
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const v3 = await call(
      'director-a',
      'PUT',
      `/definitions/${KEY}`,
      { value: { levels: ['minor', 'major'] }, effectiveFrom: later },
      confirm,
    );
    expect(v3.status).toBe(201);
    expect((v3.body as { version: number; effectiveFrom: string }).version).toBe(3);

    const current = await call('planner-a', 'GET', '/definitions');
    expect(current.status).toBe(200);
    const mine = (current.body as { key: string; version: number; value: unknown }[]).filter(
      (d) => d.key === KEY,
    );
    expect(mine).toEqual([expect.objectContaining({ version: 2, value: second })]);

    const history = await call('planner-a', 'GET', `/definitions/${KEY}`);
    expect(history.status).toBe(200);
    expect((history.body as { version: number }[]).map((d) => d.version)).toEqual([3, 2, 1]);
    expect((history.body as { value: unknown }[])[2]!.value).toEqual(first);

    // Each version is audited with its number and reason.
    const trail = await audited(counties[0]!, 'definition.write');
    expect(trail.map((a) => [a.target_id, a.target_version])).toEqual([
      [KEY, 1],
      [KEY, 2],
      [KEY, 3],
    ]);
    expect(trail.every((a) => a.reason === confirm['x-reason'])).toBe(true);
    expect(trail.every((a) => a.actor_account_id === subjects['director-a']!.accountId)).toBe(true);
  });

  it('BRD:FR-00.10, ADM-05: versions are never edited or removed, even by the application role', async () => {
    // No update or delete policy: inside the county's own context nothing is touched,
    // whether the statement matches no rows or the grant is refused.
    const changed = await withTenant(dbApp, { tenantId: counties[0]! }, async (trx) => {
      const edited = await trx
        .updateTable('cg.governed_definition')
        .set({ value: JSON.stringify({ levels: [] }) })
        .where('key', '=', KEY)
        .executeTakeFirst()
        .then(
          (r) => Number(r.numUpdatedRows),
          () => 0,
        );
      return edited;
    }).catch(() => 0);
    expect(changed).toBe(0);
    const removed = await withTenant(dbApp, { tenantId: counties[0]! }, (trx) =>
      trx
        .deleteFrom('cg.governed_definition')
        .where('key', '=', KEY)
        .executeTakeFirst()
        .then((r) => Number(r.numDeletedRows)),
    ).catch(() => 0);
    expect(removed).toBe(0);
    const rows = await dbWorker
      .selectFrom('cg.governed_definition')
      .select(['version', 'value'])
      .where('tenant_id', '=', counties[0]!)
      .where('key', '=', KEY)
      .orderBy('version')
      .execute();
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[0]!.value).toEqual({ levels: ['affected', 'minor', 'major', 'destroyed'] });
  });

  it('BRD:FR-00.10, ADM-05: a reader cannot publish, a role without the grant cannot read, and another county sees nothing of this one', async () => {
    const byPlanner = await call(
      'planner-a',
      'PUT',
      `/definitions/${KEY}`,
      { value: { levels: ['minor'] } },
      confirm,
    );
    expect(byPlanner.status).toBe(403);
    expect((await call('canvasser-a', 'GET', '/definitions')).status).toBe(403);
    expect((await call('canvasser-a', 'GET', `/definitions/${KEY}`)).status).toBe(403);
    const denials = await audited(counties[0]!, 'authz.deny');
    expect(denials.map((d) => d.reason)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^definition\.write:/)]),
    );

    // County B: the same key is unknown, and its own list does not carry county A's version.
    expect((await call('planner-b', 'GET', `/definitions/${KEY}`)).status).toBe(404);
    const listB = await call('planner-b', 'GET', '/definitions');
    expect((listB.body as { key: string }[]).some((d) => d.key === KEY)).toBe(false);
    // County B's own first version is numbered 1, not 4.
    const b1 = await call(
      'director-b',
      'PUT',
      `/definitions/${KEY}`,
      { value: { levels: ['minor'] } },
      confirm,
    );
    expect(b1.status).toBe(201);
    expect((b1.body as { version: number }).version).toBe(1);
  });

  it('SEC-13: audit retention never drops below seven years; CJIS retention is set in the enclave; a policy change is versioned and audited', async () => {
    const short = await call(
      'security-a',
      'PUT',
      '/retention/audit',
      { keepForDays: 365, rule: 'duration' },
      confirm,
    );
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body)).toContain('7 years');
    const external = await call(
      'security-a',
      'PUT',
      '/retention/audit',
      { keepForDays: null, rule: 'external' },
      confirm,
    );
    expect(external.status).toBe(400);
    const cji = await call(
      'security-a',
      'PUT',
      '/retention/cji',
      { keepForDays: 3650, rule: 'duration' },
      confirm,
    );
    expect(cji.status).toBe(400);
    expect(JSON.stringify(cji.body)).toContain('enclave');
    // Duration and days go together.
    const mismatched = await call(
      'security-a',
      'PUT',
      '/retention/otp',
      { keepForDays: null, rule: 'duration' },
      confirm,
    );
    expect(mismatched.status).toBe(400);
    // A director holds no retention grant.
    expect(
      (
        await call(
          'director-a',
          'PUT',
          '/retention/otp',
          { keepForDays: 1, rule: 'duration' },
          confirm,
        )
      ).status,
    ).toBe(403);

    const set = await call(
      'security-a',
      'PUT',
      '/retention/otp',
      { keepForDays: 1, rule: 'duration', note: 'One-time codes: one day' },
      confirm,
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ dataCategory: 'otp', keepForDays: 1, version: 1 });
    // Changing it needs the version read (optimistic concurrency).
    const stale = await call(
      'security-a',
      'PUT',
      '/retention/otp',
      { keepForDays: 2, rule: 'duration' },
      { ...confirm, 'if-match': '"7"' },
    );
    expect(stale.status).toBe(409);
    const changed = await call(
      'security-a',
      'PUT',
      '/retention/otp',
      { keepForDays: 2, rule: 'duration' },
      { ...confirm, 'if-match': '"1"' },
    );
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ keepForDays: 2, version: 2 });
    const auditTen = await call(
      'security-a',
      'PUT',
      '/retention/audit',
      { keepForDays: 3650, rule: 'duration' },
      confirm,
    );
    expect(auditTen.status).toBe(200);

    const list = await call('security-a', 'GET', '/retention');
    expect(
      (list.body as { dataCategory: string; keepForDays: number }[])
        .filter((p) => ['audit', 'otp'].includes(p.dataCategory))
        .map((p) => [p.dataCategory, p.keepForDays]),
    ).toEqual([
      ['audit', 3650],
      ['otp', 2],
    ]);
    const trail = await audited(counties[0]!, 'retention.write');
    expect(trail.map((a) => [a.target_id, a.target_version])).toEqual([
      ['otp', 1],
      ['otp', 2],
      ['audit', 1],
    ]);
    // County B's policies are its own: the shipped defaults, read back in days
    // (stored as '7 years', '1 year', '30 days', which the driver hands over as objects).
    await withTenant(dbWorker, { tenantId: counties[1]! }, (trx) =>
      sql`select cg.seed_retention_defaults(${counties[1]!}::uuid, null)`.execute(trx),
    );
    const listB = await call('security-b', 'GET', '/retention');
    const byCategory = new Map(
      (listB.body as { dataCategory: string; keepForDays: number | null; rule: string }[]).map(
        (p) => [p.dataCategory, p],
      ),
    );
    // County A's change to two days did not reach county B's one-day default.
    expect(byCategory.get('otp')).toMatchObject({ keepForDays: 1, version: 1 });
    expect(byCategory.get('audit')).toMatchObject({ keepForDays: 2555, rule: 'duration' });
    expect(byCategory.get('records')).toMatchObject({ keepForDays: 2555 });
    expect(byCategory.get('position_trail')).toMatchObject({ keepForDays: 30 });
    expect(byCategory.get('site_confirmations')).toMatchObject({ keepForDays: 365 });
    expect(byCategory.get('scribe_audio')).toMatchObject({ keepForDays: null, rule: 'on_confirm' });
  });

  it('SEC-13: a legal hold is placed with a reason and released once, both audited', async () => {
    const tooShort = await call(
      'security-a',
      'POST',
      '/legal-holds',
      { scope: { dataCategory: 'report' }, reason: 'hold' },
      confirm,
    );
    expect(tooShort.status).toBe(400);
    const noScope = await call(
      'security-a',
      'POST',
      '/legal-holds',
      { scope: {}, reason: 'Exercise: records request from county counsel' },
      confirm,
    );
    expect(noScope.status).toBe(400);
    const unconfirmed = await call('security-a', 'POST', '/legal-holds', {
      scope: { dataCategory: 'report' },
      reason: 'Exercise: records request from county counsel',
    });
    expect(unconfirmed.status).toBe(428);

    const placed = await call(
      'security-a',
      'POST',
      '/legal-holds',
      {
        scope: { dataCategory: 'report' },
        reason: 'Exercise: records request from county counsel',
      },
      confirm,
    );
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const hold = placed.body as { id: string; version: number; releasedAt: string | null };
    expect(hold.releasedAt).toBeNull();
    expect(
      ((await call('security-a', 'GET', '/legal-holds')).body as { id: string }[]).map((h) => h.id),
    ).toContain(hold.id);
    // County B cannot see or release it.
    expect(
      ((await call('security-b', 'GET', '/legal-holds')).body as { id: string }[]).some(
        (h) => h.id === hold.id,
      ),
    ).toBe(false);
    const foreign = await call('security-b', 'POST', `/legal-holds/${hold.id}/release`, undefined, {
      ...confirm,
      'if-match': `"${hold.version}"`,
    });
    expect(foreign.status).toBe(404);

    const released = await call(
      'security-a',
      'POST',
      `/legal-holds/${hold.id}/release`,
      undefined,
      { ...confirm, 'if-match': `"${hold.version}"` },
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const done = released.body as { version: number; releasedBy: string; releasedAt: string };
    expect(done.releasedBy).toBe(subjects['security-a']!.accountId);
    const again = await call('security-a', 'POST', `/legal-holds/${hold.id}/release`, undefined, {
      ...confirm,
      'if-match': `"${done.version}"`,
    });
    expect(again.status).toBe(409);

    const placedAudit = await audited(counties[0]!, 'legal_hold.place');
    const releasedAudit = await audited(counties[0]!, 'legal_hold.release');
    expect(placedAudit.map((a) => a.target_id)).toEqual([hold.id]);
    expect(placedAudit[0]!.reason).toContain('records request from county counsel');
    expect(releasedAudit.map((a) => a.target_id)).toEqual([hold.id]);
  });
});
