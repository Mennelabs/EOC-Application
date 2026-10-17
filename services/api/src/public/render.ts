/**
 * Public pages rendered from plain data (PUB-13, PUB-18, A11Y-01, ACC-49/51):
 * the strings in both launch languages and the resource, "gone" and media
 * pages. Nothing here sees a request; the routes hand over already-safe
 * values and the page shell escapes every string it places.
 */
import { escapeHtml, page } from './html.ts';
import type { PublicResource, PublicSite } from './sites-view.ts';

export const T = {
  en: {
    help: 'Find help',
    sites: 'Open sites',
    resources: 'Help and programs',
    status: {
      open: 'Open',
      limited: 'Limited space',
      full: 'Full',
      closed: 'Closed',
      planned: 'Planned',
    },
    lastConfirmed: 'Last confirmed',
    nextNearest: 'Nearest open site of this kind',
    expired: 'This information expired on',
    removed: 'This information was withdrawn on',
    noLonger: 'It is no longer current. Check the current list of help.',
    media: 'Media sheet',
    pdf: 'Download the media sheet as a PDF',
    updated: 'Last updated',
    generated: 'Page generated',
    reload: 'Reload this page for the latest numbers; it does not refresh on its own.',
    accessibility:
      'We aim to meet WCAG 2.2 AA. If something on this page does not work for you, tell us and we will help another way.',
    support: 'Help line',
    danger: 'If anyone is in danger right now, call 911. This page does not send help.',
    pets: {
      yes: 'Pets welcome',
      no: 'No pets',
      service_animals: 'Service animals only',
      unknown: 'Pets: ask',
    },
    hoursAlways: 'Open 24 hours',
    none: 'No sites are open right now.',
    columns: ['Site', 'Type', 'Status', 'Address', 'Hours', 'Pets'],
    kind: {
      shelter: 'Shelter',
      feeding: 'Food',
      pod: 'Supplies',
      marc: 'Recovery center',
      cooling: 'Cooling center',
      warming: 'Warming center',
      reporting: 'Report damage here',
      charging: 'Charging',
      other: 'Help site',
    } as Record<string, string>,
  },
  es: {
    help: 'Encuentre ayuda',
    sites: 'Sitios abiertos',
    resources: 'Ayuda y programas',
    status: {
      open: 'Abierto',
      limited: 'Espacio limitado',
      full: 'Lleno',
      closed: 'Cerrado',
      planned: 'Planeado',
    },
    lastConfirmed: 'Última confirmación',
    nextNearest: 'Sitio abierto más cercano de este tipo',
    expired: 'Esta información venció el',
    removed: 'Esta información se retiró el',
    noLonger: 'Ya no está vigente. Consulte la lista actual de ayuda.',
    media: 'Hoja para medios',
    pdf: 'Descargar la hoja para medios en PDF',
    updated: 'Última actualización',
    generated: 'Página generada',
    reload: 'Vuelva a cargar esta página para ver los datos más recientes; no se actualiza sola.',
    accessibility:
      'Buscamos cumplir WCAG 2.2 AA. Si algo en esta página no le funciona, díganos y le ayudaremos de otra manera.',
    support: 'Línea de ayuda',
    danger: 'Si alguien está en peligro ahora mismo, llame al 911. Esta página no envía ayuda.',
    pets: {
      yes: 'Se aceptan mascotas',
      no: 'Sin mascotas',
      service_animals: 'Solo animales de servicio',
      unknown: 'Mascotas: pregunte',
    },
    hoursAlways: 'Abierto las 24 horas',
    none: 'No hay sitios abiertos ahora.',
    columns: ['Sitio', 'Tipo', 'Estado', 'Dirección', 'Horario', 'Mascotas'],
    kind: {
      shelter: 'Albergue',
      feeding: 'Comida',
      pod: 'Suministros',
      marc: 'Centro de recuperación',
      cooling: 'Centro de enfriamiento',
      warming: 'Centro para calentarse',
      reporting: 'Reporte daños aquí',
      charging: 'Carga',
      other: 'Sitio de ayuda',
    } as Record<string, string>,
  },
};
export type Lang = keyof typeof T;
export const langOf = (raw: string): Lang => (raw.toLowerCase().startsWith('es') ? 'es' : 'en');

export function hoursText(hours: Record<string, unknown>, lang: Lang): string {
  if (hours['always'] === true) return T[lang].hoursAlways;
  return Object.entries(hours)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}: ${v as string}`)
    .join('; ');
}

export function addressText(site: PublicSite): string {
  const a = site.address;
  if (!a) return '';
  return [a.line1, a.unit, a.city, a.state, a.postal].filter(Boolean).join(', ');
}

const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const helpLink = (slug: string, lang: Lang) =>
  `/api/public/help/${encodeURIComponent(slug)}?lang=${lang}`;
const mediaPdfLink = (slug: string, lang: Lang) =>
  `/api/public/help/${encodeURIComponent(slug)}/media.pdf?lang=${lang}`;
const resourceLink = (slug: string, resource: string, lang: Lang) =>
  `/api/public/help/${encodeURIComponent(slug)}/resources/${encodeURIComponent(resource)}?lang=${lang}`;

/** A paragraph of escaped text. */
const p = (text: string, cls?: string) =>
  `<p${cls ? ` class="${cls}"` : ''}>${escapeHtml(text)}</p>`;

export interface ResourcePageInput {
  lang: Lang;
  tenantName: string;
  tenantSlug: string;
  title: string;
  summary: string | null;
  /** Already passed through the allow-list sanitiser. */
  safeBodyHtml: string;
  referenceUrl: string | null;
  updatedAt: string;
  /** FR-16.01: decorative, so it has empty alternative text; the words say it all. */
  thumbnailUrl?: string | null;
}

export function resourcePage(i: ResourcePageInput): string {
  const t = T[i.lang];
  const link = i.referenceUrl && /^https?:\/\//i.test(i.referenceUrl) ? i.referenceUrl : null;
  const body =
    (i.thumbnailUrl
      ? `<img src="${escapeHtml(i.thumbnailUrl)}" alt="" width="240" height="160" style="max-width:100%;height:auto">`
      : '') +
    (i.summary ? p(i.summary, 'status') : '') +
    i.safeBodyHtml +
    (link ? `<p><a href="${escapeHtml(link)}" rel="noopener">${escapeHtml(link)}</a></p>` : '') +
    p(`${t.updated}: ${stamp(i.updatedAt)}`, 'muted') +
    p(t.danger);
  return page({
    lang: i.lang,
    title: i.title,
    tenantName: i.tenantName,
    body,
    footer: footer(i.tenantSlug, i.lang),
  });
}

export function goneResourcePage(i: {
  lang: Lang;
  tenantName: string;
  tenantSlug: string;
  title: string;
  kind: 'expired' | 'removed';
  when: string;
}): string {
  const t = T[i.lang];
  const body =
    p(`${i.kind === 'expired' ? t.expired : t.removed} ${i.when}.`, 'status') + p(t.noLonger);
  return page({
    lang: i.lang,
    title: i.title,
    tenantName: i.tenantName,
    body,
    footer: footer(i.tenantSlug, i.lang),
  });
}

function footer(slug: string, lang: Lang): string {
  return `<p><a href="${helpLink(slug, lang)}">${escapeHtml(T[lang].help)}</a></p>`;
}

export interface MediaPageInput {
  lang: Lang;
  tenantName: string;
  tenantSlug: string;
  sites: PublicSite[];
  resources: PublicResource[];
  helpPhone: string | null;
  statement: string;
  generatedAt: string;
}

export function mediaPage(i: MediaPageInput): string {
  const t = T[i.lang];
  const latest = i.sites.reduce<string | null>(
    (acc, s) => (acc && acc > s.updatedAt ? acc : s.updatedAt),
    null,
  );
  const cell = (text: string, cls?: string) =>
    `<td${cls ? ` class="${cls}"` : ''}>${escapeHtml(text)}</td>`;
  const rows = i.sites
    .map((s) => {
      const status =
        escapeHtml(t.status[s.status]) +
        (s.nextNearest
          ? `<br><span class="muted">${escapeHtml(`${t.nextNearest}: ${s.nextNearest.name}`)}</span>`
          : '');
      return (
        `<tr><th scope="row">${escapeHtml(s.name)}</th>` +
        cell(t.kind[s.kind] ?? s.kind) +
        `<td class="status">${status}</td>` +
        cell(addressText(s)) +
        cell(hoursText(s.hours, i.lang)) +
        cell(t.pets[s.pets]) +
        cell(s.lastConfirmedAt ? stamp(s.lastConfirmedAt) : '') +
        '</tr>'
      );
    })
    .join('');
  const header = [...t.columns, t.lastConfirmed]
    .map((c) => `<th scope="col">${escapeHtml(c)}</th>`)
    .join('');
  const resources = i.resources
    .map(
      (r) =>
        `<li><a href="${resourceLink(i.tenantSlug, r.slug, i.lang)}">${escapeHtml(r.title)}</a>` +
        (r.summary ? ` — ${escapeHtml(r.summary)}` : '') +
        ` <span class="muted">(${escapeHtml(`${t.updated} ${r.updatedAt.slice(0, 10)}`)})</span></li>`,
    )
    .join('');
  const body =
    p(t.danger) +
    p(
      `${t.updated}: ${latest ? stamp(latest) : '—'} · ${t.generated}: ${stamp(i.generatedAt)}`,
      'muted',
    ) +
    // No timed refresh (WCAG 2.2.1, 3.2.5): a reload is the reader's choice.
    p(t.reload, 'muted') +
    `<p><a href="${mediaPdfLink(i.tenantSlug, i.lang)}">${escapeHtml(t.pdf)}</a></p>` +
    `<h2>${escapeHtml(t.sites)}</h2>` +
    (i.sites.length
      ? `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`
      : p(t.none)) +
    `<h2>${escapeHtml(t.resources)}</h2><ul>${resources}</ul>` +
    (i.helpPhone
      ? `<p><strong>${escapeHtml(t.support)}:</strong> ${escapeHtml(i.helpPhone)}</p>`
      : '') +
    p(i.statement, 'muted');
  return page({
    lang: i.lang,
    title: `${t.media}: ${t.help}`,
    tenantName: i.tenantName,
    body,
  });
}
