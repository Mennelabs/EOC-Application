/**
 * BRD:FR-09.06: the quiet period for reminder escalation emails, on the
 * county's clock: overnight and daytime windows, its edges, and a setting
 * that does not make sense never silences anything.
 */
import { describe, expect, it } from 'vitest';
import { inQuietHours, quietHoursOf } from '../src/jobs/quiet-hours.ts';

// 2026-10-16 is in Central Daylight Time (UTC-5).
const central = (hhmm: string) => new Date(`2026-10-16T${hhmm}:00-05:00`);
const night = quietHoursOf({ start: '22:00', end: '07:00' });

describe('quiet hours for escalation emails', () => {
  it('FR-09.06: an overnight window holds from its start until its end on the county clock', () => {
    expect(inQuietHours(central('23:30'), 'America/Chicago', night)).toBe(true);
    expect(inQuietHours(central('03:00'), 'America/Chicago', night)).toBe(true);
    expect(inQuietHours(central('22:00'), 'America/Chicago', night)).toBe(true);
    expect(inQuietHours(central('07:00'), 'America/Chicago', night)).toBe(false);
    expect(inQuietHours(central('12:00'), 'America/Chicago', night)).toBe(false);
    // The same instant in another county's zone is daytime there.
    expect(inQuietHours(central('03:00'), 'Pacific/Auckland', night)).toBe(false);
  });

  it('FR-09.06: a daytime window, and settings that make no sense, never silence', () => {
    const lunch = quietHoursOf({ start: '12:00', end: '13:00' });
    expect(inQuietHours(central('12:30'), 'America/Chicago', lunch)).toBe(true);
    expect(inQuietHours(central('13:00'), 'America/Chicago', lunch)).toBe(false);
    expect(quietHoursOf({ start: '25:00', end: '07:00' })).toBeNull();
    expect(quietHoursOf({ start: '07:00', end: '07:00' })).toBeNull();
    expect(quietHoursOf('22:00-07:00')).toBeNull();
    expect(quietHoursOf(null)).toBeNull();
    expect(inQuietHours(central('03:00'), 'America/Chicago', null)).toBe(false);
    expect(inQuietHours(central('03:00'), 'Not/AZone', night)).toBe(false);
  });
});
