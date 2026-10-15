/**
 * Live translation in the field against a real PostgreSQL (layer-7 task H;
 * FL-14, FL:FR-24, AI-10, AIG-01). Off until the register enables it; then a
 * general turn comes back labelled with its provider and model, and only the
 * call's record is kept (languages, outcome, model; never the words).
 * Consent, legal and medical conversations are refused with a pointer to a
 * human interpreter; a shelter nurse has no machine translation. Runs only
 * with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { fakeProvider, type AiProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

/** A translator that marks its output, so the test can tell it ran. */
const marking: AiProvider = {
  ...fakeProvider,
  translation: {
    translate: async (text, to) => ({
      output: { text: `[${to}] ${text}` },
      provider: fakeProvider.info,
      latencyMs: 1,
    }),
  },
};

describe.skipIf(!appUrl || !workerUrl)('live translation (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};

  const translate = async (who: string, body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/translations',
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID() },
      payload: { from: 'en', to: 'es', ...body },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-translation-${run}`,
        name: `Exercise translation county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'field.translation',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'One turn of a general conversation',
          decision_informed: 'A labelled translation',
          human_checkpoint: 'An interpreter one tap away',
          owner: 'Equity lead',
          evaluation: JSON.stringify({}),
          enabled: false,
        })
        .execute(),
    );
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
    subjects['worker'] = as('shelter_worker');
    subjects['nurse'] = as('shelter_nurse');
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
      subjects: loader,
      // The deterministic fake stands in for OpenAI here (tests only, ADR-0043).
      routes: routesWith({ drafting: { ai: { providerFor: async () => marking } } }),
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

  it('FL-14, AI-10: off until enabled, and it says to ask for an interpreter', async () => {
    const off = await translate('worker', { text: 'We have water and cots.' });
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ code: 'ai_off' });
    expect(String(off.body['message'])).toContain('interpreter');
  });

  it('FL-14, AIG-01: a general turn comes back labelled; only the call is recorded, never the words', async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.ai_use_register')
        .set({ enabled: true })
        .where('tenant_id', '=', county)
        .where('feature', '=', 'field.translation')
        .execute(),
    );
    const ok = await translate('worker', { text: 'We have water and cots.' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      text: '[es] We have water and cots.',
      from: 'en',
      to: 'es',
      provider: 'fake',
    });
    const back = await translate('worker', { text: 'Necesito pañales.', from: 'es', to: 'en' });
    expect(back.body['text']).toBe('[en] Necesito pañales.');
    const records = await dbWorker
      .selectFrom('cg.ai_output')
      .selectAll()
      .where('tenant_id', '=', county)
      .where('feature', '=', 'field.translation')
      .execute();
    expect(records.map((r) => [r.outcome, r.language])).toEqual(
      expect.arrayContaining([
        ['ok', 'es'],
        ['ok', 'en'],
      ]),
    );
    expect(JSON.stringify(records)).not.toContain('cots');
    expect(JSON.stringify(records)).not.toContain('pañales');
  });

  it('FL-14: consent, legal and medical go to a human interpreter; a nurse has no machine translation', async () => {
    for (const topic of ['consent', 'legal', 'medical']) {
      const r = await translate('worker', { text: 'Do you agree?', topic });
      expect(r.status).toBe(409);
      expect(r.body['code']).toBe('human_interpreter');
    }
    expect((await translate('nurse', { text: 'Hello' })).status).toBe(403);
    expect((await translate('worker', { text: 'Hello', from: 'es', to: 'es' })).status).toBe(400);
  });
});
