/**
 * Snapshot writer against the database (layer-6 task A; ADR-0039, RULE-10,
 * SCL-06, SEC-05): a good snapshot becomes current and supersedes the last;
 * a bad row fails the snapshot and leaves the current one in place; the
 * checksum depends on the rows, not on property order; staff sessions read
 * snapshots but cannot write them; tenants see only their own; a pull from
 * the recorded responses lands, and a source that is down leaves a failed
 * snapshot beside the last good one. Synthetic data.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Database } from '@cg/db';
import type { Kysely } from 'kysely';
import {
  connectorFor,
  createRecordedHttp,
  recordingsDir,
  runPull,
  writeSnapshot,
  type Connector,
  type SnapshotMeta,
} from '../src/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)('reference snapshots (database-backed)', () => {
  let worker: Kysely<Database>;
  let app: Kysely<Database>;
  let tenantId = '';
  let otherTenantId = '';
  const run = randomUUID().slice(0, 8);

  const meta = (over: Partial<SnapshotMeta> = {}): SnapshotMeta => ({
    tenantId,
    dataset: 'facility',
    source: 'test',
    mode: 'recorded',
    scope: { stateFips: '29', countyFips: ['29999'] },
    vintage: '2026',
    sourceUrl: 'https://data.cms.gov/provider-data/test',
    licence: 'U.S. government work',
    ...over,
  });
  const facility = (id: string, extra: Record<string, unknown> = {}) => ({
    sourceId: id,
    kind: 'hospital',
    name: `Exercise Hospital ${id}`,
    geometry: { type: 'Point', coordinates: [-90.45, 38.55] },
    ...extra,
  });

  beforeAll(async () => {
    worker = createDb(workerUrl!, 4);
    app = createDb(appUrl!, 4);
    const parent = await worker
      .selectFrom('cg.tenant')
      .select('id')
      .where('kind', '=', 'state')
      .executeTakeFirstOrThrow();
    for (const which of ['a', 'b'] as const) {
      const t = await worker
        .insertInto('cg.tenant')
        .values({
          kind: 'partner_org',
          parent_id: parent.id,
          slug: `exercise-refdata-${which}-${run}`,
          name: `Exercise reference data test ${which} ${run}`,
          status: 'provisioning',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (which === 'a') tenantId = t.id;
      else otherTenantId = t.id;
    }
  });

  afterAll(async () => {
    await worker?.destroy();
    await app?.destroy();
  });

  it('a good snapshot becomes current, with a row count and checksum', async () => {
    const r = await writeSnapshot(worker, meta(), [facility('H1'), facility('H2')]);
    expect(r).toMatchObject({ status: 'ready', rowCount: 2, error: null });
    expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    const current = await withTenant(worker, { tenantId }, (trx) =>
      trx
        .selectFrom('cg.refdata_current')
        .select('snapshot_id')
        .where('tenant_id', '=', tenantId)
        .where('dataset', '=', 'facility')
        .executeTakeFirst(),
    );
    expect(current?.snapshot_id).toBe(r.snapshotId);
  });

  it('the checksum follows the rows, not the order of their properties', async () => {
    const a = await writeSnapshot(worker, meta(), [
      { name: 'Exercise Hospital X', sourceId: 'X', kind: 'hospital' },
    ]);
    const b = await writeSnapshot(worker, meta(), [
      { kind: 'hospital', sourceId: 'X', name: 'Exercise Hospital X' },
    ]);
    const c = await writeSnapshot(worker, meta(), [
      { kind: 'hospital', sourceId: 'Y', name: 'Exercise Hospital X' },
    ]);
    expect(a.checksum).toBe(b.checksum);
    expect(c.checksum).not.toBe(a.checksum);
  });

  it('a newer snapshot supersedes the last; a failed one leaves the current one in place (SCL-06)', async () => {
    const good = await writeSnapshot(worker, meta(), [facility('G1')]);
    const bad = await writeSnapshot(worker, meta(), [
      facility('B1'),
      facility('B2', { kind: 'castle' }),
    ]);
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('row 2');
    expect(bad.error).not.toContain('castle');
    const rows = await withTenant(worker, { tenantId }, async (trx) => ({
      current: await trx
        .selectFrom('cg.refdata_current')
        .select('snapshot_id')
        .where('tenant_id', '=', tenantId)
        .where('dataset', '=', 'facility')
        .executeTakeFirstOrThrow(),
      badRows: await trx
        .selectFrom('cg.ref_facility')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('snapshot_id', '=', bad.snapshotId)
        .executeTakeFirstOrThrow(),
      statuses: await trx
        .selectFrom('cg.refdata_snapshot')
        .select(['id', 'status'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    }));
    expect(rows.current.snapshot_id).toBe(good.snapshotId);
    expect(Number(rows.badRows.n)).toBe(0);
    const status = new Map(rows.statuses.map((s) => [s.id, s.status]));
    expect(status.get(good.snapshotId)).toBe('ready');
    expect(status.get(bad.snapshotId)).toBe('failed');
    expect([...status.values()].filter((s) => s === 'ready')).toHaveLength(1);
  });

  it('stores geometry from GeoJSON (areas as multipolygons)', async () => {
    const r = await writeSnapshot(worker, meta({ dataset: 'tract' }), [
      {
        geoid: '29999000100',
        stateFips: '29',
        countyFips: '29999',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-90.5, 38.5],
              [-90.4, 38.5],
              [-90.4, 38.6],
              [-90.5, 38.6],
              [-90.5, 38.5],
            ],
          ],
        },
      },
    ]);
    expect(r.status).toBe('ready');
    const g = await withTenant(worker, { tenantId }, (trx) =>
      trx
        .selectFrom('cg.ref_tract')
        .select(sql<string>`GeometryType(geom)`.as('t'))
        .where('snapshot_id', '=', r.snapshotId)
        .executeTakeFirstOrThrow(),
    );
    expect(g.t).toBe('MULTIPOLYGON');
  });

  it('staff sessions read their own snapshots, cannot write them, and never see another tenant (SEC-05)', async () => {
    await writeSnapshot(worker, meta({ tenantId: otherTenantId }), [facility('O1')]);
    const seen = await withTenant(app, { tenantId }, (trx) =>
      trx.selectFrom('cg.refdata_snapshot').select('tenant_id').execute(),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.tenant_id === tenantId)).toBe(true);
    await expect(
      withTenant(app, { tenantId }, (trx) =>
        trx
          .insertInto('cg.refdata_snapshot')
          .values({
            tenant_id: tenantId,
            dataset: 'facility',
            source: 'x',
            mode: 'pull',
            licence: 'x',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a pull from the recorded responses becomes current; a source that is down leaves a failed attempt (SCL-06)', async () => {
    const declarations = connectorFor('declaration');
    if (!declarations || declarations === 'import') throw new Error('no declaration connector');
    const scope = { stateFips: '29', countyFips: ['29999'] };
    const now = () => new Date();
    const good = await runPull(worker, declarations, {
      tenantId,
      mode: 'recorded',
      http: createRecordedHttp(recordingsDir),
      scope,
      secrets: {},
      now,
    });
    expect(good).toMatchObject({ status: 'ready', rowCount: 3 });

    const down: Connector = {
      ...declarations,
      fetch: () => Promise.reject(new Error('source unavailable (503)')),
    };
    const failed = await runPull(worker, down, {
      tenantId,
      mode: 'pull',
      http: createRecordedHttp(recordingsDir),
      scope,
      secrets: {},
      now,
    });
    expect(failed).toMatchObject({ status: 'failed', rowCount: 0 });
    expect(failed.error).toContain('503');
    const state = await withTenant(worker, { tenantId }, async (trx) => ({
      current: await trx
        .selectFrom('cg.refdata_current')
        .select('snapshot_id')
        .where('tenant_id', '=', tenantId)
        .where('dataset', '=', 'declaration')
        .executeTakeFirstOrThrow(),
      good: await trx
        .selectFrom('cg.refdata_snapshot')
        .select(['source', 'source_url', 'licence', 'scope'])
        .where('id', '=', good.snapshotId)
        .executeTakeFirstOrThrow(),
    }));
    expect(state.current.snapshot_id).toBe(good.snapshotId);
    expect(state.good).toMatchObject({ source: 'openfema.declarations', scope });
    expect(state.good.source_url).toContain('https://www.fema.gov/');
  });
});
