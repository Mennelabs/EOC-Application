/**
 * Street sweep ordering (FLD-10, plan §4.4): one tap per property and the
 * pin advances to the next parcel. The order is a walk: from the start, the
 * nearest unvisited stop each time, so a block is covered without crossing
 * back; a route marked `no_photo_first` puts the properties whose resident
 * report has no photo at the front, in the same walking order. Undo steps
 * the pin back and clears that stop's tap.
 */
import { distanceM, type Point } from './geo.ts';

export type SweepTap = 'no_damage' | 'affected' | 'minor' | 'major' | 'destroyed' | 'cant_reach';

export interface SweepStop {
  parcelId: string;
  position: Point;
  /** A resident report exists for this property. */
  reported?: boolean;
  /** That report has at least one photo. */
  hasPhoto?: boolean;
}

export type SweepOrder = 'nearest' | 'no_photo_first';

/** Nearest-neighbour walk from `start` over `stops`. */
function walk(start: Point, stops: SweepStop[]): SweepStop[] {
  const left = [...stops];
  const out: SweepStop[] = [];
  let at = start;
  while (left.length) {
    let bestI = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < left.length; i += 1) {
      const d = distanceM(at, left[i]!.position);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const next = left.splice(bestI, 1)[0]!;
    out.push(next);
    at = next.position;
  }
  return out;
}

export function orderSweep(
  stops: readonly SweepStop[],
  start: Point,
  order: SweepOrder = 'nearest',
): SweepStop[] {
  if (order === 'no_photo_first') {
    const first = stops.filter((s) => s.reported && !s.hasPhoto);
    const rest = stops.filter((s) => !(s.reported && !s.hasPhoto));
    const head = walk(start, first);
    const from = head.length ? head[head.length - 1]!.position : start;
    return [...head, ...walk(from, rest)];
  }
  return walk(start, [...stops]);
}

export interface SweepState {
  order: SweepStop[];
  index: number;
  taps: Record<string, SweepTap>;
}

export function startSweep(
  stops: readonly SweepStop[],
  start: Point,
  order: SweepOrder = 'nearest',
): SweepState {
  return { order: orderSweep(stops, start, order), index: 0, taps: {} };
}

export function currentStop(s: SweepState): SweepStop | null {
  return s.order[s.index] ?? null;
}

/** Records the tap for the current parcel and advances the pin; done when the index passes the end. */
export function tap(s: SweepState, value: SweepTap): SweepState {
  const stop = currentStop(s);
  if (!stop) return s;
  return { ...s, taps: { ...s.taps, [stop.parcelId]: value }, index: s.index + 1 };
}

/** Steps the pin back one parcel and clears its tap (the record on the phone is withdrawn by the caller). */
export function undo(s: SweepState): SweepState {
  if (s.index === 0) return s;
  const prev = s.order[s.index - 1]!;
  const taps = { ...s.taps };
  delete taps[prev.parcelId];
  return { ...s, taps, index: s.index - 1 };
}

export function sweepProgress(s: SweepState): { done: number; total: number; finished: boolean } {
  return {
    done: Math.min(s.index, s.order.length),
    total: s.order.length,
    finished: s.index >= s.order.length,
  };
}
