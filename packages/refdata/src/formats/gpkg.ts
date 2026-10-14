/**
 * GeoPackage import (OGC 12-128r18; ADR-0041): the first feature table, or
 * the one named, read with Node's built-in SQLite from a private temporary
 * copy that is removed at once. Coordinates must be WGS 84 longitude and
 * latitude (EPSG:4326); other systems are refused with a request to
 * reproject first, so nothing is moved silently.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGpkgGeometry, type GeoJsonGeometry } from './wkb.ts';

export interface SourceFeature {
  properties: Record<string, unknown>;
  geometry: GeoJsonGeometry | null;
}

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function readGeoPackage(
  body: Buffer,
  layer?: string,
): { columns: string[]; features: SourceFeature[] } {
  if (body.toString('latin1', 0, 15) !== 'SQLite format 3')
    throw new FormatError('not a GeoPackage (SQLite) file');
  const dir = mkdtempSync(join(tmpdir(), 'cg-gpkg-'));
  const file = join(dir, 'import.gpkg');
  try {
    writeFileSync(file, body, { mode: 0o600 });
    // Loaded only when a GeoPackage is read: the module is still marked experimental (ADR-0041).
    const { DatabaseSync } = process.getBuiltinModule(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db
        .prepare(
          `select c.table_name as name, g.column_name as geom, g.srs_id as srs
           from gpkg_contents c join gpkg_geometry_columns g on g.table_name = c.table_name
           where c.data_type = 'features' order by c.table_name`,
        )
        .all() as { name: string; geom: string; srs: number }[];
      const table = layer ? tables.find((t) => t.name === layer) : tables[0];
      if (!table)
        throw new FormatError(
          layer ? `no feature table named ${layer}` : 'no feature table in the file',
        );
      const srs = db
        .prepare(
          'select organization as org, organization_coordsys_id as code from gpkg_spatial_ref_sys where srs_id = ?',
        )
        .get(table.srs) as { org: string; code: number } | undefined;
      const wgs84 = table.srs === 4326 || (srs?.org?.toUpperCase() === 'EPSG' && srs.code === 4326);
      if (!wgs84)
        throw new FormatError('coordinates must be WGS 84 (EPSG:4326): reproject the layer first');
      const info = db.prepare(`pragma table_info(${quote(table.name)})`).all() as {
        name: string;
        pk: number;
      }[];
      const columns = info.filter((c) => c.name !== table.geom && c.pk === 0).map((c) => c.name);
      const features: SourceFeature[] = [];
      for (const row of db.prepare(`select * from ${quote(table.name)}`).iterate() as Iterable<
        Record<string, unknown>
      >) {
        const blob = row[table.geom];
        const properties: Record<string, unknown> = {};
        for (const c of columns) properties[c] = row[c];
        features.push({
          properties,
          geometry: blob instanceof Uint8Array ? readGpkgGeometry(blob).geometry : null,
        });
      }
      return { columns, features };
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof FormatError) throw err;
    throw new FormatError(
      `the GeoPackage could not be read (${(err as Error).message.slice(0, 120)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
