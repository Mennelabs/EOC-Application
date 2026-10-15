/**
 * Approving a permission change while another transaction holds the same
 * row (ADM-05 G6, BRD:FR-08.04, migration 0040). Every audit row takes the
 * tenant's chain lock until commit, so a transaction that audits and then
 * locks a row deadlocks with one that locked the row and then audits. The
 * worker's account.invited job (services/worker/src/jobs/handlers.ts) sets
 * the account's idp_subject, a unique key, and then audits; the approval
 * that assigns that account a role checks the same row. CI run 38698603482
 * lost an onboarding approval to that deadlock (a 500). Each case holds the
 * other transaction's row lock, waits until the approval is blocked behind
 * it, then lets it audit: both must commit. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely, type Transaction } from 'kysely';
import { recordAudit, verifyChain } from '@cg/audit';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)(
  'permission changes under concurrency (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let county = '';
    let roleId = '';
    const run = randomUUID().slice(0, 8);
    const slug = `exercise-perm-${run}`;
    const people: Record<string, string> = {};

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 3);
      const region = await dbWorker
        .selectFrom('cg.tenant')
        .select('id')
        .where('kind', '=', 'region')
        .executeTakeFirstOrThrow();
      const c = await dbWorker
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: region.id,
          slug,
          name: `Exercise permissions county ${run}`,
          status: 'provisioning',
        })
        .returning(['id', 'path', 'kind'])
        .executeTakeFirstOrThrow();
      county = c.id;
      await withTenant(dbWorker, { tenantId: county }, async (trx) => {
        for (const [who, status] of [
          ['admin', 'active'],
          ['security', 'active'],
          ['newcomer', 'invited'],
        ] as const)
          people[who] = (
            await trx
              .insertInto('cg.account')
              .values({
                tenant_id: county,
                email: `${who}-${run}@example.org`,
                display_name: `Exercise ${who}`,
                status,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        const template = roleTemplates.find((t) => t.key === 'reporting_planning')!;
        roleId = (
          await trx
            .insertInto('cg.role')
            .values({
              tenant_id: county,
              key: template.key,
              name: template.name,
              template_key: template.key,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        for (const version of [1, 2])
          await trx
            .insertInto('cg.role_version')
            .values({
              tenant_id: county,
              role_id: roleId,
              version,
              grants: JSON.stringify(template.grants),
            })
            .execute();
      });

      const subject = (template: string, accountId: string): AccountSubject => {
        const r = roleTemplates.find((x) => x.key === template)!;
        return {
          kind: 'account',
          accountId,
          tenantId: c.id,
          tenantPath: c.path as string,
          tenantKind: c.kind,
          status: 'active',
          roles: [
            {
              roleId: randomUUID(),
              key: r.key,
              version: 1,
              templateKey: r.key,
              grants: r.grants,
              scope: {},
            },
          ],
          resolvedAt: new Date(),
        };
      };
      const subjects: Record<string, AccountSubject> = {
        admin: subject('tenant_admin', people['admin']!),
        security: subject('security_admin', people['security']!),
      };
      const loader: SubjectLoader = {
        async fromBearer(token) {
          const s = subjects[token];
          if (!s) throw new AuthError('invalid_token');
          return s;
        },
      };
      app = await buildApp({
        productName: 'Test Product',
        version: '0.0.0',
        dataMode: 'synthetic',
        logLevel: 'silent',
        probes: [],
        db: dbApp,
        fieldCrypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
        subjects: loader,
        routes: routesWith({}),
      });
    });

    afterAll(async () => {
      await app?.close();
      await dbWorker
        ?.updateTable('cg.tenant')
        .set({ status: 'closed' })
        .where('slug', '=', slug)
        .execute();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    const call = async (
      who: string,
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...headers },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };

    const ask = async (body: Record<string, unknown>) => {
      const asked = await call('admin', '/permission-changes', body);
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      return asked.body as { id: string; version: number };
    };

    const approve = (cr: { id: string; version: number }) =>
      call('security', `/permission-changes/${cr.id}/approve`, undefined, {
        'if-match': `"${cr.version}"`,
        'x-confirm': 'true',
        'x-reason': 'Exercise: second administrator approves',
      });

    /** Until a backend waits on a row lock (the approval, behind `holder`). */
    async function blocked(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const { rows } = await sql<{
          n: number;
        }>`select count(*)::int as n from pg_locks where not granted`.execute(dbWorker);
        if (rows[0]!.n > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the approval never waited on the held row');
    }

    /**
     * Another transaction locks a row, waits for `go`, then audits, in the
     * order the worker's jobs and the API's other writes use.
     */
    function holder(lock: (trx: Transaction<Database>) => Promise<unknown>) {
      let go!: () => void;
      const released = new Promise<void>((r) => (go = r));
      let locked!: () => void;
      const holding = new Promise<void>((r) => (locked = r));
      const done = withTenant(dbWorker, { tenantId: county }, async (trx) => {
        await lock(trx);
        locked();
        await released;
        await recordAudit(trx, {
          tenantId: county,
          actorKind: 'system',
          actorAccountId: null,
          action: 'exercise.row_then_audit',
          targetType: 'test',
          targetId: run,
          reason: 'job:exercise',
        });
      });
      return { holding, go, done };
    }

    it('ADM-05: a role is assigned while the worker links the account to its identity', async () => {
      const cr = await ask({
        kind: 'assign_role',
        accountId: people['newcomer'],
        roleId,
        scope: {},
      });
      // account.invited: idp_subject is a unique key, so the row is locked FOR UPDATE.
      const worker = holder((trx) =>
        trx
          .updateTable('cg.account')
          .set({ idp_subject: `exercise-idp-${run}` })
          .where('id', '=', people['newcomer']!)
          .execute(),
      );
      await worker.holding;
      const approving = approve(cr);
      await blocked();
      worker.go();
      const [approved] = await Promise.all([approving, worker.done]);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body['status']).toBe('applied');
      const assigned = await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .selectFrom('cg.role_assignment')
          .select(['account_id', 'approved_by'])
          .where('change_request_id', '=', cr.id)
          .executeTakeFirstOrThrow(),
      );
      expect(assigned).toEqual({
        account_id: people['newcomer'],
        approved_by: people['security'],
      });
    });

    it('ADM-04: a role version is published while another administrator edits the role', async () => {
      const cr = await ask({ kind: 'publish_role_version', roleId, version: 2 });
      const editor = holder((trx) =>
        trx
          .updateTable('cg.role')
          .set({ description: `Exercise edit ${run}` })
          .where('id', '=', roleId)
          .execute(),
      );
      await editor.holding;
      const approving = approve(cr);
      await blocked();
      editor.go();
      const [approved] = await Promise.all([approving, editor.done]);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const role = await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .selectFrom('cg.role')
          .select(['current_version', 'description'])
          .where('id', '=', roleId)
          .executeTakeFirstOrThrow(),
      );
      expect(role).toEqual({ current_version: 2, description: `Exercise edit ${run}` });
    });

    it('BRD:FR-08.04: the decisions, the changes they applied and the other writers chain in order', async () => {
      const audit = await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .selectFrom('cg.audit_event')
          .select('action')
          .where('tenant_id', '=', county)
          .orderBy('seq')
          .execute(),
      );
      expect(audit.map((a) => a.action)).toEqual([
        'permission_change.request',
        'exercise.row_then_audit',
        'permission_change.approve',
        'role_assignment.create',
        'permission_change.request',
        'exercise.row_then_audit',
        'permission_change.approve',
        'role.publish',
      ]);
      expect((await verifyChain(dbWorker, county)).ok).toBe(true);
    });
  },
);
