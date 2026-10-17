/**
 * Public "Find help" (PUB-01–07, PUB-10, PUB-13, PUB-16–18, NED-06, A11Y-01,
 * BRD:FR-16.02/16.04, AC-16A/B/C, SEC-09, GATE-04/06): no sign-in, every
 * channel reads the same published, non-confidential, reconfirmed records;
 * nearest first when a ZIP or point is given; a full or closed site names the
 * next nearest open one of its kind; expired resources answer 410 with the
 * date, never silently as current. Feeds (GeoJSON, Open Referral HSDS), the
 * copy-and-paste widget and the media sheet are the same data. Responses
 * carry a short public cache so a change reaches every channel inside the
 * two minutes PUB-01 allows. Pages are rendered by render.ts from plain data.
 */
import { publicHealthNotices } from './health-notices.ts';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { renderPdf } from '@cg/pdf';
import { publicBranding, publicNameIn } from '../branding.ts';
import { errors } from '../errors.ts';
import { mediaSheetPdf } from './pdf.ts';
import { sanitizeHtml } from './html.ts';
import {
  addressText,
  goneResourcePage,
  hoursText,
  langOf,
  mediaPage,
  resourcePage,
  T,
  type Lang,
} from './render.ts';
import { askIntent, matchHelp } from './ask.ts';
import { publicResources, publicSites, resolveNear, thumbnailTag } from './sites-view.ts';
import { configValue } from './submit.ts';

export { T, addressText, hoursText, langOf, type Lang } from './render.ts';
export type { PublicResource, PublicSite } from './sites-view.ts';

const tenantParam = z.object({ tenant: z.string().min(2).max(60) });
const langQuery = z.object({ lang: z.string().min(2).max(10).default('en') });

const CACHE = 'public, max-age=60, stale-while-revalidate=60';
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'";

export interface HelpDeps {
  /** The public site's base URL for links in feeds, texts and the widget (the gateway's public host). */
  publicBase?: string | undefined;
  /** Where resource thumbnails are kept (FR-16.01); absent, none is shown. */
  objects?: { client: S3Client; bucket: string } | undefined;
}

/** FR-16.01: the address of a published resource's thumbnail; the tag changes with the picture. */
export const thumbnailUrl = (tenantSlug: string, resourceSlug: string, tag: string | null) =>
  tag
    ? `/api/public/help/${encodeURIComponent(tenantSlug)}/resources/${encodeURIComponent(resourceSlug)}/thumbnail.jpg?v=${encodeURIComponent(tag)}`
    : null;

export const helpRoutes =
  (deps: HelpDeps = {}): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();

    const tenantOf = (request: FastifyRequest) => {
      const t = (
        request as FastifyRequest & {
          publicTenant?: {
            id: string;
            name: string;
            locales: string[];
            slug: string;
            branding?: unknown;
          };
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
        // FL:FR-06: boil-water and safety notices in force, the visitor's area first.
        const healthNotices = await publicHealthNotices(trx, tenant.id, lang, place);
        return { tenant, place, sites, resources, helpPhone, statement, healthNotices };
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
          tenant: {
            name: d.tenant.name,
            slug: d.tenant.slug,
            locales: d.tenant.locales,
            // ADM-01: the county's branding, its known fields only.
            branding: publicBranding(d.tenant.branding),
          },
          lang,
          generatedAt: new Date().toISOString(),
          near: d.place,
          sites: d.sites,
          resources: d.resources.map((r) => ({
            ...r,
            url: `/api/public/help/${encodeURIComponent(d.tenant.slug)}/resources/${encodeURIComponent(r.slug)}?lang=${lang}`,
            thumbnailUrl: thumbnailUrl(d.tenant.slug, r.slug, r.thumbnail),
          })),
          accessibility: { statement: d.statement, supportPhone: d.helpPhone },
          notices: [T[lang].danger],
          healthNotices: d.healthNotices,
          helpUrl: pageUrl(d.tenant.slug, lang),
        };
      },
    );

    // ------------------------------------------- ask (the public command coverage)
    /**
     * CMD-19, AC-C03, Section 30.2: published help, starting or resuming one's
     * own report, and one's own status only after proving it is theirs. The
     * question is read with fixed rules (ask.ts); the answer holds only what
     * the public pages already show, and links. Nothing is stored.
     */
    app.post(
      '/help/:tenant/ask',
      {
        schema: {
          tags: ['public help'],
          params: tenantParam,
          body: z.object({
            text: z.string().trim().min(1).max(500),
            lang: z.string().min(2).max(10).default('en'),
            near: z.string().max(120).optional(),
          }),
        },
      },
      async (request, reply) => {
        const lang = langOf(request.body.lang);
        const intent = askIntent(request.body.text);
        const d = await gather(request, lang, request.body.near);
        const event = await request.tx((trx) =>
          trx
            .selectFrom('cg.event')
            .select('intake_slug')
            .where('status', '=', 'active')
            .where('intake_slug', 'is not', null)
            .orderBy('opened_at', 'desc')
            .executeTakeFirst(),
        );
        const slug = encodeURIComponent(d.tenant.slug);
        const ev = event?.intake_slug ? encodeURIComponent(event.intake_slug) : null;
        const es = lang === 'es';
        const links = {
          report: ev ? `/${slug}/${ev}/report?lang=${lang}` : null,
          resume: ev ? `/${slug}/${ev}/resume?lang=${lang}` : null,
          myReport: `/${slug}/my-report?lang=${lang}`,
        };
        const found = intent === 'find' ? matchHelp(request.body.text, d.sites, d.resources) : null;
        const answer =
          intent === 'status'
            ? es
              ? 'Para ver su reporte, primero confirme que es suyo: le enviamos un código al teléfono o correo del reporte.'
              : 'To see your report, first confirm it is yours: we send a code to the phone or email on the report.'
            : intent === 'resume'
              ? es
                ? 'Puede seguir un reporte guardado con el código que le dimos.'
                : 'You can pick up a saved report with the code you were given.'
              : intent === 'report'
                ? es
                  ? 'Puede reportar daños o necesidades aquí. Toma unos minutos; puede guardarlo y seguir después.'
                  : 'You can report damage or needs here. It takes a few minutes; you can save it and finish later.'
                : found && (found.sites.length > 0 || found.resources.length > 0)
                  ? es
                    ? 'Esto es lo que encontramos en la ayuda publicada.'
                    : 'Here is what we found in the published help.'
                  : es
                    ? 'No encontramos eso. Puede ver toda la ayuda publicada, reportar daños o necesidades, o seguir su reporte.'
                    : 'We did not find that. You can see all the published help, report damage or needs, or follow your report.';
        reply.header('cache-control', 'no-store');
        return {
          intent,
          answer,
          links: {
            ...(intent === 'status' ? { myReport: links.myReport } : {}),
            ...(intent === 'resume' && links.resume ? { resume: links.resume } : {}),
            ...(intent === 'report' && links.report ? { report: links.report } : {}),
            help: pageUrl(d.tenant.slug, lang) ?? `/${slug}/help?lang=${lang}`,
          },
          sites: found?.sites ?? [],
          resources: (found?.resources ?? []).map((r) => ({
            slug: r.slug,
            title: r.title,
            summary: r.summary,
            url: `/api/public/help/${slug}/resources/${encodeURIComponent(r.slug)}?lang=${lang}`,
          })),
          notices: [T[lang].danger],
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
          return { resource, texts };
        });
        if (!found || found.resource.published_at === null) throw errors.notFound();
        const text =
          found.texts.find((t) => t.locale === lang) ??
          found.texts.find((t) => t.locale === 'en') ??
          found.texts[0];
        if (!text) throw errors.notFound();
        const r = found.resource;
        // Expired by its date, or marked expired by the worker once the date passed (AC-16B).
        const expiredAt =
          r.status === 'expired' || (r.expires_at && new Date(r.expires_at) <= new Date())
            ? (r.expires_at ?? r.updated_at)
            : null;
        const removedAt =
          r.status === 'removed' || r.unpublished_at ? (r.unpublished_at ?? r.updated_at) : null;
        const common = {
          lang,
          tenantName: publicNameIn(tenant.branding, lang) ?? tenant.name,
          tenantSlug: tenant.slug,
          title: text.title,
        };
        if (expiredAt || removedAt)
          return html(
            reply,
            goneResourcePage({
              ...common,
              kind: expiredAt ? 'expired' : 'removed',
              when: new Date(expiredAt ?? removedAt!).toISOString().slice(0, 10),
            }),
            410,
          );
        return html(
          reply,
          resourcePage({
            ...common,
            summary: text.summary,
            safeBodyHtml: sanitizeHtml(text.body_html),
            referenceUrl: r.reference_url,
            updatedAt: new Date(r.updated_at).toISOString(),
            thumbnailUrl: thumbnailUrl(
              tenant.slug,
              r.slug,
              thumbnailTag(r.published_thumbnail_key),
            ),
          }),
        );
      },
    );

    // FR-16.01, FR-16.02: a resource's thumbnail, only while the resource is published and current.
    app.get(
      '/help/:tenant/resources/:slug/thumbnail.jpg',
      {
        schema: {
          tags: ['public help'],
          params: tenantParam.extend({ slug: z.string().min(1).max(80) }),
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        await request.authorize('help.read', {
          type: 'help',
          tenantId: tenant.id,
          published: true,
        });
        const r = await request.tx((trx) =>
          trx
            .selectFrom('cg.resource')
            .select([
              'published_thumbnail_key',
              'status',
              'published_at',
              'unpublished_at',
              'expires_at',
            ])
            .where('slug', '=', request.params.slug)
            .executeTakeFirst(),
        );
        const current =
          r &&
          r.status === 'published' &&
          r.published_at !== null &&
          r.unpublished_at === null &&
          (!r.expires_at || new Date(r.expires_at) > new Date());
        if (!current || !r.published_thumbnail_key || !deps.objects) throw errors.notFound();
        const obj = await deps.objects.client
          .send(
            new GetObjectCommand({ Bucket: deps.objects.bucket, Key: r.published_thumbnail_key }),
          )
          .catch(() => null);
        if (!obj?.Body) throw errors.notFound();
        return reply
          .header('content-type', 'image/jpeg')
          .header('cache-control', 'public, max-age=300')
          .header('x-content-type-options', 'nosniff')
          .send(Buffer.from(await obj.Body.transformToByteArray()));
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
              description: `${T[lang].kind[s.kind] ?? s.kind}; ${T[lang].status[s.status]}`,
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
        // The slug and the strings are JSON literals inside the script; nothing else of the request.
        const slug = JSON.stringify(tenant.slug);
        const strings = JSON.stringify({ en: T.en, es: T.es });
        const js = [
          '(function(){',
          'var s=document.currentScript;if(!s)return;',
          "var target=document.getElementById((s.dataset&&s.dataset.target)||'cg-help');if(!target)return;",
          `var lang=((s.dataset&&s.dataset.lang)||'en').slice(0,2);var T=${strings};var t=T[lang]||T.en;`,
          'var base=new URL(s.src).origin;',
          'function el(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}',
          `fetch(base+'/api/public/help/'+encodeURIComponent(${slug})+'?lang='+encodeURIComponent(lang),{credentials:'omit'}).then(function(r){return r.json();}).then(function(d){`,
          "target.textContent='';target.appendChild(el('h2',t.sites));",
          "if(!d.sites.length){target.appendChild(el('p',t.none));}",
          "var ul=el('ul');d.sites.forEach(function(x){var li=el('li');li.appendChild(el('strong',x.name+' ('+(t.kind[x.kind]||x.kind)+'): '));li.appendChild(el('span',t.status[x.status]||x.status));",
          "var a=[x.address&&x.address.line1,x.address&&x.address.city,x.address&&x.address.postal].filter(Boolean).join(', ');if(a)li.appendChild(el('div',a));",
          "if(x.nextNearest)li.appendChild(el('div',t.nextNearest+': '+x.nextNearest.name));",
          "if(x.lastConfirmedAt)li.appendChild(el('div',t.lastConfirmed+': '+new Date(x.lastConfirmedAt).toLocaleString(),'cg-muted'));ul.appendChild(li);});target.appendChild(ul);",
          "if(d.resources.length){target.appendChild(el('h2',t.resources));var rl=el('ul');d.resources.forEach(function(r){var li=el('li');var a=el('a',r.title);a.href=base+r.url;a.rel='noopener';li.appendChild(a);if(r.summary)li.appendChild(el('div',r.summary));rl.appendChild(li);});target.appendChild(rl);}",
          "target.appendChild(el('p',d.notices.join(' '),'cg-muted'));",
          "}).catch(function(){target.appendChild(el('p',t.none));});",
          '})();',
        ].join('\n');
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
        return html(
          reply,
          mediaPage({
            lang,
            tenantName: publicNameIn(d.tenant.branding, lang) ?? d.tenant.name,
            tenantSlug: d.tenant.slug,
            sites: d.sites,
            resources: d.resources,
            helpPhone: d.helpPhone,
            statement: d.statement,
            generatedAt: new Date().toISOString(),
          }),
        );
      },
    );

    // PUB-13: the same sheet as a PDF (PDF/UA), made on request so it is as current as the page.
    app.get(
      '/help/:tenant/media.pdf',
      { schema: { tags: ['public help'], params: tenantParam, querystring: langQuery } },
      async (request, reply) => {
        const lang = langOf(request.query.lang);
        const d = await gather(request, lang);
        const zone = await request.tx((trx) =>
          trx
            .selectFrom('cg.tenant')
            .select('timezone')
            .where('id', '=', d.tenant.id)
            .executeTakeFirst(),
        );
        const pdf = await renderPdf(
          mediaSheetPdf({
            lang,
            tenantName: publicNameIn(d.tenant.branding, lang) ?? d.tenant.name,
            tenantSlug: d.tenant.slug,
            sites: d.sites,
            resources: d.resources,
            helpPhone: d.helpPhone,
            statement: d.statement,
            generatedAt: new Date().toISOString(),
            timeZone: zone?.timezone ?? 'UTC',
            publicBase: deps.publicBase ?? `${request.protocol}://${request.host}`,
            producer: d.tenant.name,
          }),
        );
        return reply
          .header('content-type', 'application/pdf')
          .header(
            'content-disposition',
            `inline; filename="media-sheet-${d.tenant.slug}-${lang}.pdf"`,
          )
          .header('cache-control', CACHE)
          .header('x-content-type-options', 'nosniff')
          .send(pdf);
      },
    );
  };
