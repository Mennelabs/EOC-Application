/**
 * FL:FR-05, Q-04: road reports as a Waze for Cities closure feed. A closed or
 * impassable road is a road closure and one down to one lane a lane-closed
 * hazard, both directions, from when it was reported; the line is written
 * latitude first; a road known only as a point is left out and named back.
 */
import { describe, expect, it } from 'vitest';
import { cifsFeed, lineOf } from '../src/public/waze-cifs.ts';

const at = new Date('2026-10-16T08:00:00Z');

describe('Waze closure feed (CIFS)', () => {
  it('FL:FR-05: closures and lane closures become incidents; a point-only road is left out', () => {
    const { feed, leftOut } = cifsFeed([
      {
        id: 'a',
        name: 'Exercise Canyon Rd',
        status: 'closed',
        reason: 'Trees down',
        reportedAt: at,
        line: [
          [38.79, -90.87],
          [38.791, -90.869],
        ],
      },
      {
        id: 'b',
        name: 'Exercise Main St',
        status: 'one_lane',
        reason: null,
        reportedAt: at,
        line: [
          [38.8, -90.85],
          [38.8005, -90.8495],
        ],
      },
      {
        id: 'c',
        name: 'Exercise Low Rd',
        status: 'impassable',
        reason: null,
        reportedAt: at,
        line: [[38.7, -90.7]],
      },
    ]);
    expect(feed.incidents).toEqual([
      {
        id: 'cg-a',
        type: 'ROAD_CLOSED',
        subtype: 'ROAD_CLOSED_HAZARD',
        polyline: '38.790000 -90.870000 38.791000 -90.869000',
        street: 'Exercise Canyon Rd',
        direction: 'BOTH_DIRECTIONS',
        starttime: '2026-10-16T08:00:00.000Z',
        description: 'Road closed: Trees down',
      },
      {
        id: 'cg-b',
        type: 'HAZARD',
        subtype: 'HAZARD_ON_ROAD_LANE_CLOSED',
        polyline: '38.800000 -90.850000 38.800500 -90.849500',
        street: 'Exercise Main St',
        direction: 'BOTH_DIRECTIONS',
        starttime: '2026-10-16T08:00:00.000Z',
        description: 'One lane open',
      },
    ]);
    expect(leftOut).toEqual([
      { id: 'c', name: 'Exercise Low Rd', reason: 'drawn as a point; Waze needs a line' },
    ]);
  });

  it('FL:FR-05: a GeoJSON line is read latitude first; a point or bad geometry gives no line', () => {
    expect(
      lineOf(
        JSON.stringify({
          type: 'LineString',
          coordinates: [
            [-90.87, 38.79],
            [-90.869, 38.791],
          ],
        }),
      ),
    ).toEqual([
      [38.79, -90.87],
      [38.791, -90.869],
    ]);
    expect(
      lineOf(
        JSON.stringify({
          type: 'MultiLineString',
          coordinates: [
            [
              [-90.8, 38.7],
              [-90.81, 38.71],
            ],
          ],
        }),
      ),
    ).toEqual([
      [38.7, -90.8],
      [38.71, -90.81],
    ]);
    expect(lineOf(JSON.stringify({ type: 'Point', coordinates: [-90.8, 38.7] }))).toEqual([]);
    expect(lineOf('not json')).toEqual([]);
    expect(lineOf(null)).toEqual([]);
  });
});
