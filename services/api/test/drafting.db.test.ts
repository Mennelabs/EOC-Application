/**
 * AI drafting from facts against a real PostgreSQL (layer-7 task G; CMD-16,
 * AI-04, AI-09, AI-10, AIG-01, RULE-10). A reporting officer drafts a
 * situation report; with the register's drafting feature off, asking for an
 * AI draft says so and the rules' summary stays. Switched on, the summary is
 * rewritten from the report's facts with each sentence citing them, the
 * call is recorded with its provider and model, and the summary stays
 * labelled as drafted, so the report cannot be reviewed yet. A draft that
 * states a figure the facts do not hold is refused, recorded as invalid and
 * never shown. When the person saves the summary, the shown draft's record
 * says whether they kept it as written. Runs only with API_DB_TEST_APP_URL
 * and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { fakeProvider, type AiProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const HOUR = 3_600_000;

interface Section {
  key: string;
  kind: string;
  drafted: boolean;
  content: {
    text?: string;
    ai?: { provider: string; model: string; outputId: string; sentences: { factIds: string[] }[] };
  };
}
interface Report {
  id: string;
  version: number;
  state: string;
  sections: Section[];
  code?: string;
  details?: { problems?: string[] };
}

/** Storage for the AI voice's files, in memory (PUB-14). */
const stored = new Map<string, { body: Buffer; type: string }>();
const objects = {
  bucket: 'drafting-test',
  client: {
    async send(cmd: unknown) {
      if (cmd instanceof PutObjectCommand) {
        stored.set(cmd.input.Key!, {
          body: Buffer.from(cmd.input.Body as Buffer),
          type: cmd.input.ContentType!,
        });
        return {};
      }
      if (cmd instanceof GetObjectCommand) {
        const o = stored.get(cmd.input.Key!)!;
        return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
      }
      throw new Error('unexpected storage call');
    },
  } as unknown as Pick<S3Client, 'send'>,
};

/** A provider that states a figure the facts do not hold. */
const straying: AiProvider = {
  ...fakeProvider,
  llm: {
    extract: (r) => fakeProvider.llm!.extract(r),
    draft: async () => ({
      output: {
        sentences: [
          { text: 'As many as 999 homes were destroyed.', factIds: ['damage.destroyed'] },
        ],
        injectionSuspected: false,
      },
      provider: fakeProvider.info,
      latencyMs: 1,
    }),
  },
};

describe.skipIf(!appUrl || !workerUrl)('AI drafting from facts (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let provider: AiProvider = fakeProvider;
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as Report };
  };
  const v = (r: { version: number }) => ({ 'if-match': `"${r.version}"` });
  const summary = (r: Report) => r.sections.find((x) => x.key === 'summary')!;
  const outputs = () =>
    dbWorker
      .selectFrom('cg.ai_output')
      .select(['id', 'outcome', 'provider', 'model', 'target_type', 'human_action'])
      .where('tenant_id', '=', county)
      .where('feature', '=', 'report.drafting')
      .orderBy('created_at')
      .execute();

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-drafting-${run}`,
        name: `Exercise drafting county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    eventId = await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) })
        .execute();
      // Switched off until the administrator enables it (AIG-06, AIG-08).
      await trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'report.drafting',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'Report figures',
          decision_informed: 'A summary draft',
          human_checkpoint: 'The author saves it',
          owner: 'Planning',
          evaluation: JSON.stringify({}),
          enabled: false,
        })
        .execute();
      await trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'declaration.drafting',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'Declaration figures',
          decision_informed: 'Box 8 and 9 drafts',
          human_checkpoint: 'Staff save them',
          owner: 'County EM',
          evaluation: JSON.stringify({}),
          enabled: true,
        })
        .execute();
      await trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'public.drafting',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'Public site facts',
          decision_informed: 'Public text drafts',
          human_checkpoint: 'The PIO copies or changes them',
          owner: 'Public information',
          evaluation: JSON.stringify({}),
          enabled: true,
        })
        .execute();
      await trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'public.speech',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'An approved radio script',
          decision_informed: 'An audio file of it',
          human_checkpoint: 'The PIO listens before it airs',
          owner: 'Public information',
          evaluation: JSON.stringify({}),
          enabled: false,
        })
        .execute();
      await trx
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: county,
          key: 'intake.help_phone',
          value: JSON.stringify('(314) 555-0142'),
        })
        .execute();
      return (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise drafting flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(Date.now() - 24 * HOUR),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    await loadDamageReports(dbWorker, {
      tenantId: county,
      eventId,
      reviewerId: randomUUID(),
      count: 30,
      tag: `drf${run}`,
    });
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
    subjects['author'] = as('reporting_planning');
    subjects['director'] = as('county_em_director');
    subjects['pio'] = as('public_information_officer');
    const loader: SubjectLoader = {
      async fromBearer(token) {
        const s = subjects[token];
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
      // The deterministic fake stands in for OpenAI here (tests only, ADR-0043).
      routes: routesWith({ drafting: { ai: { providerFor: async () => provider }, objects } }),
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

  let report: Report;

  it('AI-10: with the feature off, asking says so and the rules’ summary stays', async () => {
    const made = await call('author', 'POST', '/official-reports', {
      clientUuid: randomUUID(),
      eventId,
      kind: 'sitrep',
      periodFrom: new Date(Date.now() - 12 * HOUR).toISOString(),
      periodTo: new Date().toISOString(),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    report = made.body;
    const off = await call(
      'author',
      'POST',
      `/official-reports/${report.id}/sections/summary/ai-draft`,
      { language: 'en' },
      v(report),
    );
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('ai_off');
    expect(await outputs()).toEqual([]);
  });

  it('CMD-16, AI-04, AIG-01: switched on, the summary is drafted from the facts, cited, recorded and still labelled as drafted', async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.ai_use_register')
        .set({ enabled: true })
        .where('tenant_id', '=', county)
        .where('feature', '=', 'report.drafting')
        .execute(),
    );
    const rules = summary(report).content.text!;
    const drafted = await call(
      'author',
      'POST',
      `/official-reports/${report.id}/sections/summary/ai-draft`,
      { language: 'en' },
      v(report),
    );
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(200);
    report = drafted.body;
    const s = summary(report);
    expect(s.drafted).toBe(true);
    expect(s.content.text).toBe(rules);
    expect(s.content.ai).toMatchObject({ provider: 'fake', model: 'keyword-rules' });
    // Every sentence cites facts of this report.
    expect(s.content.ai!.sentences.every((x) => x.factIds.length > 0)).toBe(true);
    expect(s.content.ai!.sentences.flatMap((x) => x.factIds)).toContain('damage.destroyed');
    expect(await outputs()).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        provider: 'fake',
        model: 'keyword-rules',
        target_type: 'official_report_section',
        human_action: null,
      }),
    ]);
    // RULE-10: a summary still as drafted cannot be approved.
    const review = await call(
      'director',
      'POST',
      `/official-reports/${report.id}/review`,
      { decision: 'approve' },
      v(report),
    );
    expect(review.status).toBe(409);
  });

  it('AI-04, AI-09: a draft stating a figure the facts do not hold is refused, recorded and never shown', async () => {
    provider = straying;
    const refused = await call(
      'author',
      'POST',
      `/official-reports/${report.id}/sections/summary/ai-draft`,
      { language: 'en' },
      v(report),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('ai_draft_refused');
    expect(refused.body.details?.problems?.join(' ')).toContain('999');
    const after = (await call('author', 'GET', `/official-reports/${report.id}`)).body;
    expect(summary(after).content.text).not.toContain('999');
    expect(after.version).toBe(report.version);
    expect((await outputs()).map((o) => o.outcome)).toEqual(['ok', 'invalid']);
    provider = fakeProvider;
  });

  it('AIG-01: saving the summary records whether the shown draft was kept as written; the refused one is untouched', async () => {
    const text = summary(report).content.text!;
    const saved = await call(
      'author',
      'PUT',
      `/official-reports/${report.id}/sections/summary`,
      { text },
      v(report),
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(summary(saved.body).drafted).toBe(false);
    expect((await outputs()).map((o) => [o.outcome, o.human_action])).toEqual([
      ['ok', 'accepted'],
      ['invalid', null],
    ]);
  });

  it('DCL:DEC-14: Boxes 8 and 9 are drafted from the declaration figures, cited and checked; saving records what the person kept', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/declaration/ai-draft`,
      headers: { authorization: 'Bearer director', 'idempotency-key': randomUUID() },
      payload: { box: 8 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const box8 = res.json() as {
      text: string;
      sentences: { factIds: string[] }[];
      facts: { id: string; value: unknown }[];
      provider: string;
      outputId: string;
    };
    expect(box8.provider).toBe('fake');
    expect(box8.text.length).toBeLessThanOrEqual(3000);
    expect(box8.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        'damage.units',
        'damage.destroyed',
        'damage.heavyUninsured',
        'outages.over72',
      ]),
    );
    expect(box8.sentences.every((x) => x.factIds.length > 0)).toBe(true);
    const box9 = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/events/${eventId}/declaration/ai-draft`,
        headers: { authorization: 'Bearer director', 'idempotency-key': randomUUID() },
        payload: { box: 9 },
      })
    ).json() as { text: string; facts: { id: string }[]; outputId: string };
    expect(box9.facts.map((f) => f.id)).toContain('donated.volunteerHours');
    // Not saved: the draft comes back to the screen; the person saves what they keep.
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/v1/events/${eventId}/declaration`,
      headers: { authorization: 'Bearer director', 'idempotency-key': randomUUID() },
      payload: {
        box8Draft: box8.text,
        box9Draft: `${box9.text} Exercise: county crews on 12-hour shifts.`,
        ai: [
          { outputId: box8.outputId, changed: false },
          { outputId: box9.outputId, changed: true },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const rows = await dbWorker
      .selectFrom('cg.ai_output')
      .select(['id', 'outcome', 'target_type', 'human_action'])
      .where('tenant_id', '=', county)
      .where('feature', '=', 'declaration.drafting')
      .execute();
    expect(rows.find((r) => r.id === box8.outputId)).toMatchObject({
      outcome: 'ok',
      target_type: 'declaration',
      human_action: 'accepted',
    });
    expect(rows.find((r) => r.id === box9.outputId)?.human_action).toBe('edited');
    // Who may not write the declaration may not draft it.
    const author = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/declaration/ai-draft`,
      headers: { authorization: 'Bearer author', 'idempotency-key': randomUUID() },
      payload: { box: 8 },
    });
    expect(author.statusCode).toBe(403);
  });

  it('PUB-11, PUB-12, PUB-14, AI-04: the social post, radio loop and alert text are drafted from the site facts, within each channel’s length, in both languages', async () => {
    const pio = (url: string, payload?: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/v1${url}`,
        headers: { authorization: 'Bearer pio', 'idempotency-key': randomUUID() },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
    const site = await pio('/sites', {
      kind: 'shelter',
      name: `Harmon High School gym ${run}`,
      slug: `drf-harmon-${run}`,
      status: 'open',
      address: { line1: '400 Schoolhouse Rd', city: 'Harmon City', postal: '63005' },
      hours: { daily: 'Open 24 hours' },
      pets: 'service_animals',
      accessibility: { ada: true, wheelchair: true },
    });
    expect(site.statusCode, site.body).toBe(201);
    const siteId = (site.json() as { id: string }).id;
    type Drafted = {
      form: string;
      text: string;
      rules: string;
      sentences: { factIds: string[] }[];
      facts: { id: string }[];
      provider: string;
      outputId: string;
    };
    const drafted: Drafted[] = [];
    for (const [form, max, language] of [
      ['social', 280, 'en'],
      ['wea90', 90, 'en'],
      ['radioLoop', 1500, 'en'],
      ['netReadout', 1500, 'es'],
    ] as const) {
      const res = await pio('/alerts/ai-draft', { siteId, change: 'opened', form, language });
      expect(res.statusCode, `${form}: ${res.body}`).toBe(200);
      const d = res.json() as Drafted;
      expect(d.provider).toBe('fake');
      expect(d.text.length).toBeLessThanOrEqual(max);
      expect(d.text).toContain(`Harmon High School gym ${run}`);
      // Not yet published: the drafts still carry its address (read from the staff record).
      if (form !== 'wea90') expect(d.text).toContain('400 Schoolhouse Rd');
      expect(d.sentences.every((x) => x.factIds.length > 0)).toBe(true);
      expect(d.facts.map((f) => f.id)).toEqual(
        expect.arrayContaining(['county', 'site.name', 'site.address', 'safety']),
      );
      drafted.push(d);
    }
    expect(drafted[2]!.text).toMatch(/This message repeats\.$/);
    expect(drafted[3]!.text).toMatch(/Fin del mensaje\.$/);
    // AIG-01: copying records whether the person kept it as written, once.
    const kept = await pio(`/alerts/ai-draft/${drafted[0]!.outputId}/kept`, { changed: false });
    expect(kept.statusCode, kept.body).toBe(204);
    const edited = await pio(`/alerts/ai-draft/${drafted[2]!.outputId}/kept`, { changed: true });
    expect(edited.statusCode).toBe(204);
    const again = await pio(`/alerts/ai-draft/${drafted[0]!.outputId}/kept`, { changed: true });
    expect(again.statusCode).toBe(204);
    const rows = await dbWorker
      .selectFrom('cg.ai_output')
      .select(['id', 'outcome', 'target_type', 'target_id', 'human_action', 'language'])
      .where('tenant_id', '=', county)
      .where('feature', '=', 'public.drafting')
      .execute();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.target_type === 'site' && r.target_id === siteId)).toBe(true);
    expect(rows.find((r) => r.id === drafted[0]!.outputId)?.human_action).toBe('accepted');
    expect(rows.find((r) => r.id === drafted[2]!.outputId)?.human_action).toBe('edited');
    expect(rows.find((r) => r.id === drafted[3]!.outputId)?.language).toBe('es');
    // Another feature's record is not this route's to mark.
    const other = await pio(`/alerts/ai-draft/${randomUUID()}/kept`, { changed: false });
    expect(other.statusCode).toBe(404);
    // PUB-05: a confidential site is never named in public text, by the rules or the assistant.
    const quiet = await pio('/sites', {
      kind: 'shelter',
      name: `Quiet house ${run}`,
      slug: `drf-quiet-${run}`,
      status: 'open',
      confidential: true,
    });
    expect(quiet.statusCode).toBe(201);
    const secret = await pio('/alerts/ai-draft', {
      siteId: (quiet.json() as { id: string }).id,
      change: 'opened',
      form: 'social',
    });
    expect(secret.statusCode).toBe(400);
    // Who may not draft public text may not ask the assistant for it.
    const author = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts/ai-draft',
      headers: { authorization: 'Bearer author', 'idempotency-key': randomUUID() },
      payload: { siteId, change: 'opened', form: 'social' },
    });
    expect([403, 404]).toContain(author.statusCode);
  });

  it('PUB-11, AIG-07: a public text may carry the county’s own help line; the filter still refuses anyone else’s', async () => {
    const pio = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/v1${url}`,
        headers: { authorization: 'Bearer pio', 'idempotency-key': randomUUID() },
        payload: payload as Record<string, unknown>,
      });
    const site = await pio('/sites', {
      kind: 'warming',
      name: `Westwind Library ${run}`,
      slug: `drf-library-${run}`,
      status: 'open',
      address: { line1: '5 Civic Plaza', city: 'Westwind', postal: '63003' },
    });
    expect(site.statusCode, site.body).toBe(201);
    const siteId = (site.json() as { id: string }).id;
    const mass = await pio('/alerts/ai-draft', {
      siteId,
      change: 'opened',
      form: 'massNotification',
    });
    expect(mass.statusCode, mass.body).toBe(200);
    expect((mass.json() as { text: string }).text).toContain('Questions: call (314) 555-0142.');
    // A provider that adds someone else's number is filtered and never shown.
    provider = {
      ...fakeProvider,
      llm: {
        extract: (r) => fakeProvider.llm!.extract(r),
        draft: async () => ({
          output: {
            sentences: [
              {
                text: 'Questions: call (314) 555-0142 or 314-555-0100.',
                factIds: ['helpPhone', 'county'],
              },
            ],
            injectionSuspected: false,
          },
          provider: fakeProvider.info,
          latencyMs: 1,
        }),
      },
    };
    const other = await pio('/alerts/ai-draft', { siteId, change: 'opened', form: 'social' });
    provider = fakeProvider;
    expect(other.statusCode).toBe(422);
  });

  it('PUB-14, AIG-01: the AI voice speaks an approved radio script into a file that says it is computer-generated; off until enabled', async () => {
    const pio = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/v1${url}`,
        headers: { authorization: 'Bearer pio', 'idempotency-key': randomUUID() },
        payload: payload as Record<string, unknown>,
      });
    const site = await pio('/sites', {
      kind: 'shelter',
      name: `Harmon Middle School ${run}`,
      slug: `drf-middle-${run}`,
      status: 'open',
      address: { line1: '12 Schoolhouse Rd', city: 'Harmon City', postal: '63005' },
    });
    const siteId = (site.json() as { id: string }).id;
    const rules = (await pio('/alerts/draft', { siteId, change: 'opened' })).json() as {
      drafts: { lang: string; radioLoop: string; netReadout: string }[];
    };
    const script = rules.drafts.find((d) => d.lang === 'es')!.radioLoop;
    const off = await pio('/alerts/audio', { siteId, form: 'radioLoop', language: 'es', script });
    expect(off.statusCode).toBe(409);
    expect((off.json() as { code: string }).code).toBe('ai_off');
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.ai_use_register')
        .set({ enabled: true })
        .where('tenant_id', '=', county)
        .where('feature', '=', 'public.speech')
        .execute(),
    );
    const made = await pio('/alerts/audio', { siteId, form: 'radioLoop', language: 'es', script });
    expect(made.statusCode, made.body).toBe(201);
    const audio = made.json() as {
      id: string;
      script: string;
      mimeType: string;
      bytes: number;
      provider: string;
      sha256: string;
    };
    expect(audio.script).toBe(`Este anuncio lo lee una voz generada por computadora. ${script}`);
    expect(audio).toMatchObject({ mimeType: 'audio/wav', provider: 'fake' });
    expect(audio.bytes).toBeGreaterThan(44);
    const listed = await app.inject({
      url: `/api/v1/alerts/audio?siteId=${siteId}`,
      headers: { authorization: 'Bearer pio' },
    });
    expect((listed.json() as { id: string }[]).map((x) => x.id)).toEqual([audio.id]);
    const file = await app.inject({
      url: `/api/v1/alerts/audio/${audio.id}/file`,
      headers: { authorization: 'Bearer pio' },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/wav');
    expect(file.headers['content-disposition']).toContain('radio-loop-es-');
    expect(file.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(file.rawPayload.length).toBe(audio.bytes);
    const rec = await dbWorker
      .selectFrom('cg.ai_output')
      .select(['outcome', 'target_type', 'target_id', 'language'])
      .where('tenant_id', '=', county)
      .where('feature', '=', 'public.speech')
      .execute();
    expect(rec).toEqual([
      { outcome: 'ok', target_type: 'site', target_id: siteId, language: 'es' },
    ]);
    // PUB-05: never a confidential site; and only those who draft public text.
    const quiet = await pio('/sites', {
      kind: 'shelter',
      name: `Quiet place ${run}`,
      slug: `drf-quiet2-${run}`,
      status: 'open',
      confidential: true,
    });
    const secret = await pio('/alerts/audio', {
      siteId: (quiet.json() as { id: string }).id,
      form: 'netReadout',
      script,
    });
    expect(secret.statusCode).toBe(400);
    const author = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts/audio',
      headers: { authorization: 'Bearer author', 'idempotency-key': randomUUID() },
      payload: { siteId, form: 'radioLoop', script },
    });
    expect([403, 404]).toContain(author.statusCode);
  });
});
