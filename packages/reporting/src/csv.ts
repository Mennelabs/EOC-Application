/**
 * CSV that opens safely in Excel (BRD:FR-14.05, FR-14.06; DCL:DEC-12): UTF-8
 * with a byte-order mark, CRLF line ends, fields quoted when they hold a
 * comma, quote or line break, and a text field that a spreadsheet could
 * read as a formula (starting with =, +, -, @, tab or carriage return)
 * prefixed with an apostrophe so it stays text. Numbers are written as
 * numbers. Every CSV export uses this, the needs board's included.
 */
export type CsvValue = string | number | boolean | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;
/** The byte-order mark that tells Excel the file is UTF-8. */
const BOM = String.fromCharCode(0xfeff);

export function csvCell(v: CsvValue, unknown = ''): string {
  if (v === null || v === undefined) return quote(unknown);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : quote(unknown);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return quote(FORMULA.test(v) ? `'${v}` : v);
}

function quote(t: string): string {
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** A whole file: the header row, then one line per row. `unknown` fills empty values. */
export function toCsv(
  header: string[],
  rows: CsvValue[][],
  opts: { unknown?: string } = {},
): string {
  const lines = [header.map((h) => csvCell(h)).join(',')];
  for (const r of rows) lines.push(r.map((v) => csvCell(v, opts.unknown ?? '')).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
