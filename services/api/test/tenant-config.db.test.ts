/**
 * A tenant's settings are read for that tenant only (SEC-01, ADM-05 G1). The
 * worker runs as the system role, which row security lets see every tenant,
 * and agreement readers see more than one: a setting must still come from the
 * tenant in context, never from whichever row the database returns first (a
 * resident's text once could have carried another county's help line).
 * Runs only with API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { configValue } from '../src/public/submit.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!workerUrl)('tenant settings stay with their tenant (database-backed)', () => {
  let db: Kysely<Database>;
  const run = randomUUID().slice(0, 8);
  const counties: string[] = [];

  beforeAll(async () => {
    db = createDb(workerUrl!, 2);
    const seeded = await loadSeed(db);
    for (const [i, phone] of ['(314) 555-0101', '(314) 555-0202'].entries()) {
      const c = await db
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-config-${i}-${run}`,
          name: `Exercise config county ${i} ${run}`,
          status: 'provisioning',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      counties.push(c.id);
      await withTenant(db, { tenantId: c.id }, (trx) =>
        trx
          .insertInto('cg.tenant_config')
          .values({ tenant_id: c.id, key: 'intake.help_phone', value: JSON.stringify(phone) })
          .execute(),
      );
    }
  });

  afterAll(async () => {
    await db
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', 'in', counties)
      .execute();
    await db?.destroy();
  });

  it('as the system role, each county reads its own help line', async () => {
    const read = (tenantId: string) =>
      withTenant(db, { tenantId }, (trx) => configValue<string>(trx, 'intake.help_phone'));
    expect(await read(counties[0]!)).toBe('(314) 555-0101');
    expect(await read(counties[1]!)).toBe('(314) 555-0202');
  });
});
