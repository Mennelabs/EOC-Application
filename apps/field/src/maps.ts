/**
 * Offline map packages on the web build (FLD-13, SCL-13): each package of the
 * volunteer's areas is downloaded once per version, checked against the hash
 * the server recorded, and kept in the browser's Cache Storage. Packages hold
 * only public map tiles (no person, no record), so they are kept outside the
 * encrypted store; which ones the phone holds is recorded in it. The phone
 * build keeps them as files (maps.native.ts).
 */
export interface MapOffer {
  areaKey: string;
  url: string;
  sha256: string;
  version: number;
  bytes: number;
  bounds: [number, number, number, number];
}

export interface StoredMap {
  areaKey: string;
  version: number;
  bytes: number;
  sha256: string;
  bounds: [number, number, number, number];
  /** Where the package is kept on this device. */
  uri: string;
}

const CACHE = 'cg-field-maps';

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const keyFor = (m: { areaKey: string; version: number }) =>
  `${location.origin}/field-maps/${encodeURIComponent(m.areaKey)}-v${m.version}.pmtiles`;

/** Downloads one package and keeps it; refuses one that does not match its hash. */
export async function downloadMap(offer: MapOffer): Promise<StoredMap> {
  const res = await fetch(offer.url);
  if (!res.ok) throw new Error(`map package: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', buf)) !== offer.sha256)
    throw new Error('map package does not match its hash');
  const uri = keyFor(offer);
  const cache = await caches.open(CACHE);
  await cache.put(
    uri,
    new Response(buf, {
      headers: {
        'content-type': 'application/vnd.pmtiles',
        'content-length': String(buf.byteLength),
      },
    }),
  );
  return {
    areaKey: offer.areaKey,
    version: offer.version,
    bytes: buf.byteLength,
    sha256: offer.sha256,
    bounds: offer.bounds,
    uri,
  };
}

/** Whether a kept package is still on the device. */
export async function hasMap(m: StoredMap): Promise<boolean> {
  try {
    return Boolean(await (await caches.open(CACHE)).match(m.uri));
  } catch {
    return false;
  }
}

/** Drops every kept package except these. */
export async function keepOnlyMaps(keep: StoredMap[]): Promise<void> {
  try {
    const cache = await caches.open(CACHE);
    const wanted = new Set(keep.map((m) => m.uri));
    for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
  } catch {
    // No Cache Storage (an insecure page): nothing is kept, nothing to drop.
  }
}

/** The kept package's bytes, for the web map to read (area-map.tsx). */
export async function readMap(m: StoredMap): Promise<Blob | null> {
  try {
    const hit = await (await caches.open(CACHE)).match(m.uri);
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}
