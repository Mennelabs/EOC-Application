/**
 * BRD:FR-16.01, FR-16.02: a resource's thumbnail. Staff upload a picture; it
 * is stored re-encoded (no location or camera details) at one small size. The
 * public sees it only once the resource is published with it: a picture
 * uploaded later waits for the next publish, and a draft, removed or expired
 * resource shows none. Removing the picture takes it off the public page at
 * once and deletes the stored files. Roles that only read resources cannot
 * change it. Runs on a county of its own, only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import sharp from 'sharp';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Out {
  id: string;
  version: number;
  published: boolean;
  thumbnail: { uploaded: boolean; publicPicture: boolean; waitingForPublish: boolean };
}
interface PublicHelp {
  resources: { slug: string; thumbnailUrl: string | null }[];
}

describe.skipIf(!appUrl || !workerUrl)('resource thumbnails (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let slug = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const objects = new Map<string, Buffer>();
  const s3 = {
    async send(cmd: {
      constructor: { name: string };
      input: { Key: string; Body?: Buffer };
    }): Promise<unknown> {
      const name = cmd.constructor.name;
      if (name === 'PutObjectCommand') {
        objects.set(cmd.input.Key, cmd.input.Body ?? Buffer.alloc(0));
        return {};
      }
      if (name === 'GetObjectCommand') {
        const b = objects.get(cmd.input.Key);
        if (!b) throw new Error('NoSuchKey');
        return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(cmd.input.Key);
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const storage = { client: s3 as never, bucket: 'test' };

  const call = async (
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
      ...(payload === undefined ? {} : { payload: payload as Buffer }),
    });
    return {
      status: res.statusCode,
      body: res.body,
      raw: res.rawPayload,
      type: res.headers['content-type'],
      json: <T>() => res.json() as T,
    };
  };
  const json = { 'content-type': 'application/json' };
  const confirm = { 'x-confirm': 'true', 'x-reason': 'Exercise: publish the debris guidance' };
  const picture = (color: { r: number; g: number; b: number }, width = 1200, height = 900) =>
    sharp({ create: { width, height, channels: 3, background: color } })
      .withMetadata({ exif: { IFD0: { Make: 'ExerciseCam', Model: 'Exercise 1' } } })
      .jpeg()
      .toBuffer();
  const putPicture = (who: string, id: string, version: number, image: Buffer) =>
    call(who, 'PUT', `/resources/${id}/thumbnail`, image, {
      'content-type': 'image/jpeg',
      'if-match': `"${version}"`,
    });
  const get = async (id: string) => (await call('pio', 'GET', `/resources/${id}`)).json<Out>();
  const publicHelp = async () => {
    const res = await app.inject({ method: 'GET', url: `/api/public/help/${slug}` });
    return res.json<PublicHelp>();
  };
  const publicPicture = (url: string) => app.inject({ method: 'GET', url });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    slug = `exercise-thumb-${run}`;
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise thumbnail county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
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
    subjects['pio'] = as('public_information_officer');
    subjects['reader'] = as('mass_care_coordinator');
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
      routes: routesWith({ resources: { objects: storage, checkLink: async () => true } }),
      publicRoutes: [
        publicRoutes({
          resolver: new TenantResolver(dbApp),
          codes: new ReferenceCodeLeaser(dbApp, 'test'),
          risk: new RiskScorer(),
          getQueue: () => undefined,
          residentTokenSecret: 'test-secret-'.repeat(4),
          defaultGraph: westwindGraph,
          objects: { ...storage, maxBytes: 6 * 1024 * 1024 },
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

  let id = '';

  it('FR-16.01: a picture is stored re-encoded at one small size without its camera details; readers cannot change it', async () => {
    const created = await call(
      'pio',
      'POST',
      '/resources',
      {
        slug: `debris-${run}`,
        type: 'guidance',
        texts: {
          en: {
            title: 'Exercise debris pickup',
            summary: 'Put storm debris at the curb.',
            bodyHtml: '<p>Crews pick up storm debris left at the curb.</p>',
            humanReviewed: true,
          },
        },
      },
      json,
    );
    expect(created.status, created.body).toBe(201);
    const r = created.json<Out>();
    id = r.id;
    expect(r.thumbnail).toEqual({
      uploaded: false,
      uploadedAt: null,
      publicPicture: false,
      waitingForPublish: false,
    });
    const image = await picture({ r: 200, g: 120, b: 40 });
    expect((await putPicture('reader', id, r.version, image)).status).toBe(404);
    expect((await putPicture('pio', id, r.version + 5, image)).status).toBe(409);
    expect(
      (
        await call('pio', 'PUT', `/resources/${id}/thumbnail`, Buffer.from('not an image'), {
          'content-type': 'image/png',
          'if-match': `"${r.version}"`,
        })
      ).status,
    ).toBe(400);
    const saved = await putPicture('pio', id, r.version, image);
    expect(saved.status, saved.body).toBe(200);
    expect(saved.json<Out>().thumbnail).toMatchObject({
      uploaded: true,
      publicPicture: false,
      waitingForPublish: true,
    });
    expect(objects.size).toBe(1);
    const stored = [...objects.values()][0]!;
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 480, 320]);
    expect(meta.exif).toBeUndefined();
    const preview = await call('reader', 'GET', `/resources/${id}/thumbnail`);
    expect(preview.status).toBe(200);
    expect(preview.type).toBe('image/jpeg');
  });

  it('FR-16.01, FR-16.02: the public sees the picture only from the publish that approved it', async () => {
    // A draft shows nothing in public.
    expect((await publicHelp()).resources).toEqual([]);
    const published = await call(
      'pio',
      'POST',
      `/resources/${id}/publish`,
      {},
      {
        ...json,
        ...confirm,
      },
    );
    expect(published.status, published.body).toBe(200);
    expect(published.json<Out>().thumbnail).toMatchObject({
      publicPicture: true,
      waitingForPublish: false,
    });
    const first = (await publicHelp()).resources[0]!;
    expect(first.thumbnailUrl).toMatch(
      new RegExp(
        `^/api/public/help/${slug}/resources/debris-${run}/thumbnail\\.jpg\\?v=[0-9a-f]{8}$`,
      ),
    );
    const shown = await publicPicture(first.thumbnailUrl!);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toBe('image/jpeg');
    expect(shown.headers['cache-control']).toContain('public');
    const page = await app.inject({
      method: 'GET',
      url: `/api/public/help/${slug}/resources/debris-${run}`,
    });
    expect(page.body).toContain(`<img src="${first.thumbnailUrl!.replace(/&/g, '&amp;')}" alt=""`);
    expect(page.headers['content-security-policy']).toContain("img-src 'self'");

    // A new picture waits: the public keeps the approved one until the next publish.
    const before = await get(id);
    const next = await putPicture(
      'pio',
      id,
      before.version,
      await picture({ r: 20, g: 90, b: 160 }),
    );
    expect(next.json<Out>().thumbnail).toMatchObject({
      publicPicture: true,
      waitingForPublish: true,
    });
    expect((await publicHelp()).resources[0]!.thumbnailUrl).toBe(first.thumbnailUrl);
    expect(objects.size).toBe(2);
    await call('pio', 'POST', `/resources/${id}/publish`, {}, { ...json, ...confirm });
    const second = (await publicHelp()).resources[0]!.thumbnailUrl!;
    expect(second).not.toBe(first.thumbnailUrl);
    expect((await publicPicture(second)).statusCode).toBe(200);
    expect(objects.size).toBe(1); // the picture it replaced is deleted
  });

  it('FR-16.01, FR-16.03: unpublished or removed, the picture is gone from the public at once', async () => {
    const url = (await publicHelp()).resources[0]!.thumbnailUrl!;
    await call('pio', 'POST', `/resources/${id}/unpublish`, {}, { ...json, ...confirm });
    expect((await publicPicture(url)).statusCode).toBe(404);
    await call('pio', 'POST', `/resources/${id}/publish`, {}, { ...json, ...confirm });
    expect((await publicPicture(url)).statusCode).toBe(200);

    const current = await get(id);
    expect(
      (
        await call('reader', 'DELETE', `/resources/${id}/thumbnail`, undefined, {
          'if-match': `"${current.version}"`,
        })
      ).status,
    ).toBe(404);
    const removed = await call('pio', 'DELETE', `/resources/${id}/thumbnail`, undefined, {
      'if-match': `"${current.version}"`,
    });
    expect(removed.status, removed.body).toBe(200);
    expect(removed.json<Out>().thumbnail).toMatchObject({ uploaded: false, publicPicture: false });
    expect((await publicPicture(url)).statusCode).toBe(404);
    expect((await publicHelp()).resources[0]!.thumbnailUrl).toBeNull();
    expect(objects.size).toBe(0);
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('changes')
      .where('tenant_id', '=', county)
      .where('action', '=', 'resource.update')
      .where('target_id', '=', id)
      .execute();
    expect(JSON.stringify(audited.map((a) => a.changes))).toContain('"to":"none"');
  });
});
