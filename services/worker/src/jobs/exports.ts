/**
 * Builds a requested export (layer-6 task F; DCL:DEC-11, DEC-12, DEC-13,
 * DEC-15, F15, RULE-10, SEC-18, GATE-07): the IDA package as a ZIP (the
 * PDF/UA package, the per-home and per-site CSVs, summary.csv, the GIS
 * layer and a README), filled with the FEMA form mappings in force; or an
 * issued official report as PDF or CSV from its frozen snapshot. The file
 * goes to object storage; the row records its size, SHA-256, the mapping
 * versions and the totals it carries. A failure is recorded and audited,
 * never left looking like a file. Delivery is at least once and more than
 * one worker may run: each attempt writes under its own key and only the
 * first to finish records its file (a later one leaves the row as it is).
 */
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { renderPdf } from '@cg/pdf';
import {
  FORM_KEYS,
  buildPackage,
  loadPackageData,
  mappingInForce,
  reportCsv,
  reportPdf,
  zip,
  type FormKey,
  type IssuedContent,
  type Mapping,
  type PackagePhoto,
} from '@cg/reporting';
import { publishWebhookEvent, sendClaimed } from './webhooks.ts';
import { asSystem, systemAudit } from '../system.ts';
import type { JobContext, TopicHandler } from './types.ts';

/**
 * The chosen photos as JPEG for the PDF and the ZIP: drawn from the blurred,
 * metadata-free review image only (PHO-06/07), re-encoded without metadata
 * and at most 1200 px. A photo that cannot be read is left out (the package
 * says how many) rather than failing the package.
 */
async function photoImages(ctx: JobContext, photos: PackagePhoto[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const p of photos) {
    try {
      const { body } = await ctx.objects!.get(p.reviewKey);
      out.set(
        p.photoId,
        await sharp(body, { limitInputPixels: 60_000_000 })
          .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer(),
      );
    } catch (err) {
      ctx.log.warn({ err, photoId: p.photoId }, 'package photo could not be read; left out');
    }
  }
  return out;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'event';

export const exportRequested: TopicHandler = async (ctx, msg) => {
  const exportId = msg.payload['exportId'];
  if (typeof exportId !== 'string') return;
  const tenantId = msg.tenantId;
  const row = await asSystem(ctx.db, tenantId, (trx) =>
    trx
      .selectFrom('cg.export_file')
      .selectAll()
      .where('id', '=', exportId)
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'queued')
      .executeTakeFirst(),
  );
  if (!row) return;
  const now = ctx.now?.() ?? new Date();
  const productName = ctx.productName ?? 'the platform';
  const fail = async (reason: string) =>
    asSystem(ctx.db, tenantId, async (trx) => {
      const marked = await trx
        .updateTable('cg.export_file')
        .set({ status: 'failed', error: reason })
        .where('id', '=', row.id)
        .where('status', '=', 'queued')
        .executeTakeFirst();
      if (marked.numUpdatedRows === 0n) return;
      await systemAudit(trx, tenantId, 'export', {
        action: 'export.failed',
        targetType: 'export_file',
        targetId: row.id,
        reason,
        executionId: msg.executionId,
      });
    });
  if (!ctx.objects) {
    await fail('No file storage is configured.');
    return;
  }
  try {
    let file: { name: string; contentType: string; body: Buffer };
    let mappings: Record<string, unknown> = {};
    let figures: Record<string, unknown> = {};
    if (row.kind === 'ida_package') {
      const built = await asSystem(ctx.db, tenantId, async (trx) => {
        const data = await loadPackageData(trx, tenantId, row.event_id, {
          jurisdictionTenantId: row.jurisdiction_tenant_id,
        });
        const inForce = {} as Record<FormKey, Mapping>;
        for (const f of FORM_KEYS) inForce[f] = await mappingInForce(trx, tenantId, f);
        return data ? { data, inForce } : null;
      });
      if (!built) {
        await fail('The event could not be read.');
        return;
      }
      const pkg = buildPackage(built.data, built.inForce, {
        productName,
        generatedAt: now,
        photoImages: await photoImages(ctx, built.data.photos),
      });
      const pdf = await renderPdf(pkg.pdf);
      const scope = built.data.jurisdiction
        ? `${built.data.event.name} ${built.data.jurisdiction.name}`
        : built.data.event.name;
      file = {
        name: `ida-package-${slug(scope)}-${now.toISOString().slice(0, 10)}.zip`,
        contentType: 'application/zip',
        body: zip(
          [
            { name: 'package.pdf', body: pdf },
            ...pkg.files.map((f) => ({ name: f.name, body: f.body })),
          ],
          now,
        ),
      };
      mappings = pkg.mappings;
      figures = pkg.check;
    } else {
      const snap = await asSystem(ctx.db, tenantId, (trx) =>
        trx
          .selectFrom('cg.official_report_snapshot')
          .select(['content', 'content_hash'])
          .where('report_id', '=', row.report_id!)
          .executeTakeFirst(),
      );
      if (!snap) {
        await fail('The report has no issued copy.');
        return;
      }
      const content = snap.content as IssuedContent;
      const base = `${slug(content.report.title)}-${(content.report.issuer.at ?? now.toISOString()).slice(0, 10)}`;
      file =
        row.format === 'pdf'
          ? {
              name: `${base}.pdf`,
              contentType: 'application/pdf',
              body: await renderPdf(
                reportPdf(content, { productName, contentHash: snap.content_hash }),
              ),
            }
          : {
              name: `${base}.csv`,
              contentType: 'text/csv',
              body: Buffer.from(reportCsv(content), 'utf8'),
            };
      figures = { contentHash: snap.content_hash };
    }
    const key = `tenant/${tenantId}/exports/${row.id}/${randomUUID()}/${file.name}`;
    await ctx.objects.put(key, file.body, file.contentType);
    const sha256 = createHash('sha256').update(file.body).digest('hex');
    const claimed = await asSystem(ctx.db, tenantId, async (trx) => {
      const recorded = await trx
        .updateTable('cg.export_file')
        .set({
          status: 'ready',
          file_name: file.name,
          object_key: key,
          bytes: file.body.length,
          sha256,
          mappings: JSON.stringify(mappings),
          figures: JSON.stringify(figures),
          ready_at: new Date(),
        })
        .where('id', '=', row.id)
        .where('status', '=', 'queued')
        .executeTakeFirst();
      if (recorded.numUpdatedRows === 0n) return [];
      await systemAudit(trx, tenantId, 'export', {
        action: 'export.ready',
        targetType: 'export_file',
        targetId: row.id,
        changes: { file: file.name, bytes: file.body.length, sha256 },
        executionId: msg.executionId,
      });
      // SCL-09: "export ready" to the county's webhooks, in the same transaction.
      return publishWebhookEvent(
        ctx,
        tenantId,
        'export.ready',
        row.id,
        {
          exportId: row.id,
          eventId: row.event_id,
          kind: row.kind,
          format: row.format,
          reportId: row.report_id,
          fileName: file.name,
          bytes: file.body.length,
          sha256,
        },
        trx,
      );
    });
    await sendClaimed(ctx, claimed).catch((err: unknown) =>
      ctx.log.warn({ err, exportId: row.id }, 'webhook delivery deferred to the schedule'),
    );
  } catch (err) {
    ctx.log.error({ err, exportId: row.id }, 'export failed');
    await fail('The export could not be built; try again, and tell support if it fails again.');
  }
};
