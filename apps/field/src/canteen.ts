/**
 * The canteen route's stops (FL:FR-17): taken from the first mission on the
 * phone whose route lists stops by name (with a place when dispatch gave
 * one), and the next stop is the first one the crew has not checked out of.
 */
export interface Stop {
  name: string;
  lat?: number;
  lon?: number;
}

export function routeOf(missions: { id: string; route?: { stops?: unknown } | null }[]): {
  missionId: string | null;
  stops: Stop[];
} {
  for (const m of missions) {
    const stops = m.route?.stops;
    if (Array.isArray(stops) && stops.length)
      return {
        missionId: m.id,
        stops: stops.filter(
          (s): s is Stop =>
            typeof s === 'object' && s !== null && typeof (s as Stop).name === 'string',
        ),
      };
  }
  return { missionId: null, stops: [] };
}

export function nextStop(stops: Stop[], visited: string[]): Stop | null {
  return stops.find((s) => !visited.includes(s.name)) ?? null;
}
