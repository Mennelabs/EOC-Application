/**
 * Well-known binary geometry → GeoJSON (OGC Simple Features), as GeoPackage
 * stores it after its own header. Points, line strings, polygons and their
 * multi forms, with Z, M or ZM (ISO 1001–3007 type codes or the EWKB flags);
 * only X and Y are kept. Anything else is refused by name.
 */
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString' | 'MultiPoint'; coordinates: number[][] }
  | { type: 'Polygon' | 'MultiLineString'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

const NAMES = [
  '',
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
];

export function readWkb(buf: Buffer, start = 0): GeoJsonGeometry {
  let pos = start;
  const geometry = (): GeoJsonGeometry => {
    const little = buf.readUInt8(pos) === 1;
    pos += 1;
    const u32 = () => {
      const v = little ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
      pos += 4;
      return v;
    };
    const f64 = () => {
      const v = little ? buf.readDoubleLE(pos) : buf.readDoubleBE(pos);
      pos += 8;
      return v;
    };
    let code = u32();
    let dims = 2;
    // EWKB flags (PostGIS): Z 0x80000000, M 0x40000000, SRID 0x20000000.
    if (code & 0xe0000000) {
      if (code & 0x80000000) dims++;
      if (code & 0x40000000) dims++;
      if (code & 0x20000000) u32();
      code &= 0x0fffffff;
    } else if (code >= 1000) {
      dims += code >= 3000 ? 2 : 1;
      code %= 1000;
    }
    const point = () => {
      const c = [f64(), f64()];
      for (let i = 2; i < dims; i++) f64();
      return c;
    };
    const points = () => Array.from({ length: u32() }, point);
    const rings = () => Array.from({ length: u32() }, points);
    switch (code) {
      case 1:
        return { type: 'Point', coordinates: point() };
      case 2:
        return { type: 'LineString', coordinates: points() };
      case 3:
        return { type: 'Polygon', coordinates: rings() };
      case 4:
      case 5:
      case 6: {
        const parts = Array.from({ length: u32() }, geometry);
        if (code === 4)
          return { type: 'MultiPoint', coordinates: parts.map((p) => p.coordinates as number[]) };
        if (code === 5)
          return {
            type: 'MultiLineString',
            coordinates: parts.map((p) => p.coordinates as number[][]),
          };
        return {
          type: 'MultiPolygon',
          coordinates: parts.map((p) => p.coordinates as number[][][]),
        };
      }
      default:
        throw new Error(`geometry type ${NAMES[code] ?? code} is not supported`);
    }
  };
  return geometry();
}

/** A GeoPackage geometry blob: "GP" header (with an optional envelope), then WKB. */
export function readGpkgGeometry(blob: Uint8Array): {
  srsId: number;
  geometry: GeoJsonGeometry | null;
} {
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (buf.length < 8 || buf.toString('latin1', 0, 2) !== 'GP')
    throw new Error('not a GeoPackage geometry');
  const flags = buf.readUInt8(3);
  const little = (flags & 1) === 1;
  const srsId = little ? buf.readInt32LE(4) : buf.readInt32BE(4);
  const envelope = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0;
  const empty = (flags & 0x10) !== 0;
  return { srsId, geometry: empty ? null : readWkb(buf, 8 + envelope) };
}
