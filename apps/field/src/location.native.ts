/**
 * Location on the phone (DSP-08, FLD-15, FLD-16, Q-07): expo-location in the
 * foreground and a background task (expo-task-manager) only while checked in
 * with sharing on. Android shows the foreground-service notification
 * "Sharing location with dispatch while checked in" for as long as it runs,
 * so the volunteer always sees that it is on. The task stops at check-out.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { LocationPolicy } from '@cg/field-core';
import type { Fix, LocationPermission } from './location';

export type { Fix, LocationPermission } from './location';

const TASK = 'cg-field-location';
let last: Fix | null = null;
let sink: ((f: Fix) => void) | null = null;
let foreground: Location.LocationSubscription | null = null;

const toFix = (l: Location.LocationObject): Fix => ({
  lat: l.coords.latitude,
  lon: l.coords.longitude,
  accuracyM: l.coords.accuracy ?? null,
  speedMps: l.coords.speed ?? null,
  heading: l.coords.heading ?? null,
  recordedAt: new Date(l.timestamp).toISOString(),
});

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
  if (error || !data) return;
  for (const l of data.locations) {
    last = toFix(l);
    sink?.(last);
  }
});

export function lastFix(): Fix | null {
  return last;
}

const accuracyOf = (p: LocationPolicy) =>
  p.accuracy === 'high'
    ? Location.Accuracy.High
    : p.accuracy === 'balanced'
      ? Location.Accuracy.Balanced
      : Location.Accuracy.Low;

export async function startLocation(
  policy: LocationPolicy,
  onFix: (f: Fix) => void,
  onPermission: (p: LocationPermission) => void = () => undefined,
): Promise<boolean> {
  await stopLocation();
  if (!policy.enabled) return false;
  sink = onFix;
  // BRD:FR-03.05: what the phone allows is said to dispatch, not only shown here.
  if (!(await Location.hasServicesEnabledAsync().catch(() => true))) {
    onPermission('unavailable');
    return false;
  }
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    onPermission('denied');
    return false;
  }
  foreground = await Location.watchPositionAsync(
    {
      accuracy: accuracyOf(policy),
      timeInterval: policy.intervalS * 1000,
      distanceInterval: policy.distanceM,
    },
    (l) => {
      last = toFix(l);
      onFix(last);
    },
  );
  const bg = await Location.requestBackgroundPermissionsAsync();
  onPermission(bg.status === 'granted' ? 'granted' : 'foreground_only');
  if (bg.status === 'granted')
    await Location.startLocationUpdatesAsync(TASK, {
      accuracy: accuracyOf(policy),
      timeInterval: policy.intervalS * 1000,
      distanceInterval: policy.distanceM,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Checked in',
        notificationBody: 'Sharing location with dispatch while checked in',
      },
    });
  return true;
}

export async function stopLocation(): Promise<void> {
  foreground?.remove();
  foreground = null;
  if (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false))
    await Location.stopLocationUpdatesAsync(TASK);
}

export async function currentFix(): Promise<Fix | null> {
  try {
    const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
    last = toFix(l);
    return last;
  } catch {
    return last;
  }
}
