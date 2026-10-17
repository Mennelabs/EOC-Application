/**
 * CON-17, SCL-13: a county loads its own parcels and route areas from its GIS
 * as GeoJSON. Parcels map the county's property names to ours and update by
 * parcel id; a feature without an id, or not a valid polygon, is refused and
 * named back while the rest load. A route polygon names the parcels whose
 * centre lies inside it, which is the area a verification route and the
 * phone's package are cut by; a draft verification route opens for each area
 * when the importer may open missions. Importing needs a reason (it is a
 * consequential action) and is audited; other roles are refused. Runs on a
 * county of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject, type Grant } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

/** A square parcel about 20 m across, west edge at `lon`. */
const square = (lon: number, lat = 38.79) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon, lat],
      [lon + 0.0002, lat],
      [lon + 0.0002, lat + 0.0002],
      [lon, lat + 0.0002],
      [lon, lat],
    ],
  ],
});

describe.skipIf(!appUrl || !workerUrl)('parcels and route areas from GIS (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};

  const call = async (
    who: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    reason = true,
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${who}`,
        'idempotency-key': randomUUID(),
        ...(reason ? { 'x-confirm': 'true', 'x-reason': 'Exercise: county parcel layer' } : {}),
      },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-parcels-${run}`,
        name: `Exercise parcels county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      eventId = (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise parcels storm ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    const as = (template: string, extra: Grant[] = []): AccountSubject => {
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
            grants: [...t.grants, ...extra],
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects['gis'] = as('planning_gis_lead');
    // A GIS lead who also opens missions, for the route missions.
    subjects['gis-dispatch'] = as('planning_gis_lead', [
      { action: 'mission.create' },
      { action: 'mission.read' },
    ]);
    subjects['volunteer'] = as('field_volunteer');
    const loader: SubjectLoader = {
      async fromBearer(t) {
        const s = subjects[t];
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

  const features = [
    { PIN: 'A-1', SITEADDR: '1 Exercise Elm St', CITY: 'Harmon City', ZIP: '63002', UNITS: '1' },
    { PIN: 'A-2', SITEADDR: '3 Exercise Elm St', CITY: 'Harmon City', ZIP: '63002', UNITS: '4' },
    { PIN: 'B-1', SITEADDR: '9 Exercise Oak Rd', CITY: 'Westwind', ZIP: '63001' },
  ].map((properties, i) => ({
    type: 'Feature' as const,
    properties,
    geometry: square(-90.87 + (i < 2 ? i * 0.0003 : 0.01)),
  }));
  const mapping = {
    parcelId: 'PIN',
    line1: 'SITEADDR',
    city: 'CITY',
    postal: 'ZIP',
    units: 'UNITS',
  };

  it('CON-17, SCL-13: parcels load with the county mapping, update by id, and refuse what is not a polygon; a reason is needed; others are refused', async () => {
    expect((await call('volunteer', 'POST', '/parcels/import', { features, mapping })).status).toBe(
      403,
    );
    expect(
      (await call('gis', 'POST', '/parcels/import', { features, mapping }, false)).status,
    ).toBe(428);
    const bad = [
      { type: 'Feature', properties: { SITEADDR: 'no id' }, geometry: square(-90.8) },
      {
        type: 'Feature',
        properties: { PIN: 'P-1' },
        geometry: { type: 'Point', coordinates: [-90.8, 38.7] },
      },
    ];
    const first = await call('gis', 'POST', '/parcels/import', {
      features: [...features, ...bad],
      mapping,
    });
    expect(first.status, first.body).toBe(200);
    expect(first.json()).toMatchObject({ inserted: 3, updated: 0, rejected: 2 });
    expect(first.json<{ problems: { index: number; reason: string }[] }>().problems).toEqual([
      { index: 3, reason: 'no PIN' },
      { index: 4, reason: 'not a polygon' },
    ]);
    // The same parcels again, one address corrected: updated, not doubled.
    const corrected = features.map((f, i) =>
      i === 0 ? { ...f, properties: { ...f.properties, SITEADDR: '1A Exercise Elm St' } } : f,
    );
    const again = await call('gis', 'POST', '/parcels/import', { features: corrected, mapping });
    expect(again.json()).toMatchObject({ inserted: 0, updated: 3, rejected: 0 });
    const rows = await dbWorker
      .selectFrom('cg.parcel')
      .select(['parcel_id', 'line1', 'unit_count', 'source'])
      .where('tenant_id', '=', county)
      .orderBy('parcel_id')
      .execute();
    expect(rows).toEqual([
      { parcel_id: 'A-1', line1: '1A Exercise Elm St', unit_count: 1, source: 'import' },
      { parcel_id: 'A-2', line1: '3 Exercise Elm St', unit_count: 4, source: 'import' },
      { parcel_id: 'B-1', line1: '9 Exercise Oak Rd', unit_count: null, source: 'import' },
    ]);
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', county)
      .where('action', '=', 'parcel.import')
      .execute();
    expect(audited.length).toBeGreaterThanOrEqual(2);
  });

  it('CON-17, FLD-13: a route polygon names the parcels inside it; a draft verification route opens per area for an importer who may open missions', async () => {
    const route = {
      type: 'Feature',
      properties: { ROUTE: `Elm Street ${run}` },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-90.8705, 38.7895],
            [-90.869, 38.7895],
            [-90.869, 38.7905],
            [-90.8705, 38.7905],
            [-90.8705, 38.7895],
          ],
        ],
      },
    };
    const onlyAreas = await call('gis', 'POST', '/parcels/routes/import', {
      features: [route],
      nameProperty: 'ROUTE',
      missionsFor: eventId,
    });
    expect(onlyAreas.status, onlyAreas.body).toBe(200);
    const areaKey = `elm-street-${run}`;
    expect(onlyAreas.json()).toMatchObject({
      routes: [{ areaKey, parcels: 2, missionId: null }],
    });
    // Without the mission role the area is named and the reason the mission did not open is said.
    expect(onlyAreas.body).toContain('opening missions needs the mission role');

    const withMissions = await call('gis-dispatch', 'POST', '/parcels/routes/import', {
      features: [route],
      nameProperty: 'ROUTE',
      missionsFor: eventId,
    });
    const r = withMissions.json<{ routes: { missionId: string | null }[] }>().routes[0]!;
    expect(r.missionId).not.toBeNull();
    const mission = await dbWorker
      .selectFrom('cg.mission')
      .select(['kind', 'state', 'route'])
      .where('id', '=', r.missionId!)
      .executeTakeFirstOrThrow();
    expect(mission).toMatchObject({
      kind: 'verification_route',
      state: 'draft',
      route: { area: areaKey, order: 'no_photo_first' },
    });
    const summary = await call('gis', 'GET', '/parcels/summary', undefined, false);
    expect(summary.status, summary.body).toBe(200);
    expect(summary.json()).toMatchObject({
      parcels: 3,
      areas: [{ areaKey, parcels: 2 }],
    });
  });
});
