/**
 * Location on the web build (DSP-08, FLD-15, FLD-16): the browser's
 * geolocation, only while checked in with sharing on; the frequency follows
 * field-core's location policy (battery saver, standing still, urgent). The
 * phone uses location.native.ts (expo-location, a background task while
 * checked in, Q-07). Fixes go to the caller, which queues them through the
 * outbox as append-only facts. What the phone allows (granted, only while
 * the app is open, denied, no position to be had) goes to `onPermission`
 * so dispatch can be told (BRD:FR-03.05).
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

/** BRD:FR-03.05: what the phone lets the app do with location on this shift. */
export type LocationPermission = 'granted' | 'foreground_only' | 'denied' | 'unavailable';

let watchId: number | null = null;
let last: Fix | null = null;

export function lastFix(): Fix | null {
  return last;
}

export async function startLocation(
  policy: LocationPolicy,
  onFix: (f: Fix) => void,
  onPermission: (p: LocationPermission) => void = () => undefined,
): Promise<boolean> {
  await stopLocation();
  if (!policy.enabled) return false;
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    onPermission('unavailable');
    return false;
  }
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      onPermission('granted');
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
    // Denied or no position: the phone and dispatch are told; work goes on without a position.
    (err) => onPermission(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
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
