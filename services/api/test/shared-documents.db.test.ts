/**
 * Documents a survivor chooses to share (FL-09, SEC-18, PHO-07). With their
 * consent recorded in their words, the photo goes from the camera to the
 * server as a document of the report, never as one of its damage photos;
 * only document readers who may read the report see it, every view is
 * audited, and the person who asked is the only one who sends the photo.
 * Runs on a county of its own, only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, randomCode, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

const CONSENT =
  'May I take a photo of your lease to add to your record? Only people working on your case will see it.';

describe.skipIf(!appUrl || !workerUrl)('documents a survivor chooses to share', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let otherEventId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const reports: Record<string, string> = {};
  const objects = new Map<string, Buffer>();
  // An in-memory object store with the call the upload makes; links are signed offline.
  const s3 = {
    async send(cmd: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) {
      if (cmd.constructor.name === 'PutObjectCommand') {
        objects.set(cmd.input.Key, cmd.input.Body ?? Buffer.alloc(0));
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  const presign = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://objects.test',
    forcePathStyle: true,
    credentials: { accessKeyId: 'exercise', secretAccessKey: 'exercise' },
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
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> | Buffer } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> & unknown[] };
  };
  const ask = (reportId: string, clientUuid = randomUUID(), extra: Record<string, unknown> = {}) =>
    call('mc', 'POST', `/reports/${reportId}/documents`, {
      clientUuid,
      kind: 'lease',
      consent: { method: 'spoken', language: 'es', text: CONSENT },
      contentType: 'image/jpeg',
      bytes: 4,
      ...extra,
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
        slug: `exercise-documents-${run}`,
        name: `Exercise documents county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const ev = async (name: string) =>
        (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: county,
              name,
              hazard_type: 'tornado',
              status: 'active',
              opened_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      eventId = await ev(`Exercise documents storm ${run}`);
      otherEventId = await ev(`Exercise documents flood ${run}`);
      for (const [k, ev2, withdrawn] of [
        ['home', eventId, false],
        ['withdrawn', eventId, true],
        ['flood', otherEventId, false],
      ] as const)
        reports[k] = (
          await trx
            .insertInto('cg.report')
            .values({
              tenant_id: county,
              event_id: ev2,
              reference_code: randomCode(),
              execution_id: randomUUID(),
              graph_key: 'damage',
              graph_version: 1,
              channel_of_origin: 'web',
              relationship: 'own_home',
              ...(withdrawn ? { withdrawn_at: new Date() } : {}),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
    });
    const as = (template: string, eventIds?: string[]): AccountSubject => {
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
            scope: eventIds ? { eventIds } : {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects['mc'] = as('mass_care_coordinator');
    subjects['mc2'] = as('mass_care_coordinator');
    subjects['reviewer'] = as('assessment_reviewer');
    subjects['pio'] = as('public_information_officer');
    subjects['canvasser'] = as('canvasser', [otherEventId]);
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
      reportDeps: {
        objects: {
          client: s3 as unknown as S3Client,
          presignClient: presign,
          bucket: 'exercise',
        },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', county)
      .execute();
    presign.destroy();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('FL-09: with the consent recorded, the photo goes to the report as a document, never as a damage photo, and is queued for processing', async () => {
    const clientUuid = randomUUID();
    const made = await ask(reports['home']!, clientUuid);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const documentId = made.body['documentId'] as string;
    // A resend from the phone is the same document.
    const again = await ask(reports['home']!, clientUuid);
    expect(again.status).toBe(200);
    expect(again.body['documentId']).toBe(documentId);

    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    // Only the person who asked sends the photo.
    expect(
      (
        await call('mc2', 'PUT', `/documents/${documentId}/content`, bytes, {
          'content-type': 'image/jpeg',
        })
      ).status,
    ).toBe(404);
    const sent = await call('mc', 'PUT', `/documents/${documentId}/content`, bytes, {
      'content-type': 'image/jpeg',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const doc = await dbWorker
      .selectFrom('cg.shared_document')
      .selectAll()
      .where('id', '=', documentId)
      .executeTakeFirstOrThrow();
    expect(doc).toMatchObject({
      report_id: reports['home'],
      kind: 'lease',
      consent_method: 'spoken',
      consent_language: 'es',
      consent_text: CONSENT,
      taken_by: subjects['mc']!.accountId,
    });
    const photo = await dbWorker
      .selectFrom('cg.photo')
      .selectAll()
      .where('id', '=', doc.photo_id!)
      .executeTakeFirstOrThrow();
    expect(photo).toMatchObject({
      report_id: null,
      shot: 'document',
      status: 'uploaded',
      field_record_type: 'shared_document',
      field_record_id: documentId,
    });
    expect(objects.get(photo.object_key_original)).toEqual(bytes);
    expect(photo.object_key_original).toContain(`/documents/${documentId}/`);
    const queued = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', county)
      .where('topic', '=', 'photo.process')
      .execute();
    expect(queued.map((q) => (q.payload as { photoId: string }).photoId)).toContain(photo.id);

    // The report's damage photos never include it.
    const gallery = await call('reviewer', 'GET', `/reports/${reports['home']}/photos`);
    expect(gallery.status).toBe(200);
    expect((gallery.body as unknown as { id: string }[]).map((p) => p.id)).not.toContain(photo.id);
    // The audit names the kind and how they agreed, not their words.
    const audit = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'changes'])
      .where('tenant_id', '=', county)
      .where('action', '=', 'document.capture')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.changes)).toContain('spoken (es)');
    expect(JSON.stringify(audit.changes)).not.toContain('Only people working on your case');
  });

  it('FL-09, SEC-18: only document readers who may read the report see it; the view link comes once processed, and every view is audited', async () => {
    expect((await call('mc', 'GET', `/reports/${reports['home']}/documents`)).status).toBe(404);
    const listed = await call('reviewer', 'GET', `/reports/${reports['home']}/documents`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const [d] = listed.body as unknown as Record<string, unknown>[];
    expect(d).toMatchObject({
      kind: 'lease',
      consentMethod: 'spoken',
      consentLanguage: 'es',
      consentText: CONSENT,
      status: 'uploaded',
      viewUrl: null,
    });
    // Once the worker has made the review copy, a short-lived link to it is given.
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.photo')
        .set({
          status: 'processed',
          derivative_keys: JSON.stringify({ review: `tenants/${county}/restricted/x/review.webp` }),
        })
        .where('field_record_type', '=', 'shared_document')
        .where('field_record_id', '=', d!['id'] as string)
        .execute(),
    );
    const ready = await call('reviewer', 'GET', `/reports/${reports['home']}/documents`);
    const url = (ready.body as unknown as { viewUrl: string }[])[0]!.viewUrl;
    expect(url).toContain('review.webp');
    expect(url).toContain('X-Amz-Expires=300');
    const reads = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['target_id', 'classification_read'])
      .where('tenant_id', '=', county)
      .where('action', '=', 'document.read')
      .execute();
    expect(reads.length).toBe(2);
    expect(reads[0]!.classification_read).toEqual(['evidence']);
  });

  it('FL-09: a role without the action, a report the worker may not read, a withdrawn report and missing consent words are refused', async () => {
    expect(
      (
        await call('pio', 'POST', `/reports/${reports['home']}/documents`, {
          clientUuid: randomUUID(),
          kind: 'id',
          consent: { method: 'tapped', language: 'en', text: CONSENT },
          contentType: 'image/jpeg',
          bytes: 4,
        })
      ).status,
    ).toBe(403);
    // The canvasser works the flood only.
    expect(
      (
        await call('canvasser', 'POST', `/reports/${reports['home']}/documents`, {
          clientUuid: randomUUID(),
          kind: 'id',
          consent: { method: 'tapped', language: 'en', text: CONSENT },
          contentType: 'image/jpeg',
          bytes: 4,
        })
      ).status,
    ).toBe(404);
    expect((await ask(reports['withdrawn']!)).status).toBe(409);
    expect(
      (
        await ask(reports['home']!, randomUUID(), {
          consent: { method: 'spoken', language: 'en', text: 'ok' },
        })
      ).status,
    ).toBe(400);
  });
});
