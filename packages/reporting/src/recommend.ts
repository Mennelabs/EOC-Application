/**
 * The recommendation engine (layer-7 task E; REC-02, REC-03, REC-04, REC-10,
 * REC-11, REC-12; docs/02 "How the console recommends places and setups").
 * Rules and arithmetic only, never a language model (REC-12): the same inputs
 * always give the same answer, and every number in a reason can be traced to
 * an input.
 *
 * 1. Hard filters run first (REC-02): no location, inside the damage area or
 *    a flood zone, not accessible, a reported road blockage at the site, an
 *    outage with no backup power. Unknown is never taken as yes: a shelter
 *    whose accessibility or floor space is unknown is set aside with that
 *    reason, never ranked on a guess (REC-10).
 * 2. The rest are scored on components between 0 and 1, weighted by the
 *    tenant's weights (documented defaults below, REC-03).
 * 3. The answer is the top three with their reasons, the excluded places with
 *    theirs (REC-04), what would change the top pick (REC-03), the age of
 *    every input with a stale warning (REC-10), and the equity check: who
 *    lives within reach of the top three by income band, renter share and
 *    language, with any high-need tract left uncovered flagged (REC-11).
 */

export type RecommendationKind = 'shelter' | 'feeding' | 'pod' | 'marc';

/** Planning factors (docs/02, tenant-editable). Sources are cited in the docs table. */
export interface PlanningFactors {
  /** Short-term shelter, up to two weeks (Florida sheltering guidance). */
  shelterSqftPerPerson: number;
  /** One shower per this many people, short-term. */
  peoplePerShower: number;
  /** For households counted from needs. */
  personsPerHousehold: number;
  /** A place within this distance of a tract's centre covers it (equity check). */
  coverageKm: number;
  /** A registry entry not re-checked for this long is stale (REC-01). */
  staleDays: number;
  // ---------------------------------------------------------------- feeding (REC-05, REC-06)
  /** Meals per person at one stop. */
  mealsPerPersonPerStop: number;
  /** Stops one canteen makes in a day. */
  stopsPerCanteen: number;
  /** The first serving window starts at this hour (24-hour clock). */
  feedingFirstStartHour: number;
  /** Length of a serving window, hours. */
  feedingWindowHours: number;
  /** Time between one window's end and the next one's start (travel, restock), hours. */
  feedingGapHours: number;
  /** Requests within this distance are served by one stop. */
  feedingClusterKm: number;
  /** A registered site with parking within this distance of a stop's requests is used for it. */
  feedingSiteKm: number;
  /** A stop covers a tract within this distance (equity check). */
  feedingCoverageKm: number;
  /** A setup note names a language when at least this share of a stop's requests came in it, percent. */
  languageNotePct: number;
  /** A chaplain or counselor is suggested where at least this many households asked for someone to talk to. */
  chaplainMinRequests: number;
  /** People a canteen needs on its crew to serve a stop (REC-06: the partner's declared staff). */
  canteenMinCrew: number;
  // ---------------------------------------------------------------- POD and walk-up points (REC-07, REC-08)
  /** Share of the people without power who come to a POD on a given day, percent. */
  podDailySharePct: number;
  /** Supplies per person per day (FEMA POD planning: 1 gallon of water, 6–8 lb of ice, 2 meals). */
  podWaterGalPerPersonDay: number;
  podIceLbMinPerPersonDay: number;
  podIceLbMaxPerPersonDay: number;
  podMealsPerPersonDay: number;
  /** Days of supplies estimated (the first 72 hours). */
  podDays: number;
  /** A drive-through POD needs at least this many parking spaces unless it is a parking lot. */
  podMinParkingSpaces: number;
  /** A tract with at least this share of households without a vehicle gets a walk-up point, percent. */
  walkUpNoVehiclePct: number;
  /** A walk-up point is within this distance of the tract's centre. */
  walkUpKm: number;
  // ---------------------------------------------------------------- MARC (REC-09)
  /** Households one partner table serves over the MARC's days. */
  marcHouseholdsPerTable: number;
  /** Tables at most for one service. */
  marcMaxTablesPerService: number;
  /** Floor space per partner table, square feet. */
  marcSqftPerTable: number;
  /** Floor space for the welcome desk, waiting and quiet room, square feet. */
  marcBaseSqft: number;
  /** Services in the partner mix, from the top needs. */
  marcServices: number;
}

export const PLANNING_DEFAULTS: PlanningFactors = {
  shelterSqftPerPerson: 40,
  peoplePerShower: 48,
  personsPerHousehold: 2.5,
  coverageKm: 10,
  staleDays: 365,
  mealsPerPersonPerStop: 1,
  stopsPerCanteen: 2,
  feedingFirstStartHour: 11,
  feedingWindowHours: 2.5,
  feedingGapHours: 3,
  feedingClusterKm: 2,
  feedingSiteKm: 1.5,
  feedingCoverageKm: 3,
  languageNotePct: 30,
  canteenMinCrew: 3,
  chaplainMinRequests: 2,
  podDailySharePct: 50,
  podWaterGalPerPersonDay: 1,
  podIceLbMinPerPersonDay: 6,
  podIceLbMaxPerPersonDay: 8,
  podMealsPerPersonDay: 2,
  podDays: 3,
  podMinParkingSpaces: 100,
  walkUpNoVehiclePct: 15,
  walkUpKm: 1,
  marcHouseholdsPerTable: 25,
  marcMaxTablesPerService: 4,
  marcSqftPerTable: 100,
  marcBaseSqft: 1000,
  marcServices: 5,
};

export interface ShelterWeights {
  capacity: number;
  proximity: number;
  amenities: number;
  agreement: number;
  pets: number;
}

/** Documented defaults (REC-03): room for the people first, then distance, then what the place has. */
export const SHELTER_WEIGHTS: ShelterWeights = {
  capacity: 0.35,
  proximity: 0.25,
  amenities: 0.2,
  agreement: 0.1,
  pets: 0.1,
};

export const ENGINE_VERSION = 'shelter-1';

export interface Point {
  lat: number;
  lon: number;
}

export interface Candidate {
  id: string;
  name: string;
  kind: string;
  position: Point | null;
  sqft: number | null;
  ada: boolean | null;
  powerBackup: 'none' | 'generator' | 'transfer_switch' | null;
  kitchen: boolean | null;
  showers: number | null;
  petPolicy: 'none' | 'service_animals' | 'pets_inside' | 'pets_outside_area' | null;
  floodplain: 'in' | 'out' | null;
  mouStatus: 'none' | 'pending' | 'signed' | 'expired';
  parkingSpaces: number | null;
  truckAccess: boolean | null;
  lastConfirmedAt: Date;
  /** Live conditions, worked out by the loader from the event's data. */
  inDamageArea: boolean;
  inFloodZone: boolean;
  inOutage: boolean;
  blockedRoad: boolean;
  /** A debris hazard reported within its radius plus 200 m. */
  inDebrisArea: boolean;
}

export interface Demand {
  /** Households asking for a place to stay tonight. */
  households: number;
  /** Households asking for help with pets. */
  petHouseholds: number;
  /** Where most of the requests are, when they are located. */
  centroid: Point | null;
}

export interface Tract {
  geoid: string;
  name: string | null;
  centroid: Point;
  households: number | null;
  /** 1 = the fifth of tracts with the highest poverty share. */
  incomeBand: number | null;
  renterSharePct: number | null;
  limitedEnglishPct: number | null;
  /** Households without a vehicle, percent (ACS). */
  noVehiclePct: number | null;
  /** A report or request in this event lies inside the tract. */
  affected: boolean;
}

export interface InputAge {
  input: string;
  asOf: string | null;
  ageHours: number | null;
  stale: boolean;
  note?: string;
}

export interface Ranked {
  facilityId: string;
  name: string;
  score: number;
  capacity: number;
  components: Record<keyof ShelterWeights, number>;
  reasons: string[];
  unknown: string[];
}

export interface Excluded {
  facilityId: string;
  name: string;
  reasons: string[];
}

export interface EquityGroup {
  group: string;
  households: number | null;
  coveredHouseholds: number | null;
  coveredPct: number | null;
}

export interface EquityCheck {
  coverageKm: number;
  byIncomeBand: EquityGroup[];
  byRenterShare: EquityGroup[];
  byLanguage: EquityGroup[];
  uncovered: { geoid: string; name: string | null; why: string[]; nearestKm: number | null }[];
  note: string | null;
}

export interface ShelterRecommendation {
  kind: 'shelter';
  engineVersion: string;
  demand: { households: number; people: number; petHouseholds: number };
  top: Ranked[];
  excluded: Excluded[];
  whatWouldChange: string[];
  inputs: InputAge[];
  equity: EquityCheck;
  weights: ShelterWeights;
  factors: PlanningFactors;
}

const R = 6371;
export function distanceKm(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** REC-02: the reasons a place cannot be a shelter right now; empty when it may be ranked. */
export function shelterFilters(c: Candidate): string[] {
  const out: string[] = [];
  if (c.kind === 'parking_lot') out.push('a parking lot is not a shelter');
  if (!c.position) out.push('location unknown, so hazards and distance cannot be checked');
  if (c.inDamageArea) out.push('inside the damage area');
  if (c.floodplain === 'in' || c.inFloodZone) out.push('in a flood zone');
  if (c.ada === false) out.push('not accessible to wheelchair users (ADA)');
  if (c.ada === null) out.push('accessibility unknown; confirm it before using the place');
  if (c.blockedRoad) out.push('a road blockage is reported at the site');
  if (c.inOutage && c.powerBackup === 'none') out.push('in an outage area with no backup power');
  if (c.inOutage && c.powerBackup === null)
    out.push('in an outage area and backup power is unknown');
  if (c.sqft === null) out.push('floor space unknown, so capacity cannot be estimated');
  return out;
}

const WEIGHT_LABEL: Record<keyof ShelterWeights, string> = {
  capacity: 'room for the people asking',
  proximity: 'distance from where the requests are',
  amenities: 'kitchen, showers and backup power',
  agreement: 'use agreement',
  pets: 'pets',
};

function score(
  c: Candidate,
  d: Demand,
  people: number,
  f: PlanningFactors,
  w: ShelterWeights,
): Ranked {
  const capacity = Math.floor((c.sqft ?? 0) / f.shelterSqftPerPerson);
  const need = Math.max(1, people);
  const km = d.centroid && c.position ? distanceKm(d.centroid, c.position) : null;
  const showersFor = c.showers === null ? null : c.showers * f.peoplePerShower;
  const components = {
    capacity: round(Math.min(1, capacity / need)),
    proximity: km === null ? 0.5 : round(1 / (1 + km / 5)),
    amenities: round(
      ((c.kitchen ? 1 : 0) +
        (showersFor === null ? 0 : Math.min(1, showersFor / need)) +
        (c.powerBackup === 'generator' || c.powerBackup === 'transfer_switch' ? 1 : 0)) /
        3,
    ),
    agreement: c.mouStatus === 'signed' ? 1 : c.mouStatus === 'pending' ? 0.5 : 0,
    pets:
      d.petHouseholds === 0
        ? 1
        : c.petPolicy === 'pets_inside' || c.petPolicy === 'pets_outside_area'
          ? 1
          : 0,
  };
  const total = round(
    (Object.keys(w) as (keyof ShelterWeights)[]).reduce((s, k) => s + w[k] * components[k], 0),
    3,
  );
  const reasons: string[] = [];
  reasons.push(
    `Room for about ${fmt(capacity)} people (${fmt(c.sqft ?? 0)} sq ft at ${f.shelterSqftPerPerson} sq ft each) for ${fmt(people)} people asking for a place to stay`,
  );
  reasons.push(
    km === null
      ? 'Distance unknown: the requests have no location yet'
      : `${round(km, 1)} km from where most requests are`,
  );
  const has = [
    c.kitchen ? 'kitchen' : null,
    c.showers !== null && c.showers > 0
      ? `${c.showers} shower${c.showers === 1 ? '' : 's'} (enough for ${fmt(showersFor ?? 0)} people)`
      : null,
    c.powerBackup === 'generator'
      ? 'generator'
      : c.powerBackup === 'transfer_switch'
        ? 'hookup for a generator'
        : null,
  ].filter(Boolean);
  reasons.push(
    has.length ? `Has ${has.join(', ')}` : 'No kitchen, showers or backup power recorded',
  );
  reasons.push(
    c.mouStatus === 'signed'
      ? 'Use agreement signed'
      : c.mouStatus === 'pending'
        ? 'Use agreement pending'
        : 'No use agreement',
  );
  if (d.petHouseholds > 0)
    reasons.push(
      components.pets === 1
        ? `Takes pets; ${d.petHouseholds} household${d.petHouseholds === 1 ? '' : 's'} asked for help with pets`
        : `Does not take pets; ${d.petHouseholds} household${d.petHouseholds === 1 ? '' : 's'} asked for help with pets`,
    );
  const unknown = [
    c.kitchen === null ? 'kitchen' : null,
    c.showers === null ? 'showers' : null,
    c.powerBackup === null ? 'backup power' : null,
    c.petPolicy === null ? 'pet policy' : null,
    c.floodplain === null ? 'floodplain' : null,
  ].filter((x): x is string => x !== null);
  if (unknown.length) reasons.push(`Unknown, counted as missing: ${unknown.join(', ')}`);
  // docs/02: a small hall is better used by day than squeezed overnight.
  if (capacity < people / 2)
    reasons.push(
      'Too small for the overnight need on its own; consider it as a daytime reception or assisted-reporting point',
    );
  return { facilityId: c.id, name: c.name, score: total, capacity, components, reasons, unknown };
}

/** REC-03: what would change the top pick, from the runner-up's weakest gaps and the leader's weak points. */
function whatWouldChange(top: Ranked[], w: ShelterWeights, people: number): string[] {
  const [first, second] = top;
  if (!first) return [];
  const out: string[] = [];
  if (second) {
    const margin = first.score - second.score;
    const keys = (Object.keys(w) as (keyof ShelterWeights)[])
      .filter((k) => w[k] > 0 && second.components[k] < first.components[k])
      .map((k) => ({ k, need: second.components[k] + margin / w[k] }))
      .filter((x) => x.need <= 1)
      .sort((a, b) => a.need - b.need);
    const best = keys[0];
    if (best)
      out.push(
        `${second.name} would lead if its ${WEIGHT_LABEL[best.k]} score rose from ${second.components[best.k]} to ${round(best.need)} (out of 1).`,
      );
    else
      out.push(
        `${second.name} could not overtake on any single factor; the gap is ${round(margin, 3)}.`,
      );
  }
  if (first.capacity < people)
    out.push(
      `${first.name} holds about ${fmt(first.capacity)} of the ${fmt(people)} people asking: a second site is needed now.`,
    );
  else if (people > 0)
    out.push(
      `${first.name} stays the right size until more than ${fmt(first.capacity)} people need a place to stay.`,
    );
  if (first.components.amenities < 1 && first.unknown.includes('backup power'))
    out.push(`If ${first.name} loses power: its backup power is unknown.`);
  return out;
}

/** REC-11: who lives within reach of the top three, and the high-need tracts left out. */
export function equityCheck(sites: Point[], tracts: Tract[], f: PlanningFactors): EquityCheck {
  if (tracts.length === 0)
    return {
      coverageKm: f.coverageKm,
      byIncomeBand: [],
      byRenterShare: [],
      byLanguage: [],
      uncovered: [],
      note: 'No Census tracts are loaded for this county, so coverage cannot be checked.',
    };
  const nearest = (t: Tract) =>
    sites.length ? Math.min(...sites.map((s) => distanceKm(s, t.centroid))) : null;
  const rows = tracts.map((t) => {
    const km = nearest(t);
    return { t, km, covered: km !== null && km <= f.coverageKm };
  });
  const group = (label: string, pick: (t: Tract) => boolean): EquityGroup => {
    const in_ = rows.filter((r) => pick(r.t));
    const hh = in_.reduce((s, r) => s + (r.t.households ?? 0), 0);
    const cov = in_.filter((r) => r.covered).reduce((s, r) => s + (r.t.households ?? 0), 0);
    const known = in_.some((r) => r.t.households !== null);
    return {
      group: label,
      households: known ? hh : null,
      coveredHouseholds: known ? cov : null,
      coveredPct: known && hh > 0 ? round((cov / hh) * 100, 1) : null,
    };
  };
  const bands = [1, 2, 3, 4, 5].map((b) =>
    group(
      b === 1 ? 'Highest poverty fifth' : b === 5 ? 'Lowest poverty fifth' : `Poverty fifth ${b}`,
      (t) => t.incomeBand === b,
    ),
  );
  const highNeed = (t: Tract) => {
    const why: string[] = [];
    if (t.incomeBand === 1) why.push('in the highest poverty fifth');
    if (t.limitedEnglishPct !== null && t.limitedEnglishPct >= 20)
      why.push(`${t.limitedEnglishPct}% of households speak limited English`);
    if (t.renterSharePct !== null && t.renterSharePct >= 60)
      why.push(`${t.renterSharePct}% of households rent`);
    return why;
  };
  return {
    coverageKm: f.coverageKm,
    byIncomeBand: bands,
    byRenterShare: [
      group('Mostly renters (50% or more)', (t) => (t.renterSharePct ?? -1) >= 50),
      group('Mostly owners', (t) => t.renterSharePct !== null && t.renterSharePct < 50),
    ],
    byLanguage: [
      group('Limited English 10% or more', (t) => (t.limitedEnglishPct ?? -1) >= 10),
      group(
        'Limited English under 10%',
        (t) => t.limitedEnglishPct !== null && t.limitedEnglishPct < 10,
      ),
    ],
    uncovered: rows
      .filter((r) => !r.covered && highNeed(r.t).length > 0)
      .map((r) => ({
        geoid: r.t.geoid,
        name: r.t.name,
        why: highNeed(r.t),
        nearestKm: r.km === null ? null : round(r.km, 1),
      })),
    note: null,
  };
}

export function recommendShelter(
  candidates: Candidate[],
  demand: Demand,
  tracts: Tract[],
  inputs: InputAge[],
  factors: PlanningFactors = PLANNING_DEFAULTS,
  weights: ShelterWeights = SHELTER_WEIGHTS,
): ShelterRecommendation {
  const people = Math.ceil(demand.households * factors.personsPerHousehold);
  const excluded: Excluded[] = [];
  const ranked: Ranked[] = [];
  // Sorted by id first so equal scores always come out in the same order.
  for (const c of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    const why = shelterFilters(c);
    if (why.length) excluded.push({ facilityId: c.id, name: c.name, reasons: why });
    else ranked.push(score(c, demand, people, factors, weights));
  }
  ranked.sort((a, b) => b.score - a.score || a.facilityId.localeCompare(b.facilityId));
  const top = ranked.slice(0, 3);
  // Places ranked below the top three are listed with why, too (REC-04).
  for (const r of ranked.slice(3))
    excluded.push({
      facilityId: r.facilityId,
      name: r.name,
      reasons: [`ranked below the top three (score ${r.score})`],
    });
  const positions = top
    .map((t) => candidates.find((c) => c.id === t.facilityId)?.position)
    .filter((p): p is Point => !!p);
  return {
    kind: 'shelter',
    engineVersion: ENGINE_VERSION,
    demand: { households: demand.households, people, petHouseholds: demand.petHouseholds },
    top,
    excluded,
    whatWouldChange: whatWouldChange(top, weights, people),
    inputs,
    equity: equityCheck(positions, tracts, factors),
    weights,
    factors,
  };
}

/** REC-10: an input's age and whether it is stale. */
export function inputAge(
  input: string,
  asOf: Date | null,
  now: Date,
  staleHours: number,
  note?: string,
): InputAge {
  const ageHours = asOf ? round((now.getTime() - asOf.getTime()) / 3_600_000, 1) : null;
  return {
    input,
    asOf: asOf ? asOf.toISOString() : null,
    ageHours,
    stale: ageHours === null || ageHours > staleHours,
    ...(note ? { note } : {}),
  };
}
