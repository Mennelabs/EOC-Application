/**
 * Live feed pulls (CON-14; layer-8 plan §6; SCL-06, SCL-12), against the
 * database with the recorded synthetic feeds: a pull stores a feed's items
 * under the source, a second pull updates them in place and clears what the
 * feed dropped, a feed that cannot be read leaves its failure on the source
 * beside the last good items, and the schedule pulls only what is due.
 * Runs only with API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createRecordedHttp, recordingsDir, type EgressHttp } from '@cg/refdata';
import { createDb, withTenant, type Database } from '@cg/db';
import type { Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { pullLiveSource, scheduleLivePulls } from '../src/jobs/live.ts';
import type { JobContext } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!workerUrl)('live feed pulls (database-backed)', () => {
  let db: Kysely<Database>;
  let tenantId = '';
  let ctx: JobContext;
  const run = randomUUID().slice(0, 8);
  let clock = new Date('2026-10-15T16:00:00Z');
  let httpOverride: EgressHttp | null = null;

  const source = (kind: 'wzdx' | 'waze' | 'utility', url: string) =>
    withTenant(db, { tenantId }, (trx) =>
      trx
        .insertInto('cg.live_source')
        .values({
          tenant_id: tenantId,
          kind,
          name: `${kind} ${run}`,
          url,
          enabled: true,
          refresh_ms: 300_000,
          last_error: null,
          last_count: null,
          created_by: null,
          updated_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .then((r) => r.id),
    );
  const items = (sourceId: string) =>
    withTenant(db, { tenantId }, (trx) =>
      trx
        .selectFrom('cg.live_condition')
        .select(['external_id', 'kind', 'summary', 'cleared_at', 'as_of'])
        .where('source_id', '=', sourceId)
        .orderBy('external_id')
        .execute(),
    );
  const sourceRow = (id: string) =>
    withTenant(db, { tenantId }, (trx) =>
      trx.selectFrom('cg.live_source').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
    );

  beforeAll(async () => {
    db = createDb(workerUrl!, 2);
    const seeded = await loadSeed(db);
    tenantId = (
      await db
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-live-${run}`,
          name: `Exercise live county ${run}`,
          status: 'active',
          locales: ['en'],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const recorded = createRecordedHttp(recordingsDir);
    ctx = {
      db,
      log: pino({ level: 'silent' }),
      now: () => clock,
      refdata: {
        mode: 'recorded',
        http: () => httpOverride ?? recorded,
        secrets: {},
      },
    } as unknown as JobContext;
  });

  afterAll(async () => {
    await db
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', tenantId)
      .execute();
    await db?.destroy();
  });

  it('a pull stores the feed items under the source and records the outcome on it', async () => {
    const id = await source('wzdx', 'https://wzdx.exercise-dot.example/api/wzdx/v4/feed.geojson');
    const out = await pullLiveSource(ctx, tenantId, id);
    expect(out).toEqual({ status: 'ok', count: 3, error: null });
    const rows = await items(id);
    expect(rows.map((r) => [r.external_id, r.kind, r.cleared_at])).toEqual([
      ['exercise-wz-1', 'work_zone', null],
      ['exercise-wz-2', 'road_closure', null],
      ['exercise-wz-3', 'road_closure', null],
    ]);
    const s = await sourceRow(id);
    expect(s).toMatchObject({ last_status: 'ok', last_count: 3, last_error: null });
    expect(s.last_pulled_at?.toISOString()).toBe(clock.toISOString());
  });

  it('a second pull updates items in place and clears what the feed dropped; a failure keeps the last good items', async () => {
    const id = await source(
      'utility',
      'https://outages.exercise-utility.example/api/outages.geojson',
    );
    expect((await pullLiveSource(ctx, tenantId, id)).count).toBe(2);
    // The feed now carries one outage, restored to fewer customers.
    httpOverride = {
      getJson: async () => ({
        type: 'FeatureCollection',
        features: [
          {
            id: 'exercise-outage-1',
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-90.89, 38.79] },
            properties: {
              id: 'exercise-outage-1',
              utility: 'EXERCISE Electric Cooperative',
              customers_out: 300,
              area: 'Commercial Row',
              as_of: '2026-10-15T17:00:00Z',
            },
          },
        ],
      }),
      getText: async () => '',
    };
    clock = new Date('2026-10-15T17:05:00Z');
    expect(await pullLiveSource(ctx, tenantId, id)).toEqual({
      status: 'ok',
      count: 1,
      error: null,
    });
    let rows = await items(id);
    expect(rows.find((r) => r.external_id === 'exercise-outage-1')).toMatchObject({
      summary: '300 customers out in Commercial Row (EXERCISE Electric Cooperative)',
      cleared_at: null,
    });
    expect(rows.find((r) => r.external_id === 'exercise-outage-2')?.cleared_at?.toISOString()).toBe(
      clock.toISOString(),
    );
    // The feed goes down: the failure is on the source, the items stay (SCL-06).
    httpOverride = {
      getJson: async () => {
        throw new Error('connect ECONNREFUSED (exercise)');
      },
      getText: async () => '',
    };
    clock = new Date('2026-10-15T17:10:00Z');
    expect(await pullLiveSource(ctx, tenantId, id)).toMatchObject({ status: 'failed', count: 0 });
    const s = await sourceRow(id);
    expect(s).toMatchObject({ last_status: 'failed', last_count: 1 });
    expect(s.last_error).toContain('ECONNREFUSED');
    rows = await items(id);
    expect(rows.find((r) => r.external_id === 'exercise-outage-1')?.cleared_at).toBeNull();
    httpOverride = null;
  });

  it('the schedule pulls a source only when its period has passed; a switched-off one never', async () => {
    const waze = await source(
      'waze',
      'https://www.waze.com/partnerhub-api/feeds/exercise-westwind',
    );
    const off = await source('wzdx', 'https://wzdx.exercise-dot.example/api/wzdx/v4/feed.geojson');
    await withTenant(db, { tenantId }, (trx) =>
      trx.updateTable('cg.live_source').set({ enabled: false }).where('id', '=', off).execute(),
    );
    clock = new Date('2026-10-15T18:00:00Z');
    await scheduleLivePulls(ctx);
    expect((await sourceRow(waze)).last_count).toBe(4);
    expect((await sourceRow(off)).last_status).toBe('never');
    const pulledAt = (await sourceRow(waze)).last_pulled_at;
    clock = new Date('2026-10-15T18:02:00Z');
    await scheduleLivePulls(ctx);
    expect((await sourceRow(waze)).last_pulled_at?.toISOString()).toBe(pulledAt?.toISOString());
    clock = new Date('2026-10-15T18:06:00Z');
    await scheduleLivePulls(ctx);
    expect((await sourceRow(waze)).last_pulled_at?.toISOString()).toBe(clock.toISOString());
  });
});
