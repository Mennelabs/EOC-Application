/**
 * Location policy (FLD-15, DSP-08, plan §5 "Location"): positions are
 * collected only while checked in with sharing on; the battery saver and a
 * low battery lower the frequency; standing still lowers it further; a help
 * alert or an active hazard warning raises it. The policy is a pure function
 * so the app can show the user what it is doing ("Sharing location with
 * dispatch while checked in").
 */

export interface LocationInputs {
  checkedIn: boolean;
  locationSharing: boolean;
  batterySaver: boolean;
  /** 0–1, null when unknown. */
  batteryLevel: number | null;
  charging: boolean;
  /** Metres moved in the last interval, null when unknown. */
  movedM: number | null;
  /** A help alert is open or a hazard warning is active: stay precise. */
  urgent: boolean;
}

export interface LocationPolicy {
  enabled: boolean;
  /** Seconds between fixes. */
  intervalS: number;
  /** Minimum movement before a new fix is recorded. */
  distanceM: number;
  accuracy: 'high' | 'balanced' | 'low';
  /** Seconds between batches sent to the server through the outbox. */
  uploadEveryS: number;
  reason: string;
}

export function locationPolicy(i: LocationInputs): LocationPolicy {
  if (!i.checkedIn || !i.locationSharing)
    return {
      enabled: false,
      intervalS: 0,
      distanceM: 0,
      accuracy: 'low',
      uploadEveryS: 0,
      reason: i.checkedIn ? 'sharing_off' : 'not_checked_in',
    };
  if (i.urgent)
    return {
      enabled: true,
      intervalS: 10,
      distanceM: 0,
      accuracy: 'high',
      uploadEveryS: 15,
      reason: 'urgent',
    };
  const low = i.batteryLevel !== null && i.batteryLevel <= 0.2 && !i.charging;
  const saver = i.batterySaver || low;
  const still = i.movedM !== null && i.movedM < 15;
  if (saver && still)
    return {
      enabled: true,
      intervalS: 300,
      distanceM: 50,
      accuracy: 'low',
      uploadEveryS: 600,
      reason: low ? 'battery_low_still' : 'battery_saver_still',
    };
  if (saver)
    return {
      enabled: true,
      intervalS: 120,
      distanceM: 30,
      accuracy: 'balanced',
      uploadEveryS: 300,
      reason: low ? 'battery_low' : 'battery_saver',
    };
  if (still)
    return {
      enabled: true,
      intervalS: 120,
      distanceM: 25,
      accuracy: 'balanced',
      uploadEveryS: 180,
      reason: 'still',
    };
  return {
    enabled: true,
    intervalS: 30,
    distanceM: 10,
    accuracy: 'high',
    uploadEveryS: 60,
    reason: 'moving',
  };
}

/** Thins a run of fixes to those worth sending: at least `distanceM` apart or `intervalS` old, never 0,0, never the future. */
export function thinFixes<T extends { lat: number; lon: number; recordedAt: string }>(
  fixes: readonly T[],
  policy: LocationPolicy,
  now: Date,
  distance: (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => number,
): T[] {
  const out: T[] = [];
  let last: T | undefined;
  for (const f of [...fixes].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    if (f.lat === 0 && f.lon === 0) continue;
    const at = new Date(f.recordedAt).getTime();
    if (Number.isNaN(at) || at > now.getTime() + 5 * 60_000) continue;
    if (last) {
      const dt = (at - new Date(last.recordedAt).getTime()) / 1000;
      if (distance(last, f) < policy.distanceM && dt < policy.intervalS) continue;
    }
    out.push(f);
    last = f;
  }
  return out;
}
