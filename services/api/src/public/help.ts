/**
 * Public "Find help" (PUB-01–07, PUB-10, PUB-13, PUB-16–18, NED-06, A11Y-01,
 * BRD:FR-16.02/16.04, AC-16A/B/C, SEC-09, GATE-04/06): no sign-in, every
 * channel reads the same published, non-confidential, reconfirmed records;
 * nearest first when a ZIP or point is given; a full or closed site names the
 * next nearest open one of its kind; expired resources answer 410 with the
 * date, never silently as current. Feeds (GeoJSON, Open Referral HSDS), the
 * copy-and-paste widget and the media sheet are the same data. Responses
 * carry a short public cache so a change reaches every channel inside the
 * two minutes PUB-01 allows.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errors } from '../errors.ts';
import { escapeHtml, page, sanitizeHtml } from './html.ts';
import {
  publicResources,
  publicSites,
  resolveNear,
  type PublicResource,
  type PublicSite,
} from './sites-view.ts';
import { configValue } from './submit.ts';

const tenantParam = z.object({ tenant: z.string().min(2).max(60) });
const langQuery = z.object({ lang: z.string().min(2).max(10).default('en') });

const CACHE = 'public, max-age=60, stale-while-revalidate=60';
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

const T = {
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
    updated: 'Last updated',
    generated: 'Page generated',
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
    },
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
    updated: 'Última actualización',
    generated: 'Página generada',
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
    },
  },
};
type Lang = keyof typeof T;
const langOf = (raw: string): Lang => (raw.toLowerCase().startsWith('es') ? 'es' : 'en');

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

export interface HelpDeps {
  /** The public site's base URL for links in feeds, texts and the widget (the gateway's public host). */
  publicBase?: string | undefined;
}

export const helpRoutes =
  (deps: HelpDeps = {}): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();

    const tenantOf = (request: FastifyRequest) => {
      const t = (
        request as FastifyRequest & {
          publicTenant?: { id: string; name: string; locales: string[]; slug: string };
        }
      ).publicTenant;
      if (!t) throw errors.notFound();
      return t;
    };

    const html = (reply: FastifyReply, body: string, status = 200) =>
      reply
        .code(status)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', CACHE)
        .header('content-security-policy', CSP)
        .header('x-content-type-options', 'nosniff')
        .send(body);

    async function gather(request: FastifyRequest, lang: Lang, near?: string, kind?: string) {
      const tenant = tenantOf(request);
      await request.authorize('help.read', { type: 'help', tenantId: tenant.id, published: true });
      return request.tx(async (trx) => {
        const place = await resolveNear(trx, tenant.id, near);
        const sites = await publicSites(trx, tenant.id, { near: place, kind });
        const resources = await publicResources(trx, tenant.id, lang);
        const helpPhone = (await configValue<string>(trx, 'intake.help_phone')) ?? null;
        const statement =
          (await configValue<string>(trx, 'help.accessibility_statement')) ?? T[lang].accessibility;
        return { tenant, place, sites, resources, helpPhone, statement };
      });
    }

    const pageUrl = (slug: string, lang: Lang, path = 'help') =>
      deps.publicBase ? `${deps.publicBase}/${slug}/${path}?lang=${lang}` : null;

    // ------------------------------------------------------------- JSON
    app.get(
      '/help/:tenant',
      {
        schema: {
          tags: ['public help'],
          params: tenantParam,
          querystring: langQuery.extend({
            near: z.string().max(120).optional(),
            kind: z.string().max(20).optional(),
          }),
        },
      },
      async (request, reply) => {
        const lang = langOf(request.query.lang);
        const d = await gather(request, lang, request.query.near, request.query.kind);
        reply.header('cache-control', CACHE);
        return {
          tenant: { name: d.tenant.name, slug: d.tenant.slug, locales: d.tenant.locales },
          lang,
          generatedAt: new Date().toISOString(),
          near: d.place,
          sites: d.sites,
          resources: d.resources.map((r) => ({
            ...r,
            url: `/api/public/help/${d.tenant.slug}/resources/${r.slug}?lang=${lang}`,
          })),
          accessibility: { statement: d.statement, supportPhone: d.helpPhone },
          notices: [T[lang].danger],
          helpUrl: pageUrl(d.tenant.slug, lang),
        };
      },
    );

    // --------------------------------------------------- one resource page
    app.get(
      '/help/:tenant/resources/:slug',
      {
        schema: {
          tags: ['public help'],
          params: tenantParam.extend({ slug: z.string().min(1).max(80) }),
          querystring: langQuery,
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const lang = langOf(request.query.lang);
        await request.authorize('help.read', {
          type: 'help',
          tenantId: tenant.id,
          published: true,
        });
        const found = await request.tx(async (trx) => {
          const resource = await trx
            .selectFrom('cg.resource')
            .selectAll()
            .where('slug', '=', request.params.slug)
            .executeTakeFirst();
          if (!resource) return null;
          const texts = await trx
            .selectFrom('cg.resource_text')
            .selectAll()
            .where('resource_id', '=', resource.id)
            .where('reviewed_at', 'is not', null)
            .execute();
          const helpPhone = (await configValue<string>(trx, 'intake.help_phone')) ?? null;
          return { resource, texts, helpPhone };
        });
        if (!found || found.resource.published_at === null) throw errors.notFound();
        const text =
          found.texts.find((t) => t.locale === lang) ??
          found.texts.find((t) => t.locale === 'en') ??
          found.texts[0];
        if (!text) throw errors.notFound();
        const r = found.resource;
        const expiredAt =
          r.status === 'expired' || (r.expires_at && new Date(r.expires_at) <= new Date())
            ? (r.expires_at ?? r.updated_at)
            : null;
        const removedAt =
          r.status === 'removed' || r.unpublished_at ? (r.unpublished_at ?? r.updated_at) : null;
        const footer = `<p><a href="/api/public/help/${escapeHtml(tenant.slug)}?lang=${lang}">${escapeHtml(T[lang].help)}</a></p>`;
        if (expiredAt || removedAt) {
          const when = new Date(expiredAt ?? removedAt!).toISOString().slice(0, 10);
          return html(
            reply,
            page({
              lang,
              title: text.title,
              tenantName: tenant.name,
              body: `<p class="status">${escapeHtml(expiredAt ? T[lang].expired : T[lang].removed)} ${escapeHtml(when)}.</p><p>${escapeHtml(T[lang].noLonger)}</p>`,
              footer,
            }),
            410,
          );
        }
        const body =
          (text.summary ? `<p class="status">${escapeHtml(text.summary)}</p>` : '') +
          sanitizeHtml(text.body_html) +
          (r.reference_url
            ? `<p><a href="${escapeHtml(r.reference_url)}" rel="noopener">${escapeHtml(r.reference_url)}</a></p>`
            : '') +
          `<p class="muted">${escapeHtml(T[lang].updated)}: ${escapeHtml(new Date(r.updated_at).toISOString().slice(0, 16).replace('T', ' '))} UTC</p>` +
          `<p>${escapeHtml(T[lang].danger)}</p>`;
        return html(
          reply,
          page({ lang, title: text.title, tenantName: tenant.name, body, footer }),
        );
      },
    );

    // ---------------------------------------------------------------- feeds
    app.get(
      '/help/:tenant/sites.geojson',
      { schema: { tags: ['public help'], params: tenantParam, querystring: langQuery } },
      async (request, reply) => {
        const lang = langOf(request.query.lang);
        const d = await gather(request, lang);
        reply
          .header('content-type', 'application/geo+json; charset=utf-8')
          .header('cache-control', CACHE);
        return {
          type: 'FeatureCollection',
          generatedAt: new Date().toISOString(),
          features: d.sites
            .filter((s) => s.position)
            .map((s) => ({
              type: 'Feature',
              id: s.id,
              geometry: { type: 'Point', coordinates: [s.position!.lon, s.position!.lat] },
              properties: {
                slug: s.slug,
                kind: s.kind,
                name: s.name,
                status: s.status,
                address: addressText(s),
                hours: hoursText(s.hours, lang),
                services: s.services,
                pets: s.pets,
                accessibility: s.accessibility,
                medicalPower: s.medicalPower,
                languages: s.languages,
                transit: s.transit,
                lastConfirmedAt: s.lastConfirmedAt,
                nextNearest: s.nextNearest,
              },
            })),
        };
      },
    );

    /** Open Referral HSDS 3.0 shape: organizations, services, locations and service_at_location (PUB-10). */
    app.get(
      '/help/:tenant/hsds.json',
      { schema: { tags: ['public help'], params: tenantParam, querystring: langQuery } },
      async (request, reply) => {
        const lang = langOf(request.query.lang);
        const d = await gather(request, lang);
        reply.header('cache-control', CACHE);
        const orgId = d.tenant.id;
        const url = pageUrl(d.tenant.slug, lang);
        return {
          version: '3.0',
          generatedAt: new Date().toISOString(),
          organization: {
            id: orgId,
            name: `${d.tenant.name} Emergency Management`,
            description: T[lang].help,
            ...(url ? { url } : {}),
            ...(d.helpPhone ? { phones: [{ number: d.helpPhone, type: 'voice' }] } : {}),
          },
          services: [
            ...d.sites.map((s) => ({
              id: s.id,
              organization_id: orgId,
              name: s.name,
              description: `${T[lang].kind[s.kind as keyof typeof T.en.kind] ?? s.kind}; ${T[lang].status[s.status]}`,
              status: s.status === 'closed' ? 'inactive' : 'active',
              ...(s.lastConfirmedAt ? { last_modified: s.lastConfirmedAt } : {}),
              languages: s.languages.map((code) => ({ code })),
              schedules: [{ description: hoursText(s.hours, lang) }],
            })),
            ...d.resources.map((r) => ({
              id: r.id,
              organization_id: orgId,
              name: r.title,
              description: r.summary ?? '',
              status: 'active',
              ...(r.referenceUrl ? { url: r.referenceUrl } : {}),
              last_modified: r.updatedAt,
            })),
          ],
          locations: d.sites.map((s) => ({
            id: `loc-${s.id}`,
            organization_id: orgId,
            name: s.name,
            location_type: 'physical',
            ...(s.position ? { latitude: s.position.lat, longitude: s.position.lon } : {}),
            addresses: s.address
              ? [
                  {
                    address_1: s.address.line1 ?? '',
                    city: s.address.city ?? '',
                    state_province: s.address.state ?? '',
                    postal_code: s.address.postal ?? '',
                    country: 'US',
                    address_type: 'physical',
                  },
                ]
              : [],
            transportation: s.transit,
            accessibility: Object.entries(s.accessibility)
              .filter(([, v]) => v === true)
              .map(([k]) => ({ description: k })),
          })),
          service_at_location: d.sites.map((s) => ({
            id: `sal-${s.id}`,
            service_id: s.id,
            location_id: `loc-${s.id}`,
          })),
        };
      },
    );

    // --------------------------------------------------------------- widget
    app.get(
      '/help/:tenant/widget.js',
      { schema: { tags: ['public help'], params: tenantParam } },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const slug = JSON.stringify(tenant.slug);
        const strings = JSON.stringify({ en: T.en, es: T.es });
        const js = `(function(){
var s=document.currentScript;if(!s)return;
var target=document.getElementById((s.dataset&&s.dataset.target)||'cg-help');if(!target)return;
var lang=((s.dataset&&s.dataset.lang)||'en').slice(0,2);var T=${strings};var t=T[lang]||T.en;
var base=new URL(s.src).origin;
function el(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}
fetch(base+'/api/public/help/'+${slug}+'?lang='+encodeURIComponent(lang),{credentials:'omit'}).then(function(r){return r.json();}).then(function(d){
target.textContent='';var h=el('h2',t.sites);target.appendChild(h);
if(!d.sites.length){target.appendChild(el('p',t.none));}
var ul=el('ul');d.sites.forEach(function(x){var li=el('li');li.appendChild(el('strong',x.name+' ('+(t.kind[x.kind]||x.kind)+'): '));li.appendChild(el('span',t.status[x.status]||x.status));
var a=[x.address&&x.address.line1,x.address&&x.address.city,x.address&&x.address.postal].filter(Boolean).join(', ');if(a)li.appendChild(el('div',a));
if(x.nextNearest)li.appendChild(el('div',t.nextNearest+': '+x.nextNearest.name));
if(x.lastConfirmedAt)li.appendChild(el('div',t.lastConfirmed+': '+new Date(x.lastConfirmedAt).toLocaleString(),'cg-muted'));ul.appendChild(li);});target.appendChild(ul);
if(d.resources.length){target.appendChild(el('h2',t.resources));var rl=el('ul');d.resources.forEach(function(r){var li=el('li');var a=el('a',r.title);a.href=base+r.url;a.rel='noopener';li.appendChild(a);if(r.summary)li.appendChild(el('div',r.summary));rl.appendChild(li);});target.appendChild(rl);}
target.appendChild(el('p',d.notices.join(' '),'cg-muted'));
}).catch(function(){target.appendChild(el('p',t.none));});
})();`;
        return reply
          .header('content-type', 'application/javascript; charset=utf-8')
          .header('cache-control', CACHE)
          .send(js);
      },
    );

    // ---------------------------------------------------------------- media
    app.get(
      '/help/:tenant/media',
      { schema: { tags: ['public help'], params: tenantParam, querystring: langQuery } },
      async (request, reply) => {
        const lang = langOf(request.query.lang);
        const d = await gather(request, lang);
        const t = T[lang];
        const latest = d.sites.reduce<string | null>(
          (acc, s) => (acc && acc > s.updatedAt ? acc : s.updatedAt),
          null,
        );
        const rows = d.sites
          .map(
            (s) =>
              `<tr><th scope="row">${escapeHtml(s.name)}</th><td>${escapeHtml(t.kind[s.kind as keyof typeof T.en.kind] ?? s.kind)}</td><td class="status">${escapeHtml(t.status[s.status])}${s.nextNearest ? `<br><span class="muted">${escapeHtml(t.nextNearest)}: ${escapeHtml(s.nextNearest.name)}</span>` : ''}</td><td>${escapeHtml(addressText(s))}</td><td>${escapeHtml(hoursText(s.hours, lang))}</td><td>${escapeHtml(t.pets[s.pets])}</td><td>${s.lastConfirmedAt ? escapeHtml(s.lastConfirmedAt.slice(0, 16).replace('T', ' ')) + ' UTC' : ''}</td></tr>`,
          )
          .join('');
        const resources = d.resources
          .map(
            (r) =>
              `<li><a href="/api/public/help/${escapeHtml(d.tenant.slug)}/resources/${escapeHtml(r.slug)}?lang=${lang}">${escapeHtml(r.title)}</a>${r.summary ? ` — ${escapeHtml(r.summary)}` : ''} <span class="muted">(${escapeHtml(t.updated)} ${escapeHtml(r.updatedAt.slice(0, 10))})</span></li>`,
          )
          .join('');
        const body =
          `<p>${escapeHtml(t.danger)}</p>` +
          `<p class="muted">${escapeHtml(t.updated)}: ${latest ? escapeHtml(latest.slice(0, 16).replace('T', ' ')) + ' UTC' : '—'} · ${escapeHtml(t.generated)}: ${escapeHtml(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</p>` +
          `<h2>${escapeHtml(t.sites)}</h2>` +
          (d.sites.length
            ? `<table><thead><tr><th scope="col">Site</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Address</th><th scope="col">Hours</th><th scope="col">Pets</th><th scope="col">${escapeHtml(t.lastConfirmed)}</th></tr></thead><tbody>${rows}</tbody></table>`
            : `<p>${escapeHtml(t.none)}</p>`) +
          `<h2>${escapeHtml(t.resources)}</h2><ul>${resources}</ul>` +
          (d.helpPhone
            ? `<p><strong>${escapeHtml(t.support)}:</strong> ${escapeHtml(d.helpPhone)}</p>`
            : '') +
          `<p class="muted">${escapeHtml(d.statement)}</p>`;
        return html(
          reply,
          page({
            lang,
            title: `${t.media}: ${t.help}`,
            tenantName: d.tenant.name,
            body,
            refreshSeconds: 300,
          }),
        );
      },
    );
  };

export type { PublicResource, PublicSite };
export { ApiError };
