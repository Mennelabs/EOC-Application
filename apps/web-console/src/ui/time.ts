/**
 * BRD:FR-00.08: times are stored in UTC and shown, and typed, in the tenant's
 * approved time zone, whatever zone the browser is in. A county's staff, a
 * state liaison two zones away and a laptop set to UTC all read 07:00 as the
 * county's 07:00, with the zone named. The zone comes from /me once signed in;
 * until then (and if the name is not one the browser knows) the browser's own
 * zone is used.
 */

let zone: string | undefined;

/** Sets the zone every console time is shown and typed in; an unknown name is ignored. */
export function setDisplayZone(timeZone: string | undefined): void {
  if (!timeZone) {
    zone = undefined;
    return;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    zone = timeZone;
  } catch {
    zone = undefined;
  }
}

export function displayZone(): string | undefined {
  return zone;
}

/** Date and time in the display zone with the zone named: "Oct 16, 2026, 7:00 AM CDT". */
export function formatInstant(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    ...(zone ? { timeZone: zone } : {}),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/** Time of day in the display zone with the zone named: "7:00 AM CDT". */
export function formatTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    ...(zone ? { timeZone: zone } : {}),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/** A calendar date in the display zone, with the given parts. */
export function formatDate(d: Date, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(undefined, {
    ...(zone ? { timeZone: zone } : {}),
    ...opts,
  }).format(d);
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock in a zone (the browser's when none is set) at an instant. */
export function wallClock(d: Date, timeZone = zone): Wall {
  if (!timeZone) {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(d);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: n('year'),
    month: n('month'),
    day: n('day'),
    hour: n('hour') % 24,
    minute: n('minute'),
    second: n('second'),
  };
}

const pad = (x: number) => String(x).padStart(2, '0');

/** An instant as a datetime-local value ("2026-10-16T07:00") on the display zone's clock. */
export function toZoneInput(d: Date, timeZone = zone): string {
  const w = wallClock(d, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * A datetime-local value read on the display zone's clock, as an instant. Across
 * a daylight-saving change the offset is taken at the result, so 07:00 is 07:00
 * on either side; a time that does not exist (the hour skipped in spring) moves
 * forward by that hour, as clocks do.
 */
export function fromZoneInput(value: string, timeZone = zone): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return new Date(value);
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0);
  if (!timeZone) {
    return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0);
  }
  const offsetAt = (t: number) => {
    const w = wallClock(new Date(t), timeZone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - t;
  };
  const first = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(first);
  // The candidate that reads back as the typed time wins; in the skipped hour neither
  // does, and the first one is the typed time moved forward by the hour.
  return new Date(toZoneInput(new Date(second), timeZone) === value.slice(0, 16) ? second : first);
}
