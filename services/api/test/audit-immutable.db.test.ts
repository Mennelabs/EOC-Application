/**
 * Nobody can edit or delete an audit record (ADM-05, BRD:FR-08.03,
 * BRD:FR-08.04, SEC-18), and a mission's timeline keeps every entry
 * (FR-07.01, AC-07A): manual entries are added, never changed. Tried as the
 * application role (inside its tenant) and as the worker role (which passes
 * every row-security policy): an update, a delete or a truncate of the audit
 * table is refused by the database, and a timeline entry cannot be changed
 * or removed. The tenant's chain still verifies afterwards. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { recordAudit, verifyChain } from '@cg/audit';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)(
  'audit and timeline records cannot be changed (database-backed)',
  () => {
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let county = '';
    let auditTarget = '';

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 2);
      dbWorker = createDb(workerUrl!, 2);
      county = (await loadSeed(dbWorker)).tenants['county']!;
      auditTarget = randomUUID();
      await withTenant(dbApp, { tenantId: county }, (trx) =>
        recordAudit(trx, {
          tenantId: county,
          actorKind: 'system',
          action: 'exercise.immutability_probe',
          targetType: 'exercise',
          targetId: auditTarget,
          reason: 'Exercise: a record to try to change',
        }),
      );
    });

    afterAll(async () => {
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    const refused = async (attempt: () => Promise<unknown>) => {
      let error: unknown = null;
      try {
        await attempt();
      } catch (e) {
        error = e;
      }
      expect(error, 'the database refused it').not.toBeNull();
      expect(String((error as { code?: string }).code)).toBe('42501');
    };

    it('ADM-05, BRD:FR-08.04: an audit record cannot be updated, deleted or truncated by either role', async () => {
      for (const db of [dbApp, dbWorker]) {
        await refused(() =>
          withTenant(db, { tenantId: county }, (trx) =>
            trx
              .updateTable('cg.audit_event')
              .set({ reason: 'rewritten' })
              .where('target_id', '=', auditTarget)
              .execute(),
          ),
        );
        await refused(() =>
          withTenant(db, { tenantId: county }, (trx) =>
            trx.deleteFrom('cg.audit_event').where('target_id', '=', auditTarget).execute(),
          ),
        );
        await refused(() =>
          withTenant(db, { tenantId: county }, (trx) => sql`truncate cg.audit_event`.execute(trx)),
        );
      }
      const row = await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .selectFrom('cg.audit_event')
          .select(['reason'])
          .where('target_id', '=', auditTarget)
          .executeTakeFirstOrThrow(),
      );
      expect(row.reason).toBe('Exercise: a record to try to change');
      expect((await verifyChain(dbWorker, county)).ok).toBe(true);
    });

    it('BRD:FR-08.03, FR-07.01: a mission timeline entry is added, never changed or removed', async () => {
      const entry = await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .selectFrom('cg.mission_event')
          .select(['id', 'body', 'kind'])
          .where('tenant_id', '=', county)
          .orderBy('created_at')
          .executeTakeFirstOrThrow(),
      );
      for (const db of [dbApp, dbWorker]) {
        const changed = await withTenant(db, { tenantId: county }, (trx) =>
          trx
            .updateTable('cg.mission_event')
            .set({ body: 'rewritten' })
            .where('id', '=', entry.id)
            .executeTakeFirst(),
        );
        expect(Number(changed.numUpdatedRows)).toBe(0);
        const removed = await withTenant(db, { tenantId: county }, (trx) =>
          trx.deleteFrom('cg.mission_event').where('id', '=', entry.id).executeTakeFirst(),
        );
        expect(Number(removed.numDeletedRows)).toBe(0);
      }
      const after = await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .selectFrom('cg.mission_event')
          .select(['body', 'kind'])
          .where('id', '=', entry.id)
          .executeTakeFirstOrThrow(),
      );
      expect(after).toEqual({ body: entry.body, kind: entry.kind });
    });
  },
);
