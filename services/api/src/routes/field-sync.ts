/**
 * Field sync (layer-4 plan §3 and §5, task F; NFR-07, NFR-08, FLD-13,
 * FLD-14, SCL-06, SEC-05): the phone pulls the changes for its holder's
 * scopes since a cursor (`GET /field/sync`), applies its queued work as a
 * batch of commands in order (`POST /field/commands`) and downloads the area
 * package before deployment (`GET /field/area`). A command is replayed
 * through the same route the console uses, with the command's id as its
 * idempotency key and the record version it was built on as `If-Match`, so
 * a batch applied twice changes nothing and a stale command gets the current
 * record (409) for the person to reconcile; append-only facts never
 * conflict. A volunteer's feed holds only their own and their teams' records,
 * their events' hazards, messages and sites, and the missions they are
 * assigned to (FLD-14). A wipe requested for the device rides along on every
 * sync so the app clears its data on the next contact (FLD-02). Every
 * command leaves a `cg.client_command` row with its outcome.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { iso } from './helpers.ts';

type Trx = Transaction<Database>;

/** The commands a phone may replay, each mapped to the console's own route (plan §3 "same validation, authorization and idempotency"). */
export const FIELD_COMMANDS: Record<
  string,
  { method: 'POST' | 'PATCH'; path: (targetId: string | undefined) => string; needsTarget: boolean }
> = {
  'check_in.start': { method: 'POST', path: () => '/api/v1/check-ins', needsTarget: false },
  'check_in.end': {
    method: 'POST',
    path: (id) => `/api/v1/check-ins/${id}/end`,
    needsTarget: true,
  },
  'position.batch': { method: 'POST', path: () => '/api/v1/positions', needsTarget: false },
  'team.status': { method: 'POST', path: (id) => `/api/v1/teams/${id}/status`, needsTarget: true },
  'assignment.acknowledge': {
    method: 'POST',
    path: (id) => `/api/v1/assignments/${id}/acknowledge`,
    needsTarget: true,
  },
  'assignment.status': {
    method: 'POST',
    path: (id) => `/api/v1/assignments/${id}/status`,
    needsTarget: true,
  },
  'mission.narrative': {
    method: 'POST',
    path: (id) => `/api/v1/missions/${id}/narratives`,
    needsTarget: true,
  },
  'hazard.report': { method: 'POST', path: () => '/api/v1/hazards', needsTarget: false },
  'field_message.receipt': {
    method: 'POST',
    path: (id) => `/api/v1/field-messages/${id}/receipt`,
    needsTarget: true,
  },
  'safety_alert.raise': { method: 'POST', path: () => '/api/v1/safety-alerts', needsTarget: false },
  'reminder.acknowledge': {
    method: 'POST',
    path: (id) => `/api/v1/reminders/${id}/acknowledge`,
    needsTarget: true,
  },
  'reminder.complete': {
    method: 'POST',
    path: (id) => `/api/v1/reminders/${id}/complete`,
    needsTarget: true,
  },
};

const commandIn = z.object({
  /** The phone's UUID for this command: its idempotency key here and on the route it replays. */
  id: z.uuid(),
  kind: z.string().max(60),
  /** The record the command acts on, where the kind needs one. */
  targetId: z.uuid().optional(),
  /** The record version the command was built on (FR-00.05); the route answers 409 when it moved. */
  version: z.number().int().optional(),
  body: z.record(z.string(), z.unknown()).default({}),
  clientAt: z.iso.datetime().optional(),
});

const commandResult = z.object({
  id: z.uuid(),
  kind: z.string(),
  result: z.enum(['applied', 'duplicate', 'conflict', 'rejected']),
  status: z.number().int(),
  record: z
    .object({
      type: z.string().nullable(),
      id: z.uuid().nullable(),
      version: z.number().int().nullable(),
    })
    .nullable(),
  /** On a conflict: the record as it is now, so the person can reconcile (AC-00B). */
  current: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const changeOut = z.object({
  seq: z.number().int(),
  recordType: z.string(),
  recordId: z.uuid(),
  version: z.number().int().nullable(),
  op: z.enum(['upsert', 'delete']),
  scope: z.object({ kind: z.string(), id: z.uuid().nullable() }),
  at: z.iso.datetime(),
});

const point = z.object({ lat: z.number(), lon: z.number() });

/** Record types a volunteer's event scope carries (hazards and messages for the event, sites to send people to). */
const EVENT_TYPES_FOR_FIELD = ['hazard', 'field_message', 'site', 'safety_alert'];

export interface FieldSyncDeps {
  objects?:
    | {
        client: import('@aws-sdk/client-s3').S3Client;
        presignClient?: import('@aws-sdk/client-s3').S3Client;
        bucket: string;
      }
    | undefined;
}

export const fieldSyncRoutes =
  (deps: FieldSyncDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    /** The caller's personnel row, teams and the county whose records a partner's volunteer works in (DSP-09). */
    interface Me {
      personnelId: string;
      personnelTenantId: string;
      /** The tenant whose records hold missions and assignments. */
      tenantId: string;
      partnerId: string | null;
      teamIds: string[];
      name: string;
    }
    async function whoAmI(request: FastifyRequest): Promise<Me> {
      const s = account(request);
      return request.tx(async (trx) => {
        const p = await trx
          .selectFrom('cg.personnel')
          .select(['id', 'tenant_id', 'name', 'status'])
          .where('account_id', '=', s.accountId)
          .executeTakeFirst();
        if (!p || p.status !== 'active')
          throw new ApiError(
            409,
            'no_personnel_record',
            'Your account is not linked to an active personnel record; ask your coordinator.',
          );
        const teams = await trx
          .selectFrom('cg.team_member as tm')
          .innerJoin('cg.team as t', 't.id', 'tm.team_id')
          .select('tm.team_id')
          .where('tm.personnel_id', '=', p.id)
          .where('tm.left_at', 'is', null)
          .where('t.status', '<>', 'archived')
          .execute();
        let tenantId = s.tenantId;
        let partnerId: string | null = null;
        if (s.tenantKind === 'partner_org') {
          const me = await trx
            .selectFrom('cg.tenant')
            .select('parent_id')
            .where('id', '=', s.tenantId)
            .executeTakeFirst();
          tenantId = me?.parent_id ?? s.tenantId;
          partnerId = s.tenantId;
        }
        return {
          personnelId: p.id,
          personnelTenantId: p.tenant_id,
          tenantId,
          partnerId,
          teamIds: teams.map((t) => t.team_id),
          name: p.name,
        };
      });
    }
    const run = <T>(request: FastifyRequest, me: Me, fn: (trx: Trx) => Promise<T>) =>
      me.partnerId ? request.txAs(me.tenantId, fn) : request.tx(fn);

    async function myMissionIds(trx: Trx, me: Me): Promise<string[]> {
      const rows = await trx
        .selectFrom('cg.assignment')
        .select('mission_id')
        .where('released_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('personnel_id', '=', me.personnelId),
            ...(me.teamIds.length ? [eb('team_id', 'in', me.teamIds)] : []),
          ]),
        )
        .execute();
      return [...new Set(rows.map((r) => r.mission_id))];
    }
    async function myEventIds(trx: Trx, me: Me): Promise<string[]> {
      const open = await trx
        .selectFrom('cg.check_in')
        .select('event_id')
        .where('personnel_id', '=', me.personnelId)
        .where('ended_at', 'is', null)
        .execute();
      const active = await trx
        .selectFrom('cg.event')
        .select('id')
        .where('status', '=', 'active')
        .execute();
      return [...new Set([...open.map((o) => o.event_id), ...active.map((a) => a.id)])];
    }

    async function deviceState(
      trx: Trx,
      accountId: string,
      deviceId: string | undefined,
    ): Promise<{ id: string; status: string; wipe: boolean } | null> {
      if (!deviceId) return null;
      const d = await trx
        .selectFrom('cg.field_device')
        .select(['id', 'status'])
        .where('id', '=', deviceId)
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      if (!d) return null;
      await trx
        .updateTable('cg.field_device')
        .set({ last_contact_at: new Date() })
        .where('id', '=', d.id)
        .execute();
      return {
        id: d.id,
        status: d.status,
        wipe: d.status === 'wipe_requested' || d.status === 'wiped',
      };
    }

    // --------------------------------------------------------------- sync
    app.get(
      '/field/sync',
      {
        schema: {
          tags: ['field'],
          querystring: z.object({
            cursor: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(1000).default(500),
            deviceId: z.uuid().optional(),
          }),
          response: {
            200: z.object({
              asOf: z.iso.datetime(),
              cursor: z.number().int(),
              more: z.boolean(),
              changes: z.array(changeOut),
              scopes: z.object({
                personnelId: z.uuid(),
                teamIds: z.array(z.uuid()),
                eventIds: z.array(z.uuid()),
                missionIds: z.array(z.uuid()),
              }),
              device: z.object({ id: z.uuid(), status: z.string(), wipe: z.boolean() }).nullable(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('field.sync', { type: 'change_feed', tenantId: s.tenantId });
        const me = await whoAmI(request);
        const q = request.query;
        const device = await request.tx((trx) => deviceState(trx, s.accountId, q.deviceId));
        return run(request, me, async (trx) => {
          const missionIds = await myMissionIds(trx, me);
          const eventIds = await myEventIds(trx, me);
          const rows = await trx
            .selectFrom('cg.change_feed')
            .select([
              'seq',
              'scope_kind',
              'scope_id',
              'record_type',
              'record_id',
              'record_version',
              'op',
              'created_at',
            ])
            .where('seq', '>', q.cursor)
            .where((eb) =>
              eb.or([
                eb.and([eb('scope_kind', '=', 'person'), eb('scope_id', '=', me.personnelId)]),
                ...(me.teamIds.length
                  ? [eb.and([eb('scope_kind', '=', 'team'), eb('scope_id', 'in', me.teamIds)])]
                  : []),
                ...(eventIds.length
                  ? [
                      eb.and([
                        eb('scope_kind', '=', 'event'),
                        eb('scope_id', 'in', eventIds),
                        eb('record_type', 'in', EVENT_TYPES_FOR_FIELD),
                      ]),
                    ]
                  : []),
                ...(missionIds.length
                  ? [eb.and([eb('record_type', '=', 'mission'), eb('record_id', 'in', missionIds)])]
                  : []),
                ...(device
                  ? [
                      eb.and([
                        eb('record_type', '=', 'field_device'),
                        eb('record_id', '=', device.id),
                      ]),
                    ]
                  : []),
              ]),
            )
            .orderBy('seq')
            .limit(q.limit + 1)
            .execute();
          const more = rows.length > q.limit;
          const page = more ? rows.slice(0, q.limit) : rows;
          const cursor = page.length ? Number(page[page.length - 1]!.seq) : q.cursor;
          return {
            asOf: new Date().toISOString(),
            cursor,
            more,
            changes: page.map((r) => ({
              seq: Number(r.seq),
              recordType: r.record_type,
              recordId: r.record_id,
              version: r.record_version,
              op: r.op,
              scope: { kind: r.scope_kind, id: r.scope_id },
              at: iso(r.created_at)!,
            })),
            scopes: { personnelId: me.personnelId, teamIds: me.teamIds, eventIds, missionIds },
            device,
          };
        });
      },
    );

    // ----------------------------------------------------------- commands
    app.post(
      '/field/commands',
      {
        schema: {
          tags: ['field'],
          body: z.object({
            deviceId: z.uuid().optional(),
            commands: z.array(commandIn).min(1).max(100),
          }),
          response: {
            200: z.object({
              asOf: z.iso.datetime(),
              results: z.array(commandResult),
              device: z.object({ id: z.uuid(), status: z.string(), wipe: z.boolean() }).nullable(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('field.command', { type: 'client_command', tenantId: s.tenantId });
        const me = await whoAmI(request);
        const b = request.body;
        const device = await request.tx((trx) => deviceState(trx, s.accountId, b.deviceId));
        const authorization = request.headers.authorization!;
        const results: z.infer<typeof commandResult>[] = [];
        for (const c of b.commands) {
          // Seen before: the stored outcome, nothing applied again (FLD-13 "two records… never overwritten", AC-00C).
          const seen = await request.tx((trx) =>
            trx
              .selectFrom('cg.client_command')
              .select(['result', 'result_detail', 'record_type', 'record_id', 'record_version'])
              .where('id', '=', c.id)
              .executeTakeFirst(),
          );
          if (seen) {
            const detail = seen.result_detail as {
              status?: number;
              current?: unknown;
              error?: { code: string; message: string };
            };
            results.push({
              id: c.id,
              kind: c.kind,
              result: 'duplicate',
              status: detail.status ?? 200,
              record: seen.record_id
                ? { type: seen.record_type, id: seen.record_id, version: seen.record_version }
                : null,
              ...(detail.current !== undefined ? { current: detail.current } : {}),
              ...(detail.error ? { error: detail.error } : {}),
            });
            continue;
          }
          const spec = FIELD_COMMANDS[c.kind];
          let outcome: z.infer<typeof commandResult>;
          if (!spec || (spec.needsTarget && !c.targetId)) {
            outcome = {
              id: c.id,
              kind: c.kind,
              result: 'rejected',
              status: 400,
              record: null,
              error: {
                code: 'unknown_command',
                message: spec
                  ? 'this command names no record'
                  : 'this command is not one the field app may send',
              },
            };
          } else {
            const payload: Record<string, unknown> = { ...c.body };
            if (c.kind === 'safety_alert.raise' && !payload['clientUuid'])
              payload['clientUuid'] = c.id;
            if (c.kind === 'position.batch' && b.deviceId && !payload['deviceId'])
              payload['deviceId'] = b.deviceId;
            const res = await instance.inject({
              method: spec.method,
              url: spec.path(c.targetId),
              headers: {
                authorization,
                'idempotency-key': c.id,
                'x-field-command': c.id,
                ...(c.version !== undefined ? { 'if-match': String(c.version) } : {}),
                ...(request.headers['accept-language']
                  ? { 'accept-language': String(request.headers['accept-language']) }
                  : {}),
              },
              payload,
            });
            let body: unknown;
            try {
              body = res.body ? (JSON.parse(res.body) as unknown) : null;
            } catch {
              body = null;
            }
            const rec = (body ?? {}) as {
              id?: string;
              version?: number;
              code?: string;
              message?: string;
              details?: unknown;
            };
            if (res.statusCode < 300) {
              outcome = {
                id: c.id,
                kind: c.kind,
                result: 'applied',
                status: res.statusCode,
                record:
                  typeof rec.id === 'string'
                    ? {
                        type: c.kind.split('.')[0] ?? null,
                        id: rec.id,
                        version: typeof rec.version === 'number' ? rec.version : null,
                      }
                    : null,
              };
            } else if (res.statusCode === 409 && rec.code === 'version_conflict') {
              outcome = {
                id: c.id,
                kind: c.kind,
                result: 'conflict',
                status: 409,
                record: c.targetId
                  ? {
                      type: c.kind.split('.')[0] ?? null,
                      id: c.targetId,
                      version: (rec.details as { version?: number } | undefined)?.version ?? null,
                    }
                  : null,
                current: rec.details ?? null,
              };
            } else {
              outcome = {
                id: c.id,
                kind: c.kind,
                result: 'rejected',
                status: res.statusCode,
                record: null,
                error: {
                  code: rec.code ?? 'rejected',
                  message: rec.message ?? 'The command was not accepted.',
                },
              };
            }
          }
          await request.tx(async (trx) => {
            await trx
              .insertInto('cg.client_command')
              .values({
                id: c.id,
                tenant_id: s.tenantId,
                device_id: device?.id ?? null,
                account_id: s.accountId,
                personnel_id: me.personnelId,
                kind: c.kind,
                payload: JSON.stringify(c.body),
                client_at: c.clientAt ? new Date(c.clientAt) : null,
                applied_at: outcome.result === 'applied' ? new Date() : null,
                result: outcome.result,
                result_detail: JSON.stringify({
                  status: outcome.status,
                  ...(outcome.current !== undefined ? { current: outcome.current } : {}),
                  ...(outcome.error ? { error: outcome.error } : {}),
                }),
                record_type: outcome.record?.type ?? null,
                record_id: outcome.record?.id ?? null,
                record_version: outcome.record?.version ?? null,
              })
              .onConflict((oc) => oc.doNothing())
              .execute();
          });
          results.push(outcome);
        }
        return { asOf: new Date().toISOString(), results, device };
      },
    );

    // --------------------------------------------------------------- area
    app.get(
      '/field/area',
      {
        schema: {
          tags: ['field'],
          querystring: z.object({
            eventId: z.uuid().optional(),
            /** Parcel areas to pack; the areas around the caller's assignments otherwise. */
            areaKey: z.string().max(80).optional(),
            /** Include parcel outlines (GeoJSON); centroids only by default. */
            geometry: z.coerce.boolean().default(false),
            lang: z.enum(['en', 'es']).default('en'),
            parcelLimit: z.coerce.number().int().min(1).max(20_000).default(5_000),
          }),
          response: {
            200: z.object({
              asOf: z.iso.datetime(),
              cursor: z.number().int(),
              eventId: z.uuid().nullable(),
              me: z.object({ personnelId: z.uuid(), name: z.string(), teamIds: z.array(z.uuid()) }),
              areaKeys: z.array(z.string()),
              assignments: z.array(
                z.object({
                  id: z.uuid(),
                  version: z.number().int(),
                  state: z.string(),
                  teamId: z.uuid().nullable(),
                  personnelId: z.uuid().nullable(),
                  mission: z.object({
                    id: z.uuid(),
                    version: z.number().int(),
                    reference: z.string(),
                    kind: z.string(),
                    state: z.string(),
                    priority: z.string(),
                    urgency: z.string(),
                    summary: z.string().nullable(),
                    conditions: z.string().nullable(),
                    requiredCredentials: z.array(z.string()),
                    route: z.unknown().nullable(),
                    location: z
                      .object({
                        line1: z.string().nullable(),
                        city: z.string().nullable(),
                        postal: z.string().nullable(),
                        landmark: z.string().nullable(),
                        parcelId: z.string().nullable(),
                        usng: z.string().nullable(),
                        position: point.nullable(),
                      })
                      .nullable(),
                  }),
                }),
              ),
              parcels: z.array(
                z.object({
                  id: z.uuid(),
                  parcelId: z.string(),
                  line1: z.string().nullable(),
                  city: z.string().nullable(),
                  postal: z.string().nullable(),
                  structure: z.string(),
                  unitCount: z.number().int().nullable(),
                  areaKey: z.string().nullable(),
                  centroid: point.nullable(),
                  geometry: z.unknown().optional(),
                }),
              ),
              parcelsTruncated: z.boolean(),
              hazards: z.array(
                z.object({
                  id: z.uuid(),
                  version: z.number().int(),
                  kind: z.string(),
                  state: z.string(),
                  severity: z.string(),
                  summary: z.string().nullable(),
                  position: point.nullable(),
                  radiusM: z.number().nullable(),
                  unverified: z.boolean(),
                }),
              ),
              sites: z.array(
                z.object({
                  id: z.uuid(),
                  name: z.string(),
                  kind: z.string(),
                  status: z.string(),
                  position: point.nullable(),
                  services: z.array(z.string()),
                }),
              ),
              jobAids: z.array(
                z.object({
                  id: z.uuid(),
                  key: z.string(),
                  roleKey: z.string().nullable(),
                  lang: z.string(),
                  kind: z.string(),
                  title: z.string(),
                  bodyHtml: z.string(),
                  version: z.number().int(),
                }),
              ),
              /** SCL-13, plan §5: the map extract cut from the self-hosted tiles when one exists; pins work without it (SCL-06). */
              maps: z.array(
                z.object({
                  areaKey: z.string(),
                  available: z.boolean(),
                  url: z.string().nullable(),
                  expiresAt: z.iso.datetime().nullable(),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('field.area', { type: 'area_package', tenantId: s.tenantId });
        const me = await whoAmI(request);
        const q = request.query;
        const roleKeys = s.roles.map((r) => r.templateKey ?? r.key);
        const pkg = await run(request, me, async (trx) => {
          const head = await trx
            .selectFrom('cg.change_feed')
            .select(sql<string>`coalesce(max(seq), 0)`.as('seq'))
            .executeTakeFirstOrThrow();
          const assignments = await trx
            .selectFrom('cg.assignment as a')
            .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
            .leftJoin('cg.location as l', 'l.id', 'm.location_id')
            .select([
              'a.id',
              'a.version',
              'a.state',
              'a.team_id',
              'a.personnel_id',
              'm.id as mission_id',
              'm.version as mission_version',
              'm.reference',
              'm.kind',
              'm.state as mission_state',
              'm.priority',
              'm.urgency',
              'm.summary',
              'm.conditions',
              'm.required_credentials',
              'm.route',
              'm.event_id',
              'm.location_id',
              'l.line1',
              'l.city',
              'l.postal',
              'l.landmark',
              'l.parcel_id',
              'l.usng',
              sql<number | null>`ST_Y(l.geom)`.as('lat'),
              sql<number | null>`ST_X(l.geom)`.as('lon'),
            ])
            .where('a.released_at', 'is', null)
            .where('a.state', 'not in', ['declined', 'released', 'cleared'])
            .where('m.state', 'in', ['open', 'en_route', 'on_scene'])
            .where((eb) =>
              eb.or([
                eb('a.personnel_id', '=', me.personnelId),
                ...(me.teamIds.length ? [eb('a.team_id', 'in', me.teamIds)] : []),
              ]),
            )
            .$if(!!q.eventId, (qb) => qb.where('m.event_id', '=', q.eventId!))
            .orderBy('m.priority')
            .orderBy('a.assigned_at')
            .execute();
          const eventId =
            q.eventId ?? assignments[0]?.event_id ?? (await myEventIds(trx, me))[0] ?? null;
          // The areas: named, else those holding a parcel the assignments point at.
          let areaKeys: string[] = q.areaKey ? [q.areaKey] : [];
          if (!areaKeys.length) {
            const points = assignments.filter((a) => a.lat !== null && a.lon !== null);
            if (points.length) {
              const found = await trx
                .selectFrom('cg.parcel')
                .select('area_key')
                .distinct()
                .where('area_key', 'is not', null)
                .where(
                  sql<boolean>`ST_Intersects(geom, ST_Collect(ARRAY[${sql.join(
                    points.map(
                      (p) =>
                        sql`ST_SetSRID(ST_MakePoint(${Number(p.lon)}, ${Number(p.lat)}), 4326)`,
                    ),
                  )}]))`,
                )
                .execute();
              areaKeys = found.map((f) => f.area_key!).filter(Boolean);
            }
          }
          const parcelRows = areaKeys.length
            ? await trx
                .selectFrom('cg.parcel')
                .select([
                  'id',
                  'parcel_id',
                  'line1',
                  'city',
                  'postal',
                  'structure',
                  'unit_count',
                  'area_key',
                  sql<number | null>`ST_Y(centroid)`.as('lat'),
                  sql<number | null>`ST_X(centroid)`.as('lon'),
                  ...(q.geometry ? [sql<string>`ST_AsGeoJSON(geom)`.as('geojson')] : []),
                ])
                .where('area_key', 'in', areaKeys)
                .orderBy('parcel_id')
                .limit(q.parcelLimit + 1)
                .execute()
            : [];
          const parcelsTruncated = parcelRows.length > q.parcelLimit;
          const parcels = (parcelsTruncated ? parcelRows.slice(0, q.parcelLimit) : parcelRows).map(
            (p) => ({
              id: p.id,
              parcelId: p.parcel_id,
              line1: p.line1,
              city: p.city,
              postal: p.postal,
              structure: p.structure,
              unitCount: p.unit_count,
              areaKey: p.area_key,
              centroid:
                p.lat !== null && p.lon !== null
                  ? { lat: Number(p.lat), lon: Number(p.lon) }
                  : null,
              ...('geojson' in p && typeof p.geojson === 'string'
                ? { geometry: JSON.parse(p.geojson) as unknown }
                : {}),
            }),
          );
          const hazards = eventId
            ? await trx
                .selectFrom('cg.hazard')
                .select([
                  'id',
                  'version',
                  'kind',
                  'state',
                  'severity',
                  'summary',
                  'radius_m',
                  'ai_suggested',
                  'accepted_at',
                  sql<number | null>`ST_Y(geom)`.as('lat'),
                  sql<number | null>`ST_X(geom)`.as('lon'),
                ])
                .where('event_id', '=', eventId)
                .where('state', '<>', 'cleared')
                .execute()
            : [];
          const sites = await trx
            .selectFrom('cg.site as st')
            .leftJoin('cg.location as l', 'l.id', 'st.location_id')
            .select([
              'st.id',
              'st.name',
              'st.kind',
              'st.status',
              'st.services',
              sql<number | null>`ST_Y(l.geom)`.as('lat'),
              sql<number | null>`ST_X(l.geom)`.as('lon'),
            ])
            .where('st.status', 'in', ['open', 'limited', 'full'])
            .where('st.confidential', '=', false)
            .$if(!!eventId, (qb) =>
              qb.where((eb) =>
                eb.or([eb('st.event_id', '=', eventId!), eb('st.event_id', 'is', null)]),
              ),
            )
            .orderBy('st.name')
            .execute();
          const jobAids = await trx
            .selectFrom('cg.job_aid')
            .select(['id', 'key', 'role_key', 'lang', 'kind', 'title', 'body_html', 'version'])
            .where('status', 'in', ['approved', 'exercise_draft'])
            .where('lang', '=', q.lang)
            .where((eb) =>
              eb.or([
                eb('role_key', 'is', null),
                ...(roleKeys.length ? [eb('role_key', 'in', roleKeys)] : []),
              ]),
            )
            .orderBy('key')
            .execute();
          return {
            cursor: Number(head.seq),
            eventId,
            areaKeys,
            assignments: assignments.map((a) => ({
              id: a.id,
              version: a.version,
              state: a.state,
              teamId: a.team_id,
              personnelId: a.personnel_id,
              mission: {
                id: a.mission_id,
                version: a.mission_version,
                reference: a.reference,
                kind: a.kind,
                state: a.mission_state,
                priority: a.priority,
                urgency: a.urgency,
                summary: a.summary,
                conditions: a.conditions,
                requiredCredentials: a.required_credentials,
                route: a.route ?? null,
                location: a.location_id
                  ? {
                      line1: a.line1,
                      city: a.city,
                      postal: a.postal,
                      landmark: a.landmark,
                      parcelId: a.parcel_id,
                      usng: a.usng,
                      position:
                        a.lat !== null && a.lon !== null
                          ? { lat: Number(a.lat), lon: Number(a.lon) }
                          : null,
                    }
                  : null,
              },
            })),
            parcels,
            parcelsTruncated,
            hazards: hazards.map((h) => ({
              id: h.id,
              version: h.version,
              kind: h.kind,
              state: h.state,
              severity: h.severity,
              summary: h.summary,
              position:
                h.lat !== null && h.lon !== null
                  ? { lat: Number(h.lat), lon: Number(h.lon) }
                  : null,
              radiusM: h.radius_m,
              unverified: h.ai_suggested && !h.accepted_at,
            })),
            sites: sites.map((x) => ({
              id: x.id,
              name: x.name,
              kind: x.kind,
              status: x.status,
              position:
                x.lat !== null && x.lon !== null
                  ? { lat: Number(x.lat), lon: Number(x.lon) }
                  : null,
              services: x.services,
            })),
            jobAids: jobAids.map((j) => ({
              id: j.id,
              key: j.key,
              roleKey: j.role_key,
              lang: j.lang,
              kind: j.kind,
              title: j.title,
              bodyHtml: j.body_html,
              version: j.version,
            })),
          };
        });
        // Map extracts live at maps/areas/<tenant>/<area>.pmtiles; the worker cuts them when tiles exist (§7).
        const maps = await Promise.all(
          pkg.areaKeys.map(async (areaKey) => {
            if (!deps.objects) return { areaKey, available: false, url: null, expiresAt: null };
            const key = `maps/areas/${me.tenantId}/${areaKey}.pmtiles`;
            try {
              await deps.objects.client.send(
                new HeadObjectCommand({ Bucket: deps.objects.bucket, Key: key }),
              );
            } catch {
              return { areaKey, available: false, url: null, expiresAt: null };
            }
            const ttl = 3600;
            const url = await getSignedUrl(
              (deps.objects.presignClient ?? deps.objects.client) as unknown as Parameters<
                typeof getSignedUrl
              >[0],
              new GetObjectCommand({ Bucket: deps.objects.bucket, Key: key }),
              { expiresIn: ttl },
            );
            return {
              areaKey,
              available: true,
              url,
              expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
            };
          }),
        );
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'field.area',
            targetType: 'area_package',
            targetId: me.personnelId,
            changes: {
              fields: [
                { name: 'areas', to: pkg.areaKeys.join(',') },
                { name: 'assignments', to: String(pkg.assignments.length) },
                { name: 'parcels', to: String(pkg.parcels.length) },
              ],
            },
          }),
        );
        return {
          asOf: new Date().toISOString(),
          me: { personnelId: me.personnelId, name: me.name, teamIds: me.teamIds },
          ...pkg,
          maps,
        };
      },
    );
  };
