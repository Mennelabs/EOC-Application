/**
 * File import for every reference dataset (ADR-0039): a county's own GIS
 * data, a release file (National Risk Index, SVI) or a source without an API
 * (the HIFLD archive) arrives as CSV or GeoJSON. Staff map the file's columns
 * (or GeoJSON properties) to the dataset's fields; points in a CSV come from
 * latitude and longitude columns, areas need GeoJSON. Values are coerced by
 * the target field's type (numbers, booleans, lists); empty cells become
 * null, never zero (RULE-02). The result is the rows ready for the snapshot
 * writer plus errors by row and field, never echoing cell values.
 */
import { z } from 'zod';
import { checkRow, ROW_SCHEMAS, type Dataset, type RawRow } from './datasets.ts';

export type ImportFormat = 'csv' | 'geojson';

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

type FieldKind = 'number' | 'boolean' | 'list' | 'object' | 'text';

/** The kind of value a dataset field takes, read from its schema's JSON Schema. */
function fieldKinds(dataset: Dataset): Record<string, FieldKind> {
  const kinds: Record<string, FieldKind> = {};
  for (const [name, schema] of Object.entries(ROW_SCHEMAS[dataset].shape)) {
    let t: string;
    try {
      t = JSON.stringify(
        z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }),
      );
    } catch {
      t = '';
    }
    kinds[name] =
      name === 'geometry'
        ? 'object'
        : t.includes('"type":"number"') || t.includes('"type":"integer"')
          ? 'number'
          : t.includes('"type":"boolean"')
            ? 'boolean'
            : t.includes('"type":"array"')
              ? 'list'
              : t.includes('"type":"object"')
                ? 'object'
                : 'text';
  }
  return kinds;
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

export function parseImport(
  dataset: Dataset,
  format: ImportFormat,
  body: string,
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
    const table = parseCsv(body);
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
            message: 'map latitude and longitude columns, or import GeoJSON for areas',
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

  let doc: unknown;
  try {
    doc = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
  } catch {
    return { rows: [], errors: [{ message: 'not valid JSON' }], total: 0 };
  }
  const features = (doc as { type?: string; features?: unknown[] }).features;
  if ((doc as { type?: string }).type !== 'FeatureCollection' || !Array.isArray(features))
    return { rows: [], errors: [{ message: 'not a GeoJSON FeatureCollection' }], total: 0 };
  if (features.length > MAX_ROWS)
    return {
      rows: [],
      errors: [{ message: `more than ${MAX_ROWS} features` }],
      total: features.length,
    };
  const mapped = features.map((f) => {
    const feature = f as { properties?: Record<string, unknown>; geometry?: unknown };
    const props = feature.properties ?? {};
    const row = mapRecord(dataset, kinds, mapping, (c) => props[c]);
    if ('geometry' in kinds && feature.geometry) row['geometry'] = feature.geometry;
    return row;
  });
  return finish(dataset, mapped, errors);
}
