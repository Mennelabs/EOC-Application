/**
 * Location geography against a real PostgreSQL (layer-6 task C; DCL:DEC-05,
 * EQ-11, RULE-10): each located place gets its census tract from the tract
 * snapshot in use and its most specific jurisdiction (a city inside the
 * county); a new tract snapshot or moved coordinates assign it again; a
 * place outside the county has no tract; the run is audited. Runs only with
 * API_DB_TEST_WORKER_URL set; its exercise tenants are closed afterwards.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { sql, type Kysely } from 'kysely';
import { SimulatorSms } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { connectorFor, createRecordedHttp, recordingsDir, runPull } from '@cg/refdata';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../src/idp/keycloak.ts';
import { assignBatch, assignLocationGeography } from '../src/jobs/geography.ts';
import type { JobContext } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!workerUrl)('location geography (database-backed)', () => {
  let db: Kysely<Database>;
  let ctx: JobContext;
  let county = '';
  let city = '';
  const run = randomUUID().slice(0, 8);
  const tx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db, { tenantId }, fn);

  async function tenant(
    kind: 'county' | 'city',
    parent: string,
    outline: number[],
    fips: string | null,
  ) {
    const t = await db
      .insertInto('cg.tenant')
      .values({
        kind,
        parent_id: parent,
        slug: `exercise-geo-${kind}-${run}`,
        name: `Exercise geography ${kind} ${run}`,
        status: 'provisioning',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx(t.id, async (trx) => {
      await trx
        .insertInto('cg.jurisdiction')
        .values({
          tenant_id: t.id,
          fips,
          geom: sql`ST_Multi(ST_MakeEnvelope(${outline[0]}, ${outline[1]}, ${outline[2]}, ${outline[3]}, 4326))`,
        })
        .execute();
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: t.id, key: 'refdata.enabled', value: JSON.stringify(false) })
        .execute();
    });
    return t.id;
  }

  async function place(lon: number | null, lat: number | null): Promise<string> {
    return (
      await tx(county, (trx) =>
        trx
          .insertInto('cg.location')
          .values({
            tenant_id: county,
            line1: 'Exercise address',
            geom: lon === null ? null : sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id;
  }

  const pullTracts = async () => {
    const c = connectorFor('tract');
    if (!c || c === 'import') throw new Error('no tract connector');
    return runPull(db, c, {
      tenantId: county,
      mode: 'recorded',
      http: createRecordedHttp(recordingsDir),
      scope: { stateFips: '29', countyFips: ['29999'] },
      secrets: {},
      now: () => new Date(),
    });
  };

  const geo = (locationId: string) =>
    tx(county, (trx) =>
      trx
        .selectFrom('cg.location_geo')
        .selectAll()
        .where('location_id', '=', locationId)
        .executeTakeFirst(),
    );

  beforeAll(async () => {
    db = createDb(workerUrl!, 3);
    const seeded = await loadSeed(db);
    county = await tenant(
      'county',
      seeded.tenants['region']!,
      [-90.95, 38.76, -90.75, 38.84],
      '29999',
    );
    city = await tenant('city', county, [-90.8, 38.8, -90.775, 38.82], null);
    ctx = {
      db,
      log: pino({ level: 'silent' }),
      idp: {} as unknown as KeycloakAdmin,
      mail: { send: async () => undefined },
      sms: new SimulatorSms(),
      crypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
      objects: null,
      devDirectGrant: false,
      ai: { providerFor: async () => fakeProvider },
      defaultGraph: westwindGraph,
    };
  });

  afterAll(async () => {
    await db
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', 'like', `exercise-geo-%-${run}`)
      .execute();
    await db?.destroy();
  });

  it('assigns each place its tract and its most specific jurisdiction', async () => {
    const before = await place(-90.905, 38.79);
    // Without its own tracts the county uses those of the nearest tenant above it, if any.
    await assignBatch(ctx, county);
    const inherited = await geo(before);
    expect(inherited?.jurisdiction_tenant_id).toBe(county);
    if (inherited?.tract_snapshot_id) expect(inherited.tract_geoid).toBe('29999000100');

    const tracts = await pullTracts();
    const willow = await place(-90.905, 38.79);
    const harmon = await place(-90.79, 38.812);
    const outside = await place(-91.5, 38.5);
    const nowhere = await place(null, null);
    await assignBatch(ctx, county);
    expect(await geo(before)).toMatchObject({
      tract_geoid: '29999000100',
      tract_snapshot_id: tracts.snapshotId,
    });
    expect(await geo(willow)).toMatchObject({
      tract_geoid: '29999000100',
      jurisdiction_tenant_id: county,
    });
    expect(await geo(harmon)).toMatchObject({
      tract_geoid: '29999000500',
      jurisdiction_tenant_id: city,
    });
    expect(await geo(outside)).toMatchObject({ tract_geoid: null, jurisdiction_tenant_id: null });
    expect(await geo(nowhere)).toBeUndefined();
    // Nothing left to do: a second pass assigns nothing.
    expect(await assignBatch(ctx, county)).toBe(0);
  });

  it('assigns again when a new tract snapshot lands or a place moves (RULE-10)', async () => {
    const p = await place(-90.87, 38.795);
    await assignBatch(ctx, county);
    const first = await geo(p);
    expect(first?.tract_geoid).toBe('29999000200');
    const next = await pullTracts();
    await assignBatch(ctx, county);
    expect((await geo(p))?.tract_snapshot_id).toBe(next.snapshotId);

    await tx(county, (trx) =>
      trx
        .updateTable('cg.location')
        .set({ geom: sql`ST_SetSRID(ST_MakePoint(-90.835, 38.8), 4326)` })
        .where('id', '=', p)
        .execute(),
    );
    await assignBatch(ctx, county);
    expect((await geo(p))?.tract_geoid).toBe('29999000400');
  });

  it('works through every tenant on its schedule and audits the run', async () => {
    await place(-90.85, 38.79);
    await assignLocationGeography(ctx);
    const audit = await tx(county, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'actor_kind', 'target_id'])
        .where('tenant_id', '=', county)
        .where('action', '=', 'location_geo.assign')
        .execute(),
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({ actor_kind: 'system' });
  });
});
