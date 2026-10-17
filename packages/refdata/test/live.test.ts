/**
 * Live feed parsers (CON-14; layer-8 plan §6 and §14): WZDx, the Waze
 * partner feed and a utility's outages, read from the recorded synthetic
 * feeds, each item with its kind, road, severity, times and the source's
 * own id; unreadable entries are named, never silently dropped; a
 * geometry the table would refuse is stored as none.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptedGeometry,
  parseOutages,
  parseWaze,
  parseWzdx,
  recordingsDir,
} from '../src/index.ts';

const doc = (file: string) =>
  JSON.parse(readFileSync(join(recordingsDir, file), 'utf8')) as unknown;
const now = new Date('2026-10-15T16:00:00Z');

describe('live feed parsers (CON-14)', () => {
  it('WZDx: work zones, closures and detours with road, direction, impact and times', () => {
    const { items, skipped } = parseWzdx(doc('wzdx-exercise-westwind.json'), now);
    expect(skipped).toEqual([]);
    expect(items.map((i) => [i.externalId, i.kind, i.severity])).toEqual([
      ['exercise-wz-1', 'work_zone', 'minor'],
      ['exercise-wz-2', 'road_closure', 'major'],
      ['exercise-wz-3', 'road_closure', 'info'],
    ]);
    expect(items[0]).toMatchObject({
      road: 'State Route 94',
      startsAt: '2026-10-15T12:00:00.000Z',
      endsAt: '2026-10-18T22:00:00.000Z',
      asOf: '2026-10-15T15:30:00.000Z',
      sourceRef: 'exercise-dot-westwind',
    });
    expect(items[0]!.summary).toBe(
      'Work zone, some lanes closed on State Route 94 (eastbound) EXERCISE: debris removal, one lane open',
    );
    expect(items[1]!.summary).toMatch(/^Closed on Commercial Row/);
    expect((items[0]!.geometry as { type: string }).type).toBe('LineString');
    // An entry without an id is named, not guessed.
    const bad = parseWzdx({ features: [{ properties: { core_details: {} } }] }, now);
    expect(bad.items).toEqual([]);
    expect(bad.skipped).toEqual([{ id: null, reason: 'no id' }]);
  });

  it('Waze: alerts become points by kind, jams become lines by level; no reporter is kept', () => {
    const { items } = parseWaze(doc('waze-partner-exercise-westwind.json'), now);
    expect(items.map((i) => [i.externalId, i.kind, i.severity])).toEqual([
      ['alert:exercise-alert-1', 'road_closure', 'major'],
      ['alert:exercise-alert-2', 'hazard', 'minor'],
      ['alert:exercise-alert-3', 'hazard', 'minor'],
      ['jam:exercise-jam-1', 'traffic', 'major'],
    ]);
    expect(items[0]!.summary).toBe('Road closed on Commercial Row reported by drivers');
    expect(items[3]!.summary).toBe('Standstill traffic on State Route 94 (9 min delay)');
    expect((items[3]!.geometry as { type: string }).type).toBe('LineString');
    expect(JSON.stringify(items)).not.toMatch(/reliability|confidence|reporter/i);
  });

  it('utility outages: customers out, area, cause and the estimated restoration', () => {
    const { items } = parseOutages(doc('utility-outages-exercise-westwind.json'), now);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: 'exercise-outage-1',
      kind: 'outage',
      severity: 'major',
      summary:
        '2,400 customers out in Commercial Row and Elm St (EXERCISE Electric Cooperative): Downed lines',
      endsAt: null,
      asOf: '2026-10-15T15:45:00.000Z',
    });
    expect(items[1]).toMatchObject({ severity: 'minor', endsAt: '2026-10-15T22:00:00.000Z' });
    // The plain list form reads the same.
    const plain = parseOutages(
      { outages: [{ id: 'x', customers_out: 5, lat: 38.8, lon: -90.9 }] },
      now,
    );
    expect(plain.items[0]).toMatchObject({ externalId: 'x', severity: 'info' });
    expect(plain.items[0]!.geometry).toEqual({ type: 'Point', coordinates: [-90.9, 38.8] });
  });

  it('geometry the table would refuse is stored as none', () => {
    expect(acceptedGeometry({ type: 'Point', coordinates: [1, 2] })).toEqual({
      type: 'Point',
      coordinates: [1, 2],
    });
    expect(acceptedGeometry({ type: 'GeometryCollection', geometries: [] })).toBeNull();
    expect(acceptedGeometry({ type: 'Point', coordinates: ['1', 2] })).toBeNull();
    expect(acceptedGeometry('not geometry')).toBeNull();
  });
});
