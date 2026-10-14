/**
 * File import for every reference dataset (ADR-0039, ADR-0041): a county's
 * own GIS data, a release file (National Risk Index, SVI, FEMA USA
 * Structures) or a source without a pull arrives as CSV, GeoJSON, a
 * GeoPackage or a zipped Shapefile. Staff map the file's columns (or feature
 * properties) to the dataset's fields; points in a CSV come from latitude
 * and longitude columns, areas need one of the geometry formats. Values are coerced by
 * the target field's type (numbers, booleans, lists); empty cells become
 * null, never zero (RULE-02). The result is the rows ready for the snapshot
 * writer plus errors by row and field, never echoing cell values.
 */
import { z } from 'zod';
import { checkRow, ROW_SCHEMAS, type Dataset, type RawRow } from './datasets.ts';
import { FormatError, readGeoPackage, type SourceFeature } from './formats/gpkg.ts';
import { readZippedShapefile } from './formats/shapefile.ts';

export type ImportFormat = 'csv' | 'geojson' | 'gpkg' | 'shapefile';
export const IMPORT_FORMATS = [
  'csv',
  'geojson',
  'gpkg',
  'shapefile',
] as const satisfies readonly ImportFormat[];
export { FormatError };

/** Target field → source column (CSV header or GeoJSON property). */
export type ColumnMapping = Record<string, string>;

export interface ImportError {
  row?: number;
  field?: string;
  message: string;
}

export interface ParsedImport {
  rows: RawRow[];
  errors: ImportError[];
  total: number;
}

const MAX_ROWS = 500_000;
const MAX_ERRORS = 200;

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) out.push(row);
  return out;
}

export type FieldKind = 'number' | 'boolean' | 'list' | 'object' | 'text';

interface ZodDef {
  type: string;
  innerType?: { _zod: { def: ZodDef } };
  options?: { _zod: { def: ZodDef } }[];
}

/** The kind of value a schema takes, through its default, nullable and optional wrappers. */
function kindOf(def: ZodDef): FieldKind {
  if (
    def.innerType &&
    ['default', 'nullable', 'optional', 'prefault', 'readonly'].includes(def.type)
  )
    return kindOf(def.innerType._zod.def);
  switch (def.type) {
    case 'number':
    case 'int':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
    case 'tuple':
      return 'list';
    case 'object':
    case 'record':
      return 'object';
    case 'union': {
      const kinds = new Set((def.options ?? []).map((o) => kindOf(o._zod.def)));
      return kinds.size === 1 ? [...kinds][0]! : 'text';
    }
    default:
      return 'text';
  }
}

/** The kind of value each dataset field takes, read from its schema. */
function fieldKinds(dataset: Dataset): Record<string, FieldKind> {
  const kinds: Record<string, FieldKind> = {};
  for (const [name, schema] of Object.entries(ROW_SCHEMAS[dataset].shape))
    kinds[name] =
      name === 'geometry'
        ? 'object'
        : kindOf((schema as unknown as { _zod: { def: ZodDef } })._zod.def);
  return kinds;
}

export interface ImportField {
  name: string;
  kind: FieldKind;
  required: boolean;
}

/**
 * The fields a file's columns can map to, for the import wizard. Point
 * datasets also offer `latitude` and `longitude` for CSV files; areas need
 * GeoJSON, whose geometry is taken as it is.
 */
export function importFields(dataset: Dataset): ImportField[] {
  const shape = ROW_SCHEMAS[dataset].shape as Record<string, z.ZodType>;
  const kinds = fieldKinds(dataset);
  const fields: ImportField[] = Object.keys(shape)
    .filter((name) => name !== 'geometry')
    .map((name) => ({
      name,
      kind: kinds[name]!,
      required: !shape[name]!.safeParse(undefined).success,
    }));
  const geometry = shape['geometry'];
  if (geometry?.safeParse({ type: 'Point', coordinates: [0, 0] }).success) {
    const required = needsGeometry(dataset);
    fields.push(
      { name: 'latitude', kind: 'number', required },
      { name: 'longitude', kind: 'number', required },
    );
  }
  return fields;
}

/** Whether a dataset's rows must carry a geometry. */
function needsGeometry(dataset: Dataset): boolean {
  const shape = ROW_SCHEMAS[dataset].shape as Record<string, z.ZodType>;
  return 'geometry' in shape && !shape['geometry']!.safeParse(undefined).success;
}

function coerce(kind: FieldKind, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const v = value.trim();
    if (v === '') return null;
    if (kind === 'number') {
      const n = Number(v.replace(/[$,%\s]/g, ''));
      return Number.isFinite(n) ? n : v;
    }
    if (kind === 'boolean') {
      if (/^(true|yes|y|1)$/i.test(v)) return true;
      if (/^(false|no|n|0)$/i.test(v)) return false;
      return v;
    }
    if (kind === 'list')
      return v
        .split(/[;|]/)
        .map((x) => x.trim())
        .filter(Boolean);
    if (kind === 'object') {
      try {
        return JSON.parse(v) as unknown;
      } catch {
        return v;
      }
    }
    return v;
  }
  return value;
}

function mapRecord(
  dataset: Dataset,
  kinds: Record<string, FieldKind>,
  mapping: ColumnMapping,
  get: (source: string) => unknown,
): RawRow {
  const row: RawRow = {};
  for (const [target, source] of Object.entries(mapping)) {
    if (!(target in kinds) || target === 'geometry') continue;
    const value = coerce(kinds[target]!, get(source));
    if (value !== null) row[target] = value;
  }
  return row;
}

function finish(dataset: Dataset, mapped: RawRow[], errors: ImportError[]): ParsedImport {
  const rows: RawRow[] = [];
  mapped.forEach((raw, i) => {
    const checked = checkRow(dataset, raw);
    if (checked.ok) rows.push(raw);
    else if (errors.length < MAX_ERRORS)
      for (const issue of checked.issues.slice(0, 3))
        errors.push({ row: i + 1, field: issue.field, message: issue.message });
  });
  return { rows: errors.length ? [] : rows, errors, total: mapped.length };
}

const text = (body: string | Buffer) => (typeof body === 'string' ? body : body.toString('utf8'));
const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** Features of a GeoJSON, GeoPackage or zipped Shapefile body, with the property names found. */
function readFeatures(
  format: Exclude<ImportFormat, 'csv'>,
  body: string | Buffer,
): { columns: string[]; features: SourceFeature[] } {
  if (format === 'gpkg') return readGeoPackage(Buffer.isBuffer(body) ? body : Buffer.from(body));
  if (format === 'shapefile')
    return readZippedShapefile(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
  let doc: unknown;
  try {
    doc = JSON.parse(stripBom(text(body)));
  } catch {
    throw new FormatError('not valid JSON');
  }
  const features = (doc as { type?: unknown; features?: unknown }).features;
  if ((doc as { type?: unknown }).type !== 'FeatureCollection' || !Array.isArray(features))
    throw new FormatError('not a GeoJSON FeatureCollection');
  const names = new Set<string>();
  const out: SourceFeature[] = features.map((f) => {
    const props = (f as { properties?: unknown }).properties;
    const properties = props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
    for (const k of Object.keys(properties)) names.add(k);
    return { properties, geometry: ((f as { geometry?: unknown }).geometry ?? null) as never };
  });
  return { columns: [...names], features: out };
}

/** The column or property names in a file, for the mapping step; null when it cannot be read. */
export function importColumns(format: ImportFormat, body: string | Buffer): string[] | null {
  try {
    if (format === 'csv') {
      const header = parseCsv(text(body).slice(0, 64 * 1024))[0];
      return header?.length ? header.map((h) => h.trim()) : null;
    }
    const { columns } = readFeatures(format, body);
    return columns.length ? columns : null;
  } catch {
    return null;
  }
}

export function parseImport(
  dataset: Dataset,
  format: ImportFormat,
  body: string | Buffer,
  mapping: ColumnMapping,
): ParsedImport {
  const kinds = fieldKinds(dataset);
  const unknown = Object.keys(mapping).filter(
    (k) => !(k in kinds) && k !== 'latitude' && k !== 'longitude',
  );
  if (unknown.length)
    return {
      rows: [],
      errors: unknown.map((f) => ({ field: f, message: 'not a field of this dataset' })),
      total: 0,
    };
  const errors: ImportError[] = [];

  if (format === 'csv') {
    const table = parseCsv(text(body));
    const header = table.shift() ?? [];
    if (table.length > MAX_ROWS)
      return { rows: [], errors: [{ message: `more than ${MAX_ROWS} rows` }], total: table.length };
    const missing = Object.values(mapping).filter((c) => !header.includes(c));
    if (missing.length)
      return {
        rows: [],
        errors: missing.map((c) => ({ field: c, message: 'column not in the file' })),
        total: table.length,
      };
    if (needsGeometry(dataset) && !(mapping['latitude'] && mapping['longitude']))
      return {
        rows: [],
        errors: [
          {
            field: 'geometry',
            message:
              'map latitude and longitude columns, or import GeoJSON, a GeoPackage or a Shapefile for areas',
          },
        ],
        total: table.length,
      };
    const at = (cells: string[], col: string) => cells[header.indexOf(col)];
    const mapped = table.map((cells) => {
      const row = mapRecord(dataset, kinds, mapping, (c) => at(cells, c));
      const lat = mapping['latitude'] ? Number(at(cells, mapping['latitude'])) : NaN;
      const lon = mapping['longitude'] ? Number(at(cells, mapping['longitude'])) : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lon))
        row['geometry'] = { type: 'Point', coordinates: [lon, lat] };
      return row;
    });
    return finish(dataset, mapped, errors);
  }

  let features: SourceFeature[];
  try {
    features = readFeatures(format, body).features;
  } catch (err) {
    if (err instanceof FormatError)
      return { rows: [], errors: [{ message: err.message }], total: 0 };
    throw err;
  }
  if (features.length > MAX_ROWS)
    return {
      rows: [],
      errors: [{ message: `more than ${MAX_ROWS} features` }],
      total: features.length,
    };
  const mapped = features.map((f) => {
    const row = mapRecord(dataset, kinds, mapping, (c) => f.properties[c]);
    if ('geometry' in kinds && f.geometry) row['geometry'] = f.geometry;
    return row;
  });
  return finish(dataset, mapped, errors);
}
