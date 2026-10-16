/**
 * CON-02: event templates by hazard. The shipped four (tornado, flood, winter
 * storm, wildfire) are added once on request and are the county's to change,
 * with keywords checked as docs/06 keywords. An event made from a template
 * takes its hazard; opening it with only an intake link takes the template's
 * keywords and drafts its public safety messages into Resources, in English
 * and Spanish, for the public information officer to publish (nothing is
 * published). The event names the map layers its template switches on. From
 * a new event to a published intake is timed under five minutes. An event
 * with no template still needs its keywords. Roles without event rights are
 * refused. Runs on a county of its own, only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Template {
  id: string;
  version: number;
  hazardType: string;
  name: string;
  config: { keywords: string[]; mapLayers: string[]; messages: { key: string }[] } | null;
}
interface Event {
  id: string;
  version: number;
  hazardType: string;
  templateId: string | null;
  status: string;
  intakeKeywords: string[];
  draftedMessages?: number;
}

describe.skipIf(!appUrl || !workerUrl)('event templates (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...extra },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
  };
  const confirmed = (version: number) => ({
    'if-match': `"${version}"`,
    'x-confirm': 'true',
    'x-reason': 'Exercise: flood event',
  });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-templates-${run}`,
        name: `Exercise templates county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const as = (template: string): AccountSubject => {
      const t = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId: randomUUID(),
        tenantId: county,
        tenantPath: c.path,
        tenantKind: c.kind,
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
    subjects['director'] = as('county_em_director');
    subjects['volunteer'] = as('field_volunteer');
    const loader: SubjectLoader = {
      async fromBearer(t) {
        const s = subjects[t];
        if (!s) throw new AuthError('invalid_token');
        return s;
      },
    };
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      subjects: loader,
      routes: routesWith(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', county)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  let flood: Template;

  it('CON-02: the shipped four are added once and are the county’s to change; keywords stay docs/06 words', async () => {
    expect((await call('director', 'GET', '/event-templates')).json()).toEqual([]);
    expect((await call('volunteer', 'POST', '/event-templates/defaults')).status).toBe(403);
    const added = await call('director', 'POST', '/event-templates/defaults');
    expect(added.status, added.body).toBe(200);
    const templates = added.json<Template[]>();
    expect(templates.map((t) => t.hazardType).sort()).toEqual([
      'flood',
      'tornado',
      'wildfire',
      'winter_storm',
    ]);
    expect(
      (await call('director', 'POST', '/event-templates/defaults')).json<Template[]>(),
    ).toHaveLength(4);
    flood = templates.find((t) => t.hazardType === 'flood')!;
    expect(flood.config).toMatchObject({
      keywords: ['DAMAGE', 'DAÑOS', 'DANOS'],
      mapLayers: expect.arrayContaining(['roadClosures', 'outages']),
    });
    expect(flood.config!.messages).toHaveLength(2);
    const bad = await call(
      'director',
      'PUT',
      `/event-templates/${flood.id}`,
      { config: { ...flood.config, keywords: ['flood water'] } },
      { 'if-match': `"${flood.version}"` },
    );
    expect(bad.status).toBe(400);
    const changed = await call(
      'director',
      'PUT',
      `/event-templates/${flood.id}`,
      { config: { ...flood.config, keywords: ['DAMAGE', 'DAÑOS'] } },
      { 'if-match': `"${flood.version}"` },
    );
    expect(changed.status, changed.body).toBe(200);
    flood = changed.json<Template>();
    expect(flood.config!.keywords).toEqual(['DAMAGE', 'DAÑOS']);
  });

  it('CON-02: an event from the flood template opens with only its link: keywords preset, map layers named, messages drafted for review; under five minutes', async () => {
    const started = Date.now();
    const created = await call('director', 'POST', '/events', {
      name: `Exercise river flood ${run}`,
      templateId: flood.id,
    });
    expect(created.status, created.body).toBe(201);
    const event = created.json<Event>();
    expect(event).toMatchObject({ hazardType: 'flood', templateId: flood.id, status: 'draft' });
    const layers = await call('director', 'GET', `/events/${event.id}/template`);
    expect(layers.json()).toMatchObject({
      name: 'Flood',
      keywords: ['DAMAGE', 'DAÑOS'],
      mapLayers: flood.config!.mapLayers,
    });
    const slug = `flood-${run}`;
    const opened = await call(
      'director',
      'POST',
      `/events/${event.id}/open`,
      { intakeSlug: slug },
      confirmed(event.version),
    );
    expect(opened.status, opened.body).toBe(200);
    expect(opened.json<Event>()).toMatchObject({
      status: 'active',
      intakeKeywords: ['DAMAGE', 'DAÑOS'],
      draftedMessages: 2,
    });
    expect(Date.now() - started).toBeLessThan(5 * 60_000);
    const drafts = await dbWorker
      .selectFrom('cg.resource as r')
      .innerJoin('cg.resource_text as t', 't.resource_id', 'r.id')
      .select(['r.slug', 'r.status', 'r.type', 't.locale', 't.title', 't.human_reviewed_by'])
      .where('r.tenant_id', '=', county)
      .orderBy('r.slug')
      .orderBy('t.locale')
      .execute();
    expect(drafts).toHaveLength(4);
    expect(drafts.every((d) => d.status === 'draft' && d.type === 'guidance')).toBe(true);
    expect(drafts.every((d) => d.human_reviewed_by === null)).toBe(true);
    expect(drafts.map((d) => [d.slug, d.locale])).toEqual([
      [`flood-food-water-${slug}`, 'en'],
      [`flood-food-water-${slug}`, 'es'],
      [`flood-turn-around-${slug}`, 'en'],
      [`flood-turn-around-${slug}`, 'es'],
    ]);
    // The public page shows nothing until someone publishes.
    const published = await dbWorker
      .selectFrom('cg.resource')
      .select('id')
      .where('tenant_id', '=', county)
      .where('status', '=', 'published')
      .execute();
    expect(published).toEqual([]);
  });

  it('CON-02: an event with no template still names its keywords; one without a hazard or a template is refused', async () => {
    expect(
      (await call('director', 'POST', '/events', { name: `Exercise nothing ${run}` })).status,
    ).toBe(400);
    const plain = (
      await call('director', 'POST', '/events', {
        name: `Exercise ice ${run}`,
        hazardType: 'winter_storm',
      })
    ).json<Event>();
    expect((await call('director', 'GET', `/events/${plain.id}/template`)).status).toBe(404);
    const refused = await call(
      'director',
      'POST',
      `/events/${plain.id}/open`,
      { intakeSlug: `ice-${run}` },
      confirmed(plain.version),
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toContain('intakeKeywords');
  });
});
