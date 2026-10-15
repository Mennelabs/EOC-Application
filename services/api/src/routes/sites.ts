/**
 * Sites (CON-09, PUB-01–06, PUB-11, PUB-15 data): shelters, feeding sites,
 * distribution points, recovery and cooling centers. Staff open, update,
 * confirm and close them; nothing goes public without a named approver and a
 * reason (site.publish is consequential), and the publication log records
 * what went out, where and when. Confidential sites can be edited and
 * confirmed but never published (PUB-05). Alert drafts (PUB-11) come from
 * deterministic templates; the county sends them through its own tool.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import type { DraftFact, DraftPurpose } from '@cg/ai';
import { draftAlerts, type AlertDraft, type AlertInput, type AlertSite } from '../public/alerts.ts';
import { addressText, hoursText } from '../public/help.ts';
import { publicSites } from '../public/sites-view.ts';
import { configValue } from '../public/submit.ts';
import { aiDraft, type DraftingDeps } from './drafting.ts';
import { classifierFor, iso, listQuery, pickDefined, stamped, uuidParam } from './helpers.ts';

type SiteRow = Selectable<Database['cg.site']>;
type Trx = Transaction<Database>;

const kinds = [
  'shelter',
  'feeding',
  'pod',
  'marc',
  'cooling',
  'warming',
  'reporting',
  'charging',
  'other',
] as const;
const statuses = ['planned', 'open', 'limited', 'full', 'closed'] as const;
const pets = ['yes', 'no', 'service_animals', 'unknown'] as const;

const addressIn = z.object({
  line1: z.string().max(200).nullable().optional(),
  unit: z.string().max(60).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(40).nullable().optional(),
  postal: z.string().max(12).nullable().optional(),
});
const positionIn = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
const jsonRecord = z.record(z.string(), z.union([z.string().max(200), z.boolean(), z.number()]));

const siteFields = {
  kind: z.enum(kinds),
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  eventId: z.uuid().nullable(),
  status: z.enum(statuses),
  address: addressIn.nullable(),
  position: positionIn.nullable(),
  capacity: z.number().int().min(0).nullable(),
  occupancy: z.number().int().min(0).nullable(),
  hours: jsonRecord,
  services: z.array(z.string().max(60)).max(40),
  pets: z.enum(pets),
  accessibility: jsonRecord,
  medicalPower: z.boolean().nullable(),
  languages: z.array(z.string().max(10)).max(20),
  transit: z.string().max(500).nullable(),
  directions: z.string().max(1000).nullable(),
  notes: z.string().max(2000).nullable(),
  confidential: z.boolean(),
  leadContactId: z.uuid().nullable(),
  confirmEveryHours: z.number().int().min(1).max(168),
  usng: z.string().max(40).nullable(),
  /** CON-16: the partner organization that runs the site; its staff may read it and confirm status and census. */
  operatorTenantId: z.uuid().nullable(),
};

const siteOut = z.object({
  ...stamped,
  kind: z.enum(kinds),
  name: z.string(),
  slug: z.string(),
  eventId: z.uuid().nullable(),
  status: z.enum(statuses),
  address: addressIn.nullable(),
  position: positionIn.nullable(),
  capacity: z.number().int().nullable(),
  occupancy: z.number().int().nullable(),
  hours: z.record(z.string(), z.unknown()),
  services: z.array(z.string()),
  pets: z.enum(pets),
  accessibility: z.record(z.string(), z.unknown()),
  medicalPower: z.boolean().nullable(),
  languages: z.array(z.string()),
  transit: z.string().nullable(),
  directions: z.string().nullable(),
  notes: z.string().nullable(),
  confidential: z.boolean(),
  leadContactId: z.uuid().nullable(),
  confirmEveryHours: z.number().int(),
  lastConfirmedAt: z.iso.datetime().nullable(),
  lastConfirmedBy: z.uuid().nullable(),
  /** PUB-03: past the reconfirmation window; hidden on every public channel until confirmed. */
  stale: z.boolean(),
  confirmDueAt: z.iso.datetime().nullable(),
  published: z.boolean(),
  publishedVersion: z.number().int().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  unpublishedAt: z.iso.datetime().nullable(),
  usng: z.string().nullable(),
  operatorTenantId: z.uuid().nullable(),
  /** Partner self-posting (2026-10-15): the partner organization that posted the site, if one did. */
  postedBy: z.object({ tenantId: z.uuid(), name: z.string().nullable() }).nullable(),
});
type SiteOut = z.infer<typeof siteOut>;

const publicationOut = z.object({
  id: z.uuid(),
  subjectKind: z.enum(['site', 'resource', 'alert_draft', 'poster', 'media_sheet']),
  subjectId: z.uuid(),
  subjectVersion: z.number().int(),
  snapshot: z.unknown(),
  approvedBy: z.uuid(),
  approvedAt: z.iso.datetime(),
  channels: z.array(z.string()),
  reason: z.string(),
  unpublishedAt: z.iso.datetime().nullable(),
  unpublishedBy: z.uuid().nullable(),
});

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'site';

export const siteRoutesWith =
  (deps: DraftingDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    type Joined = SiteRow & {
      line1: string | null;
      unit: string | null;
      city: string | null;
      state: string | null;
      postal: string | null;
      lat: number | string | null;
      lon: number | string | null;
      posted_by_name: string | null;
    };

    const query = (trx: Trx) =>
      trx
        .selectFrom('cg.site as s')
        .leftJoin('cg.location as l', 'l.id', 's.location_id')
        .leftJoin('cg.tenant as pt', 'pt.id', 's.posted_by_tenant_id')
        .selectAll('s')
        .select([
          'pt.name as posted_by_name',
          'l.line1',
          'l.unit',
          'l.city',
          'l.state',
          'l.postal',
          sql<number | null>`ST_Y(l.geom)`.as('lat'),
          sql<number | null>`ST_X(l.geom)`.as('lon'),
        ]);

    function toOut(r: Joined): SiteOut {
      const base = r.last_confirmed_at ?? r.published_at;
      const due = base
        ? new Date(new Date(base).getTime() + r.confirm_every_hours * 3_600_000)
        : null;
      return {
        id: r.id,
        version: r.version,
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        kind: r.kind,
        name: r.name,
        slug: r.slug,
        eventId: r.event_id,
        status: r.status,
        address:
          r.line1 || r.city || r.postal
            ? { line1: r.line1, unit: r.unit, city: r.city, state: r.state, postal: r.postal }
            : null,
        position:
          r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
        capacity: r.capacity,
        occupancy: r.occupancy,
        hours: (r.hours ?? {}) as Record<string, unknown>,
        services: r.services,
        pets: r.pets,
        accessibility: (r.accessibility ?? {}) as Record<string, unknown>,
        medicalPower: r.medical_power,
        languages: r.languages,
        transit: r.transit,
        directions: r.directions,
        notes: r.notes,
        confidential: r.confidential,
        leadContactId: r.lead_contact_id,
        confirmEveryHours: r.confirm_every_hours,
        lastConfirmedAt: iso(r.last_confirmed_at),
        lastConfirmedBy: r.last_confirmed_by,
        stale: Boolean(r.published_at && !r.unpublished_at && due && due.getTime() < Date.now()),
        confirmDueAt: iso(due),
        published: Boolean(r.published_at && !r.unpublished_at),
        publishedVersion: r.published_version,
        publishedAt: iso(r.published_at),
        unpublishedAt: iso(r.unpublished_at),
        usng: r.usng,
        operatorTenantId: r.operator_tenant_id,
        postedBy: r.posted_by_tenant_id
          ? { tenantId: r.posted_by_tenant_id, name: r.posted_by_name }
          : null,
      };
    }

    async function load(request: FastifyRequest, id: string): Promise<Joined> {
      const row = await request.tx((trx) => query(trx).where('s.id', '=', id).executeTakeFirst());
      if (!row) throw errors.notFound();
      return row as Joined;
    }

    const resourceOf = (r: Joined) => ({
      type: 'site',
      id: r.id,
      tenantId: r.tenant_id,
      ...(r.event_id ? { eventId: r.event_id } : {}),
    });
    /**
     * CON-16: the partner that runs a site reads it and confirms its status and census as its own;
     * editing, publishing and closing stay with the owner (resourceOf).
     */
    const operatedResourceOf = (request: FastifyRequest, r: Joined) => {
      const s = request.subject;
      return s.kind === 'account' && r.operator_tenant_id && r.operator_tenant_id === s.tenantId
        ? { type: 'site', id: r.id, tenantId: s.tenantId }
        : resourceOf(r);
    };

    /** CON-16: the operator is a partner organization this tenant can see (its own partner). */
    async function checkOperator(trx: Trx, id: string): Promise<void> {
      const t = await trx
        .selectFrom('cg.tenant')
        .select('id')
        .where('id', '=', id)
        .where('kind', '=', 'partner_org')
        .executeTakeFirst();
      if (!t)
        throw errors.validation([
          { name: 'operatorTenantId', message: 'choose one of your partner organizations' },
        ]);
    }

    /** Writes or updates the site's location row from an address and an optional point. */
    async function saveLocation(
      trx: Trx,
      tenantId: string,
      existing: string | null,
      address: z.infer<typeof addressIn> | null | undefined,
      position: z.infer<typeof positionIn> | null | undefined,
      accountId: string,
    ): Promise<string | null> {
      if (address === undefined && position === undefined) return existing;
      const values = {
        ...(address !== undefined
          ? {
              line1: address?.line1 ?? null,
              unit: address?.unit ?? null,
              city: address?.city ?? null,
              state: address?.state ?? null,
              postal: address?.postal ?? null,
              no_fixed_address: !address?.line1,
            }
          : {}),
        ...(position !== undefined
          ? {
              geom: position
                ? sql`ST_SetSRID(ST_MakePoint(${position.lon}, ${position.lat}), 4326)`
                : null,
              precision: position ? ('exact' as const) : ('unknown' as const),
            }
          : {}),
      };
      if (existing) {
        await trx
          .updateTable('cg.location')
          .set({ ...values, updated_by: accountId })
          .where('id', '=', existing)
          .execute();
        return existing;
      }
      const row = await trx
        .insertInto('cg.location')
        .values({
          tenant_id: tenantId,
          source: 'reviewer',
          created_by: accountId,
          updated_by: accountId,
          ...values,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    }

    const columnMap = {
      kind: 'kind',
      name: 'name',
      slug: 'slug',
      eventId: 'event_id',
      status: 'status',
      capacity: 'capacity',
      occupancy: 'occupancy',
      pets: 'pets',
      medicalPower: 'medical_power',
      transit: 'transit',
      directions: 'directions',
      notes: 'notes',
      confidential: 'confidential',
      leadContactId: 'lead_contact_id',
      confirmEveryHours: 'confirm_every_hours',
      usng: 'usng',
      operatorTenantId: 'operator_tenant_id',
    } as const;

    type SiteBody = {
      [K in keyof typeof siteFields]?: z.infer<(typeof siteFields)[K]> | undefined;
    };
    function columns(body: SiteBody) {
      const out = pickDefined(body as Record<string, unknown>, columnMap);
      if (body.hours !== undefined) out['hours'] = JSON.stringify(body.hours);
      if (body.accessibility !== undefined)
        out['accessibility'] = JSON.stringify(body.accessibility);
      if (body.services !== undefined) out['services'] = body.services;
      if (body.languages !== undefined) out['languages'] = body.languages;
      return out;
    }

    /** What the public channels get (PUB-02); the snapshot the publication log keeps. */
    async function publicSnapshot(trx: Trx, tenantId: string, siteId: string) {
      const all = await trx
        .selectFrom('cg.site')
        .select(['id'])
        .where('id', '=', siteId)
        .executeTakeFirst();
      if (!all) return null;
      const sites = await publicSites(trx, tenantId, {});
      return sites.find((s) => s.id === siteId) ?? null;
    }

    // ------------------------------------------------------------------ list
    app.get(
      '/sites',
      {
        schema: {
          tags: ['sites'],
          querystring: listQuery.extend({
            eventId: z.uuid().optional(),
            status: z.enum(statuses).optional(),
            kind: z.enum(kinds).optional(),
            published: z.coerce.boolean().optional(),
            stale: z.coerce.boolean().optional(),
          }),
          response: { 200: z.array(siteOut) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('site.read', { type: 'site', tenantId: s.tenantId });
        const q = request.query;
        const rows = await request.tx((trx) => {
          let x = query(trx).orderBy('s.name').limit(q.limit).offset(q.offset);
          if (q.eventId) x = x.where('s.event_id', '=', q.eventId);
          if (q.status) x = x.where('s.status', '=', q.status);
          if (q.kind) x = x.where('s.kind', '=', q.kind);
          if (q.published === true)
            x = x.where('s.published_at', 'is not', null).where('s.unpublished_at', 'is', null);
          if (q.published === false)
            x = x.where((eb) =>
              eb.or([eb('s.published_at', 'is', null), eb('s.unpublished_at', 'is not', null)]),
            );
          // PUB-03: staleness is decided in the query (the same rule as toOut), so a stale site
          // beyond the first page is never missing from the list staff reconfirm from.
          const staleRule = sql<boolean>`(s.published_at is not null and s.unpublished_at is null
          and coalesce(s.last_confirmed_at, s.published_at)
            + make_interval(hours => s.confirm_every_hours) < now())`;
          if (q.stale === true) x = x.where(staleRule);
          if (q.stale === false) x = x.where(sql<boolean>`not ${staleRule}`);
          return x.execute();
        });
        return (rows as Joined[]).map(toOut);
      },
    );

    app.get(
      '/sites/:id',
      { schema: { tags: ['sites'], params: uuidParam, response: { 200: siteOut } } },
      async (request) => {
        const row = await load(request, request.params.id);
        await request.authorize('site.read', operatedResourceOf(request, row), {
          asNotFound: true,
        });
        return toOut(row);
      },
    );

    // ---------------------------------------------------------------- create
    app.post(
      '/sites',
      {
        schema: {
          tags: ['sites'],
          body: z.object({
            ...siteFields,
            slug: siteFields.slug.optional(),
            eventId: siteFields.eventId.optional(),
            status: siteFields.status.default('planned'),
            address: siteFields.address.optional(),
            position: siteFields.position.optional(),
            capacity: siteFields.capacity.optional(),
            occupancy: siteFields.occupancy.optional(),
            hours: siteFields.hours.default({}),
            services: siteFields.services.default([]),
            pets: siteFields.pets.default('unknown'),
            accessibility: siteFields.accessibility.default({}),
            medicalPower: siteFields.medicalPower.optional(),
            languages: siteFields.languages.default(['en']),
            transit: siteFields.transit.optional(),
            directions: siteFields.directions.optional(),
            notes: siteFields.notes.optional(),
            confidential: siteFields.confidential.default(false),
            leadContactId: siteFields.leadContactId.optional(),
            confirmEveryHours: siteFields.confirmEveryHours.default(12),
            usng: siteFields.usng.optional(),
            operatorTenantId: siteFields.operatorTenantId.optional(),
          }),
          response: { 201: siteOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        await request.authorize('site.edit', {
          type: 'site',
          tenantId: s.tenantId,
          ...(request.body.eventId ? { eventId: request.body.eventId } : {}),
        });
        const b = request.body;
        const row = await request.tx(async (trx) => {
          if (b.operatorTenantId) await checkOperator(trx, b.operatorTenantId);
          const locationId = await saveLocation(
            trx,
            s.tenantId,
            null,
            b.address ?? null,
            b.position ?? null,
            s.accountId,
          );
          const slug = b.slug ?? slugify(b.name);
          const taken = await trx
            .selectFrom('cg.site')
            .select('id')
            .where('slug', '=', slug)
            .executeTakeFirst();
          if (taken)
            throw errors.validation([{ name: 'slug', message: 'already used by another site' }]);
          const inserted = await trx
            .insertInto('cg.site')
            .values({
              tenant_id: s.tenantId,
              ...columns({ ...b, slug }),
              kind: b.kind,
              name: b.name,
              slug,
              location_id: locationId,
              created_by: s.accountId,
              updated_by: s.accountId,
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow();
          const full = (await query(trx)
            .where('s.id', '=', inserted.id)
            .executeTakeFirstOrThrow()) as Joined;
          await request.audit(trx, {
            action: 'site.create',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            changes: diffForAudit(
              null,
              full as unknown as Record<string, unknown>,
              classifierFor('site'),
            ),
          });
          return full;
        });
        return reply.code(201).send(toOut(row));
      },
    );

    // ---------------------------------------------------------------- update
    app.patch(
      '/sites/:id',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['sites'],
          params: uuidParam,
          body: z.object(
            Object.fromEntries(Object.entries(siteFields).map(([k, v]) => [k, v.optional()])) as {
              [K in keyof typeof siteFields]: z.ZodOptional<(typeof siteFields)[K]>;
            },
          ),
          response: { 200: siteOut },
        },
      },
      async (request) => {
        const s = account(request);
        const expected = request.expectedVersion();
        const current = await load(request, request.params.id);
        await request.authorize('site.edit', resourceOf(current), { asNotFound: true });
        const b = request.body;
        const row = await request.tx(async (trx) => {
          if (b.operatorTenantId) await checkOperator(trx, b.operatorTenantId);
          const locationId = await saveLocation(
            trx,
            s.tenantId,
            current.location_id,
            b.address,
            b.position,
            s.accountId,
          );
          const updated = assertUpdated(
            await trx
              .updateTable('cg.site')
              .set({ ...columns(b), location_id: locationId, updated_by: s.accountId } as never)
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returning('id')
              .executeTakeFirst(),
            toOut(current),
          );
          const full = (await query(trx)
            .where('s.id', '=', updated.id)
            .executeTakeFirstOrThrow()) as Joined;
          await request.audit(trx, {
            action: 'site.update',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            changes: diffForAudit(
              current as unknown as Record<string, unknown>,
              full as unknown as Record<string, unknown>,
              classifierFor('site'),
            ),
          });
          return full;
        });
        return toOut(row);
      },
    );

    // --------------------------------------------------------------- confirm
    app.post(
      '/sites/:id/confirm',
      {
        schema: {
          tags: ['sites'],
          params: uuidParam,
          body: z.object({
            status: z.enum(statuses).optional(),
            occupancy: z.number().int().min(0).nullable().optional(),
            note: z.string().max(500).optional(),
          }),
          response: { 200: siteOut },
        },
      },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.params.id);
        await request.authorize('site.confirm', operatedResourceOf(request, current), {
          asNotFound: true,
        });
        const row = await request.tx(async (trx) => {
          await trx
            .updateTable('cg.site')
            .set({
              last_confirmed_at: new Date(),
              last_confirmed_by: s.accountId,
              ...(request.body.status ? { status: request.body.status } : {}),
              ...(request.body.occupancy !== undefined
                ? { occupancy: request.body.occupancy }
                : {}),
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .execute();
          const full = (await query(trx)
            .where('s.id', '=', current.id)
            .executeTakeFirstOrThrow()) as Joined;
          await request.audit(trx, {
            action: 'site.confirm',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            reason: request.body.note ?? null,
            changes: diffForAudit(
              current as unknown as Record<string, unknown>,
              full as unknown as Record<string, unknown>,
              classifierFor('site'),
            ),
          });
          return full;
        });
        return toOut(row);
      },
    );

    // --------------------------------------------------------------- publish
    app.post(
      '/sites/:id/publish',
      { schema: { tags: ['sites'], params: uuidParam, response: { 200: siteOut } } },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.params.id);
        await request.authorize('site.publish', resourceOf(current), { asNotFound: true });
        if (current.confidential)
          throw errors.validation([
            { name: 'confidential', message: 'a confidential site is never published (PUB-05)' },
          ]);
        const { reason } = request.confirmation();
        const row = await request.tx(async (trx) => {
          await trx
            .updateTable('cg.site')
            .set({
              published_version: current.version + 1,
              published_at: new Date(),
              unpublished_at: null,
              last_confirmed_at: current.last_confirmed_at ?? new Date(),
              last_confirmed_by: current.last_confirmed_by ?? s.accountId,
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .execute();
          const full = (await query(trx)
            .where('s.id', '=', current.id)
            .executeTakeFirstOrThrow()) as Joined;
          const snapshot = await publicSnapshot(trx, s.tenantId, full.id);
          await trx
            .insertInto('cg.publication')
            .values({
              tenant_id: s.tenantId,
              subject_kind: 'site',
              subject_id: full.id,
              subject_version: full.version,
              snapshot: JSON.stringify(snapshot ?? toOut(full)),
              approved_by: s.accountId,
              reason: reason ?? 'published',
            })
            .execute();
          await request.audit(trx, {
            action: 'site.publish',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            reason,
            changes: {
              fields: [
                {
                  name: 'published',
                  from: Boolean(current.published_at && !current.unpublished_at),
                  to: true,
                },
              ],
            },
          });
          return full;
        });
        return toOut(row);
      },
    );

    app.post(
      '/sites/:id/unpublish',
      { schema: { tags: ['sites'], params: uuidParam, response: { 200: siteOut } } },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.params.id);
        await request.authorize('site.publish', resourceOf(current), { asNotFound: true });
        const { reason } = request.confirmation();
        const row = await request.tx(async (trx) => {
          await trx
            .updateTable('cg.site')
            .set({ unpublished_at: new Date(), updated_by: s.accountId })
            .where('id', '=', current.id)
            .execute();
          await trx
            .updateTable('cg.publication')
            .set({ unpublished_at: new Date(), unpublished_by: s.accountId })
            .where('subject_kind', '=', 'site')
            .where('subject_id', '=', current.id)
            .where('unpublished_at', 'is', null)
            .execute();
          const full = (await query(trx)
            .where('s.id', '=', current.id)
            .executeTakeFirstOrThrow()) as Joined;
          await request.audit(trx, {
            action: 'site.publish',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            reason,
            changes: { fields: [{ name: 'published', from: true, to: false }] },
          });
          return full;
        });
        return toOut(row);
      },
    );

    // ----------------------------------------------------------------- close
    app.post(
      '/sites/:id/close',
      {
        schema: {
          tags: ['sites'],
          params: uuidParam,
          body: z.object({ note: z.string().min(3).max(500) }),
          response: { 200: siteOut },
        },
      },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.params.id);
        await request.authorize('site.edit', resourceOf(current), { asNotFound: true });
        const row = await request.tx(async (trx) => {
          await trx
            .updateTable('cg.site')
            .set({ status: 'closed', notes: request.body.note, updated_by: s.accountId })
            .where('id', '=', current.id)
            .execute();
          const full = (await query(trx)
            .where('s.id', '=', current.id)
            .executeTakeFirstOrThrow()) as Joined;
          await request.audit(trx, {
            action: 'site.update',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            reason: request.body.note,
            changes: { fields: [{ name: 'status', from: current.status, to: 'closed' }] },
          });
          return full;
        });
        return toOut(row);
      },
    );

    // ------------------------------------------------- partner self-posting
    // Decided 2026-10-15 (PUB-01, PUB-06, CON-16, REC-13): a partner organization posts its own
    // service (a shelter, a feeding site, a POD) in its county, as the site's operator, and its
    // named approver publishes it on every public channel at once. The site belongs to the county,
    // so the county sees it, is told of the publication (the publication notices) and can edit,
    // close or withdraw it. The writes run in the county's context after `site.post` (drafting) or
    // `site.post_publish` (the named approver) is authorized for the partner, as the partner's
    // mission and need work does; these routes keep the partner to the sites it posted.

    /** The partner's county: the parent of a partner organization's tenant. */
    async function partnerScope(request: FastifyRequest) {
      const s = account(request);
      if (s.tenantKind !== 'partner_org') throw errors.forbidden();
      const me = await request.tx((trx) =>
        trx
          .selectFrom('cg.tenant')
          .select('parent_id')
          .where('id', '=', s.tenantId)
          .executeTakeFirst(),
      );
      if (!me?.parent_id) throw errors.forbidden();
      return { s, countyId: me.parent_id, partnerId: s.tenantId };
    }

    /** A partner may file its service under one of its county's events only. */
    async function checkCountyEvent(trx: Trx, countyId: string, eventId: string) {
      const event = await trx
        .selectFrom('cg.event')
        .select('id')
        .where('id', '=', eventId)
        .where('tenant_id', '=', countyId)
        .executeTakeFirst();
      if (!event)
        throw errors.validation([{ name: 'eventId', message: "not one of your county's events" }]);
    }

    async function loadPosted(
      request: FastifyRequest,
      countyId: string,
      partnerId: string,
      id: string,
    ) {
      const row = await request.txAs(countyId, (trx) =>
        query(trx)
          .where('s.id', '=', id)
          .where('s.posted_by_tenant_id', '=', partnerId)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      return row as Joined;
    }

    /**
     * What a partner's post needs before it goes public, beyond the fields every post has: a place
     * people can find (an address or a point on the map), and no wording that reads like an
     * emergency alert, since the name and notes reach the SHELTER text replies and carriers
     * reject alert wording (docs/06).
     */
    function publishProblems(row: Joined) {
      const problems: { name: string; message: string }[] = [];
      if (!row.line1 && !row.city && (row.lat === null || row.lon === null))
        problems.push({
          name: 'address',
          message: 'an address or a map point is needed to publish',
        });
      const alertWording = /emergency alert|alerta de emergencia/i;
      for (const [name, text] of [
        ['name', row.name],
        ['notes', row.notes],
        ['directions', row.directions],
      ] as const)
        if (typeof text === 'string' && alertWording.test(text))
          problems.push({ name, message: 'reads like an emergency alert; reword it (docs/06)' });
      return problems;
    }

    const partnerFields = {
      kind: siteFields.kind,
      name: siteFields.name,
      eventId: siteFields.eventId.optional(),
      status: siteFields.status.default('open'),
      address: siteFields.address.optional(),
      position: siteFields.position.optional(),
      capacity: siteFields.capacity.optional(),
      occupancy: siteFields.occupancy.optional(),
      hours: siteFields.hours.default({}),
      services: siteFields.services.default([]),
      pets: siteFields.pets.default('unknown'),
      accessibility: siteFields.accessibility.default({}),
      medicalPower: siteFields.medicalPower.optional(),
      languages: siteFields.languages.default(['en']),
      transit: siteFields.transit.optional(),
      directions: siteFields.directions.optional(),
      notes: siteFields.notes.optional(),
      confidential: siteFields.confidential.default(false),
      confirmEveryHours: siteFields.confirmEveryHours.default(12),
    };

    /** What a partner may change on a service it posted (the county keeps lead contact and operator). */
    const partnerPatchKeys = [
      'kind',
      'name',
      'eventId',
      'status',
      'address',
      'position',
      'capacity',
      'occupancy',
      'hours',
      'services',
      'pets',
      'accessibility',
      'medicalPower',
      'languages',
      'transit',
      'directions',
      'notes',
      'confidential',
      'confirmEveryHours',
    ] as const;

    app.get(
      '/partner/sites',
      { schema: { tags: ['sites'], response: { 200: z.array(siteOut) } } },
      async (request) => {
        const { countyId, partnerId } = await partnerScope(request);
        await request.authorize('site.read', { type: 'site', tenantId: partnerId });
        const rows = await request.txAs(countyId, (trx) =>
          query(trx).where('s.operator_tenant_id', '=', partnerId).orderBy('s.name').execute(),
        );
        return (rows as Joined[]).map(toOut);
      },
    );

    app.post(
      '/partner/sites',
      { schema: { tags: ['sites'], body: z.object(partnerFields), response: { 201: siteOut } } },
      async (request, reply) => {
        const { s, countyId, partnerId } = await partnerScope(request);
        await request.authorize('site.post', { type: 'site', tenantId: partnerId });
        const b = request.body;
        const row = await request.txAs(countyId, async (trx) => {
          if (b.eventId) await checkCountyEvent(trx, countyId, b.eventId);
          const locationId = await saveLocation(
            trx,
            countyId,
            null,
            b.address ?? null,
            b.position ?? null,
            s.accountId,
          );
          // A unique slug: the partner names the service, the county's page needs one address.
          const base = slugify(b.name);
          let slug = base;
          for (let n = 2; ; n++) {
            const taken = await trx
              .selectFrom('cg.site')
              .select('id')
              .where('slug', '=', slug)
              .executeTakeFirst();
            if (!taken) break;
            slug = `${base.slice(0, 56)}-${n}`;
          }
          const inserted = await trx
            .insertInto('cg.site')
            .values({
              tenant_id: countyId,
              ...columns(b),
              kind: b.kind,
              name: b.name,
              slug,
              location_id: locationId,
              operator_tenant_id: partnerId,
              posted_by_tenant_id: partnerId,
              created_by: s.accountId,
              updated_by: s.accountId,
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow();
          const full = (await query(trx)
            .where('s.id', '=', inserted.id)
            .executeTakeFirstOrThrow()) as Joined;
          await request.audit(trx, {
            tenantId: countyId,
            action: 'site.create',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            reason: 'posted by a partner organization',
            changes: diffForAudit(
              null,
              full as unknown as Record<string, unknown>,
              classifierFor('site'),
            ),
          });
          return full;
        });
        return reply.code(201).send(toOut(row));
      },
    );

    app.patch(
      '/partner/sites/:id',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['sites'],
          params: uuidParam,
          body: z.object(
            Object.fromEntries(partnerPatchKeys.map((k) => [k, siteFields[k].optional()])) as {
              [K in (typeof partnerPatchKeys)[number]]: z.ZodOptional<(typeof siteFields)[K]>;
            },
          ),
          response: { 200: siteOut },
        },
      },
      async (request) => {
        const { s, countyId, partnerId } = await partnerScope(request);
        const expected = request.expectedVersion();
        await request.authorize('site.post', { type: 'site', tenantId: partnerId });
        const current = await loadPosted(request, countyId, partnerId, request.params.id);
        const b = request.body;
        const row = await request.txAs(countyId, async (trx) => {
          if (b.eventId) await checkCountyEvent(trx, countyId, b.eventId);
          const locationId = await saveLocation(
            trx,
            countyId,
            current.location_id,
            b.address,
            b.position,
            s.accountId,
          );
          const updated = assertUpdated(
            await trx
              .updateTable('cg.site')
              .set({ ...columns(b), location_id: locationId, updated_by: s.accountId } as never)
              .where('id', '=', current.id)
              .where('posted_by_tenant_id', '=', partnerId)
              .where('version', '=', expected)
              .returning('id')
              .executeTakeFirst(),
            toOut(current),
          );
          const full = (await query(trx)
            .where('s.id', '=', updated.id)
            .executeTakeFirstOrThrow()) as Joined;
          // A live post shows its changes at once, so it keeps meeting the publish checks.
          if (full.published_at && !full.unpublished_at) {
            const problems = publishProblems(full);
            if (problems.length) throw errors.validation(problems);
          }
          await request.audit(trx, {
            tenantId: countyId,
            action: 'site.update',
            targetType: 'site',
            targetId: full.id,
            targetVersion: full.version,
            changes: diffForAudit(
              current as unknown as Record<string, unknown>,
              full as unknown as Record<string, unknown>,
              classifierFor('site'),
            ),
          });
          return full;
        });
        return toOut(row);
      },
    );

    for (const op of ['publish', 'unpublish'] as const) {
      app.post(
        `/partner/sites/:id/${op}`,
        { schema: { tags: ['sites'], params: uuidParam, response: { 200: siteOut } } },
        async (request) => {
          const { s, countyId, partnerId } = await partnerScope(request);
          await request.authorize('site.post_publish', { type: 'site', tenantId: partnerId });
          const current = await loadPosted(request, countyId, partnerId, request.params.id);
          if (op === 'publish') {
            if (current.confidential)
              throw errors.validation([
                {
                  name: 'confidential',
                  message: 'a confidential site is never published (PUB-05)',
                },
              ]);
            const problems = publishProblems(current);
            if (problems.length) throw errors.validation(problems);
          }
          // PUB-06: the partner's approver is the named person; the reason is kept with it.
          const { reason } = request.confirmation();
          const poster = await request.tx(async (trx) => {
            const org = await trx
              .selectFrom('cg.tenant')
              .select('name')
              .where('id', '=', partnerId)
              .executeTakeFirstOrThrow();
            const me = await trx
              .selectFrom('cg.account')
              .select('display_name')
              .where('id', '=', s.accountId)
              .executeTakeFirst();
            return {
              tenantId: partnerId,
              organization: org.name,
              approver: me?.display_name ?? null,
            };
          });
          const now = new Date();
          const row = await request.txAs(countyId, async (trx) => {
            await trx
              .updateTable('cg.site')
              .set(
                op === 'publish'
                  ? {
                      published_version: current.version + 1,
                      published_at: now,
                      unpublished_at: null,
                      last_confirmed_at: now,
                      last_confirmed_by: s.accountId,
                      updated_by: s.accountId,
                    }
                  : { unpublished_at: now, updated_by: s.accountId },
              )
              .where('id', '=', current.id)
              .where('posted_by_tenant_id', '=', partnerId)
              .execute();
            const full = (await query(trx)
              .where('s.id', '=', current.id)
              .executeTakeFirstOrThrow()) as Joined;
            if (op === 'publish') {
              const snapshot = await publicSnapshot(trx, countyId, full.id);
              await trx
                .insertInto('cg.publication')
                .values({
                  tenant_id: countyId,
                  subject_kind: 'site',
                  subject_id: full.id,
                  subject_version: full.version,
                  // The county's notices and log name the organization and its approver, whose
                  // account the county's context cannot read.
                  snapshot: JSON.stringify({ ...(snapshot ?? toOut(full)), postedBy: poster }),
                  approved_by: s.accountId,
                  reason: reason ?? 'published by a partner organization',
                })
                .execute();
            } else {
              await trx
                .updateTable('cg.publication')
                .set({ unpublished_at: now, unpublished_by: s.accountId })
                .where('subject_kind', '=', 'site')
                .where('subject_id', '=', current.id)
                .where('unpublished_at', 'is', null)
                .execute();
            }
            await request.audit(trx, {
              tenantId: countyId,
              action: 'site.publish',
              targetType: 'site',
              targetId: full.id,
              targetVersion: full.version,
              reason,
              changes: {
                fields: [
                  {
                    name: 'published',
                    from: Boolean(current.published_at && !current.unpublished_at),
                    to: op === 'publish',
                  },
                  { name: 'posted_by', to: partnerId },
                ],
              },
            });
            return full;
          });
          return toOut(row);
        },
      );
    }

    // ----------------------------------------------------------- publications
    app.get(
      '/publications',
      {
        schema: {
          tags: ['sites'],
          querystring: listQuery.extend({
            subjectKind: z
              .enum(['site', 'resource', 'alert_draft', 'poster', 'media_sheet'])
              .optional(),
            subjectId: z.uuid().optional(),
          }),
          response: { 200: z.array(publicationOut) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('publication.read', { type: 'publication', tenantId: s.tenantId });
        const q = request.query;
        const rows = await request.tx((trx) => {
          let x = trx
            .selectFrom('cg.publication')
            .selectAll()
            .orderBy('approved_at', 'desc')
            .limit(q.limit)
            .offset(q.offset);
          if (q.subjectKind) x = x.where('subject_kind', '=', q.subjectKind);
          if (q.subjectId) x = x.where('subject_id', '=', q.subjectId);
          return x.execute();
        });
        return rows.map((r) => ({
          id: r.id,
          subjectKind: r.subject_kind,
          subjectId: r.subject_id,
          subjectVersion: r.subject_version,
          snapshot: r.snapshot,
          approvedBy: r.approved_by,
          approvedAt: iso(r.approved_at)!,
          channels: r.channels,
          reason: r.reason,
          unpublishedAt: iso(r.unpublished_at),
          unpublishedBy: r.unpublished_by,
        }));
      },
    );

    /** The facts an alert about a site change states (PUB-04, PUB-11): the site, the next nearest open one, the help line. */
    async function alertInputFor(
      trx: Transaction<Database>,
      tenantId: string,
      current: Joined,
      change: AlertInput['change'],
    ): Promise<AlertInput> {
      const tenant = await trx
        .selectFrom('cg.tenant')
        .select(['name', 'slug'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow();
      const helpPhone = (await configValue<string>(trx, 'intake.help_phone')) ?? null;
      const sites = await publicSites(trx, tenantId, {});
      const mine = sites.find((x) => x.id === current.id);
      const asAlertSite = (x: typeof current | NonNullable<typeof mine>): AlertSite => {
        const site = 'position' in x ? x : null;
        const petsText = {
          yes: 'Pets welcome',
          no: 'No pets',
          service_animals: 'Service animals only',
          unknown: '',
        } as const;
        return {
          name: x.name,
          kind: x.kind,
          address: site ? addressText(site) || null : null,
          hours: site ? hoursText(site.hours, 'en') || null : null,
          pets: petsText[x.pets] || null,
          accessibility:
            site && site.accessibility['wheelchair'] === true ? 'Wheelchair accessible' : null,
        };
      };
      return {
        county: tenant.name,
        change,
        site: asAlertSite(mine ?? current),
        next: mine?.nextNearest
          ? asAlertSite(sites.find((x) => x.id === mine.nextNearest!.id)!)
          : null,
        helpUrl: null,
        helpPhone,
      };
    }

    // ----------------------------------------------------------- alert drafts
    app.post(
      '/alerts/draft',
      {
        schema: {
          tags: ['sites'],
          body: z.object({
            siteId: z.uuid(),
            change: z.enum(['opened', 'reopened', 'limited', 'full', 'closed']),
          }),
          response: {
            200: z.object({
              siteId: z.uuid(),
              change: z.string(),
              drafts: z.array(
                z.object({
                  lang: z.enum(['en', 'es']),
                  wea90: z.string().max(90),
                  wea360: z.string().max(360),
                  massNotification: z.string(),
                  social: z.string().max(280),
                  radioLoop: z.string(),
                  netReadout: z.string(),
                }),
              ),
              publicationId: z.uuid(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.body.siteId);
        await request.authorize('publication.draft', { type: 'publication', tenantId: s.tenantId });
        if (current.confidential)
          throw errors.validation([
            {
              name: 'siteId',
              message: 'a confidential site is never named in public text (PUB-05)',
            },
          ]);
        const result = await request.tx(async (trx) => {
          const drafts = draftAlerts(
            await alertInputFor(trx, s.tenantId, current, request.body.change),
          );
          const row = await trx
            .insertInto('cg.publication')
            .values({
              tenant_id: s.tenantId,
              subject_kind: 'alert_draft',
              subject_id: current.id,
              subject_version: current.version,
              snapshot: JSON.stringify({ change: request.body.change, drafts }),
              approved_by: s.accountId,
              channels: ['wea', 'mass_notification', 'social', 'radio', 'amateur_net'],
              reason: `draft: ${request.body.change}`,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'publication.draft',
            targetType: 'publication',
            targetId: row.id,
            changes: {
              fields: [
                { name: 'site', to: current.id },
                { name: 'change', to: request.body.change },
              ],
            },
          });
          return { siteId: current.id, change: request.body.change, drafts, publicationId: row.id };
        });
        return result;
      },
    );

    // ----------------------------------------------------------- AI drafts of public text (layer-7 task G)
    /**
     * PUB-11, PUB-12, PUB-14, AI-04: the AI assistant rewrites one of the
     * rules' public texts (WEA, mass notification, social post, radio loop,
     * amateur-net read-out) from the same facts, each sentence citing them,
     * every figure checked, within the channel's length. It comes back to the
     * screen only: the county sends alerts through its own authorized tool,
     * and nothing is published without its named approver (PUB-06).
     */
    const FORMS = {
      wea90: { max: 90, purpose: 'wea_alert' },
      wea360: { max: 360, purpose: 'wea_alert' },
      massNotification: { max: 1000, purpose: 'wea_alert' },
      social: { max: 280, purpose: 'pio_post' },
      radioLoop: { max: 1500, purpose: 'radio_script' },
      netReadout: { max: 1500, purpose: 'radio_script' },
    } as const satisfies Record<
      keyof Omit<AlertDraft, 'lang'>,
      { max: number; purpose: DraftPurpose }
    >;
    app.post(
      '/alerts/ai-draft',
      {
        schema: {
          tags: ['sites'],
          body: z.object({
            siteId: z.uuid(),
            change: z.enum(['opened', 'reopened', 'limited', 'full', 'closed']),
            form: z.enum([
              'wea90',
              'wea360',
              'massNotification',
              'social',
              'radioLoop',
              'netReadout',
            ]),
            language: z.enum(['en', 'es']).default('en'),
          }),
          response: {
            200: z.object({
              form: z.string(),
              language: z.string(),
              text: z.string(),
              rules: z.string(),
              sentences: z.array(z.object({ text: z.string(), factIds: z.array(z.string()) })),
              facts: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  value: z.union([z.string(), z.number(), z.null()]),
                }),
              ),
              provider: z.string(),
              model: z.string(),
              outputId: z.uuid(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        const b = request.body;
        const current = await load(request, b.siteId);
        await request.authorize('publication.draft', { type: 'publication', tenantId: s.tenantId });
        if (current.confidential)
          throw errors.validation([
            {
              name: 'siteId',
              message: 'a confidential site is never named in public text (PUB-05)',
            },
          ]);
        const input = await request.tx((trx) => alertInputFor(trx, s.tenantId, current, b.change));
        const rules = draftAlerts(input).find((d) => d.lang === b.language)!;
        const facts: DraftFact[] = [
          { id: 'county', label: 'County', value: input.county },
          { id: 'change', label: 'What changed', value: b.change },
          { id: 'site.name', label: 'Site name', value: input.site.name },
          { id: 'site.kind', label: 'Kind of site', value: input.site.kind },
          { id: 'site.address', label: 'Address', value: input.site.address },
          { id: 'site.hours', label: 'Hours', value: input.site.hours ?? null },
          { id: 'site.pets', label: 'Pets', value: input.site.pets ?? null },
          {
            id: 'site.accessibility',
            label: 'Accessibility',
            value: input.site.accessibility ?? null,
          },
          ...(input.next
            ? [
                { id: 'next.name', label: 'Nearest other open site', value: input.next.name },
                { id: 'next.address', label: 'Its address', value: input.next.address },
              ]
            : []),
          { id: 'helpPhone', label: 'County help line', value: input.helpPhone ?? null },
          { id: 'safety', label: 'Safety line', value: 'If anyone is in danger, call 911' },
        ];
        const form = FORMS[b.form];
        const draft = await aiDraft(
          request,
          deps,
          'public.drafting',
          {
            purpose: form.purpose,
            language: b.language,
            facts,
            template: rules[b.form],
            maxChars: form.max,
          },
          { type: 'site', id: current.id },
        );
        return {
          form: b.form,
          language: b.language,
          text: draft.text,
          rules: rules[b.form],
          sentences: draft.sentences,
          facts,
          provider: draft.provider.provider,
          model: draft.provider.model,
          outputId: draft.outputId,
        };
      },
    );

    /**
     * AIG-01: when the person copies an AI draft for the county's sending
     * tool or the publishing page, its record says whether they kept it as
     * written or changed it. Once only, and only for this county's public
     * drafts.
     */
    app.post(
      '/alerts/ai-draft/:outputId/kept',
      {
        schema: {
          tags: ['sites'],
          params: z.object({ outputId: z.uuid() }),
          body: z.object({ changed: z.boolean() }),
        },
      },
      async (request, reply) => {
        const s = account(request);
        await request.authorize('publication.draft', { type: 'publication', tenantId: s.tenantId });
        const done = await request.tx((trx) =>
          trx
            .updateTable('cg.ai_output')
            .set({ human_action: request.body.changed ? 'edited' : 'accepted' })
            .where('id', '=', request.params.outputId)
            .where('tenant_id', '=', s.tenantId)
            .where('feature', '=', 'public.drafting')
            .where('outcome', '=', 'ok')
            .where('human_action', 'is', null)
            .executeTakeFirst(),
        );
        if (!done.numUpdatedRows) {
          const seen = await request.tx((trx) =>
            trx
              .selectFrom('cg.ai_output')
              .select('id')
              .where('id', '=', request.params.outputId)
              .where('tenant_id', '=', s.tenantId)
              .where('feature', '=', 'public.drafting')
              .where('outcome', '=', 'ok')
              .executeTakeFirst(),
          );
          if (!seen) throw errors.notFound();
        }
        return reply.code(204).send();
      },
    );
  };

export const siteRoutes = siteRoutesWith();
