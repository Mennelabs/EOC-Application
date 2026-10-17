/**
 * Storing a feed's items (CON-14): each item is matched to the source's row
 * by the source's own id and updated in place; items the feed no longer
 * carries are cleared (never deleted, so what was shown stays on record).
 * Geometry must be a point, line or area with numeric coordinates; anything
 * else is stored without geometry rather than refused.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import type { LiveItem } from './types.ts';

const GEOMETRY_TYPES = new Set([
  'Point',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);
const numbersOnly = (v: unknown): boolean =>
  Array.isArray(v) ? v.every(numbersOnly) : typeof v === 'number' && Number.isFinite(v);

/** A GeoJSON geometry the table accepts, or null. */
export function acceptedGeometry(g: unknown): Record<string, unknown> | null {
  if (!g || typeof g !== 'object') return null;
  const o = g as { type?: unknown; coordinates?: unknown };
  if (typeof o.type !== 'string' || !GEOMETRY_TYPES.has(o.type)) return null;
  if (!Array.isArray(o.coordinates) || !numbersOnly(o.coordinates)) return null;
  return { type: o.type, coordinates: o.coordinates };
}

export interface ApplyResult {
  upserted: number;
  cleared: number;
}

export async function applyLiveItems(
  trx: Transaction<Database>,
  source: { id: string; tenant_id: string },
  items: readonly LiveItem[],
  now: Date,
  actor: string | null,
): Promise<ApplyResult> {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.externalId)) continue;
    seen.add(it.externalId);
    const geometry = acceptedGeometry(it.geometry);
    const geom = geometry
      ? sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)`
      : null;
    const values = {
      kind: it.kind,
      summary: it.summary,
      road: it.road,
      geom,
      severity: it.severity,
      starts_at: it.startsAt ? new Date(it.startsAt) : null,
      ends_at: it.endsAt ? new Date(it.endsAt) : null,
      as_of: new Date(it.asOf),
      source_ref: it.sourceRef,
      cleared_at: null,
      cleared_by: null,
      updated_by: actor,
    };
    await trx
      .insertInto('cg.live_condition')
      .values({
        tenant_id: source.tenant_id,
        source_id: source.id,
        external_id: it.externalId,
        override: false,
        entered_by: null,
        created_by: actor,
        ...values,
      })
      .onConflict((oc) => oc.columns(['source_id', 'external_id']).doUpdateSet(values))
      .execute();
  }
  const cleared = await trx
    .updateTable('cg.live_condition')
    .set({ cleared_at: now, cleared_by: actor, updated_by: actor })
    .where('source_id', '=', source.id)
    .where('cleared_at', 'is', null)
    .where((eb) => (seen.size ? eb('external_id', 'not in', [...seen]) : eb.val(true)))
    .executeTakeFirst();
  return { upserted: seen.size, cleared: Number(cleared.numUpdatedRows ?? 0) };
}
