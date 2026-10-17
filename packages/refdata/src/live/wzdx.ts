/**
 * WZDx (Work Zone Data Exchange, USDOT) road event feeds (CON-14): the open
 * GeoJSON standard most state DOTs publish for work zones, detours and
 * restrictions. Read: each feature's core details (event type, road names,
 * direction, description, update date), its start and end, the vehicle
 * impact and the geometry (a line or points along the road). Field names
 * follow WZDx v4; compare with the state's feed when the county enrols.
 * https://github.com/usdot-jpo-ode/wzdx
 */
import { clip, isoOf, str, type LiveItem, type LiveKind, type ParseResult } from './types.ts';

interface Feature {
  id?: unknown;
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

const KIND: Record<string, LiveKind> = {
  'work-zone': 'work_zone',
  detour: 'road_closure',
  restriction: 'road_closure',
};

export function parseWzdx(doc: unknown, now: Date): ParseResult {
  const d = doc as { features?: unknown; road_event_feed_info?: Record<string, unknown> } | null;
  const features = Array.isArray(d?.features) ? (d.features as Feature[]) : [];
  const feedUpdated = isoOf(d?.road_event_feed_info?.['update_date']);
  const items: LiveItem[] = [];
  const skipped: ParseResult['skipped'] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const core = (p['core_details'] ?? {}) as Record<string, unknown>;
    const id = str(f.id) ?? str(core['data_source_id']);
    if (!id) {
      skipped.push({ id: null, reason: 'no id' });
      continue;
    }
    const eventType = str(core['event_type']) ?? 'work-zone';
    const impact = str(p['vehicle_impact']) ?? 'unknown';
    const roads = Array.isArray(core['road_names'])
      ? (core['road_names'] as unknown[]).map(str).filter((x): x is string => !!x)
      : [];
    const road = roads[0] ?? null;
    const direction = str(core['direction']);
    const description = str(core['description']);
    const closed = impact === 'all-lanes-closed';
    const kind: LiveKind = closed ? 'road_closure' : (KIND[eventType] ?? 'work_zone');
    const what =
      kind === 'road_closure'
        ? 'Closed'
        : eventType === 'work-zone'
          ? impact === 'some-lanes-closed'
            ? 'Work zone, some lanes closed'
            : impact === 'alternating-one-way'
              ? 'Work zone, alternating one way'
              : 'Work zone'
          : eventType === 'detour'
            ? 'Detour'
            : 'Restriction';
    items.push({
      externalId: id,
      kind,
      summary: clip(
        [what, road ? `on ${road}` : null, direction ? `(${direction})` : null, description]
          .filter(Boolean)
          .join(' '),
      ),
      road,
      geometry: f.geometry ?? null,
      severity: closed ? 'major' : impact === 'some-lanes-closed' ? 'minor' : 'info',
      startsAt: isoOf(p['start_date']),
      endsAt: isoOf(p['end_date']),
      asOf: isoOf(core['update_date']) ?? feedUpdated ?? now.toISOString(),
      sourceRef: str(core['data_source_id']),
    });
  }
  return { items, skipped };
}
