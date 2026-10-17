/**
 * The Waze for Cities partner feed, receive side (CON-14; FL:FR-05 built the
 * publish side): alerts (closures, hazards, accidents, weather) and jams
 * reported by drivers in the county's area. Free to government partners;
 * off until the county enrols and sets the feed address Waze gives it.
 * Alerts are points; jams are lines with a level (0 to 5) and a delay. Only
 * the road, the kind and the time are kept: never a reporter.
 */
import { clip, isoOf, num, str, type LiveItem, type LiveKind, type ParseResult } from './types.ts';

interface Alert {
  uuid?: unknown;
  type?: unknown;
  subtype?: unknown;
  street?: unknown;
  city?: unknown;
  location?: { x?: unknown; y?: unknown } | null;
  pubMillis?: unknown;
  reliability?: unknown;
}
interface Jam {
  uuid?: unknown;
  street?: unknown;
  line?: { x?: unknown; y?: unknown }[] | null;
  level?: unknown;
  delay?: unknown;
  length?: unknown;
  pubMillis?: unknown;
}

const ALERT_KIND: Record<string, LiveKind> = {
  ROAD_CLOSED: 'road_closure',
  HAZARD: 'hazard',
  ACCIDENT: 'hazard',
  WEATHERHAZARD: 'hazard',
  JAM: 'traffic',
};
const label = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export function parseWaze(doc: unknown, now: Date): ParseResult {
  const d = doc as { alerts?: unknown; jams?: unknown } | null;
  const alerts = Array.isArray(d?.alerts) ? (d.alerts as Alert[]) : [];
  const jams = Array.isArray(d?.jams) ? (d.jams as Jam[]) : [];
  const items: LiveItem[] = [];
  const skipped: ParseResult['skipped'] = [];
  for (const a of alerts) {
    const id = str(a.uuid);
    const type = str(a.type);
    if (!id || !type) {
      skipped.push({ id, reason: 'no id or type' });
      continue;
    }
    const x = num(a.location?.x);
    const y = num(a.location?.y);
    const kind = ALERT_KIND[type] ?? 'hazard';
    const street = str(a.street);
    const subtype = str(a.subtype);
    items.push({
      externalId: `alert:${id}`,
      kind,
      summary: clip(
        [
          kind === 'road_closure' ? 'Road closed' : label(subtype ?? type),
          street ? `on ${street}` : null,
          'reported by drivers',
        ]
          .filter(Boolean)
          .join(' '),
      ),
      road: street,
      geometry: x !== null && y !== null ? { type: 'Point', coordinates: [x, y] } : null,
      severity: kind === 'road_closure' ? 'major' : kind === 'hazard' ? 'minor' : 'info',
      startsAt: isoOf(a.pubMillis),
      endsAt: null,
      asOf: isoOf(a.pubMillis) ?? now.toISOString(),
      sourceRef: null,
    });
  }
  for (const j of jams) {
    const id = str(j.uuid);
    if (!id) {
      skipped.push({ id: null, reason: 'jam without id' });
      continue;
    }
    const coords = (j.line ?? [])
      .map((p) => [num(p.x), num(p.y)] as [number | null, number | null])
      .filter((c): c is [number, number] => c[0] !== null && c[1] !== null);
    const level = num(j.level) ?? 0;
    const delay = num(j.delay);
    const street = str(j.street);
    items.push({
      externalId: `jam:${id}`,
      kind: 'traffic',
      summary: clip(
        [
          level >= 4 ? 'Standstill traffic' : level >= 2 ? 'Heavy traffic' : 'Slow traffic',
          street ? `on ${street}` : null,
          delay !== null && delay > 0 ? `(${Math.round(delay / 60)} min delay)` : null,
        ]
          .filter(Boolean)
          .join(' '),
      ),
      road: street,
      geometry: coords.length >= 2 ? { type: 'LineString', coordinates: coords } : null,
      severity: level >= 4 ? 'major' : level >= 2 ? 'minor' : 'info',
      startsAt: isoOf(j.pubMillis),
      endsAt: null,
      asOf: isoOf(j.pubMillis) ?? now.toISOString(),
      sourceRef: null,
    });
  }
  return { items, skipped };
}
