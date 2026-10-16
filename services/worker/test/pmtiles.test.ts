/** FLD-13, SCL-13, ADR-0015: offline map packages are cut from the county archive tile for tile; any PMTiles reader opens them. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PMTiles, tileIdToZxy, zxyToTileId, type RangeResponse, type Source } from 'pmtiles';
import {
  deserializeDirectory,
  extractArea,
  serializeDirectory,
  tileCount,
  tileRange,
  writeArchive,
} from '../src/maps/pmtiles.ts';

const dir = mkdtempSync(join(tmpdir(), 'pmtiles-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

/** A synthetic "region": every tile from zoom 0 to 8 says which tile it is; tiles over water repeat. */
function region(): Buffer {
  const tiles = new Map<number, Uint8Array>();
  for (let z = 0; z <= 8; z++)
    for (let x = 0; x < 1 << z; x++)
      for (let y = 0; y < 1 << z; y++)
        tiles.set(zxyToTileId(z, x, y), Buffer.from(x % 7 === 3 ? 'water' : `${z}/${x}/${y}`));
  return writeArchive(tiles, {
    tileType: 1,
    tileCompression: 1,
    bounds: { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 },
    metadata: { name: 'exercise region', vector_layers: [{ id: 'water' }] },
  });
}

const westwind = { minLon: -90.9, minLat: 38.75, maxLon: -90.75, maxLat: 38.85 };

describe('offline map packages (FLD-13, SCL-13)', () => {
  it('directories survive a round trip, contiguous offsets compressed to zero', () => {
    const entries = [
      { tileId: 0, offset: 0, length: 10, runLength: 1 },
      { tileId: 5, offset: 10, length: 4, runLength: 3 },
      { tileId: 9, offset: 0, length: 10, runLength: 1 },
      { tileId: 2 ** 40, offset: 2 ** 33, length: 7, runLength: 1 },
    ];
    expect(deserializeDirectory(serializeDirectory(entries))).toEqual(entries);
  });

  it('the tiles over a box are counted per zoom', () => {
    const r = tileRange(westwind, 8);
    expect(r.minX).toBeLessThanOrEqual(r.maxX);
    expect(r.minY).toBeLessThanOrEqual(r.maxY);
    expect(tileCount(westwind, 0, 0)).toBe(1);
    expect(tileCount(westwind, 0, 14)).toBeGreaterThan(14);
  });

  it('an area is cut tile for tile; outside tiles are left out; the library reads the package', async () => {
    const src = join(dir, 'region.pmtiles');
    writeFileSync(src, region());
    const out = await extractArea(src, westwind, {
      maxZoom: 8,
      attribution: '© OpenStreetMap contributors',
    });
    expect(out.minZoom).toBe(0);
    expect(out.maxZoom).toBe(8);
    expect(out.tiles).toBe(tileCount(westwind, 0, 8));
    const p = new PMTiles(new BufferSource(out.archive));
    const h = await p.getHeader();
    expect(h).toMatchObject({ minZoom: 0, maxZoom: 8, tileType: 1, clustered: true });
    expect(h.minLon).toBeCloseTo(westwind.minLon, 5);
    expect(h.maxLat).toBeCloseTo(westwind.maxLat, 5);
    for (let z = 0; z <= 8; z++) {
      const r = tileRange(westwind, z);
      const inside = await p.getZxy(z, r.minX, r.minY);
      const expected = r.minX % 7 === 3 ? 'water' : `${z}/${r.minX}/${r.minY}`;
      expect(Buffer.from(inside!.data).toString(), `z${z}`).toBe(expected);
      if (r.maxX + 1 < 1 << z) expect(await p.getZxy(z, r.maxX + 1, r.minY)).toBeUndefined();
    }
    expect(await p.getMetadata()).toMatchObject({
      name: 'exercise region',
      vector_layers: [{ id: 'water' }],
      attribution: '© OpenStreetMap contributors',
    });
  });

  it('identical tiles are stored once, and a large package splits its directory into leaves', async () => {
    const tiles = new Map<number, Uint8Array>();
    for (let i = 0; i < 40_000; i++) tiles.set(i * 3, Buffer.from(i % 2 ? 'land' : `t${i}`));
    const archive = writeArchive(tiles, {
      tileType: 1,
      tileCompression: 1,
      bounds: westwind,
      metadata: {},
    });
    const p = new PMTiles(new BufferSource(archive));
    const h = await p.getHeader();
    expect(h.numAddressedTiles).toBe(40_000);
    expect(h.numTileContents).toBe(20_001);
    expect(h.leafDirectoryLength).toBeGreaterThan(0);
    expect(h.rootDirectoryOffset + h.rootDirectoryLength).toBeLessThanOrEqual(16_384);
    for (const i of [0, 1, 12_345, 39_999]) {
      const [z, x, y] = tileIdToZxy(i * 3);
      expect(Buffer.from((await p.getZxy(z, x, y))!.data).toString()).toBe(
        i % 2 ? 'land' : `t${i}`,
      );
    }
  });

  it('a box that would need too many tiles is refused', async () => {
    const src = join(dir, 'region2.pmtiles');
    writeFileSync(src, region());
    await expect(
      extractArea(src, { minLon: -120, minLat: 20, maxLon: -60, maxLat: 50 }, { maxTiles: 100 }),
    ).rejects.toThrow(/needs \d+ tiles/);
  });
});
