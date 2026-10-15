/**
 * Tracts and an event's population profile against a real PostgreSQL
 * (layer-6 task C; DCL:DEC-05/06, EQ-11, RULE-02, RULE-10, NED-09): the
 * tracts in use with their profiles and the snapshot ids to cite; an
 * event's area taken from its footprint, or else from where its reports
 * are; shares weighted by population or households; a tract without an
 * estimate named, never counted as zero; roles without the grant refused.
 * Runs in its own exercise county; only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import {
  connectorFor,
  createRecordedHttp,
  recordingsDir,
  runPull,
  type Dataset,
} from '@cg/refdata';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { assignBatch } from '../../worker/src/jobs/geography.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Profile {
  geoid: string;
  population: number | null;
  households: number | null;
  povertyPct: number | null;
  medianHouseholdIncome: number | null;
}

describe.skipIf(!appUrl || !workerUrl)('tracts and event profiles (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let footprintEvent = '';
  let reportsEvent = '';
  let emptyEvent = '';
  const run = randomUUID().slice(0, 8);
  const snapshots: Partial<Record<Dataset, string>> = {};

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const t = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-tracts-${run}`,
        name: `Exercise tracts ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = t.id;
    for (const dataset of ['tract', 'tract_profile'] as const) {
      const c = connectorFor(dataset);
      if (!c || c === 'import') throw new Error(`no ${dataset} connector`);
      const r = await runPull(dbWorker, c, {
        tenantId: county,
        mode: 'recorded',
        http: createRecordedHttp(recordingsDir),
        scope: { stateFips: '29', countyFips: ['29999'] },
        secrets: {},
        now: () => new Date(),
      });
      snapshots[dataset] = r.snapshotId;
    }
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) })
        .execute();
      const event = (name: string, footprint: boolean) =>
        trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `${name} ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
            // Over tracts 1 and 2 only.
            footprint: footprint
              ? sql`ST_Multi(ST_MakeEnvelope(-90.94, 38.77, -90.87, 38.83, 4326))`
              : null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      footprintEvent = (await event('Exercise footprint event', true)).id;
      reportsEvent = (await event('Exercise reports event', false)).id;
      emptyEvent = (await event('Exercise empty event', false)).id;
      // One located report in tract 3 (whose median income the Census suppressed).
      const loc = await trx
        .insertInto('cg.location')
        .values({
          tenant_id: county,
          geom: sql`ST_SetSRID(ST_MakePoint(-90.85, 38.79), 4326)`,
          precision: 'exact',
          source: 'resident',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cg.report')
        .values({
          tenant_id: county,
          reference_code: `TRACTS-${run}`,
          execution_id: randomUUID(),
          event_id: reportsEvent,
          graph_key: 'default-home-damage',
          graph_version: 1,
          channel_of_origin: 'web',
          relationship: 'own_home',
          location_id: loc.id,
        })
        .execute();
    });
    await assignBatch({ db: dbWorker } as JobContext, county);

    const subject = (template: string): AccountSubject => {
      const r = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId: randomUUID(),
        tenantId: county,
        tenantPath: t.path,
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
    const subjects: Record<string, AccountSubject> = {
      gis: subject('planning_gis_lead'),
      assessor: subject('damage_assessor'),
    };
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

  const get = async <T>(who: string, url: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}` },
    });
    return { status: res.statusCode, body: res.json() as T };
  };

  it('lists the tracts in use with their profiles and the snapshots to cite (RULE-10)', async () => {
    const r = await get<{
      tracts: { snapshotId: string };
      profiles: { snapshotId: string; vintage: string };
      items: { geoid: string; geometry: { type: string }; profile: Profile | null }[];
    }>('gis', '/refdata/tracts');
    expect(r.status).toBe(200);
    expect(r.body.tracts.snapshotId).toBe(snapshots.tract);
    expect(r.body.profiles).toMatchObject({
      snapshotId: snapshots.tract_profile,
      vintage: 'ACS 2020-2024 5-year',
    });
    expect(r.body.items.map((i) => i.geoid)).toEqual([
      '29999000100',
      '29999000200',
      '29999000300',
      '29999000400',
      '29999000500',
    ]);
    expect(r.body.items[0]!.geometry.type).toMatch(/Polygon/);
    expect(r.body.items[2]!.profile!.medianHouseholdIncome).toBeNull();
    expect((await get('assessor', '/refdata/tracts')).status).toBe(403);
  });

  it('profiles an event by its footprint, weighting shares, and by its reports when it has no footprint (DCL:DEC-06)', async () => {
    type P = {
      basis: string;
      items: Profile[];
      missing: string[];
      total: { tracts: number; population: number | null; povertyPct: number | null };
    };
    const byFootprint = await get<P>('gis', `/refdata/profile?event=${footprintEvent}`);
    expect(byFootprint.status).toBe(200);
    expect(byFootprint.body.basis).toBe('footprint');
    expect(byFootprint.body.items.map((i) => i.geoid)).toEqual(['29999000100', '29999000200']);
    const [a, b] = byFootprint.body.items;
    expect(byFootprint.body.total.population).toBe(a!.population! + b!.population!);
    const weighted =
      (a!.povertyPct! * a!.population! + b!.povertyPct! * b!.population!) /
      (a!.population! + b!.population!);
    expect(byFootprint.body.total.povertyPct).toBeCloseTo(weighted, 1);

    const byReports = await get<P>('gis', `/refdata/profile?event=${reportsEvent}`);
    expect(byReports.body).toMatchObject({ basis: 'reports', missing: [], total: { tracts: 1 } });
    expect(byReports.body.items.map((i) => i.geoid)).toEqual(['29999000300']);

    const empty = await get<P>('gis', `/refdata/profile?event=${emptyEvent}`);
    expect(empty.body).toMatchObject({
      basis: 'none',
      items: [],
      total: { tracts: 0, population: null },
    });
    expect((await get('gis', `/refdata/profile?event=${randomUUID()}`)).status).toBe(404);
  });
});
