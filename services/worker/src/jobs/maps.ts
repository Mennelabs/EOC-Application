/**
 * maps-cut (FLD-13, SCL-13, ADR-0015): for every area of a county's parcels,
 * an offline map package cut from the regional tiles (`tiles-build`), stored
 * at maps/areas/<tenant>/<area>.pmtiles and recorded in cg.map_package. The
 * box is the area's lots with about a kilometre around them, so the streets
 * in and out show. A package is cut again only when the regional tiles were
 * rebuilt or the area's lots moved; an area whose lots are gone loses its
 * package. Without regional tiles nothing happens: the phone keeps its list,
 * its lot sketches and addresses (FLD-04).
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { sql } from 'kysely';
import { extractArea, type Bbox } from '../maps/pmtiles.ts';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

/** About a kilometre around the lots (in degrees of latitude). */
export const MARGIN_DEG = 0.01;
/** The most tiles one package may hold (a county-sized area at street zoom fits well under it). */
export const MAX_TILES = 50_000;
export const ATTRIBUTION = '© OpenStreetMap contributors';

const round = (x: number) => Math.round(x * 1e5) / 1e5;

/** Cuts what changed; `only` limits it to some tenants (tests). Returns how many packages were cut. */
export async function cutAreaMaps(ctx: JobContext, only?: string[]): Promise<number> {
  const regionPath = ctx.maps?.regionPath;
  const objects = ctx.objects;
  if (!regionPath || !objects) return 0;
  let regionStamp: string;
  try {
    const s = await stat(regionPath);
    regionStamp = `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return 0; // No regional tiles built yet (`docker compose --profile maps-build run --rm tiles-build`).
  }
  let cut = 0;
  for (const tenantId of only ?? (await allTenantIds(ctx.db))) {
    const areas = await asSystem(ctx.db, tenantId, (trx) =>
      trx
        .selectFrom('cg.parcel')
        .select([
          'area_key',
          sql<number>`ST_XMin(ST_Extent(geom))`.as('min_lon'),
          sql<number>`ST_YMin(ST_Extent(geom))`.as('min_lat'),
          sql<number>`ST_XMax(ST_Extent(geom))`.as('max_lon'),
          sql<number>`ST_YMax(ST_Extent(geom))`.as('max_lat'),
        ])
        .where('tenant_id', '=', tenantId)
        .where('area_key', 'is not', null)
        .groupBy('area_key')
        .execute(),
    );
    const existing = await asSystem(ctx.db, tenantId, (trx) =>
      trx.selectFrom('cg.map_package').selectAll().where('tenant_id', '=', tenantId).execute(),
    );
    for (const a of areas) {
      if (!a.area_key || a.min_lon === null) continue;
      const box: Bbox = {
        minLon: round(Number(a.min_lon) - MARGIN_DEG),
        minLat: round(Number(a.min_lat) - MARGIN_DEG),
        maxLon: round(Number(a.max_lon) + MARGIN_DEG),
        maxLat: round(Number(a.max_lat) + MARGIN_DEG),
      };
      const had = existing.find((e) => e.area_key === a.area_key);
      if (
        had &&
        had.region_stamp === regionStamp &&
        had.min_lon === box.minLon &&
        had.min_lat === box.minLat &&
        had.max_lon === box.maxLon &&
        had.max_lat === box.maxLat
      )
        continue;
      let out;
      try {
        out = await extractArea(regionPath, box, { maxTiles: MAX_TILES, attribution: ATTRIBUTION });
      } catch (err) {
        ctx.log.warn({ err, tenantId, area: a.area_key }, 'map package not cut');
        continue;
      }
      const key = `maps/areas/${tenantId}/${a.area_key}.pmtiles`;
      await objects.put(key, out.archive, 'application/vnd.pmtiles');
      const sha256 = createHash('sha256').update(out.archive).digest('hex');
      await asSystem(ctx.db, tenantId, async (trx) => {
        const values = {
          min_lon: box.minLon,
          min_lat: box.minLat,
          max_lon: box.maxLon,
          max_lat: box.maxLat,
          min_zoom: out.minZoom,
          max_zoom: out.maxZoom,
          tiles: out.tiles,
          bytes: out.archive.length,
          sha256,
          object_key: key,
          region_stamp: regionStamp,
          cut_at: new Date(),
        };
        const row = await trx
          .insertInto('cg.map_package')
          .values({ tenant_id: tenantId, area_key: a.area_key!, ...values })
          .onConflict((oc) =>
            oc
              .columns(['tenant_id', 'area_key'])
              .doUpdateSet({ ...values, version: sql`cg.map_package.version + 1` }),
          )
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        await systemAudit(trx, tenantId, 'maps-cut', {
          action: 'map_package.cut',
          targetType: 'map_package',
          targetId: row.id,
          targetVersion: row.version,
          changes: {
            fields: [
              { name: 'area', to: a.area_key },
              { name: 'tiles', to: out.tiles },
              { name: 'bytes', to: out.archive.length },
            ],
          },
        });
      });
      cut++;
    }
    // An area whose lots are all gone loses its package.
    const gone = existing.filter((e) => !areas.some((a) => a.area_key === e.area_key));
    for (const g of gone) {
      await objects.delete?.(g.object_key);
      await asSystem(ctx.db, tenantId, async (trx) => {
        await trx.deleteFrom('cg.map_package').where('id', '=', g.id).execute();
        await systemAudit(trx, tenantId, 'maps-cut', {
          action: 'map_package.remove',
          targetType: 'map_package',
          targetId: g.id,
          changes: { fields: [{ name: 'area', from: g.area_key, to: null }] },
        });
      });
    }
  }
  return cut;
}
