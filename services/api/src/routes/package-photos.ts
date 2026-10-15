/**
 * Representative photos for the IDA package (layer-6 task F; DCL:DEC-13,
 * PHO-06, PHO-07, PHO-08, SEC-18). A person who may export the package
 * chooses photos of the event's homes and public damage sites and writes
 * each caption, confirming they looked at the blurred image and saw no face,
 * license plate, document, house number or street sign. Only photos with
 * metadata stripped and sensitive regions blurred by a detector can be
 * chosen, and only their blurred review image is ever shown or exported. A
 * caption naming the home's street address, a unit, an email address or a
 * phone number is refused. Choosing and withdrawing are audited.
 */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  MAX_PACKAGE_PHOTOS,
  eventPhotos,
  placeText,
  type EventPhoto,
  type PhotoPlace,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { iso, uuidParam } from './helpers.ts';

export interface PackagePhotoDeps {
  objects?: { client: Pick<S3Client, 'send'>; presignClient?: S3Client; bucket: string };
}

const place = z.object({
  usng: z.string().nullable(),
  postal: z.string().nullable(),
  tract: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  site: z.string().nullable(),
});

const candidateOut = z.object({
  photoId: z.uuid(),
  subject: z.enum(['home', 'public_site']),
  place,
  placeText: z.string(),
  takenOrUploadedAt: z.iso.datetime().nullable(),
  imageUrl: z.string().nullable(),
});

const chosenOut = z.object({
  id: z.uuid(),
  photoId: z.uuid(),
  caption: z.string(),
  subject: z.enum(['home', 'public_site']).nullable(),
  place: place.nullable(),
  placeText: z.string().nullable(),
  /** Still fit to leave: a photo no longer cleared is left out of the package. */
  cleared: z.boolean(),
  chosenBy: z.string().nullable(),
  chosenAt: z.iso.datetime(),
  imageUrl: z.string().nullable(),
});

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** DEC-13: what a caption must not carry. Returns the problem, or null. */
export function captionProblem(
  caption: string,
  address: { line1: string | null; unit: string | null } | null,
): string | null {
  if (/\S+@\S+\.\S+/.test(caption)) return 'must not include an email address';
  if (/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(caption))
    return 'must not include a phone number';
  const text = ` ${norm(caption)} `;
  const line1 = address?.line1 ? norm(address.line1) : '';
  if (line1) {
    // The whole street line, or its house number with the first word of the street.
    const [number, street] = line1.split(' ');
    if (text.includes(` ${line1} `)) return 'must not include the street address';
    if (number && /\d/.test(number) && street && text.includes(` ${number} ${street} `))
      return 'must not include the street address';
  }
  const unit = address?.unit ? norm(address.unit) : '';
  if (unit && /\d/.test(unit) && text.includes(` ${unit} `)) return 'must not include the unit';
  return null;
}

export const packagePhotoRoutes =
  (deps: PackagePhotoDeps = {}): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    /** Only the blurred review image of a cleared photo is ever signed (PHO-07). */
    const imageUrl = async (p: EventPhoto | undefined) => {
      const objects = deps.objects;
      if (!p?.cleared || !p.reviewKey || !objects) return null;
      return getSignedUrl(
        (objects.presignClient ?? objects.client) as unknown as Parameters<typeof getSignedUrl>[0],
        new GetObjectCommand({ Bucket: objects.bucket, Key: p.reviewKey }),
        { expiresIn: 900 },
      );
    };
    const placeOut = (p: PhotoPlace) => ({ place: p, placeText: placeText(p) });

    app.get(
      '/events/:id/package-photos',
      {
        schema: {
          tags: ['exports'],
          params: uuidParam,
          response: {
            200: z.object({ max: z.number().int(), chosen: z.array(chosenOut) }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        const eventId = request.params.id;
        await request.authorize('declaration.read', {
          type: 'declaration',
          tenantId: s.tenantId,
          eventId,
        });
        const { rows, photos } = await request.tx(async (trx) => {
          const rows = await trx
            .selectFrom('cg.package_photo as pp')
            .leftJoin('cg.account as a', 'a.id', 'pp.chosen_by')
            .select(['pp.id', 'pp.photo_id', 'pp.caption', 'pp.chosen_at', 'a.display_name'])
            .where('pp.event_id', '=', eventId)
            .where('pp.removed_at', 'is', null)
            .orderBy('pp.chosen_at')
            .orderBy('pp.id')
            .execute();
          const photos = await eventPhotos(trx, eventId, {
            photoIds: rows.map((r) => r.photo_id),
          });
          return { rows, photos: new Map(photos.map((p) => [p.photoId, p])) };
        });
        const chosen = [];
        for (const r of rows) {
          const p = photos.get(r.photo_id);
          chosen.push({
            id: r.id,
            photoId: r.photo_id,
            caption: r.caption,
            subject: p?.subject ?? null,
            ...(p ? placeOut(p.place) : { place: null, placeText: null }),
            cleared: !!p?.cleared,
            chosenBy: r.display_name,
            chosenAt: iso(r.chosen_at)!,
            imageUrl: await imageUrl(p),
          });
        }
        return { max: MAX_PACKAGE_PHOTOS, chosen };
      },
    );

    app.get(
      '/events/:id/package-photos/candidates',
      {
        schema: {
          tags: ['exports'],
          params: uuidParam,
          response: { 200: z.array(candidateOut) },
        },
      },
      async (request) => {
        const s = account(request);
        const eventId = request.params.id;
        await request.authorize('declaration.export', {
          type: 'declaration',
          tenantId: s.tenantId,
          eventId,
        });
        const photos = await request.tx(async (trx) => {
          const taken = new Set(
            (
              await trx
                .selectFrom('cg.package_photo')
                .select('photo_id')
                .where('event_id', '=', eventId)
                .where('removed_at', 'is', null)
                .execute()
            ).map((r) => r.photo_id),
          );
          return (await eventPhotos(trx, eventId))
            .filter((p) => p.cleared && !taken.has(p.photoId))
            .slice(0, 100);
        });
        const out = [];
        for (const p of photos)
          out.push({
            photoId: p.photoId,
            subject: p.subject,
            ...placeOut(p.place),
            takenOrUploadedAt: p.takenOrUploadedAt,
            imageUrl: await imageUrl(p),
          });
        return out;
      },
    );

    app.post(
      '/events/:id/package-photos',
      {
        schema: {
          tags: ['exports'],
          params: uuidParam,
          body: z.object({
            photoId: z.uuid(),
            caption: z.string().trim().min(10).max(200),
            /** The chooser looked at the blurred image and saw nothing identifying. */
            checked: z.literal(true),
          }),
          response: { 201: chosenOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const eventId = request.params.id;
        await request.authorize('declaration.export', {
          type: 'declaration',
          tenantId: s.tenantId,
          eventId,
        });
        const b = request.body;
        const { row, photo } = await request.tx(async (trx) => {
          const [photo] = await eventPhotos(trx, eventId, { photoIds: [b.photoId] });
          if (!photo) throw errors.notFound();
          if (!photo.cleared)
            throw new ApiError(
              409,
              'not_cleared',
              'Only a photo with its metadata stripped and faces, plates and documents blurred can leave in the package.',
            );
          const address =
            photo.recordKind === 'report'
              ? await trx
                  .selectFrom('cg.report as r')
                  .innerJoin('cg.location as l', 'l.id', 'r.location_id')
                  .select(['l.line1', 'l.unit'])
                  .where('r.id', '=', photo.recordId)
                  .executeTakeFirst()
              : photo.recordKind === 'assessment'
                ? await trx
                    .selectFrom('cg.field_assessment as r')
                    .innerJoin('cg.location as l', 'l.id', 'r.location_id')
                    .select(['l.line1', 'l.unit'])
                    .where('r.id', '=', photo.recordId)
                    .executeTakeFirst()
                : undefined;
          const problem = captionProblem(b.caption, address ?? null);
          if (problem) throw errors.validation([{ name: 'caption', message: problem }]);
          const held = await trx
            .selectFrom('cg.package_photo')
            .select(['id', 'photo_id'])
            .where('event_id', '=', eventId)
            .where('removed_at', 'is', null)
            .execute();
          if (held.some((h) => h.photo_id === b.photoId))
            throw new ApiError(409, 'already_chosen', 'This photo is already in the package.');
          if (held.length >= MAX_PACKAGE_PHOTOS)
            throw new ApiError(
              409,
              'too_many',
              `A package carries at most ${MAX_PACKAGE_PHOTOS} photos; take one out first.`,
            );
          const event = await trx
            .selectFrom('cg.event')
            .select('tenant_id')
            .where('id', '=', eventId)
            .executeTakeFirstOrThrow();
          const row = await trx
            .insertInto('cg.package_photo')
            .values({
              tenant_id: event.tenant_id,
              event_id: eventId,
              photo_id: b.photoId,
              caption: b.caption,
              checked: true,
              chosen_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'package_photo.choose',
            targetType: 'package_photo',
            targetId: row.id,
            changes: { eventId, photoId: b.photoId, caption: b.caption, checked: true },
          });
          return { row, photo };
        });
        return reply.code(201).send({
          id: row.id,
          photoId: row.photo_id,
          caption: row.caption,
          subject: photo.subject,
          ...placeOut(photo.place),
          cleared: photo.cleared,
          chosenBy: null,
          chosenAt: iso(row.chosen_at)!,
          imageUrl: await imageUrl(photo),
        });
      },
    );

    app.delete(
      '/events/:id/package-photos/:choiceId',
      {
        schema: {
          tags: ['exports'],
          params: z.object({ id: z.uuid(), choiceId: z.uuid() }),
          response: { 204: z.null() },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const { id: eventId, choiceId } = request.params;
        await request.authorize('declaration.export', {
          type: 'declaration',
          tenantId: s.tenantId,
          eventId,
        });
        await request.tx(async (trx) => {
          const removed = await trx
            .updateTable('cg.package_photo')
            .set({ removed_at: new Date(), removed_by: s.accountId })
            .where('id', '=', choiceId)
            .where('event_id', '=', eventId)
            .where('removed_at', 'is', null)
            .returning(['id', 'photo_id'])
            .executeTakeFirst();
          if (!removed) throw errors.notFound();
          await request.audit(trx, {
            action: 'package_photo.remove',
            targetType: 'package_photo',
            targetId: removed.id,
            changes: { eventId, photoId: removed.photo_id },
          });
        });
        return reply.code(204).send(null);
      },
    );
  };
