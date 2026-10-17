import { describe, expect, it } from 'vitest';
import { nextStop, routeOf } from '../src/canteen';

describe('canteen route (FL:FR-17)', () => {
  it('takes the stops from the first mission whose route lists them, and the next one not yet left', () => {
    const route = routeOf([
      { id: 'job', route: null },
      { id: 'sweep', route: { stops: [] } },
      {
        id: 'canteen',
        route: {
          stops: [
            { name: 'Exercise Pine Park lot', lat: 38.79, lon: -90.86 },
            { name: 'Exercise church lot' },
            { nope: true },
          ],
        },
      },
    ]);
    expect(route.missionId).toBe('canteen');
    expect(route.stops.map((s) => s.name)).toEqual([
      'Exercise Pine Park lot',
      'Exercise church lot',
    ]);
    expect(nextStop(route.stops, [])?.name).toBe('Exercise Pine Park lot');
    expect(nextStop(route.stops, ['Exercise Pine Park lot'])?.name).toBe('Exercise church lot');
    expect(nextStop(route.stops, ['Exercise Pine Park lot', 'Exercise church lot'])).toBeNull();
    expect(routeOf([{ id: 'x' }])).toEqual({ missionId: null, stops: [] });
  });
});
