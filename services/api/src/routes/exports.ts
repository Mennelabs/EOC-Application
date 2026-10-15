/**
 * Exports (layer-6 task F; DCL:DEC-11, DEC-12, DEC-13, F15, SEC-13, SEC-18,
 * GATE-07): staff ask for the IDA package of an event (optionally one
 * jurisdiction in it) or for an issued official report as PDF or CSV; the
 * worker builds the file into object storage and records its size, SHA-256,
 * the FEMA form and mapping versions used and the totals it carries. The
 * request, the result and every download are in the audit chain. A report
 * export is drawn from the frozen snapshot, never from today's records.
 */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { ExportFileTable } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { enqueueOutbox, iso, uuidParam } from './helpers.ts';

export interface ExportDeps {
  objects?: { client: Pick<S3Client, 'send'>; bucket: string };
}

type Row = Selectable<ExportFileTable>;

const exportOut = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  kind: z.enum(['ida_package', 'official_report']),
  format: z.enum(['zip', 'pdf', 'csv']),
  reportId: z.uuid().nullable(),
  jurisdictionTenantId: z.uuid().nullable(),
  status: z.enum(['queued', 'ready', 'failed']),
  fileName: z.string().nullable(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  mappings: z.unknown(),
  figures: z.unknown(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  readyAt: z.iso.datetime().nullable(),
});

const view = (r: Row): z.infer<typeof exportOut> => ({
  id: r.id,
  eventId: r.event_id,
  kind: r.kind,
  format: r.format,
  reportId: r.report_id,
  jurisdictionTenantId: r.jurisdiction_tenant_id,
  status: r.status,
  fileName: r.file_name,
  bytes: r.bytes === null ? null : Number(r.bytes),
  sha256: r.sha256,
  mappings: r.mappings,
  figures: r.figures,
  error: r.error,
  createdAt: iso(r.created_at)!,
  readyAt: iso(r.ready_at),
});

const CONTENT_TYPE: Record<Row['format'], string> = {
  zip: 'application/zip',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
};

export const exportRoutes =
  (deps: ExportDeps = {}): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    /** Who may see an export: the readers of what it holds. */
    const readAction = (r: Row) =>
      r.kind === 'ida_package' ? ('declaration.read' as const) : ('official_report.read' as const);
    const exportAction = (r: Row) =>
      r.kind === 'ida_package'
        ? ('declaration.export' as const)
        : ('official_report.export' as const);

    const load = async (request: FastifyRequest, id: string) => {
      const row = await request.tx((trx) =>
        trx.selectFrom('cg.export_file').selectAll().where('id', '=', id).executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      return row;
    };

    // ------------------------------------------------------------ the IDA package
    app.post(
      '/events/:id/exports',
      {
        schema: {
          tags: ['exports'],
          params: uuidParam,
          body: z.object({
            clientUuid: z.uuid(),
            /** Limit the homes and public sites to one jurisdiction (DEC-11). */
            jurisdictionTenantId: z.uuid().optional(),
            reason: z.string().trim().max(500).optional(),
          }),
          response: { 201: exportOut, 200: exportOut },
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
        const { row, created } = await request.tx(async (trx) => {
          const held = await trx
            .selectFrom('cg.export_file')
            .selectAll()
            .where('client_uuid', '=', b.clientUuid)
            .executeTakeFirst();
          if (held) return { row: held, created: false };
          const event = await trx
            .selectFrom('cg.event')
            .select(['id', 'tenant_id'])
            .where('id', '=', eventId)
            .executeTakeFirst();
          if (!event) throw errors.notFound();
          if (b.jurisdictionTenantId) {
            const j = await trx
              .selectFrom('cg.tenant')
              .select('kind')
              .where('id', '=', b.jurisdictionTenantId)
              .executeTakeFirst();
            if (!j || (j.kind !== 'county' && j.kind !== 'city'))
              throw errors.validation([
                { name: 'jurisdictionTenantId', message: 'not a county or city you can see' },
              ]);
          }
          const inserted = await trx
            .insertInto('cg.export_file')
            .values({
              tenant_id: event.tenant_id,
              event_id: eventId,
              client_uuid: b.clientUuid,
              kind: 'ida_package',
              format: 'zip',
              jurisdiction_tenant_id: b.jurisdictionTenantId ?? null,
              requested_by: s.accountId,
              reason: b.reason ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await enqueueOutbox(
            trx,
            event.tenant_id,
            'export.requested',
            { exportId: inserted.id },
            request.executionId,
          );
          await request.audit(trx, {
            action: 'declaration.export',
            targetType: 'export_file',
            targetId: inserted.id,
            changes: {
              kind: 'ida_package',
              eventId,
              jurisdictionTenantId: b.jurisdictionTenantId ?? null,
            },
            reason: b.reason ?? null,
          });
          return { row: inserted, created: true };
        });
        return reply.code(created ? 201 : 200).send(view(row));
      },
    );

    // ------------------------------------------------------------ an issued report
    app.post(
      '/official-reports/:id/exports',
      {
        schema: {
          tags: ['exports'],
          params: uuidParam,
          body: z.object({
            clientUuid: z.uuid(),
            format: z.enum(['pdf', 'csv']),
            reason: z.string().trim().max(500).optional(),
          }),
          response: { 201: exportOut, 200: exportOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        await request.authorize(
          'official_report.export',
          { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        const b = request.body;
        const { row, created } = await request.tx(async (trx) => {
          const held = await trx
            .selectFrom('cg.export_file')
            .selectAll()
            .where('client_uuid', '=', b.clientUuid)
            .executeTakeFirst();
          if (held) return { row: held, created: false };
          const report = await trx
            .selectFrom('cg.official_report')
            .select(['id', 'tenant_id', 'event_id', 'state'])
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!report) throw errors.notFound();
          // RULE-10: only what was issued is exported, from its frozen copy.
          if (report.state !== 'issued' && report.state !== 'superseded')
            throw new ApiError(409, 'not_issued', 'Only an issued report is exported.');
          const inserted = await trx
            .insertInto('cg.export_file')
            .values({
              tenant_id: report.tenant_id,
              event_id: report.event_id,
              client_uuid: b.clientUuid,
              kind: 'official_report',
              format: b.format,
              report_id: report.id,
              requested_by: s.accountId,
              reason: b.reason ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await enqueueOutbox(
            trx,
            report.tenant_id,
            'export.requested',
            { exportId: inserted.id },
            request.executionId,
          );
          await request.audit(trx, {
            action: 'official_report.export',
            targetType: 'export_file',
            targetId: inserted.id,
            changes: { kind: 'official_report', reportId: report.id, format: b.format },
            reason: b.reason ?? null,
          });
          return { row: inserted, created: true };
        });
        return reply.code(created ? 201 : 200).send(view(row));
      },
    );

    // ------------------------------------------------------------ lists and status
    app.get(
      '/events/:id/exports',
      {
        schema: { tags: ['exports'], params: uuidParam, response: { 200: z.array(exportOut) } },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('declaration.read', {
          type: 'declaration',
          tenantId: s.tenantId,
          eventId: request.params.id,
        });
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.export_file')
            .selectAll()
            .where('event_id', '=', request.params.id)
            .where('kind', '=', 'ida_package')
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute(),
        );
        return rows.map(view);
      },
    );

    app.get(
      '/official-reports/:id/exports',
      {
        schema: { tags: ['exports'], params: uuidParam, response: { 200: z.array(exportOut) } },
      },
      async (request) => {
        const s = account(request);
        await request.authorize(
          'official_report.read',
          { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.export_file')
            .selectAll()
            .where('report_id', '=', request.params.id)
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute(),
        );
        return rows.map(view);
      },
    );

    app.get(
      '/exports/:id',
      { schema: { tags: ['exports'], params: uuidParam, response: { 200: exportOut } } },
      async (request) => {
        const s = account(request);
        const row = await load(request, request.params.id);
        await request.authorize(
          readAction(row),
          { type: 'export_file', id: row.id, tenantId: s.tenantId, eventId: row.event_id },
          { asNotFound: true },
        );
        return view(row);
      },
    );

    // ------------------------------------------------------------ download (SEC-18)
    app.get(
      '/exports/:id/file',
      { schema: { tags: ['exports'], params: uuidParam } },
      async (request, reply) => {
        const s = account(request);
        const row = await load(request, request.params.id);
        await request.authorize(
          exportAction(row),
          { type: 'export_file', id: row.id, tenantId: s.tenantId, eventId: row.event_id },
          { asNotFound: true },
        );
        if (row.status !== 'ready' || !row.object_key)
          throw new ApiError(
            409,
            'not_ready',
            row.status === 'failed' ? 'This export failed.' : 'This export is still being made.',
          );
        if (!deps.objects)
          throw new ApiError(503, 'storage_unavailable', 'File storage is not available.');
        const obj = await deps.objects.client.send(
          new GetObjectCommand({ Bucket: deps.objects.bucket, Key: row.object_key }),
        );
        const bytes = await obj.Body?.transformToByteArray();
        if (!bytes) throw new ApiError(503, 'storage_unavailable', 'The file could not be read.');
        await request.tx((trx) =>
          request.audit(trx, {
            action: 'export.download',
            targetType: 'export_file',
            targetId: row.id,
            changes: { kind: row.kind, format: row.format, sha256: row.sha256 },
          }),
        );
        return reply
          .header('content-type', CONTENT_TYPE[row.format])
          .header(
            'content-disposition',
            `attachment; filename="${row.file_name ?? `export.${row.format}`}"`,
          )
          .header('x-content-sha256', row.sha256 ?? '')
          .send(Buffer.from(bytes));
      },
    );
  };
