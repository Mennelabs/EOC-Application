/**
 * Permission sweep over every staff API route (GATE-04, SEC-01, ADM-05 G1:
 * default deny with server-side checks). Every route registered under
 * /api/v1 is called twice: without a token, and by a signed-in account of a
 * county that holds no role at all. Neither may ever get a success, and no
 * route may fail with a server error on the way to saying no. A route that
 * is deliberately open to any signed-in account is listed below with its
 * reason, so a new route cannot be open by accident. The calls carry no
 * body, so a route that validates its body first answers 400 before reading
 * anything; the per-feature suites cover those routes with real bodies. An
 * administrator through the same harness gets a success, so a harness that
 * refused everything would fail. Runs on a county of its own, only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { createDb, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

/**
 * Routes any signed-in account may use with no role, and why. Everything else
 * must refuse an account that holds nothing.
 */
const OPEN_TO_ANY_ACCOUNT: Record<string, string> = {};

describe.skipIf(!appUrl || !workerUrl)('permission sweep (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const routes: { method: string; url: string }[] = [];
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-sweep-${run}`,
        name: `Exercise sweep county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const nobody: AccountSubject = {
      kind: 'account',
      accountId: randomUUID(),
      tenantId: county,
      tenantPath: c.path,
      tenantKind: c.kind,
      status: 'active',
      roles: [],
      resolvedAt: new Date(),
    };
    const t = roleTemplates.find((x) => x.key === 'tenant_admin')!;
    const admin: AccountSubject = {
      ...nobody,
      accountId: randomUUID(),
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
    };
    const loader: SubjectLoader = {
      async fromBearer(token) {
        if (token === 'nobody') return nobody;
        if (token === 'admin') return admin;
        throw new AuthError('invalid_token');
      },
    };
    // One plugin holds every staff route, so its onRoute hook sees them all.
    const all: FastifyPluginAsync = async (scope) => {
      scope.addHook('onRoute', (r) => {
        for (const method of [r.method].flat())
          if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: r.url });
      });
      for (const plugin of routesWith()) await scope.register(plugin);
    };
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      subjects: loader,
      routes: [all],
    });
    await app.ready();
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

  /** The route with its parameters filled by fresh identifiers. */
  const concrete = (url: string) =>
    url.replace(/:[A-Za-z0-9_]+/g, () => randomUUID()).replace(/\*/g, 'x');

  const call = (method: string, url: string, token?: string) =>
    app.inject({
      method: method as 'GET',
      url: concrete(url),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'idempotency-key': randomUUID(),
        'if-match': '"1"',
        'x-confirm': 'true',
        'x-reason': 'Exercise: permission sweep.',
      },
      ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
    });

  it('finds the staff routes, and an administrator gets through the same harness', async () => {
    expect(routes.length).toBeGreaterThan(300);
    for (const url of ['/api/v1/ai-register', '/api/v1/roles', '/api/v1/events'])
      expect((await call('GET', url, 'admin')).statusCode, url).toBe(200);
  });

  it('GATE-04: without a token, no staff route succeeds or fails with a server error', async () => {
    const bad: string[] = [];
    for (const r of routes) {
      const res = await call(r.method, r.url);
      if (res.statusCode < 400 || res.statusCode >= 500)
        bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('GATE-04, ADM-05 G1: an account holding no role gets no success from any staff route but those listed open', async () => {
    const bad: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      const res = await call(r.method, r.url, 'nobody');
      if (res.statusCode >= 500) bad.push(`${key} → ${res.statusCode} ${res.body.slice(0, 120)}`);
      else if (res.statusCode < 400 && !(key in OPEN_TO_ANY_ACCOUNT))
        bad.push(`${key} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('every route listed open still exists', () => {
    const keys = new Set(routes.map((r) => `${r.method} ${r.url}`));
    expect(Object.keys(OPEN_TO_ANY_ACCOUNT).filter((k) => !keys.has(k))).toEqual([]);
  });
});
