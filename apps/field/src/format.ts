/** Times and durations in the volunteer's language. */
import type { Locale } from './i18n';

export function clock(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-US' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function duration(fromIso: string, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}

export function words(code: string): string {
  return code.replace(/_/g, ' ');
}
