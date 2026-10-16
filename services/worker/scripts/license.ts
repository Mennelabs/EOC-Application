/**
 * Subscription contracts, the vendor's operator command (SCL-10). A contract
 * is an annual subscription per jurisdiction, tiered by population served;
 * a state or coalition contract can cover its member jurisdictions (the
 * tenants below it). Counties read their contracts on the Subscription
 * screen; no county role can write one (`license.write` is explicit and no
 * template holds it). Every change is audited on the holder's chain with the
 * operator's name and reason. Nothing here meters or caps resident reports:
 * intake never reads a contract.
 *
 *   DATABASE_URL=postgres://cg_worker:…@localhost:5432/cg pnpm --filter @cg/worker license list state
 *   … license add --holder state --tier "state coalition" --population 6100000 \
 *       --start 2026-07-01 --end 2027-06-30 --covers region,county,city \
 *       --by "A. Operator" --reason "Signed renewal, contract 2026-17"
 *   … license status <contract id> expired --by "A. Operator" --reason "Term ended"
 *
 * Tier names and population breakpoints are not decided yet (Section 21,
 * 2026-10-12); the tier is kept as the contract states it.
 */
import { parseArgs } from 'node:util';
import { recordAudit } from '@cg/audit';
import { createDb, withTenant, type Database } from '@cg/db';
import type { Kysely } from 'kysely';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ContractInput {
  holder: string;
  tier: string;
  population: number | null;
  start: string;
  end: string;
  covers: string[];
  by: string;
  reason: string;
}

/** What is wrong with a contract before it reaches the database, or null. */
export function contractProblem(c: ContractInput): string | null {
  if (!c.tier.trim() || c.tier.length > 80) return 'the tier is 1 to 80 characters';
  if (c.population !== null && (!Number.isInteger(c.population) || c.population < 0))
    return 'the population served is a whole number';
  if (!DAY.test(c.start) || !DAY.test(c.end)) return 'dates are YYYY-MM-DD';
  if (c.end <= c.start) return 'the term ends after it starts';
  if (!c.by.trim() || !c.reason.trim()) return 'say who is making the change, and why';
  return null;
}

async function tenantId(db: Kysely<Database>, slug: string): Promise<string> {
  const t = await db
    .selectFrom('cg.tenant')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (!t) throw new Error(`no organization "${slug}"`);
  return t.id;
}

/** Adds a contract on the holder's tenant; the database refuses coverage outside its members. */
export async function addContract(db: Kysely<Database>, c: ContractInput): Promise<string> {
  const problem = contractProblem(c);
  if (problem) throw new Error(problem);
  const holder = await tenantId(db, c.holder);
  const covers = await Promise.all(c.covers.map((slug) => tenantId(db, slug)));
  return withTenant(db, { tenantId: holder }, async (trx) => {
    const row = await trx
      .insertInto('cg.license')
      .values({
        tenant_id: holder,
        tier: c.tier.trim(),
        population_served: c.population,
        term_start: c.start,
        term_end: c.end,
        covers_tenant_ids: covers,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      tenantId: holder,
      actorKind: 'system',
      action: 'license.added',
      targetType: 'license',
      targetId: row.id,
      targetVersion: row.version,
      changes: {
        tier: c.tier.trim(),
        populationServed: c.population,
        termStart: c.start,
        termEnd: c.end,
        covers: c.covers,
        operator: c.by.trim(),
      },
      reason: c.reason.trim(),
    });
    return row.id;
  });
}

/** Marks a contract expired or cancelled (or active again); audited with who and why. */
export async function setContractStatus(
  db: Kysely<Database>,
  id: string,
  status: 'active' | 'expired' | 'cancelled',
  by: string,
  reason: string,
): Promise<void> {
  if (!by.trim() || !reason.trim()) throw new Error('say who is making the change, and why');
  const current = await db
    .selectFrom('cg.license')
    .select(['tenant_id', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!current) throw new Error(`no contract ${id}`);
  await withTenant(db, { tenantId: current.tenant_id }, async (trx) => {
    const row = await trx
      .updateTable('cg.license')
      .set({ status })
      .where('id', '=', id)
      .returning('version')
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      tenantId: current.tenant_id,
      actorKind: 'system',
      action: 'license.status_changed',
      targetType: 'license',
      targetId: id,
      targetVersion: row.version,
      changes: { status: { from: current.status, to: status }, operator: by.trim() },
      reason: reason.trim(),
    });
  });
}

async function main(argv: string[]): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('set DATABASE_URL to the worker role (cg_worker)');
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      holder: { type: 'string' },
      tier: { type: 'string' },
      population: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      covers: { type: 'string' },
      by: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  const db = createDb(url, 2);
  try {
    const [command, ...rest] = positionals;
    if (command === 'list') {
      const holder = await tenantId(db, rest[0] ?? '');
      const rows = await db
        .selectFrom('cg.license')
        .selectAll()
        .where('tenant_id', '=', holder)
        .orderBy('term_end', 'desc')
        .execute();
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    } else if (command === 'add') {
      const id = await addContract(db, {
        holder: values.holder ?? '',
        tier: values.tier ?? '',
        population: values.population === undefined ? null : Number(values.population),
        start: values.start ?? '',
        end: values.end ?? '',
        covers: (values.covers ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        by: values.by ?? '',
        reason: values.reason ?? '',
      });
      process.stdout.write(`contract ${id} added\n`);
    } else if (command === 'status') {
      const [id, status] = rest;
      if (!id || (status !== 'active' && status !== 'expired' && status !== 'cancelled'))
        throw new Error('usage: license status <contract id> active|expired|cancelled');
      await setContractStatus(db, id, status, values.by ?? '', values.reason ?? '');
      process.stdout.write(`contract ${id} is ${status}\n`);
    } else {
      throw new Error('usage: license list <holder> | add … | status <id> <status> …');
    }
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
