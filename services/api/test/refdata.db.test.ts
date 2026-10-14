/**
 * Reference data routes against a real PostgreSQL (layer-6 task A;
 * ADR-0039, SCL-09, SCL-13, FR-00.05/06, ADM-05): the planning/GIS lead sees
 * each dataset's sources and snapshots, asks for a pull now and takes a file
 * through upload, column mapping and apply; a resent upload request answers
 * the same import; a mapping to a field or column that does not exist is
 * refused by name; apply waits for a passed check; the director reads but
 * cannot manage; a coordinator without the grant gets nothing; every write is
 * audited. Object storage is a stand-in that keeps what it is sent. Runs only
 * with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
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

interface ImportBody {
  id: string;
  version: number;
  status: string;
  columns: string[];
  fields: { name: string; required: boolean }[];
  uploadPath: string;
}

describe.skipIf(!appUrl || !workerUrl)('reference data routes (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let countyId: string;
  const stored = new Map<string, Buffer>();
  const objects = {
    client: {
      async send(cmd: { input: { Key: string; Body: Buffer } }) {
        stored.set(cmd.input.Key, cmd.input.Body);
        return {};
      },
    } as unknown as S3Client,
    bucket: 'test',
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    countyId = seeded.tenants['county']!;
    const county = await dbWorker
      .selectFrom('cg.tenant')
      .select(['path', 'kind'])
      .where('id', '=', countyId)
      .executeTakeFirstOrThrow();
    const subject = (template: string, email: string): AccountSubject => {
      const t = roleTemplates.find((r) => r.key === template)!;
      return {
        kind: 'account',
        accountId: seeded.accounts[email]!,
        tenantId: countyId,
        tenantPath: county.path,
        tenantKind: county.kind,
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
    const subjects: Record<string, AccountSubject> = {
      gis: subject('planning_gis_lead', 'marcus.gis@example.org'),
      director: subject('county_em_director', 'dana.director@example.org'),
      coordinator: subject('damage_assessment_coordinator', 'priya.assessment@example.org'),
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
      routes: routesWith({ refdata: { objects } }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload !== undefined
        ? { payload: payload as Record<string, unknown> | string | Buffer }
        : {}),
    });
    return { status: res.statusCode, json: <T>() => res.json() as T };
  };

  async function audited(action: string, targetId: string) {
    return dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'actor_kind'])
      .where('tenant_id', '=', countyId)
      .where('action', '=', action)
      .where('target_id', '=', targetId)
      .execute();
  }

  it('lists every dataset with its sources; the director reads, a coordinator without the grant does not', async () => {
    const res = await call('gis', 'GET', '/refdata/sources');
    expect(res.status).toBe(200);
    const body = res.json<{ dataset: string; sources: { id: string }[] }[]>();
    expect(body.map((d) => d.dataset)).toContain('tract_profile');
    expect(body.find((d) => d.dataset === 'declaration')?.sources.map((s) => s.id)).toEqual([
      'openfema.declarations',
    ]);
    expect((await call('director', 'GET', '/refdata/sources')).status).toBe(200);
    expect((await call('coordinator', 'GET', '/refdata/sources')).status).toBe(403);
    expect((await call('director', 'GET', '/refdata/snapshots?dataset=declaration')).status).toBe(
      200,
    );
  });

  it('queues a pull now for the GIS lead, audited; the director cannot', async () => {
    const res = await call('gis', 'POST', '/refdata/pull', { dataset: 'declaration' });
    expect(res.status).toBe(202);
    const queued = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', countyId)
      .where('topic', '=', 'refdata.pull')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(queued.payload).toMatchObject({ dataset: 'declaration', reason: 'staff' });
    expect(await audited('refdata.pull.request', 'declaration')).not.toHaveLength(0);
    expect(
      (await call('director', 'POST', '/refdata/pull', { dataset: 'declaration' })).status,
    ).toBe(403);
    expect((await call('gis', 'POST', '/refdata/pull', { dataset: 'castles' })).status).toBe(400);
  });

  it('takes a file through upload, mapping and apply, refusing what does not fit (FR-00.05, FR-00.06)', async () => {
    const clientUuid = randomUUID();
    const request = {
      clientUuid,
      dataset: 'facility',
      format: 'csv',
      fileName: 'facilities.csv',
      bytes: 120,
      licence: 'Exercise data (synthetic)',
    };
    expect((await call('director', 'POST', '/refdata/imports', request)).status).toBe(403);
    expect(
      (await call('gis', 'POST', '/refdata/imports', { ...request, fileName: '../x.csv' })).status,
    ).toBe(400);
    const created = await call('gis', 'POST', '/refdata/imports', request);
    expect(created.status).toBe(201);
    const imp = created.json<ImportBody>();
    expect(imp.status).toBe('uploading');
    expect(imp.fields.find((f) => f.name === 'kind')?.required).toBe(true);
    const again = await call('gis', 'POST', '/refdata/imports', request);
    expect(again.status).toBe(200);
    expect(again.json<ImportBody>().id).toBe(imp.id);

    const csv = 'ID,Type,Name,Lat,Lon\nH1,hospital,Exercise General,38.55,-90.45\n';
    const empty = await call('gis', 'PUT', `/refdata/imports/${imp.id}/content`, '\n', {
      'content-type': 'text/csv',
    });
    expect(empty.status).toBe(400);
    const uploaded = await call('gis', 'PUT', `/refdata/imports/${imp.id}/content`, csv, {
      'content-type': 'text/csv',
    });
    expect(uploaded.status).toBe(200);
    const up = uploaded.json<ImportBody>();
    expect(up).toMatchObject({ status: 'uploaded', columns: ['ID', 'Type', 'Name', 'Lat', 'Lon'] });
    expect(stored.get(`tenants/${countyId}/refdata/imports/${imp.id}`)?.toString()).toBe(csv);

    const mapping = {
      sourceId: 'ID',
      kind: 'Type',
      name: 'Name',
      latitude: 'Lat',
      longitude: 'Lon',
    };
    const noVersion = await call('gis', 'PUT', `/refdata/imports/${imp.id}/mapping`, { mapping });
    expect(noVersion.status).toBe(428);
    const wrong = await call(
      'gis',
      'PUT',
      `/refdata/imports/${imp.id}/mapping`,
      { mapping: { ...mapping, colour: 'Name', beds: 'Beds' } },
      { 'if-match': `"${up.version}"` },
    );
    expect(wrong.status).toBe(400);
    expect(
      wrong
        .json<{ fields: { name: string; message: string }[] }>()
        .fields.map((f) => `${f.name}: ${f.message}`)
        .sort(),
    ).toEqual([
      'mapping.beds: not a column in the file',
      'mapping.colour: not a field of this dataset',
    ]);
    const mapped = await call(
      'gis',
      'PUT',
      `/refdata/imports/${imp.id}/mapping`,
      { mapping, vintage: 'Exercise 2026' },
      { 'if-match': `"${up.version}"` },
    );
    expect(mapped.status).toBe(200);
    const m = mapped.json<ImportBody>();
    expect(m.status).toBe('validating');
    const job = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', countyId)
      .where('topic', '=', 'refdata.import')
      .where(({ ref }) => ref('payload', '->>').key('importId' as never), '=', imp.id as never)
      .executeTakeFirst();
    expect(job).toBeDefined();

    const early = await call('gis', 'POST', `/refdata/imports/${imp.id}/apply`, undefined, {
      'if-match': `"${m.version}"`,
    });
    expect(early.status).toBe(409);

    // The worker's check passed (services/worker/test/refdata.db.test.ts covers the check itself).
    const checked = await dbWorker
      .updateTable('cg.refdata_import')
      .set({ status: 'validated', row_count: 1 })
      .where('id', '=', imp.id)
      .returning('version')
      .executeTakeFirstOrThrow();
    const applied = await call('gis', 'POST', `/refdata/imports/${imp.id}/apply`, undefined, {
      'if-match': `"${checked.version}"`,
    });
    expect(applied.status).toBe(200);
    expect(applied.json<ImportBody>().status).toBe('applying');
    for (const action of [
      'refdata.import.create',
      'refdata.import.upload',
      'refdata.import.map',
      'refdata.import.apply',
    ])
      expect(await audited(action, imp.id)).toEqual([{ action, actor_kind: 'account' }]);
  });

  it('refuses a GeoJSON file that is not a FeatureCollection or a GeoPackage that is not one, and answers 404 for an import it cannot see', async () => {
    const created = await call('gis', 'POST', '/refdata/imports', {
      clientUuid: randomUUID(),
      dataset: 'tract',
      format: 'geojson',
      fileName: 'tracts.geojson',
      bytes: 40,
      licence: 'Exercise data (synthetic)',
    });
    const imp = created.json<ImportBody>();
    const bad = await call(
      'gis',
      'PUT',
      `/refdata/imports/${imp.id}/content`,
      '{"type":"Feature"}',
      { 'content-type': 'application/geo+json' },
    );
    expect(bad.status).toBe(400);
    const gpkg = await call('gis', 'POST', '/refdata/imports', {
      clientUuid: randomUUID(),
      dataset: 'facility',
      format: 'gpkg',
      fileName: 'facilities.gpkg',
      bytes: 40,
      licence: 'Exercise data (synthetic)',
    });
    expect(gpkg.status).toBe(201);
    const notGpkg = await call(
      'gis',
      'PUT',
      `/refdata/imports/${gpkg.json<ImportBody>().id}/content`,
      Buffer.from('this is not a GeoPackage'),
      { 'content-type': 'application/geopackage+sqlite3' },
    );
    expect(notGpkg.status).toBe(400);
    expect(notGpkg.json<{ fields: { message: string }[] }>().fields[0]!.message).toMatch(
      /GeoPackage/,
    );
    expect((await call('gis', 'GET', `/refdata/imports/${randomUUID()}`)).status).toBe(404);
    expect((await call('director', 'GET', `/refdata/imports/${imp.id}`)).status).toBe(200);
  });
});
