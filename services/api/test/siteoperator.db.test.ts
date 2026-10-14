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
import { sql, type Kysely } from 'kysely';
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
      ['gis', county, 'planning_gis_lead'],
      ['admin', county, 'tenant_admin'],
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

  it('CON-03, PUB-05, RULE-16, DCL:DEC-03: the situation layers show exact report points only to roles with the exact-location category, never a confidential site, and verified damage only once approved', async () => {
    const county = (
      await dbWorker
        .selectFrom('cg.event')
        .select('tenant_id')
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow()
    ).tenant_id;
    // A report at a known point in this event, and a confidential site with a location.
    const loc = await dbWorker
      .insertInto('cg.location')
      .values({
        tenant_id: county,
        geom: sql`ST_SetSRID(ST_MakePoint(-90.86543, 38.79876), 4326)`,
        precision: 'exact',
        source: 'resident',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const report = await dbWorker
      .selectFrom('cg.report')
      .select('id')
      .where('tenant_id', '=', county)
      .where('withdrawn_at', 'is', null)
      .where('duplicate_of', 'is', null)
      .orderBy('submitted_at', 'desc')
      .executeTakeFirstOrThrow();
    await dbWorker
      .updateTable('cg.report')
      .set({ location_id: loc.id, event_id: eventId })
      .where('id', '=', report.id)
      .execute();
    const hidden = await dbWorker
      .insertInto('cg.location')
      .values({
        tenant_id: county,
        geom: sql`ST_SetSRID(ST_MakePoint(-90.9, 38.8), 4326)`,
        precision: 'exact',
        source: 'reviewer',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const confidential = await dbWorker
      .insertInto('cg.site')
      .values({
        tenant_id: county,
        event_id: eventId,
        kind: 'shelter',
        name: 'Exercise confidential shelter',
        slug: `confidential-${randomUUID().slice(0, 8)}`,
        status: 'open',
        confidential: true,
        location_id: hidden.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    type Situation = {
      layers: Record<
        string,
        {
          available: boolean;
          items: { id: string; position: { lat: number; lon: number }; approximate: boolean }[];
        }
      >;
    };
    const gis = await call('gis', 'GET', `/api/v1/situation?eventId=${eventId}`);
    expect(gis.status, gis.body).toBe(200);
    const g = gis.json<Situation>();
    const exact = g.layers['reports']!.items.find((i) => i.id === report.id)!;
    expect(exact).toMatchObject({
      approximate: false,
      position: { lat: 38.79876, lon: -90.86543 },
    });
    expect(g.layers['sites']!.items.some((i) => i.id === confidential.id)).toBe(false);
    const admin = await call('admin', 'GET', `/api/v1/situation?eventId=${eventId}`);
    expect(admin.status, admin.body).toBe(200);
    const rounded = admin
      .json<Situation>()
      .layers['reports']!.items.find((i) => i.id === report.id)!;
    expect(rounded).toMatchObject({ approximate: true, position: { lat: 38.8, lon: -90.87 } });
    // A role without the layer's action is told the layer is not available, not given an empty map.
    const shelter = await call('ngoShelter', 'GET', `/api/v1/situation?eventId=${eventId}`);
    if (shelter.status === 200)
      expect(shelter.json<Situation>().layers['reports']!.available).toBe(false);

    // DCL:DEC-03, layer-6 plan §2: verified damage on the map is the counting rule's
    // "approved and verified"; a verified finding still under review is not on it.
    const before = await dbWorker
      .selectFrom('cg.report')
      .select(['review_state', 'verification_level', 'fema_degree'])
      .where('id', '=', report.id)
      .executeTakeFirstOrThrow();
    const onLayer = async () =>
      (await call('gis', 'GET', `/api/v1/situation?eventId=${eventId}`))
        .json<Situation>()
        .layers['verifiedDamage']!.items.some((i) => i.id === report.id);
    try {
      await dbWorker
        .updateTable('cg.report')
        .set({
          review_state: 'under_review',
          verification_level: 'desktop_verified',
          fema_degree: 'major',
        })
        .where('id', '=', report.id)
        .execute();
      expect(await onLayer()).toBe(false);
      await dbWorker
        .updateTable('cg.report')
        .set({ review_state: 'approved' })
        .where('id', '=', report.id)
        .execute();
      expect(await onLayer()).toBe(true);
    } finally {
      await dbWorker.updateTable('cg.report').set(before).where('id', '=', report.id).execute();
    }
  });
});
