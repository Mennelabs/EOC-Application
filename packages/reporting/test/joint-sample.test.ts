/**
 * The joint assessment's sample route (FL:FR-10): proportional to the
 * counted homes by degree, every degree with homes seen when the sample can
 * afford it, the same seed draws the same sample, never a home twice, route
 * order by nearest neighbour with unplaced homes last; Box 10 text.
 */
import { describe, expect, it } from 'vitest';
import {
  allocate,
  jointPdaBox10,
  proportionalSample,
  routeOrder,
  type SampleCandidate,
} from '../src/fema/index.ts';

const homes = (n: number, degree: SampleCandidate['degree'], from = 0): SampleCandidate[] =>
  Array.from({ length: n }, (_, i) => ({
    recordId: `${degree}-${String(from + i).padStart(4, '0')}`,
    degree,
    point: [-90.9 + (from + i) * 0.001, 38.8 + ((from + i) % 7) * 0.001],
  }));

describe('joint assessment sample', () => {
  const population = [
    ...homes(60, 'affected'),
    ...homes(25, 'minor'),
    ...homes(12, 'major'),
    ...homes(3, 'destroyed'),
  ];

  it('allocates in proportion, with every degree seen when the sample can afford it', () => {
    expect(allocate({ affected: 60, minor: 25, major: 12, destroyed: 3 }, 20)).toEqual({
      affected: 12,
      minor: 5,
      major: 2,
      destroyed: 1,
    });
    // A degree too small for a share still gets one, from the largest share.
    expect(allocate({ affected: 90, minor: 9, major: 0, destroyed: 1 }, 10)).toEqual({
      affected: 8,
      minor: 1,
      major: 0,
      destroyed: 1,
    });
    // Too small to see every degree: the largest shares win, severe first on ties.
    expect(allocate({ affected: 10, minor: 10, major: 0, destroyed: 0 }, 1)).toEqual({
      affected: 0,
      minor: 1,
      major: 0,
      destroyed: 0,
    });
    // Asking for more than there are takes every home.
    expect(allocate({ affected: 2, minor: 1, major: 0, destroyed: 1 }, 50)).toEqual({
      affected: 2,
      minor: 1,
      major: 0,
      destroyed: 1,
    });
    for (const size of [1, 4, 7, 19, 33, 100])
      expect(
        Object.values(allocate({ affected: 60, minor: 25, major: 12, destroyed: 3 }, size)).reduce(
          (a, b) => a + b,
        ),
      ).toBe(size);
  });

  it('draws the same sample from the same seed, a different one from another, never a home twice', () => {
    const a = proportionalSample(population, 20, 42);
    const b = proportionalSample([...population].reverse(), 20, 42);
    expect(a.stops.map((s) => s.recordId)).toEqual(b.stops.map((s) => s.recordId));
    const c = proportionalSample(population, 20, 43);
    expect(c.stops.map((s) => s.recordId).sort()).not.toEqual(
      a.stops.map((s) => s.recordId).sort(),
    );
    expect(new Set(a.stops.map((s) => s.recordId)).size).toBe(20);
    expect(a.stops.filter((s) => s.degree === 'destroyed')).toHaveLength(1);
    expect(a.stops.map((s) => s.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('orders the route by nearest neighbour from the west; homes with no position go last', () => {
    const route = routeOrder([
      { id: 'east', point: [-90.0, 38.8] as [number, number] },
      { id: 'none', point: null },
      { id: 'west', point: [-91.0, 38.8] as [number, number] },
      { id: 'middle', point: [-90.5, 38.8] as [number, number] },
      { id: 'near-west', point: [-90.95, 38.8] as [number, number] },
    ]);
    expect(route.map((r) => r.id)).toEqual(['west', 'near-west', 'middle', 'east', 'none']);
  });

  it('fills Box 10 from the schedule, or leaves it unknown', () => {
    expect(jointPdaBox10(null)).toEqual({ dates: null, areas: null });
    expect(
      jointPdaBox10({ startsOn: '2026-10-20', endsOn: '2026-10-22', areas: ['North', 'River'] }),
    ).toEqual({ dates: '2026-10-20 to 2026-10-22', areas: 'North; River' });
    expect(jointPdaBox10({ startsOn: '2026-10-20', endsOn: '2026-10-20', areas: [] })).toEqual({
      dates: '2026-10-20',
      areas: null,
    });
  });
});
