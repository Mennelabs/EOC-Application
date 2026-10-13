/**
 * US National Grid (FLD-05, SCL-13): WGS 84 latitude and longitude to a
 * USNG/MGRS string and back. UTM by the Krüger series (sub-millimetre over
 * the UTM bands), the MGRS 100 km square letters by the AA scheme (the
 * civilian standard, FGDC-STD-011-2001). Polar regions (UPS) are outside
 * the product's scope (disasters in the 50 states' UTM bands and the band
 * exceptions for Norway and Svalbard are kept for completeness).
 */

export interface Utm {
  zone: number;
  hemisphere: 'N' | 'S';
  easting: number;
  northing: number;
}

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const N = F / (2 - F);
const AA = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);
const ALPHA = [
  N / 2 - (2 / 3) * N ** 2 + (5 / 16) * N ** 3,
  (13 / 48) * N ** 2 - (3 / 5) * N ** 3,
  (61 / 240) * N ** 3,
];
const BETA = [
  N / 2 - (2 / 3) * N ** 2 + (37 / 96) * N ** 3,
  N ** 2 / 48 + N ** 3 / 15,
  (17 / 480) * N ** 3,
];
const DELTA = [
  2 * N - (2 / 3) * N ** 2 - 2 * N ** 3,
  (7 / 3) * N ** 2 - (8 / 5) * N ** 3,
  (56 / 15) * N ** 3,
];

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const COL_LETTERS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_LETTERS = ['ABCDEFGHJKLMNPQRSTUV', 'FGHJKLMNPQRSTUVABCDE'];

export function utmZone(lat: number, lon: number): number {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32; // Norway
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37; // Svalbard
  }
  return zone;
}

export function latitudeBand(lat: number): string {
  if (lat < -80 || lat > 84) throw new RangeError('USNG covers latitudes -80 to 84');
  return BANDS[Math.min(19, Math.floor((lat + 80) / 8))]!;
}

export function toUtm(lat: number, lon: number, zone = utmZone(lat, lon)): Utm {
  const phi = (lat * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180 - lambda0;
  const t = Math.sinh(
    Math.atanh(Math.sin(phi)) -
      ((2 * Math.sqrt(N)) / (1 + N)) * Math.atanh(((2 * Math.sqrt(N)) / (1 + N)) * Math.sin(phi)),
  );
  const xi0 = Math.atan2(t, Math.cos(lambda));
  const eta0 = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let xi = xi0;
  let eta = eta0;
  for (let j = 1; j <= 3; j += 1) {
    xi += ALPHA[j - 1]! * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += ALPHA[j - 1]! * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  const easting = 500000 + K0 * AA * eta;
  let northing = K0 * AA * xi;
  const hemisphere = lat >= 0 ? 'N' : 'S';
  if (hemisphere === 'S') northing += 10000000;
  return { zone, hemisphere, easting, northing };
}

export function fromUtm(u: Utm): { lat: number; lon: number } {
  const x = u.easting - 500000;
  const y = u.hemisphere === 'S' ? u.northing - 10000000 : u.northing;
  const xi = y / (K0 * AA);
  const eta = x / (K0 * AA);
  let xi1 = xi;
  let eta1 = eta;
  for (let j = 1; j <= 3; j += 1) {
    xi1 -= BETA[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  for (let j = 1; j <= 3; j += 1) phi += DELTA[j - 1]! * Math.sin(2 * j * chi);
  const lambda0 = ((u.zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const lambda = lambda0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  return { lat: (phi * 180) / Math.PI, lon: (lambda * 180) / Math.PI };
}

/** The 100 km square letters for a UTM position (AA scheme). */
export function squareLetters(zone: number, easting: number, northing: number): string {
  const set = (zone - 1) % 3;
  const col = Math.floor(easting / 100000); // 1..8
  const row = Math.floor(northing / 100000) % 20;
  const colLetter = COL_LETTERS[set]![col - 1]!;
  const rowLetter = ROW_LETTERS[zone % 2 === 0 ? 1 : 0]![row]!;
  return `${colLetter}${rowLetter}`;
}

/**
 * `toUsng(38.8895, -77.0353)` → `18S UJ 23478 06483` (five digits: 1 m; the Washington Monument, checked against PostGIS).
 * `digits` 1–5 selects 10 km … 1 m precision; the parts are space-separated as
 * the standard writes them for people, and `compact` removes the spaces.
 */
export function toUsng(lat: number, lon: number, digits = 5, compact = false): string {
  if (digits < 1 || digits > 5) throw new RangeError('digits must be 1 to 5');
  const u = toUtm(lat, lon);
  const band = latitudeBand(lat);
  const letters = squareLetters(u.zone, u.easting, u.northing);
  const e = Math.floor(u.easting % 100000);
  const n = Math.floor(u.northing % 100000);
  const div = 10 ** (5 - digits);
  const eText = String(Math.floor(e / div)).padStart(digits, '0');
  const nText = String(Math.floor(n / div)).padStart(digits, '0');
  const parts = [`${u.zone}${band}`, letters, eText, nText];
  return compact ? parts.join('') : parts.join(' ');
}

const USNG_RE = /^\s*(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])([A-HJ-NP-V])\s*([\d ]{2,11})\s*$/i;

/** Parses `18S UJ 23371 06519` or `18SUJ2337106519` to the south-west corner of its cell (plus half a cell: the centre). */
export function fromUsng(text: string): { lat: number; lon: number; precisionM: number } {
  const m = USNG_RE.exec(text.replace(/\s+/g, ' '));
  if (!m) throw new RangeError(`not a USNG coordinate: ${text}`);
  const zone = Number(m[1]);
  const band = m[2]!.toUpperCase();
  const colLetter = m[3]!.toUpperCase();
  const rowLetter = m[4]!.toUpperCase();
  const digitsText = m[5]!.replace(/\s+/g, '');
  if (digitsText.length % 2 !== 0)
    throw new RangeError('easting and northing need the same number of digits');
  const digits = digitsText.length / 2;
  const cell = 10 ** (5 - digits);
  const eIn = Number(digitsText.slice(0, digits)) * cell + cell / 2;
  const nIn = Number(digitsText.slice(digits)) * cell + cell / 2;
  const set = (zone - 1) % 3;
  const col = COL_LETTERS[set]!.indexOf(colLetter) + 1;
  if (col < 1) throw new RangeError('column letter outside the zone set');
  const rowIndex = ROW_LETTERS[zone % 2 === 0 ? 1 : 0]!.indexOf(rowLetter);
  if (rowIndex < 0) throw new RangeError('row letter outside the zone set');
  const easting = col * 100000 + eIn;
  // The band fixes which 2,000 km repeat of the row letters applies.
  const bandIndex = BANDS.indexOf(band);
  const bandSouth = -80 + bandIndex * 8;
  const hemisphere: 'N' | 'S' = bandSouth >= 0 ? 'N' : 'S';
  const bandBottomNorthing = toUtm(
    Math.max(-80, bandSouth),
    (zone - 1) * 6 - 180 + 3,
    zone,
  ).northing;
  let northing = rowIndex * 100000 + nIn;
  while (northing < bandBottomNorthing - 100000) northing += 2000000;
  const p = fromUtm({ zone, hemisphere, easting, northing });
  return { lat: p.lat, lon: p.lon, precisionM: cell };
}
