/**
 * The audit chain under concurrent writers (BRD:FR-08.04, SEC-18, ADR-0012,
 * migration 0040): many transactions in one tenant write audit rows at once,
 * each holding its transaction open a moment, as the API and the worker do.
 * The tenant's chain must still verify. Before 0040 the sequence number was
 * taken before the chain lock, so concurrent writers could chain in the
 * opposite order to their numbers and the verifier reported a break.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '@cg/audit';
import { createDb, type Database } from '@cg/db';
import { sql, type Kysely } from 'kysely';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!workerUrl)('audit chain under concurrency (database-backed)', () => {
  let db: Kysely<Database>;
  let tenantId = '';

  beforeAll(async () => {
    db = createDb(workerUrl!, 24);
    const parent = await db
      .selectFrom('cg.tenant')
      .select('id')
      .where('kind', '=', 'county')
      .executeTakeFirstOrThrow();
    // A tenant of its own, so the verdict covers only this suite's rows.
    const run = randomUUID().slice(0, 8);
    tenantId = (
      await db
        .insertInto('cg.tenant')
        .values({
          kind: 'partner_org',
          parent_id: parent.id,
          slug: `exercise-audit-${run}`,
          name: `Exercise audit chain test ${run}`,
          status: 'provisioning',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('BRD:FR-08.04: forty concurrent writers in one tenant leave a chain that verifies', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        db.transaction().execute(async (trx) => {
          await trx
            .insertInto('cg.audit_event')
            .values({
              tenant_id: tenantId,
              actor_kind: 'system',
              action: 'exercise.audit_chain',
              target_type: 'test',
              target_id: String(i),
            })
            .execute();
          // Hold the transaction (and the chain lock) open, as a request does.
          await sql`select pg_sleep(0.01)`.execute(trx);
        }),
      ),
    );
    const result = await verifyChain(db, tenantId);
    expect(result).toEqual({ ok: true, checked: 40, firstBadSeq: null });
  });
});
