/**
 * Shelter counts from the Red Cross system, without personal details (CON-16:
 * "import of shelter counts from the Red Cross system without personal
 * details"). Mass care loads the Red Cross shelter report as a CSV file, with
 * its column names mapped to ours: the shelter's id in their records, its
 * name, and optionally its status, people staying, capacity and when it was
 * counted. Only those columns are read; every other column is dropped and the
 * file is not kept. A file whose columns name people (first or last names,
 * dates of birth, phone numbers, emails, client or guest lists) is refused
 * whole, so a roster is never loaded by mistake. Each count is kept as the Red
 * Cross reported it; the same shelter at the same moment is not counted
 * twice. A county site that carries the shelter's id (`site.externalRef`)
 * takes the newest count as its occupancy; its status stays with whoever
 * confirms the site (PUB-03), and the reported status is shown beside it.
 * Importing needs a reason and is audited.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { parseCsv } from '@cg/refdata';
import { ApiError, errors } from '../errors.ts';

/**
 * Column names that mean a file lists people, not shelters. A column about the shelter itself
 * ("Shelter Phone", "Facility Name") is not one.
 */
const ABOUT_SHELTER = /^(shelter|facility|site|location)\b/i;
const PERSONAL =
  /\b(first|last|full|given|family|middle)[ _-]?name\b|\bbirth|\bdob\b|\bphone\b|\be-?mail\b|\bssn\b|\bsocial security\b|\bclient\b|\bguest\b|\bresident name\b|\bhousehold member\b|\bgender\b|\bage\b/i;

const STATUS: Record<string, 'open' | 'limited' | 'full' | 'closed'> = {
  open: 'open',
  opened: 'open',
  active: 'open',
  limited: 'limited',
  partial: 'limited',
  'near capacity': 'limited',
  full: 'full',
  'at capacity': 'full',
  closed: 'closed',
  inactive: 'closed',
};

const count = (v: string | undefined) => {
  if (v === undefined || v.trim() === '') return { ok: true as const, value: null };
  const n = Number(v.replace(/,/g, '').trim());
  return Number.isInteger(n) && n >= 0 && n < 1_000_000
    ? { ok: true as const, value: n }
    : { ok: false as const };
};

export const shelterCountRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.post(
    '/shelter-counts/import',
    {
      bodyLimit: 3 * 1024 * 1024,
      schema: {
        tags: ['sites'],
        body: z.object({
          eventId: z.uuid(),
          source: z.literal('red_cross').default('red_cross'),
          csv: z
            .string()
            .min(1)
            .max(2 * 1024 * 1024),
          /** The file's column names for each of ours; the id and the name are required. */
          mapping: z.object({
            externalRef: z.string().min(1).max(120),
            name: z.string().min(1).max(120),
            status: z.string().max(120).optional(),
            population: z.string().max(120).optional(),
            capacity: z.string().max(120).optional(),
            asOf: z.string().max(120).optional(),
          }),
          /** When the counts were taken, if the file has no column for it. */
          asOf: z.iso.datetime().optional(),
        }),
        response: {
          200: z.object({
            imported: z.number().int(),
            duplicates: z.number().int(),
            sitesUpdated: z.number().int(),
            rejected: z.number().int(),
            problems: z.array(z.object({ row: z.number().int(), reason: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      const { eventId, source, csv, mapping, asOf } = request.body;
      await request.authorize('shelter_count.import', {
        type: 'shelter_count',
        tenantId: s.tenantId,
        eventId,
      });
      const { reason } = request.confirmation();
      const rows = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
      const header = (rows.shift() ?? []).map((h) => h.trim());
      // A list of people is refused whole: only shelter counts may be loaded (CON-16).
      const personal = header.filter((h) => PERSONAL.test(h) && !ABOUT_SHELTER.test(h));
      if (personal.length)
        throw new ApiError(
          400,
          'personal_details',
          'This file has columns about people. Only shelter counts can be imported; remove those columns or export the shelter summary instead.',
          { fields: personal.slice(0, 10).map((h) => ({ name: h, message: 'names people' })) },
        );
      const col = (name: string | undefined) => (name ? header.indexOf(name.trim()) : -1);
      const at = {
        ref: col(mapping.externalRef),
        name: col(mapping.name),
        status: col(mapping.status),
        population: col(mapping.population),
        capacity: col(mapping.capacity),
        asOf: col(mapping.asOf),
      };
      const missing = (
        [
          ['externalRef', mapping.externalRef],
          ['name', mapping.name],
          ['status', mapping.status],
          ['population', mapping.population],
          ['capacity', mapping.capacity],
          ['asOf', mapping.asOf],
        ] as const
      ).filter(([, name]) => name !== undefined && col(name) < 0);
      if (missing.length)
        throw errors.validation(
          missing.map(([field, name]) => ({
            name: `mapping.${field}`,
            message: `no column named "${name}"`,
          })),
        );
      if (rows.length > 2000)
        throw errors.validation([{ name: 'csv', message: 'at most 2,000 shelters per file' }]);
      const problems: { row: number; reason: string }[] = [];
      let imported = 0;
      let duplicates = 0;
      let sitesUpdated = 0;
      const touched = new Set<string>();
      await request.tx(async (trx) => {
        const event = await trx
          .selectFrom('cg.event')
          .select('id')
          .where('id', '=', eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        for (const [i, r] of rows.entries()) {
          const row = i + 2; // the header is row 1
          const ref = r[at.ref]?.trim() ?? '';
          const name = r[at.name]?.trim() ?? '';
          if (!ref || !name) {
            problems.push({ row, reason: 'no shelter id or name' });
            continue;
          }
          const population = count(at.population >= 0 ? r[at.population] : undefined);
          const capacity = count(at.capacity >= 0 ? r[at.capacity] : undefined);
          if (!population.ok || !capacity.ok) {
            problems.push({ row, reason: 'a count is not a whole number' });
            continue;
          }
          const rawWhen = at.asOf >= 0 ? (r[at.asOf]?.trim() ?? '') : '';
          const when = rawWhen ? new Date(rawWhen) : asOf ? new Date(asOf) : new Date();
          if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 3_600_000) {
            problems.push({ row, reason: 'the time it was counted is not a date, or is ahead' });
            continue;
          }
          const status =
            at.status >= 0 ? (STATUS[(r[at.status] ?? '').trim().toLowerCase()] ?? null) : null;
          const site = await trx
            .selectFrom('cg.site')
            .select('id')
            .where('external_ref', '=', ref)
            .executeTakeFirst();
          const inserted = await trx
            .insertInto('cg.shelter_count')
            .values({
              tenant_id: s.tenantId,
              event_id: eventId,
              source,
              external_ref: ref.slice(0, 80),
              shelter_name: name.slice(0, 200),
              status,
              population: population.value,
              capacity: capacity.value,
              as_of: when,
              site_id: site?.id ?? null,
              imported_by: s.accountId,
            })
            .onConflict((oc) =>
              oc.columns(['tenant_id', 'event_id', 'source', 'external_ref', 'as_of']).doNothing(),
            )
            .returning('id')
            .executeTakeFirst();
          if (!inserted) {
            duplicates += 1;
            continue;
          }
          imported += 1;
          if (site && population.value !== null) touched.add(site.id);
        }
        // Each linked site takes its newest count as occupancy; its status stays with its confirmer.
        for (const siteId of touched) {
          const updated = await sql<{ id: string }>`
            update cg.site s set occupancy = c.population, updated_by = ${s.accountId}
              from (select population from cg.shelter_count
                     where site_id = ${siteId} and population is not null
                     order by as_of desc limit 1) c
             where s.id = ${siteId} and s.occupancy is distinct from c.population
            returning s.id`.execute(trx);
          sitesUpdated += updated.rows.length;
        }
        await request.audit(trx, {
          action: 'shelter_count.import',
          targetType: 'event',
          targetId: eventId,
          reason: reason ?? null,
          changes: {
            fields: [
              { name: 'source', to: source },
              { name: 'imported', to: imported },
              { name: 'duplicates', to: duplicates },
              { name: 'rejected', to: problems.length },
              { name: 'sites_updated', to: sitesUpdated },
            ],
          },
        });
      });
      return {
        imported,
        duplicates,
        sitesUpdated,
        rejected: problems.length,
        problems: problems.slice(0, 50),
      };
    },
  );

  app.get(
    '/shelter-counts',
    {
      schema: {
        tags: ['sites'],
        querystring: z.object({ eventId: z.uuid() }),
        response: {
          200: z.object({
            shelters: z.array(
              z.object({
                externalRef: z.string(),
                name: z.string(),
                status: z.string().nullable(),
                population: z.number().int().nullable(),
                capacity: z.number().int().nullable(),
                asOf: z.string(),
                site: z.object({ id: z.uuid(), name: z.string() }).nullable(),
              }),
            ),
            totals: z.object({
              shelters: z.number().int(),
              population: z.number().int(),
              capacity: z.number().int(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      const { eventId } = request.query;
      await request.authorize('shelter_count.read', {
        type: 'shelter_count',
        tenantId: s.tenantId,
        eventId,
      });
      return request.tx(async (trx) => {
        // The newest count per shelter.
        const rows = await trx
          .selectFrom('cg.shelter_count as c')
          .leftJoin('cg.site as st', 'st.id', 'c.site_id')
          .select([
            'c.external_ref',
            'c.shelter_name',
            'c.status',
            'c.population',
            'c.capacity',
            'c.as_of',
            'st.id as site_id',
            'st.name as site_name',
          ])
          .distinctOn('c.external_ref')
          .where('c.event_id', '=', eventId)
          .orderBy('c.external_ref')
          .orderBy('c.as_of', 'desc')
          .execute();
        rows.sort((a, b) => a.shelter_name.localeCompare(b.shelter_name));
        return {
          shelters: rows.map((r) => ({
            externalRef: r.external_ref,
            name: r.shelter_name,
            status: r.status,
            population: r.population,
            capacity: r.capacity,
            asOf: new Date(r.as_of).toISOString(),
            site: r.site_id ? { id: r.site_id, name: r.site_name ?? '' } : null,
          })),
          totals: {
            shelters: rows.length,
            population: rows.reduce((n, r) => n + (r.population ?? 0), 0),
            capacity: rows.reduce((n, r) => n + (r.capacity ?? 0), 0),
          },
        };
      });
    },
  );
};
