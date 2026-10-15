/**
 * Feeding, POD with walk-up points, and MARC recommendations (layer-7 task
 * E2; REC-05–REC-12) on the docs/02 WESTWIND scenario: Sunday noon, two
 * canteens and 610 households asking for food or water; Monday 10 am, 6,200
 * customers without power and a tract where 23% of households have no
 * vehicle; Wednesday, 164 major and destroyed homes, mostly rented, many
 * uninsured. Same inputs, same answer; unknown is said, never guessed.
 */
import { describe, expect, it } from 'vitest';
import { PLANNING_DEFAULTS, type Candidate, type Tract } from '../src/recommend.ts';
import {
  feedingFilters,
  groupRequests,
  languageName,
  marcFilters,
  podFilters,
  recommendFeeding,
  recommendMarc,
  recommendPod,
  type Canteen,
  type DemandCell,
  type MarcDemand,
  type PodDemand,
} from '../src/recommend-sites.ts';

const base = (over: Partial<Candidate>): Candidate => ({
  id: 'x',
  name: 'x',
  kind: 'school',
  position: { lat: 38.8, lon: -90.85 },
  sqft: 10000,
  ada: true,
  powerBackup: 'generator',
  kitchen: true,
  showers: 4,
  petPolicy: 'service_animals',
  floodplain: 'out',
  mouStatus: 'signed',
  parkingSpaces: 50,
  truckAccess: true,
  lastConfirmedAt: new Date('2026-06-01T00:00:00Z'),
  inDamageArea: false,
  inFloodZone: false,
  inOutage: false,
  blockedRoad: false,
  inDebrisArea: false,
  ...over,
});

/** Three cells a few hundred metres apart around a place. */
const area = (
  lat: number,
  lon: number,
  food: number,
  extra: Partial<Omit<DemandCell, 'position' | 'food'>> = {},
): DemandCell[] => {
  const a = Math.floor(food / 3);
  return [
    { position: { lat, lon }, food: food - 2 * a, languages: {}, pets: 0, talk: 0, ...extra },
    { position: { lat: lat + 0.002, lon }, food: a, languages: {}, pets: 0, talk: 0 },
    { position: { lat, lon: lon + 0.002 }, food: a, languages: {}, pets: 0, talk: 0 },
  ];
};

const CEDAR = { lat: 38.79, lon: -90.85 };
const PRAIRIE = { lat: 38.83, lon: -90.78 };
const WILLOW = { lat: 38.76, lon: -90.9 };
const HARMON = { lat: 38.85, lon: -90.7 };
const OAK = { lat: 38.7, lon: -90.6 };

// 610 households asking for food or water, 31 with pets, 27 wanting someone to talk to.
const cells: DemandCell[] = [
  ...area(CEDAR.lat, CEDAR.lon, 168, { languages: { es: 120, en: 30 }, pets: 14, talk: 8 }),
  ...area(PRAIRIE.lat, PRAIRIE.lon, 200, { languages: { en: 180 }, pets: 10, talk: 10 }),
  ...area(WILLOW.lat, WILLOW.lon, 140, { pets: 5, talk: 1 }),
  ...area(HARMON.lat, HARMON.lon, 82, { pets: 2, talk: 8 }),
  ...area(OAK.lat, OAK.lon, 20),
];

const canteens: Canteen[] = [
  {
    teamId: 't2',
    name: 'Canteen 2',
    agency: 'Hope Canteen Services',
    mealsPerHour: 200,
    staff: 3,
    skills: ['food_safety'],
  },
  {
    teamId: 't1',
    name: 'Canteen 1',
    agency: 'Hope Canteen Services',
    mealsPerHour: null,
    staff: 3,
    skills: ['food_safety', 'spanish_speaker'],
  },
];

const feedingSites: Candidate[] = [
  base({
    id: 'cedar-lot',
    name: 'Cedar Ridge parking lot',
    kind: 'parking_lot',
    position: { lat: 38.791, lon: -90.851 },
    parkingSpaces: null,
    truckAccess: null,
  }),
  base({
    id: 'prairie-school',
    name: 'Prairie Lakes Elementary',
    position: { lat: 38.832, lon: -90.781 },
    parkingSpaces: 80,
  }),
  base({
    id: 'willow-church',
    name: 'Willow Bend chapel',
    kind: 'place_of_worship',
    position: { lat: 38.761, lon: -90.901 },
    parkingSpaces: null,
  }),
  base({
    id: 'willow-park',
    name: 'Willow Bend park lot',
    kind: 'parking_lot',
    position: { lat: 38.762, lon: -90.899 },
    inFloodZone: true,
  }),
];

describe('feeding stops (REC-05, REC-06)', () => {
  const r = recommendFeeding(feedingSites, cells, canteens, [], []);

  it('docs/02 Sunday noon: four stops across two canteens, largest first, with windows and meals', () => {
    expect(r.demand).toEqual({
      households: 610,
      people: 1525,
      meals: 1525,
      petHouseholds: 31,
      talkHouseholds: 27,
    });
    expect(
      r.stops.map((s) => [s.stop, s.canteen?.name, s.window.start, s.window.end, s.households]),
    ).toEqual([
      [1, 'Canteen 1', '11:00', '13:30', 200],
      [2, 'Canteen 2', '11:00', '13:30', 168],
      [3, 'Canteen 1', '16:30', '19:00', 140],
      [4, 'Canteen 2', '16:30', '19:00', 82],
    ]);
    expect(r.unserved).toBe(20);
    expect(r.whatWouldChange.join(' ')).toContain(
      '20 households asking for food or water are beyond these stops',
    );
  });

  it('the Cedar Ridge stop: about 420 meals, a Spanish-speaking volunteer, pet food and a chaplain', () => {
    const cedar = r.stops.find((s) => s.facilityId === 'cedar-lot')!;
    expect(cedar).toMatchObject({ place: 'Cedar Ridge parking lot', meals: 420 });
    expect(cedar.notes).toEqual([
      'Most requests here came in Spanish: bring a Spanish-speaking volunteer',
      '14 households here asked for help with pets: bring pet food',
      '8 households here asked for someone to talk to: suggest a chaplain or crisis counselor at this stop',
    ]);
    // Canteen 2 declared 200 meals an hour: 500 in the window covers 420.
    expect(cedar.reasons).toContain('Canteen 2 serves about 500 meals in the window');
    // A parking lot whose truck access is not recorded says so.
    expect(cedar.unknown).toEqual(['truck access']);
  });

  it('REC-06, REC-10: a canteen with no declared rate is said to be unknown, never guessed', () => {
    const prairie = r.stops[0]!;
    expect(prairie.canteen?.name).toBe('Canteen 1');
    expect(prairie.unknown).toContain('meals an hour for Canteen 1');
    expect(prairie.notes.join(' ')).not.toContain('serves in the window');
  });

  it('a canteen that cannot serve the stop in the window is told to send a second unit', () => {
    const one = recommendFeeding(
      feedingSites,
      area(CEDAR.lat, CEDAR.lon, 300),
      [canteens[0]!],
      [],
      [],
    );
    expect(one.stops[0]!.notes[0]).toBe(
      'About 750 meals is more than Canteen 2 serves in the window (about 500): send a second unit or lengthen the window',
    );
  });

  it('a stop with no safe registered site nearby gets an open area, and unsafe or unknown places are set aside with reasons', () => {
    const willow = r.stops[2]!;
    expect(willow.facilityId).toBeNull();
    expect(willow.place).toMatch(/^Open area near 38\.76/);
    const why = new Map(r.excluded.map((x) => [x.facilityId, x.reasons.join(' ')]));
    expect(why.get('willow-park')).toContain('in a flood zone');
    expect(why.get('willow-church')).toContain('parking unknown');
    expect(feedingFilters(base({ parkingSpaces: 0 }))).toEqual(['no parking for a canteen']);
  });

  it('with no canteen on the roster it still shows where stops would go, and says what is missing', () => {
    const none = recommendFeeding(feedingSites, cells, [], [], []);
    expect(none.stops).toHaveLength(PLANNING_DEFAULTS.stopsPerCanteen);
    expect(none.stops.every((s) => s.canteen === null)).toBe(true);
    expect(none.whatWouldChange[0]).toContain('No canteen is on the roster');
  });

  it('is deterministic, whatever order the inputs come in', () => {
    const again = recommendFeeding(
      [...feedingSites].reverse(),
      [...cells].reverse(),
      [...canteens].reverse(),
      [],
      [],
    );
    expect(again).toEqual(r);
  });

  it('groups requests within the radius and leaves the rest as unserved', () => {
    const g = groupRequests(cells, 2, 2);
    expect(g.groups.map((x) => x.households)).toEqual([200, 168]);
    expect(g.rest).toBe(242);
    expect(languageName('es')).toBe('Spanish');
  });
});

// ---------------------------------------------------------------- POD (REC-07, REC-08)

const podSites: Candidate[] = [
  base({
    id: 'fair-lot',
    name: 'County fairgrounds lot',
    kind: 'parking_lot',
    position: { lat: 38.805, lon: -90.82 },
    parkingSpaces: 400,
  }),
  base({
    id: 'hs-gym',
    name: 'Harmon High School gym',
    position: { lat: 38.812, lon: -90.79 },
    parkingSpaces: 120,
  }),
  base({ id: 'church', name: 'Grace church', kind: 'place_of_worship', parkingSpaces: 25 }),
  base({ id: 'center', name: 'Community center', truckAccess: false, parkingSpaces: 200 }),
  base({ id: 'debris-lot', name: 'Mill lot', kind: 'parking_lot', inDebrisArea: true }),
  base({ id: 'unknown-trucks', name: 'Depot', truckAccess: null, parkingSpaces: 300 }),
  base({
    id: 'cedar-lot',
    name: 'Cedar Ridge parking lot',
    kind: 'parking_lot',
    position: { lat: 38.791, lon: -90.851 },
    truckAccess: null,
  }),
];
const podDemand: PodDemand = {
  powerCustomersOut: 6200,
  outagesUncounted: 0,
  waterOutages: 0,
  restorationAt: '2026-10-16T22:00:00.000Z',
  centroid: { lat: 38.8, lon: -90.82 },
};
const tract = (over: Partial<Tract>): Tract => ({
  geoid: '29999000100',
  name: 'Cedar Ridge',
  centroid: CEDAR,
  households: 1200,
  incomeBand: 1,
  renterSharePct: 62,
  limitedEnglishPct: 28,
  noVehiclePct: 23,
  affected: true,
  ...over,
});
const podTracts: Tract[] = [
  tract({}),
  tract({
    geoid: '29999000200',
    name: 'Prairie Lakes',
    centroid: PRAIRIE,
    noVehiclePct: 5,
    incomeBand: 4,
  }),
  tract({
    geoid: '29999000300',
    name: 'Far Hills',
    centroid: { lat: 39.2, lon: -91.2 },
    noVehiclePct: 30,
    affected: false,
  }),
];

describe('POD and walk-up points (REC-07, REC-08)', () => {
  const r = recommendPod(podSites, podDemand, podTracts, []);

  it('docs/02 Monday 10 am: 6,200 customers, about 15,500 people, one Type II POD and its 72-hour supplies', () => {
    expect(r.demand).toMatchObject({ powerCustomersOut: 6200, people: 15500, peoplePerDay: 7750 });
    expect(r.pod).toEqual({ type: 'II', count: 1, peoplePerDay: 7750 });
    expect(r.supplies).toEqual({
      days: 3,
      waterGallons: 23250,
      iceLbMin: 139500,
      iceLbMax: 186000,
      meals: 46500,
    });
    expect(r.top[0]).toMatchObject({ facilityId: 'fair-lot', name: 'County fairgrounds lot' });
    expect(r.top.map((t) => t.facilityId)).toContain('hs-gym');
  });

  it('a POD needs semi-truck access and a large lot outside damage, flood and debris; unknown is set aside', () => {
    const why = new Map(r.excluded.map((x) => [x.facilityId, x.reasons.join(' ')]));
    expect(why.get('church')).toContain('25 parking spaces; a drive-through POD needs about 100');
    expect(why.get('center')).toContain('no semi-truck access');
    expect(why.get('debris-lot')).toContain('inside a reported debris area');
    expect(why.get('unknown-trucks')).toContain('semi-truck access unknown');
    expect(podFilters(podSites[0]!, PLANNING_DEFAULTS)).toEqual([]);
    expect(r.checks).toEqual(
      expect.arrayContaining([
        'Hospital routes are not loaded: keep the queue off the route to the hospital.',
      ]),
    );
  });

  it('a walk-up point where 23% of households have no vehicle, with a communications trailer; none where the tract is not affected', () => {
    expect(r.walkUps).toHaveLength(1);
    expect(r.walkUps[0]).toMatchObject({
      geoid: '29999000100',
      noVehiclePct: 23,
      facilityId: 'cedar-lot',
      place: 'Cedar Ridge parking lot',
    });
    expect(r.walkUps[0]!.reasons[0]).toBe(
      '23% of households in Cedar Ridge have no vehicle (Census ACS)',
    );
    expect(r.walkUps[0]!.notes[0]).toBe(
      'Ask for a partner communications trailer for phone charging and Wi-Fi: 6,200 customers without power',
    );
    // REC-11: Far Hills is high-need and out of reach of the POD and the walk-up point.
    expect(r.equity.uncovered.map((u) => u.geoid)).toEqual(['29999000300']);
  });

  it('sizes up: past 20,000 people a day it takes more than one Type I POD', () => {
    const big = recommendPod(podSites, { ...podDemand, powerCustomersOut: 40000 }, [], []);
    expect(big.pod).toEqual({ type: 'I', count: 3, peoplePerDay: 50000 });
    expect(big.checks).toContain(
      'Census vehicle data is not loaded, so walk-up points cannot be suggested.',
    );
  });

  it('no outage, no POD; uncounted outages say so', () => {
    const none = recommendPod(podSites, { ...podDemand, powerCustomersOut: 0 }, podTracts, []);
    expect(none.pod).toBeNull();
    expect(none.top).toEqual([]);
    expect(none.walkUps).toEqual([]);
    expect(none.whatWouldChange).toEqual([
      'No open power outage with customers counted: no POD is needed on these inputs.',
    ]);
    const uncounted = recommendPod(
      podSites,
      { ...podDemand, powerCustomersOut: 0, outagesUncounted: 2 },
      [],
      [],
    );
    expect(uncounted.whatWouldChange[0]).toContain('have no customer count yet');
  });
});

// ---------------------------------------------------------------- MARC (REC-09)

const marcDemand: MarcDemand = {
  majorDestroyed: 164,
  renters: 95,
  owners: 69,
  insured: 87,
  uninsured: 77,
  needs: {
    shelter_tonight: 40,
    someone_to_talk: 27,
    food_water: 610,
    pets: 31,
    medical_power: 6,
    transportation: 12,
  },
  languages: { en: 600, es: 180, vi: 12 },
  centroid: { lat: 38.79, lon: -90.85 },
};
const marcSites: Candidate[] = [
  base({
    id: 'hall',
    name: 'Union hall',
    position: { lat: 38.792, lon: -90.848 },
    sqft: 4000,
    parkingSpaces: 60,
    powerBackup: 'none',
  }),
  base({
    id: 'gym',
    name: 'Harmon High School gym',
    position: { lat: 38.812, lon: -90.79 },
    sqft: 14000,
    parkingSpaces: 120,
  }),
  base({ id: 'small', name: 'Small hall', sqft: 2000 }),
  base({ id: 'no-ada', name: 'Old library', ada: null, sqft: 6000 }),
  base({ id: 'lot', name: 'Fair lot', kind: 'parking_lot', sqft: 200000 }),
  base({ id: 'dark', name: 'Dark center', inOutage: true, powerBackup: 'none', sqft: 6000 }),
];

describe('MARC (REC-09)', () => {
  const r = recommendMarc(marcSites, marcDemand, [], []);

  it('docs/02 Wednesday: the partner mix follows the top recovery needs, with tables and floor space', () => {
    expect(r.services.map((s) => [s.service, s.households, s.tables])).toEqual([
      ['Housing', 204, 4],
      ['Legal aid', 95, 4],
      ['Insurance help', 87, 4],
      ['Disaster loans and grants', 77, 4],
      ['Crisis counseling', 27, 2],
    ]);
    expect(r.tables).toBe(18);
    expect(r.sqftNeeded).toBe(2800);
    expect(r.demand).toEqual({ majorDestroyed: 164, renterPct: 57.9, uninsuredPct: 47 });
  });

  it('interpreters follow the languages residents reported in, Spanish first', () => {
    expect(r.interpreters).toEqual([
      { language: 'es', name: 'Spanish', reports: 180 },
      { language: 'vi', name: 'Vietnamese', reports: 12 },
    ]);
  });

  it('the site is close to the damaged homes, accessible and big enough; the rest are set aside with reasons', () => {
    expect(r.top.map((t) => t.facilityId)).toEqual(['hall', 'gym']);
    const why = new Map(r.excluded.map((x) => [x.facilityId, x.reasons.join(' ')]));
    expect(why.get('small')).toContain(
      '2,000 sq ft; 18 partner tables with waiting space need about 2,800',
    );
    expect(why.get('no-ada')).toContain('accessibility unknown');
    expect(why.get('lot')).toContain('a parking lot is not a building');
    expect(why.get('dark')).toContain('in an outage area with no backup power');
    expect(r.checks[0]).toContain('Bus line');
    expect(marcFilters(marcSites[0]!, 2800, 18)).toEqual([]);
    expect(r.whatWouldChange[0]).toContain('Harmon High School gym would lead if its');
  });
});
