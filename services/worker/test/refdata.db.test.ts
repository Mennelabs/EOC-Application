/**
 * Reference data jobs against a real PostgreSQL (layer-6 task A; ADR-0039,
 * SCL-09, SCL-06, SCL-12, SEC-13, RULE-10): a tenant's geography comes from
 * its jurisdiction or configuration; a pull from the recorded synthetic
 * responses becomes current and is audited; a source that is down leaves a
 * failed attempt and the last good snapshot; an imported file is validated
 * by row and field, then applied as a snapshot; the schedule queues a due
 * pull once; pruning drops only old, uncited, superseded snapshots and
 * honours legal holds. Runs only with API_DB_TEST_WORKER_URL set. The
 * stack's own worker may share the database (CI), so each test uses its own
 * exercise tenants and asserts on its own snapshots.
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
import { createRecordedHttp, recordingsDir, type EgressHttp } from '@cg/refdata';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../src/idp/keycloak.ts';
import {
  pruneReferenceSnapshots,
  referenceScope,
  refdataImport,
  refdataPull,
  scheduleReferencePulls,
} from '../src/jobs/refdata.ts';
import type { JobContext, OutboxMessage } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const DAY = 86_400_000;

describe.skipIf(!workerUrl)('reference data jobs (database-backed)', () => {
  let db: Kysely<Database>;
  let ctx: JobContext;
  let seeded: Awaited<ReturnType<typeof loadSeed>>;
  const run = randomUUID().slice(0, 8);
  const files = new Map<string, Buffer>();
  const down: EgressHttp = {
    getJson: () => Promise.reject(new Error('reference source unavailable (503)')),
    getText: () => Promise.reject(new Error('reference source unavailable (503)')),
  };
  let sourceDown = false;

  const msg = (
    tenantId: string,
    topic: string,
    payload: Record<string, unknown>,
  ): OutboxMessage => ({
    id: 0,
    tenantId,
    topic,
    payload,
    executionId: randomUUID(),
  });
  const tx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db, { tenantId }, fn);

  /** An exercise county; `quiet` keeps the stack's own schedule (CI) from pulling for it meanwhile. */
  async function county(name: string, fips: string | null, quiet = true): Promise<string> {
    const t = await db
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-ref-${name}-${run}`,
        name: `Exercise reference ${name} ${run}`,
        status: 'provisioning',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx(t.id, async (trx) => {
      if (fips) await trx.insertInto('cg.jurisdiction').values({ tenant_id: t.id, fips }).execute();
      if (quiet)
        await trx
          .insertInto('cg.tenant_config')
          .values({ tenant_id: t.id, key: 'refdata.enabled', value: JSON.stringify(false) })
          .execute();
    });
    return t.id;
  }

  async function current(tenantId: string, dataset: string) {
    return tx(tenantId, (trx) =>
      trx
        .selectFrom('cg.refdata_current')
        .select('snapshot_id')
        .where('tenant_id', '=', tenantId)
        .where('dataset', '=', dataset as never)
        .executeTakeFirst(),
    );
  }

  beforeAll(async () => {
    db = createDb(workerUrl!, 3);
    seeded = await loadSeed(db);
    ctx = {
      db,
      log: pino({ level: 'silent' }),
      idp: {} as unknown as KeycloakAdmin,
      mail: { send: async () => undefined },
      sms: new SimulatorSms(),
      crypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
      objects: {
        async get(key) {
          const body = files.get(key);
          if (!body) throw new Error(`no object ${key}`);
          return { body, contentType: null };
        },
        async put(key, body) {
          files.set(key, Buffer.from(body));
        },
        async putAnchor() {},
        async putLocked() {
          return { versionId: null, mode: 'GOVERNANCE' as const };
        },
      },
      devDirectGrant: false,
      ai: { providerFor: async () => fakeProvider },
      defaultGraph: westwindGraph,
      refdata: {
        mode: 'recorded',
        http: () => (sourceDown ? down : createRecordedHttp(recordingsDir)),
        secrets: {},
      },
    };
  });

  afterAll(async () => {
    // Closed tenants drop out of schedules and listings; tenants are never deleted.
    await db
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', 'like', `exercise-ref-%-${run}`)
      .execute();
    await db?.destroy();
  });

  it('takes the geography from the jurisdiction, the county above a city, the counties below a state, or configuration', async () => {
    const c = await county('scope', '29999');
    const none = await county('noscope', null);
    await tx(c, async (trx) => {
      expect(await referenceScope(trx, c)).toEqual({
        stateFips: '29',
        countyFips: ['29999'],
        countyNames: [`EXERCISE REFERENCE SCOPE ${run.toUpperCase()}`],
      });
    });
    await tx(none, async (trx) => expect(await referenceScope(trx, none)).toBeNull());
    const city = seeded.tenants['city']!;
    await tx(city, async (trx) =>
      expect(await referenceScope(trx, city)).toMatchObject({
        stateFips: '29',
        countyFips: ['29999'],
        countyNames: ['WESTWIND'],
      }),
    );
    // Several county tenants may share a code (exercise tenants here); the state asks once.
    const state = seeded.tenants['state']!;
    await tx(state, async (trx) => {
      const scope = await referenceScope(trx, state);
      expect(scope?.stateFips).toBe('29');
      expect(scope?.countyFips.filter((f) => f === '29999')).toEqual(['29999']);
    });
    await tx(none, async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: none,
          key: 'refdata.scope',
          value: JSON.stringify({
            stateFips: '29',
            countyFips: ['29998', '29999'],
            countyNames: ['Northfield County', 'Westwind County'],
          }),
        })
        .execute();
      expect(await referenceScope(trx, none)).toEqual({
        stateFips: '29',
        countyFips: ['29998', '29999'],
        countyNames: ['NORTHFIELD', 'WESTWIND'],
      });
    });
    const partner = seeded.tenants['coad']!;
    await tx(partner, async (trx) => expect(await referenceScope(trx, partner)).toBeNull());
  });

  it('the schedule queues one pull per due dataset, even when two run at once, and none for a tenant without geography', async () => {
    const c = await county('schedule', '29999', false);
    const none = await county('schedule-none', null, false);
    await Promise.all([scheduleReferencePulls(ctx), scheduleReferencePulls(ctx)]);
    await scheduleReferencePulls(ctx);
    const queued = await db
      .selectFrom('cg.outbox')
      .select(['tenant_id', 'payload'])
      .where('tenant_id', 'in', [c, none])
      .where('topic', '=', 'refdata.pull')
      .execute();
    // Every dataset with a pull source, each once. Flood zones wait for the tract outline: on a
    // stack whose own worker already pulled this county's tracts (CI), they follow; never before.
    const datasets = queued
      .filter((q) => q.tenant_id === c)
      .map((q) => (q.payload as { dataset: string }).dataset)
      .sort();
    expect(new Set(datasets).size).toBe(datasets.length);
    const hasOutline = await current(c, 'tract');
    expect(datasets.filter((d) => d !== 'flood_zone')).toEqual(
      [
        'alert',
        'declaration',
        'facility',
        'nfip_summary',
        'structure',
        'tract',
        'tract_profile',
      ].sort(),
    );
    if (!hasOutline) expect(datasets).not.toContain('flood_zone');
    expect(queued.filter((q) => q.tenant_id === none)).toHaveLength(0);
  });

  it('a pull from the recorded responses becomes current and is audited; a source that is down leaves the last good snapshot (SCL-06)', async () => {
    const c = await county('pull', '29999');
    const m = msg(c, 'refdata.pull', { dataset: 'declaration' });
    await refdataPull(ctx, m);
    const good = await current(c, 'declaration');
    expect(good).toBeDefined();
    const rows = await tx(c, (trx) =>
      trx
        .selectFrom('cg.ref_declaration')
        .select(['disaster_number', 'county_fips', 'programs'])
        .where('snapshot_id', '=', good!.snapshot_id)
        .orderBy('disaster_number')
        .execute(),
    );
    expect(rows.map((r) => r.disaster_number)).toEqual([9901, 9902, 9903]);
    const audit = await tx(c, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'actor_kind', 'target_id'])
        .where('tenant_id', '=', c)
        .where('execution_id', '=', m.executionId)
        .execute(),
    );
    expect(audit).toEqual([
      { action: 'refdata.pull', actor_kind: 'system', target_id: good!.snapshot_id },
    ]);

    sourceDown = true;
    try {
      await expect(
        refdataPull(ctx, msg(c, 'refdata.pull', { dataset: 'declaration' })),
      ).resolves.toBeUndefined();
    } finally {
      sourceDown = false;
    }
    expect((await current(c, 'declaration'))?.snapshot_id).toBe(good!.snapshot_id);
    const last = await tx(c, (trx) =>
      trx
        .selectFrom('cg.refdata_snapshot')
        .select(['status', 'error'])
        .where('tenant_id', '=', c)
        .orderBy('retrieved_at', 'desc')
        .executeTakeFirstOrThrow(),
    );
    expect(last.status).toBe('failed');
    expect(last.error).toContain('503');
  });

  it('pulls every dataset for a county from the recordings; the outline from its tracts lets the flood zones follow (ADR-0039)', async () => {
    const c = await county('all', '29999');
    // CMS filters by county name; this exercise tenant answers to the seed county's.
    await tx(c, (trx) =>
      trx
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: c,
          key: 'refdata.scope',
          value: JSON.stringify({
            stateFips: '29',
            countyFips: ['29999'],
            countyNames: ['Westwind County'],
          }),
        })
        .execute(),
    );
    const pullAll = async () => {
      for (const dataset of [
        'tract',
        'tract_profile',
        'structure',
        'flood_zone',
        'facility',
        'declaration',
        'nfip_summary',
        'alert',
      ])
        await refdataPull(ctx, msg(c, 'refdata.pull', { dataset }));
    };
    await pullAll();
    const counts = await tx(c, (trx) =>
      trx
        .selectFrom('cg.refdata_current as cur')
        .innerJoin('cg.refdata_snapshot as s', 's.id', 'cur.snapshot_id')
        .select(['s.dataset', 's.row_count', 's.status'])
        .where('cur.tenant_id', '=', c)
        .execute(),
    );
    const byDataset = Object.fromEntries(counts.map((r) => [r.dataset, r.row_count]));
    expect(byDataset).toMatchObject({
      tract: 5,
      tract_profile: 5,
      structure: 548,
      flood_zone: 4,
      facility: 3,
      declaration: 3,
      nfip_summary: 6,
      alert: 2,
    });
    await tx(c, async (trx) => {
      expect((await referenceScope(trx, c))?.bbox).toEqual([-90.95, 38.76, -90.75, 38.84]);
      // Structures fall in the tracts the Census drew (the seed's areas).
      const misplaced = await trx
        .selectFrom('cg.ref_structure as s')
        .innerJoin('cg.refdata_current as cs', (j) =>
          j.onRef('cs.snapshot_id', '=', 's.snapshot_id').on('cs.dataset', '=', 'structure'),
        )
        .innerJoin('cg.refdata_current as ct', (j) =>
          j.onRef('ct.tenant_id', '=', 'cs.tenant_id').on('ct.dataset', '=', 'tract'),
        )
        .innerJoin('cg.ref_tract as t', (j) =>
          j.onRef('t.snapshot_id', '=', 'ct.snapshot_id').onRef('t.geoid', '=', 's.tract_geoid'),
        )
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('cs.tenant_id', '=', c)
        .where(sql<boolean>`not st_contains(t.geom, s.geom)`)
        .executeTakeFirstOrThrow();
      expect(Number(misplaced.n)).toBe(0);
    });
  });

  it('pulls nothing when reference pulls are off or the tenant imports only', async () => {
    const c = await county('off', '29999');
    await refdataPull(
      { ...ctx, refdata: { ...ctx.refdata!, mode: 'off' } },
      msg(c, 'refdata.pull', { dataset: 'declaration' }),
    );
    await tx(c, (trx) =>
      trx
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: c,
          key: 'refdata.sources',
          value: JSON.stringify({ declaration: 'import' }),
        })
        .execute(),
    );
    await refdataPull(ctx, msg(c, 'refdata.pull', { dataset: 'declaration' }));
    const n = await tx(c, (trx) =>
      trx
        .selectFrom('cg.refdata_snapshot')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', c)
        .executeTakeFirstOrThrow(),
    );
    expect(Number(n.n)).toBe(0);
  });

  it('validates an imported file by row and field, then applies it as the current snapshot', async () => {
    const c = await county('import', '29999');
    const id = randomUUID();
    const key = `tenants/${c}/refdata/imports/${id}`;
    files.set(
      key,
      Buffer.from(
        'ID,Type,Name,Lat,Lon\nH1,hospital,Exercise General,38.55,-90.45\nH2,castle,Keep,38.56,-90.44\n',
      ),
    );
    const mapping = {
      sourceId: 'ID',
      kind: 'Type',
      name: 'Name',
      latitude: 'Lat',
      longitude: 'Lon',
    };
    await tx(c, (trx) =>
      trx
        .insertInto('cg.refdata_import')
        .values({
          id,
          tenant_id: c,
          execution_id: randomUUID(),
          dataset: 'facility',
          file_name: 'facilities.csv',
          object_key: key,
          format: 'csv',
          bytes: 100,
          columns: JSON.stringify(['ID', 'Type', 'Name', 'Lat', 'Lon']),
          mapping: JSON.stringify(mapping),
          licence: 'Exercise data',
          status: 'validating',
        })
        .execute(),
    );
    const state = () =>
      tx(c, (trx) =>
        trx
          .selectFrom('cg.refdata_import')
          .select(['status', 'errors', 'row_count', 'snapshot_id'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      );
    await refdataImport(ctx, msg(c, 'refdata.import', { importId: id }));
    const invalid = await state();
    expect(invalid.status).toBe('invalid');
    expect(invalid.errors).toEqual([expect.objectContaining({ row: 2, field: 'kind' })]);
    expect(JSON.stringify(invalid.errors)).not.toContain('castle');

    files.set(
      key,
      Buffer.from(
        'ID,Type,Name,Lat,Lon\nH1,hospital,Exercise General,38.55,-90.45\nH2,school,Exercise School,38.56,-90.44\n',
      ),
    );
    await tx(c, (trx) =>
      trx
        .updateTable('cg.refdata_import')
        .set({ status: 'validating' })
        .where('id', '=', id)
        .execute(),
    );
    await refdataImport(ctx, msg(c, 'refdata.import', { importId: id }));
    expect(await state()).toMatchObject({ status: 'validated', row_count: 2, errors: [] });

    await tx(c, (trx) =>
      trx
        .updateTable('cg.refdata_import')
        .set({ status: 'applying' })
        .where('id', '=', id)
        .execute(),
    );
    await refdataImport(ctx, msg(c, 'refdata.import', { importId: id }));
    const applied = await state();
    expect(applied.status).toBe('applied');
    expect((await current(c, 'facility'))?.snapshot_id).toBe(applied.snapshot_id);
    const snap = await tx(c, (trx) =>
      trx
        .selectFrom('cg.refdata_snapshot')
        .select(['mode', 'source', 'import_id', 'row_count'])
        .where('id', '=', applied.snapshot_id!)
        .executeTakeFirstOrThrow(),
    );
    expect(snap).toEqual({ mode: 'import', source: 'import', import_id: id, row_count: 2 });

    // A redelivered message finds the import settled and changes nothing.
    await refdataImport(ctx, msg(c, 'refdata.import', { importId: id }));
    expect((await state()).snapshot_id).toBe(applied.snapshot_id);
  });

  it('prunes old superseded snapshots that no report cites, keeps the current and cited ones, and honours a legal hold (SEC-13, RULE-10)', async () => {
    const c = await county('prune', '29999');
    const pull = () => refdataPull(ctx, msg(c, 'refdata.pull', { dataset: 'declaration' }));
    await pull();
    await pull();
    await pull();
    const all = await tx(c, (trx) =>
      trx
        .selectFrom('cg.refdata_snapshot')
        .select(['id', 'status'])
        .where('tenant_id', '=', c)
        .orderBy('retrieved_at')
        .execute(),
    );
    expect(all.map((s) => s.status)).toEqual(['superseded', 'superseded', 'ready']);
    const [oldest, cited, latest] = all.map((s) => s.id);
    await tx(c, async (trx) => {
      await trx
        .updateTable('cg.refdata_snapshot')
        .set({ retrieved_at: new Date(Date.now() - 200 * DAY) })
        .where('tenant_id', '=', c)
        .execute();
      await trx
        .updateTable('cg.refdata_snapshot')
        .set({ cited: true })
        .where('id', '=', cited!)
        .execute();
      await trx
        .insertInto('cg.legal_hold')
        .values({
          tenant_id: c,
          scope: JSON.stringify({ dataCategory: 'reference_data' }),
          reason: 'Exercise hold on reference data',
          placed_by: seeded.accounts['admin@example.org']!,
        })
        .execute();
    });
    await pruneReferenceSnapshots(ctx);
    const ids = async () =>
      (
        await tx(c, (trx) =>
          trx.selectFrom('cg.refdata_snapshot').select('id').where('tenant_id', '=', c).execute(),
        )
      ).map((s) => s.id);
    expect(await ids()).toHaveLength(3);

    await tx(c, (trx) =>
      trx
        .updateTable('cg.legal_hold')
        .set({ released_at: new Date(), released_by: seeded.accounts['admin@example.org']! })
        .where('tenant_id', '=', c)
        .execute(),
    );
    await pruneReferenceSnapshots(ctx);
    expect((await ids()).sort()).toEqual([cited!, latest!].sort());
    expect(await ids()).not.toContain(oldest);
    const log = await tx(c, (trx) =>
      trx
        .selectFrom('cg.deletion_log')
        .select(['data_category', 'target_type', 'deleted_count'])
        .where('tenant_id', '=', c)
        .execute(),
    );
    expect(log).toEqual([
      { data_category: 'reference_data', target_type: 'refdata_snapshot', deleted_count: 1 },
    ]);
  });
});
