/** PHO-03, PHO-06: metadata hints read on the device; one plain quality suggestion. */
import { describe, expect, it } from 'vitest';
import { assessQuality, readExifHints } from '../src/intake/photos.ts';

/** A JPEG header with an EXIF APP1 holding DateTimeOriginal and a GPS position (little-endian TIFF). */
function exifJpeg(): ArrayBuffer {
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) =>
    bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const ascii = (s: string) => {
    for (const ch of s) bytes.push(ch.charCodeAt(0));
  };
  // SOI + APP1 marker; the length is patched at the end.
  bytes.push(0xff, 0xd8, 0xff, 0xe1, 0, 0);
  const app1Start = bytes.length;
  ascii('Exif');
  bytes.push(0, 0);
  const tiff = bytes.length;
  ascii('II');
  u16(42);
  u32(8); // IFD0 at offset 8
  // IFD0: 2 entries (ExifIFD pointer, GPS pointer)
  const ifd0 = tiff + 8;
  u16(2);
  const exifIfd = ifd0 + 2 + 2 * 12 + 4;
  u16(0x8769);
  u16(4);
  u32(1);
  u32(exifIfd - tiff);
  const gpsIfd = exifIfd + 2 + 12 + 4 + 20;
  u16(0x8825);
  u16(4);
  u32(1);
  u32(gpsIfd - tiff);
  u32(0);
  // Exif IFD: DateTimeOriginal (ascii, 20 bytes, stored after the IFD)
  u16(1);
  const dateAt = exifIfd + 2 + 12 + 4;
  u16(0x9003);
  u16(2);
  u32(20);
  u32(dateAt - tiff);
  u32(0);
  ascii('2026:10:12 09:30:00\0');
  // GPS IFD: LatRef, Lat (3 rationals), LonRef, Lon (3 rationals)
  u16(4);
  const latAt = gpsIfd + 2 + 4 * 12 + 4;
  const lonAt = latAt + 24;
  u16(1);
  u16(2);
  u32(2);
  bytes.push(0x4e, 0, 0, 0); // 'N'
  u16(2);
  u16(5);
  u32(3);
  u32(latAt - tiff);
  u16(3);
  u16(2);
  u32(2);
  bytes.push(0x57, 0, 0, 0); // 'W'
  u16(4);
  u16(5);
  u32(3);
  u32(lonAt - tiff);
  u32(0);
  u32(38);
  u32(1);
  u32(36);
  u32(1);
  u32(0);
  u32(1); // 38° 36' 0"
  u32(90);
  u32(1);
  u32(12);
  u32(1);
  u32(0);
  u32(1); // 90° 12' 0"
  const app1Len = bytes.length - app1Start + 2;
  bytes[app1Start - 2] = (app1Len >> 8) & 0xff;
  bytes[app1Start - 1] = app1Len & 0xff;
  bytes.push(0xff, 0xd9);
  return new Uint8Array(bytes).buffer;
}

describe('photo hints and quality', () => {
  it('reads the date and position from EXIF, with hemispheres', () => {
    const hints = readExifHints(exifJpeg());
    expect(hints.takenAt).toBe('2026-10-12T09:30:00');
    expect(hints.location?.lat).toBeCloseTo(38.6, 5);
    expect(hints.location?.lon).toBeCloseTo(-90.2, 5);
  });

  it('returns nothing for files without EXIF or that are not JPEG', () => {
    expect(readExifHints(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toEqual({});
    expect(readExifHints(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toEqual({});
    expect(readExifHints(new ArrayBuffer(0))).toEqual({});
  });

  it('flags a dark frame and a flat frame, not a textured bright one', () => {
    const w = 40;
    const h = 30;
    const dark = new Uint8ClampedArray(w * h).fill(10);
    expect(assessQuality(dark, w, h)).toEqual({ dark: true, blurry: true });
    const flat = new Uint8ClampedArray(w * h).fill(180);
    expect(assessQuality(flat, w, h)).toEqual({ dark: false, blurry: true });
    const textured = new Uint8ClampedArray(w * h);
    for (let i = 0; i < textured.length; i++) textured[i] = (i % 2 ? 220 : 60) + ((i * 7) % 20);
    expect(assessQuality(textured, w, h)).toEqual({ dark: false, blurry: false });
  });
});
