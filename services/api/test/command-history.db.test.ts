/**
 * Personal command history against a real PostgreSQL (layer-7 task C;
 * CMD-36, CMD-37, SEC-13, RULE-15, Section 30.2): kept only when the client
 * says the device is not shared; encrypted; readable by its owner alone,
 * not by another person of the same county, through the API or the rows;
 * cleared by its owner with a deletion-log entry and an audit record while
 * the executions stay; a legal hold stops both the clearing and the sweep;
 * the sweep deletes what is past 30 days; a plan nobody confirmed goes stale
 * and keeps only the digest of its free text. Runs on a county of its own,
 * only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import {
  FREE_TEXT_ARGS,
  staleAbandonedPlans,
  sweepCommandHistory,
} from '../../worker/src/jobs/commands.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { CATALOG } from '../src/commands/catalog.ts';
import { routesWith } from '../src/routes/index.ts';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Execution {
  id: string;
  executionId: string;
  status: string;
  planHash: string | null;
}
interface Item {
  role: string;
  text: string;
  executionId: string | null;
}

describe.skipIf(!appUrl || !workerUrl)('personal command history (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let countyPath = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const ctx = () => ({ db: dbWorker, log: silent }) as unknown as JobContext;

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID() },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const command = async (who: string, input: string, remember: boolean) =>
    (await call(who, 'POST', '/commands', { executionId: randomUUID(), input, remember }))
      .body as Execution;
  const history = async (who: string) =>
    (await call(who, 'GET', '/me/command-history')).body as Item[];
  const rowsAs = (accountId: string) =>
    withTenant(dbApp, { tenantId: county, tenantPath: countyPath, accountId }, (trx) =>
      trx.selectFrom('cg.command_message').select(['id', 'body_enc']).execute(),
    );

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-command-history-${run}`,
        name: `Exercise command history county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    countyPath = c.path;
    const as = (template: string): AccountSubject => {
      const t = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId: randomUUID(),
        tenantId: county,
        tenantPath: c.path,
        tenantKind: c.kind,
        status: 'active',
        roles: [
          {
            roleId: randomUUID(),
            key: t.key,
            version: 1,
            templateKey: t.key,
            grants: t.grants,
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects['ana'] = as('mass_care_coordinator');
    subjects['ben'] = as('mass_care_coordinator');
    subjects['admin'] = as('tenant_admin');
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
      routes: routesWith(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', county)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('CMD-37: the worker strips every free-text argument the catalog declares', () => {
    const declared = new Set(CATALOG.flatMap((c) => c.freeText ?? []));
    for (const k of declared) expect(FREE_TEXT_ARGS as readonly string[]).toContain(k);
  });

  it('CMD-36: nothing is kept unless the client says the device is not shared; kept history is encrypted and follows the command to its result', async () => {
    await command('ana', '/reminders', false);
    expect(await history('ana')).toEqual([]);
    const plan = await command('ana', '/remind in 30m Exercise: call the warming centre', true);
    expect(plan.status).toBe('awaiting_confirmation');
    const done = await call('ana', 'POST', `/commands/${plan.id}/confirm`, {
      planHash: plan.planHash,
    });
    expect((done.body as Execution).status).toBe('succeeded');
    const items = await history('ana');
    expect(items.map((i) => i.role)).toEqual(['person', 'window', 'window']);
    expect(items[0]!.text).toBe('/remind in 30m Exercise: call the warming centre');
    expect(items[1]!.text).toMatch(/^Plan: /);
    expect(items[2]!.text).toContain('warming centre');
    expect(items.every((i) => i.executionId === plan.executionId)).toBe(true);
    for (const r of await rowsAs(subjects['ana']!.accountId))
      expect(r.body_enc.toString('utf8')).not.toContain('warming');
  });

  it('CMD-36: history belongs to its owner alone, through the API and the rows, administrators included', async () => {
    expect(await history('ben')).toEqual([]);
    expect(await history('admin')).toEqual([]);
    expect(await rowsAs(subjects['ben']!.accountId)).toEqual([]);
    expect(await rowsAs(subjects['admin']!.accountId)).toEqual([]);
    expect((await rowsAs(subjects['ana']!.accountId)).length).toBe(3);
  });

  it('SEC-13: a legal hold stops clearing; RULE-15: clearing is logged and audited and the executions stay', async () => {
    const hold = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.legal_hold')
        .values({
          tenant_id: county,
          scope: JSON.stringify({ dataCategory: 'command_conversation' }),
          reason: 'Exercise: hold the command conversations',
          placed_by: subjects['admin']!.accountId,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const refused = await call('ana', 'DELETE', '/me/command-history');
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe('legal_hold');
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.legal_hold')
        .set({ released_at: new Date(), released_by: subjects['admin']!.accountId })
        .where('id', '=', hold.id)
        .execute(),
    );
    const cleared = await call('ana', 'DELETE', '/me/command-history');
    expect(cleared.body).toEqual({ cleared: 3 });
    expect(await history('ana')).toEqual([]);
    const logged = await dbWorker
      .selectFrom('cg.deletion_log')
      .select(['data_category', 'deleted_count'])
      .where('tenant_id', '=', county)
      .execute();
    expect(logged).toEqual([{ data_category: 'command_conversation', deleted_count: 3 }]);
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', county)
      .where('action', '=', 'command.history_cleared')
      .execute();
    expect(audited).toHaveLength(1);
    const executions = await dbWorker
      .selectFrom('cg.command_execution')
      .select('id')
      .where('tenant_id', '=', county)
      .execute();
    expect(executions.length).toBeGreaterThanOrEqual(2);
  });

  it('Section 30.2: the sweep deletes history past 30 days, not newer, and not under a hold', async () => {
    const ana = subjects['ana']!.accountId;
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
    const put = (days: number) =>
      withTenant(dbApp, { tenantId: county, tenantPath: countyPath, accountId: ana }, async (trx) =>
        trx
          .insertInto('cg.command_message')
          .values({
            tenant_id: county,
            account_id: ana,
            role: 'person',
            body_enc: await crypto.encrypt(county, `Exercise ${days} days ago`),
            execution_id: null,
            created_at: new Date(Date.now() - days * 86_400_000),
          })
          .execute(),
      );
    await put(40);
    await put(2);
    const hold = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.legal_hold')
        .values({
          tenant_id: county,
          scope: JSON.stringify({ targetType: 'command_message', targetId: ana }),
          reason: "Exercise: hold one person's commands",
          placed_by: subjects['admin']!.accountId,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await sweepCommandHistory(ctx());
    expect(await rowsAs(ana)).toHaveLength(2);
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.legal_hold')
        .set({ released_at: new Date(), released_by: subjects['admin']!.accountId })
        .where('id', '=', hold.id)
        .execute(),
    );
    await sweepCommandHistory(ctx());
    expect(await rowsAs(ana)).toHaveLength(1);
  });

  it('CMD-09, CMD-37: a plan nobody confirmed goes stale after 15 minutes and keeps only the digest of its free text', async () => {
    const plan = await command('ana', '/remind in 2h Exercise: private words', false);
    expect(plan.status).toBe('awaiting_confirmation');
    const later = {
      db: dbWorker,
      log: silent,
      now: () => new Date(Date.now() + 16 * 60_000),
    } as unknown as JobContext;
    expect(await staleAbandonedPlans(later)).toBeGreaterThanOrEqual(1);
    const row = await dbWorker
      .selectFrom('cg.command_execution')
      .select(['state', 'plan'])
      .where('id', '=', plan.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('stale');
    expect(JSON.stringify(row.plan)).not.toContain('private words');
    const confirm = await call('ana', 'POST', `/commands/${plan.id}/confirm`, {
      planHash: plan.planHash,
    });
    expect((confirm.body as Execution).status).toBe('stale');
  });
});
