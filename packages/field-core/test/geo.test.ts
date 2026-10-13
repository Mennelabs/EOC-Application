/**
 * Parcel snapping, hazard warnings, street sweep, timers and the location
 * policy (FLD-04, FLD-05, FLD-10, FLD-15, FLD-16, DSP-07, DSP-08).
 */
import { describe, expect, it } from 'vitest';
import { distanceM, hazardsAround, pointInParcel, snapToParcel, type Parcel } from '../src/geo.ts';
import { currentStop, orderSweep, startSweep, sweepProgress, tap, undo } from '../src/sweep.ts';
import { confirmTimer, nextReminderAt, startTimer, timerLabel, timerPhase } from '../src/timers.ts';
import { locationPolicy, thinFixes } from '../src/battery.ts';

/** A 30 m lot grid like the seed's (tools/seed/src/county.ts): lot (c, r) at the origin. */
const DEG_LAT = 1 / 111_320;
const lat0 = 38.79;
const lon0 = -90.87;
const degLon = DEG_LAT / Math.cos((lat0 * Math.PI) / 180);
function lot(c: number, r: number, size = 30): Parcel {
  const lon = lon0 + c * size * 1.2 * degLon;
  const lat = lat0 + r * size * 1.2 * DEG_LAT;
  const dLon = size * degLon;
  const dLat = size * DEG_LAT;
  return {
    id: `id-${c}-${r}`,
    parcelId: `SYN-WIL-${c}${r}`,
    line1: `${100 + c * 2} Elm St`,
    city: 'Harmon City',
    postal: '63001',
    structure: 'single_family',
    unitCount: 1,
    areaKey: 'willow-bend',
    centroid: { lat: lat + dLat / 2, lon: lon + dLon / 2 },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, lat],
          [lon + dLon, lat],
          [lon + dLon, lat + dLat],
          [lon, lat + dLat],
          [lon, lat],
        ],
      ],
    },
  };
}
const grid = [lot(0, 0), lot(1, 0), lot(2, 0), lot(0, 1), lot(1, 1), lot(2, 1)];

describe('parcel snapping (FLD-04, FLD-05)', () => {
  it('a fix inside a lot snaps to it with confidence inside and offers the neighbours', () => {
    const inside = { lat: lot(1, 0).centroid!.lat, lon: lot(1, 0).centroid!.lon, accuracyM: 5 };
    expect(pointInParcel(inside, lot(1, 0))).toBe(true);
    const snap = snapToParcel(inside, grid)!;
    expect(snap.parcel.parcelId).toBe('SYN-WIL-10');
    expect(snap.inside).toBe(true);
    expect(snap.confidence).toBe('inside');
    expect(snap.distanceM).toBe(0);
    expect(snap.alternatives.map((a) => a.parcel.parcelId)).toContain('SYN-WIL-00');
    expect(snap.alternatives.length).toBeLessThanOrEqual(4);
  });

  it('a fix in the gap between lots snaps to the nearest one as near; a far fix asks harder; nothing within range gives null', () => {
    // 3 m east of lot (0,0)'s eastern edge, mid-height.
    const eastEdgeLon = lon0 + 30 * degLon;
    const gap = { lat: lot(0, 0).centroid!.lat, lon: eastEdgeLon + 3 * degLon };
    const snap = snapToParcel(gap, grid)!;
    expect(snap.parcel.parcelId).toBe('SYN-WIL-00');
    expect(snap.inside).toBe(false);
    expect(snap.confidence).toBe('near');
    expect(snap.distanceM).toBeGreaterThan(2);
    expect(snap.distanceM).toBeLessThan(6);
    const far = { lat: lat0 - 45 * DEG_LAT, lon: lon0 };
    expect(snapToParcel(far, grid)!.confidence).toBe('far');
    const nowhere = { lat: lat0 - 500 * DEG_LAT, lon: lon0 };
    expect(snapToParcel(nowhere, grid)).toBeNull();
    // A poor accuracy radius widens the search (the phone says ±120 m).
    expect(
      snapToParcel({ ...nowhere, lat: lat0 - 100 * DEG_LAT, accuracyM: 120 }, grid),
    ).not.toBeNull();
  });

  it('hazard areas warn when inside or within the margin, nearest first, never a cleared one (FLD-16)', () => {
    const here = { lat: lat0, lon: lon0 };
    const hazards = [
      {
        id: 'a',
        kind: 'downed_line',
        severity: 'danger',
        state: 'confirmed',
        position: { lat: lat0 + 20 * DEG_LAT, lon: lon0 },
        radiusM: 30,
        summary: null,
      },
      {
        id: 'b',
        kind: 'gas_leak',
        severity: 'critical',
        state: 'reported',
        position: { lat: lat0 + 70 * DEG_LAT, lon: lon0 },
        radiusM: 50,
        summary: null,
      },
      {
        id: 'c',
        kind: 'flooding',
        severity: 'caution',
        state: 'cleared',
        position: here,
        radiusM: 500,
        summary: null,
      },
      {
        id: 'd',
        kind: 'debris',
        severity: 'info',
        state: 'confirmed',
        position: { lat: lat0 + 300 * DEG_LAT, lon: lon0 },
        radiusM: 20,
        summary: null,
      },
    ];
    const warnings = hazardsAround(here, hazards);
    expect(warnings.map((w) => w.hazard.id)).toEqual(['a', 'b']);
    expect(warnings[0]!.inside).toBe(true);
    expect(warnings[1]!.inside).toBe(false);
    expect(Math.abs(distanceM(here, hazards[1]!.position!) - 70)).toBeLessThan(1);
  });
});

describe('street sweep (FLD-10)', () => {
  const stops = grid.map((p, i) => ({
    parcelId: p.parcelId,
    position: p.centroid!,
    reported: i === 4 || i === 2,
    hasPhoto: i === 2,
  }));
  it('walks nearest-neighbour from the start and never revisits a stop', () => {
    const order = orderSweep(stops, { lat: lat0, lon: lon0 });
    expect(order.map((s) => s.parcelId)).toEqual([
      'SYN-WIL-00',
      'SYN-WIL-10',
      'SYN-WIL-20',
      'SYN-WIL-21',
      'SYN-WIL-11',
      'SYN-WIL-01',
    ]);
    expect(new Set(order.map((s) => s.parcelId)).size).toBe(stops.length);
  });
  it('no_photo_first puts the reports without a photo at the front, then walks the rest from there', () => {
    const order = orderSweep(stops, { lat: lat0, lon: lon0 }, 'no_photo_first');
    expect(order[0]!.parcelId).toBe('SYN-WIL-11'); // reported, no photo
    expect(order.slice(1).map((s) => s.parcelId)).not.toContain('SYN-WIL-11');
    expect(order.length).toBe(stops.length);
  });
  it('one tap per property advances the pin; undo steps back and clears the tap; progress counts', () => {
    let s = startSweep(stops, { lat: lat0, lon: lon0 });
    expect(currentStop(s)!.parcelId).toBe('SYN-WIL-00');
    s = tap(s, 'minor');
    s = tap(s, 'destroyed');
    expect(currentStop(s)!.parcelId).toBe('SYN-WIL-20');
    expect(s.taps).toEqual({ 'SYN-WIL-00': 'minor', 'SYN-WIL-10': 'destroyed' });
    s = undo(s);
    expect(currentStop(s)!.parcelId).toBe('SYN-WIL-10');
    expect(s.taps).toEqual({ 'SYN-WIL-00': 'minor' });
    expect(sweepProgress(s)).toEqual({ done: 1, total: 6, finished: false });
    for (let i = 0; i < 6; i += 1) s = tap(s, 'no_damage');
    expect(sweepProgress(s).finished).toBe(true);
    expect(currentStop(s)).toBeNull();
    expect(tap(s, 'affected')).toEqual(s); // nothing left to tap
  });
});

describe('check-in timer (DSP-07, FLD-16)', () => {
  const t0 = new Date('2026-10-13T12:00:00Z');
  it('ok, due soon at the reminder lead, due, then overdue; confirming restarts it', () => {
    const t = startTimer(t0, 60, 10);
    expect(timerPhase(t, new Date('2026-10-13T12:30:00Z'))).toBe('ok');
    expect(timerPhase(t, new Date('2026-10-13T12:51:00Z'))).toBe('due_soon');
    expect(timerPhase(t, new Date('2026-10-13T13:00:00Z'))).toBe('due');
    expect(timerPhase(t, new Date('2026-10-13T13:02:00Z'))).toBe('overdue');
    expect(timerLabel(t, new Date('2026-10-13T12:30:00Z'))).toBe('Due in 30 min');
    expect(timerLabel(t, new Date('2026-10-13T13:07:00Z'))).toBe('Overdue 7 min');
    expect(timerLabel(t, new Date('2026-10-13T13:07:00Z'), 'es')).toBe('Atrasado 7 min');
    const again = confirmTimer(t, new Date('2026-10-13T12:40:00Z'));
    expect(timerPhase(again, new Date('2026-10-13T13:20:00Z'))).toBe('ok');
  });
  it('the next reminder is the lead, then due, then every five minutes while overdue', () => {
    const t = startTimer(t0, 60, 10);
    expect(nextReminderAt(t, new Date('2026-10-13T12:00:00Z')).toISOString()).toBe(
      '2026-10-13T12:50:00.000Z',
    );
    expect(nextReminderAt(t, new Date('2026-10-13T12:55:00Z')).toISOString()).toBe(
      '2026-10-13T13:00:00.000Z',
    );
    expect(nextReminderAt(t, new Date('2026-10-13T13:01:00Z')).toISOString()).toBe(
      '2026-10-13T13:05:00.000Z',
    );
    expect(nextReminderAt(t, new Date('2026-10-13T13:12:00Z')).toISOString()).toBe(
      '2026-10-13T13:15:00.000Z',
    );
  });
});

describe('location policy (FLD-15, DSP-08, Q-07)', () => {
  const base = {
    checkedIn: true,
    locationSharing: true,
    batterySaver: false,
    batteryLevel: 0.8,
    charging: false,
    movedM: 100,
    urgent: false,
  };
  it('is off unless checked in with sharing on; precise when urgent; slower on battery saver, low battery and standing still', () => {
    expect(locationPolicy({ ...base, checkedIn: false }).enabled).toBe(false);
    expect(locationPolicy({ ...base, locationSharing: false })).toMatchObject({
      enabled: false,
      reason: 'sharing_off',
    });
    expect(locationPolicy(base)).toMatchObject({
      enabled: true,
      intervalS: 30,
      accuracy: 'high',
      reason: 'moving',
    });
    expect(locationPolicy({ ...base, urgent: true })).toMatchObject({
      intervalS: 10,
      accuracy: 'high',
      reason: 'urgent',
    });
    expect(locationPolicy({ ...base, batterySaver: true }).intervalS).toBe(120);
    expect(locationPolicy({ ...base, batteryLevel: 0.1 }).reason).toBe('battery_low');
    expect(locationPolicy({ ...base, batteryLevel: 0.1, charging: true }).reason).toBe('moving');
    expect(locationPolicy({ ...base, movedM: 2 }).reason).toBe('still');
    expect(locationPolicy({ ...base, batterySaver: true, movedM: 2 })).toMatchObject({
      intervalS: 300,
      accuracy: 'low',
    });
    // Even on saver, a help alert gets the exact position often (plan §12.1).
    expect(
      locationPolicy({ ...base, batterySaver: true, batteryLevel: 0.05, urgent: true }).intervalS,
    ).toBe(10);
  });
  it('thins a run of fixes: never 0,0 or the future, and nothing closer than the policy says unless the interval passed', () => {
    const now = new Date('2026-10-13T12:10:00Z');
    const policy = locationPolicy(base); // 10 m / 30 s
    const at = (s: number) => new Date(now.getTime() - (600 - s) * 1000).toISOString();
    const fixes = [
      { lat: 0, lon: 0, recordedAt: at(0) },
      { lat: lat0, lon: lon0, recordedAt: at(1) },
      { lat: lat0 + 2 * DEG_LAT, lon: lon0, recordedAt: at(5) }, // 2 m, 4 s: dropped
      { lat: lat0 + 3 * DEG_LAT, lon: lon0, recordedAt: at(40) }, // 3 m but 39 s: kept
      { lat: lat0 + 50 * DEG_LAT, lon: lon0, recordedAt: at(42) }, // 47 m: kept
      { lat: lat0, lon: lon0, recordedAt: new Date(now.getTime() + 3_600_000).toISOString() }, // future
    ];
    const kept = thinFixes(fixes, policy, now, distanceM);
    expect(kept.map((f) => f.recordedAt)).toEqual([at(1), at(40), at(42)]);
  });
});
