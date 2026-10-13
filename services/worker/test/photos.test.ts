/**
 * Photo pipeline (PHO-06, PHO-07, PHO-15): derivatives carry no EXIF, GPS or
 * ICC data; orientation is applied; sizes are bounded; the hash identifies
 * identical uploads; blurring covers the reported regions.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { blurRegions, DERIVATIVES, processImage } from '../src/jobs/photos.ts';

async function jpegWithExif(width: number, height: number, orientation = 1): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3b6ea5' } })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><rect x="10" y="10" width="${Math.floor(width / 3)}" height="${Math.floor(height / 3)}" fill="#ffffff"/></svg>`,
        ),
      },
    ])
    .jpeg({ quality: 90 })
    .withMetadata({ orientation })
    .withExif({
      IFD0: { ImageDescription: 'taken at 12 Oak St', Copyright: 'resident' },
      IFD2: { DateTimeOriginal: '2026:10:12 09:30:00' },
    })
    .toBuffer();
}

describe('photo processing', () => {
  it('strips every metadata block from the derivatives and bounds their size (PHO-06)', async () => {
    const original = await jpegWithExif(2400, 1600);
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const out = await processImage(original);
    expect(out.format).toBe('jpeg');
    expect(out.width).toBe(2400);
    expect(out.height).toBe(1600);
    for (const name of ['review', 'thumb'] as const) {
      const meta = await sharp(out.derivatives[name]).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(DERIVATIVES[name]);
    }
  });

  it('applies the EXIF orientation so a sideways phone photo reads upright', async () => {
    const original = await jpegWithExif(800, 400, 6);
    const out = await processImage(original);
    expect(out.width).toBe(400);
    expect(out.height).toBe(800);
    const meta = await sharp(out.derivatives.review).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(800);
    expect(meta.orientation).toBeUndefined();
  });

  it('hashes the original bytes so identical uploads are found (PHO-15)', async () => {
    const original = await jpegWithExif(640, 480);
    const a = await processImage(original);
    const b = await processImage(Buffer.from(original));
    expect(a.sha256.equals(b.sha256)).toBe(true);
    const other = await processImage(await jpegWithExif(640, 481));
    expect(a.sha256.equals(other.sha256)).toBe(false);
  });

  it('does not enlarge a small photo', async () => {
    const out = await processImage(await jpegWithExif(200, 150));
    const meta = await sharp(out.derivatives.review).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(150);
  });

  it('refuses something that is not an image', async () => {
    await expect(processImage(Buffer.from('not an image'))).rejects.toThrow();
  });

  it('blurs the regions a detector reports (PHO-07)', async () => {
    const original = await jpegWithExif(800, 600);
    const { derivatives } = await processImage(original);
    const blurred = await blurRegions(derivatives.review, [
      { kind: 'face', x: 0.05, y: 0.05, width: 0.3, height: 0.3 },
    ]);
    const before = await sharp(derivatives.review)
      .extract({ left: 60, top: 60, width: 80, height: 80 })
      .raw()
      .toBuffer();
    const after = await sharp(blurred)
      .extract({ left: 60, top: 60, width: 80, height: 80 })
      .raw()
      .toBuffer();
    expect(after.equals(before)).toBe(false);
    const untouchedBefore = await sharp(derivatives.review)
      .extract({ left: 600, top: 400, width: 40, height: 40 })
      .raw()
      .toBuffer();
    const untouchedAfter = await sharp(blurred)
      .extract({ left: 600, top: 400, width: 40, height: 40 })
      .raw()
      .toBuffer();
    expect(untouchedAfter.equals(untouchedBefore)).toBe(true);
    expect((await sharp(blurred).metadata()).exif).toBeUndefined();
  });
});
