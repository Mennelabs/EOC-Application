/**
 * Feeding stops, PODs with walk-up points, and MARCs (layer-7 task E2;
 * REC-05, REC-06, REC-07, REC-08, REC-09, REC-10, REC-11, REC-12; docs/02
 * Sunday noon, Monday 10 am and Wednesday). Rules and arithmetic only, never
 * a language model (REC-12), so the same inputs always give the same answer.
 *
 * - Feeding (REC-05, REC-06): requests for food or water are grouped by
 *   place; the largest groups become stops, as many as the canteens on the
 *   roster can make in a day, each with a serving window, a meal estimate,
 *   the nearest safe registered site with parking, and setup notes on
 *   language, pets and someone to talk to. A canteen's declared meals an
 *   hour caps what one window can serve; unknown is said, never guessed.
 * - POD (REC-07, REC-08): sized from the people without power, typed by the
 *   people served a day, with the first 72 hours' supplies from the planning
 *   factors, sited on a large lot with semi-truck access away from damage,
 *   flood and debris; walk-up points where Census data shows many
 *   households without a vehicle.
 * - MARC (REC-09): the partner mix follows the top recovery needs, the
 *   tables and floor space follow the mix, the site is close to the major
 *   and destroyed homes, accessible and big enough, and interpreters follow
 *   the languages residents reported in.
 *
 * Every kind reports the places set aside and why, what would change the
 * answer, the age of each input (REC-10) and the equity check (REC-11).
 */
import {
  PLANNING_DEFAULTS,
  distanceKm,
  equityCheck,
  fmt,
  round,
  type Candidate,
  type EquityCheck,
  type Excluded,
  type InputAge,
  type PlanningFactors,
  type Point,
  type Tract,
} from './recommend.ts';

export const SITE_ENGINE_VERSIONS = { feeding: 'feeding-1', pod: 'pod-1', marc: 'marc-1' } as const;

/** A registered place weighed for one use, with its score parts. */
export interface SiteOption {
  facilityId: string;
  name: string;
  score: number;
  components: Record<string, number>;
  reasons: string[];
  unknown: string[];
}

export interface PodWeights {
  proximity: number;
  parking: number;
  agreement: number;
}
/** Documented defaults (REC-03): a drive-through POD lives or dies by room for queued cars. */
export const POD_WEIGHTS: PodWeights = { proximity: 0.4, parking: 0.45, agreement: 0.15 };

export interface MarcWeights {
  proximity: number;
  parking: number;
  agreement: number;
  power: number;
}
export const MARC_WEIGHTS: MarcWeights = {
  proximity: 0.5,
  parking: 0.2,
  agreement: 0.15,
  power: 0.15,
};

const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const names = new Intl.DisplayNames(['en'], { type: 'language' });
export function languageName(code: string): string {
  try {
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}
const hhmm = (h: number) => {
  const m = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const near = (p: Point) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
const proximity = (km: number | null) => (km === null ? 0.5 : round(1 / (1 + km / 5)));
const agreement = (c: Candidate) =>
  c.mouStatus === 'signed' ? 1 : c.mouStatus === 'pending' ? 0.5 : 0;
const agreementReason = (c: Candidate) =>
  c.mouStatus === 'signed'
    ? 'Use agreement signed'
    : c.mouStatus === 'pending'
      ? 'Use agreement pending'
      : 'No use agreement';
const byId = <T extends { id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));

/** REC-02: the live conditions that rule a place out for any use. */
export function siteHazards(c: Candidate, opts: { debris?: boolean } = {}): string[] {
  const out: string[] = [];
  if (!c.position) out.push('location unknown, so hazards and distance cannot be checked');
  if (c.inDamageArea) out.push('inside the damage area');
  if (c.floodplain === 'in' || c.inFloodZone) out.push('in a flood zone');
  if (c.blockedRoad) out.push('a road blockage is reported at the site');
  if (opts.debris && c.inDebrisArea) out.push('inside a reported debris area');
  return out;
}

function weighted<W extends object>(w: W, parts: Record<keyof W, number>): number {
  return round(
    (Object.keys(w) as (keyof W)[]).reduce((s, k) => s + (w[k] as number) * parts[k], 0),
    3,
  );
}

/** REC-03: what would put the runner-up first, on its weakest gap. */
function nextPick<W extends object>(
  top: SiteOption[],
  w: W,
  labels: Record<keyof W, string>,
): string[] {
  const [first, second] = top;
  if (!first || !second) return [];
  const margin = first.score - second.score;
  const keys = (Object.keys(w) as (keyof W & string)[])
    .filter((k) => (w[k] as number) > 0 && (second.components[k] ?? 0) < (first.components[k] ?? 0))
    .map((k) => ({ k, need: (second.components[k] ?? 0) + margin / (w[k] as number) }))
    .filter((x) => x.need <= 1)
    .sort((a, b) => a.need - b.need);
  const best = keys[0];
  return [
    best
      ? `${second.name} would lead if its ${labels[best.k]} score rose from ${second.components[best.k]} to ${round(best.need)} (out of 1).`
      : `${second.name} could not overtake on any single factor; the gap is ${round(margin, 3)}.`,
  ];
}

// ====================================================================== feeding (REC-05, REC-06)

/** Requests in one small area, as the loader counts them. */
export interface DemandCell {
  position: Point;
  /** Households asking for food or water here. */
  food: number;
  /** Of those, by the language they asked in; unknown is not counted. */
  languages: Record<string, number>;
  /** Households asking for help with pets. */
  pets: number;
  /** Households asking for someone to talk to. */
  talk: number;
}

/** A canteen on the roster, with what its partner declared (REC-06). */
export interface Canteen {
  teamId: string;
  name: string;
  agency: string | null;
  mealsPerHour: number | null;
  staff: number;
  skills: string[];
}

export interface FeedingStop {
  stop: number;
  canteen: { teamId: string; name: string; agency: string | null } | null;
  window: { start: string; end: string };
  facilityId: string | null;
  place: string;
  position: Point;
  households: number;
  meals: number;
  /** Setup notes: language, pets, someone to talk to, capacity. */
  notes: string[];
  reasons: string[];
  unknown: string[];
}

export interface FeedingRecommendation {
  kind: 'feeding';
  engineVersion: string;
  demand: {
    households: number;
    people: number;
    meals: number;
    petHouseholds: number;
    talkHouseholds: number;
  };
  canteens: Canteen[];
  stops: FeedingStop[];
  /** Households asking for food or water beyond the stops planned. */
  unserved: number;
  excluded: Excluded[];
  whatWouldChange: string[];
  inputs: InputAge[];
  equity: EquityCheck;
  factors: PlanningFactors;
}

interface Group {
  position: Point;
  households: number;
  languages: Record<string, number>;
  pets: number;
  talk: number;
}

/** Quick distance for grouping; within a county the flat-earth error is far below the radius. */
const flatKm = (a: Point, b: Point) => {
  const dy = (a.lat - b.lat) * 110.57;
  const dx = (a.lon - b.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Greedy grouping: the place with the most requests within the radius seeds a
 * group of everything within it; repeat. Stops after `max` groups; the rest
 * is counted as unserved. Ties fall to the southernmost, then westernmost cell.
 */
export function groupRequests(
  cells: DemandCell[],
  km: number,
  max: number,
): { groups: Group[]; rest: number } {
  const food = cells
    .filter((c) => c.food > 0)
    .sort((a, b) => a.position.lat - b.position.lat || a.position.lon - b.position.lon);
  const left = new Set(food.map((_, i) => i));
  const groups: Group[] = [];
  while (left.size && groups.length < max) {
    let seed = -1;
    let best = -1;
    for (const i of left) {
      let sum = 0;
      for (const j of left)
        if (flatKm(food[i]!.position, food[j]!.position) <= km) sum += food[j]!.food;
      if (sum > best) {
        best = sum;
        seed = i;
      }
    }
    const members = [...left].filter((j) => flatKm(food[seed]!.position, food[j]!.position) <= km);
    let lat = 0;
    let lon = 0;
    let households = 0;
    const languages: Record<string, number> = {};
    for (const j of members) {
      const c = food[j]!;
      left.delete(j);
      households += c.food;
      lat += c.position.lat * c.food;
      lon += c.position.lon * c.food;
      for (const [k, v] of Object.entries(c.languages)) languages[k] = (languages[k] ?? 0) + v;
    }
    groups.push({
      position: { lat: round(lat / households, 5), lon: round(lon / households, 5) },
      households,
      languages,
      pets: 0,
      talk: 0,
    });
  }
  const rest = [...left].reduce((s, j) => s + food[j]!.food, 0);
  // Pets and someone to talk to go to the nearest stop within the radius.
  for (const c of cells) {
    if (!c.pets && !c.talk) continue;
    let at: Group | null = null;
    let d = Infinity;
    for (const g of groups) {
      const k = flatKm(c.position, g.position);
      if (k <= km && k < d) {
        d = k;
        at = g;
      }
    }
    if (at) {
      at.pets += c.pets;
      at.talk += c.talk;
    }
  }
  groups.sort(
    (a, b) =>
      b.households - a.households ||
      a.position.lat - b.position.lat ||
      a.position.lon - b.position.lon,
  );
  return { groups, rest };
}

/** Why a registered place cannot host a canteen stop. */
export function feedingFilters(c: Candidate): string[] {
  const out = siteHazards(c);
  if (c.kind !== 'parking_lot') {
    if (c.parkingSpaces === 0) out.push('no parking for a canteen');
    if (c.parkingSpaces === null) out.push('parking unknown, so a canteen cannot be placed there');
  }
  return out;
}

export function recommendFeeding(
  candidates: Candidate[],
  cells: DemandCell[],
  canteens: Canteen[],
  tracts: Tract[],
  inputs: InputAge[],
  factors: PlanningFactors = PLANNING_DEFAULTS,
): FeedingRecommendation {
  const f = factors;
  const roster = [...canteens].sort(
    (a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId),
  );
  const slots = Math.max(1, roster.length) * f.stopsPerCanteen;
  const { groups, rest } = groupRequests(cells, f.feedingClusterKm, slots);
  const excluded: Excluded[] = [];
  const usable: Candidate[] = [];
  for (const c of byId(candidates)) {
    const why = feedingFilters(c);
    if (why.length) excluded.push({ facilityId: c.id, name: c.name, reasons: why });
    else usable.push(c);
  }
  const used = new Set<string>();
  const stops: FeedingStop[] = groups.map((g, s) => {
    const canteen = roster.length ? roster[s % roster.length]! : null;
    const w = roster.length ? Math.floor(s / roster.length) : s;
    const start = f.feedingFirstStartHour + w * (f.feedingWindowHours + f.feedingGapHours);
    let site: Candidate | null = null;
    let siteKm = Infinity;
    for (const c of usable) {
      if (used.has(c.id)) continue;
      const k = distanceKm(g.position, c.position!);
      if (k <= f.feedingSiteKm && k < siteKm) {
        site = c;
        siteKm = k;
      }
    }
    if (site) used.add(site.id);
    const meals = Math.ceil(g.households * f.personsPerHousehold * f.mealsPerPersonPerStop);
    const reasons: string[] = [
      `${plural(g.households, 'household')} asking for food or water within ${f.feedingClusterKm} km`,
    ];
    const unknown: string[] = [];
    const notes: string[] = [];
    if (site) {
      reasons.push(`${round(siteKm, 1)} km from the middle of these requests`);
      reasons.push(
        site.kind === 'parking_lot'
          ? 'A parking lot'
          : `${plural(site.parkingSpaces ?? 0, 'parking space')}`,
      );
      reasons.push(agreementReason(site));
      if (site.truckAccess === null) unknown.push('truck access');
    } else {
      reasons.push(
        `No registered site with parking within ${f.feedingSiteKm} km: pick a safe, open lot near here`,
      );
    }
    if (canteen) {
      if (canteen.mealsPerHour === null) unknown.push(`meals an hour for ${canteen.name}`);
      else {
        const can = Math.floor(canteen.mealsPerHour * f.feedingWindowHours);
        if (meals > can)
          notes.push(
            `About ${fmt(meals)} meals is more than ${canteen.name} serves in the window (about ${fmt(can)}): send a second unit or lengthen the window`,
          );
        else reasons.push(`${canteen.name} serves about ${fmt(can)} meals in the window`);
      }
    }
    for (const [code, n] of Object.entries(g.languages).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      if (code === 'en' || (n / g.households) * 100 < f.languageNotePct) continue;
      const name = languageName(code);
      const lead = n * 2 > g.households ? 'Most' : `${fmt(n)} of ${fmt(g.households)}`;
      const listed = canteen?.skills.some((x) => x.toLowerCase().startsWith(name.toLowerCase()));
      notes.push(
        `${lead} requests here came in ${name}: bring a ${name}-speaking volunteer${listed ? ` (${canteen!.name} lists one)` : ''}`,
      );
    }
    if (g.pets > 0)
      notes.push(`${plural(g.pets, 'household')} here asked for help with pets: bring pet food`);
    if (g.talk >= f.chaplainMinRequests)
      notes.push(
        `${plural(g.talk, 'household')} here asked for someone to talk to: suggest a chaplain or crisis counselor at this stop`,
      );
    return {
      stop: s + 1,
      canteen: canteen
        ? { teamId: canteen.teamId, name: canteen.name, agency: canteen.agency }
        : null,
      window: { start: hhmm(start), end: hhmm(start + f.feedingWindowHours) },
      facilityId: site?.id ?? null,
      place: site?.name ?? `Open area near ${near(g.position)}`,
      position: site?.position ?? g.position,
      households: g.households,
      meals,
      notes,
      reasons,
      unknown,
    };
  });
  for (const c of usable)
    if (!used.has(c.id))
      excluded.push({
        facilityId: c.id,
        name: c.name,
        reasons: [
          `not within ${f.feedingSiteKm} km of a group of requests, or a nearer site was used`,
        ],
      });
  const households = cells.reduce((s, c) => s + c.food, 0);
  const people = Math.ceil(households * f.personsPerHousehold);
  const whatWouldChange: string[] = [];
  if (!roster.length)
    whatWouldChange.push(
      'No canteen is on the roster for this event: add the partners’ canteens, with their meals an hour, to plan who goes where.',
    );
  if (rest > 0)
    whatWouldChange.push(
      `${plural(rest, 'household')} asking for food or water ${rest === 1 ? 'is' : 'are'} beyond these stops: another canteen, or a third window, would reach the next group.`,
    );
  else if (stops.length)
    whatWouldChange.push('Every household asking for food or water is within reach of a stop.');
  return {
    kind: 'feeding',
    engineVersion: SITE_ENGINE_VERSIONS.feeding,
    demand: {
      households,
      people,
      meals: Math.ceil(people * f.mealsPerPersonPerStop),
      petHouseholds: cells.reduce((s, c) => s + c.pets, 0),
      talkHouseholds: cells.reduce((s, c) => s + c.talk, 0),
    },
    canteens: roster,
    stops,
    unserved: rest,
    excluded,
    whatWouldChange,
    inputs,
    equity: equityCheck(
      stops.map((s) => s.position),
      tracts,
      { ...f, coverageKm: f.feedingCoverageKm },
    ),
    factors: f,
  };
}

// ====================================================================== POD and walk-up points (REC-07, REC-08)

export interface PodDemand {
  /** Customers without power in the open outages. */
  powerCustomersOut: number;
  /** Open power outages whose customer count is not known. */
  outagesUncounted: number;
  /** Open water outages: a POD hands out water. */
  waterOutages: number;
  /** The latest restoration estimate among the open power outages. */
  restorationAt: string | null;
  /** The middle of the event's reports and requests. */
  centroid: Point | null;
}

export type PodType = 'I' | 'II' | 'III';
/** FEMA POD types by people served a day. */
export const POD_TYPES: { type: PodType; peoplePerDay: number }[] = [
  { type: 'III', peoplePerDay: 5000 },
  { type: 'II', peoplePerDay: 10000 },
  { type: 'I', peoplePerDay: 20000 },
];

export interface WalkUp {
  geoid: string;
  tract: string | null;
  noVehiclePct: number;
  households: number | null;
  facilityId: string | null;
  place: string;
  position: Point;
  reasons: string[];
  notes: string[];
}

export interface PodRecommendation {
  kind: 'pod';
  engineVersion: string;
  demand: {
    powerCustomersOut: number;
    people: number;
    peoplePerDay: number;
    outagesUncounted: number;
    waterOutages: number;
    restorationAt: string | null;
  };
  pod: { type: PodType; count: number; peoplePerDay: number } | null;
  supplies: {
    days: number;
    waterGallons: number;
    iceLbMin: number;
    iceLbMax: number;
    meals: number;
  } | null;
  top: SiteOption[];
  /** What the registry cannot say and someone must check on site. */
  checks: string[];
  walkUps: WalkUp[];
  excluded: Excluded[];
  whatWouldChange: string[];
  inputs: InputAge[];
  equity: EquityCheck;
  weights: PodWeights;
  factors: PlanningFactors;
}

/** Why a registered place cannot be a drive-through POD. */
export function podFilters(c: Candidate, f: PlanningFactors): string[] {
  const out = siteHazards(c, { debris: true });
  if (c.truckAccess === false) out.push('no semi-truck access');
  if (c.truckAccess === null) out.push('semi-truck access unknown');
  if (c.kind !== 'parking_lot') {
    if (c.parkingSpaces === null)
      out.push('parking unknown; a drive-through POD needs a large lot');
    else if (c.parkingSpaces < f.podMinParkingSpaces)
      out.push(
        `${plural(c.parkingSpaces, 'parking space')}; a drive-through POD needs about ${fmt(f.podMinParkingSpaces)}`,
      );
  }
  return out;
}

const POD_LABEL: Record<keyof PodWeights, string> = {
  proximity: 'distance from the affected area',
  parking: 'room for queued cars',
  agreement: 'use agreement',
};

export function recommendPod(
  candidates: Candidate[],
  demand: PodDemand,
  tracts: Tract[],
  inputs: InputAge[],
  factors: PlanningFactors = PLANNING_DEFAULTS,
  weights: PodWeights = POD_WEIGHTS,
): PodRecommendation {
  const f = factors;
  const people = Math.ceil(demand.powerCustomersOut * f.personsPerHousehold);
  const perDay = Math.ceil((people * f.podDailySharePct) / 100);
  const largest = POD_TYPES[POD_TYPES.length - 1]!;
  const fit = POD_TYPES.find((t) => t.peoplePerDay >= perDay);
  const pod =
    perDay === 0
      ? null
      : fit
        ? { type: fit.type, count: 1, peoplePerDay: perDay }
        : {
            type: largest.type,
            count: Math.ceil(perDay / largest.peoplePerDay),
            peoplePerDay: perDay,
          };
  const excluded: Excluded[] = [];
  const ranked: SiteOption[] = [];
  for (const c of byId(candidates)) {
    const why = podFilters(c, f);
    if (why.length) {
      excluded.push({ facilityId: c.id, name: c.name, reasons: why });
      continue;
    }
    const km = demand.centroid ? distanceKm(demand.centroid, c.position!) : null;
    const components = {
      proximity: proximity(km),
      parking:
        c.kind === 'parking_lot' && c.parkingSpaces === null
          ? 0.5
          : round(Math.min(1, (c.parkingSpaces ?? 0) / (f.podMinParkingSpaces * 3))),
      agreement: agreement(c),
    };
    const unknown: string[] = [];
    if (c.kind === 'parking_lot' && c.parkingSpaces === null) unknown.push('parking spaces');
    ranked.push({
      facilityId: c.id,
      name: c.name,
      score: weighted(weights, components),
      components,
      reasons: [
        km === null
          ? 'Distance unknown: the reports have no location yet'
          : `${round(km, 1)} km from the middle of the affected area`,
        c.kind === 'parking_lot'
          ? c.parkingSpaces === null
            ? 'A parking lot (spaces not counted)'
            : `A parking lot with ${plural(c.parkingSpaces, 'space')}`
          : `${plural(c.parkingSpaces ?? 0, 'parking space')}`,
        'Semi-truck access',
        'Outside the damage area, flood zones, debris and reported road blockages',
        agreementReason(c),
      ],
      unknown,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.facilityId.localeCompare(b.facilityId));
  const top = pod ? ranked.slice(0, Math.max(3, pod.count + 2)) : [];
  if (pod)
    for (const r of ranked.slice(top.length))
      excluded.push({
        facilityId: r.facilityId,
        name: r.name,
        reasons: [`ranked below the places shown (score ${r.score})`],
      });
  const supplies = pod
    ? {
        days: f.podDays,
        waterGallons: Math.ceil(perDay * f.podDays * f.podWaterGalPerPersonDay),
        iceLbMin: Math.ceil(perDay * f.podDays * f.podIceLbMinPerPersonDay),
        iceLbMax: Math.ceil(perDay * f.podDays * f.podIceLbMaxPerPersonDay),
        meals: Math.ceil(perDay * f.podDays * f.podMealsPerPersonDay),
      }
    : null;

  // Walk-up points (REC-08): affected tracts where many households have no vehicle.
  const walkUps: WalkUp[] = [];
  const checks: string[] = [];
  const profiled = tracts.some((t) => t.noVehiclePct !== null);
  if (pod && !profiled)
    checks.push('Census vehicle data is not loaded, so walk-up points cannot be suggested.');
  if (pod && profiled) {
    const used = new Set(top.slice(0, pod.count).map((t) => t.facilityId));
    const open = byId(candidates).filter((c) => siteHazards(c, { debris: true }).length === 0);
    for (const t of tracts
      .filter((t) => t.affected && (t.noVehiclePct ?? -1) >= f.walkUpNoVehiclePct)
      .sort((a, b) => b.noVehiclePct! - a.noVehiclePct! || a.geoid.localeCompare(b.geoid))) {
      let site: Candidate | null = null;
      let siteKm = Infinity;
      for (const c of open) {
        if (used.has(c.id)) continue;
        const k = distanceKm(t.centroid, c.position!);
        if (k <= f.walkUpKm && k < siteKm) {
          site = c;
          siteKm = k;
        }
      }
      if (site) used.add(site.id);
      const label = t.name ?? `tract ${t.geoid}`;
      const notes: string[] = [];
      if (demand.powerCustomersOut > 0)
        notes.push(
          `Ask for a partner communications trailer for phone charging and Wi-Fi: ${plural(demand.powerCustomersOut, 'customer')} without power`,
        );
      walkUps.push({
        geoid: t.geoid,
        tract: t.name,
        noVehiclePct: t.noVehiclePct!,
        households: t.households,
        facilityId: site?.id ?? null,
        place: site?.name ?? `Near the middle of ${label}`,
        position: site?.position ?? t.centroid,
        reasons: [
          `${t.noVehiclePct}% of households in ${label} have no vehicle (Census ACS)`,
          site
            ? `${round(siteKm, 1)} km from the middle of the tract, outside the hazards reported`
            : `No registered site within ${f.walkUpKm} km of the middle of the tract: pick a safe spot people can walk to`,
        ],
        notes,
      });
    }
  }
  if (pod) {
    checks.push('Surface: paved and flat is not in the registry; check it on site.');
    checks.push('Hospital routes are not loaded: keep the queue off the route to the hospital.');
    if (!demand.restorationAt)
      checks.push('No restoration estimate is given: plan for the full first 72 hours.');
    if (demand.outagesUncounted)
      checks.push(
        `${plural(demand.outagesUncounted, 'open power outage')} ${demand.outagesUncounted === 1 ? 'has' : 'have'} no customer count, so the sizing is low.`,
      );
  }

  const whatWouldChange: string[] = [];
  if (!pod)
    whatWouldChange.push(
      demand.outagesUncounted
        ? 'Open power outages have no customer count yet: add the counts to size a POD.'
        : 'No open power outage with customers counted: no POD is needed on these inputs.',
    );
  else {
    whatWouldChange.push(...nextPick(top, weights, POD_LABEL));
    const bigger = POD_TYPES.find((t) => t.peoplePerDay > pod.peoplePerDay && t.type !== pod.type);
    const cap = POD_TYPES.find((t) => t.type === pod.type)!.peoplePerDay * pod.count;
    whatWouldChange.push(
      bigger && pod.count === 1
        ? `If more than ${fmt(cap)} people a day come, a Type ${bigger.type} POD is needed.`
        : `If more than ${fmt(cap)} people a day come, another Type I POD is needed.`,
    );
    if (demand.restorationAt)
      whatWouldChange.push(
        `Power is expected back by ${demand.restorationAt.slice(0, 16).replace('T', ' ')} UTC; supplies can stop then.`,
      );
  }
  const shown = [
    ...top
      .slice(0, pod?.count ?? 0)
      .map((t) => candidates.find((c) => c.id === t.facilityId)?.position),
    ...walkUps.map((w) => w.position),
  ].filter((p): p is Point => !!p);
  return {
    kind: 'pod',
    engineVersion: SITE_ENGINE_VERSIONS.pod,
    demand: {
      powerCustomersOut: demand.powerCustomersOut,
      people,
      peoplePerDay: perDay,
      outagesUncounted: demand.outagesUncounted,
      waterOutages: demand.waterOutages,
      restorationAt: demand.restorationAt,
    },
    pod,
    supplies,
    top,
    checks,
    walkUps,
    excluded,
    whatWouldChange,
    inputs,
    equity: equityCheck(shown, tracts, f),
    weights,
    factors: f,
  };
}

// ====================================================================== MARC (REC-09)

export interface MarcDemand {
  /** Homes counted major or destroyed under the counting rule (verified). */
  majorDestroyed: number;
  renters: number;
  owners: number;
  insured: number;
  uninsured: number;
  /** Open requests in the event by category. */
  needs: Record<string, number>;
  /** Reports in the event by the language they were made in. */
  languages: Record<string, number>;
  /** The middle of the major and destroyed homes. */
  centroid: Point | null;
}

export interface MarcService {
  service: string;
  households: number;
  tables: number;
  basis: string;
}

export interface MarcRecommendation {
  kind: 'marc';
  engineVersion: string;
  demand: {
    majorDestroyed: number;
    renterPct: number | null;
    uninsuredPct: number | null;
  };
  services: MarcService[];
  tables: number;
  sqftNeeded: number;
  interpreters: { language: string; name: string; reports: number }[];
  top: SiteOption[];
  checks: string[];
  excluded: Excluded[];
  whatWouldChange: string[];
  inputs: InputAge[];
  equity: EquityCheck;
  weights: MarcWeights;
  factors: PlanningFactors;
}

/**
 * The recovery services a MARC can offer and who needs each. Food, cleanup
 * and pets are planned through feeding stops, missions and shelters, not at
 * the MARC.
 */
function serviceLines(d: MarcDemand): Omit<MarcService, 'tables'>[] {
  const n = (k: string) => d.needs[k] ?? 0;
  return [
    {
      service: 'Housing',
      households: d.majorDestroyed + n('shelter_tonight'),
      basis: `${plural(d.majorDestroyed, 'home')} major or destroyed; ${plural(n('shelter_tonight'), 'household')} asking for a place to stay`,
    },
    {
      service: 'Insurance help',
      households: d.insured,
      basis: `${plural(d.insured, 'insured home')} major or destroyed`,
    },
    {
      service: 'Disaster loans and grants',
      households: d.uninsured,
      basis: `${plural(d.uninsured, 'home')} major or destroyed with no insurance for this damage`,
    },
    {
      service: 'Legal aid',
      households: d.renters,
      basis: `${plural(d.renters, 'rented home')} major or destroyed (leases, deposits, documents)`,
    },
    {
      service: 'Crisis counseling',
      households: n('someone_to_talk'),
      basis: `${plural(n('someone_to_talk'), 'household')} asking for someone to talk to`,
    },
    {
      service: 'Medical equipment and power',
      households: n('medical_power'),
      basis: `${plural(n('medical_power'), 'household')} asking for medical equipment or power for it`,
    },
    {
      service: 'Transportation',
      households: n('transportation'),
      basis: `${plural(n('transportation'), 'household')} asking for a ride`,
    },
  ];
}

/** Why a registered place cannot hold the MARC. */
export function marcFilters(c: Candidate, sqftNeeded: number, tables: number): string[] {
  const out = siteHazards(c);
  if (c.kind === 'parking_lot') out.push('a parking lot is not a building');
  if (c.ada === false) out.push('not accessible to wheelchair users (ADA)');
  if (c.ada === null) out.push('accessibility unknown; confirm it before using the place');
  if (c.inOutage && c.powerBackup === 'none') out.push('in an outage area with no backup power');
  if (c.inOutage && c.powerBackup === null)
    out.push('in an outage area and backup power is unknown');
  if (c.sqft === null) out.push('floor space unknown, so the tables cannot be fitted');
  else if (c.sqft < sqftNeeded)
    out.push(
      `${fmt(c.sqft)} sq ft; ${plural(tables, 'partner table')} with waiting space need about ${fmt(sqftNeeded)}`,
    );
  if (c.parkingSpaces === 0) out.push('no parking');
  return out;
}

const MARC_LABEL: Record<keyof MarcWeights, string> = {
  proximity: 'distance from the damaged homes',
  parking: 'parking',
  agreement: 'use agreement',
  power: 'backup power',
};

export function recommendMarc(
  candidates: Candidate[],
  demand: MarcDemand,
  tracts: Tract[],
  inputs: InputAge[],
  factors: PlanningFactors = PLANNING_DEFAULTS,
  weights: MarcWeights = MARC_WEIGHTS,
): MarcRecommendation {
  const f = factors;
  const services: MarcService[] = serviceLines(demand)
    .map((l, i) => ({ ...l, i }))
    .filter((l) => l.households > 0)
    .sort((a, b) => b.households - a.households || a.i - b.i)
    .slice(0, f.marcServices)
    .map(({ i: _i, ...l }) => ({
      ...l,
      tables: Math.min(
        f.marcMaxTablesPerService,
        Math.max(1, Math.ceil(l.households / f.marcHouseholdsPerTable)),
      ),
    }));
  const tables = services.reduce((s, l) => s + l.tables, 0);
  const sqftNeeded = f.marcBaseSqft + tables * f.marcSqftPerTable;
  const excluded: Excluded[] = [];
  const ranked: SiteOption[] = [];
  for (const c of byId(candidates)) {
    const why = marcFilters(c, sqftNeeded, tables);
    if (why.length) {
      excluded.push({ facilityId: c.id, name: c.name, reasons: why });
      continue;
    }
    const km = demand.centroid ? distanceKm(demand.centroid, c.position!) : null;
    const backup = c.powerBackup === 'generator' || c.powerBackup === 'transfer_switch';
    const components = {
      proximity: proximity(km),
      parking: c.parkingSpaces === null ? 0 : round(Math.min(1, c.parkingSpaces / 100)),
      agreement: agreement(c),
      power: backup ? 1 : 0,
    };
    const unknown: string[] = [];
    if (c.parkingSpaces === null) unknown.push('parking');
    if (c.powerBackup === null) unknown.push('backup power');
    ranked.push({
      facilityId: c.id,
      name: c.name,
      score: weighted(weights, components),
      components,
      reasons: [
        km === null
          ? 'Distance unknown: the damaged homes have no location yet'
          : `${round(km, 1)} km from where the major and destroyed homes are`,
        `${fmt(c.sqft!)} sq ft for ${plural(tables, 'partner table')} (about ${fmt(sqftNeeded)} needed)`,
        'Accessible to wheelchair users (ADA)',
        c.parkingSpaces === null
          ? 'Parking unknown, counted as none'
          : `${plural(c.parkingSpaces, 'parking space')}`,
        backup
          ? c.powerBackup === 'generator'
            ? 'Generator'
            : 'Hookup for a generator'
          : 'No backup power recorded',
        agreementReason(c),
      ],
      unknown,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.facilityId.localeCompare(b.facilityId));
  const top = ranked.slice(0, 3);
  for (const r of ranked.slice(3))
    excluded.push({
      facilityId: r.facilityId,
      name: r.name,
      reasons: [`ranked below the top three (score ${r.score})`],
    });
  const interpreters = Object.entries(demand.languages)
    .filter(([code, n]) => code !== 'en' && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([language, reports]) => ({ language, name: languageName(language), reports }));
  const tenureKnown = demand.renters + demand.owners;
  const insuranceKnown = demand.insured + demand.uninsured;
  const whatWouldChange = nextPick(top, weights, MARC_LABEL);
  if (!demand.majorDestroyed)
    whatWouldChange.push(
      'No home is counted major or destroyed yet: the partner mix follows the requests alone until reviewers verify damage.',
    );
  if (top[0] && services.length)
    whatWouldChange.push(
      `Each further ${fmt(f.marcHouseholdsPerTable)} households needing one service adds a table, up to ${f.marcMaxTablesPerService} for that service.`,
    );
  const first = top[0] ? candidates.find((c) => c.id === top[0]!.facilityId)?.position : null;
  return {
    kind: 'marc',
    engineVersion: SITE_ENGINE_VERSIONS.marc,
    demand: {
      majorDestroyed: demand.majorDestroyed,
      renterPct: tenureKnown ? round((demand.renters / tenureKnown) * 100, 1) : null,
      uninsuredPct: insuranceKnown ? round((demand.uninsured / insuranceKnown) * 100, 1) : null,
    },
    services,
    tables,
    sqftNeeded,
    interpreters,
    top,
    checks: [
      'Bus line: transit routes are not loaded; check the route map before booking the site.',
    ],
    excluded,
    whatWouldChange,
    inputs,
    equity: equityCheck(first ? [first] : [], tracts, f),
    weights,
    factors: f,
  };
}
