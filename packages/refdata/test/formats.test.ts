/**
 * GeoPackage and zipped Shapefile import (ADR-0041, ADR-0039): geometry and
 * attributes come through as features, holes stay holes, deleted records
 * stay out, and a layer in another coordinate system is refused rather than
 * moved silently. The files are built here from synthetic values.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  importColumns,
  parseImport,
  readGeoPackage,
  readWkb,
  readZippedShapefile,
  unzip,
} from '../src/index.ts';

// --- writers for the test files -------------------------------------------------

function wkbPoint(x: number, y: number): Buffer {
  const b = Buffer.alloc(21);
  b.writeUInt8(1, 0);
  b.writeUInt32LE(1, 1);
  b.writeDoubleLE(x, 5);
  b.writeDoubleLE(y, 13);
  return b;
}

function wkbPolygon(rings: number[][][], z = false): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(9);
  head.writeUInt8(1, 0);
  head.writeUInt32LE(z ? 1003 : 3, 1);
  head.writeUInt32LE(rings.length, 5);
  parts.push(head);
  for (const r of rings) {
    const n = Buffer.alloc(4);
    n.writeUInt32LE(r.length);
    parts.push(n);
    for (const [x, y] of r) {
      const p = Buffer.alloc(z ? 24 : 16);
      p.writeDoubleLE(x!, 0);
      p.writeDoubleLE(y!, 8);
      if (z) p.writeDoubleLE(140, 16);
      parts.push(p);
    }
  }
  return Buffer.concat(parts);
}

function gpkgBlob(wkb: Buffer, srs = 4326): Buffer {
  const h = Buffer.alloc(8);
  h.write('GP', 0, 'latin1');
  h.writeUInt8(0, 2);
  h.writeUInt8(1, 3); // little-endian header, no envelope
  h.writeInt32LE(srs, 4);
  return Buffer.concat([h, wkb]);
}

function geoPackage(
  srs: number,
  rows: { name: string; beds: number | null; geom: Buffer }[],
): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cg-gpkg-test-'));
  const file = join(dir, 't.gpkg');
  const db = new DatabaseSync(file);
  db.exec(`
    create table gpkg_spatial_ref_sys (srs_name text, srs_id integer primary key, organization text,
      organization_coordsys_id integer, definition text, description text);
    insert into gpkg_spatial_ref_sys values ('WGS 84', 4326, 'EPSG', 4326, '', ''),
      ('NAD83 / Missouri East', 26996, 'EPSG', 26996, '', '');
    create table gpkg_contents (table_name text primary key, data_type text, identifier text,
      description text, last_change text, min_x real, min_y real, max_x real, max_y real, srs_id integer);
    create table gpkg_geometry_columns (table_name text, column_name text, geometry_type_name text,
      srs_id integer, z integer, m integer);
    insert into gpkg_contents (table_name, data_type, srs_id) values ('facilities', 'features', ${srs});
    insert into gpkg_geometry_columns values ('facilities', 'geom', 'POINT', ${srs}, 0, 0);
    create table facilities (fid integer primary key autoincrement, geom blob, name text, beds integer);
  `);
  const ins = db.prepare('insert into facilities (geom, name, beds) values (?, ?, ?)');
  for (const r of rows) ins.run(r.geom, r.name, r.beds);
  db.close();
  const body = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return body;
}

function zip(entries: Record<string, Buffer>, deflate: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const compressed = deflate.includes(name);
    const data = compressed ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(compressed ? 8 : 0, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A polygon shapefile: records are lists of rings (outer clockwise, holes counter-clockwise). */
function shp(records: number[][][][]): Buffer {
  const bodies = records.map((rings) => {
    const points = rings.flat();
    const b = Buffer.alloc(44 + rings.length * 4 + points.length * 16);
    b.writeInt32LE(5, 0);
    b.writeInt32LE(rings.length, 36);
    b.writeInt32LE(points.length, 40);
    let start = 0;
    rings.forEach((r, i) => {
      b.writeInt32LE(start, 44 + i * 4);
      start += r.length;
    });
    points.forEach(([x, y], i) => {
      b.writeDoubleLE(x!, 44 + rings.length * 4 + i * 16);
      b.writeDoubleLE(y!, 52 + rings.length * 4 + i * 16);
    });
    return b;
  });
  const head = Buffer.alloc(100);
  head.writeInt32BE(9994, 0);
  head.writeInt32LE(1000, 28);
  head.writeInt32LE(5, 32);
  const recs = bodies.map((b, i) => {
    const h = Buffer.alloc(8);
    h.writeInt32BE(i + 1, 0);
    h.writeInt32BE(b.length / 2, 4);
    return Buffer.concat([h, b]);
  });
  const all = Buffer.concat([head, ...recs]);
  all.writeInt32BE(all.length / 2, 24);
  return all;
}

function dbf(
  fields: { name: string; type: 'C' | 'N'; len: number }[],
  rows: (string | number | null)[][],
  deleted: number[] = [],
): Buffer {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((n, f) => n + f.len, 0);
  const b = Buffer.alloc(headerLen + rows.length * recordLen + 1, 0x20);
  b.fill(0, 0, headerLen);
  b.writeUInt8(3, 0);
  b.writeUInt32LE(rows.length, 4);
  b.writeUInt16LE(headerLen, 8);
  b.writeUInt16LE(recordLen, 10);
  fields.forEach((f, i) => {
    b.write(f.name, 32 + i * 32, 'latin1');
    b.write(f.type, 32 + i * 32 + 11, 'latin1');
    b.writeUInt8(f.len, 32 + i * 32 + 16);
  });
  b.writeUInt8(0x0d, headerLen - 1);
  rows.forEach((row, r) => {
    let at = headerLen + r * recordLen;
    b.write(deleted.includes(r) ? '*' : ' ', at, 'latin1');
    at++;
    fields.forEach((f, i) => {
      const v = row[i];
      const s = v === null || v === undefined ? '' : String(v);
      b.write(f.type === 'N' ? s.padStart(f.len) : s.padEnd(f.len), at, 'utf8');
      at += f.len;
    });
  });
  b.writeUInt8(0x1a, b.length - 1);
  return b;
}

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const UTM_PRJ = 'PROJCS["NAD_1983_UTM_Zone_15N",GEOGCS["GCS_North_American_1983"]]';

// Outer ring clockwise (the Shapefile way), and a hole counter-clockwise inside it.
const outer = [
  [-90.5, 38.5],
  [-90.5, 38.6],
  [-90.4, 38.6],
  [-90.4, 38.5],
  [-90.5, 38.5],
];
const hole = [
  [-90.47, 38.53],
  [-90.43, 38.53],
  [-90.43, 38.57],
  [-90.47, 38.57],
  [-90.47, 38.53],
];
const second = [
  [-90.3, 38.5],
  [-90.3, 38.55],
  [-90.25, 38.55],
  [-90.25, 38.5],
  [-90.3, 38.5],
];

// --- tests ----------------------------------------------------------------------

describe('well-known binary', () => {
  it('reads points and polygons, dropping Z', () => {
    expect(readWkb(wkbPoint(-90.45, 38.55))).toEqual({
      type: 'Point',
      coordinates: [-90.45, 38.55],
    });
    const poly = readWkb(wkbPolygon([outer], true));
    expect(poly).toEqual({ type: 'Polygon', coordinates: [outer] });
  });
});

describe('GeoPackage', () => {
  it('reads the feature table, its columns and point geometry', () => {
    const body = geoPackage(4326, [
      { name: 'Exercise General', beds: 120, geom: gpkgBlob(wkbPoint(-90.45, 38.55)) },
      { name: 'Exercise Clinic', beds: null, geom: gpkgBlob(wkbPoint(-90.44, 38.56)) },
    ]);
    const { columns, features } = readGeoPackage(body);
    expect(columns).toEqual(['name', 'beds']);
    expect(features[1]).toEqual({
      properties: { name: 'Exercise Clinic', beds: null },
      geometry: { type: 'Point', coordinates: [-90.44, 38.56] },
    });
    expect(importColumns('gpkg', body)).toEqual(['name', 'beds']);
    const parsed = parseImport('facility', 'gpkg', body, {
      sourceId: 'name',
      name: 'name',
      kind: 'name',
      beds: 'beds',
    });
    // "kind" mapped to a name column fails the check by row and field, values never echoed.
    expect(parsed.errors[0]).toMatchObject({ row: 1, field: 'kind' });
    expect(JSON.stringify(parsed.errors)).not.toContain('Exercise');
  });

  it('refuses a layer that is not in WGS 84', () => {
    const body = geoPackage(26996, [{ name: 'x', beds: 1, geom: gpkgBlob(wkbPoint(1, 2), 26996) }]);
    expect(() => readGeoPackage(body)).toThrow(/WGS 84/);
    expect(parseImport('facility', 'gpkg', body, { name: 'name' }).errors[0]!.message).toMatch(
      /reproject/,
    );
    expect(importColumns('gpkg', Buffer.from('not sqlite'))).toBeNull();
  });
});

describe('zipped Shapefile', () => {
  const fields = [
    { name: 'GEOID', type: 'C' as const, len: 11 },
    { name: 'ZONE', type: 'C' as const, len: 4 },
    { name: 'BFE', type: 'N' as const, len: 8 },
  ];
  const layer = (prj: string, deletedRows: number[] = []) =>
    zip(
      {
        'nfhl/zones.shp': shp([[outer, hole], [second]]),
        'nfhl/zones.dbf': dbf(
          fields,
          [
            ['29999000100', 'AE', 452.5],
            ['29999000200', 'X', null],
          ],
          deletedRows,
        ),
        'nfhl/zones.prj': Buffer.from(prj),
        '__MACOSX/nfhl/._zones.shp': Buffer.from('junk'),
      },
      ['nfhl/zones.shp', 'nfhl/zones.dbf'],
    );

  it('unzips stored and deflated entries, skipping macOS metadata', () => {
    const files = unzip(layer(WGS84_PRJ));
    expect([...files.keys()].sort()).toEqual([
      'nfhl/zones.dbf',
      'nfhl/zones.prj',
      'nfhl/zones.shp',
    ]);
  });

  it('reads attributes and polygons, the hole kept inside its outer ring, rings turned the GeoJSON way', () => {
    const { columns, features } = readZippedShapefile(layer(WGS84_PRJ));
    expect(columns).toEqual(['GEOID', 'ZONE', 'BFE']);
    expect(features[0]!.properties).toEqual({ GEOID: '29999000100', ZONE: 'AE', BFE: 452.5 });
    expect(features[1]!.properties['BFE']).toBeNull();
    const g = features[0]!.geometry as { type: string; coordinates: number[][][] };
    expect(g.type).toBe('Polygon');
    expect(g.coordinates).toHaveLength(2);
    expect(g.coordinates[0]).toEqual([...outer].reverse());
    const parsed = parseImport('flood_zone', 'shapefile', layer(WGS84_PRJ), {
      zone: 'ZONE',
      baseFloodElevation: 'BFE',
    });
    // specialHazard is required and not mapped: refused by field.
    expect(parsed.errors.map((e) => e.field)).toContain('specialHazard');
    const tracts = parseImport('tract', 'shapefile', layer(WGS84_PRJ), { geoid: 'GEOID' });
    expect(tracts.errors.map((e) => e.field)).toContain('stateFips');
  });

  it('keeps deleted records out without shifting the shapes', () => {
    const { features } = readZippedShapefile(layer(WGS84_PRJ, [0]));
    expect(features).toHaveLength(1);
    expect(features[0]!.properties['GEOID']).toBe('29999000200');
    expect((features[0]!.geometry as { coordinates: number[][][] }).coordinates[0]).toEqual(
      [...second].reverse(),
    );
  });

  it('refuses a projected layer and a missing .prj', () => {
    expect(() => readZippedShapefile(layer(UTM_PRJ))).toThrow(/reproject/);
    expect(() => readZippedShapefile(layer(''))).toThrow(/WGS 84/);
    expect(() => readZippedShapefile(Buffer.from('not a zip at all, just text'))).toThrow(
      /not a zip/,
    );
  });
});
