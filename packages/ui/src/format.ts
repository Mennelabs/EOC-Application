/** Small formatting helpers shared by the shell and the screens. */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Elapsed time since `iso` as the EOC writes it: "T+39h", "T+3d 4h", "T+0h". */
export function elapsedLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return '';
  const ms = Math.max(0, now - start);
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  if (days === 0) return `T+${hours}h`;
  return `T+${days}d ${hours}h`;
}

/** "just now", "8 min ago", "3 h ago", "2 d ago", or the date when older than a week. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(diff / HOUR);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(diff / DAY);
  if (days < 7) return `${days} d ago`;
  return new Date(t).toLocaleDateString();
}

/** Clock time for a timestamp, on the viewer's clock: "10:04 AM". */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Up to two initials from a name or an email address: "Dana Reyes" → "DR", "dana.director@…" → "DD". */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const local = name.includes('@') ? (name.split('@')[0] ?? '') : name;
  const parts = local
    .split(/[\s._-]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  const out = (first + second).toUpperCase();
  return out || '?';
}

const ACRONYMS = new Set([
  'gis',
  'em',
  'afn',
  'coad',
  'voad',
  'ngo',
  'pio',
  'fema',
  'cjis',
  'ai',
  'pda',
  'pod',
  'marc',
  'sema',
  'ics',
  'eoc',
]);

/** A role or state key in words: "planning_gis_lead" → "Planning GIS lead". */
export function humanize(key: string | null | undefined): string {
  if (!key) return '';
  const words = key
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const first = words[0];
  if (first && !ACRONYMS.has(first.toLowerCase())) {
    words[0] = (first[0] ?? '').toUpperCase() + first.slice(1);
  }
  return words.join(' ');
}

/** 1612 → "1,612"; null → "—". */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString();
}
