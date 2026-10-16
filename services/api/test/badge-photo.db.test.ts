/**
 * BRD:FR-13.01, FR-13.04, BDG-01, ADM-05 G4: a badge photo taken at the desk
 * waits until a second person approves it; whoever took it cannot approve it.
 * The stored image is a re-encoded JPEG without the original's metadata. The
 * approved photo is served to roles that read the person; a pending one only
 * to those who take or approve photos. A badge prints only the approved
 * photo, and a request cannot name another. A rejected photo is deleted.
 * Runs on a county of its own, only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import sharp from 'sharp';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Status {
  approved: boolean;
  pending: boolean;
  pendingBy: string | null;
}

describe.skipIf(!appUrl || !workerUrl)('badge photos', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let person = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
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
      headers: { authorization: `Bearer ${who}`, ...headers },
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
  const put = (who: string, image: Buffer, type = 'image/jpeg') =>
    call(who, 'PUT', `/personnel/${person}/photo`, image, { 'content-type': type });
  const decide = (who: string, decision: 'approve' | 'reject') =>
    call(who, 'POST', `/personnel/${person}/photo/decision`, { decision } as never, {
      'content-type': 'application/json',
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
        slug: `exercise-badge-${run}`,
        name: `Exercise badge photo county ${run}`,
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
    subjects['reception'] = as('volunteer_reception');
    subjects['coordinator'] = as('personnel_coordinator');
    subjects['reader'] = as('field_coordinator');
    subjects['volunteer'] = as('field_volunteer');
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      person = (
        await trx
          .insertInto('cg.personnel')
          .values({ tenant_id: county, name: 'Exercise volunteer Rae', agency: 'Exercise CERT' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
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
      fieldCrypto: crypto,
      subjects: loader,
      routes: routesWith({
        personnelPhotos: {
          objects: {
            client: s3 as unknown as import('@aws-sdk/client-s3').S3Client,
            bucket: 'test',
          },
        },
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

  it('BRD:FR-13.01, ADM-05 G4: taken at the desk, re-encoded without metadata, approved only by someone else, printed on the badge; a rejected photo is deleted', async () => {
    // A large photo with camera details.
    const original = await sharp({
      create: { width: 1200, height: 1600, channels: 3, background: '#7a8a99' },
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'Exercise camera', Copyright: 'Exercise' } })
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    expect([403, 404]).toContain((await put('volunteer', original)).status);
    expect((await put('reception', Buffer.from('not an image'), 'image/png')).status).toBe(400);
    const taken = await put('reception', original);
    expect(taken.status, taken.body).toBe(200);
    expect(taken.json<Status>()).toMatchObject({ approved: false, pending: true });
    const [stored] = [...objects.values()];
    const meta = await sharp(stored!).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.width! <= 600 && meta.height! <= 800).toBe(true);

    // Pending: only those who take or approve photos see it; the approved photo does not exist yet.
    expect([403, 404]).toContain(
      (await call('reader', 'GET', `/personnel/${person}/photo?which=pending`)).status,
    );
    const pendingSeen = await call(
      'coordinator',
      'GET',
      `/personnel/${person}/photo?which=pending`,
    );
    expect(pendingSeen.status).toBe(200);
    expect(pendingSeen.type).toBe('image/jpeg');
    expect((await call('reader', 'GET', `/personnel/${person}/photo`)).status).toBe(404);

    // Reception cannot approve at all; the coordinator cannot approve a photo they took.
    expect([403, 404]).toContain((await decide('reception', 'approve')).status);
    const own = await put('coordinator', original);
    expect(own.status, own.body).toBe(200);
    expect((await decide('coordinator', 'approve')).status).toBe(403);
    expect(objects.size).toBe(1); // the replaced pending photo is not kept
    const retaken = await put('reception', original);
    expect(retaken.status).toBe(200);
    const approved = await decide('coordinator', 'approve');
    expect(approved.status, approved.body).toBe(200);
    expect(approved.json<Status>()).toMatchObject({ approved: true, pending: false });
    expect((await decide('coordinator', 'approve')).status).toBe(409);
    const seen = await call('reader', 'GET', `/personnel/${person}/photo`);
    expect(seen.status).toBe(200);
    expect(seen.type).toBe('image/jpeg');

    // The badge prints the approved photo, never one a request names.
    const badge = await call(
      'reception',
      'POST',
      '/badges',
      {
        personnelId: person,
        accessLabel: 'Exercise: field',
        photoKey: 'tenants/elsewhere/x.jpg',
      } as never,
      { 'content-type': 'application/json' },
    );
    expect(badge.status, badge.body).toBe(201);
    const printed = badge.json<{ id: string; photoKey: string | null }>();
    expect(printed.photoKey).toMatch(new RegExp(`^tenants/${county}/personnel/${person}/`));
    const onBadge = await call('reception', 'GET', `/badges/${printed.id}/photo`);
    expect(onBadge.status).toBe(200);
    expect(Buffer.compare(onBadge.raw, seen.raw)).toBe(0);

    // A new photo that is rejected is deleted; the approved one stays.
    await put('reception', original);
    const before = objects.size;
    const rejected = await decide('coordinator', 'reject');
    expect(rejected.json<Status>()).toMatchObject({ approved: true, pending: false });
    expect(objects.size).toBe(before - 1);
    expect((await call('reader', 'GET', `/personnel/${person}/photo`)).status).toBe(200);
  });
});
