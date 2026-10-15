/**
 * The joint damage assessment's sample route (FL:FR-10): federal, state and
 * county teams validate a sample of the county's verified, counted homes.
 * The sample is drawn in proportion to the homes in each degree of damage
 * (largest remainder, and at least one from every degree that has homes
 * when the sample is big enough), at random within each degree from a recorded
 * seed so it can be drawn again exactly, and put in route order by nearest
 * neighbour from the westernmost stop. Positions are the homes' 100 m cell
 * centres: the route never needs an address (DEC-13). Pure: no database.
 */
import { DEGREES, type Degree } from '../counting.ts';

export interface SampleCandidate {
  recordId: string;
  /** Whether the record is a resident report or a field assessment. */
  kind?: 'report' | 'assessment';
  degree: Degree;
  /** [lon, lat] of the home's 100 m cell centre; null when it has no position. */
  point: [number, number] | null;
}

export interface SampleStop extends SampleCandidate {
  seq: number;
}

/** A small, fast, seeded generator (mulberry32): the same seed draws the same sample. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How many to draw from each degree: proportional by largest remainder (ties
 * to the more severe degree); then, when the sample can afford it, a degree
 * with homes but no share takes one from the largest share.
 */
export function allocate(counts: Record<Degree, number>, size: number): Record<Degree, number> {
  const total = DEGREES.reduce((n, d) => n + counts[d], 0);
  const out = Object.fromEntries(DEGREES.map((d) => [d, 0])) as Record<Degree, number>;
  const want = Math.min(Math.max(0, Math.floor(size)), total);
  if (want === 0) return out;
  const exact = Object.fromEntries(DEGREES.map((d) => [d, (counts[d] * want) / total])) as Record<
    Degree,
    number
  >;
  for (const d of DEGREES) out[d] = Math.floor(exact[d]);
  let short = want - DEGREES.reduce((n, d) => n + out[d], 0);
  const byRemainder = [...DEGREES].sort(
    (a, b) =>
      exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])) ||
      DEGREES.indexOf(b) - DEGREES.indexOf(a),
  );
  for (const d of byRemainder) {
    if (short <= 0) break;
    if (out[d] < counts[d]) {
      out[d]++;
      short--;
    }
  }
  const present = DEGREES.filter((d) => counts[d] > 0);
  if (want >= present.length)
    for (const d of present)
      if (out[d] === 0) {
        const donor = DEGREES.reduce((best, x) => (out[x] > out[best] ? x : best), DEGREES[0]);
        out[donor]--;
        out[d] = 1;
      }
  return out;
}

const metres = (a: [number, number], b: [number, number]) => {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (a[0] - b[0]) * k * 111_320;
  const dy = (a[1] - b[1]) * 110_540;
  return Math.hypot(dx, dy);
};

/** Nearest neighbour from the westernmost stop; stops with no position go last, as drawn. */
export function routeOrder<T extends { point: [number, number] | null }>(stops: T[]): T[] {
  const placed = stops.filter((s) => s.point);
  const unplaced = stops.filter((s) => !s.point);
  const out: T[] = [];
  if (placed.length) {
    let i = placed.reduce((best, s, k) => (s.point![0] < placed[best]!.point![0] ? k : best), 0);
    while (placed.length) {
      const [here] = placed.splice(i, 1);
      out.push(here!);
      if (!placed.length) break;
      i = placed.reduce(
        (best, s, k) =>
          metres(here!.point!, s.point!) < metres(here!.point!, placed[best]!.point!) ? k : best,
        0,
      );
    }
  }
  return [...out, ...unplaced];
}

/** The sample route: proportional by degree, seeded, in route order. */
export function proportionalSample(
  candidates: readonly SampleCandidate[],
  size: number,
  seed: number,
): { stops: SampleStop[]; allocation: Record<Degree, number> } {
  const byDegree = Object.fromEntries(
    DEGREES.map((d) => [
      d,
      // A stable order first, so the seed alone decides the draw.
      candidates.filter((c) => c.degree === d).sort((a, b) => (a.recordId < b.recordId ? -1 : 1)),
    ]),
  ) as Record<Degree, SampleCandidate[]>;
  const allocation = allocate(
    Object.fromEntries(DEGREES.map((d) => [d, byDegree[d].length])) as Record<Degree, number>,
    size,
  );
  const random = seededRandom(seed);
  const drawn: SampleCandidate[] = [];
  for (const d of DEGREES) {
    const pool = [...byDegree[d]];
    // Partial Fisher–Yates: the first n of a seeded shuffle.
    for (let i = 0; i < allocation[d]; i++) {
      const j = i + Math.floor(random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      drawn.push(pool[i]!);
    }
  }
  return {
    stops: routeOrder(drawn).map((s, i) => ({ ...s, seq: i + 1 })),
    allocation,
  };
}

/** Box 10 of Form 010-0-13: the joint assessment's dates and areas, or null when not set. */
export function jointPdaBox10(
  j: { startsOn: string | null; endsOn: string | null; areas: string[] } | null,
): { dates: string | null; areas: string | null } {
  if (!j) return { dates: null, areas: null };
  const dates =
    j.startsOn && j.endsOn
      ? j.startsOn === j.endsOn
        ? j.startsOn
        : `${j.startsOn} to ${j.endsOn}`
      : (j.startsOn ?? j.endsOn);
  return { dates, areas: j.areas.length ? j.areas.join('; ') : null };
}
