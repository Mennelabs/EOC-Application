/**
 * Reference data (layer-6 task A; ADR-0039, SCL-09, SCL-13, RULE-10,
 * SCL-06): what each dataset is filled from, the snapshot in use with its
 * age, the last attempt, "pull now", and file imports for every dataset.
 *
 * An import is a small state machine, each step saved and resumable:
 * the console asks for an import with its own id (a resend answers the same
 * import, FR-00.06), sends the file's bytes (CSV or GeoJSON; the columns
 * found come back), saves a column mapping (the worker validates it and
 * reports errors by row and field), then applies it (the worker writes a
 * snapshot that becomes current). Only the worker writes snapshots. The
 * files are public reference data, never resident records.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import { connectors, DATASETS, importFields, parseCsv, type Dataset } from '@cg/refdata';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, enqueueOutbox, iso, uuidParam } from './helpers.ts';

export interface RefdataDeps {
  objects?:
    | {
        client: S3Client;
        bucket: string;
        /** Largest file accepted (default 50 MB). */
        maxImportBytes?: number;
      }
    | undefined;
}

const dataset = z.enum(DATASETS);
const importTypes = ['text/csv', 'application/geo+json', 'application/octet-stream'] as const;

const snapshotOut = z.object({
  id: z.uuid(),
  dataset,
  source: z.string(),
  mode: z.enum(['pull', 'recorded', 'import']),
  status: z.enum(['loading', 'ready', 'failed', 'superseded']),
  vintage: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  licence: z.string(),
  rowCount: z.number().int(),
  checksum: z.string().nullable(),
  error: z.string().nullable(),
  retrievedAt: z.iso.datetime(),
  readyAt: z.iso.datetime().nullable(),
  cited: z.boolean(),
  importId: z.uuid().nullable(),
});

const importOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  dataset,
  fileName: z.string(),
  format: z.enum(['csv', 'geojson']),
  bytes: z.number().int(),
  columns: z.array(z.string()),
  fields: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['number', 'boolean', 'list', 'object', 'text']),
      required: z.boolean(),
    }),
  ),
  mapping: z.record(z.string(), z.string()),
  vintage: z.string().nullable(),
  licence: z.string(),
  status: z.enum([
    'uploading',
    'uploaded',
    'validating',
    'validated',
    'invalid',
    'applying',
    'applied',
    'failed',
  ]),
  errors: z.array(
    z.object({
      row: z.number().int().optional(),
      field: z.string().optional(),
      message: z.string(),
    }),
  ),
  rowCount: z.number().int(),
  snapshotId: z.uuid().nullable(),
  uploadPath: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

type SnapshotRow = {
  id: string;
  dataset: Dataset;
  source: string;
  mode: 'pull' | 'recorded' | 'import';
  status: 'loading' | 'ready' | 'failed' | 'superseded';
  vintage: string | null;
  source_url: string | null;
  licence: string;
  row_count: number;
  checksum: string | null;
  error: string | null;
  retrieved_at: Date;
  ready_at: Date | null;
  cited: boolean;
  import_id: string | null;
};

function snapshotView(r: SnapshotRow): z.infer<typeof snapshotOut> {
  return {
    id: r.id,
    dataset: r.dataset,
    source: r.source,
    mode: r.mode,
    status: r.status,
    vintage: r.vintage,
    sourceUrl: r.source_url,
    licence: r.licence,
    rowCount: r.row_count,
    checksum: r.checksum,
    error: r.error,
    retrievedAt: iso(r.retrieved_at)!,
    readyAt: iso(r.ready_at),
    cited: r.cited,
    importId: r.import_id,
  };
}

type ImportRow = {
  id: string;
  version: number;
  dataset: Dataset;
  file_name: string;
  format: 'csv' | 'geojson';
  bytes: number;
  columns: string[];
  mapping: Record<string, string>;
  vintage: string | null;
  licence: string;
  status: z.infer<typeof importOut>['status'];
  errors: { row?: number; field?: string; message: string }[];
  row_count: number;
  snapshot_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function importView(r: ImportRow): z.infer<typeof importOut> {
  return {
    id: r.id,
    version: r.version,
    dataset: r.dataset,
    fileName: r.file_name,
    format: r.format,
    bytes: r.bytes,
    columns: r.columns,
    fields: importFields(r.dataset),
    mapping: r.mapping,
    vintage: r.vintage,
    licence: r.licence,
    status: r.status,
    errors: r.errors,
    rowCount: r.row_count,
    snapshotId: r.snapshot_id,
    uploadPath: `/api/v1/refdata/imports/${r.id}/content`,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

/** Column names in a file: a CSV's header, or the properties of a GeoJSON file's first features. */
export function columnsOf(format: 'csv' | 'geojson', text: string): string[] | null {
  if (format === 'csv') {
    const firstLines = text.slice(0, 64 * 1024);
    const header = parseCsv(firstLines)[0];
    return header && header.length ? header.map((h) => h.trim()) : null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  const features = (doc as { type?: unknown; features?: unknown }).features;
  if ((doc as { type?: unknown }).type !== 'FeatureCollection' || !Array.isArray(features))
    return null;
  const names = new Set<string>();
  for (const f of features.slice(0, 100)) {
    const props = (f as { properties?: unknown }).properties;
    if (props && typeof props === 'object') for (const k of Object.keys(props)) names.add(k);
  }
  return [...names];
}

export const refdataRoutes =
  (deps: RefdataDeps = {}): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();
    const maxBytes = deps.objects?.maxImportBytes ?? 50 * 1024 * 1024;

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    const target = (tenantId: string) => ({ type: 'refdata_snapshot', tenantId });

    app.addContentTypeParser(
      [...importTypes],
      { parseAs: 'buffer', bodyLimit: maxBytes + 1024 },
      (_req, body, done) => done(null, body),
    );

    app.get(
      '/refdata/sources',
      {
        schema: {
          tags: ['refdata'],
          response: {
            200: z.array(
              z.object({
                dataset,
                sources: z.array(
                  z.object({
                    id: z.string(),
                    title: z.string(),
                    licence: z.string(),
                    hosts: z.array(z.string()),
                    refreshHours: z.number(),
                  }),
                ),
                current: snapshotOut.nullable(),
                ageHours: z.number().nullable(),
                lastAttempt: snapshotOut.nullable(),
              }),
            ),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('refdata.read', target(s.tenantId));
        const { current, latest } = await request.tx(async (trx) => ({
          current: await trx
            .selectFrom('cg.refdata_current as c')
            .innerJoin('cg.refdata_snapshot as s', 's.id', 'c.snapshot_id')
            .selectAll('s')
            .where('c.tenant_id', '=', s.tenantId)
            .execute(),
          latest: await sql<SnapshotRow>`
            select distinct on (dataset) * from cg.refdata_snapshot
            where tenant_id = ${s.tenantId}
            order by dataset, retrieved_at desc`.execute(trx),
        }));
        const now = Date.now();
        return DATASETS.map((d) => {
          const cur = current.find((c) => c.dataset === d) as SnapshotRow | undefined;
          const last = latest.rows.find((l) => l.dataset === d);
          return {
            dataset: d,
            sources: connectors
              .filter((c) => c.dataset === d)
              .map((c) => ({
                id: c.id,
                title: c.title,
                licence: c.licence,
                hosts: [...c.hosts],
                refreshHours: Math.round(c.refreshMs / 3600_000),
              })),
            current: cur ? snapshotView(cur) : null,
            ageHours: cur
              ? Math.round(((now - new Date(cur.retrieved_at).getTime()) / 3600_000) * 10) / 10
              : null,
            lastAttempt: last ? snapshotView(last) : null,
          };
        });
      },
    );

    app.get(
      '/refdata/snapshots',
      {
        schema: {
          tags: ['refdata'],
          querystring: z.object({
            dataset: dataset.optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: { 200: z.array(snapshotOut) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('refdata.read', target(s.tenantId));
        const rows = await request.tx((trx) => {
          let q = trx
            .selectFrom('cg.refdata_snapshot')
            .selectAll()
            .where('tenant_id', '=', s.tenantId)
            .orderBy('retrieved_at', 'desc')
            .limit(request.query.limit);
          if (request.query.dataset) q = q.where('dataset', '=', request.query.dataset);
          return q.execute();
        });
        return rows.map((r) => snapshotView(r as SnapshotRow));
      },
    );

    app.post(
      '/refdata/pull',
      {
        config: { idempotent: true },
        schema: {
          tags: ['refdata'],
          body: z.object({ dataset }),
          response: { 202: z.object({ dataset, queued: z.literal(true) }) },
        },
      },
      async (request, reply) => {
        const s = account(request);
        await request.authorize('refdata.manage', target(s.tenantId));
        await request.tx(async (trx) => {
          await enqueueOutbox(
            trx,
            s.tenantId,
            'refdata.pull',
            { dataset: request.body.dataset, requestedBy: s.accountId, reason: 'staff' },
            request.executionId,
          );
          await request.audit(trx, {
            action: 'refdata.pull.request',
            targetType: 'refdata_snapshot',
            targetId: request.body.dataset,
          });
        });
        return reply.code(202).send({ dataset: request.body.dataset, queued: true });
      },
    );

    app.get(
      '/refdata/imports',
      {
        schema: {
          tags: ['refdata'],
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
          response: { 200: z.array(importOut) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('refdata.read', target(s.tenantId));
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.refdata_import')
            .selectAll()
            .where('tenant_id', '=', s.tenantId)
            .orderBy('created_at', 'desc')
            .limit(request.query.limit)
            .execute(),
        );
        return rows.map((r) => importView(r as ImportRow));
      },
    );

    app.get(
      '/refdata/imports/:id',
      { schema: { tags: ['refdata'], params: uuidParam, response: { 200: importOut } } },
      async (request) => {
        const s = account(request);
        await request.authorize('refdata.read', target(s.tenantId));
        const row = await request.tx((trx) =>
          trx
            .selectFrom('cg.refdata_import')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('tenant_id', '=', s.tenantId)
            .executeTakeFirst(),
        );
        if (!row) throw errors.notFound();
        return importView(row as ImportRow);
      },
    );

    app.post(
      '/refdata/imports',
      {
        schema: {
          tags: ['refdata'],
          body: z.object({
            clientUuid: z.uuid(),
            dataset,
            format: z.enum(['csv', 'geojson']),
            fileName: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .regex(/^[^/\\]+$/, 'a file name, not a path'),
            bytes: z.number().int().positive(),
            vintage: z.string().trim().min(1).max(80).optional(),
            licence: z.string().trim().min(1).max(200),
          }),
          response: { 201: importOut, 200: importOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        await request.authorize('refdata.manage', target(s.tenantId));
        if (!deps.objects)
          throw new ApiError(503, 'imports_unavailable', 'Files cannot be uploaded right now.', {
            retryable: true,
          });
        const b = request.body;
        if (b.bytes > maxBytes)
          throw new ApiError(
            413,
            'file_too_large',
            `Files must be under ${Math.round(maxBytes / 1_048_576)} MB.`,
          );
        const { row, created } = await request.tx(async (trx) => {
          const existing = await trx
            .selectFrom('cg.refdata_import')
            .selectAll()
            .where('tenant_id', '=', s.tenantId)
            .where('execution_id', '=', b.clientUuid)
            .executeTakeFirst();
          if (existing) return { row: existing, created: false };
          const id = randomUUID();
          const inserted = await trx
            .insertInto('cg.refdata_import')
            .values({
              id,
              tenant_id: s.tenantId,
              execution_id: b.clientUuid,
              dataset: b.dataset,
              file_name: b.fileName,
              object_key: `tenants/${s.tenantId}/refdata/imports/${id}`,
              format: b.format,
              bytes: b.bytes,
              vintage: b.vintage ?? null,
              licence: b.licence,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'refdata.import.create',
            targetType: 'refdata_import',
            targetId: inserted.id,
            targetVersion: inserted.version,
            changes: diffForAudit(
              null,
              { dataset: b.dataset, file_name: b.fileName, format: b.format, bytes: b.bytes },
              classifierFor('refdata_import'),
            ),
            executionId: b.clientUuid,
          });
          return { row: inserted, created: true };
        });
        return reply.code(created ? 201 : 200).send(importView(row as ImportRow));
      },
    );

    app.put(
      '/refdata/imports/:id/content',
      {
        bodyLimit: maxBytes + 1024,
        schema: { tags: ['refdata'], params: uuidParam, response: { 200: importOut } },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('refdata.manage', target(s.tenantId));
        const objects = deps.objects;
        if (!objects)
          throw new ApiError(503, 'imports_unavailable', 'Files cannot be uploaded right now.', {
            retryable: true,
          });
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0)
          throw new ApiError(400, 'validation_failed', 'Send the file itself as the request body.');
        if (body.length > maxBytes)
          throw new ApiError(413, 'file_too_large', 'That file is too large.');
        const row = await request.tx((trx) =>
          trx
            .selectFrom('cg.refdata_import')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('tenant_id', '=', s.tenantId)
            .executeTakeFirst(),
        );
        if (!row) throw errors.notFound();
        if (row.status !== 'uploading' && row.status !== 'uploaded')
          throw new ApiError(409, 'import_in_progress', 'This file has already been checked.', {
            details: importView(row as ImportRow),
          });
        const columns = columnsOf(row.format, body.toString('utf8'));
        if (!columns || columns.length === 0)
          throw errors.validation([
            {
              name: 'file',
              message:
                row.format === 'csv'
                  ? 'The file has no header row.'
                  : 'The file is not a GeoJSON FeatureCollection with properties.',
            },
          ]);
        await objects.client.send(
          new PutObjectCommand({
            Bucket: objects.bucket,
            Key: row.object_key,
            Body: body,
            ContentType: row.format === 'csv' ? 'text/csv' : 'application/geo+json',
          }),
        );
        const updated = await request.tx(async (trx) => {
          const u = await trx
            .updateTable('cg.refdata_import')
            .set({
              status: 'uploaded',
              bytes: body.length,
              columns: JSON.stringify(columns),
              version: sql`version + 1`,
              updated_by: s.accountId,
            })
            .where('id', '=', row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'refdata.import.upload',
            targetType: 'refdata_import',
            targetId: u.id,
            targetVersion: u.version,
            changes: diffForAudit(
              { status: row.status },
              { status: u.status, bytes: u.bytes },
              classifierFor('refdata_import'),
            ),
          });
          return u;
        });
        return importView(updated as ImportRow);
      },
    );

    app.put(
      '/refdata/imports/:id/mapping',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['refdata'],
          params: uuidParam,
          body: z.object({
            mapping: z.record(z.string().min(1).max(60), z.string().min(1).max(200)),
            vintage: z.string().trim().min(1).max(80).nullable().optional(),
            licence: z.string().trim().min(1).max(200).optional(),
          }),
          response: { 200: importOut },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('refdata.manage', target(s.tenantId));
        const expected = request.expectedVersion();
        const b = request.body;
        const updated = await request.tx(async (trx) => {
          const row = await trx
            .selectFrom('cg.refdata_import')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('tenant_id', '=', s.tenantId)
            .executeTakeFirst();
          if (!row) throw errors.notFound();
          if (!['uploaded', 'validated', 'invalid'].includes(row.status))
            throw new ApiError(
              409,
              'import_not_ready',
              row.status === 'uploading'
                ? 'Send the file first.'
                : 'This file is being checked or has been applied.',
              { details: importView(row as ImportRow) },
            );
          const fields = new Set(importFields(row.dataset).map((f) => f.name));
          const bad: { name: string; message: string }[] = [];
          for (const [field, column] of Object.entries(b.mapping)) {
            if (!fields.has(field))
              bad.push({ name: `mapping.${field}`, message: 'not a field of this dataset' });
            else if (!row.columns.includes(column))
              bad.push({ name: `mapping.${field}`, message: 'not a column in the file' });
          }
          if (bad.length) throw errors.validation(bad);
          const u = await trx
            .updateTable('cg.refdata_import')
            .set({
              mapping: JSON.stringify(b.mapping),
              ...(b.vintage !== undefined ? { vintage: b.vintage } : {}),
              ...(b.licence !== undefined ? { licence: b.licence } : {}),
              status: 'validating',
              errors: '[]',
              version: sql`version + 1`,
              updated_by: s.accountId,
            })
            .where('id', '=', row.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst();
          const saved = assertUpdated(u, importView(row as ImportRow));
          await enqueueOutbox(trx, s.tenantId, 'refdata.import', { importId: row.id }, null);
          await request.audit(trx, {
            action: 'refdata.import.map',
            targetType: 'refdata_import',
            targetId: saved.id,
            targetVersion: saved.version,
            changes: diffForAudit(
              { mapping: row.mapping, status: row.status },
              { mapping: saved.mapping, status: saved.status },
              classifierFor('refdata_import'),
            ),
          });
          return saved;
        });
        return importView(updated as ImportRow);
      },
    );

    app.post(
      '/refdata/imports/:id/apply',
      {
        config: { requiresVersion: true },
        schema: { tags: ['refdata'], params: uuidParam, response: { 200: importOut } },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('refdata.manage', target(s.tenantId));
        const expected = request.expectedVersion();
        const updated = await request.tx(async (trx) => {
          const row = await trx
            .selectFrom('cg.refdata_import')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('tenant_id', '=', s.tenantId)
            .executeTakeFirst();
          if (!row) throw errors.notFound();
          // A resend after the first apply went through answers the import as it stands.
          if (row.status === 'applying' || row.status === 'applied') return row;
          if (row.status !== 'validated')
            throw new ApiError(
              409,
              'import_not_validated',
              'Only a file whose check passed can be applied.',
              { details: importView(row as ImportRow) },
            );
          const u = await trx
            .updateTable('cg.refdata_import')
            .set({ status: 'applying', version: sql`version + 1`, updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst();
          const saved = assertUpdated(u, importView(row as ImportRow));
          await enqueueOutbox(trx, s.tenantId, 'refdata.import', { importId: row.id }, null);
          await request.audit(trx, {
            action: 'refdata.import.apply',
            targetType: 'refdata_import',
            targetId: saved.id,
            targetVersion: saved.version,
            changes: diffForAudit(
              { status: row.status },
              { status: saved.status },
              classifierFor('refdata_import'),
            ),
          });
          return saved;
        });
        return importView(updated as ImportRow);
      },
    );
  };
