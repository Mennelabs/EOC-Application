/**
 * Zipped Shapefile import (ESRI Shapefile Technical Description, 1998;
 * ADR-0041): the zip is read with Node's own inflate (no extraction to
 * disk), then the .shp geometry, the .dbf attributes and the .prj
 * coordinate system of the first layer, or the one named. Coordinates must
 * be WGS 84 longitude and latitude; anything else (or a missing .prj) is
 * refused with a request to reproject first. Polygon rings are grouped the
 * Shapefile way (outer rings clockwise, holes counter-clockwise) and written
 * the GeoJSON way. Sizes are capped against zip bombs.
 */
import { inflateRawSync } from 'node:zlib';
import { FormatError, type SourceFeature } from './gpkg.ts';
import type { GeoJsonGeometry } from './wkb.ts';

const MAX_UNZIPPED = 512 * 1024 * 1024;

/** Entries of a zip archive (stored or deflated; no ZIP64, no encryption). */
export function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new FormatError('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff)
    throw new FormatError('ZIP64 archives are not supported');
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new FormatError('the zip directory is damaged');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const unzipped = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    if (flags & 1) throw new FormatError('encrypted zip files are not supported');
    total += unzipped;
    if (total > MAX_UNZIPPED) throw new FormatError('the zip unpacks to more than 512 MB');
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new FormatError('the zip is damaged');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8)
      out.set(name, inflateRawSync(data, { maxOutputLength: Math.max(unzipped, 1) }));
    else throw new FormatError(`zip compression method ${method} is not supported`);
  }
  return out;
}

function readDbf(
  buf: Buffer,
  encoding: 'utf8' | 'latin1',
): { columns: string[]; records: (Record<string, unknown> | null)[] } {
  const records = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields: { name: string; type: string; len: number }[] = [];
  for (let at = 32; at < headerLen - 1 && buf[at] !== 0x0d; at += 32) {
    const raw = buf.subarray(at, at + 11);
    const end = raw.indexOf(0);
    fields.push({
      name: raw.toString('latin1', 0, end < 0 ? 11 : end).trim(),
      type: String.fromCharCode(buf[at + 11]!),
      len: buf[at + 16]!,
    });
  }
  // Deleted records stay as null so record n still pairs with shape n.
  const out: (Record<string, unknown> | null)[] = [];
  for (let r = 0; r < records; r++) {
    let at = headerLen + r * recordLen;
    if (at + recordLen > buf.length) break;
    const deleted = buf[at] === 0x2a;
    at += 1;
    const rec: Record<string, unknown> = {};
    for (const f of fields) {
      const text = buf.toString(encoding, at, at + f.len).trim();
      at += f.len;
      if (f.type === 'N' || f.type === 'F')
        rec[f.name] = text === '' || /^\*+$/.test(text) ? null : Number(text);
      else if (f.type === 'L')
        rec[f.name] = /^[TtYy]$/.test(text) ? true : /^[FfNn]$/.test(text) ? false : null;
      else if (f.type === 'D')
        rec[f.name] = /^\d{8}$/.test(text)
          ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`
          : null;
      else rec[f.name] = text === '' ? null : text;
    }
    out.push(deleted ? null : rec);
  }
  return { columns: fields.map((f) => f.name), records: out };
}

/** Twice the signed area: positive for counter-clockwise rings. */
function signedArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  return a;
}

function inside(pt: number[], ring: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (
      yi! > pt[1]! !== yj! > pt[1]! &&
      pt[0]! < ((xj! - xi!) * (pt[1]! - yi!)) / (yj! - yi!) + xi!
    )
      hit = !hit;
  }
  return hit;
}

function polygonFrom(rings: number[][][]): GeoJsonGeometry {
  const outers: number[][][][] = [];
  const holes: number[][][] = [];
  for (const r of rings) {
    if (signedArea(r) < 0) outers.push([[...r].reverse()]);
    else holes.push(r);
  }
  for (const h of holes) {
    const owner = outers.find((o) => inside(h[0]!, o[0]!));
    if (owner) owner.push([...h].reverse());
    else outers.push([h]); // a lone counter-clockwise ring: taken as an outer ring
  }
  return outers.length === 1
    ? { type: 'Polygon', coordinates: outers[0]! }
    : { type: 'MultiPolygon', coordinates: outers };
}

function readShp(buf: Buffer): (GeoJsonGeometry | null)[] {
  if (buf.length < 100 || buf.readInt32BE(0) !== 9994)
    throw new FormatError('the .shp file is not a shapefile');
  const out: (GeoJsonGeometry | null)[] = [];
  let at = 100;
  while (at + 8 <= buf.length) {
    const len = buf.readInt32BE(at + 4) * 2;
    const c = at + 8;
    at = c + len;
    const type = buf.readInt32LE(c);
    const xy = (p: number) => [buf.readDoubleLE(p), buf.readDoubleLE(p + 8)];
    if (type === 0) out.push(null);
    else if (type === 1 || type === 11 || type === 21)
      out.push({ type: 'Point', coordinates: xy(c + 4) });
    else if ([8, 18, 28].includes(type)) {
      const n = buf.readInt32LE(c + 36);
      const pts = Array.from({ length: n }, (_, i) => xy(c + 40 + i * 16));
      out.push(
        n === 1
          ? { type: 'Point', coordinates: pts[0]! }
          : { type: 'MultiPoint', coordinates: pts },
      );
    } else if ([3, 13, 23, 5, 15, 25].includes(type)) {
      const parts = buf.readInt32LE(c + 36);
      const points = buf.readInt32LE(c + 40);
      const starts = Array.from({ length: parts }, (_, i) => buf.readInt32LE(c + 44 + i * 4));
      const base = c + 44 + parts * 4;
      const rings = starts.map((s, i) =>
        Array.from({ length: (starts[i + 1] ?? points) - s }, (_, k) => xy(base + (s + k) * 16)),
      );
      if ([5, 15, 25].includes(type)) out.push(polygonFrom(rings));
      else
        out.push(
          rings.length === 1
            ? { type: 'LineString', coordinates: rings[0]! }
            : { type: 'MultiLineString', coordinates: rings },
        );
    } else throw new FormatError(`shape type ${type} is not supported`);
  }
  return out;
}

export function readZippedShapefile(
  zip: Buffer,
  layer?: string,
): { columns: string[]; features: SourceFeature[] } {
  const files = unzip(zip);
  const byExt = (base: string, ext: string) =>
    [...files.entries()].find(([n]) => n.toLowerCase() === `${base}.${ext}`)?.[1];
  const shps = [...files.keys()].filter((n) => n.toLowerCase().endsWith('.shp')).sort();
  const shp = layer
    ? shps.find((n) => n.replace(/^.*\//, '').replace(/\.shp$/i, '') === layer)
    : shps[0];
  if (!shp)
    throw new FormatError(layer ? `no layer named ${layer} in the zip` : 'no .shp file in the zip');
  const base = shp.slice(0, -4).toLowerCase();
  const dbf = byExt(base, 'dbf');
  const prj = byExt(base, 'prj')?.toString('latin1') ?? '';
  if (!dbf) throw new FormatError('the .dbf file for the layer is missing');
  if (!/^\s*GEOGCS\[/i.test(prj) || !/WGS[_ ]?(19)?84/i.test(prj))
    throw new FormatError(
      'coordinates must be WGS 84 longitude and latitude (.prj): reproject the layer first',
    );
  const cpg = byExt(base, 'cpg')?.toString('latin1').trim().toUpperCase();
  const encoding = !cpg || cpg.includes('UTF') ? 'utf8' : 'latin1';
  const { columns, records } = readDbf(dbf, encoding);
  const shapes = readShp(files.get(shp)!);
  return {
    columns,
    features: records.flatMap((properties, i) =>
      properties ? [{ properties, geometry: shapes[i] ?? null }] : [],
    ),
  };
}
