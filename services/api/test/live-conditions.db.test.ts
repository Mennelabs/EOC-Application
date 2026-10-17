/**
 * Live conditions (CON-14; layer-8 plan §6; SEC-18), against the database:
 * the county's feeds are added and switched on or off by those who manage
 * them, fed by file import when there is no feed, and their items are
 * listed with source, age and staleness; staff enter an override and clear
 * it; a feed item is never cleared by hand; a reader without the grant gets
 * nothing. Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { recordingsDir } from '@cg/refdata';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Source {
  id: string;
  version: number;
  kind: string;
  enabled: boolean;
  lastStatus: string;
  lastCount: number | null;
  activeItems: number;
  upserted?: number;
  cleared?: number;
  skipped?: number;
  code?: string;
}
interface Condition {
  id: string;
  version: number;
  kind: string;
  summary: string;
  severity: string;
  position: { lat: number; lon: number } | null;
  ageSeconds: number;
  stale: boolean;
  active: boolean;
  override: boolean;
  source: { id: string | null; name: string; kind: string };
  enteredBy: string | null;
  clearedAt: string | null;
  code?: string;
}

describe.skipIf(!appUrl || !workerUrl)('live conditions (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-live-api-${run}`;
  const subjects: Record<string, AccountSubject> = {};

  const call = async <T>(
    who: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T };
  };
  const feed = (file: string) =>
    JSON.parse(readFileSync(join(recordingsDir, file), 'utf8')) as unknown;

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise live county ${run}`,
        status: 'active',
        locales: ['en', 'es'],
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const people: Record<string, string> = {};
    const cast = [
      ['director', 'county_em_director', 'Exercise EM Director'],
      ['dispatcher', 'dispatcher_call_taker', 'Exercise Dispatcher'],
      ['pio', 'public_information_officer', 'Exercise PIO'],
      ['nurse', 'shelter_nurse', 'Exercise Nurse'],
    ] as const;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      for (const [who, , name] of cast)
        people[who] = (
          await trx
            .insertInto('cg.account')
            .values({
              tenant_id: county,
              email: `${who}-${run}@example.org`,
              display_name: name,
              status: 'active',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
    });
    for (const [who, template] of cast) {
      const r = roleTemplates.find((x) => x.key === template)!;
      subjects[who] = {
        kind: 'account',
        accountId: people[who]!,
        tenantId: county,
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
    }
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

  let wzdx: Source;

  it('the director adds a feed and a file source; a dispatcher reads them but cannot manage; an address must be https', async () => {
    const added = await call<Source>('director', 'POST', '/live-sources', {
      kind: 'wzdx',
      name: 'EXERCISE State DOT',
      url: 'https://wzdx.exercise-dot.example/api/wzdx/v4/feed.geojson',
      enabled: true,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    wzdx = added.body;
    expect(wzdx).toMatchObject({
      kind: 'wzdx',
      enabled: true,
      lastStatus: 'never',
      activeItems: 0,
    });
    expect(
      (
        await call('director', 'POST', '/live-sources', {
          kind: 'waze',
          name: 'x',
          url: 'http://plain.example/feed',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('director', 'POST', '/live-sources', {
          kind: 'file',
          name: 'x',
          url: 'https://a.example/f',
        })
      ).status,
    ).toBe(400);
    const file = await call<Source>('director', 'POST', '/live-sources', {
      kind: 'file',
      name: 'Utility file',
    });
    expect(file.status).toBe(201);
    expect((await call<Source[]>('dispatcher', 'GET', '/live-sources')).body).toHaveLength(2);
    expect(
      (
        await call('dispatcher', 'POST', '/live-sources', {
          kind: 'wzdx',
          name: 'no',
          url: 'https://x.example/f',
        })
      ).status,
    ).toBe(403);
    expect((await call('nurse', 'GET', '/live-sources')).status).toBe(403);
    // The pull is queued for the worker; the worker's recorded feeds are tested in services/worker.
    const outbox = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.outbox')
        .select('topic')
        .where('tenant_id', '=', county)
        .where('topic', '=', 'live.pull')
        .execute(),
    );
    expect(outbox.length).toBeGreaterThanOrEqual(1);
  });

  it('file import applies the feed at once; items list with source, age and staleness', async () => {
    const imported = await call<Source>('director', 'POST', `/live-sources/${wzdx.id}/import`, {
      document: feed('wzdx-exercise-westwind.json'),
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body).toMatchObject({
      upserted: 3,
      cleared: 0,
      skipped: 0,
      lastStatus: 'ok',
      activeItems: 3,
    });
    const list = await call<Condition[]>('dispatcher', 'GET', '/live-conditions');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3);
    const closed = list.body.find((c) => c.summary.startsWith('Closed on Commercial Row'))!;
    expect(closed).toMatchObject({
      kind: 'road_closure',
      severity: 'major',
      override: false,
      active: true,
      source: { id: wzdx.id, name: 'EXERCISE State DOT', kind: 'wzdx' },
    });
    expect(closed.position).not.toBeNull();
    // The recorded feed is dated 2026-10-15: old by now, but the source was just pulled, so not stale.
    expect(closed.ageSeconds).toBeGreaterThan(3600);
    expect(closed.stale).toBe(false);
    // Importing a smaller document clears what it dropped.
    const again = await call<Source>('director', 'POST', `/live-sources/${wzdx.id}/import`, {
      document: {
        type: 'FeatureCollection',
        features: (feed('wzdx-exercise-westwind.json') as { features: unknown[] }).features.slice(
          0,
          1,
        ),
      },
    });
    expect(again.body).toMatchObject({ upserted: 1, cleared: 2, activeItems: 1 });
    expect((await call<Condition[]>('dispatcher', 'GET', '/live-conditions')).body).toHaveLength(1);
    expect(
      (await call<Condition[]>('dispatcher', 'GET', '/live-conditions?includeCleared=true')).body,
    ).toHaveLength(3);
    // A feed item cannot be cleared by hand.
    const item = (await call<Condition[]>('dispatcher', 'GET', '/live-conditions')).body[0]!;
    const refused = await call<Condition>(
      'dispatcher',
      'POST',
      `/live-conditions/${item.id}/clear`,
      undefined,
      {
        'if-match': `"${item.version}"`,
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('feed_item');
  });

  it('staff enter an override with a point, and clear it; the PIO reads, never writes', async () => {
    const entered = await call<Condition>('dispatcher', 'POST', '/live-conditions', {
      kind: 'road_closure',
      summary: 'Elm St closed at the creek: water over the road (exercise)',
      road: 'Elm St',
      severity: 'major',
      position: { lat: 38.79, lon: -90.9 },
    });
    expect(entered.status, JSON.stringify(entered.body)).toBe(201);
    expect(entered.body).toMatchObject({
      override: true,
      active: true,
      stale: false,
      ageSeconds: 0,
      source: { id: null, name: 'Staff entry', kind: 'staff' },
      enteredBy: 'Exercise Dispatcher',
      position: { lat: 38.79, lon: -90.9 },
    });
    expect((await call('pio', 'GET', '/live-conditions')).status).toBe(200);
    expect(
      (
        await call('pio', 'POST', '/live-conditions', {
          kind: 'hazard',
          summary: 'Not mine to enter',
        })
      ).status,
    ).toBe(403);
    const cleared = await call<Condition>(
      'dispatcher',
      'POST',
      `/live-conditions/${entered.body.id}/clear`,
      undefined,
      {
        'if-match': `"${entered.body.version}"`,
      },
    );
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body).toMatchObject({ active: false });
    expect(cleared.body.clearedAt).not.toBeNull();
    // Switching a feed off takes its items off the board at once.
    const off = await call<Source>(
      'director',
      'PATCH',
      `/live-sources/${wzdx.id}`,
      { enabled: false },
      {
        'if-match': `"${(await call<Source[]>('director', 'GET', '/live-sources')).body.find((s) => s.id === wzdx.id)!.version}"`,
      },
    );
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, activeItems: 0 });
    expect((await call<Condition[]>('dispatcher', 'GET', '/live-conditions')).body).toHaveLength(0);
  });
});
