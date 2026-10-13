/**
 * Nearest open sites for the text and voice channels (PUB-08, PUB-09): the
 * same published records as the web page, cut to the three nearest open
 * sites with hours, pets and accessibility, in the resident's language.
 */
import type { Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { addressText, hoursText } from '../public/help.ts';
import { publicSites, resolveNear, type Near, type PublicSite } from '../public/sites-view.ts';

type Lang = 'en' | 'es';

const T = {
  en: {
    pets: {
      yes: 'pets welcome',
      no: 'no pets',
      service_animals: 'service animals only',
      unknown: '',
    },
    kind: {
      shelter: 'shelter',
      feeding: 'food',
      pod: 'supplies',
      marc: 'recovery center',
      cooling: 'cooling center',
      warming: 'warming center',
      reporting: 'report damage here',
      charging: 'charging',
      other: 'help site',
    } as Record<string, string>,
    status: {
      open: 'open',
      limited: 'limited space',
      full: 'full',
      closed: 'closed',
      planned: 'planned',
    },
    wheelchair: 'wheelchair accessible',
    km: 'km away',
  },
  es: {
    pets: {
      yes: 'se aceptan mascotas',
      no: 'sin mascotas',
      service_animals: 'solo animales de servicio',
      unknown: '',
    },
    kind: {
      shelter: 'albergue',
      feeding: 'comida',
      pod: 'suministros',
      marc: 'centro de recuperación',
      cooling: 'centro de enfriamiento',
      warming: 'centro para calentarse',
      reporting: 'reporte daños aquí',
      charging: 'carga',
      other: 'sitio de ayuda',
    } as Record<string, string>,
    status: {
      open: 'abierto',
      limited: 'espacio limitado',
      full: 'lleno',
      closed: 'cerrado',
      planned: 'planeado',
    },
    wheelchair: 'accesible en silla de ruedas',
    km: 'km',
  },
};

export interface NearestOpen {
  near: Near | null;
  sites: PublicSite[];
}

/** The three nearest open or limited sites; by name when the place is unknown. */
export async function nearestOpenSites(
  trx: Transaction<Database>,
  tenantId: string,
  query: string | null,
  limit = 3,
): Promise<NearestOpen> {
  const near = await resolveNear(trx, tenantId, query ?? undefined);
  const all = await publicSites(trx, tenantId, { near });
  const open = all.filter((s) => s.status === 'open' || s.status === 'limited');
  return { near, sites: open.slice(0, limit) };
}

function facts(site: PublicSite, lang: Lang): string[] {
  const t = T[lang];
  const parts = [addressText(site), hoursText(site.hours, lang), t.pets[site.pets]];
  if (site.accessibility['wheelchair'] === true || site.accessibility['ada'] === true)
    parts.push(t.wheelchair);
  if (site.status === 'limited') parts.push(t.status.limited);
  return parts.filter((p) => p && p.trim());
}

/** One text line per site: name (kind), address, hours, pets, accessibility, distance. */
export function siteLine(site: PublicSite, lang: Lang): string {
  const t = T[lang];
  const distance = site.distanceKm !== null ? ` (${site.distanceKm} ${t.km})` : '';
  return `${site.name} (${t.kind[site.kind] ?? site.kind})${distance}: ${facts(site, lang).join('; ')}.`;
}

/** The same site as a spoken sentence (no abbreviations, no symbols). */
export function siteSpoken(site: PublicSite, lang: Lang): string {
  const t = T[lang];
  const kind = t.kind[site.kind] ?? site.kind;
  const parts = facts(site, lang);
  return lang === 'en'
    ? `${site.name}, a ${kind}. ${parts.join('. ')}.`
    : `${site.name}, ${kind}. ${parts.join('. ')}.`;
}
