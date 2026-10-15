/**
 * The audit chain under concurrent writers (BRD:FR-08.04, SEC-18, ADR-0012,
 * migration 0040): many transactions in one tenant write audit rows at once,
 * each holding its transaction open a moment, as the API and the worker do.
 * The tenant's chain must still verify. Before 0040 the sequence number was
 * taken before the chain lock, so concurrent writers could chain in the
 * opposite order to their numbers and the verifier reported a break.
 *
 * Audit rows are written just before commit (`beforeCommit`), so a
 * transaction locks its rows before the chain: one that audits and then
 * writes a row no longer deadlocks with one that wrote that row and then
 * audits (CI run 38698603482). They keep the order they were recorded in,
 * and a failed transaction writes none.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit, verifyChain } from '@cg/audit';
import { createDb, withTenant, type Database } from '@cg/db';
import { sql, type Kysely, type Transaction } from 'kysely';

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

  const audit = (trx: Transaction<Database>, action: string, targetId = 'row') =>
    recordAudit(trx, {
      tenantId,
      actorKind: 'system',
      action,
      targetType: 'test',
      targetId,
    });
  const actions = async (targetId: string) =>
    (
      await db
        .selectFrom('cg.audit_event')
        .select('action')
        .where('tenant_id', '=', tenantId)
        .where('target_id', '=', targetId)
        .orderBy('seq')
        .execute()
    ).map((r) => r.action);

  it('BRD:FR-08.04: auditing first and then writing a row does not deadlock with the other order', async () => {
    const key = `exercise.lock_order.${randomUUID().slice(0, 8)}`;
    await db
      .insertInto('cg.tenant_config')
      .values({ tenant_id: tenantId, key, value: JSON.stringify(0) })
      .execute();
    const target = `lock-${key}`;
    let go!: () => void;
    const audited = new Promise<void>((r) => (go = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    // The worker's order: the row, then the audit row.
    const rowFirst = withTenant(db, { tenantId }, async (trx) => {
      await trx
        .updateTable('cg.tenant_config')
        .set({ value: JSON.stringify(1) })
        .where('tenant_id', '=', tenantId)
        .where('key', '=', key)
        .execute();
      locked();
      await audited;
      await audit(trx, 'exercise.row_first', target);
    });
    await holding;
    // The order that deadlocked: the audit row, then the row.
    const auditFirst = withTenant(db, { tenantId }, async (trx) => {
      await audit(trx, 'exercise.audit_first', target);
      go();
      await trx
        .updateTable('cg.tenant_config')
        .set({ value: JSON.stringify(2) })
        .where('tenant_id', '=', tenantId)
        .where('key', '=', key)
        .execute();
    });
    await Promise.all([rowFirst, auditFirst]);
    // The second writer waited for the first; each audit row follows its own rows.
    expect(await actions(target)).toEqual(['exercise.row_first', 'exercise.audit_first']);
    expect((await verifyChain(db, tenantId)).ok).toBe(true);
  });

  it('BRD:FR-08.04: audit rows keep the order they were recorded in; a failed transaction writes none', async () => {
    const target = `order-${randomUUID().slice(0, 8)}`;
    await withTenant(db, { tenantId }, async (trx) => {
      for (const n of ['one', 'two', 'three']) await audit(trx, `exercise.${n}`, target);
      // Not written yet: the rows wait for the transaction's own work.
      expect(
        await trx
          .selectFrom('cg.audit_event')
          .select('seq')
          .where('target_id', '=', target)
          .execute(),
      ).toEqual([]);
    });
    expect(await actions(target)).toEqual(['exercise.one', 'exercise.two', 'exercise.three']);
    const failed = `failed-${target}`;
    await expect(
      withTenant(db, { tenantId }, async (trx) => {
        await audit(trx, 'exercise.never', failed);
        throw new Error('exercise: the business write failed');
      }),
    ).rejects.toThrow('exercise: the business write failed');
    expect(await actions(failed)).toEqual([]);
    // Outside withTenant the row is written at once.
    await db.transaction().execute(async (trx) => {
      await audit(trx, 'exercise.plain', `plain-${target}`);
      expect(
        await trx
          .selectFrom('cg.audit_event')
          .select('action')
          .where('target_id', '=', `plain-${target}`)
          .execute(),
      ).toHaveLength(1);
    });
  });
});
