/**
 * Offline map packages on the phone (FLD-13, SCL-13): each package of the
 * volunteer's areas is downloaded once per version into the app's own files,
 * checked against the hash the server recorded, and opened by MapLibre from
 * there (pmtiles://file://…). Packages hold only public map tiles (no
 * person, no record), so they sit outside the encrypted store; which ones the
 * phone holds is recorded in it. The web build keeps them in Cache Storage.
 */
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import type { MapOffer, StoredMap } from './maps';

export type { MapOffer, StoredMap } from './maps';

const folder = () => {
  const d = new Directory(Paths.document, 'maps');
  if (!d.exists) d.create({ intermediates: true });
  return d;
};

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function downloadMap(offer: MapOffer): Promise<StoredMap> {
  const target = new File(
    folder(),
    `${offer.areaKey.replace(/[^\w-]/g, '_')}-v${offer.version}.pmtiles`,
  );
  if (target.exists) target.delete();
  const file = await File.downloadFileAsync(offer.url, target);
  const bytes = await file.bytes();
  if (hex(await digest(CryptoDigestAlgorithm.SHA256, bytes)) !== offer.sha256) {
    file.delete();
    throw new Error('map package does not match its hash');
  }
  return {
    areaKey: offer.areaKey,
    version: offer.version,
    bytes: bytes.byteLength,
    sha256: offer.sha256,
    bounds: offer.bounds,
    uri: file.uri,
  };
}

export async function hasMap(m: StoredMap): Promise<boolean> {
  return new File(m.uri).exists;
}

export async function keepOnlyMaps(keep: StoredMap[]): Promise<void> {
  const wanted = new Set(keep.map((m) => m.uri));
  for (const entry of folder().list())
    if (entry instanceof File && !wanted.has(entry.uri)) entry.delete();
}

/** The phone opens packages by file; the web build reads their bytes instead. */
export async function readMap(): Promise<Blob | null> {
  return null;
}
