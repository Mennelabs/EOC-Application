/**
 * Read-only feature service for the PDA layer (layer-6 task H; SCL-09,
 * CON-17): ArcGIS and QGIS add it by URL and read the county's damage
 * points as they change, without a file export.
 *
 *   GET /api/gis/:tenant/pda/FeatureServer             service
 *   GET /api/gis/:tenant/pda/FeatureServer/0           layer
 *   GET /api/gis/:tenant/pda/FeatureServer/0/query     the query subset
 *
 * The subset of the GeoServices REST specification: where (1=1 or
 * Field = 'value' joined by AND), outFields, returnGeometry, objectIds,
 * resultOffset and resultRecordCount (2,000 at most), returnCountOnly,
 * returnIdsOnly; f=json (Esri JSON) or f=geojson; WGS 84 only. Spatial
 * filters and other spatial references are refused, not ignored.
 *
 * An API key with the pda.read scope, active (approved by a second
 * administrator), unexpired and unrevoked, is required: X-API-Key, or the
 * token parameter GIS clients send (logging.ts removes it from request logs). A wrong,
 * unknown, revoked or expired key all answer the same. The layer is the
 * one in the IDA package: a 100 m cell per home and the mapping's fields,
 * nothing personal (DEC-13). Each answer is audited against the key.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import { apiKeyMatches, apiKeyPrefix } from '@cg/crypto';
import { matches, parseWhere, pdaLayer, type LayerFeature, type PdaLayer } from '@cg/reporting';
import { recordAudit } from '@cg/audit';
import type { TenantResolver } from '../public/tenant-resolver.ts';

export interface GisDeps {
  resolver: Pick<TenantResolver, 'bySlug'>;
  db: Kysely<Database>;
  /** How long a computed layer is reused (ms); 30 s by default. */
  cacheMs?: number;
  now?: () => Date;
}

const MAX_RECORDS = 2000;
const SR = { wkid: 4326, latestWkid: 4326 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Query = Record<string, string | undefined>;

function esriError(reply: FastifyReply, status: number, message: string) {
  // Esri clients read the body's error; the HTTP status says the same.
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .send({ error: { code: status === 401 ? 499 : status, message, details: [] } });
}

const esriField = (f: PdaLayer['fields'][number]) =>
  f.type === 'number'
    ? { name: f.name, alias: f.alias, type: 'esriFieldTypeDouble', nullable: true }
    : { name: f.name, alias: f.alias, type: 'esriFieldTypeString', length: 256, nullable: true };

const OID = { name: 'OBJECTID', alias: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false };

function extentOf(layer: PdaLayer | null) {
  const e = layer?.extent;
  return e
    ? { xmin: e[0], ymin: e[1], xmax: e[2], ymax: e[3], spatialReference: SR }
    : { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: SR };
}

const truthy = (v: string | undefined) => v === 'true' || v === '1';

export function gisRoutes(deps: GisDeps): FastifyPluginAsync {
  const cacheMs = deps.cacheMs ?? 30_000;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; layer: PdaLayer | null }>();

  return async (app) => {
    /** The tenant and key, or an answer already sent. */
    async function admit(
      request: FastifyRequest<{ Params: { tenant: string }; Querystring: Query }>,
      reply: FastifyReply,
    ): Promise<{ tenantId: string; keyId: string; prefix: string; eventId: string | null } | null> {
      const header = request.headers['x-api-key'];
      const key =
        (typeof header === 'string' ? header : undefined) ?? request.query['token'] ?? undefined;
      if (!key) {
        await esriError(reply, 401, 'An API key is required.');
        return null;
      }
      let tenant;
      try {
        tenant = await deps.resolver.bySlug(request.params.tenant);
      } catch {
        await esriError(reply, 404, 'Not found.');
        return null;
      }
      const prefix = apiKeyPrefix(key);
      const at = now();
      const found = prefix
        ? await withTenant(deps.db, { tenantId: tenant.id }, async (trx) => {
            const row = await trx
              .selectFrom('cg.api_key')
              .select(['id', 'secret_hash', 'status', 'scopes', 'expires_at', 'last_used_at'])
              .where('tenant_id', '=', tenant.id)
              .where('prefix', '=', prefix)
              .executeTakeFirst();
            if (
              !row ||
              !apiKeyMatches(key, row.secret_hash) ||
              row.status !== 'active' ||
              row.expires_at.getTime() <= at.getTime() ||
              !row.scopes.includes('pda.read')
            )
              return null;
            // Last use, at most once a minute per key.
            if (!row.last_used_at || at.getTime() - row.last_used_at.getTime() > 60_000)
              await trx
                .updateTable('cg.api_key')
                .set({ last_used_at: at })
                .where('id', '=', row.id)
                .execute();
            return row;
          })
        : null;
      if (!found) {
        await esriError(reply, 401, 'The API key is not valid.');
        return null;
      }
      const wanted = request.query['event'];
      if (wanted !== undefined && !UUID.test(wanted)) {
        await esriError(reply, 400, 'event must be an event id.');
        return null;
      }
      const eventId = await withTenant(deps.db, { tenantId: tenant.id }, async (trx) => {
        const row = await trx
          .selectFrom('cg.event')
          .select('id')
          .where('tenant_id', '=', tenant.id)
          .$if(!!wanted, (q) => q.where('id', '=', wanted!))
          .$if(!wanted, (q) => q.where('status', '=', 'active'))
          .orderBy('opened_at', (ob) => ob.desc().nullsLast())
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        return row?.id ?? null;
      });
      if (wanted && !eventId) {
        await esriError(reply, 404, 'Not found.');
        return null;
      }
      return { tenantId: tenant.id, keyId: found.id, prefix: prefix!, eventId };
    }

    async function layerFor(tenantId: string, eventId: string | null): Promise<PdaLayer | null> {
      if (!eventId) return null;
      const k = `${tenantId}:${eventId}`;
      const hit = cache.get(k);
      if (hit && Date.now() - hit.at < cacheMs) return hit.layer;
      const layer = await withTenant(deps.db, { tenantId }, (trx) =>
        pdaLayer(trx, tenantId, eventId),
      );
      cache.set(k, { at: Date.now(), layer });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return layer;
    }

    const audit = (
      request: FastifyRequest,
      who: { tenantId: string; keyId: string; prefix: string; eventId: string | null },
      what: Record<string, unknown>,
    ) =>
      withTenant(deps.db, { tenantId: who.tenantId }, (trx) =>
        recordAudit(trx, {
          tenantId: who.tenantId,
          actorKind: 'public',
          actorAccountId: null,
          action: 'api_key.use',
          targetType: 'api_key',
          targetId: who.keyId,
          requestId: request.id,
          reason: `feature service, key ${who.prefix}`,
          changes: { eventId: who.eventId, ...what },
        }),
      );

    const noStore = (reply: FastifyReply) =>
      reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');

    app.get<{ Params: { tenant: string }; Querystring: Query }>(
      '/:tenant/pda/FeatureServer',
      async (request, reply) => {
        const who = await admit(request, reply);
        if (!who) return reply;
        const layer = await layerFor(who.tenantId, who.eventId);
        return noStore(reply).send({
          currentVersion: 10.81,
          serviceDescription: layer
            ? `Preliminary damage assessment for ${layer.event.name}: one point per home at its 100 m cell.`
            : 'Preliminary damage assessment: no active event.',
          hasVersionedData: false,
          supportsDisconnectedEditing: false,
          maxRecordCount: MAX_RECORDS,
          supportedQueryFormats: 'JSON, geoJSON',
          capabilities: 'Query',
          spatialReference: SR,
          initialExtent: extentOf(layer),
          fullExtent: extentOf(layer),
          layers: [{ id: 0, name: 'PDA', geometryType: 'esriGeometryPoint' }],
          tables: [],
        });
      },
    );

    app.get<{ Params: { tenant: string }; Querystring: Query }>(
      '/:tenant/pda/FeatureServer/0',
      async (request, reply) => {
        const who = await admit(request, reply);
        if (!who) return reply;
        const layer = await layerFor(who.tenantId, who.eventId);
        return noStore(reply).send({
          currentVersion: 10.81,
          id: 0,
          name: 'PDA',
          type: 'Feature Layer',
          description: layer
            ? `${layer.event.name}. PDA GIS layer mapping version ${layer.mapping.version} (${layer.mapping.status}).`
            : 'No active event.',
          geometryType: 'esriGeometryPoint',
          objectIdField: 'OBJECTID',
          displayField: 'RecordID',
          fields: [OID, ...(layer?.fields ?? []).map(esriField)],
          extent: extentOf(layer),
          spatialReference: SR,
          capabilities: 'Query',
          maxRecordCount: MAX_RECORDS,
          supportedQueryFormats: 'JSON, geoJSON',
          advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: false },
          hasAttachments: false,
        });
      },
    );

    app.get<{ Params: { tenant: string }; Querystring: Query }>(
      '/:tenant/pda/FeatureServer/0/query',
      async (request, reply) => {
        const who = await admit(request, reply);
        if (!who) return reply;
        const q = request.query;
        const f = (q['f'] ?? 'json').toLowerCase();
        if (!['json', 'pjson', 'geojson'].includes(f))
          return esriError(reply, 400, 'f must be json or geojson.');
        for (const p of ['geometry', 'geometryType', 'spatialRel', 'distance', 'orderByFields'])
          if (q[p]) return esriError(reply, 400, `${p} is not supported by this service.`);
        if (q['outSR'] && !/^(4326|\{"wkid":\s*4326\})$/.test(q['outSR']))
          return esriError(reply, 400, 'Only WGS 84 (4326) is supported.');
        const layer = await layerFor(who.tenantId, who.eventId);
        const fields = layer?.fields ?? [];
        const parsed = parseWhere(q['where'], fields);
        if (!parsed.ok) return esriError(reply, 400, parsed.message);
        const ids = q['objectIds']
          ? new Set(
              q['objectIds']
                .split(',')
                .map((x) => Number(x.trim()))
                .filter((n) => Number.isInteger(n)),
            )
          : null;
        let rows: LayerFeature[] = (layer?.features ?? []).filter(
          (x) => matches(x, parsed.clauses) && (!ids || ids.has(x.objectId)),
        );
        if (truthy(q['returnCountOnly'])) {
          await audit(request, who, { op: 'count', count: rows.length });
          return noStore(reply).send({ count: rows.length });
        }
        if (truthy(q['returnIdsOnly'])) {
          await audit(request, who, { op: 'ids', count: rows.length });
          return noStore(reply).send({
            objectIdFieldName: 'OBJECTID',
            objectIds: rows.map((x) => x.objectId),
          });
        }
        const offset = Math.max(0, Number.parseInt(q['resultOffset'] ?? '0', 10) || 0);
        const count = Math.min(
          MAX_RECORDS,
          Math.max(
            1,
            Number.parseInt(q['resultRecordCount'] ?? `${MAX_RECORDS}`, 10) || MAX_RECORDS,
          ),
        );
        const exceeded = rows.length > offset + count;
        rows = rows.slice(offset, offset + count);
        const wanted =
          !q['outFields'] || q['outFields'].trim() === '*'
            ? fields.map((x) => x.name)
            : q['outFields']
                .split(',')
                .map((x) => x.trim())
                .filter((x) => fields.some((fl) => fl.name === x));
        const geometry = q['returnGeometry'] === undefined || truthy(q['returnGeometry']);
        const attrs = (x: LayerFeature) => ({
          OBJECTID: x.objectId,
          ...Object.fromEntries(wanted.map((n) => [n, x.attributes[n] ?? null])),
        });
        await audit(request, who, { op: 'query', count: rows.length, where: q['where'] ?? '1=1' });
        if (f === 'geojson')
          return noStore(reply)
            .type('application/geo+json')
            .send({
              type: 'FeatureCollection',
              features: rows.map((x) => ({
                type: 'Feature',
                id: x.objectId,
                geometry: geometry && x.point ? { type: 'Point', coordinates: x.point } : null,
                properties: attrs(x),
              })),
              ...(exceeded ? { properties: { exceededTransferLimit: true } } : {}),
            });
        return noStore(reply).send({
          objectIdFieldName: 'OBJECTID',
          globalIdFieldName: '',
          geometryType: 'esriGeometryPoint',
          spatialReference: SR,
          fields: [OID, ...fields.filter((x) => wanted.includes(x.name)).map(esriField)],
          features: rows.map((x) => ({
            attributes: attrs(x),
            ...(geometry && x.point
              ? { geometry: { x: x.point[0], y: x.point[1], spatialReference: SR } }
              : {}),
          })),
          exceededTransferLimit: exceeded,
        });
      },
    );
  };
}
