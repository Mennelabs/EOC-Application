/**
 * Generation load profile (layer-6 plan §9; SCL-03, GATE-07): how long the
 * official numbers take for a large event. An exercise county is filled
 * with synthetic damage reports (SCL-12), then each is timed as the stack
 * runs it:
 *
 * - counting: the counting rule over every record of the event;
 * - package: the IDA package's data, its PDF and the zip, as the worker
 *   builds it (worker role);
 * - metrics: every metric with its trends, as the API computes it (app
 *   role, under row-level security).
 *
 * Budgets: `full` is 50,000 reports with each step under 60 seconds;
 * `smoke` (CI) is 1,000 reports with each under 15 seconds. The summary is
 * written to tests/load/out/generation-<profile>.json; the run fails when a
 * step is over its budget. The county is closed afterwards.
 *
 *   API_DB_TEST_APP_URL=… API_DB_TEST_WORKER_URL=… pnpm --filter @cg/worker load:generation smoke
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { createDb, withTenant } from '@cg/db';
import { renderPdf } from '@cg/pdf';
import {
  FORM_KEYS,
  buildPackage,
  computeMetrics,
  countDamage,
  loadDamageRecords,
  loadPackageData,
  mappingInForce,
  zip,
  type FormKey,
  type Mapping,
} from '@cg/reporting';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';

const PROFILES = {
  smoke: { reports: 1_000, budgetMs: 15_000 },
  full: { reports: 50_000, budgetMs: 60_000 },
} as const;
const BATCH = 2_000;

const profile = (process.argv[2] ?? 'smoke') as keyof typeof PROFILES;
const p = PROFILES[profile];
if (!p) throw new Error(`profile must be ${Object.keys(PROFILES).join(' or ')}`);
const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
if (!appUrl || !workerUrl) throw new Error('set API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL');

const app = createDb(appUrl, 2);
const worker = createDb(workerUrl, 2);
const run = randomUUID().slice(0, 8);
const slug = `exercise-load-${run}`;
const timings: Record<string, number> = {};
const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  const out = await fn();
  timings[name] = Math.round(performance.now() - start);
  process.stdout.write(`${name}: ${timings[name]} ms\n`);
  return out;
};

try {
  const seeded = await loadSeed(worker);
  const county = (
    await worker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise load county ${run}`,
        status: 'provisioning',
        timezone: 'America/Chicago',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const { eventId, reviewerId } = await withTenant(worker, { tenantId: county }, async (trx) => {
    const reviewer = await trx
      .insertInto('cg.account')
      .values({
        tenant_id: county,
        email: `load-${run}@example.org`,
        display_name: 'Exercise load reviewer',
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const event = await trx
      .insertInto('cg.event')
      .values({
        tenant_id: county,
        name: `Exercise load flood ${run}`,
        hazard_type: 'flood',
        status: 'active',
        opened_at: new Date(Date.now() - 72 * 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { eventId: event.id, reviewerId: reviewer.id };
  });

  await time('load_reports', async () => {
    for (let done = 0, batch = 0; done < p.reports; done += BATCH, batch++)
      await loadDamageReports(worker, {
        tenantId: county,
        eventId,
        reviewerId,
        count: Math.min(BATCH, p.reports - done),
        seed: 6060 + batch,
        tag: `L${run}-${batch}`,
      });
  });

  // The exercise county's parcels repeat across a large load; give every
  // report its own home so the package is measured at full size.
  await withTenant(worker, { tenantId: county }, (trx) =>
    trx
      .updateTable('cg.location')
      .set({
        parcel_id: null,
        address_key: sql<string>`coalesce(address_key, '') || '|' || id::text`,
      })
      .where('tenant_id', '=', county)
      .execute(),
  );

  const totals = await time('counting', () =>
    withTenant(worker, { tenantId: county }, async (trx) =>
      countDamage(await loadDamageRecords(trx, eventId)),
    ),
  );

  const bytes = await time('package', async () => {
    const built = await withTenant(worker, { tenantId: county }, async (trx) => {
      const data = await loadPackageData(trx, county, eventId);
      const inForce = {} as Record<FormKey, Mapping>;
      for (const f of FORM_KEYS) inForce[f] = await mappingInForce(trx, county, f);
      return data ? { data, inForce } : null;
    });
    if (!built) throw new Error('the package data could not be read');
    const now = new Date();
    const pkg = buildPackage(built.data, built.inForce, {
      productName: 'Load profile',
      generatedAt: now,
    });
    const pdf = await renderPdf(pkg.pdf);
    return zip(
      [
        { name: 'package.pdf', body: pdf },
        ...pkg.files.map((f) => ({ name: f.name, body: f.body })),
      ],
      now,
    ).length;
  });

  const metrics = await time('metrics', () =>
    withTenant(app, { tenantId: county }, (trx) =>
      computeMetrics(trx, county, {
        eventId,
        from: new Date(Date.now() - 7 * 86_400_000),
        to: new Date(),
        timeZone: 'America/Chicago',
        filters: {},
      }),
    ),
  );

  const over = ['counting', 'package', 'metrics'].filter((k) => (timings[k] ?? 0) > p.budgetMs);
  const summary = {
    profile,
    reports: p.reports,
    budgetMs: p.budgetMs,
    timings,
    countedUnits: totals.counted.units,
    homes: totals.counted.homes,
    packageBytes: bytes,
    metrics: metrics.metrics.length,
    pass: over.length === 0,
    over,
    at: new Date().toISOString(),
  };
  const out = join(dirname(fileURLToPath(import.meta.url)), '../../../tests/load/out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `generation-${profile}.json`), JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (over.length) process.exitCode = 1;
} finally {
  await worker
    .updateTable('cg.tenant')
    .set({ status: 'closed' })
    .where('slug', '=', slug)
    .execute();
  await app.destroy();
  await worker.destroy();
}
