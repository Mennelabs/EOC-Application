/**
 * BRD:FR-00.08: console times are shown and typed in the tenant's approved
 * zone, whatever zone the machine running the test is in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  displayZone,
  formatInstant,
  fromZoneInput,
  setDisplayZone,
  toZoneInput,
} from '../src/ui/time.ts';

afterEach(() => setDisplayZone(undefined));

describe('the display zone', () => {
  it('BRD:FR-00.08: an instant shows on the county clock with the zone named', () => {
    setDisplayZone('America/Chicago');
    // 12:00 UTC in October is 07:00 Central Daylight Time.
    const text = formatInstant(new Date('2026-10-16T12:00:00Z'));
    expect(text).toMatch(/7:00/);
    expect(text).toMatch(/CDT|GMT-5/);
    setDisplayZone('America/Denver');
    expect(formatInstant(new Date('2026-10-16T12:00:00Z'))).toMatch(/6:00/);
  });

  it('BRD:FR-00.08: a typed time is read on the county clock, and an instant fills an input on it', () => {
    setDisplayZone('America/Chicago');
    expect(fromZoneInput('2026-10-16T07:00').toISOString()).toBe('2026-10-16T12:00:00.000Z');
    expect(toZoneInput(new Date('2026-10-16T12:00:00Z'))).toBe('2026-10-16T07:00');
    // Winter: Central Standard Time, six hours behind.
    expect(fromZoneInput('2026-12-01T07:00').toISOString()).toBe('2026-12-01T13:00:00.000Z');
    // Round trip at any minute.
    for (const v of ['2026-01-31T23:59', '2026-07-04T00:00', '2026-11-01T12:30']) {
      expect(toZoneInput(fromZoneInput(v))).toBe(v);
    }
  });

  it('BRD:FR-00.08: across daylight-saving changes a wall time stays that wall time; the skipped hour moves forward', () => {
    setDisplayZone('America/Chicago');
    // 8 March 2026: 02:00 CST jumps to 03:00 CDT.
    expect(fromZoneInput('2026-03-08T01:30').toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(fromZoneInput('2026-03-08T03:30').toISOString()).toBe('2026-03-08T08:30:00.000Z');
    expect(toZoneInput(fromZoneInput('2026-03-08T02:30'))).toBe('2026-03-08T03:30');
    // 1 November 2026: 02:00 CDT falls back to 01:00 CST; 01:30 is read as the first one.
    expect(fromZoneInput('2026-11-01T01:30').toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(fromZoneInput('2026-11-01T03:00').toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });

  it('an unknown zone name is ignored, and the browser zone is used', () => {
    setDisplayZone('Not/AZone');
    expect(displayZone()).toBeUndefined();
    const v = '2026-10-16T07:00';
    expect(toZoneInput(fromZoneInput(v))).toBe(v);
  });
});
