/**
 * Offline map packages (FLD-13, SCL-13, ADR-0015): a PMTiles v3 archive of
 * the tiles over one area, cut from the county's regional archive. The tiles
 * are copied byte for byte (still compressed as the region stores them), so
 * the package draws exactly what the web maps draw. Identical tiles (open
 * water, empty fields) are stored once. Spec:
 * https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * The reader here is only what cutting needs; the field app and the web maps
 * read packages with the PMTiles library and MapLibre.
 */
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { bytesToHeader, readVarint, tileIdToZxy, zxyToTileId, type Header } from 'pmtiles';

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

const HEADER_BYTES = 127;
/** The header and root directory must fit in the first 16 KiB, which readers fetch at once. */
const FIRST_FETCH = 16_384;
const GZIP = 2;
const NONE = 1;

// ------------------------------------------------------------------ tile maths

const lonToX = (lon: number, z: number) =>
  Math.min((1 << z) - 1, Math.max(0, Math.floor(((lon + 180) / 360) * (1 << z))));
const latToY = (lat: number, z: number) => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z);
  return Math.min((1 << z) - 1, Math.max(0, Math.floor(y)));
};

/** The tiles over a box at one zoom, as x and y ranges. */
export function tileRange(b: Bbox, z: number) {
  return {
    minX: lonToX(b.minLon, z),
    maxX: lonToX(b.maxLon, z),
    minY: latToY(b.maxLat, z),
    maxY: latToY(b.minLat, z),
  };
}

/** How many tiles a box covers from minZoom to maxZoom. */
export function tileCount(b: Bbox, minZoom: number, maxZoom: number): number {
  let n = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = tileRange(b, z);
    n += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  return n;
}

// ------------------------------------------------------------------ directories

function pushVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

export function serializeDirectory(entries: Entry[]): Buffer {
  const out: number[] = [];
  pushVarint(out, entries.length);
  let last = 0;
  for (const e of entries) {
    pushVarint(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) pushVarint(out, e.runLength);
  for (const e of entries) pushVarint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    pushVarint(out, i > 0 && prev && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return Buffer.from(out);
}

export function deserializeDirectory(buf: Uint8Array): Entry[] {
  const p = { buf, pos: 0 };
  const n = readVarint(p);
  const entries: Entry[] = [];
  let last = 0;
  for (let i = 0; i < n; i++) {
    last += readVarint(p);
    entries.push({ tileId: last, offset: 0, length: 0, runLength: 1 });
  }
  for (const e of entries) e.runLength = readVarint(p);
  for (const e of entries) e.length = readVarint(p);
  entries.forEach((e, i) => {
    const v = readVarint(p);
    const prev = entries[i - 1];
    e.offset = v === 0 && prev ? prev.offset + prev.length : v - 1;
  });
  return entries;
}

function find(entries: Entry[], tileId: number): Entry | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    if (e.tileId < tileId) lo = mid + 1;
    else if (e.tileId > tileId) hi = mid - 1;
    else return e;
  }
  const e = hi >= 0 ? entries[hi]! : null;
  return e && (e.runLength === 0 || tileId - e.tileId < e.runLength) ? e : null;
}

// ------------------------------------------------------------------ writer

export interface ArchiveOptions {
  tileType: number;
  tileCompression: number;
  metadata: Record<string, unknown>;
  bounds: Bbox;
  /** The zooms the archive declares when it holds no tiles (an exercise package). */
  zooms?: [number, number];
}

function u64(view: DataView, at: number, v: number): void {
  view.setUint32(at, v % 2 ** 32, true);
  view.setUint32(at + 4, Math.floor(v / 2 ** 32), true);
}

/** A PMTiles v3 archive from tiles keyed by tile id. Identical tiles are stored once. */
export function writeArchive(tiles: Map<number, Uint8Array>, o: ArchiveOptions): Buffer {
  const ids = [...tiles.keys()].sort((a, b) => a - b);
  const contents: Buffer[] = [];
  const byHash = new Map<string, { offset: number; length: number }>();
  let dataLength = 0;
  const entries: Entry[] = [];
  for (const id of ids) {
    const data = Buffer.from(tiles.get(id)!);
    const hash = createHash('sha256').update(data).digest('hex');
    let at = byHash.get(hash);
    if (!at) {
      at = { offset: dataLength, length: data.length };
      byHash.set(hash, at);
      contents.push(data);
      dataLength += data.length;
    }
    const prev = entries[entries.length - 1];
    // A run of consecutive tiles with the same content is one entry.
    if (prev && prev.offset === at.offset && prev.tileId + prev.runLength === id) prev.runLength++;
    else entries.push({ tileId: id, offset: at.offset, length: at.length, runLength: 1 });
  }
  const metadata = gzipSync(Buffer.from(JSON.stringify(o.metadata)));
  // The root directory, split into leaves until it fits the first fetch with the header.
  let root = gzipSync(serializeDirectory(entries));
  let leaves = Buffer.alloc(0);
  for (let size = 4096; HEADER_BYTES + root.length > FIRST_FETCH; size *= 2) {
    const leafParts: Buffer[] = [];
    const rootEntries: Entry[] = [];
    let at = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = gzipSync(serializeDirectory(entries.slice(i, i + size)));
      rootEntries.push({
        tileId: entries[i]!.tileId,
        offset: at,
        length: leaf.length,
        runLength: 0,
      });
      leafParts.push(leaf);
      at += leaf.length;
    }
    root = gzipSync(serializeDirectory(rootEntries));
    leaves = Buffer.concat(leafParts);
  }
  const zooms = ids.map((id) => tileIdToZxy(id)[0]);
  const minZoom = zooms.length ? Math.min(...zooms) : (o.zooms?.[0] ?? 0);
  const maxZoom = zooms.length ? Math.max(...zooms) : (o.zooms?.[1] ?? 0);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const v = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const rootAt = HEADER_BYTES;
  const metaAt = rootAt + root.length;
  const leafAt = metaAt + metadata.length;
  const dataAt = leafAt + leaves.length;
  u64(v, 8, rootAt);
  u64(v, 16, root.length);
  u64(v, 24, metaAt);
  u64(v, 32, metadata.length);
  u64(v, 40, leafAt);
  u64(v, 48, leaves.length);
  u64(v, 56, dataAt);
  u64(v, 64, dataLength);
  u64(v, 72, ids.length);
  u64(v, 80, entries.length);
  u64(v, 88, contents.length);
  v.setUint8(96, 1); // clustered: tile data follows tile id order
  v.setUint8(97, GZIP);
  v.setUint8(98, o.tileCompression);
  v.setUint8(99, o.tileType);
  v.setUint8(100, minZoom);
  v.setUint8(101, maxZoom);
  const e7 = (x: number) => Math.round(x * 1e7);
  v.setInt32(102, e7(o.bounds.minLon), true);
  v.setInt32(106, e7(o.bounds.minLat), true);
  v.setInt32(110, e7(o.bounds.maxLon), true);
  v.setInt32(114, e7(o.bounds.maxLat), true);
  v.setUint8(118, Math.max(minZoom, maxZoom - 2));
  v.setInt32(119, e7((o.bounds.minLon + o.bounds.maxLon) / 2), true);
  v.setInt32(123, e7((o.bounds.minLat + o.bounds.maxLat) / 2), true);
  return Buffer.concat([header, root, metadata, leaves, ...contents]);
}

// ------------------------------------------------------------------ reader and cutter

class Reader {
  private readonly leafCache = new Map<number, Entry[]>();
  private readonly file: FileHandle;
  readonly header: Header;
  private readonly root: Entry[];
  private constructor(file: FileHandle, header: Header, root: Entry[]) {
    this.file = file;
    this.header = header;
    this.root = root;
  }

  static async open(path: string): Promise<Reader> {
    const file = await open(path, 'r');
    try {
      const first = Buffer.alloc(FIRST_FETCH);
      const { bytesRead } = await file.read(first, 0, FIRST_FETCH, 0);
      if (bytesRead < HEADER_BYTES || first.toString('ascii', 0, 7) !== 'PMTiles')
        throw new Error('not a PMTiles archive');
      const header = bytesToHeader(first.buffer.slice(first.byteOffset, first.byteOffset + 127));
      if (header.specVersion !== 3) throw new Error(`PMTiles version ${header.specVersion}`);
      const rootRaw = await Reader.bytes(
        file,
        header.rootDirectoryOffset,
        header.rootDirectoryLength,
      );
      const root = deserializeDirectory(Reader.inflate(rootRaw, header.internalCompression));
      return new Reader(file, header, root);
    } catch (err) {
      await file.close();
      throw err;
    }
  }

  private static async bytes(file: FileHandle, at: number, length: number): Promise<Buffer> {
    const b = Buffer.alloc(length);
    await file.read(b, 0, length, at);
    return b;
  }

  private static inflate(b: Buffer, compression: number): Buffer {
    if (compression === GZIP) return gunzipSync(b);
    if (compression === NONE || compression === 0) return b;
    throw new Error(`directory compression ${compression} is not supported`);
  }

  async metadata(): Promise<Record<string, unknown>> {
    if (!this.header.jsonMetadataLength) return {};
    const raw = await Reader.bytes(
      this.file,
      this.header.jsonMetadataOffset,
      this.header.jsonMetadataLength,
    );
    return JSON.parse(
      Reader.inflate(raw, this.header.internalCompression).toString('utf8'),
    ) as Record<string, unknown>;
  }

  /** A tile's bytes as stored (still compressed as the archive says), or null. */
  async tile(tileId: number): Promise<Buffer | null> {
    let dir = this.root;
    for (let depth = 0; depth <= 3; depth++) {
      const e = find(dir, tileId);
      if (!e) return null;
      if (e.runLength > 0)
        return Reader.bytes(this.file, (this.header.tileDataOffset ?? 0) + e.offset, e.length);
      const at = this.header.leafDirectoryOffset + e.offset;
      let leaf = this.leafCache.get(at);
      if (!leaf) {
        leaf = deserializeDirectory(
          Reader.inflate(
            await Reader.bytes(this.file, at, e.length),
            this.header.internalCompression,
          ),
        );
        this.leafCache.set(at, leaf);
      }
      dir = leaf;
    }
    throw new Error('PMTiles directories nest too deep');
  }

  close(): Promise<void> {
    return this.file.close();
  }
}

export interface Extract {
  archive: Buffer;
  tiles: number;
  minZoom: number;
  maxZoom: number;
}

/**
 * Cuts the tiles over a box, from the region's lowest zoom to `maxZoom`, into a
 * new archive. Refuses a box that would need more than `maxTiles` tiles, so a
 * mistaken outline can never fill the storage.
 */
export async function extractArea(
  sourcePath: string,
  box: Bbox,
  opts: { maxZoom?: number; maxTiles?: number; attribution?: string } = {},
): Promise<Extract> {
  const reader = await Reader.open(sourcePath);
  try {
    const h = reader.header;
    const minZoom = h.minZoom;
    const maxZoom = Math.min(h.maxZoom, opts.maxZoom ?? h.maxZoom);
    const wanted = tileCount(box, minZoom, maxZoom);
    if (wanted > (opts.maxTiles ?? 50_000))
      throw new Error(`the area needs ${wanted} tiles; at most ${opts.maxTiles ?? 50_000}`);
    const tiles = new Map<number, Uint8Array>();
    for (let z = minZoom; z <= maxZoom; z++) {
      const r = tileRange(box, z);
      for (let x = r.minX; x <= r.maxX; x++)
        for (let y = r.minY; y <= r.maxY; y++) {
          const id = zxyToTileId(z, x, y);
          const data = await reader.tile(id);
          if (data && data.length) tiles.set(id, data);
        }
    }
    const metadata = await reader.metadata();
    const archive = writeArchive(tiles, {
      tileType: h.tileType,
      tileCompression: h.tileCompression,
      bounds: box,
      metadata: {
        ...metadata,
        description: 'Offline map package for one area (FLD-13), cut from the county tiles',
        ...(opts.attribution ? { attribution: opts.attribution } : {}),
      },
    });
    return { archive, tiles: tiles.size, minZoom, maxZoom };
  } finally {
    await reader.close();
  }
}
