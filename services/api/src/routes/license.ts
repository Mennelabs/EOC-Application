/**
 * The county's subscription, read only (SCL-10). Each contract is an annual
 * subscription per jurisdiction, tiered by population served; a state or
 * coalition contract can cover member jurisdictions. The county sees its own
 * contracts and the ones above it that cover it (`cg.license_coverage()`,
 * migration 0106), whether any is in force today, and the standing promise
 * that resident reports are never metered or capped.
 *
 * Nothing in the platform acts on what this reads: intake, SMS and phone
 * reports never check a contract (license.db.test.ts holds that). Contracts
 * are written by the vendor's operator command, never through the API.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { errors } from '../errors.ts';

const contractOut = z.object({
  id: z.uuid(),
  holder: z.object({ id: z.uuid(), name: z.string(), kind: z.string() }),
  /** True when the reading tenant holds the contract; false when an ancestor's covers it. */
  own: z.boolean(),
  tier: z.string(),
  populationServed: z.number().int().nullable(),
  termStart: z.iso.date(),
  termEnd: z.iso.date(),
  status: z.enum(['active', 'expired', 'cancelled']),
  inForce: z.boolean(),
  /** Covered jurisdictions within the reader's own part of the hierarchy. */
  covered: z.array(z.object({ id: z.uuid(), name: z.string() })),
  coveredCount: z.number().int(),
});

interface CoverageRow {
  id: string;
  holder_id: string;
  holder_name: string;
  holder_kind: string;
  tier: string;
  population_served: number | null;
  term_start: Date | string;
  term_end: Date | string;
  status: 'active' | 'expired' | 'cancelled';
  in_force: boolean;
  covered: { id: string; name: string }[];
  covered_count: number;
}

/** A date column as YYYY-MM-DD, whichever way the driver hands it over. */
const day = (d: Date | string): string =>
  typeof d === 'string'
    ? d.slice(0, 10)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const licenseRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/license',
    {
      schema: {
        tags: ['license'],
        response: {
          200: z.object({
            contracts: z.array(contractOut),
            inForce: z.boolean(),
            /** SCL-10: always true; said by the server so no screen has to promise it alone. */
            residentReportsNeverCapped: z.literal(true),
          }),
        },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('license.read', { type: 'license', tenantId: s.tenantId });
      const rows = await request.tx(
        async (trx) =>
          (await sql<CoverageRow>`select * from cg.license_coverage()`.execute(trx)).rows,
      );
      const contracts = rows.map((r) => ({
        id: r.id,
        holder: { id: r.holder_id, name: r.holder_name, kind: r.holder_kind },
        own: r.holder_id === s.tenantId,
        tier: r.tier,
        populationServed: r.population_served,
        termStart: day(r.term_start),
        termEnd: day(r.term_end),
        status: r.status,
        inForce: r.in_force,
        covered: r.covered,
        coveredCount: r.covered_count,
      }));
      return {
        contracts,
        inForce: contracts.some((c) => c.inForce),
        residentReportsNeverCapped: true as const,
      };
    },
  );
};
