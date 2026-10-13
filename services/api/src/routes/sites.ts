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
import { draftAlerts, type AlertSite } from '../public/alerts.ts';
import { addressText, hoursText } from '../public/help.ts';
import { publicSites } from '../public/sites-view.ts';
import { configValue } from '../public/submit.ts';
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

export const siteRoutes: FastifyPluginAsync = async (instance) => {
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
  };

  const query = (trx: Trx) =>
    trx
      .selectFrom('cg.site as s')
      .leftJoin('cg.location as l', 'l.id', 's.location_id')
      .selectAll('s')
      .select([
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

  type SiteBody = { [K in keyof typeof siteFields]?: z.infer<(typeof siteFields)[K]> | undefined };
  function columns(body: SiteBody) {
    const out = pickDefined(body as Record<string, unknown>, columnMap);
    if (body.hours !== undefined) out['hours'] = JSON.stringify(body.hours);
    if (body.accessibility !== undefined) out['accessibility'] = JSON.stringify(body.accessibility);
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
        return x.execute();
      });
      const out = (rows as Joined[]).map(toOut);
      return q.stale === undefined ? out : out.filter((x) => x.stale === q.stale);
    },
  );

  app.get(
    '/sites/:id',
    { schema: { tags: ['sites'], params: uuidParam, response: { 200: siteOut } } },
    async (request) => {
      const row = await load(request, request.params.id);
      await request.authorize('site.read', operatedResourceOf(request, row), { asNotFound: true });
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
            ...(request.body.occupancy !== undefined ? { occupancy: request.body.occupancy } : {}),
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
          { name: 'siteId', message: 'a confidential site is never named in public text (PUB-05)' },
        ]);
      const result = await request.tx(async (trx) => {
        const tenant = await trx
          .selectFrom('cg.tenant')
          .select(['name', 'slug'])
          .where('id', '=', s.tenantId)
          .executeTakeFirstOrThrow();
        const helpPhone = (await configValue<string>(trx, 'intake.help_phone')) ?? null;
        const sites = await publicSites(trx, s.tenantId, {});
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
        const drafts = draftAlerts({
          county: tenant.name,
          change: request.body.change,
          site: asAlertSite(mine ?? current),
          next: mine?.nextNearest
            ? asAlertSite(sites.find((x) => x.id === mine.nextNearest!.id)!)
            : null,
          helpUrl: null,
          helpPhone,
        });
        const row = await trx
          .insertInto('cg.publication')
          .values({
            tenant_id: s.tenantId,
            subject_kind: 'alert_draft',
            subject_id: current.id,
            subject_version: current.version,
            snapshot: JSON.stringify({ change: request.body.change, drafts }),
            approved_by: s.accountId,
            channels: ['wea', 'mass_notification'],
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
};
