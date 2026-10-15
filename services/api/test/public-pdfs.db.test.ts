/**
 * The resident's own copy and the media sheet PDF against the database
 * (layer-6 task I; FL:FR-32, PUB-13, SEC-09, SEC-18): the copy needs the
 * resident's token for that report; it carries the home and damage answers
 * (the address included, decrypted), their own words and their processed
 * photos as JPEG, and leaves out how to reach them, their household and
 * their needs; photos still processing are counted, not shown; every copy
 * is audited. The media sheet PDF is served in both languages next to the
 * page that links to it. Runs only with API_DB_TEST_APP_URL,
 * API_DB_TEST_WORKER_URL and MINIO_ROOT_PASSWORD (the stack's MinIO).
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createS3 } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { loadResidentCopy } from '../src/public/my-copy.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { signResidentToken } from '../src/public/resident-token.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const objectsSecret = process.env['MINIO_ROOT_PASSWORD'];
const bucket = 'cg-local';
const SECRET = 'test-secret-'.repeat(4);

interface Img {
  webp(o: { quality: number }): Img;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(import.meta.url)('sharp') as (o: {
  create: { width: number; height: number; channels: 3; background: string };
}) => Img;

describe.skipIf(!appUrl || !workerUrl || !objectsSecret)('public PDFs (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let reportId = '';
  let otherReport = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-pdf-${run}`;
  const reference = `PDF-${run.toUpperCase()}`;
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const s3 = createS3({
    endpoint: process.env['API_DB_TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
    region: 'us-east-1',
    accessKeyId: 'cg-local',
    secretAccessKey: objectsSecret ?? '',
    bucket,
  });
  const tokenFor = (id: string, tenantId = county) =>
    signResidentToken(SECRET, {
      tenantId,
      reportId: id,
      exp: Math.floor(Date.now() / 1000) + 600,
    });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise PDF County ${run}`,
        status: 'provisioning',
        timezone: 'America/Chicago',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    county = c.id;
    const answers = {
      relationship: { kind: 'value', value: 'own_home' },
      home_type: { kind: 'value', value: 'house' },
      cause: { kind: 'value', value: 'flood' },
      water_depth: { kind: 'value', value: 'over_1ft' },
      insurance: { kind: 'unknown' },
      household_size: { kind: 'value', value: 4 },
    };
    const restricted = {
      address: { kind: 'value', value: { line1: '12 Exercise Lane', city: 'Westwind' } },
      contact: { kind: 'value', value: { phone: '314-555-0142', preferred: 'text' } },
      access_needs: { kind: 'value', value: ['wheelchair'] },
    };
    const review = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#5a7' },
    })
      .webp({ quality: 80 })
      .toBuffer();
    const prefix = `tenant/${county}/photos/test-${run}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/review.webp`,
        Body: review,
        ContentType: 'image/webp',
      }),
    );
    [reportId, otherReport] = await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const ids: string[] = [];
      for (const [i, ref] of [reference, `${reference}-B`].entries()) {
        const r = await trx
          .insertInto('cg.report')
          .values({
            tenant_id: county,
            reference_code: ref,
            execution_id: randomUUID(),
            graph_key: westwindGraph.key,
            graph_version: westwindGraph.version,
            channel_of_origin: 'web',
            channels_used: ['web'],
            relationship: 'own_home',
            answers: JSON.stringify(answers),
            answers_enc: await crypto.encrypt(county, JSON.stringify(restricted)),
            original_text_enc: await crypto.encrypt(
              county,
              'Exercise: water came into the basement.\n\nThe furnace is under water.',
            ),
            // Withdrawn, so no review queue counts these exercise reports.
            withdrawn_at: i === 1 ? new Date() : null,
          })
          .returning(['id', 'execution_id'])
          .executeTakeFirstOrThrow();
        ids.push(r.id);
        if (i === 0) {
          await trx
            .insertInto('cg.photo')
            .values({
              tenant_id: county,
              execution_id: r.execution_id,
              report_id: r.id,
              shot: 'front',
              object_key_original: `${prefix}/original.jpg`,
              derivative_keys: JSON.stringify({ review: `${prefix}/review.webp` }),
              exif_stripped: true,
              status: 'processed',
              content_type: 'image/jpeg',
              uploaded_at: new Date(),
              processed_at: new Date(),
            })
            .execute();
          await trx
            .insertInto('cg.photo')
            .values({
              tenant_id: county,
              execution_id: r.execution_id,
              report_id: r.id,
              shot: 'damage_close',
              object_key_original: `${prefix}/second.jpg`,
              status: 'uploaded',
              content_type: 'image/jpeg',
              uploaded_at: new Date(),
            })
            .execute();
        }
      }
      return ids as [string, string];
    });
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: crypto,
      publicRoutes: [
        publicRoutes({
          resolver: new TenantResolver(dbApp, 0),
          codes: new ReferenceCodeLeaser(dbApp, 'test'),
          getQueue: () => undefined,
          residentTokenSecret: SECRET,
          defaultGraph: westwindGraph,
          ai: { providerFor: async () => fakeProvider },
          objects: { client: s3, bucket, maxBytes: 6 * 1024 * 1024 },
        }),
      ],
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

  it('FL:FR-32: the copy holds the home and damage answers, own words and photos, nothing else', async () => {
    const copy = await withTenant(dbApp, { tenantId: county }, (trx) =>
      loadResidentCopy(
        trx,
        { crypto, objects: { client: s3, bucket }, defaultGraph: westwindGraph },
        { tenantId: county, tenantName: 'Exercise', reportId, lang: 'en', now: new Date() },
      ),
    );
    expect(copy).not.toBeNull();
    expect(copy!.referenceCode).toBe(reference);
    expect(copy!.state).toBe('received');
    expect(copy!.timeZone).toBe('America/Chicago');
    const all = copy!.sections.flatMap((s) => s.items);
    const text = JSON.stringify(copy!.sections);
    // The address is the resident's own and is what an insurer needs.
    expect(all.some((x) => x.answer.includes('12 Exercise Lane'))).toBe(true);
    expect(all.some((x) => x.answer === 'I don’t know')).toBe(true);
    // How to reach them, their household and their needs stay with the county.
    expect(text).not.toContain('314-555-0142');
    expect(text).not.toMatch(/wheelchair/i);
    expect(all.some((x) => x.answer === '4')).toBe(false);
    expect(copy!.ownWords).toContain('furnace');
    expect(copy!.photos).toHaveLength(1);
    expect(copy!.photos[0]!.image.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(copy!.photosPending).toBe(1);
    const es = await withTenant(dbApp, { tenantId: county }, (trx) =>
      loadResidentCopy(
        trx,
        { crypto, defaultGraph: westwindGraph },
        { tenantId: county, tenantName: 'Exercise', reportId, lang: 'es', now: new Date() },
      ),
    );
    expect(es!.sections.flatMap((s) => s.items).some((x) => x.answer === 'No sé')).toBe(true);
  });

  it('SEC-09: the copy needs the resident token for that report, and is audited', async () => {
    const url = `/api/public/intake/${slug}/me/export.pdf?lang=es`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url, headers: { 'x-resident-token': 'nope.nope' } })).statusCode,
    ).toBe(401);
    // A token for another tenant does not open this tenant's copy.
    const elsewhere = tokenFor(reportId, randomUUID());
    expect((await app.inject({ url, headers: { 'x-resident-token': elsewhere } })).statusCode).toBe(
      401,
    );
    const res = await app.inject({ url, headers: { 'x-resident-token': tokenFor(reportId) } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="damage-report-${reference}.pdf"`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // A withdrawn report still gives its owner a copy, marked withdrawn.
    const withdrawn = await app.inject({
      url,
      headers: { 'x-resident-token': tokenFor(otherReport) },
    });
    expect(withdrawn.statusCode).toBe(200);
    const audit = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'actor_kind', 'changes'])
        .where('target_id', '=', reportId)
        .where('action', '=', 'report.self_export')
        .execute(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_kind).toBe('public');
    expect(audit[0]!.changes).toMatchObject({ lang: 'es', photos: 1 });
  });

  it('PUB-13: the media sheet is a PDF in both languages, linked from the page', async () => {
    for (const lang of ['en', 'es']) {
      const res = await app.inject({ url: `/api/public/help/${slug}/media.pdf?lang=${lang}` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        `inline; filename="media-sheet-${slug}-${lang}.pdf"`,
      );
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    }
    const page = await app.inject({ url: `/api/public/help/${slug}/media?lang=es` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`/api/public/help/${slug}/media.pdf?lang=es`);
    expect(page.body).toContain('Descargar la hoja para medios en PDF');
  });
});
