/**
 * BRD:FR-03.01, FR-03.02: address suggestions and reverse geocoding for the
 * mission intake. The county's parcels answer first and are the address of
 * record; the self-hosted Nominatim adds map matches; when it is down or slow
 * the answer is the parcels alone, and a point with no known address is not
 * found (0,0 never is). A mission location keeps its cross streets in a field
 * of their own and, when saved as verified, when it was verified. Roles
 * without mission intake are refused. Runs on a county of its own, only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Place {
  label: string;
  line1: string | null;
  source: 'parcel' | 'osm';
  parcelId: string | null;
  position: { lat: number; lon: number } | null;
}

describe.skipIf(!appUrl || !workerUrl)('geocoding and verified locations (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let osmDown = false;
  const asked: string[] = [];
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const street = `Exercise Maple ${run}`;

  /** A stand-in for the self-hosted Nominatim. */
  const nominatim = (async (url: string | URL) => {
    asked.push(String(url));
    if (osmDown) throw new Error('connect ECONNREFUSED');
    const u = new URL(String(url));
    const body = u.pathname.startsWith('/search')
      ? [
          {
            lat: '38.81',
            lon: '-90.85',
            display_name: 'x',
            address: {
              house_number: '200',
              road: `${street} St`,
              town: 'Westwind',
              postcode: '63001',
            },
          },
        ]
      : {
          lat: u.searchParams.get('lat'),
          lon: u.searchParams.get('lon'),
          address: { house_number: '9', road: 'Exercise Rural Rd', village: 'Oak Hollow' },
        };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const call = async (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID() },
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
        slug: `exercise-geocode-${run}`,
        name: `Exercise geocode county ${run}`,
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
            name: `Exercise geocode storm ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // Two parcels side by side, each about 20 m across.
      for (const [n, lon] of [
        [101, -90.8702],
        [103, -90.8698],
      ] as const)
        await trx
          .insertInto('cg.parcel')
          .values({
            tenant_id: county,
            parcel_id: `EX-${run}-${n}`,
            geom: sql`ST_MakeEnvelope(${lon - 0.0001}, 38.7899, ${lon + 0.0001}, 38.7901, 4326)`,
            line1: `${n} ${street} St`,
            city: 'Harmon City',
            postal: '63002',
          } as never)
          .execute();
    });
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
    subjects['calltaker'] = as('dispatcher_call_taker');
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
      routes: routesWith({
        geocode: { nominatimUrl: 'http://geocoder.test:8080', fetch: nominatim },
      }),
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

  it('BRD:FR-03.02: suggestions come from the county parcels first, then the map data; with the geocoder down, the parcels alone', async () => {
    expect(
      (await call('volunteer', 'GET', `/geocode/suggest?q=${encodeURIComponent('101 Exercise')}`))
        .status,
    ).toBe(403);
    // Words in any order: the street first, the number not typed.
    const q = encodeURIComponent(street);
    const found = await call('calltaker', 'GET', `/geocode/suggest?q=${q}&limit=3`);
    expect(found.status, found.body).toBe(200);
    const places = found.json<Place[]>();
    expect(places.slice(0, 2).map((p) => p.source)).toEqual(['parcel', 'parcel']);
    expect(places[0]).toMatchObject({
      line1: `101 ${street} St`,
      parcelId: `EX-${run}-101`,
    });
    expect(places[0]!.position!.lat).toBeCloseTo(38.79, 3);
    expect(places[2]).toMatchObject({ source: 'osm', line1: `200 ${street} St` });
    expect(asked.some((u) => u.includes('/search?') && u.includes('countrycodes=us'))).toBe(true);

    osmDown = true;
    const parcelsOnly = await call('calltaker', 'GET', `/geocode/suggest?q=${q}&limit=3`);
    expect(parcelsOnly.json<Place[]>().map((p) => p.source)).toEqual(['parcel', 'parcel']);
    osmDown = false;
  });

  it('BRD:FR-03.02: reverse geocoding names the parcel at a point, else the map data; 0,0 and an unknown point are not found', async () => {
    const atParcel = await call('calltaker', 'GET', '/geocode/reverse?lat=38.79&lon=-90.8698');
    expect(atParcel.status, atParcel.body).toBe(200);
    expect(atParcel.json<Place>()).toMatchObject({
      source: 'parcel',
      line1: `103 ${street} St`,
    });
    const rural = await call('calltaker', 'GET', '/geocode/reverse?lat=38.70&lon=-90.70');
    expect(rural.json<Place>()).toMatchObject({ source: 'osm', line1: '9 Exercise Rural Rd' });
    expect((await call('calltaker', 'GET', '/geocode/reverse?lat=0&lon=0')).status).toBe(404);
    osmDown = true;
    expect((await call('calltaker', 'GET', '/geocode/reverse?lat=38.70&lon=-90.70')).status).toBe(
      404,
    );
    osmDown = false;
  });

  it('BRD:FR-03.01: a mission location keeps cross streets apart from the landmark, and a verified place records when it was verified', async () => {
    const base = {
      eventId,
      kind: 'welfare_check',
      source: 'call',
      priority: 'normal',
      urgency: 'soon',
      summary: 'Exercise: check on an older resident after the storm.',
    };
    const verified = await call('calltaker', 'POST', '/missions', {
      ...base,
      location: {
        line1: `101 ${street} St`,
        city: 'Harmon City',
        postal: '63002',
        crossStreets: 'Exercise Maple St and 4th Ave',
        landmark: 'Green door',
        position: { lat: 38.79, lon: -90.8702 },
        state: 'verified',
      },
    });
    expect(verified.status, verified.body).toBe(201);
    const loc = verified.json<{
      location: { crossStreets: string; landmark: string; verifiedAt: string | null };
      locationState: string;
    }>();
    expect(loc.locationState).toBe('verified');
    expect(loc.location).toMatchObject({
      crossStreets: 'Exercise Maple St and 4th Ave',
      landmark: 'Green door',
    });
    expect(Date.now() - new Date(loc.location.verifiedAt!).getTime()).toBeLessThan(60_000);
    const approximate = await call('calltaker', 'POST', '/missions', {
      ...base,
      location: { position: { lat: 38.7, lon: -90.7 }, state: 'approximate' },
    });
    expect(
      approximate.json<{ location: { verifiedAt: string | null } }>().location.verifiedAt,
    ).toBeNull();
  });
});
