/**
 * Public information against a real PostgreSQL (PUB-01–07, PUB-10, PUB-11,
 * PUB-13, PUB-16–18, NED-06, CON-09, BRD:FR-16/17, CNT-01, AC-16A/B/C,
 * SEC-18, GATE-04/06): the public help endpoint lists only published,
 * non-confidential, reconfirmed sites, nearest first by ZIP or point, with the
 * next nearest open site for a full or closed one; expired resources answer
 * 410 with the date; feeds, widget and media sheet come from the same data;
 * staff create, update (with versions), confirm, publish (named approver and
 * reason, logged), close and unpublish sites; a stale site disappears from
 * every channel until confirmed; a confidential site is never published;
 * alert drafts fit WEA sizes; resources publish only when human-reviewed and
 * accessible; the contact registry is encrypted and masked by role. Runs only
 * with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import type { Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routes } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Site {
  id: string;
  slug: string;
  kind: string;
  name: string;
  status: string;
  distanceKm: number | null;
  nextNearest: { slug: string; name: string } | null;
  lastConfirmedAt: string | null;
}
interface Help {
  sites: Site[];
  resources: { slug: string; title: string; lang: string; url: string }[];
  near: { resolved: boolean; how: string; label: string | null } | null;
  accessibility: { statement: string; supportPhone: string | null };
}
interface StaffSite {
  id: string;
  version: number;
  status: string;
  published: boolean;
  stale: boolean;
  confirmDueAt: string | null;
  slug: string;
}
interface Resource {
  id: string;
  version: number;
  status: string;
  published: boolean;
  linkStatus: string;
  texts: { locale: string; reviewedAt: string | null; problems: string[] }[];
}
interface Contact {
  id: string;
  version: number;
  name: string | null;
  methods: { phone?: string } | null;
  verifyBy: string | null;
  due: boolean;
}

describe.skipIf(!appUrl || !workerUrl)('public information (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let tenants: Record<string, string>;
  let subjects: Record<string, AccountSubject>;
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const run = Date.now().toString().slice(-7);
  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${who}`,
    ...extra,
  });
  const confirmed = (reason: string) => ({ 'x-confirm': 'true', 'x-reason': reason });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    tenants = seeded.tenants;
    // Sites left by earlier local runs would change "nearest" and "next nearest"; take them off the public channels.
    await dbWorker
      .updateTable('cg.site')
      .set({ unpublished_at: new Date() })
      .where('tenant_id', '=', tenants['county']!)
      .where('slug', 'like', 'test-%')
      .where('unpublished_at', 'is', null)
      .execute();
    await dbWorker
      .updateTable('cg.resource')
      .set({ status: 'removed', unpublished_at: new Date() })
      .where('tenant_id', '=', tenants['county']!)
      .where('slug', 'like', 'test-%')
      .where('unpublished_at', 'is', null)
      .execute();
    const paths = Object.fromEntries(
      (
        await dbWorker
          .selectFrom('cg.tenant')
          .select(['id', 'path'])
          .where('id', 'in', Object.values(tenants))
          .execute()
      ).map((t) => [t.id, t.path]),
    );
    const subjectFor = (
      tenantKey: string,
      templateKey: string,
      accountId: string,
    ): AccountSubject => {
      const t = roleTemplates.find((r) => r.key === templateKey)!;
      const tenantId = tenants[tenantKey]!;
      return {
        kind: 'account',
        accountId,
        tenantId,
        tenantPath: paths[tenantId]!,
        status: 'active',
        roles: [
          {
            roleId: randomUUID(),
            key: t.key,
            version: 1,
            templateKey: t.key,
            grants: t.grants,
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects = {
      tomas: subjectFor(
        'county',
        'public_information_officer',
        seeded.accounts['tomas.pio@example.org']!,
      ),
      luis: subjectFor(
        'county',
        'mass_care_coordinator',
        seeded.accounts['luis.masscare@example.org']!,
      ),
      coordinator: subjectFor('county', 'partner_coordinator', randomUUID()),
      jen: subjectFor('coad', 'coad_chair', seeded.accounts['jen.coad@example.org']!),
    };
    const loader: SubjectLoader = {
      async fromBearer(token) {
        const s = subjects[token];
        if (!s) throw new AuthError('invalid_token');
        return s;
      },
    };
    const resolver = new TenantResolver(dbApp);
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: crypto,
      subjects: loader,
      routes,
      publicRoutes: [
        publicRoutes({
          resolver,
          codes: new ReferenceCodeLeaser(dbApp, 'test'),
          risk: new RiskScorer(),
          getQueue: () => undefined,
          residentTokenSecret: 'test-secret-'.repeat(4),
          defaultGraph: westwindGraph,
          ai: { providerFor: async () => fakeProvider },
          publicBase: 'https://localhost',
        }),
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const help = async (query = '') => {
    const res = await app.inject({ url: `/api/public/help/county${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Help;
  };

  it('lists published, non-confidential sites and current resources; nearest first by ZIP or point; the next nearest open site for a closed one (PUB-02/04/05, NED-06)', async () => {
    const d = await help('?lang=en');
    const slugs = d.sites.map((s) => s.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        'harmon-high-gym',
        'nueva-esperanza-hall',
        'westwind-community-center',
      ]),
    );
    expect(slugs).not.toContain('safe-harbor'); // confidential, never published
    expect(slugs).not.toContain('fairgrounds-pod'); // planned, not published
    const cooling = d.sites.find((s) => s.slug === 'westwind-community-center')!;
    expect(cooling.status).toBe('closed');
    expect(cooling.nextNearest).toBeNull(); // no other cooling center is open
    expect(d.sites.every((s) => s.lastConfirmedAt)).toBe(true);
    expect(d.resources.map((r) => r.slug)).toEqual(
      expect.arrayContaining([
        'county-help-line',
        'fema-registration',
        'debris-pickup',
        'legal-help',
      ]),
    );
    expect(d.resources.map((r) => r.slug)).not.toContain('boil-water-notice'); // expired
    expect(d.accessibility.supportPhone).toBe('(314) 555-0142');
    expect(d.accessibility.statement).toContain('WCAG');

    const byZip = await help('?near=63005');
    expect(byZip.near).toMatchObject({ resolved: true, how: 'zip', label: 'Harmon City (63005)' });
    expect(byZip.sites[0]!.slug).toBe('harmon-high-gym');
    expect(byZip.sites[0]!.distanceKm).toBe(0);
    const byPoint = await help('?near=38.801,-90.873');
    expect(byPoint.sites[0]!.slug).toBe('nueva-esperanza-hall');
    const unknown = await help('?near=somewhere%20nice');
    expect(unknown.near).toMatchObject({ resolved: false, how: 'none' });
    expect(unknown.sites.every((s) => s.distanceKm === null)).toBe(true);
    const feeding = await help('?kind=feeding');
    expect(feeding.sites.map((s) => s.kind)).toEqual(['feeding']);
    const es = await help('?lang=es');
    expect(es.resources.find((r) => r.slug === 'county-help-line')!.title).toBe(
      'Línea de ayuda del condado',
    );
  });

  it('CMD-19, AC-C03: the public ask box finds published help, points to the form, resume and verified status pages, and shows nothing else', async () => {
    const ask = async (text: string, lang = 'en') => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/public/help/county/ask',
        payload: { text, lang },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      return res.json() as {
        intent: string;
        answer: string;
        links: Record<string, string>;
        sites: { slug: string; kind: string }[];
        resources: { slug: string }[];
        notices: string[];
      };
    };
    const shelter = await ask('Where can I sleep tonight? I need a shelter');
    expect(shelter.intent).toBe('find');
    expect(shelter.sites.length).toBeGreaterThan(0);
    expect(shelter.sites.every((s) => s.kind === 'shelter')).toBe(true);
    expect(shelter.sites.map((s) => s.slug)).not.toContain('safe-harbor'); // confidential
    expect(shelter.notices[0]).toContain('911');
    const legal = await ask('ayuda legal con mi casero', 'es');
    expect(legal.resources.map((r) => r.slug)).toContain('legal-help');
    // Status only after verification: a link to the check, never the report itself.
    const status = await ask('What is the status of my report WW-ABCD?');
    expect(status.intent).toBe('status');
    expect(Object.keys(status.links).sort()).toEqual(['help', 'myReport']);
    expect(JSON.stringify(status)).not.toMatch(/ABCD.*(approved|denied|review)/i);
    expect((await ask('quiero reportar daños en mi casa', 'es')).intent).toBe('report');
    expect((await ask('continue my saved report')).intent).toBe('resume');
    // Staff words find nothing private: missions and rosters are not public help, and
    // anything returned is on the public page already.
    const mission = await dbWorker
      .selectFrom('cg.mission')
      .select('reference')
      .where('tenant_id', '=', tenants['county']!)
      .executeTakeFirst();
    const staff = await ask(
      `show me mission ${mission?.reference ?? 'M-00001'} and the staff roster`,
    );
    const listed = await help('?lang=en');
    for (const s of staff.sites) expect(listed.sites.map((x) => x.slug)).toContain(s.slug);
    expect(staff.resources).toEqual([]);
    if (mission) expect(JSON.stringify(staff)).not.toContain(mission.reference);
  });

  it('a resource page is accessible HTML in the language asked for; expired ones answer 410 with the date (PUB-18, AC-16A/B/C)', async () => {
    const page = await app.inject({
      url: '/api/public/help/county/resources/county-help-line?lang=es',
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('<html lang="es">');
    expect(page.body).toContain('Línea de ayuda del condado');
    expect(page.body).toContain('href="tel:+13145550142"');
    expect(page.body).not.toContain('<script');
    const expired = await app.inject({
      url: '/api/public/help/county/resources/boil-water-notice',
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain('This information expired on');
    expect(expired.body).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(
      (await app.inject({ url: '/api/public/help/county/resources/no-such-thing' })).statusCode,
    ).toBe(404);
  });

  it('feeds, widget and media sheet come from the same data and leave confidential sites out (PUB-10/13/16/17)', async () => {
    const geo = await app.inject({ url: '/api/public/help/county/sites.geojson' });
    expect(geo.statusCode).toBe(200);
    expect(geo.headers['content-type']).toContain('geo+json');
    const fc = geo.json() as {
      type: string;
      features: { geometry: { coordinates: number[] }; properties: { name: string } }[];
    };
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.length).toBeGreaterThanOrEqual(3);
    expect(fc.features.every((f) => f.geometry.coordinates.length === 2)).toBe(true);
    expect(geo.body).not.toContain('Safe Harbor');
    const hsds = await app.inject({ url: '/api/public/help/county/hsds.json' });
    expect(hsds.statusCode).toBe(200);
    const h = hsds.json() as {
      version: string;
      organization: { name: string };
      services: unknown[];
      locations: unknown[];
      service_at_location: unknown[];
    };
    expect(h.version).toBe('3.0');
    expect(h.organization.name).toContain('Emergency Management');
    expect(h.services.length).toBeGreaterThanOrEqual(7);
    expect(h.locations.length).toBe(h.service_at_location.length);
    const widget = await app.inject({ url: '/api/public/help/county/widget.js' });
    expect(widget.statusCode).toBe(200);
    expect(widget.headers['content-type']).toContain('javascript');
    expect(widget.body).toContain('/api/public/help/');
    expect(widget.body).toContain('"county"');
    const media = await app.inject({ url: '/api/public/help/county/media?lang=en' });
    expect(media.statusCode).toBe(200);
    expect(media.body).toContain('Media sheet');
    expect(media.body).toContain('Last updated');
    expect(media.body).toContain('Harmon High School gym');
    // No timed refresh: it would move the reader's place (WCAG 2.2.1/3.2.5); the sheet says to reload.
    expect(media.body).not.toContain('http-equiv');
    expect(media.body).toContain('Reload this page');
    expect(media.body).not.toContain('Safe Harbor');
  });

  let siteId: string;
  let siteVersion: number;
  let secondId: string;

  it('staff open a site, update it with a version, publish it with a named approver and a reason, and every channel shows it (CON-09, PUB-01/06)', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: headers('jen'),
      payload: { kind: 'warming', name: 'x' },
    });
    expect(refused.statusCode).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: headers('tomas'),
      payload: {
        kind: 'warming',
        name: `Westwind Library warming center ${run}`,
        slug: `test-library-${run}`,
        status: 'open',
        address: { line1: '5 Civic Plaza', city: 'Westwind', postal: '63003' },
        position: { lat: 38.798, lon: -90.861 },
        hours: { daily: '08:00–20:00' },
        services: ['warmth', 'charging'],
        pets: 'service_animals',
        accessibility: { ada: true, wheelchair: true },
        languages: ['en', 'es'],
        confirmEveryHours: 6,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const site = created.json() as StaffSite;
    siteId = site.id;
    expect(site.published).toBe(false);
    expect((await help()).sites.map((s) => s.slug)).not.toContain(site.slug);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${siteId}`,
      headers: headers('tomas', { 'if-match': '99' }),
      payload: { capacity: 80 },
    });
    expect(stale.statusCode).toBe(409);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${siteId}`,
      headers: headers('tomas', { 'if-match': String(site.version) }),
      payload: { capacity: 80 },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    siteVersion = (patched.json() as StaffSite).version;
    expect(siteVersion).toBe(site.version + 1);

    const unconfirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/publish`,
      headers: headers('tomas'),
    });
    expect(unconfirmed.statusCode).toBe(428);
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/publish`,
      headers: headers('tomas', confirmed('Opened by the EOC at 09:00')),
    });
    expect(published.statusCode, published.body).toBe(200);
    expect((published.json() as StaffSite).published).toBe(true);
    const log = await app.inject({
      url: `/api/v1/publications?subjectKind=site&subjectId=${siteId}`,
      headers: headers('luis'),
    });
    expect(log.statusCode, log.body).toBe(200);
    const entries = log.json() as {
      approvedBy: string;
      reason: string;
      snapshot: { slug: string };
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.approvedBy).toBe(subjects['tomas']!.accountId);
    expect(entries[0]!.reason).toBe('Opened by the EOC at 09:00');
    expect(entries[0]!.snapshot.slug).toBe(site.slug);
    const now = await help('?near=63003');
    expect(now.sites.find((s) => s.slug === site.slug)?.status).toBe('open');
  });

  it('full or closed points to the next nearest open site of the kind; a stale site hides until confirmed; unpublish removes it (PUB-03/04)', async () => {
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: headers('tomas'),
      payload: {
        kind: 'warming',
        name: `Oak Hollow church warming center ${run}`,
        slug: `test-oak-hollow-${run}`,
        status: 'open',
        address: { line1: '9 Oak Hollow Rd', city: 'Westwind', postal: '63004' },
        position: { lat: 38.805, lon: -90.815 },
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    secondId = (second.json() as StaffSite).id;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/sites/${secondId}/publish`,
          headers: headers('tomas', confirmed('Second warming center')),
        })
      ).statusCode,
    ).toBe(200);

    const full = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/confirm`,
      headers: headers('luis'),
      payload: { status: 'full', occupancy: 80, note: 'Lead called in' },
    });
    expect(full.statusCode, full.body).toBe(200);
    let view = (await help()).sites.find((s) => s.id === siteId)!;
    expect(view.status).toBe('full');
    expect(view.nextNearest?.slug).toBe(`test-oak-hollow-${run}`);

    // PUB-03: past the reconfirmation window → hidden on every channel, flagged for staff.
    await dbWorker
      .updateTable('cg.site')
      .set({ last_confirmed_at: new Date(Date.now() - 7 * 3_600_000) })
      .where('id', '=', siteId)
      .execute();
    expect((await help()).sites.find((s) => s.id === siteId)).toBeUndefined();
    expect((await app.inject({ url: '/api/public/help/county/sites.geojson' })).body).not.toContain(
      `test-library-${run}`,
    );
    const staleList = await app.inject({
      url: '/api/v1/sites?stale=true',
      headers: headers('luis'),
    });
    expect((staleList.json() as StaffSite[]).some((s) => s.id === siteId && s.stale)).toBe(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/sites/${siteId}/confirm`,
          headers: headers('luis'),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    view = (await help()).sites.find((s) => s.id === siteId)!;
    expect(view.status).toBe('full');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/close`,
      headers: headers('tomas'),
      payload: { note: 'Power restored in the area' },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    view = (await help()).sites.find((s) => s.id === siteId)!;
    expect(view.status).toBe('closed');
    expect(view.nextNearest?.slug).toBe(`test-oak-hollow-${run}`);

    const gone = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/unpublish`,
      headers: headers('tomas', confirmed('Closed for the season')),
    });
    expect(gone.statusCode, gone.body).toBe(200);
    expect((await help()).sites.find((s) => s.id === siteId)).toBeUndefined();
    const log = (
      await app.inject({
        url: `/api/v1/publications?subjectId=${siteId}`,
        headers: headers('luis'),
      })
    ).json() as { unpublishedAt: string | null }[];
    expect(log.every((p) => p.unpublishedAt !== null)).toBe(true);
  });

  it('a confidential site is never published; alert drafts fit WEA sizes and are logged (PUB-05, PUB-11)', async () => {
    const secret = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: headers('tomas'),
      payload: {
        kind: 'shelter',
        name: `Quiet house ${run}`,
        slug: `test-quiet-${run}`,
        status: 'open',
        confidential: true,
      },
    });
    expect(secret.statusCode).toBe(201);
    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${(secret.json() as StaffSite).id}/publish`,
      headers: headers('tomas', confirmed('try it')),
    });
    expect(publish.statusCode).toBe(400);
    const draft = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts/draft',
      headers: headers('tomas'),
      payload: { siteId: secondId, change: 'opened' },
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const d = draft.json() as {
      drafts: { lang: string; wea90: string; wea360: string; massNotification: string }[];
      publicationId: string;
    };
    expect(d.drafts.map((x) => x.lang)).toEqual(['en', 'es']);
    expect(d.drafts[0]!.wea90.length).toBeLessThanOrEqual(90);
    expect(d.drafts[0]!.wea360).toContain('Oak Hollow church warming center');
    expect(d.drafts[0]!.massNotification).toContain('911');
    const log = (
      await app.inject({
        url: `/api/v1/publications?subjectKind=alert_draft&subjectId=${secondId}`,
        headers: headers('luis'),
      })
    ).json() as { id: string }[];
    expect(log.some((p) => p.id === d.publicationId)).toBe(true);
  });

  it('resources publish only when every text is human-reviewed and the HTML is accessible; the link check records a broken link; unpublished and expired answer 410 (PUB-06/18, AC-16B)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/resources',
      headers: headers('tomas'),
      payload: {
        slug: `test-tarps-${run}`,
        type: 'program',
        category: 'cleanup',
        referenceUrl: 'https://127.0.0.1:9/dead-link',
        texts: {
          en: {
            title: `Free tarp program ${run}`,
            summary: 'Tarps for damaged roofs.',
            bodyHtml:
              '<p>Call <a href="tel:+13145550142">the county help line</a> to ask for a tarp.</p>',
            humanReviewed: true,
          },
          es: {
            title: `Programa de lonas gratis ${run}`,
            summary: 'Lonas para techos dañados.',
            bodyHtml:
              '<p>Llame a <a href="tel:+13145550142">la línea de ayuda</a> para pedir una lona.</p>',
            humanReviewed: false,
          },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    let r = created.json() as Resource;
    expect(r.status).toBe('draft');
    const notReviewed = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${r.id}/publish`,
      headers: headers('tomas', confirmed('go ahead')),
    });
    expect(notReviewed.statusCode).toBe(400);
    expect(notReviewed.body).toContain('not human-reviewed');
    const reviewed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${r.id}`,
      headers: headers('tomas', { 'if-match': String(r.version) }),
      payload: {
        texts: {
          es: {
            title: `Programa de lonas gratis ${run}`,
            summary: 'Lonas para techos dañados.',
            bodyHtml:
              '<p>Llame a <a href="tel:+13145550142">la línea de ayuda</a> para pedir una lona.</p>',
            humanReviewed: true,
          },
        },
      },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    r = reviewed.json() as Resource;
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${r.id}`,
      headers: headers('tomas', { 'if-match': String(r.version) }),
      payload: {
        texts: {
          en: {
            title: `Free tarp program ${run}`,
            bodyHtml: '<p><a href="https://x.example/guide.pdf">click here</a></p>',
            humanReviewed: true,
          },
        },
      },
    });
    expect(bad.statusCode, bad.body).toBe(200);
    r = bad.json() as Resource;
    expect(r.texts.find((t) => t.locale === 'en')!.problems.length).toBeGreaterThan(0);
    const inaccessible = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${r.id}/publish`,
      headers: headers('tomas', confirmed('go ahead')),
    });
    expect(inaccessible.statusCode).toBe(400);
    expect(inaccessible.body).toContain('click here');
    const fixed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${r.id}`,
      headers: headers('tomas', { 'if-match': String(r.version) }),
      payload: {
        texts: {
          en: {
            title: `Free tarp program ${run}`,
            summary: 'Tarps for damaged roofs.',
            bodyHtml:
              '<p>Call <a href="tel:+13145550142">the county help line</a> to ask for a tarp.</p>',
            humanReviewed: true,
          },
        },
      },
    });
    r = fixed.json() as Resource;
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${r.id}/publish`,
      headers: headers('tomas', confirmed('Approved by the PIO')),
    });
    expect(published.statusCode, published.body).toBe(200);
    expect((published.json() as Resource).published).toBe(true);
    const listed = await help('?lang=es');
    expect(listed.resources.find((x) => x.slug === `test-tarps-${run}`)?.title).toBe(
      `Programa de lonas gratis ${run}`,
    );
    const page = await app.inject({ url: `/api/public/help/county/resources/test-tarps-${run}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('the county help line');

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${r.id}/check-link`,
      headers: headers('tomas'),
    });
    expect(link.statusCode, link.body).toBe(200);
    expect((link.json() as Resource).linkStatus).toBe('broken');
    // OWASP SSRF (ADR-0042): a link into the stack's own network is never fetched, so
    // "check link" cannot tell staff whether something answers there.
    const inside: string[] = [];
    const listener = createServer((req, res) => {
      inside.push(req.url ?? '');
      res.writeHead(200).end();
    });
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
    try {
      const port = (listener.address() as AddressInfo).port;
      await dbWorker
        .updateTable('cg.resource')
        .set({ reference_url: `http://127.0.0.1:${port}/v1/sys/health` })
        .where('id', '=', r.id)
        .execute();
      const probed = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${r.id}/check-link`,
        headers: headers('tomas'),
      });
      expect(probed.statusCode, probed.body).toBe(200);
      expect((probed.json() as Resource).linkStatus).toBe('broken');
      expect(inside).toEqual([]);
    } finally {
      await new Promise<void>((done) => listener.close(() => done()));
    }

    const removed = await app.inject({
      method: 'POST',
      url: `/api/v1/resources/${r.id}/unpublish`,
      headers: headers('tomas', confirmed('Program ended')),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const after = await app.inject({ url: `/api/public/help/county/resources/test-tarps-${run}` });
    expect(after.statusCode).toBe(410);
    expect(after.body).toContain('withdrawn on');
    expect((await help()).resources.find((x) => x.slug === `test-tarps-${run}`)).toBeUndefined();
  });

  it('the contact registry is encrypted at rest, masked by role, audited on read and re-verified on a date (CNT-01, F17, SEC-18)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: headers('coordinator'),
      payload: {
        agency: 'Hope Canteen Services',
        name: `Ruth Adeyemi ${run}`,
        role: 'Operations lead',
        methods: { phone: '+13145550199', email: 'ruth.canteen@example.org' },
        type: 'twenty_four_hour',
        orgTenantId: tenants['canteen'],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json() as Contact;
    expect(c.name).toBe(`Ruth Adeyemi ${run}`);
    expect(c.due).toBe(false);
    const raw = await dbWorker
      .selectFrom('cg.partner_contact')
      .select(['name_enc', 'methods_enc'])
      .where('id', '=', c.id)
      .executeTakeFirstOrThrow();
    expect(raw.name_enc.toString('utf8')).not.toContain('Ruth');
    expect(raw.methods_enc.toString('utf8')).not.toContain('5550199');
    const masked = await app.inject({ url: `/api/v1/contacts/${c.id}`, headers: headers('tomas') });
    expect(masked.statusCode, masked.body).toBe(200);
    expect((masked.json() as Contact).name).toBeNull();
    expect((masked.json() as Contact).methods).toBeNull();
    const shown = await app.inject({ url: `/api/v1/contacts/${c.id}`, headers: headers('luis') });
    expect((shown.json() as Contact).methods?.phone).toBe('+13145550199');
    const audit = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['classification_read'])
      .where('action', '=', 'contact.read')
      .where('target_id', '=', c.id)
      .where('actor_account_id', '=', subjects['luis']!.accountId)
      .executeTakeFirstOrThrow();
    expect(audit.classification_read).toEqual(['contact']);
    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/contacts/${c.id}/verify`,
      headers: headers('coordinator'),
      payload: { days: 90 },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const expected = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    expect((verified.json() as Contact).verifyBy).toBe(expected);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${c.id}`,
      headers: headers('coordinator', { 'if-match': String((verified.json() as Contact).version) }),
      payload: { active: false },
    });
    expect(patched.statusCode, patched.body).toBe(200);
  });
});
