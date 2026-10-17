/**
 * Live conditions (CON-14; layer-8 plan §6): one shape for every feed. A
 * parser turns a feed document in its source's real format into items; the
 * worker stores them per source and shows each with its source and age.
 * Items describe the public road network or a utility area, never a home.
 */
export type LiveKind = 'road_closure' | 'work_zone' | 'hazard' | 'traffic' | 'outage';
export type LiveSeverity = 'info' | 'minor' | 'major';
export type LiveSourceKind = 'wzdx' | 'waze' | 'utility';

export interface LiveItem {
  /** The source's own id; items are matched to the last pull by it. */
  externalId: string;
  kind: LiveKind;
  summary: string;
  road: string | null;
  /** GeoJSON geometry (WGS84), or null when the source gives none. */
  geometry: unknown | null;
  severity: LiveSeverity;
  startsAt: string | null;
  endsAt: string | null;
  /** When the source last said so (its own update time, or the pull time). */
  asOf: string;
  sourceRef: string | null;
}

export interface ParseResult {
  items: LiveItem[];
  /** Entries the parser could not read, named so staff can see what a feed left out. */
  skipped: { id: string | null; reason: string }[];
}

export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
export const isoOf = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
export const clip = (s: string, max = 500) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
