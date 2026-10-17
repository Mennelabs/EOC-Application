/**
 * Utility outage feeds (CON-14): where a utility publishes outages, as
 * GeoJSON (one feature per outage area with `customers_out`, `utility`,
 * `area`, `started_at`, `estimated_restoration`, `cause`) or as the same
 * fields in a plain `{ outages: [...] }` list. Counts and areas only; a
 * customer is never named. The county's ODIN county-level figures stay as
 * they are (layer 6); this is the finer feed a utility offers.
 */
import { clip, isoOf, num, str, type LiveItem, type ParseResult } from './types.ts';

interface Entry {
  id?: unknown;
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export function parseOutages(doc: unknown, now: Date): ParseResult {
  const d = doc as { features?: unknown; outages?: unknown } | null;
  const entries = Array.isArray(d?.features)
    ? (d.features as Entry[])
    : Array.isArray(d?.outages)
      ? (d.outages as Entry[])
      : [];
  const items: LiveItem[] = [];
  const skipped: ParseResult['skipped'] = [];
  for (const e of entries) {
    const p = (e.properties ?? e) as Record<string, unknown>;
    const id = str(e.id) ?? str(p['id']);
    if (!id) {
      skipped.push({ id: null, reason: 'no id' });
      continue;
    }
    const customers = num(p['customers_out']) ?? num(p['customersOut']);
    const utility = str(p['utility']);
    const area = str(p['area']);
    const cause = str(p['cause']);
    const geometry =
      e.geometry ??
      (num(p['lon']) !== null && num(p['lat']) !== null
        ? { type: 'Point', coordinates: [num(p['lon']), num(p['lat'])] }
        : null);
    items.push({
      externalId: id,
      kind: 'outage',
      summary: clip(
        [
          customers !== null ? `${customers.toLocaleString('en-US')} customers out` : 'Outage',
          area ? `in ${area}` : null,
          utility ? `(${utility})` : null,
        ]
          .filter(Boolean)
          .join(' ') + (cause ? `: ${cause}` : ''),
      ),
      road: null,
      geometry,
      severity:
        customers !== null && customers >= 1000
          ? 'major'
          : customers !== null && customers >= 100
            ? 'minor'
            : 'info',
      startsAt: isoOf(p['started_at']) ?? isoOf(p['startedAt']),
      endsAt: isoOf(p['estimated_restoration']) ?? isoOf(p['estimatedRestoration']),
      asOf: isoOf(p['as_of']) ?? isoOf(p['updated_at']) ?? now.toISOString(),
      sourceRef: utility,
    });
  }
  return { items, skipped };
}
