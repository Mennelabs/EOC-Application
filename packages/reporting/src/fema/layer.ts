/**
 * The PDA layer as a live feature layer (layer-6 task H; SCL-09, CON-17):
 * the same homes, places and values as pda-layer.geojson in the package,
 * filled by the county's PDA GIS layer mapping in force (DCL:DEC-15). One
 * point per home at its 100 m cell; nothing personal (DEC-13). The query
 * subset of the GeoServices REST specification is answered from it in
 * memory, so a where clause never reaches SQL.
 */
import type { Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { classifyHomes } from '../counting.ts';
import { loadDamageRecords } from '../load.ts';
import { homeRows } from './data.ts';
import { mappingInForce } from './in-force.ts';
import type { ElementKey } from './vocabulary.ts';

type Trx = Transaction<Database>;

export type LayerValue = string | number | null;

export interface LayerField {
  name: string;
  alias: string;
  type: 'string' | 'number';
}

export interface LayerFeature {
  /** 1-based and stable within one answer (OBJECTID); the record id is never sent. */
  objectId: number;
  point: [number, number] | null;
  attributes: Record<string, LayerValue>;
}

export interface PdaLayer {
  event: { id: string; name: string };
  mapping: { version: number; femaFormVersion: string; status: 'shipped' | 'active' };
  fields: LayerField[];
  features: LayerFeature[];
  /** [minLon, minLat, maxLon, maxLat] of the features with a place; null when none. */
  extent: [number, number, number, number] | null;
}

const NUMERIC = new Set<ElementKey>([
  'home.units',
  'location.lat',
  'location.lon',
  'location.tract_poverty_pct',
  'business.employees',
  'business.days_closed',
] as ElementKey[]);

/** The event's PDA layer, or null when the event is not the tenant's. */
export async function pdaLayer(
  trx: Trx,
  tenantId: string,
  eventId: string,
): Promise<PdaLayer | null> {
  const event = await trx
    .selectFrom('cg.event as e')
    .innerJoin('cg.tenant as t', 't.id', 'e.tenant_id')
    .select(['e.id', 'e.name', 't.timezone'])
    .where('e.id', '=', eventId)
    .where('e.tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!event) return null;
  const mapping = await mappingInForce(trx, tenantId, 'pda_gis_layer');
  const records = await loadDamageRecords(trx, eventId);
  const homes = await homeRows(trx, tenantId, classifyHomes(records).homes, event.timezone);
  const fields: LayerField[] = mapping.fields.map((f) => ({
    name: f.code,
    alias: f.label,
    type: NUMERIC.has(f.element) ? 'number' : 'string',
  }));
  // Ordered by the short reference so OBJECTIDs stay put while the records do.
  const sorted = [...homes].sort((a, b) =>
    String(a.values['record.ref'] ?? '').localeCompare(String(b.values['record.ref'] ?? '')),
  );
  const features = sorted.map((h, i) => ({
    objectId: i + 1,
    point: h.point,
    attributes: Object.fromEntries(
      mapping.fields.map((f) => [f.code, (h.values[f.element] ?? null) as LayerValue]),
    ),
  }));
  let extent: PdaLayer['extent'] = null;
  for (const f of features) {
    if (!f.point) continue;
    const [x, y] = f.point;
    extent = extent
      ? [
          Math.min(extent[0], x),
          Math.min(extent[1], y),
          Math.max(extent[2], x),
          Math.max(extent[3], y),
        ]
      : [x, y, x, y];
  }
  return {
    event: { id: event.id, name: event.name },
    mapping: {
      version: mapping.mappingVersion,
      femaFormVersion: mapping.femaFormVersion,
      status: mapping.status,
    },
    fields,
    features,
    extent,
  };
}

/** One clause of the where subset: a field equal to a value. */
export interface WhereClause {
  field: string;
  value: string | number;
}

/**
 * The where subset the endpoint answers: `1=1`, or `Field = 'text'` and
 * `Field = 12` clauses joined by AND, on the layer's own fields. Anything
 * else is refused with a message (null clauses = everything).
 */
export function parseWhere(
  where: string | undefined,
  fields: readonly LayerField[],
): { ok: true; clauses: WhereClause[] } | { ok: false; message: string } {
  const text = (where ?? '').trim();
  if (!text || /^1\s*=\s*1$/.test(text)) return { ok: true, clauses: [] };
  if (text.length > 1000) return { ok: false, message: 'The where clause is too long.' };
  const names = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const clauses: WhereClause[] = [];
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?))\s*/;
  let rest = text;
  for (;;) {
    const m = re.exec(rest);
    if (!m)
      return { ok: false, message: "Only 1=1 or Field = 'value' joined by AND is supported." };
    const field = names.get(m[1]!.toLowerCase());
    if (!field) return { ok: false, message: `Unknown field: ${m[1]}` };
    clauses.push({
      field: field.name,
      value: m[2] !== undefined ? m[2].replace(/''/g, "'") : Number(m[3]),
    });
    rest = rest.slice(m[0].length);
    if (!rest) break;
    const and = /^AND\s+/i.exec(rest);
    if (!and)
      return { ok: false, message: "Only 1=1 or Field = 'value' joined by AND is supported." };
    rest = rest.slice(and[0].length);
  }
  return { ok: true, clauses };
}

export function matches(f: LayerFeature, clauses: readonly WhereClause[]): boolean {
  return clauses.every((c) => {
    const v = f.attributes[c.field];
    if (v === null || v === undefined) return false;
    return typeof c.value === 'number' ? Number(v) === c.value : String(v) === c.value;
  });
}
