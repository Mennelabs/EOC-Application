/**
 * The AI use register against a real PostgreSQL (layer-7 task A; AIG-01,
 * AIG-06, AIG-08, ADR-0043): a new tenant lists OpenAI with every feature off
 * and unevaluated; a feature cannot be enabled before its provider passed the
 * evaluation for the tenant's languages; the evaluation is queued only when a
 * provider is configured, runs in the worker and is recorded and audited; then
 * an administrator can enable a feature, with a reason. Runs on a county of
 * its own, with the test double standing in for the provider.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { fakeProvider, openAIDescriptor, registerProvider, unregisterProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { ensureAiRegister } from '../../../packages/provisioning/src/index.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { aiEvaluate } from '../../worker/src/jobs/ai-evaluate.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)('the AI use register (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const confirm = { 'x-confirm': 'true', 'x-reason': 'Exercise: evaluate before enabling' };

  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: 'Bearer admin', 'idempotency-key': randomUUID(), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  const register = async () =>
    (await call('GET', '/ai-register')).body as unknown as {
      feature: string;
      provider: string;
      enabled: boolean;
      version: number;
      evaluation: { passed?: boolean };
    }[];

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-ai-register-${run}`,
        name: `Exercise AI register county ${run}`,
        status: 'provisioning',
        locales: ['en', 'es'],
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      ensureAiRegister(trx, county, openAIDescriptor(), null),
    );
    const t = roleTemplates.find((x) => x.key === 'tenant_admin')!;
    const admin: AccountSubject = {
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
    const loader: SubjectLoader = {
      async fromBearer(token) {
        if (token !== 'admin') throw new AuthError('invalid_token');
        return admin;
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
    unregisterProvider('fake');
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', county)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('ADR-0043, AIG-08: a new tenant lists OpenAI with every feature off; nothing is enabled or evaluated without a configured provider', async () => {
    const rows = await register();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ provider: 'openai', enabled: false });
    const extraction = rows.find((r) => r.feature === 'intake.extraction')!;
    const enable = await call(
      'PATCH',
      '/ai-register/intake.extraction',
      { enabled: true },
      { 'if-match': `"${extraction.version}"`, ...confirm },
    );
    expect(enable.status).toBe(409);
    expect((enable.body['details'] as { reasons: string[] }).reasons).toEqual([
      'provider_not_configured',
    ]);
    expect((await call('POST', '/ai-register/evaluate', undefined, confirm)).status).toBe(409);
  });

  it('AIG-08: with a provider, the evaluation is confirmed, queued, run in the worker and recorded; then a feature can be enabled', async () => {
    // The test double stands in for the configured provider for this tenant only.
    registerProvider(fakeProvider);
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'ai.provider', value: JSON.stringify('fake') })
        .execute();
      await trx
        .updateTable('cg.ai_use_register')
        .set({ provider: 'fake', model: 'keyword-rules' })
        .where('tenant_id', '=', county)
        .execute();
    });
    expect((await call('POST', '/ai-register/evaluate')).status).toBe(428);
    const queued = await call('POST', '/ai-register/evaluate', undefined, confirm);
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const msg = await dbWorker
      .selectFrom('cg.outbox')
      .select(['id', 'execution_id', 'payload'])
      .where('tenant_id', '=', county)
      .where('topic', '=', 'ai.evaluate')
      .executeTakeFirstOrThrow();
    const ctx = {
      db: dbWorker,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      ai: { providerFor: async () => fakeProvider },
    } as unknown as JobContext;
    await aiEvaluate(ctx, {
      id: Number(msg.id),
      tenantId: county,
      topic: 'ai.evaluate',
      payload: msg.payload as Record<string, unknown>,
      executionId: msg.execution_id,
    });
    const rows = await register();
    for (const r of rows) expect(r.evaluation).toMatchObject({ passed: true });
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', county)
      .execute();
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining(['ai_register.evaluate_requested', 'ai_register.evaluate']),
    );
    // Evaluated for English and Spanish: an administrator enables extraction, with a reason.
    const extraction = rows.find((r) => r.feature === 'intake.extraction')!;
    const enabled = await call(
      'PATCH',
      '/ai-register/intake.extraction',
      { enabled: true },
      { 'if-match': `"${extraction.version}"`, ...confirm },
    );
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body['enabled']).toBe(true);
  });
});
