/**
 * Declaration data (layer-6 task D; DCL:DEC-05–DEC-11, DEC-14, DEC-16,
 * DEC-17, FL-17, RULE-02, RULE-14). One view per event with what a
 * declaration request needs, built from records, never retyped:
 * - verified damage by the counting rule (packages/reporting), with what is
 *   shown apart, by tract;
 * - the event area's population profile (DEC-06);
 * - the outage log, with outages longer than 72 hours flagged (DEC-07);
 * - official casualty counts, the latest per kind, with their source (DEC-08);
 * - public damage sites rolled up by category against the per-capita
 *   indicators the tenant enters (DEC-10);
 * - volunteer hours donated through check-ins, for Public Assistance credit
 *   (FL-17);
 * - the 30-day filing clock from the incident end date staff enter (DEC-16).
 * Staff enter the incident period, requested areas and the Box 8 and 9
 * drafts; nothing here is ever submitted to FEMA (DEC-14).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { Database } from '@cg/db';
import { countDamage, loadDamageRecords } from '@cg/reporting';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { areaProfile, currentSnapshot } from './area-profile.ts';
import { classifierFor, iso, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;

const OUTAGE_KINDS = [
  'hospital',
  'water',
  'wastewater',
  'police',
  'fire_ems',
  'school',
  'child_care',
  'eldercare',
  'roads',
  'power',
] as const;
const CATEGORIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
const yesNoUnknown = z.enum(['yes', 'no', 'unknown']);
const DAY = 86_400_000;
const LONG_OUTAGE_HOURS = 72;

const eventParam = z.object({ id: z.uuid() });
const date = z.iso.date();
const moment = z.iso.datetime({ offset: true });

const declarationOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  incidentType: z.string().nullable(),
  incidentStart: z.string().nullable(),
  incidentEnd: z.string().nullable(),
  requestedAreas: z.array(
    z.object({ name: z.string(), tenantId: z.uuid().optional(), programs: z.array(z.string()) }),
  ),
  box8Draft: z.string().nullable(),
  box9Draft: z.string().nullable(),
  reviewLabel: z.string(),
  updatedAt: z.iso.datetime(),
});

const outageOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  kind: z.enum(OUTAGE_KINDS),
  facilitySourceId: z.string().nullable(),
  facilityName: z.string().nullable(),
  description: z.string().nullable(),
  area: z.string().nullable(),
  customersOut: z.number().nullable(),
  startedAt: z.iso.datetime(),
  expectedRestorationAt: z.iso.datetime().nullable(),
  restoredAt: z.iso.datetime().nullable(),
  source: z.enum(['staff', 'feed_suggestion', 'utility_report']),
  confirmed: z.boolean(),
  hoursOut: z.number(),
  over72Hours: z.boolean(),
});

const casualtyOut = z.object({
  id: z.uuid(),
  kind: z.enum(['injured', 'missing', 'deceased']),
  count: z.number().int(),
  officialSource: z.string(),
  asOf: z.iso.datetime(),
  note: z.string().nullable(),
  enteredAt: z.iso.datetime(),
});

const paSiteOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  applicant: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.enum(CATEGORIES),
  position: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  estimatedCost: z.number().nullable(),
  costBasis: z.enum(['estimate', 'verified']),
  percentComplete: z.number().int().nullable(),
  insured: yesNoUnknown,
  otherFederalAgency: yesNoUnknown,
  debrisCubicYards: z.number().nullable(),
  status: z.enum(['active', 'withdrawn']),
  photos: z.number().int(),
});

type OutageRow = {
  id: string;
  version: number;
  kind: (typeof OUTAGE_KINDS)[number];
  facility_source_id: string | null;
  facility_name: string | null;
  description: string | null;
  area: string | null;
  customers_out: number | null;
  started_at: Date;
  expected_restoration_at: Date | null;
  restored_at: Date | null;
  source: 'staff' | 'feed_suggestion' | 'utility_report';
  confirmed_at: Date | null;
};

function outageView(r: OutageRow, now = Date.now()): z.infer<typeof outageOut> {
  const end = r.restored_at ? new Date(r.restored_at).getTime() : now;
  const hours = Math.max(0, (end - new Date(r.started_at).getTime()) / 3_600_000);
  return {
    id: r.id,
    version: r.version,
    kind: r.kind,
    facilitySourceId: r.facility_source_id,
    facilityName: r.facility_name,
    description: r.description,
    area: r.area,
    customersOut: r.customers_out,
    startedAt: iso(r.started_at)!,
    expectedRestorationAt: iso(r.expected_restoration_at),
    restoredAt: iso(r.restored_at),
    source: r.source,
    confirmed: r.source === 'staff' || r.confirmed_at !== null,
    hoursOut: Math.round(hours * 10) / 10,
    over72Hours: hours > LONG_OUTAGE_HOURS,
  };
}

type PaSiteRow = {
  id: string;
  version: number;
  applicant: string;
  name: string;
  description: string | null;
  category: (typeof CATEGORIES)[number];
  lat: number | null;
  lon: number | null;
  estimated_cost: string | null;
  cost_basis: 'estimate' | 'verified';
  percent_complete: number | null;
  insured: 'yes' | 'no' | 'unknown';
  other_federal_agency: 'yes' | 'no' | 'unknown';
  debris_cubic_yards: string | null;
  status: 'active' | 'withdrawn';
  photos: number | string;
};

const paSiteView = (r: PaSiteRow): z.infer<typeof paSiteOut> => ({
  id: r.id,
  version: r.version,
  applicant: r.applicant,
  name: r.name,
  description: r.description,
  category: r.category,
  position: r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
  estimatedCost: r.estimated_cost === null ? null : Number(r.estimated_cost),
  costBasis: r.cost_basis,
  percentComplete: r.percent_complete,
  insured: r.insured,
  otherFederalAgency: r.other_federal_agency,
  debrisCubicYards: r.debris_cubic_yards === null ? null : Number(r.debris_cubic_yards),
  status: r.status,
  photos: Number(r.photos),
});

const paSiteSelect = (trx: Trx) =>
  trx
    .selectFrom('cg.pa_site as s')
    .select([
      's.id',
      's.version',
      's.applicant',
      's.name',
      's.description',
      's.category',
      sql<number | null>`ST_Y(s.geom)`.as('lat'),
      sql<number | null>`ST_X(s.geom)`.as('lon'),
      's.estimated_cost',
      's.cost_basis',
      's.percent_complete',
      's.insured',
      's.other_federal_agency',
      's.debris_cubic_yards',
      's.status',
      sql<string>`(select count(*) from cg.photo p where p.field_record_type = 'pa_site' and p.field_record_id = s.id)`.as(
        'photos',
      ),
    ]);

const declarationView = (r: {
  id: string;
  version: number;
  incident_type: string | null;
  incident_start: string | Date | null;
  incident_end: string | Date | null;
  requested_areas: unknown;
  box8_draft: string | null;
  box9_draft: string | null;
  review_label: string;
  updated_at: Date;
}): z.infer<typeof declarationOut> => ({
  id: r.id,
  version: r.version,
  incidentType: r.incident_type,
  incidentStart: dayOf(r.incident_start),
  incidentEnd: dayOf(r.incident_end),
  requestedAreas: (r.requested_areas as z.infer<typeof declarationOut>['requestedAreas']) ?? [],
  box8Draft: r.box8_draft,
  box9Draft: r.box9_draft,
  reviewLabel: r.review_label,
  updatedAt: iso(r.updated_at)!,
});

function dayOf(v: string | Date | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

/** DEC-16: a major disaster request is due within 30 days of the incident end date. */
export function filingClock(incidentEnd: string | null, now = new Date()) {
  if (!incidentEnd) return null;
  const end = Date.parse(`${incidentEnd}T00:00:00Z`);
  const deadline = new Date(end + 30 * DAY).toISOString().slice(0, 10);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const daysLeft = Math.round((Date.parse(`${deadline}T00:00:00Z`) - today) / DAY);
  return { incidentEnd, deadline, daysLeft, overdue: daysLeft < 0 };
}

interface Indicators {
  statewidePerCapita: number | null;
  countywidePerCapita: number | null;
  statePopulation: number | null;
  fiscalYear: string | null;
}

async function indicatorsOf(trx: Trx, tenantId: string): Promise<Indicators> {
  const row = await trx
    .selectFrom('cg.tenant_config')
    .select('value')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', 'declaration.pa_indicators')
    .executeTakeFirst();
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  return {
    statewidePerCapita: n(v['statewidePerCapita']),
    countywidePerCapita: n(v['countywidePerCapita']),
    statePopulation: n(v['statePopulation']),
    fiscalYear: typeof v['fiscalYear'] === 'string' ? v['fiscalYear'] : null,
  };
}

export const declarationRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const eventOf = async (trx: Trx, eventId: string) => {
    const event = await trx
      .selectFrom('cg.event')
      .select(['id', 'tenant_id'])
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!event) throw errors.notFound();
    return event;
  };
  const readable = (request: FastifyRequest, tenantId: string, eventId: string) =>
    request.authorize('declaration.read', { type: 'declaration', tenantId, eventId });

  // ---------------------------------------------------------------- the view
  app.get(
    '/events/:id/declaration',
    { schema: { tags: ['declaration'], params: eventParam } },
    async (request) => {
      const s = account(request);
      const eventId = request.params.id;
      await readable(request, s.tenantId, eventId);
      return request.tx(async (trx) => {
        await eventOf(trx, eventId);
        const decl = await trx
          .selectFrom('cg.declaration')
          .selectAll()
          .where('event_id', '=', eventId)
          .executeTakeFirst();
        const damage = countDamage(await loadDamageRecords(trx, eventId));
        const profile = await areaProfile(trx, s.tenantId, eventId);
        const outages = (
          await trx
            .selectFrom('cg.outage')
            .selectAll()
            .where('event_id', '=', eventId)
            .orderBy('started_at')
            .execute()
        ).map((r) => outageView(r as OutageRow));
        const casualties = await sql<{
          kind: 'injured' | 'missing' | 'deceased';
          count: number;
          official_source: string;
          as_of: Date;
          entries: string;
        }>`
          select distinct on (kind) kind, count, official_source, as_of,
            count(*) over (partition by kind) as entries
          from cg.casualty_count where event_id = ${eventId}
          order by kind, as_of desc, created_at desc`.execute(trx);
        const sites = (
          await paSiteSelect(trx)
            .where('s.event_id', '=', eventId)
            .where('s.status', '=', 'active')
            .execute()
        ).map((r) => paSiteView(r as PaSiteRow));
        const byCategory = Object.fromEntries(
          CATEGORIES.map((c) => [
            c,
            {
              sites: sites.filter((x) => x.category === c).length,
              cost: sites
                .filter((x) => x.category === c)
                .reduce((n, x) => n + (x.estimatedCost ?? 0), 0),
            },
          ]),
        );
        const totalCost = sites.reduce((n, x) => n + (x.estimatedCost ?? 0), 0);
        const indicators = await indicatorsOf(trx, s.tenantId);
        const profiles = await currentSnapshot(trx, s.tenantId, 'tract_profile');
        const county = profiles
          ? await sql<{ population: string | null; tracts: string; missing: string }>`
              select sum(population) as population, count(*) as tracts,
                count(*) filter (where population is null) as missing
              from cg.ref_tract_profile where snapshot_id = ${profiles.id}`.execute(trx)
          : null;
        const countyRow = county?.rows[0];
        const countyPopulation =
          countyRow && Number(countyRow.missing) === 0 && countyRow.population !== null
            ? Number(countyRow.population)
            : null;
        const threshold = (perCapita: number | null, population: number | null) =>
          perCapita !== null && population !== null
            ? Math.round(perCapita * population * 100) / 100
            : null;
        const countyThreshold = threshold(indicators.countywidePerCapita, countyPopulation);
        const stateThreshold = threshold(indicators.statewidePerCapita, indicators.statePopulation);
        // FL-17: hours from check-ins, by who donated them. Partner organizations' people and
        // registered walk-up volunteers donate; staff of the county itself do not.
        const hours = await sql<{
          agency: string | null;
          kind: string | null;
          donated: boolean;
          hours: string;
          people: string;
          open_shifts: string;
        }>`
          select t.name as agency, t.kind,
            (t.kind = 'partner_org' or exists (
              select 1 from cg.volunteer_registration v
              where v.personnel_id = c.personnel_id and v.event_id = c.event_id)) as donated,
            sum(coalesce(c.hours, extract(epoch from (now() - c.started_at)) / 3600)) as hours,
            count(distinct c.personnel_id) as people,
            count(*) filter (where c.ended_at is null) as open_shifts
          from cg.check_in c
          left join cg.tenant t on t.id = c.tenant_id
          where c.event_id = ${eventId}
          group by 1, 2, 3
          order by 3 desc, 1`.execute(trx);
        const donatedRows = hours.rows.filter((h) => h.donated);
        const round1 = (n: number) => Math.round(n * 10) / 10;
        return {
          eventId,
          asOf: new Date().toISOString(),
          declaration: decl ? declarationView(decl) : null,
          clock: filingClock(decl ? dayOf(decl.incident_end) : null),
          damage: {
            counted: {
              units: damage.counted.units,
              homes: damage.counted.homes,
              unknownUnitBuildings: damage.counted.unknownUnitBuildings,
              byDegree: damage.counted.byDegree,
              cells: damage.counted.cells,
              byTract: damage.counted.byTract,
            },
            shownSeparately: damage.shownSeparately,
            merged: damage.merged,
            excluded: damage.excluded,
          },
          profile,
          outages: {
            items: outages,
            open: outages.filter((o) => !o.restoredAt).length,
            over72Hours: outages.filter((o) => o.over72Hours).length,
            unconfirmed: outages.filter((o) => !o.confirmed).length,
          },
          casualties: Object.fromEntries(
            (['injured', 'missing', 'deceased'] as const).map((k) => {
              const r = casualties.rows.find((x) => x.kind === k);
              return [
                k,
                r
                  ? {
                      count: r.count,
                      officialSource: r.official_source,
                      asOf: iso(r.as_of)!,
                      entries: Number(r.entries),
                    }
                  : null,
              ];
            }),
          ),
          publicAssistance: {
            sites: sites.length,
            byCategory,
            totalCost: Math.round(totalCost * 100) / 100,
            verifiedCost:
              Math.round(
                sites
                  .filter((x) => x.costBasis === 'verified')
                  .reduce((n, x) => n + (x.estimatedCost ?? 0), 0) * 100,
              ) / 100,
            indicators: {
              ...indicators,
              countyPopulation,
              countyThreshold,
              stateThreshold,
              meetsCounty: countyThreshold === null ? null : totalCost >= countyThreshold,
              meetsState: stateThreshold === null ? null : totalCost >= stateThreshold,
            },
          },
          donated: {
            volunteerHours: round1(donatedRows.reduce((n, h) => n + Number(h.hours), 0)),
            includesOpenShifts: donatedRows.some((h) => Number(h.open_shifts) > 0),
            byOrganization: donatedRows.map((h) => ({
              organization:
                h.kind === 'partner_org'
                  ? (h.agency ?? 'Partner organization')
                  : 'Registered volunteers',
              hours: round1(Number(h.hours)),
              people: Number(h.people),
            })),
          },
        };
      });
    },
  );

  app.put(
    '/events/:id/declaration',
    {
      schema: {
        tags: ['declaration'],
        params: eventParam,
        body: z
          .object({
            incidentType: z.string().trim().min(1).max(80).nullable().optional(),
            incidentStart: date.nullable().optional(),
            incidentEnd: date.nullable().optional(),
            requestedAreas: z
              .array(
                z.object({
                  name: z.string().trim().min(1).max(120),
                  tenantId: z.uuid().optional(),
                  programs: z.array(z.enum(['IA', 'PA', 'HM', 'IH'])).max(4),
                }),
              )
              .max(200)
              .optional(),
            box8Draft: z.string().max(3000).nullable().optional(),
            box9Draft: z.string().max(3000).nullable().optional(),
          })
          .refine((b) => !b.incidentStart || !b.incidentEnd || b.incidentEnd >= b.incidentStart, {
            message: 'the incident cannot end before it starts',
            path: ['incidentEnd'],
          }),
        response: { 200: declarationOut, 201: declarationOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('declaration.write', {
        type: 'declaration',
        tenantId: s.tenantId,
        eventId,
      });
      const b = request.body;
      const set = {
        ...(b.incidentType !== undefined ? { incident_type: b.incidentType } : {}),
        ...(b.incidentStart !== undefined ? { incident_start: b.incidentStart } : {}),
        ...(b.incidentEnd !== undefined ? { incident_end: b.incidentEnd } : {}),
        ...(b.requestedAreas !== undefined
          ? { requested_areas: JSON.stringify(b.requestedAreas) }
          : {}),
        ...(b.box8Draft !== undefined ? { box8_draft: b.box8Draft } : {}),
        ...(b.box9Draft !== undefined ? { box9_draft: b.box9Draft } : {}),
      };
      const { row, created } = await request.tx(async (trx) => {
        const event = await eventOf(trx, eventId);
        const existing = await trx
          .selectFrom('cg.declaration')
          .selectAll()
          .where('event_id', '=', eventId)
          .executeTakeFirst();
        if (!existing) {
          const inserted = await trx
            .insertInto('cg.declaration')
            .values({
              tenant_id: event.tenant_id,
              event_id: eventId,
              ...set,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'declaration.write',
            targetType: 'declaration',
            targetId: inserted.id,
            targetVersion: inserted.version,
            changes: diffForAudit(null, set, classifierFor('declaration')),
          });
          return { row: inserted, created: true };
        }
        const expected = request.expectedVersion();
        const updated = await trx
          .updateTable('cg.declaration')
          .set({ ...set, version: sql`version + 1`, updated_by: s.accountId })
          .where('id', '=', existing.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        const saved = assertUpdated(updated, declarationView(existing));
        await request.audit(trx, {
          action: 'declaration.write',
          targetType: 'declaration',
          targetId: saved.id,
          targetVersion: saved.version,
          changes: diffForAudit(existing, saved, classifierFor('declaration')),
        });
        return { row: saved, created: false };
      });
      return reply.code(created ? 201 : 200).send(declarationView(row));
    },
  );

  // ---------------------------------------------------------------- outages (DEC-07)
  app.get(
    '/events/:id/outages',
    {
      schema: { tags: ['declaration'], params: eventParam, response: { 200: z.array(outageOut) } },
    },
    async (request) => {
      const s = account(request);
      await readable(request, s.tenantId, request.params.id);
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.outage')
          .selectAll()
          .where('event_id', '=', request.params.id)
          .orderBy('started_at')
          .execute(),
      );
      return rows.map((r) => outageView(r as OutageRow));
    },
  );

  const outageBody = z.object({
    kind: z.enum(OUTAGE_KINDS),
    facilitySourceId: z.string().trim().min(1).max(120).nullable().optional(),
    facilityName: z.string().trim().min(1).max(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    area: z.string().trim().max(300).nullable().optional(),
    customersOut: z.number().int().min(0).nullable().optional(),
    startedAt: moment,
    expectedRestorationAt: moment.nullable().optional(),
    restoredAt: moment.nullable().optional(),
  });

  app.post(
    '/events/:id/outages',
    {
      schema: {
        tags: ['declaration'],
        params: eventParam,
        body: outageBody.extend({
          clientUuid: z.uuid(),
          source: z.enum(['staff', 'feed_suggestion', 'utility_report']).default('staff'),
        }),
        response: { 201: outageOut, 200: outageOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('outage.write', { type: 'outage', tenantId: s.tenantId, eventId });
      const b = request.body;
      if (b.restoredAt && b.restoredAt < b.startedAt)
        throw errors.validation([{ name: 'restoredAt', message: 'restored before it started' }]);
      const { row, created } = await request.tx(async (trx) => {
        const event = await eventOf(trx, eventId);
        const existing = await trx
          .selectFrom('cg.outage')
          .selectAll()
          .where('client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (existing) return { row: existing, created: false };
        const values = {
          kind: b.kind,
          facility_source_id: b.facilitySourceId ?? null,
          facility_name: b.facilityName ?? null,
          description: b.description ?? null,
          area: b.area ?? null,
          customers_out: b.customersOut ?? null,
          started_at: b.startedAt,
          expected_restoration_at: b.expectedRestorationAt ?? null,
          restored_at: b.restoredAt ?? null,
          source: b.source,
        };
        const inserted = await trx
          .insertInto('cg.outage')
          .values({
            tenant_id: event.tenant_id,
            event_id: eventId,
            client_uuid: b.clientUuid,
            ...values,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'outage.write',
          targetType: 'outage',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(null, values, classifierFor('outage')),
        });
        return { row: inserted, created: true };
      });
      return reply.code(created ? 201 : 200).send(outageView(row as OutageRow));
    },
  );

  app.patch(
    '/outages/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['declaration'],
        params: uuidParam,
        body: outageBody.partial(),
        response: { 200: outageOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('outage.write', { type: 'outage', tenantId: s.tenantId });
      const b = request.body;
      const set = {
        ...(b.kind !== undefined ? { kind: b.kind } : {}),
        ...(b.facilitySourceId !== undefined ? { facility_source_id: b.facilitySourceId } : {}),
        ...(b.facilityName !== undefined ? { facility_name: b.facilityName } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.area !== undefined ? { area: b.area } : {}),
        ...(b.customersOut !== undefined ? { customers_out: b.customersOut } : {}),
        ...(b.startedAt !== undefined ? { started_at: b.startedAt } : {}),
        ...(b.expectedRestorationAt !== undefined
          ? { expected_restoration_at: b.expectedRestorationAt }
          : {}),
        ...(b.restoredAt !== undefined ? { restored_at: b.restoredAt } : {}),
      };
      const saved = await request.tx(async (trx) => {
        const row = await trx
          .selectFrom('cg.outage')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!row) throw errors.notFound();
        const startedAt = new Date(b.startedAt ?? row.started_at).getTime();
        const restored = b.restoredAt !== undefined ? b.restoredAt : row.restored_at;
        if (restored && new Date(restored).getTime() < startedAt)
          throw errors.validation([{ name: 'restoredAt', message: 'restored before it started' }]);
        const u = await trx
          .updateTable('cg.outage')
          .set({ ...set, version: sql`version + 1`, updated_by: s.accountId })
          .where('id', '=', row.id)
          .where('version', '=', request.expectedVersion())
          .returningAll()
          .executeTakeFirst();
        const out = assertUpdated(u, outageView(row as OutageRow));
        await request.audit(trx, {
          action: 'outage.write',
          targetType: 'outage',
          targetId: out.id,
          targetVersion: out.version,
          changes: diffForAudit(row, out, classifierFor('outage')),
        });
        return out;
      });
      return outageView(saved as OutageRow);
    },
  );

  // A suggestion from a feed becomes part of the log only when a person confirms it.
  app.post(
    '/outages/:id/confirm',
    {
      config: { requiresVersion: true },
      schema: { tags: ['declaration'], params: uuidParam, response: { 200: outageOut } },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('outage.write', { type: 'outage', tenantId: s.tenantId });
      const saved = await request.tx(async (trx) => {
        const row = await trx
          .selectFrom('cg.outage')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!row) throw errors.notFound();
        if (row.source === 'staff' || row.confirmed_at) return row;
        const u = await trx
          .updateTable('cg.outage')
          .set({
            confirmed_by: s.accountId,
            confirmed_at: new Date(),
            version: sql`version + 1`,
            updated_by: s.accountId,
          })
          .where('id', '=', row.id)
          .where('version', '=', request.expectedVersion())
          .returningAll()
          .executeTakeFirst();
        const out = assertUpdated(u, outageView(row as OutageRow));
        await request.audit(trx, {
          action: 'outage.confirm',
          targetType: 'outage',
          targetId: out.id,
          targetVersion: out.version,
        });
        return out;
      });
      return outageView(saved as OutageRow);
    },
  );

  // ---------------------------------------------------------------- casualties (DEC-08)
  app.get(
    '/events/:id/casualties',
    {
      schema: {
        tags: ['declaration'],
        params: eventParam,
        response: { 200: z.array(casualtyOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await readable(request, s.tenantId, request.params.id);
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.casualty_count')
          .selectAll()
          .where('event_id', '=', request.params.id)
          .orderBy('as_of', 'desc')
          .orderBy('created_at', 'desc')
          .execute(),
      );
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        count: r.count,
        officialSource: r.official_source,
        asOf: iso(r.as_of)!,
        note: r.note,
        enteredAt: iso(r.created_at)!,
      }));
    },
  );

  app.post(
    '/events/:id/casualties',
    {
      config: { idempotent: true },
      schema: {
        tags: ['declaration'],
        params: eventParam,
        body: z.object({
          kind: z.enum(['injured', 'missing', 'deceased']),
          count: z.number().int().min(0).max(1_000_000),
          officialSource: z.string().trim().min(3).max(300),
          asOf: moment,
          note: z.string().trim().max(1000).optional(),
        }),
        response: { 201: casualtyOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('casualty.record', {
        type: 'casualty_count',
        tenantId: s.tenantId,
        eventId,
      });
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const event = await eventOf(trx, eventId);
        const inserted = await trx
          .insertInto('cg.casualty_count')
          .values({
            tenant_id: event.tenant_id,
            event_id: eventId,
            kind: b.kind,
            count: b.count,
            official_source: b.officialSource,
            as_of: b.asOf,
            note: b.note ?? null,
            entered_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'casualty.record',
          targetType: 'casualty_count',
          targetId: inserted.id,
          changes: diffForAudit(
            null,
            { kind: b.kind, count: b.count, official_source: b.officialSource },
            classifierFor('casualty_count'),
          ),
        });
        return inserted;
      });
      return reply.code(201).send({
        id: row.id,
        kind: row.kind,
        count: row.count,
        officialSource: row.official_source,
        asOf: iso(row.as_of)!,
        note: row.note,
        enteredAt: iso(row.created_at)!,
      });
    },
  );

  // ---------------------------------------------------------------- public damage (DEC-10)
  app.get(
    '/events/:id/pa-sites',
    {
      schema: { tags: ['declaration'], params: eventParam, response: { 200: z.array(paSiteOut) } },
    },
    async (request) => {
      const s = account(request);
      await readable(request, s.tenantId, request.params.id);
      const rows = await request.tx((trx) =>
        paSiteSelect(trx)
          .where('s.event_id', '=', request.params.id)
          .orderBy('s.category')
          .orderBy('s.name')
          .execute(),
      );
      return rows.map((r) => paSiteView(r as PaSiteRow));
    },
  );

  const paBody = z.object({
    applicant: z.string().trim().min(1).max(200),
    applicantTenantId: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    category: z.enum(CATEGORIES),
    position: z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
      .nullable()
      .optional(),
    estimatedCost: z.number().min(0).max(1e12).nullable().optional(),
    costBasis: z.enum(['estimate', 'verified']).optional(),
    percentComplete: z.number().int().min(0).max(100).nullable().optional(),
    insured: yesNoUnknown.optional(),
    otherFederalAgency: yesNoUnknown.optional(),
    debrisCubicYards: z.number().min(0).max(1e9).nullable().optional(),
  });
  /** Any subset of the site's fields, as a create or a change sends them. */
  type PaInput = { [K in keyof z.infer<typeof paBody>]?: z.infer<typeof paBody>[K] | undefined };
  const paColumns = (b: PaInput) => ({
    ...(b.applicant !== undefined ? { applicant: b.applicant } : {}),
    ...(b.applicantTenantId !== undefined ? { applicant_tenant_id: b.applicantTenantId } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.description !== undefined ? { description: b.description } : {}),
    ...(b.category !== undefined ? { category: b.category } : {}),
    ...(b.position !== undefined
      ? {
          geom: b.position
            ? sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`
            : null,
        }
      : {}),
    ...(b.estimatedCost !== undefined ? { estimated_cost: b.estimatedCost } : {}),
    ...(b.costBasis !== undefined ? { cost_basis: b.costBasis } : {}),
    ...(b.percentComplete !== undefined ? { percent_complete: b.percentComplete } : {}),
    ...(b.insured !== undefined ? { insured: b.insured } : {}),
    ...(b.otherFederalAgency !== undefined ? { other_federal_agency: b.otherFederalAgency } : {}),
    ...(b.debrisCubicYards !== undefined ? { debris_cubic_yards: b.debrisCubicYards } : {}),
  });
  /** What the audit records: the plain fields, the position as a flag. */
  const paAudit = (b: PaInput) => {
    const { position, ...rest } = b;
    return position === undefined ? rest : { ...rest, located: position !== null };
  };

  app.post(
    '/events/:id/pa-sites',
    {
      schema: {
        tags: ['declaration'],
        params: eventParam,
        body: paBody.extend({ clientUuid: z.uuid() }),
        response: { 201: paSiteOut, 200: paSiteOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const eventId = request.params.id;
      await request.authorize('pa_site.write', { type: 'pa_site', tenantId: s.tenantId, eventId });
      const b = request.body;
      const { id, created } = await request.tx(async (trx) => {
        const event = await eventOf(trx, eventId);
        const existing = await trx
          .selectFrom('cg.pa_site')
          .select('id')
          .where('client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (existing) return { id: existing.id, created: false };
        const inserted = await trx
          .insertInto('cg.pa_site')
          .values({
            tenant_id: event.tenant_id,
            event_id: eventId,
            client_uuid: b.clientUuid,
            applicant: b.applicant,
            name: b.name,
            category: b.category,
            ...paColumns(b),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'pa_site.write',
          targetType: 'pa_site',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(null, paAudit(b), classifierFor('pa_site')),
        });
        return { id: inserted.id, created: true };
      });
      const row = await request.tx((trx) =>
        paSiteSelect(trx).where('s.id', '=', id).executeTakeFirstOrThrow(),
      );
      return reply.code(created ? 201 : 200).send(paSiteView(row as PaSiteRow));
    },
  );

  app.patch(
    '/pa-sites/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['declaration'],
        params: uuidParam,
        body: paBody.partial().extend({ status: z.enum(['active', 'withdrawn']).optional() }),
        response: { 200: paSiteOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('pa_site.write', { type: 'pa_site', tenantId: s.tenantId });
      const { status, ...b } = request.body;
      await request.tx(async (trx) => {
        const row = await paSiteSelect(trx)
          .where('s.id', '=', request.params.id)
          .executeTakeFirst();
        if (!row) throw errors.notFound();
        const u = await trx
          .updateTable('cg.pa_site')
          .set({
            ...paColumns(b),
            ...(status !== undefined ? { status } : {}),
            version: sql`version + 1`,
            updated_by: s.accountId,
          })
          .where('id', '=', row.id)
          .where('version', '=', request.expectedVersion())
          .returning(['id', 'version'])
          .executeTakeFirst();
        const out = assertUpdated(u, paSiteView(row as PaSiteRow));
        await request.audit(trx, {
          action: 'pa_site.write',
          targetType: 'pa_site',
          targetId: out.id,
          targetVersion: out.version,
          changes: diffForAudit(
            {},
            { ...paAudit(b), ...(status !== undefined ? { status } : {}) },
            classifierFor('pa_site'),
          ),
        });
      });
      const row = await request.tx((trx) =>
        paSiteSelect(trx).where('s.id', '=', request.params.id).executeTakeFirstOrThrow(),
      );
      return paSiteView(row as PaSiteRow);
    },
  );
};
