/**
 * Photos on the device (PHO-03, PHO-05, PHO-06): a picture from the camera
 * or gallery is read for its date and place (suggestions only), redrawn on a
 * canvas so nothing of its metadata travels, compressed under the tenant's
 * size cap, and checked once for darkness and blur with one plain retake
 * suggestion. Everything degrades: no canvas, no checks, the original goes.
 */
export interface PhotoHints {
  takenAt?: string;
  location?: { lat: number; lon: number };
}

/** JPEG EXIF: DateTimeOriginal and GPS, read from the first APP1 segment. Best effort; never throws. */
export function readExifHints(bytes: ArrayBuffer): PhotoHints {
  try {
    const view = new DataView(bytes);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {};
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if (marker === 0xffe1 && offset + 10 <= view.byteLength) {
        const exifStart = offset + 4;
        if (view.getUint32(exifStart) !== 0x45786966) return {}; // "Exif"
        const tiff = exifStart + 6;
        const little = view.getUint16(tiff) === 0x4949;
        const u16 = (p: number) => view.getUint16(p, little);
        const u32 = (p: number) => view.getUint32(p, little);
        const ifd0 = tiff + u32(tiff + 4);
        const hints: PhotoHints = {};
        let exifIfd = 0;
        let gpsIfd = 0;
        const entries = u16(ifd0);
        for (let i = 0; i < entries; i++) {
          const e = ifd0 + 2 + i * 12;
          const tag = u16(e);
          if (tag === 0x8769) exifIfd = tiff + u32(e + 8);
          if (tag === 0x8825) gpsIfd = tiff + u32(e + 8);
        }
        const ascii = (e: number) => {
          const count = u32(e + 4);
          const p = count > 4 ? tiff + u32(e + 8) : e + 8;
          let s = '';
          for (let j = 0; j < count - 1 && p + j < view.byteLength; j++)
            s += String.fromCharCode(view.getUint8(p + j));
          return s;
        };
        const rational = (p: number) => u32(p) / (u32(p + 4) || 1);
        if (exifIfd) {
          const n = u16(exifIfd);
          for (let i = 0; i < n; i++) {
            const e = exifIfd + 2 + i * 12;
            if (u16(e) === 0x9003) {
              const m = ascii(e).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
              if (m) hints.takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
            }
          }
        }
        if (gpsIfd) {
          const n = u16(gpsIfd);
          let latRef = 'N';
          let lonRef = 'E';
          let lat: number | undefined;
          let lon: number | undefined;
          const dms = (e: number) => {
            const p = tiff + u32(e + 8);
            return rational(p) + rational(p + 8) / 60 + rational(p + 16) / 3600;
          };
          for (let i = 0; i < n; i++) {
            const e = gpsIfd + 2 + i * 12;
            const tag = u16(e);
            if (tag === 1) latRef = String.fromCharCode(view.getUint8(e + 8));
            if (tag === 2) lat = dms(e);
            if (tag === 3) lonRef = String.fromCharCode(view.getUint8(e + 8));
            if (tag === 4) lon = dms(e);
          }
          if (
            lat !== undefined &&
            lon !== undefined &&
            Number.isFinite(lat) &&
            Number.isFinite(lon)
          )
            hints.location = {
              lat: latRef === 'S' ? -lat : lat,
              lon: lonRef === 'W' ? -lon : lon,
            };
        }
        return hints;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      offset += 2 + size;
    }
  } catch {
    // unreadable metadata: no hints
  }
  return {};
}

export interface QualityCheck {
  dark: boolean;
  blurry: boolean;
}

/** Mean luminance and a Laplacian variance on a small grey copy; one suggestion, never a block (PHO-03). */
export function assessQuality(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): QualityCheck {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  const mean = sum / gray.length;
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = 4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!;
      lapSum += v;
      lapSq += v * v;
      n++;
    }
  const variance = n ? lapSq / n - (lapSum / n) ** 2 : 0;
  return { dark: mean < 40, blurry: variance < 25 };
}

export interface PreparedPhoto {
  blob: Blob;
  contentType: string;
  width: number;
  height: number;
  hints: PhotoHints;
  quality: QualityCheck | null;
}

/** Redraws the picture (metadata gone), fits it under maxBytes, and runs the quality check. */
export async function preparePhoto(
  file: File,
  maxBytes: number,
  maxEdge = 1600,
): Promise<PreparedPhoto> {
  const buffer = await file.arrayBuffer();
  const hints = file.type === 'image/jpeg' ? readExifHints(buffer) : {};
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buffer], { type: file.type }), {
      imageOrientation: 'from-image',
    });
  } catch {
    // Cannot decode here (HEIC on some browsers): send as is, the worker decides (PHO-05).
    return { blob: file, contentType: file.type, width: 0, height: 0, hints, quality: null };
  }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { blob: file, contentType: file.type, width, height, hints, quality: null };
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Quality on a 160 px wide grey copy.
  let quality: QualityCheck | null = null;
  try {
    const sw = 160;
    const sh = Math.max(1, Math.round((height / width) * sw));
    const small = document.createElement('canvas');
    small.width = sw;
    small.height = sh;
    const sctx = small.getContext('2d');
    if (sctx) {
      sctx.drawImage(canvas, 0, 0, sw, sh);
      const { data } = sctx.getImageData(0, 0, sw, sh);
      const gray = new Uint8ClampedArray(sw * sh);
      for (let i = 0; i < gray.length; i++)
        gray[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
      quality = assessQuality(gray, sw, sh);
    }
  } catch {
    quality = null;
  }

  let qualityStep = 0.85;
  let blob = await toBlob(canvas, qualityStep);
  while (blob.size > maxBytes && qualityStep > 0.4) {
    qualityStep -= 0.15;
    blob = await toBlob(canvas, qualityStep);
  }
  return { blob, contentType: 'image/jpeg', width, height, hints, quality };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/jpeg', quality),
  );
}
