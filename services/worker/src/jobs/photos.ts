/**
 * Photo processing (PHO-05–PHO-08, PHO-15, PHO-12): the original stays under
 * the restricted prefix for evidence (PHO-07); derivatives for review carry no
 * metadata at all (EXIF, GPS, ICC stripped; orientation applied first); the
 * image interface is asked for sensitive regions to blur, and when the
 * provider has no detector (the fake one) the status says so and the
 * derivatives stay restricted. Nothing here rates damage: once the photo is
 * ready, `report.severity` (severity.ts) may suggest a degree for reviewers,
 * and a person decides.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { callAi, recordAiOutput, type Region } from '@cg/ai';
import { sql } from 'kysely';
import { asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import type { TopicHandler } from './types.ts';

export const DERIVATIVES = { review: 1600, thumb: 320 } as const;
export type DerivativeName = keyof typeof DERIVATIVES;

export interface ProcessedImage {
  sha256: Buffer;
  /** Orientation-corrected size of the original. */
  width: number;
  height: number;
  format: string;
  derivatives: Record<DerivativeName, Buffer>;
}

/** Decodes, applies the EXIF orientation, hashes the original, and renders metadata-free derivatives. */
export async function processImage(original: Buffer): Promise<ProcessedImage> {
  const image = sharp(original, { failOn: 'error', limitInputPixels: 60_000_000 }).rotate();
  const meta = await image.metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const derivative = async (max: number) =>
    image
      .clone()
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: max >= 1000 ? 82 : 70 }) // no withMetadata(): EXIF, GPS and ICC are not copied
      .toBuffer();
  return {
    sha256: createHash('sha256').update(original).digest(),
    width: (swap ? meta.height : meta.width) ?? 0,
    height: (swap ? meta.width : meta.height) ?? 0,
    format: meta.format ?? 'unknown',
    derivatives: {
      review: await derivative(DERIVATIVES.review),
      thumb: await derivative(DERIVATIVES.thumb),
    },
  };
}

/** Blurs the regions a detector reported; values ≤ 1 are fractions of the image, larger ones pixels. */
export async function blurRegions(image: Buffer, regions: Region[]): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H || regions.length === 0) return image;
  const px = (v: number, max: number) => Math.round(v <= 1 ? v * max : v);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const overlays: { input: Buffer; left: number; top: number }[] = [];
  for (const r of regions) {
    const left = clamp(px(r.x, W), 0, W - 1);
    const top = clamp(px(r.y, H), 0, H - 1);
    const width = clamp(px(r.width, W), 1, W - left);
    const height = clamp(px(r.height, H), 1, H - top);
    const blurred = await sharp(image).extract({ left, top, width, height }).blur(25).toBuffer();
    overlays.push({ input: blurred, left, top });
  }
  return sharp(image).composite(overlays).webp({ quality: 82 }).toBuffer();
}

/**
 * The derivatives written after detection (PHO-07): with regions to blur, the
 * review image is blurred and the thumbnail is made again from it, so no size
 * shows what the detector found.
 */
export async function blurredDerivatives(
  derivatives: Record<DerivativeName, Buffer>,
  regions: Region[],
): Promise<Record<DerivativeName, Buffer>> {
  if (regions.length === 0) return derivatives;
  const review = await blurRegions(derivatives.review, regions);
  const thumb = await sharp(review)
    .resize({
      width: DERIVATIVES.thumb,
      height: DERIVATIVES.thumb,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 70 })
    .toBuffer();
  return { review, thumb };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

/** photo.process: enqueued when an upload completes (public/routes.ts). Idempotent by status. */
export const photoProcess: TopicHandler = async (ctx, msg) => {
  const photoId = str(msg.payload['photoId']);
  const row = await ctx.db
    .selectFrom('cg.photo')
    .select([
      'id',
      'tenant_id',
      'execution_id',
      'report_id',
      'object_key_original',
      'status',
      'content_type',
      'bytes',
    ])
    .where('id', '=', photoId)
    .executeTakeFirst();
  if (!row) throw new Error(`photo ${photoId} not found`);
  if (row.status !== 'uploaded') return; // not complete yet, already processed, or rejected
  if (!ctx.objects) throw new Error('object storage is not configured');

  const original = await ctx.objects.get(row.object_key_original);
  let processed: ProcessedImage;
  try {
    processed = await processImage(original.body);
  } catch (err) {
    // An unreadable file is not retried; the resident's report stands without it (PHO-05).
    await asSystem(ctx.db, row.tenant_id, async (trx) => {
      await trx
        .updateTable('cg.photo')
        .set({ status: 'failed', blur_status: 'failed', processed_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await systemAudit(trx, row.tenant_id, 'photo.process', {
        action: 'photo.failed',
        targetType: 'photo',
        targetId: row.id,
        reason: `unreadable image: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          300,
        ),
        executionId: row.execution_id,
      });
    });
    return;
  }

  const prefix = `tenants/${row.tenant_id}/restricted/${row.execution_id}/${row.id}`;
  const keys: Record<DerivativeName, string> = {
    review: `${prefix}/review.webp`,
    thumb: `${prefix}/thumb.webp`,
  };

  // Sensitive regions through the image interface (PHO-07); never a severity rating (PHO-12).
  // The provider is called outside any transaction: a slow reply holds no connection.
  const detector = await asSystem(ctx.db, row.tenant_id, async (trx) => {
    const feature = await trx
      .selectFrom('cg.ai_use_register')
      .select(['enabled', 'provider'])
      .where('feature', '=', 'photo.sensitive_regions')
      .executeTakeFirst();
    if (!feature?.enabled) return null;
    const provider = await ctx.ai.providerFor(row.tenant_id, trx);
    return provider?.image && provider.info.provider === feature.provider
      ? { info: provider.info, image: provider.image }
      : null;
  });
  const analysis = detector
    ? await callAi(() => detector.image.analyse(processed.derivatives.review, 'image/webp'))
    : null;

  await asSystem(ctx.db, row.tenant_id, async (trx) => {
    let blurStatus: 'applied' | 'skipped_no_detector' | 'failed' = 'skipped_no_detector';
    let written = processed.derivatives;
    let regions = 0;
    if (detector && analysis) {
      // AIG-01: the call's record, whatever its outcome.
      await recordAiOutput(trx, {
        tenantId: row.tenant_id,
        feature: 'photo.sensitive_regions',
        provider: analysis.ok ? analysis.out.provider : detector.info,
        outcome: analysis.ok ? 'ok' : analysis.outcome,
        latencyMs: analysis.ok ? analysis.out.latencyMs : analysis.latencyMs,
        executionId: row.execution_id,
        targetType: 'photo',
        targetId: row.id,
      });
      if (!analysis.ok) {
        // AI-10: the photo stays restricted, unblurred, for staff with the evidence category.
        ctx.log.warn(
          { photoId: row.id, outcome: analysis.outcome },
          'sensitive-region detection failed',
        );
        blurStatus = 'failed';
      } else if (analysis.out.output.detectorAvailable) {
        regions = analysis.out.output.sensitiveRegions.length;
        written = await blurredDerivatives(
          processed.derivatives,
          analysis.out.output.sensitiveRegions,
        );
        blurStatus = 'applied';
      }
    }
    await ctx.objects!.put(keys.review, written.review, 'image/webp');
    await ctx.objects!.put(keys.thumb, written.thumb, 'image/webp');

    // The same bytes on another report are a duplicate for a person to judge (PHO-15).
    const twins = await trx
      .selectFrom('cg.photo')
      .select(['id', 'report_id'])
      .where('tenant_id', '=', row.tenant_id)
      .where('sha256', '=', processed.sha256)
      .where('execution_id', '<>', row.execution_id)
      .orderBy('created_at', 'desc')
      .limit(5)
      .execute();
    await trx
      .updateTable('cg.photo')
      .set({
        status: 'processed',
        processed_at: new Date(),
        derivative_keys: JSON.stringify(keys),
        exif_stripped: true,
        blur_status: blurStatus,
        width: processed.width,
        height: processed.height,
        sha256: processed.sha256,
        bytes: original.body.length,
      })
      .where('id', '=', row.id)
      .execute();
    if (twins.length > 0 && row.report_id) {
      const flags = twins.map((t) => ({
        kind: 'duplicate_photo',
        reason: 'same photo bytes as another report',
        photoId: row.id,
        ...(t.report_id ? { reportId: t.report_id } : {}),
        at: new Date().toISOString(),
      }));
      await trx
        .updateTable('cg.report')
        .set({ flags: sql<string>`flags || ${JSON.stringify(flags)}::jsonb` })
        .where('id', '=', row.report_id)
        .execute();
    }
    // PHO-09: the severity suggestion looks at the report's photos once this one is ready.
    if (row.report_id)
      await enqueueOutbox(
        trx,
        row.tenant_id,
        'report.severity',
        { reportId: row.report_id },
        row.execution_id,
      );
    await systemAudit(trx, row.tenant_id, 'photo.process', {
      action: 'photo.processed',
      targetType: 'photo',
      targetId: row.id,
      executionId: row.execution_id,
      changes: {
        fields: [
          { name: 'blur_status', to: blurStatus },
          { name: 'sensitive_regions', to: regions },
          { name: 'derivatives', to: Object.keys(keys) },
          { name: 'duplicates', to: twins.length },
        ],
      },
    });
  });
};
