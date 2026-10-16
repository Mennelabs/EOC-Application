/**
 * Exports against the database (layer-6 task F; DCL:DEC-11, DEC-12, DEC-13,
 * DEC-15, F15, RULE-10, SEC-18, GATE-07): the director asks for the IDA
 * package; the worker builds it; its summary, street sheet and GIS layer
 * agree with the declaration view; no street address leaves; a package for
 * one jurisdiction counts only the homes in it; only exporters may ask for
 * or download a file; the request, the result and each download are
 * audited; an issued report exports from its frozen copy, a draft not at
 * all; with no file storage the export fails visibly. Representative
 * photos (PHO-06/07, DEC-13): only cleared photos can be chosen, a caption
 * naming the address or a phone number is refused, the package carries the
 * blurred image re-encoded without metadata, a city package only the city's
 * photos, and a photo no longer cleared is left out. Runs only with
 * API_DB_TEST_APP_URL, API_DB_TEST_WORKER_URL and MINIO_ROOT_PASSWORD (the
 * stack's object store): the stack's own worker may take a request before
 * the test runs the job, so the file is wherever the stack keeps it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3 } from '@cg/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { countDamage, loadDamageRecords } from '@cg/reporting';
import { unzip } from '../../../packages/refdata/src/formats/shapefile.ts';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { exportRequested } from '../../worker/src/jobs/exports.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const objectsSecret = process.env['MINIO_ROOT_PASSWORD'];
// The compose stack's object store and bucket (compose.yaml).
const bucket = 'cg-local';
// The API has no image library; the worker's makes the synthetic photos.
interface Img {
  webp(): Img;
  withExif(exif: Record<string, Record<string, string>>): Img;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{ width?: number; height?: number }>;
}
const sharp = createRequire(new URL('../../worker/package.json', import.meta.url))('sharp') as (
  input: Buffer | { create: { width: number; height: number; channels: 3; background: string } },
) => Img;

interface Export {
  id: string;
  kind?: string;
  status: string;
  sha256: string | null;
  bytes: number | null;
  error: string | null;
  mappings: Record<string, { mappingVersion: number }>;
  figures: { countedUnits?: number; homes?: number; features?: number; contentHash?: string };
  code?: string;
}

/** Parses this platform's CSV (quoted fields, doubled quotes, CRLF rows). */
function csvRows(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && t[i + 1] === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return out;
}

describe.skipIf(!appUrl || !workerUrl || !objectsSecret)('exports (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let city = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const s3 = createS3({
    endpoint: process.env['API_DB_TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
    region: 'us-east-1',
    accessKeyId: 'cg-local',
    secretAccessKey: objectsSecret ?? '',
    bucket,
  });
  const people: Record<string, string> = {};
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(dbWorker, { tenantId: county }, fn);

  const ctx = (objects = true) =>
    ({
      db: dbWorker,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      productName: 'Test Product',
      objects: objects
        ? {
            async put(key: string, body: Buffer | string, contentType: string) {
              await s3.send(
                new PutObjectCommand({
                  Bucket: bucket,
                  Key: key,
                  Body: body,
                  ContentType: contentType,
                }),
              );
            },
            async get(key: string) {
              const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
              return {
                body: Buffer.from(await res.Body!.transformToByteArray()),
                contentType: res.ContentType ?? null,
              };
            },
          }
        : null,
    }) as unknown as JobContext;
  const build = (exportId: string, objects = true) =>
    exportRequested(ctx(objects), {
      id: 1,
      tenantId: county,
      topic: 'export.requested',
      payload: { exportId },
      executionId: null,
    });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-exp-${run}`,
        name: `Exercise export county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    city = (
      await tx((trx) =>
        trx
          .insertInto('cg.tenant')
          .values({
            kind: 'city',
            parent_id: county,
            slug: `exercise-exp-city-${run}`,
            name: `Exercise City ${run}`,
            status: 'provisioning',
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id;
    eventId = await tx(async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) })
        .execute();
      for (const [who, name] of [
        ['author', 'Exercise Reporting Officer'],
        ['director', 'Exercise EM Director'],
      ] as const)
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
      return (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise export flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(Date.now() - 86_400_000),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    await loadDamageReports(dbWorker, {
      tenantId: county,
      eventId,
      reviewerId: randomUUID(),
      count: 40,
      tag: `exp${run}`,
    });
    // Half the located homes fall in the city (the worker assigns this from outlines in the stack).
    const locs = await tx((trx) =>
      trx
        .selectFrom('cg.report')
        .select('location_id')
        .where('event_id', '=', eventId)
        .orderBy('reference_code')
        .execute(),
    );
    await tx((trx) =>
      trx
        .insertInto('cg.location_geo')
        .values(
          locs
            .filter((_, i) => i % 2 === 0)
            .map((l) => ({
              location_id: l.location_id!,
              tenant_id: county,
              jurisdiction_tenant_id: city,
            })),
        )
        .execute(),
    );

    const subject = (template: string, accountId: string = randomUUID()): AccountSubject => {
      const r = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId,
        tenantId: county,
        tenantPath: c.path,
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
    };
    const subjects: Record<string, AccountSubject> = {
      director: subject('county_em_director', people['director']!),
      author: subject('reporting_planning', people['author']!),
      coordinator: subject('damage_assessment_coordinator'),
      pio: subject('public_information_officer'),
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
      routes: routesWith({
        exports: { objects: { client: s3, bucket } },
        packagePhotos: { objects: { client: s3, bucket } },
      }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', 'like', `exercise-exp-%${run}`)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async <T = Export>(
    who: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return {
      status: res.statusCode,
      body: (res.headers['content-type']?.toString().includes('json') ? res.json() : null) as T,
      raw: res.rawPayload,
      headers: res.headers,
    };
  };

  let packageId = '';

  it('DEC-11, GATE-07: the package is built from the records and agrees with the declaration view', async () => {
    const clientUuid = randomUUID();
    const asked = await call('director', 'POST', `/events/${eventId}/exports`, {
      clientUuid,
      reason: 'Exercise: state request',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.status).toBe('queued');
    packageId = asked.body.id;
    expect(
      (await call('director', 'POST', `/events/${eventId}/exports`, { clientUuid })).body.id,
    ).toBe(packageId);
    await build(packageId);
    const done = (await call('director', 'GET', `/exports/${packageId}`)).body;
    expect(done).toMatchObject({ status: 'ready' });
    expect(Object.keys(done.mappings)).toHaveLength(10);
    expect(Object.values(done.mappings).every((m) => m.mappingVersion === 1)).toBe(true);

    const view = (
      await call<{ damage: { counted: { units: number } } }>(
        'director',
        'GET',
        `/events/${eventId}/declaration`,
      )
    ).body;
    expect(done.figures.countedUnits).toBe(view.damage.counted.units);
    expect(view.damage.counted.units).toBeGreaterThan(0);

    const file = await call('director', 'GET', `/exports/${packageId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/zip');
    expect(createHash('sha256').update(file.raw).digest('hex')).toBe(done.sha256);
    const files = unzip(file.raw);
    expect([...files.keys()].sort()).toEqual(
      [
        'README.txt',
        'ia-street-sheet.csv',
        'ia-survey-multi-family.csv',
        'ia-survey-single-family.csv',
        'pda-layer.geojson',
        'pa-site-sheet.csv',
        'package.pdf',
        'summary.csv',
      ].sort(),
    );
    expect(files.get('package.pdf')!.subarray(0, 8).toString()).toBe('%PDF-1.7');
    const summary = csvRows(files.get('summary.csv')!.toString('utf8'));
    expect(
      Number(summary.find((r) => r[0] === 'ia_summary_sheet' && r[2] === 'UNITS-TOTAL')![4]),
    ).toBe(view.damage.counted.units);
    const street = csvRows(files.get('ia-street-sheet.csv')!.toString('utf8'));
    const layer = JSON.parse(files.get('pda-layer.geojson')!.toString('utf8')) as {
      features: unknown[];
    };
    expect(layer.features).toHaveLength(street.length - 1);
    expect(street.length - 1).toBe(done.figures.homes);
    expect(files.get('README.txt')!.toString()).toContain('mapping version 1');
  });

  it('DEC-13: no street address or unit leaves in any file', async () => {
    const lines = await tx((trx) =>
      trx
        .selectFrom('cg.report as r')
        .innerJoin('cg.location as l', 'l.id', 'r.location_id')
        .select(['l.line1', 'l.unit'])
        .where('r.event_id', '=', eventId)
        .execute(),
    );
    const text = [
      ...unzip((await call('director', 'GET', `/exports/${packageId}/file`)).raw).entries(),
    ]
      .filter(([n]) => !n.endsWith('.pdf'))
      .map(([, b]) => b.toString('utf8'))
      .join('\n');
    for (const l of lines) {
      expect(text).not.toContain(l.line1!);
    }
    // Neither the report reference codes nor the parcel numbers (SYN-…) leave.
    expect(text).not.toMatch(/SYN-/);
  });

  it('DEC-11: a package for one jurisdiction counts only the homes located in it', async () => {
    const asked = await call('director', 'POST', `/events/${eventId}/exports`, {
      clientUuid: randomUUID(),
      jurisdictionTenantId: city,
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    await build(asked.body.id);
    const done = (await call('director', 'GET', `/exports/${asked.body.id}`)).body;
    const inCity = new Set(
      (
        await tx((trx) =>
          trx
            .selectFrom('cg.location_geo')
            .select('location_id')
            .where('jurisdiction_tenant_id', '=', city)
            .execute(),
        )
      ).map((x) => x.location_id),
    );
    const records = await withTenant(dbApp, { tenantId: county }, (trx) =>
      loadDamageRecords(trx, eventId),
    );
    const want = countDamage(records.filter((r) => r.locationId && inCity.has(r.locationId)));
    expect(done.figures.countedUnits).toBe(want.counted.units);
    const all = (await call('director', 'GET', `/exports/${packageId}`)).body.figures.countedUnits!;
    expect(done.figures.countedUnits!).toBeLessThan(all);
    const readme = unzip((await call('director', 'GET', `/exports/${asked.body.id}/file`)).raw)
      .get('README.txt')!
      .toString();
    expect(readme).toContain(`Exercise City ${run}`);
  });

  it('SEC-18: only exporters ask for or download a file; every step is audited', async () => {
    expect(
      (
        await call('coordinator', 'POST', `/events/${eventId}/exports`, {
          clientUuid: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect((await call('coordinator', 'GET', `/events/${eventId}/exports`)).status).toBe(200);
    expect((await call('coordinator', 'GET', `/exports/${packageId}/file`)).status).toBe(404);
    const actions = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('action')
        .where('target_id', '=', packageId)
        .execute(),
    );
    const names = actions.map((a) => a.action);
    expect(names).toContain('declaration.export');
    expect(names).toContain('export.ready');
    expect(names.filter((a) => a === 'export.download').length).toBeGreaterThanOrEqual(2);
  });

  it('F15, RULE-10: an issued report exports from its frozen copy; a draft does not export', async () => {
    const periodFrom = new Date(Date.now() - 12 * 3_600_000).toISOString();
    const periodTo = new Date(Date.now() + 3_600_000).toISOString();
    let r = (
      await call<{
        id: string;
        version: number;
        sections: { key: string; content: { text?: string } }[];
      }>('author', 'POST', '/official-reports', {
        clientUuid: randomUUID(),
        eventId,
        kind: 'sitrep',
        periodFrom,
        periodTo,
      })
    ).body;
    const draftExport = await call('director', 'POST', `/official-reports/${r.id}/exports`, {
      clientUuid: randomUUID(),
      format: 'pdf',
    });
    expect(draftExport.status).toBe(409);
    const v = (x: { version: number }) => ({ 'if-match': `"${x.version}"` });
    r = (
      await call<typeof r>(
        'author',
        'PUT',
        `/official-reports/${r.id}/sections/summary`,
        { text: 'Exercise summary, read and saved.' },
        v(r),
      )
    ).body;
    r = (
      await call<typeof r>(
        'director',
        'POST',
        `/official-reports/${r.id}/review`,
        { decision: 'approve' },
        v(r),
      )
    ).body;
    const issued = (
      await call<{ id: string; snapshot: { contentHash: string } }>(
        'director',
        'POST',
        `/official-reports/${r.id}/issue`,
        undefined,
        { ...v(r), 'x-confirm': 'true', 'x-reason': 'Exercise: release' },
      )
    ).body;
    for (const format of ['pdf', 'csv'] as const) {
      const asked = await call('author', 'POST', `/official-reports/${issued.id}/exports`, {
        clientUuid: randomUUID(),
        format,
      });
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      await build(asked.body.id);
      const done = (await call('author', 'GET', `/exports/${asked.body.id}`)).body;
      expect(done).toMatchObject({
        status: 'ready',
        figures: { contentHash: issued.snapshot.contentHash },
      });
      const file = await call('author', 'GET', `/exports/${asked.body.id}/file`);
      if (format === 'pdf') expect(file.raw.subarray(0, 8).toString()).toBe('%PDF-1.7');
      else expect(file.raw.toString('utf8')).toContain('Housing units counted');
    }
    const listed = await call<Export[]>('author', 'GET', `/official-reports/${issued.id}/exports`);
    expect(listed.body).toHaveLength(2);
  });

  it('SEC-13: a public-records release is confirmed with a reason, holds only what the person may read, and withholds restricted and sensitive details, addresses and confidential sites', async () => {
    // A public site and a confidential one (a domestic-violence shelter, for one).
    await tx((trx) =>
      trx
        .insertInto('cg.site')
        .values([
          {
            tenant_id: county,
            event_id: eventId,
            kind: 'shelter',
            name: `Exercise public shelter ${run}`,
            slug: `exercise-public-${run}`,
          },
          {
            tenant_id: county,
            event_id: eventId,
            kind: 'shelter',
            name: `Exercise confidential shelter ${run}`,
            slug: `exercise-confidential-${run}`,
            confidential: true,
          },
        ])
        .execute(),
    );
    const body = {
      clientUuid: randomUUID(),
      requestReference: `PRR-${run}`,
      recordTypes: ['reports', 'needs', 'sites', 'official_reports'],
    };
    const confirm = { 'x-confirm': 'true', 'x-reason': 'Exercise: answering a records request' };
    // Not a records officer's action for every role, and confirmed with a reason.
    expect(
      (await call('coordinator', 'POST', `/events/${eventId}/public-records`, body)).status,
    ).toBe(403);
    expect((await call('director', 'POST', `/events/${eventId}/public-records`, body)).status).toBe(
      428,
    );
    // Default deny: the PIO may release issued reports, not resident reports it cannot read.
    const pio = await call(
      'pio',
      'POST',
      `/events/${eventId}/public-records`,
      { ...body, clientUuid: randomUUID() },
      confirm,
    );
    expect(pio.status).toBe(403);
    expect(JSON.stringify(pio.body)).toContain('reports');

    const asked = await call(
      'director',
      'POST',
      `/events/${eventId}/public-records`,
      body,
      confirm,
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.kind).toBe('public_records');
    await build(asked.body.id);
    const ready = await call('director', 'GET', `/exports/${asked.body.id}`);
    expect(ready.body.status, JSON.stringify(ready.body)).toBe('ready');
    expect(
      (ready.body.figures as unknown as { rows: Record<string, number> }).rows['reports'],
    ).toBe(40);
    const listed = await call<Export[]>('director', 'GET', `/events/${eventId}/public-records`);
    expect(listed.body.map((e) => e.id)).toContain(asked.body.id);

    const file = await call('director', 'GET', `/exports/${asked.body.id}/file`);
    expect(file.status).toBe(200);
    const files = unzip(file.raw);
    expect([...files.keys()].sort()).toEqual([
      'README.txt',
      'REDACTIONS.csv',
      'needs.csv',
      'official_reports.csv',
      'reports.csv',
      'sites.csv',
    ]);
    const text = [...files.values()].map((b) => b.toString('utf8')).join('\n');
    expect(text).toContain(`PRR-${run}`);
    expect(text).toContain(`Exercise public shelter ${run}`);
    expect(text).not.toContain(`Exercise confidential shelter ${run}`);
    // No street address, no resident's reference code, no parcel number.
    const homes = await tx((trx) =>
      trx
        .selectFrom('cg.report as r')
        .innerJoin('cg.location as l', 'l.id', 'r.location_id')
        .select(['l.line1', 'r.reference_code'])
        .where('r.event_id', '=', eventId)
        .execute(),
    );
    for (const h of homes) {
      expect(text).not.toContain(h.line1!);
      expect(text).not.toContain(h.reference_code!);
    }
    expect(text).not.toMatch(/SYN-/);
    const header = files.get('reports.csv')!.toString('utf8').split('\r\n')[0]!;
    for (const c of ['answers', 'answers_enc', 'location_id', 'reporter_party_id', 'need_signals'])
      expect(header.split(',')).not.toContain(c);
    expect(files.get('REDACTIONS.csv')!.toString('utf8')).toContain('reports,answers,sensitive');

    // Requested, built and downloaded are each in the audit log.
    const audited = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('action')
        .where('target_id', '=', asked.body.id)
        .execute(),
    );
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining(['public_records.export', 'export.ready', 'export.download']),
    );
  });

  it('fails visibly when there is no file storage', async () => {
    // A request with no outbox message, so only this job sees it.
    const id = (
      await tx((trx) =>
        trx
          .insertInto('cg.export_file')
          .values({
            tenant_id: county,
            event_id: eventId,
            client_uuid: randomUUID(),
            kind: 'ida_package',
            format: 'zip',
            requested_by: people['director']!,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id;
    await build(id, false);
    const done = (await call('director', 'GET', `/exports/${id}`)).body;
    expect(done).toMatchObject({ status: 'failed', error: 'No file storage is configured.' });
    expect((await call('director', 'GET', `/exports/${id}/file`)).status).toBe(409);
  });

  it('records the first finished attempt only (at-least-once delivery)', async () => {
    const asked = await call('director', 'POST', `/events/${eventId}/exports`, {
      clientUuid: randomUUID(),
    });
    await Promise.all([build(asked.body.id), build(asked.body.id)]);
    await build(asked.body.id);
    const done = (await call('director', 'GET', `/exports/${asked.body.id}`)).body;
    expect(done.status).toBe('ready');
    const file = await call('director', 'GET', `/exports/${asked.body.id}/file`);
    expect(createHash('sha256').update(file.raw).digest('hex')).toBe(done.sha256);
    const ready = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('action')
        .where('target_id', '=', asked.body.id)
        .where('action', '=', 'export.ready')
        .execute(),
    );
    expect(ready).toHaveLength(1);
  });

  describe('representative photos (PHO-06, PHO-07, DEC-13)', () => {
    interface Chosen {
      id: string;
      photoId: string;
      cleared: boolean;
      placeText: string | null;
      imageUrl: string | null;
    }
    const photo: Record<'cityCleared' | 'countyCleared' | 'notCleared', string> = {
      cityCleared: '',
      countyCleared: '',
      notCleared: '',
    };
    let cityLine1 = '';

    beforeAll(async () => {
      // Three synthetic photos on located reports: two cleared (one in the city), one not.
      const reports = await tx((trx) =>
        trx
          .selectFrom('cg.report as r')
          .innerJoin('cg.location as l', 'l.id', 'r.location_id')
          .leftJoin('cg.location_geo as g', 'g.location_id', 'l.id')
          .select(['r.id', 'r.execution_id', 'l.line1', 'g.jurisdiction_tenant_id'])
          .where('r.event_id', '=', eventId)
          .where('r.review_state', '=', 'approved')
          .orderBy('r.reference_code')
          .execute(),
      );
      const inCity = reports.find((r) => r.jurisdiction_tenant_id === city)!;
      const outside = reports.filter((r) => r.jurisdiction_tenant_id !== city);
      cityLine1 = inCity.line1!;
      const image = await sharp({
        create: { width: 1600, height: 1200, channels: 3, background: '#5a7a96' },
      })
        .webp()
        // A defect upstream would leave metadata; the package must not carry it.
        .withExif({ IFD0: { ImageDescription: 'exercise metadata that must not leave' } })
        .toBuffer();
      const add = async (
        r: { id: string; execution_id: string },
        blur: 'applied' | 'skipped_no_detector',
      ) => {
        const id = randomUUID();
        const prefix = `tenants/${county}/restricted/${r.execution_id}/${id}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${prefix}/review.webp`,
            Body: image,
            ContentType: 'image/webp',
          }),
        );
        await tx((trx) =>
          trx
            .insertInto('cg.photo')
            .values({
              id,
              tenant_id: county,
              execution_id: r.execution_id,
              report_id: r.id,
              object_key_original: `${prefix}/original.jpg`,
              derivative_keys: JSON.stringify({
                review: `${prefix}/review.webp`,
                thumb: `${prefix}/thumb.webp`,
              }),
              exif_stripped: true,
              blur_status: blur,
              status: 'processed',
              content_type: 'image/jpeg',
              processed_at: new Date(),
            })
            .execute(),
        );
        return id;
      };
      photo.cityCleared = await add(inCity, 'applied');
      photo.countyCleared = await add(outside[0]!, 'applied');
      photo.notCleared = await add(outside[1]!, 'skipped_no_detector');
    });

    const choose = (photoId: string, caption: string, checked: unknown = true) =>
      call<Chosen & { code?: string }>('director', 'POST', `/events/${eventId}/package-photos`, {
        photoId,
        caption,
        checked,
      });

    it('only cleared photos are offered and chosen; captions carry no address or phone', async () => {
      const offered = await call<{ photoId: string; imageUrl: string | null; placeText: string }[]>(
        'director',
        'GET',
        `/events/${eventId}/package-photos/candidates`,
      );
      expect(offered.status).toBe(200);
      const ids = offered.body.map((c) => c.photoId);
      expect(ids).toContain(photo.cityCleared);
      expect(ids).toContain(photo.countyCleared);
      expect(ids).not.toContain(photo.notCleared);
      const shown = offered.body.find((c) => c.photoId === photo.cityCleared)!;
      expect(shown.imageUrl).toContain('review.webp');
      expect(shown.placeText).toContain('(100 m cell)');
      expect(shown.placeText).not.toContain(cityLine1);
      expect(
        (await call('coordinator', 'GET', `/events/${eventId}/package-photos/candidates`)).status,
      ).toBe(403);

      expect((await choose(photo.notCleared, 'Exercise: water in the basement.')).body.code).toBe(
        'not_cleared',
      );
      expect((await choose(photo.cityCleared, `Exercise: flooding at ${cityLine1}.`)).status).toBe(
        400,
      );
      const number = cityLine1.split(' ')[0]!;
      const street = cityLine1.split(' ')[1]!;
      expect(
        (await choose(photo.cityCleared, `Exercise: house ${number} ${street} flooded.`)).status,
      ).toBe(400);
      expect(
        (await choose(photo.cityCleared, 'Exercise: call 555-201-3344 for access.')).status,
      ).toBe(400);
      expect(
        (await choose(photo.cityCleared, 'Exercise: water line in the hall.', false)).status,
      ).toBe(400);
      const first = await choose(
        photo.cityCleared,
        'Exercise: water line about three feet up a wall.',
      );
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect((await choose(photo.cityCleared, 'Exercise: the same photo again.')).body.code).toBe(
        'already_chosen',
      );
      expect(
        (await choose(photo.countyCleared, 'Exercise: debris piled at the curb after the flood.'))
          .status,
      ).toBe(201);
      const listed = await call<{ chosen: Chosen[] }>(
        'director',
        'GET',
        `/events/${eventId}/package-photos`,
      );
      expect(listed.body.chosen.map((c) => c.photoId)).toEqual([
        photo.cityCleared,
        photo.countyCleared,
      ]);
      expect(listed.body.chosen.every((c) => c.cleared && c.imageUrl)).toBe(true);
    });

    it('the package carries the blurred images without metadata, captioned, in scope', async () => {
      const asked = await call('director', 'POST', `/events/${eventId}/exports`, {
        clientUuid: randomUUID(),
      });
      await build(asked.body.id);
      const done = (await call('director', 'GET', `/exports/${asked.body.id}`)).body;
      expect(done.figures).toMatchObject({ photos: 2, photosLeftOut: 0 });
      const files = unzip((await call('director', 'GET', `/exports/${asked.body.id}/file`)).raw);
      for (const name of ['photos/photo-01.jpg', 'photos/photo-02.jpg']) {
        const jpeg = files.get(name)!;
        expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
        expect(jpeg.includes(Buffer.from('Exif'))).toBe(false);
        expect(jpeg.includes(Buffer.from('must not leave'))).toBe(false);
        const meta = await sharp(jpeg).metadata();
        expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1200);
      }
      const listed = csvRows(files.get('photos.csv')!.toString('utf8'));
      expect(listed[1]![2]).toBe('Exercise: water line about three feet up a wall.');
      expect(files.get('photos.csv')!.toString('utf8')).not.toContain(cityLine1);
      expect(files.get('package.pdf')!.toString('latin1')).toContain('/S /Figure');

      // The city's package carries only the city's photo.
      const cityPkg = await call('director', 'POST', `/events/${eventId}/exports`, {
        clientUuid: randomUUID(),
        jurisdictionTenantId: city,
      });
      await build(cityPkg.body.id);
      expect(
        (await call('director', 'GET', `/exports/${cityPkg.body.id}`)).body.figures,
      ).toMatchObject({ photos: 1, photosLeftOut: 1 });
    });

    it('a photo no longer cleared is left out; a choice is withdrawn, never deleted; all audited', async () => {
      await tx((trx) =>
        trx
          .updateTable('cg.photo')
          .set({ blur_status: 'failed' })
          .where('id', '=', photo.countyCleared)
          .execute(),
      );
      const asked = await call('director', 'POST', `/events/${eventId}/exports`, {
        clientUuid: randomUUID(),
      });
      await build(asked.body.id);
      const done = (await call('director', 'GET', `/exports/${asked.body.id}`)).body;
      expect(done.figures).toMatchObject({ photos: 1, photosLeftOut: 1 });
      const readme = unzip((await call('director', 'GET', `/exports/${asked.body.id}/file`)).raw)
        .get('README.txt')!
        .toString();
      expect(readme).toContain('1 chosen photo(s) left out');

      const listed = (
        await call<{ chosen: Chosen[] }>('director', 'GET', `/events/${eventId}/package-photos`)
      ).body.chosen;
      const stale = listed.find((c) => c.photoId === photo.countyCleared)!;
      expect(stale).toMatchObject({ cleared: false, imageUrl: null });
      expect(
        (await call('coordinator', 'DELETE', `/events/${eventId}/package-photos/${stale.id}`))
          .status,
      ).toBe(403);
      expect(
        (await call('director', 'DELETE', `/events/${eventId}/package-photos/${stale.id}`)).status,
      ).toBe(204);
      expect(
        (await call('director', 'DELETE', `/events/${eventId}/package-photos/${stale.id}`)).status,
      ).toBe(404);
      const row = await tx((trx) =>
        trx
          .selectFrom('cg.package_photo')
          .select(['removed_at', 'removed_by'])
          .where('id', '=', stale.id)
          .executeTakeFirstOrThrow(),
      );
      expect(row.removed_by).toBe(people['director']);
      const actions = (
        await tx((trx) =>
          trx
            .selectFrom('cg.audit_event')
            .select('action')
            .where('target_type', '=', 'package_photo')
            .where(
              'target_id',
              'in',
              listed.map((c) => c.id),
            )
            .execute(),
        )
      ).map((a) => a.action);
      expect(actions.filter((a) => a === 'package_photo.choose')).toHaveLength(2);
      expect(actions).toContain('package_photo.remove');
    });
  });
});
