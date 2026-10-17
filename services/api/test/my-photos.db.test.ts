/**
 * CHN-09, RULE-09: a report started by text gets photos from the web. With the
 * code-verified token from My report the resident asks for an upload ticket;
 * the photo joins the report's own submission and the report at once, is
 * stored through the same upload as intake photos and queued for the same
 * processing. Once it is complete the web joins the channels the report used,
 * and a report already reviewed goes back to review with its version kept. A
 * withdrawn report takes no photo, and nothing works without the token. Runs
 * on a county of its own against the local object store, only with
 * API_DB_TEST_APP_URL, API_DB_TEST_WORKER_URL and MINIO_ROOT_PASSWORD.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createS3 } from '@cg/adapters';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
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
  jpeg(): Img;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(import.meta.url)('sharp') as (o: {
  create: { width: number; height: number; channels: 3; background: string };
}) => Img;

describe.skipIf(!appUrl || !workerUrl || !objectsSecret)(
  'photos added from My report (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let county = '';
    const reports: Record<
      'approved' | 'submitted' | 'withdrawn' | 'web',
      { id: string; exec: string }
    > = {
      approved: { id: '', exec: '' },
      submitted: { id: '', exec: '' },
      withdrawn: { id: '', exec: '' },
      web: { id: '', exec: '' },
    };
    const run = randomUUID().slice(0, 8);
    const slug = `exercise-myphotos-${run}`;
    const s3 = createS3({
      endpoint: process.env['API_DB_TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
      region: 'us-east-1',
      accessKeyId: 'cg-local',
      secretAccessKey: objectsSecret ?? '',
      bucket,
    });
    const tokenFor = (id: string) =>
      signResidentToken(SECRET, {
        tenantId: county,
        reportId: id,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
    const base = () => `/api/public/intake/${slug}`;
    const ticket = (token: string | null) =>
      app.inject({
        method: 'POST',
        url: `${base()}/me/photos`,
        headers: token ? { 'x-resident-token': token } : {},
        payload: { contentType: 'image/jpeg', bytes: 2000 },
      });
    /** The whole upload as the browser's same-origin fallback does it. */
    async function addPhoto(reportId: string) {
      const t = await ticket(tokenFor(reportId));
      expect(t.statusCode, t.body).toBe(201);
      const { photoId, executionId } = t.json<{ photoId: string; executionId: string }>();
      const jpeg = await sharp({
        create: { width: 80, height: 60, channels: 3, background: '#a75' },
      })
        .jpeg()
        .toBuffer();
      const put = await app.inject({
        method: 'PUT',
        url: `${base()}/photos/${photoId}/content?executionId=${executionId}`,
        headers: { 'content-type': 'image/jpeg' },
        payload: jpeg,
      });
      expect(put.statusCode, put.body).toBe(200);
      const done = await app.inject({
        method: 'POST',
        url: `${base()}/photos/${photoId}/complete`,
        payload: { executionId },
      });
      expect(done.statusCode, done.body).toBe(200);
      return { photoId, executionId };
    }
    const report = (id: string) =>
      dbWorker
        .selectFrom('cg.report')
        .select(['review_state', 'channels_used', 'version'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 2);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      county = (
        await dbWorker
          .insertInto('cg.tenant')
          .values({
            kind: 'county',
            parent_id: seeded.tenants['region']!,
            slug,
            name: `Exercise My Photos County ${run}`,
            status: 'provisioning',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await withTenant(dbWorker, { tenantId: county }, async (trx) => {
        for (const key of ['approved', 'submitted', 'withdrawn', 'web'] as const) {
          const r = await trx
            .insertInto('cg.report')
            .values({
              tenant_id: county,
              reference_code: `PH-${key.slice(0, 3).toUpperCase()}-${run.toUpperCase()}`,
              execution_id: randomUUID(),
              graph_key: westwindGraph.key,
              graph_version: westwindGraph.version,
              channel_of_origin: key === 'web' ? 'web' : 'sms',
              channels_used: [key === 'web' ? 'web' : 'sms'],
              relationship: 'own_home',
              answers: JSON.stringify({}),
              review_state: key === 'approved' ? 'approved' : 'submitted',
              withdrawn_at: key === 'withdrawn' ? new Date() : null,
            } as never)
            .returning(['id', 'execution_id'])
            .executeTakeFirstOrThrow();
          reports[key] = { id: r.id, exec: r.execution_id };
        }
      });
      app = await buildApp({
        productName: 'Test Product',
        version: '0.0.0',
        dataMode: 'synthetic',
        logLevel: 'silent',
        probes: [],
        db: dbApp,
        fieldCrypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
        publicRoutes: [
          publicRoutes({
            resolver: new TenantResolver(dbApp, 0),
            codes: new ReferenceCodeLeaser(dbApp, 'test'),
            getQueue: () => undefined,
            residentTokenSecret: SECRET,
            defaultGraph: westwindGraph,
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
        .where('id', '=', county)
        .execute();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    it('CHN-09: nothing without the token from My report; a withdrawn report takes no photo', async () => {
      expect((await ticket(null)).statusCode).toBe(401);
      expect((await ticket('not-a-token')).statusCode).toBe(401);
      const gone = await ticket(tokenFor(reports.withdrawn.id));
      expect(gone.statusCode).toBe(409);
      expect(gone.json()).toMatchObject({ code: 'report_withdrawn' });
    });

    it('CHN-09: a photo added on the web joins the report started by text, is queued for processing, and the web joins its channels', async () => {
      const me = () =>
        app.inject({
          method: 'GET',
          url: `${base()}/me`,
          headers: { 'x-resident-token': tokenFor(reports.submitted.id) },
        });
      expect((await me()).json()).toMatchObject({ photos: 0 });
      const before = await report(reports.submitted.id);
      const { photoId, executionId } = await addPhoto(reports.submitted.id);
      // The report's own submission, so its photos are never compared as another report's.
      expect(executionId).toBe(reports.submitted.exec);
      const photo = await dbWorker
        .selectFrom('cg.photo')
        .select(['report_id', 'status', 'source'])
        .where('id', '=', photoId)
        .executeTakeFirstOrThrow();
      expect(photo).toEqual({ report_id: reports.submitted.id, status: 'uploaded', source: 'web' });
      const queued = await dbWorker
        .selectFrom('cg.outbox')
        .select('topic')
        .where('tenant_id', '=', county)
        .where('topic', '=', 'photo.process')
        .execute();
      expect(queued.length).toBe(1);
      const after = await report(reports.submitted.id);
      expect(after.channels_used).toEqual(['sms', 'web']);
      // Not yet reviewed: it stays where it was, with no new version kept.
      expect(after.review_state).toBe('submitted');
      expect(before.review_state).toBe('submitted');
      expect((await me()).json()).toMatchObject({ photos: 1 });
    });

    it('CHN-09: a report sent on the web and not yet reviewed takes a photo with nothing else to change', async () => {
      const before = await report(reports.web.id);
      await addPhoto(reports.web.id);
      const after = await report(reports.web.id);
      expect(after.channels_used).toEqual(['web']);
      expect(after.review_state).toBe('submitted');
      expect(after.version).toBe(before.version);
    });

    it('RULE-09: a photo added to a reviewed report puts it back in review, its reviewed version kept and the change audited', async () => {
      await addPhoto(reports.approved.id);
      const r = await report(reports.approved.id);
      expect(r.review_state).toBe('submitted');
      expect(r.channels_used).toEqual(['sms', 'web']);
      const kept = await dbWorker
        .selectFrom('cg.report_version')
        .select(['snapshot', 'changed_by_kind', 'reason'])
        .where('report_id', '=', reports.approved.id)
        .executeTakeFirstOrThrow();
      expect(kept).toMatchObject({
        changed_by_kind: 'resident',
        reason: 'photo added by the resident',
      });
      expect((kept.snapshot as { review_state: string }).review_state).toBe('approved');
      const audited = await dbWorker
        .selectFrom('cg.audit_event')
        .select(['action', 'reason'])
        .where('tenant_id', '=', county)
        .where('target_id', '=', reports.approved.id)
        .execute();
      expect(audited).toContainEqual({
        action: 'report.self_update',
        reason: 'photo added after review: back to review (RULE-09)',
      });
    });
  },
);
