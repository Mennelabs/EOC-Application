/**
 * Badge photos (BRD:FR-13.01, FR-13.04, BDG-01): a photo is taken at the
 * desk or uploaded and waits as pending; a second person approves it (the
 * one who took it cannot, ADM-05 G4) or rejects it. Only the approved photo
 * is printed on a badge, which keeps the photo it was generated with. The
 * image is decoded and re-encoded as a JPEG on upload, which drops its
 * location and camera details and anything that is not pixels. Photos are
 * served only through these routes, to roles that read the person (or,
 * while pending, to those who take or approve photos), never from a
 * storage link.
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import sharp from 'sharp';
import { z } from 'zod';
import { ApiError, errors } from '../errors.ts';
import { iso, uuidParam } from './helpers.ts';

export interface PersonnelPhotoDeps {
  objects?: { client: S3Client; bucket: string } | undefined;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_BYTES = 8 * 1024 * 1024;

const statusOut = z.object({
  personnelId: z.uuid(),
  approved: z.boolean(),
  approvedAt: z.iso.datetime().nullable(),
  pending: z.boolean(),
  pendingAt: z.iso.datetime().nullable(),
  pendingBy: z.uuid().nullable(),
});

export const personnelPhotoRoutes =
  (deps: PersonnelPhotoDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    app.addContentTypeParser(
      [...IMAGE_TYPES],
      { parseAs: 'buffer', bodyLimit: MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    const storage = () => {
      if (!deps.objects)
        throw new ApiError(503, 'photos_unavailable', 'Photos cannot be stored right now.', {
          retryable: true,
        });
      return deps.objects;
    };
    const load = (request: FastifyRequest, id: string) =>
      request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .select([
            'id',
            'tenant_id',
            'photo_key',
            'photo_approved_at',
            'photo_pending_key',
            'photo_pending_by',
            'photo_pending_at',
          ])
          .where('id', '=', id)
          .executeTakeFirst(),
      );
    type Person = NonNullable<Awaited<ReturnType<typeof load>>>;
    const status = (p: Person): z.infer<typeof statusOut> => ({
      personnelId: p.id,
      approved: !!p.photo_key,
      approvedAt: iso(p.photo_approved_at),
      pending: !!p.photo_pending_key,
      pendingAt: iso(p.photo_pending_at),
      pendingBy: p.photo_pending_by,
    });
    async function send(reply: FastifyReply, key: string) {
      const { client, bucket } = storage();
      const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = Buffer.from(await obj.Body!.transformToByteArray());
      return reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'no-store')
        .send(bytes);
    }
    async function remove(key: string | null) {
      if (!key || !deps.objects) return;
      await deps.objects.client
        .send(new DeleteObjectCommand({ Bucket: deps.objects.bucket, Key: key }))
        .catch(() => undefined);
    }

    // FR-13.04: take or upload the photo; it waits for a second person.
    app.put(
      '/personnel/:id/photo',
      { schema: { tags: ['personnel'], params: uuidParam, response: { 200: statusOut } } },
      async (request) => {
        const s = account(request);
        const person = await load(request, request.params.id);
        if (!person) throw errors.notFound();
        await request.authorize(
          'personnel.photo',
          { type: 'personnel', id: person.id, tenantId: person.tenant_id },
          { asNotFound: true },
        );
        const type = String(request.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim();
        if (!(IMAGE_TYPES as readonly string[]).includes(type) || !Buffer.isBuffer(request.body))
          throw errors.validation([{ name: 'photo', message: 'send a JPEG, PNG or WebP image' }]);
        let jpeg: Buffer;
        try {
          // Re-encoded: orientation applied, metadata (location, camera) dropped, a badge-sized picture.
          jpeg = await sharp(request.body)
            .rotate()
            .resize({ width: 600, height: 800, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch {
          throw errors.validation([{ name: 'photo', message: 'this image could not be read' }]);
        }
        const { client, bucket } = storage();
        const key = `tenants/${person.tenant_id}/personnel/${person.id}/photo-${randomUUID()}.jpg`;
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: jpeg, ContentType: 'image/jpeg' }),
        );
        const updated = await request.tx(async (trx) => {
          const row = await trx
            .updateTable('cg.personnel')
            .set({
              photo_pending_key: key,
              photo_pending_by: s.accountId,
              photo_pending_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', person.id)
            .returning([
              'id',
              'tenant_id',
              'photo_key',
              'photo_approved_at',
              'photo_pending_key',
              'photo_pending_by',
              'photo_pending_at',
            ])
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'personnel.photo',
            targetType: 'personnel',
            targetId: person.id,
            changes: { fields: [{ name: 'photo', to: 'pending' }] },
          });
          return row;
        });
        // A photo replaced before anyone approved it is not kept.
        await remove(person.photo_pending_key);
        return status(updated);
      },
    );

    // FR-13.01: a second person approves or rejects the pending photo.
    app.post(
      '/personnel/:id/photo/decision',
      {
        schema: {
          tags: ['personnel'],
          params: uuidParam,
          body: z.object({
            decision: z.enum(['approve', 'reject']),
            reason: z.string().max(300).optional(),
          }),
          response: { 200: statusOut },
        },
      },
      async (request) => {
        const s = account(request);
        const person = await load(request, request.params.id);
        if (!person) throw errors.notFound();
        await request.authorize(
          'personnel.photo.approve',
          {
            type: 'personnel',
            id: person.id,
            tenantId: person.tenant_id,
            ...(person.photo_pending_by ? { recordedBy: person.photo_pending_by } : {}),
          },
          { asNotFound: true },
        );
        if (!person.photo_pending_key)
          throw new ApiError(409, 'no_pending_photo', 'There is no photo waiting for approval.');
        const approve = request.body.decision === 'approve';
        const updated = await request.tx(async (trx) => {
          const row = await trx
            .updateTable('cg.personnel')
            .set({
              ...(approve
                ? {
                    photo_key: person.photo_pending_key,
                    photo_approved_by: s.accountId,
                    photo_approved_at: new Date(),
                  }
                : {}),
              photo_pending_key: null,
              photo_pending_by: null,
              photo_pending_at: null,
              updated_by: s.accountId,
            })
            .where('id', '=', person.id)
            .where('photo_pending_key', '=', person.photo_pending_key)
            .returning([
              'id',
              'tenant_id',
              'photo_key',
              'photo_approved_at',
              'photo_pending_key',
              'photo_pending_by',
              'photo_pending_at',
            ])
            .executeTakeFirst();
          if (!row) throw errors.conflict(status(person));
          await request.audit(trx, {
            action: 'personnel.photo.approve',
            targetType: 'personnel',
            targetId: person.id,
            reason: request.body.reason ?? null,
            changes: {
              fields: [{ name: 'photo', from: 'pending', to: approve ? 'approved' : 'rejected' }],
            },
          });
          return row;
        });
        // A rejected photo is not kept. An approved one replaces the last, which stays for the
        // badges already printed with it until the person's record is swept (SEC-13).
        if (!approve) await remove(person.photo_pending_key);
        return status(updated);
      },
    );

    app.get(
      '/personnel/:id/photo/status',
      { schema: { tags: ['personnel'], params: uuidParam, response: { 200: statusOut } } },
      async (request) => {
        const person = await load(request, request.params.id);
        if (!person) throw errors.notFound();
        await request.authorize(
          'personnel.read',
          { type: 'personnel', id: person.id, tenantId: person.tenant_id },
          { asNotFound: true },
        );
        return status(person);
      },
    );

    // The approved photo for anyone who reads the person; a pending one only for those who take
    // or approve photos.
    app.get(
      '/personnel/:id/photo',
      {
        schema: {
          tags: ['personnel'],
          params: uuidParam,
          querystring: z.object({ which: z.enum(['approved', 'pending']).default('approved') }),
        },
      },
      async (request, reply) => {
        const person = await load(request, request.params.id);
        if (!person) throw errors.notFound();
        const resource = { type: 'personnel', id: person.id, tenantId: person.tenant_id };
        if (request.query.which === 'pending') {
          const may = await request.authorize('personnel.photo.approve', resource).then(
            () => true,
            () => false,
          );
          if (!may) await request.authorize('personnel.photo', resource, { asNotFound: true });
          if (!person.photo_pending_key) throw errors.notFound();
          return send(reply, person.photo_pending_key);
        }
        await request.authorize('personnel.read', resource, { asNotFound: true });
        if (!person.photo_key) throw errors.notFound();
        return send(reply, person.photo_key);
      },
    );

    // FR-13.04: the photo printed on a badge, the one it was generated with.
    app.get(
      '/badges/:id/photo',
      { schema: { tags: ['field'], params: uuidParam } },
      async (request, reply) => {
        const s = account(request);
        const badge = await request.tx((trx) =>
          trx
            .selectFrom('cg.badge')
            .select(['id', 'photo_key'])
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!badge) throw errors.notFound();
        await request.authorize(
          'badge.read',
          { type: 'badge', id: badge.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        if (!badge.photo_key) throw errors.notFound();
        return send(reply, badge.photo_key);
      },
    );
  };
