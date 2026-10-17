/**
 * The time of an appointment as a resident reads it in a text (FL:FR-18):
 * in the county's clock and the resident's language, e.g. "Tuesday, October
 * 20 at 2:30 PM" / "martes, 20 de octubre a las 14:30". Shared by the API,
 * which texts the notice, and the worker, which texts the reminder.
 */
export function formatAppointmentWhen(at: Date, timeZone: string, language: string): string {
  const es = language.toLowerCase().startsWith('es');
  const locale = es ? 'es-US' : 'en-US';
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat(locale, { timeZone: zone }).format(at);
  } catch {
    zone = 'UTC'; // An unknown zone never loses the text; the time is still right, in UTC.
  }
  const day = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(at);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    ...(es ? { hourCycle: 'h23' as const } : {}),
  }).format(at);
  return es ? `${day} a las ${time}` : `${day} at ${time}`;
}
