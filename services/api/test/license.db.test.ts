/**
 * Subscriptions against the database (SCL-10): each contract is an annual
 * subscription per jurisdiction, tiered by population served; a state or
 * coalition contract covers member jurisdictions. A county sees its own
 * contracts and the state's that covers it, never the names of the other
 * jurisdictions on the state's contract; a county the contract does not
 * cover sees nothing of it. A contract can cover only members of its
 * holder, each once. And with no contract in force, a surge of resident
 * reports is accepted in full: intake never reads a contract. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { ensureIntakeGraph } from '../../../packages/provisioning/src/index.ts';
import { addContract, setContractStatus } from '../../worker/scripts/license.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { routesWith } from '../src/routes/index.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Contract {
  id: string;
  holder: { id: string; name: string; kind: string };
  own: boolean;
  tier: string;
  populationServed: number | null;
  termStart: string;
  termEnd: string;
  status: string;
  inForce: boolean;
  covered: { id: string; name: string }[];
  coveredCount: number;
}

/** A date `days` from today, as the contract stores it. */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!appUrl || !workerUrl)('subscriptions (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  const run = randomUUID().slice(0, 8);
  const slugs = {
    state: `exercise-lic-state-${run}`,
    a: `exercise-lic-a-${run}`,
    cityA: `exercise-lic-a-city-${run}`,
    b: `exercise-lic-b-${run}`,
    c: `exercise-lic-c-${run}`,
    surge: `exercise-lic-surge-${run}`,
  };
  const ids: Record<keyof typeof slugs, string> = {
    state: '',
    a: '',
    cityA: '',
    b: '',
    c: '',
    surge: '',
  };
  const subjects: Record<string, AccountSubject> = {};
  const by = 'Exercise operator';
  let stateContract = '';

  const get = async (who: string) => {
    const res = await app.inject({
      url: '/api/v1/license',
      headers: { authorization: `Bearer ${who}` },
    });
    return {
      status: res.statusCode,
      body: res.json() as { contracts: Contract[]; inForce: boolean },
    };
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 4);
    dbWorker = createDb(workerUrl!, 2);
    const tenant = async (
      key: keyof typeof slugs,
      kind: 'state' | 'county' | 'city',
      parent: string | null,
      name: string,
    ) => {
      const t = await dbWorker
        .insertInto('cg.tenant')
        .values({ kind, parent_id: parent, slug: slugs[key], name, status: 'active' })
        .returning(['id', 'path', 'kind'])
        .executeTakeFirstOrThrow();
      ids[key] = t.id;
      const account = await withTenant(dbWorker, { tenantId: t.id }, (trx) =>
        trx
          .insertInto('cg.account')
          .values({
            tenant_id: t.id,
            email: `lic-${key}-${run}@example.org`,
            display_name: `Exercise ${key} administrator`,
            status: 'active',
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      const as = (template: string): AccountSubject => {
        const r = roleTemplates.find((x) => x.key === template)!;
        return {
          kind: 'account',
          accountId: account.id,
          tenantId: t.id,
          tenantPath: t.path as string,
          tenantKind: t.kind,
          status: 'active',
          roles: [
            {
              roleId: randomUUID(),
              key: r.key,
              version: 1,
              templateKey: r.key,
              grants: r.grants,
              scope: {},
            },
          ],
          resolvedAt: new Date(),
        };
      };
      subjects[key] = as('tenant_admin');
      subjects[`${key}-director`] = as('county_em_director');
      subjects[`${key}-dispatcher`] = as('dispatcher_call_taker');
    };
    await tenant('state', 'state', null, `Exercise coalition state ${run}`);
    await tenant('a', 'county', ids.state, `Exercise county A ${run}`);
    await tenant('cityA', 'city', ids.a, `Exercise city in A ${run}`);
    await tenant('b', 'county', ids.state, `Exercise county B ${run}`);
    await tenant('c', 'county', ids.state, `Exercise county C ${run}`);
    await tenant('surge', 'county', ids.state, `Exercise surge county ${run}`);

    // The state's coalition contract covers A (and its city) and C; B is not on it.
    stateContract = await addContract(dbWorker, {
      holder: slugs.state,
      tier: 'State coalition (exercise)',
      population: 2_500_000,
      start: day(-100),
      end: day(265),
      covers: [slugs.a, slugs.cityA, slugs.c],
      by,
      reason: 'Exercise: coalition contract signed',
    });
    // A's own earlier contract has run out.
    await addContract(dbWorker, {
      holder: slugs.a,
      tier: 'County (exercise)',
      population: 40_000,
      start: day(-465),
      end: day(-101),
      covers: [slugs.cityA],
      by,
      reason: 'Exercise: last year',
    });

    // The surge county: an intake event, a contract that was cancelled and one that expired.
    await withTenant(dbWorker, { tenantId: ids.surge }, async (trx) => {
      await ensureIntakeGraph(trx, ids.surge, westwindGraph);
      await trx
        .insertInto('cg.event')
        .values({
          tenant_id: ids.surge,
          name: 'Exercise surge tornado',
          hazard_type: 'tornado',
          status: 'active',
          intake_slug: 'surge',
          opened_at: new Date(),
        })
        .execute();
    });
    const cancelled = await addContract(dbWorker, {
      holder: slugs.surge,
      tier: 'County (exercise)',
      population: 30_000,
      start: day(-30),
      end: day(335),
      covers: [],
      by,
      reason: 'Exercise: signed',
    });
    await setContractStatus(dbWorker, cancelled, 'cancelled', by, 'Exercise: not renewed');
    await addContract(dbWorker, {
      holder: slugs.surge,
      tier: 'County (exercise)',
      population: 30_000,
      start: day(-400),
      end: day(-35),
      covers: [],
      by,
      reason: 'Exercise: last year',
    });

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
      publicRoutes: [
        publicRoutes({
          resolver: new TenantResolver(dbApp),
          codes: new ReferenceCodeLeaser(dbApp, 'test'),
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
      .where('slug', 'in', Object.values(slugs))
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('a covered county sees the state contract over it, and its own expired one; never the other members', async () => {
    const { status, body } = await get('a');
    expect(status).toBe(200);
    expect(body.inForce).toBe(true);
    expect(body.contracts).toHaveLength(2);
    const [state, own] = body.contracts as [Contract, Contract];
    expect(state).toMatchObject({
      id: stateContract,
      own: false,
      holder: { id: ids.state, name: `Exercise coalition state ${run}`, kind: 'state' },
      tier: 'State coalition (exercise)',
      populationServed: 2_500_000,
      termStart: day(-100),
      termEnd: day(265),
      status: 'active',
      inForce: true,
      coveredCount: 3,
    });
    // A and its own city, by name; county C is on the contract but not named to A.
    expect(state.covered.map((c) => c.id).sort()).toEqual([ids.a, ids.cityA].sort());
    expect(JSON.stringify(body)).not.toContain(ids.c);
    expect(own).toMatchObject({ own: true, status: 'active', inForce: false, coveredCount: 1 });
    expect(own.covered).toEqual([{ id: ids.cityA, name: `Exercise city in A ${run}` }]);
    // The director reads it too.
    expect((await get('a-director')).body.contracts).toHaveLength(2);
  });

  it('the state sees its contract with every member; a county not on it sees nothing of it', async () => {
    const state = (await get('state')).body.contracts;
    expect(state).toHaveLength(1);
    expect(state[0]!.own).toBe(true);
    expect(state[0]!.covered.map((c) => c.id).sort()).toEqual([ids.a, ids.cityA, ids.c].sort());
    // The state does not see a county's own contracts through it.
    expect(JSON.stringify(state)).not.toContain('County (exercise)');

    const b = await get('b');
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ contracts: [], inForce: false, residentReportsNeverCapped: true });
  });

  it('a role without the subscription is refused', async () => {
    expect((await get('a-dispatcher')).status).toBe(403);
  });

  it('a contract covers only members of its holder, each once', async () => {
    // County A cannot put county B on its contract; nor can it name its own city twice.
    await expect(
      addContract(dbWorker, {
        holder: slugs.a,
        tier: 'County (exercise)',
        population: 40_000,
        start: day(0),
        end: day(365),
        covers: [slugs.b],
        by,
        reason: 'Exercise: a typo',
      }),
    ).rejects.toThrow(/member jurisdictions/);
    await expect(
      addContract(dbWorker, {
        holder: slugs.a,
        tier: 'County (exercise)',
        population: 40_000,
        start: day(0),
        end: day(365),
        covers: [slugs.cityA, slugs.cityA],
        by,
        reason: 'Exercise: a typo',
      }),
    ).rejects.toThrow(/once/);
    await expect(
      addContract(dbWorker, {
        holder: slugs.a,
        tier: 'County (exercise)',
        population: 40_000,
        start: day(10),
        end: day(0),
        covers: [],
        by,
        reason: 'Exercise: a typo',
      }),
    ).rejects.toThrow(/ends after it starts/);
  });

  it('every contract change is audited on the holder with the operator and the reason', async () => {
    const rows = await withTenant(dbWorker, { tenantId: ids.surge }, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'actor_kind', 'reason', 'changes'])
        .where('tenant_id', '=', ids.surge)
        .where('target_type', '=', 'license')
        .orderBy('seq')
        .execute(),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'license.added',
      'license.status_changed',
      'license.added',
    ]);
    expect(rows[1]).toMatchObject({ actor_kind: 'system', reason: 'Exercise: not renewed' });
    expect(rows[1]!.changes).toMatchObject({
      status: { from: 'active', to: 'cancelled' },
      operator: by,
    });
  });

  it('with no contract in force, a surge of resident reports is accepted in full (never metered or capped)', async () => {
    const view = await get('surge');
    expect(view.body.inForce).toBe(false);
    expect(view.body.contracts.map((c) => c.status).sort()).toEqual(['active', 'cancelled']);

    const submission = (executionId: string) => ({
      executionId,
      channel: 'web',
      language: 'en',
      graphKey: westwindGraph.key,
      graphVersion: westwindGraph.version,
      relationship: 'own_home',
      answers: {
        danger_now: { kind: 'value', value: 'no' },
        relationship: { kind: 'value', value: 'own_home' },
        address: { kind: 'value', value: { line1: '12 Oak St', city: 'Westwind' } },
        home_type: { kind: 'value', value: 'house' },
        cause: { kind: 'value', value: 'wind_tornado' },
        damage_types: { kind: 'value', value: ['roof'] },
        roof_state: { kind: 'value', value: 'large_hole' },
        habitable: { kind: 'value', value: 'no' },
        tonight: { kind: 'value', value: 'yes' },
        insurance: { kind: 'unknown' },
        contact: { kind: 'value', value: { phone: '314-555-0199', preferred: 'text' } },
      },
      ownWords: 'A tree fell on the roof.',
      needs: ['cleanup_tarp'],
      consent: {},
    });
    const surge = 30;
    const results = await Promise.all(
      Array.from({ length: surge }, () => {
        const executionId = randomUUID();
        return app.inject({
          method: 'POST',
          url: `/api/public/intake/${slugs.surge}/surge/submissions`,
          headers: { 'idempotency-key': executionId },
          payload: submission(executionId),
        });
      }),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(surge).fill(202));
    const stored = await withTenant(dbWorker, { tenantId: ids.surge }, (trx) =>
      trx
        .selectFrom('cg.intake_submission')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', ids.surge)
        .executeTakeFirstOrThrow(),
    );
    expect(Number(stored.n)).toBe(surge);
  });
});
