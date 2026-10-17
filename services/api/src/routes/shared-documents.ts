/**
 * Documents a survivor chooses to share (FL-09). A worker who has found the
 * survivor's report asks, in the survivor's language, whether they may
 * photograph a document (a lease, an ID, an insurance letter) into their
 * record; only when the survivor says or taps yes does the app open the
 * camera. The photo goes from the camera straight to the server, never into
 * the phone's photo library, and is processed like any photo (metadata
 * stripped, derivatives made) except that it is never sent to an AI service.
 *
 * Each document keeps the words the survivor agreed to, how they agreed, who
 * took it and when. It is linked to the report through its own record, never
 * as one of the report's damage photos, so it does not appear in the review
 * gallery or a FEMA package. Only holders of `document.read` who may read the
 * report see it, and every view is audited.
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { decide } from '@cg/authz';
import { ApiError, errors } from '../errors.ts';
import type { ReportDeps } from './reports.ts';
import { enqueueOutbox, iso, uuidParam } from './helpers.ts';

const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
const KINDS = ['lease', 'id', 'insurance', 'other'] as const;
const MAX_BYTES = 8 * 1024 * 1024;

const documentOut = z.object({
  id: z.uuid(),
  kind: z.enum(KINDS),
  consentMethod: z.enum(['spoken', 'tapped']),
  consentLanguage: z.string(),
  consentText: z.string(),
  consentedAt: z.iso.datetime(),
  takenBy: z.string().nullable(),
  status: z.string(),
  viewUrl: z.string().nullable(),
});

export const sharedDocumentRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const deps = (): ReportDeps => (app.hasDecorator('reportDeps') ? app.reportDeps : {});
  app.addContentTypeParser(
    [...imageTypes],
    { parseAs: 'buffer', bodyLimit: MAX_BYTES + 1024 },
    (_req, body, done) => done(null, body),
  );
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const storage = () => {
    const objects = deps().objects;
    if (!objects)
      throw new ApiError(503, 'photos_unavailable', 'Photos cannot be taken right now.', {
        retryable: true,
      });
    return objects;
  };
  /** The report, only if this person may read it; anything else is "not found". */
  const readableReport = async (request: FastifyRequest, id: string) => {
    const s = account(request);
    const r = await request.tx((trx) =>
      trx
        .selectFrom('cg.report')
        .select(['id', 'tenant_id', 'event_id', 'withdrawn_at'])
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    const may =
      r &&
      decide(s, 'report.read', {
        type: 'report',
        tenantId: r.tenant_id,
        ...(r.event_id ? { eventId: r.event_id } : {}),
      }).effect === 'allow';
    if (!r || !may) throw errors.notFound();
    return r;
  };

  app.post(
    '/reports/:id/documents',
    {
      schema: {
        tags: ['frontline'],
        params: uuidParam,
        body: z.object({
          clientUuid: z.uuid(),
          kind: z.enum(KINDS),
          consent: z.object({
            method: z.enum(['spoken', 'tapped']),
            language: z.string().min(2).max(10),
            /** The question the survivor answered yes to, as it was shown or read to them. */
            text: z.string().trim().min(10).max(1000),
          }),
          contentType: z.enum(imageTypes),
          bytes: z.number().int().positive(),
        }),
        response: {
          201: z.object({ documentId: z.uuid(), uploadPath: z.string(), status: z.string() }),
          200: z.object({ documentId: z.uuid(), uploadPath: z.string(), status: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('document.capture', { type: 'report', tenantId: s.tenantId });
      const report = await readableReport(request, request.params.id);
      if (report.withdrawn_at)
        throw new ApiError(409, 'report_withdrawn', 'The resident withdrew this report.');
      storage();
      const b = request.body;
      if (b.bytes > MAX_BYTES)
        throw new ApiError(413, 'photo_too_large', 'Photos must be under 8 MB.');
      const { doc, status, created } = await request.tx(async (trx) => {
        const held = await trx
          .selectFrom('cg.shared_document as d')
          .innerJoin('cg.photo as p', 'p.id', 'd.photo_id')
          .select(['d.id', 'p.status'])
          .where('d.client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (held) return { doc: held.id, status: held.status, created: false };
        const photo = await trx
          .insertInto('cg.photo')
          .values({
            tenant_id: report.tenant_id,
            execution_id: b.clientUuid,
            shot: 'document',
            source: 'field',
            object_key_original: '',
            content_type: b.contentType,
            bytes: b.bytes,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning(['id', 'status'])
          .executeTakeFirstOrThrow();
        const doc = await trx
          .insertInto('cg.shared_document')
          .values({
            tenant_id: report.tenant_id,
            report_id: report.id,
            client_uuid: b.clientUuid,
            kind: b.kind,
            consent_method: b.consent.method,
            consent_language: b.consent.language,
            consent_text: b.consent.text,
            taken_by: s.accountId,
            photo_id: photo.id,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('cg.photo')
          .set({
            object_key_original: `tenants/${report.tenant_id}/documents/${doc.id}/${photo.id}`,
            field_record_type: 'shared_document',
            field_record_id: doc.id,
          })
          .where('id', '=', photo.id)
          .execute();
        await request.audit(trx, {
          action: 'document.capture',
          targetType: 'shared_document',
          targetId: doc.id,
          changes: {
            fields: [
              { name: 'report', to: report.id },
              { name: 'kind', to: b.kind },
              { name: 'consent', to: `${b.consent.method} (${b.consent.language})` },
            ],
          },
        });
        return { doc: doc.id, status: photo.status, created: true };
      });
      return reply
        .code(created ? 201 : 200)
        .send({ documentId: doc, uploadPath: `/api/v1/documents/${doc}/content`, status });
    },
  );

  app.put(
    '/documents/:id/content',
    { bodyLimit: MAX_BYTES + 1024, schema: { tags: ['frontline'], params: uuidParam } },
    async (request) => {
      const s = account(request);
      await request.authorize('document.capture', { type: 'report', tenantId: s.tenantId });
      const objects = storage();
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0)
        throw new ApiError(400, 'validation_failed', 'Send the photo itself as the request body.');
      if (body.length > MAX_BYTES)
        throw new ApiError(413, 'photo_too_large', 'That photo is too large.');
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.shared_document as d')
          .innerJoin('cg.photo as p', 'p.id', 'd.photo_id')
          .select([
            'd.id',
            'p.id as photo_id',
            'p.status',
            'p.object_key_original',
            'p.content_type',
            'p.execution_id',
            'p.tenant_id',
          ])
          .where('d.id', '=', request.params.id)
          // Only the person who asked the survivor sends the photo.
          .where('d.taken_by', '=', s.accountId)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      if (row.status !== 'uploading') return { documentId: row.id, status: row.status };
      await objects.client.send(
        new PutObjectCommand({
          Bucket: objects.bucket,
          Key: row.object_key_original,
          Body: body,
          ...(row.content_type ? { ContentType: row.content_type } : {}),
        }),
      );
      await request.tx(async (trx) => {
        await trx
          .updateTable('cg.photo')
          .set({ status: 'uploaded', bytes: body.length, uploaded_at: new Date() })
          .where('id', '=', row.photo_id)
          .where('status', '=', 'uploading')
          .execute();
        await enqueueOutbox(
          trx,
          row.tenant_id,
          'photo.process',
          { photoId: row.photo_id },
          row.execution_id,
        );
      });
      return { documentId: row.id, status: 'uploaded' };
    },
  );

  app.get(
    '/reports/:id/documents',
    {
      schema: {
        tags: ['frontline'],
        params: uuidParam,
        response: { 200: z.array(documentOut) },
      },
    },
    async (request) => {
      const report = await readableReport(request, request.params.id);
      await request.authorize(
        'document.read',
        {
          type: 'report',
          tenantId: report.tenant_id,
          ...(report.event_id ? { eventId: report.event_id } : {}),
        },
        { asNotFound: true },
      );
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.shared_document as d')
          .innerJoin('cg.photo as p', 'p.id', 'd.photo_id')
          .leftJoin('cg.account as a', 'a.id', 'd.taken_by')
          .select([
            'd.id',
            'd.kind',
            'd.consent_method',
            'd.consent_language',
            'd.consent_text',
            'd.consented_at',
            'a.display_name',
            'p.status',
            'p.derivative_keys',
          ])
          .where('d.report_id', '=', report.id)
          .orderBy('d.consented_at')
          .execute(),
      );
      const objects = deps().objects;
      const sign = async (key: string | undefined) =>
        key && objects
          ? getSignedUrl(
              (objects.presignClient ?? objects.client) as unknown as Parameters<
                typeof getSignedUrl
              >[0],
              new GetObjectCommand({ Bucket: objects.bucket, Key: key }),
              { expiresIn: 300 },
            )
          : null;
      const out: z.infer<typeof documentOut>[] = [];
      for (const r of rows) {
        const keys = (r.derivative_keys ?? {}) as Record<string, string>;
        out.push({
          id: r.id,
          kind: r.kind,
          consentMethod: r.consent_method,
          consentLanguage: r.consent_language,
          consentText: r.consent_text,
          consentedAt: iso(r.consented_at)!,
          takenBy: r.display_name,
          status: r.status,
          viewUrl: r.status === 'processed' ? await sign(keys['review']) : null,
        });
      }
      if (out.length)
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'document.read',
            targetType: 'report',
            targetId: report.id,
            classificationRead: ['evidence'],
            changes: { fields: [{ name: 'documents', to: out.length }] },
          }),
        );
      return out;
    },
  );
};
