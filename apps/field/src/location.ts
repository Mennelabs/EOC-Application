/**
 * Location on the web build (DSP-08, FLD-15, FLD-16): the browser's
 * geolocation, only while checked in with sharing on; the frequency follows
 * field-core's location policy (battery saver, standing still, urgent). The
 * phone uses location.native.ts (expo-location, a background task while
 * checked in, Q-07). Fixes go to the caller, which queues them through the
 * outbox as append-only facts.
 */
import type { LocationPolicy } from '@cg/field-core';

export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedMps: number | null;
  heading: number | null;
  recordedAt: string;
}

let watchId: number | null = null;
let last: Fix | null = null;

export function lastFix(): Fix | null {
  return last;
}

export async function startLocation(
  policy: LocationPolicy,
  onFix: (f: Fix) => void,
): Promise<boolean> {
  await stopLocation();
  if (!policy.enabled || typeof navigator === 'undefined' || !navigator.geolocation) return false;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      last = {
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        accuracyM: p.coords.accuracy ?? null,
        speedMps: p.coords.speed ?? null,
        heading: p.coords.heading ?? null,
        recordedAt: new Date(p.timestamp).toISOString(),
      };
      onFix(last);
    },
    () => undefined, // denied or unavailable: the indicator says so; work goes on without a position
    {
      enableHighAccuracy: policy.accuracy === 'high',
      maximumAge: policy.intervalS * 1000,
      timeout: 30_000,
    },
  );
  return true;
}

export async function stopLocation(): Promise<void> {
  if (watchId !== null && typeof navigator !== 'undefined')
    navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

/** One fresh fix for the help button: exact, whatever the policy (plan §12.1). */
export function currentFix(timeoutMs = 8_000): Promise<Fix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(last);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracyM: p.coords.accuracy ?? null,
          speedMps: p.coords.speed ?? null,
          heading: p.coords.heading ?? null,
          recordedAt: new Date(p.timestamp).toISOString(),
        }),
      () => resolve(last),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10_000 },
    );
  });
}
