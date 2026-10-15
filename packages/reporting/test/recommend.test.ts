/**
 * The shelter recommendation engine (layer-7 task E; REC-02, REC-03, REC-04,
 * REC-10, REC-11, REC-12) on the WESTWIND Saturday-night scenario of docs/02:
 * 96 households with nowhere to stay (about 240 people); the high school gym
 * leads, the church hall is too small for overnight use, the community
 * center in the outage area with no generator is excluded, the fairgrounds
 * lot is not a shelter. Same inputs, same answer.
 */
import { describe, expect, it } from 'vitest';
import {
  PLANNING_DEFAULTS,
  SHELTER_WEIGHTS,
  equityCheck,
  inputAge,
  recommendShelter,
  shelterFilters,
  type Candidate,
  type Tract,
} from '../src/recommend.ts';

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
  lastConfirmedAt: new Date('2026-06-01T00:00:00Z'),
  inDamageArea: false,
  inFloodZone: false,
  inOutage: false,
  blockedRoad: false,
  ...over,
});

const westwind: Candidate[] = [
  base({
    id: 'a-gym',
    name: 'Harmon High School gym',
    position: { lat: 38.812, lon: -90.79 },
    sqft: 14000,
    showers: 8,
  }),
  base({
    id: 'b-church',
    name: 'Iglesia Nueva Esperanza fellowship hall',
    kind: 'place_of_worship',
    position: { lat: 38.801, lon: -90.873 },
    sqft: 2800,
    powerBackup: 'none',
    showers: 0,
    floodplain: null,
    mouStatus: 'pending',
  }),
  base({
    id: 'c-center',
    name: 'Westwind Community Center',
    kind: 'community_center',
    position: { lat: 38.797, lon: -90.86 },
    sqft: 9000,
    powerBackup: 'none',
    inOutage: true,
    petPolicy: 'pets_inside',
  }),
  base({ id: 'd-lot', name: 'County fairgrounds lot', kind: 'parking_lot', sqft: 220000 }),
];
const demand = { households: 96, petHouseholds: 0, centroid: { lat: 38.8, lon: -90.82 } };
const now = new Date('2026-10-10T22:00:00Z');

describe('shelter recommendations', () => {
  it('docs/02: the gym leads; the small hall is a daytime point; the center without power and the lot are out, each with why', () => {
    const r = recommendShelter(westwind, demand, [], []);
    expect(r.demand).toEqual({ households: 96, people: 240, petHouseholds: 0 });
    expect(r.top.map((t) => t.name)).toEqual([
      'Harmon High School gym',
      'Iglesia Nueva Esperanza fellowship hall',
    ]);
    const gym = r.top[0]!;
    expect(gym.capacity).toBe(350);
    expect(gym.reasons[0]).toBe(
      'Room for about 350 people (14,000 sq ft at 40 sq ft each) for 240 people asking for a place to stay',
    );
    const hall = r.top[1]!;
    expect(hall.reasons.join(' ')).toContain('daytime reception');
    expect(hall.unknown).toContain('floodplain');
    expect(r.excluded).toEqual([
      {
        facilityId: 'c-center',
        name: 'Westwind Community Center',
        reasons: ['in an outage area with no backup power'],
      },
      {
        facilityId: 'd-lot',
        name: 'County fairgrounds lot',
        reasons: ['a parking lot is not a shelter'],
      },
    ]);
    expect(r.whatWouldChange.join(' ')).toContain(
      'stays the right size until more than 350 people',
    );
  });

  it('REC-12: the same inputs always give the same answer', () => {
    const a = recommendShelter(westwind, demand, [], []);
    const b = recommendShelter([...westwind].reverse(), demand, [], []);
    expect(b).toEqual(a);
  });

  it('REC-02, REC-10: hard filters run first, and unknown is never taken as yes', () => {
    expect(shelterFilters(base({ ada: false }))).toEqual([
      'not accessible to wheelchair users (ADA)',
    ]);
    expect(shelterFilters(base({ ada: null }))).toEqual([
      'accessibility unknown; confirm it before using the place',
    ]);
    expect(shelterFilters(base({ sqft: null }))).toEqual([
      'floor space unknown, so capacity cannot be estimated',
    ]);
    expect(shelterFilters(base({ inDamageArea: true, blockedRoad: true }))).toEqual([
      'inside the damage area',
      'a road blockage is reported at the site',
    ]);
    expect(shelterFilters(base({ floodplain: 'in' }))).toEqual(['in a flood zone']);
    expect(shelterFilters(base({ inFloodZone: true }))).toEqual(['in a flood zone']);
    expect(shelterFilters(base({ inOutage: true, powerBackup: null }))).toEqual([
      'in an outage area and backup power is unknown',
    ]);
    expect(shelterFilters(base({ inOutage: true, powerBackup: 'transfer_switch' }))).toEqual([]);
    expect(shelterFilters(base({ position: null }))).toEqual([
      'location unknown, so hazards and distance cannot be checked',
    ]);
  });

  it('REC-03: the tenant weights decide; what would change the top pick is named', () => {
    const near = base({
      id: 'near',
      name: 'Near small',
      position: { lat: 38.8, lon: -90.82 },
      sqft: 3000,
    });
    const far = base({
      id: 'far',
      name: 'Far large',
      position: { lat: 38.95, lon: -90.55 },
      sqft: 20000,
    });
    const byRoom = recommendShelter([near, far], demand, [], []);
    expect(byRoom.top[0]!.name).toBe('Far large');
    expect(byRoom.whatWouldChange[0]).toMatch(/^Near small would lead if its/);
    const byDistance = recommendShelter([near, far], demand, [], [], PLANNING_DEFAULTS, {
      ...SHELTER_WEIGHTS,
      capacity: 0.05,
      proximity: 0.7,
    });
    expect(byDistance.top[0]!.name).toBe('Near small');
  });

  it('pets count only when households asked for help with pets', () => {
    const noPets = base({ id: 'p1', name: 'No pets', petPolicy: 'service_animals' });
    const pets = base({ id: 'p2', name: 'Pets welcome', petPolicy: 'pets_inside' });
    expect(recommendShelter([noPets, pets], demand, [], []).top[0]!.components.pets).toBe(1);
    const withPets = recommendShelter([noPets, pets], { ...demand, petHouseholds: 6 }, [], []);
    expect(withPets.top[0]!.name).toBe('Pets welcome');
    expect(withPets.top[1]!.reasons.join(' ')).toContain('Does not take pets; 6 households');
  });

  it('REC-11: coverage by income band, renters and language; a high-need tract out of reach is flagged', () => {
    const tracts: Tract[] = [
      {
        geoid: '29999000100',
        name: 'Near',
        centroid: { lat: 38.81, lon: -90.8 },
        households: 1000,
        incomeBand: 2,
        renterSharePct: 30,
        limitedEnglishPct: 5,
      },
      {
        geoid: '29999000200',
        name: 'Far',
        centroid: { lat: 39.2, lon: -91.2 },
        households: 800,
        incomeBand: 1,
        renterSharePct: 70,
        limitedEnglishPct: 25,
      },
    ];
    const e = equityCheck([{ lat: 38.812, lon: -90.79 }], tracts, PLANNING_DEFAULTS);
    expect(e.byIncomeBand.find((g) => g.group === 'Highest poverty fifth')).toMatchObject({
      households: 800,
      coveredHouseholds: 0,
      coveredPct: 0,
    });
    expect(e.byRenterShare[0]).toMatchObject({ coveredPct: 0 });
    expect(e.uncovered).toEqual([
      expect.objectContaining({
        geoid: '29999000200',
        why: [
          'in the highest poverty fifth',
          '25% of households speak limited English',
          '70% of households rent',
        ],
      }),
    ]);
    expect(equityCheck([], [], PLANNING_DEFAULTS).note).toContain('No Census tracts');
  });

  it('REC-10: every input carries its age; old or missing inputs are stale', () => {
    expect(inputAge('Facility registry', new Date('2026-10-10T20:00:00Z'), now, 24)).toEqual({
      input: 'Facility registry',
      asOf: '2026-10-10T20:00:00.000Z',
      ageHours: 2,
      stale: false,
    });
    expect(inputAge('Flood zones', null, now, 24)).toMatchObject({ stale: true, ageHours: null });
  });
});
