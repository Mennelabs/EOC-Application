/**
 * Offline map packages against a real PostgreSQL (FLD-13, SCL-13, ADR-0015):
 * each parcel area of a county gets a package cut from the regional tiles,
 * covering its lots with a margin, recorded with its size and hash and
 * audited; a second run cuts nothing; rebuilt regional tiles cut it again; an
 * area whose lots are gone loses its package; without regional tiles nothing
 * happens. Runs only with API_DB_TEST_WORKER_URL set; its exercise tenant is
 * closed afterwards.
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { sql, type Kysely } from 'kysely';
import { PMTiles, zxyToTileId, type RangeResponse, type Source } from 'pmtiles';
import { SimulatorSms } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../src/idp/keycloak.ts';
import { cutAreaMaps, MARGIN_DEG } from '../src/jobs/maps.ts';
import type { JobContext, ObjectStore } from '../src/jobs/types.ts';
import { tileRange, writeArchive } from '../src/maps/pmtiles.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

class BufferSource implements Source {
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  getKey() {
    return 'buffer';
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const b = this.buf.subarray(offset, offset + length);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  }
}

/** A synthetic region over eastern Missouri, zoom 0 to 12: each tile names itself. */
function region(): Buffer {
  const box = { minLon: -91.5, minLat: 38.3, maxLon: -90.2, maxLat: 39.2 };
  const tiles = new Map<number, Uint8Array>();
  for (let z = 0; z <= 12; z++) {
    const r = tileRange(box, z);
    for (let x = r.minX; x <= r.maxX; x++)
      for (let y = r.minY; y <= r.maxY; y++)
        tiles.set(zxyToTileId(z, x, y), Buffer.from(`${z}/${x}/${y}`));
  }
  return writeArchive(tiles, {
    tileType: 1,
    tileCompression: 1,
    bounds: box,
    metadata: { name: 'exercise region' },
  });
}

describe.skipIf(!workerUrl)('offline map packages (database-backed)', () => {
  let db: Kysely<Database>;
  let ctx: JobContext;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const dir = mkdtempSync(join(tmpdir(), 'maps-'));
  const regionPath = join(dir, 'region.pmtiles');
  const stored = new Map<string, Buffer>();
  const objects: ObjectStore = {
    get: async (key) => ({ body: stored.get(key)!, contentType: null }),
    put: async (key, body) => {
      stored.set(key, Buffer.from(body));
    },
    delete: async (key) => {
      stored.delete(key);
    },
    putAnchor: async () => undefined,
    putLocked: async () => ({ versionId: null, mode: 'GOVERNANCE' }),
  };
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db, { tenantId: county }, fn);
  const lot = (area: string, n: number, lon: number, lat: number) =>
    tx((trx) =>
      trx
        .insertInto('cg.parcel')
        .values({
          tenant_id: county,
          parcel_id: `MAP-${run}-${area}-${n}`,
          geom: sql`ST_Multi(ST_MakeEnvelope(${lon}, ${lat}, ${lon + 0.0004}, ${lat + 0.0003}, 4326))`,
          line1: `${n} Exercise Map Rd`,
          area_key: area,
        } as never)
        .execute(),
    );
  const packages = () =>
    tx((trx) =>
      trx
        .selectFrom('cg.map_package')
        .selectAll()
        .where('tenant_id', '=', county)
        .orderBy('area_key')
        .execute(),
    );

  beforeAll(async () => {
    db = createDb(workerUrl!, 3);
    const seeded = await loadSeed(db);
    county = (
      await db
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-maps-${run}`,
          name: `Exercise maps ${run}`,
          status: 'provisioning',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    ctx = {
      db,
      log: pino({ level: 'silent' }),
      idp: {} as unknown as KeycloakAdmin,
      mail: { send: async () => undefined },
      sms: new SimulatorSms(),
      crypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
      objects,
      devDirectGrant: false,
      ai: { providerFor: async () => fakeProvider },
      defaultGraph: westwindGraph,
      maps: { regionPath },
    };
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', '=', `exercise-maps-${run}`)
      .execute();
    await db?.destroy();
  });

  it('FLD-13, SCL-13: each area gets a package over its lots, recorded, audited and cut only when something changed', async () => {
    await lot('north', 1, -90.87, 38.81);
    await lot('north', 2, -90.86, 38.815);
    await lot('south', 1, -90.85, 38.77);
    // No regional tiles yet: nothing is cut and nothing fails.
    expect(await cutAreaMaps(ctx, [county])).toBe(0);
    expect(await packages()).toEqual([]);

    writeFileSync(regionPath, region());
    expect(await cutAreaMaps(ctx, [county])).toBe(2);
    const [north, south] = await packages();
    expect(north).toMatchObject({ area_key: 'north', min_zoom: 0, max_zoom: 12 });
    expect(north!.min_lon).toBeCloseTo(-90.87 - MARGIN_DEG, 5);
    expect(north!.max_lat).toBeCloseTo(38.8153 + MARGIN_DEG, 4);
    expect(south!.area_key).toBe('south');
    // The stored package is the one recorded, and any PMTiles reader opens it.
    const body = stored.get(north!.object_key)!;
    expect(north!.object_key).toBe(`maps/areas/${county}/north.pmtiles`);
    expect(body.length).toBe(north!.bytes);
    expect(createHash('sha256').update(body).digest('hex')).toBe(north!.sha256);
    const p = new PMTiles(new BufferSource(body));
    const r = tileRange({ minLon: -90.87, minLat: 38.81, maxLon: -90.86, maxLat: 38.815 }, 12);
    expect(Buffer.from((await p.getZxy(12, r.minX, r.minY))!.data).toString()).toBe(
      `12/${r.minX}/${r.minY}`,
    );
    expect(await p.getMetadata()).toMatchObject({ attribution: '© OpenStreetMap contributors' });
    const audited = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'actor_kind'])
        .where('tenant_id', '=', county)
        .where('target_type', '=', 'map_package')
        .execute(),
    );
    expect(audited).toEqual([
      { action: 'map_package.cut', actor_kind: 'system' },
      { action: 'map_package.cut', actor_kind: 'system' },
    ]);

    // Nothing changed: nothing is cut again.
    expect(await cutAreaMaps(ctx, [county])).toBe(0);
    // A lot added to one area: only that area is cut again, its version moves on.
    await lot('south', 2, -90.84, 38.765);
    expect(await cutAreaMaps(ctx, [county])).toBe(1);
    expect((await packages())[1]).toMatchObject({ area_key: 'south', version: 2 });
    // Rebuilt regional tiles: every area is cut again.
    utimesSync(regionPath, new Date(), new Date(Date.now() + 60_000));
    expect(await cutAreaMaps(ctx, [county])).toBe(2);

    // An area whose lots are gone loses its package and its stored file.
    await tx((trx) =>
      trx
        .deleteFrom('cg.parcel')
        .where('tenant_id', '=', county)
        .where('area_key', '=', 'south')
        .execute(),
    );
    await cutAreaMaps(ctx, [county]);
    expect((await packages()).map((x) => x.area_key)).toEqual(['north']);
    expect(stored.has(south!.object_key)).toBe(false);
  });

  it('FLD-13: in an exercise environment without regional tiles an area gets a street-less package, replaced once real tiles exist', async () => {
    rmSync(regionPath, { force: true });
    await tx((trx) => trx.deleteFrom('cg.map_package').where('tenant_id', '=', county).execute());
    const exercise = { ...ctx, maps: { regionPath, exercise: true } };
    expect(await cutAreaMaps(exercise, [county])).toBe(1);
    const [north] = await packages();
    expect(north).toMatchObject({
      area_key: 'north',
      region_stamp: 'exercise',
      tiles: 0,
      max_zoom: 14,
    });
    const p = new PMTiles(new BufferSource(stored.get(north!.object_key)!));
    expect(await p.getHeader()).toMatchObject({ minZoom: 0, maxZoom: 14, tileType: 1 });
    expect(await p.getMetadata()).toMatchObject({ name: 'Exercise map' });
    expect(await cutAreaMaps(exercise, [county])).toBe(0);
    // Real tiles arrive: the package is cut from them.
    writeFileSync(regionPath, region());
    expect(await cutAreaMaps(exercise, [county])).toBe(1);
    expect((await packages())[0]!.tiles).toBeGreaterThan(0);
  });
});
