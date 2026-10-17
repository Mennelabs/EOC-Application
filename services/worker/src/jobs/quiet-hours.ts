/**
 * BRD:FR-09.06: a county's quiet period for escalation emails, in its own
 * clock ("22:00" to "07:00" runs overnight). During it, a reminder that comes
 * due for escalation waits and is escalated when the period ends. It applies
 * to reminder escalations only: help alerts and missed safety check-ins are
 * never held (FLD-16).
 */
export interface QuietHours {
  start: string;
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (hhmm: string) => {
  const m = HHMM.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** The stored setting, or null when it is missing or not two "HH:MM" times that differ. */
export function quietHoursOf(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const { start, end } = raw as { start?: unknown; end?: unknown };
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  if (!HHMM.test(start) || !HHMM.test(end) || start === end) return null;
  return { start, end };
}

/** Whether `now` falls in the quiet period on the county's clock (start included, end not). */
export function inQuietHours(now: Date, timeZone: string, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return false; // An unknown zone never silences anything.
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const m = hour * 60 + minute;
  const s = minutes(quiet.start);
  const e = minutes(quiet.end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}
