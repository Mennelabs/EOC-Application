/**
 * A county shelter run by a partner (CON-16, FL:FR-14, ADM-05, SEC-05,
 * layer-4 task K): the county names the partner as the site's operator; the
 * partner's shelter staff then read the site, record its status and census
 * and register households there, and still cannot edit the site; another
 * partner sees nothing of it; the county sees the census the operator
 * confirms, not the households (the partner keeps its guests' details).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import type { Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)('site operator (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let eventId: string;
  let siteId: string;
  let ngo: string;
  const subjects: Record<string, AccountSubject> = {};
  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${who}`, ...extra },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return {
      status: res.statusCode,
      body: res.body,
      json: <T = Record<string, unknown>>() => res.json() as T,
    };
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const county = seeded.tenants['county']!;
    ngo = seeded.tenants['shelter-ngo']!;
    const other = seeded.tenants['canteen']!;
    eventId = (
      await dbWorker
        .selectFrom('cg.event')
        .select('id')
        .where('tenant_id', '=', county)
        .where('intake_slug', '=', 'westwind')
        .executeTakeFirstOrThrow()
    ).id;
    // A county shelter of its own for this suite, so other suites' sites are untouched.
    siteId = (
      await dbWorker
        .insertInto('cg.site')
        .values({
          tenant_id: county,
          event_id: eventId,
          kind: 'shelter',
          name: `Exercise operated shelter ${randomUUID().slice(0, 6)}`,
          slug: `operated-${randomUUID().slice(0, 8)}`,
          status: 'open',
          capacity: 80,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const tenants = await dbWorker
      .selectFrom('cg.tenant')
      .select(['id', 'path', 'kind'])
      .where('id', 'in', [county, ngo, other])
      .execute();
    const t = (id: string) => tenants.find((x) => x.id === id)!;
    for (const [who, tenantId, template] of [
      ['countyCare', county, 'mass_care_coordinator'],
      ['ngoShelter', ngo, 'shelter_worker'],
      ['otherShelter', other, 'shelter_worker'],
    ] as const) {
      const email = `${who.toLowerCase()}.operator@example.org`;
      const existing = await dbWorker
        .selectFrom('cg.account')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('email', '=', email)
        .executeTakeFirst();
      const id =
        existing?.id ??
        (
          await dbWorker
            .insertInto('cg.account')
            .values({
              tenant_id: tenantId,
              email,
              display_name: email,
              status: 'active',
              activated_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const tpl = roleTemplates.find((r) => r.key === template)!;
      subjects[who] = {
        kind: 'account',
        accountId: id,
        tenantId,
        tenantPath: t(tenantId).path,
        tenantKind: t(tenantId).kind,
        status: 'active',
        roles: [
          {
            roleId: randomUUID(),
            key: tpl.key,
            version: 1,
            templateKey: tpl.key,
            grants: tpl.grants,
            scope: { eventIds: [eventId] },
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
      logLevel: process.env['TEST_LOG'] ?? 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      subjects: loader,
      routes: routesWith(),
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('CON-16: only the named operator reads the site and records its census; it still cannot edit it', async () => {
    // Before the county names an operator, the partner cannot see the site at all.
    expect((await call('ngoShelter', 'GET', `/api/v1/sites/${siteId}`)).status).toBe(404);
    const current = (await call('countyCare', 'GET', `/api/v1/sites/${siteId}`)).json<{
      version: number;
    }>();
    // Only a partner organization can be named.
    const wrong = await call(
      'countyCare',
      'PATCH',
      `/api/v1/sites/${siteId}`,
      { operatorTenantId: eventId },
      { 'if-match': String(current.version) },
    );
    expect(wrong.status).toBe(400);
    const named = await call(
      'countyCare',
      'PATCH',
      `/api/v1/sites/${siteId}`,
      { operatorTenantId: ngo },
      { 'if-match': String(current.version) },
    );
    expect(named.status, named.body).toBe(200);
    expect(named.json()['operatorTenantId']).toBe(ngo);

    const seen = await call('ngoShelter', 'GET', `/api/v1/sites/${siteId}`);
    expect(seen.status, seen.body).toBe(200);
    const census = await call('ngoShelter', 'POST', `/api/v1/sites/${siteId}/confirm`, {
      status: 'limited',
      occupancy: 61,
      note: 'Evening count',
    });
    expect(census.status, census.body).toBe(200);
    expect(census.json()).toMatchObject({ status: 'limited', occupancy: 61 });
    // Editing stays with the owner (row security and the action both say no).
    const v = (census.json() as { version: number }).version;
    const edit = await call(
      'ngoShelter',
      'PATCH',
      `/api/v1/sites/${siteId}`,
      { name: 'Renamed' },
      { 'if-match': String(v) },
    );
    expect([403, 404]).toContain(edit.status);
    // Another partner sees nothing of it.
    expect((await call('otherShelter', 'GET', `/api/v1/sites/${siteId}`)).status).toBe(404);
    expect(
      (await call('otherShelter', 'POST', `/api/v1/sites/${siteId}/confirm`, { occupancy: 1 }))
        .status,
    ).toBe(404);
  });

  it('FL:FR-14: the operator registers households there; the county sees the confirmed census, not the households', async () => {
    const stay = await call('ngoShelter', 'POST', '/api/v1/field-records/shelter_stay', {
      clientUuid: randomUUID(),
      eventId,
      siteId,
      householdName: 'Exercise Household Gamma',
      householdSize: 2,
      adults: 2,
      children: 0,
      cots: ['N-1', 'N-2'],
    });
    expect(stay.status, stay.body).toBe(201);
    const row = await dbWorker
      .selectFrom('cg.shelter_stay')
      .select('tenant_id')
      .where('id', '=', stay.json()['id'] as string)
      .executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(ngo);
    const ngoView = await call(
      'ngoShelter',
      'GET',
      `/api/v1/field-records/shelter_stay/census?siteId=${siteId}`,
    );
    expect(ngoView.json<{ cotsInUse: string[] }>().cotsInUse).toEqual(
      expect.arrayContaining(['N-1', 'N-2']),
    );
    // The partner keeps its guests' details; the county reads the census the operator confirms.
    const countyStays = await call(
      'countyCare',
      'GET',
      `/api/v1/field-records/shelter_stay?siteId=${siteId}`,
    );
    expect(countyStays.status, countyStays.body).toBe(200);
    expect(countyStays.json<unknown[]>()).toEqual([]);
    const site = await call('countyCare', 'GET', `/api/v1/sites/${siteId}`);
    expect(site.json()).toMatchObject({ status: 'limited', occupancy: 61, operatorTenantId: ngo });
    // The other partner sees nothing of this shelter.
    const otherView = await call(
      'otherShelter',
      'GET',
      `/api/v1/field-records/shelter_stay/census?siteId=${siteId}`,
    );
    expect(otherView.json<{ households: number }>().households).toBe(0);
  });
});
