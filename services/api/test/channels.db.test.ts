/**
 * Text and voice intake against a real PostgreSQL through the simulator
 * (CHN-01, CHN-03, CHN-04, CHN-05, docs/06): a whole conversation from the
 * keyword to the reference code; BACK, SKIP, HELP, STOP and a wrong reply;
 * Spanish by keyword; a voice call through language choice, answers, agent
 * transfer and sending; Twilio webhooks refused without a valid signature and
 * accepted with one; delivery receipts update the message row. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider } from '@cg/ai';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Kysely } from 'kysely';
import { loadSeed, SEED_COUNTY_NUMBER } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { dataUrlFetcher } from '../src/channels/media.ts';
import { webhookRoutes } from '../src/channels/routes.ts';
import { ChannelSessions } from '../src/channels/session.ts';
import { twilioSignature } from '../src/channels/twilio.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser, CODE_PATTERN } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { submitIntake } from '../src/public/submit.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const AUTH_TOKEN = 'test-twilio-token';

describe.skipIf(!appUrl || !workerUrl)('text and voice intake (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let tenantId: string;
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const run = Date.now().toString().slice(-7);
  const objectStore = new Map<string, Buffer>();
  const phone = `+1314555${run.slice(-4)}`;

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    tenantId = seeded.tenants['county']!;
    const resolver = new TenantResolver(dbApp);
    const codes = new ReferenceCodeLeaser(dbApp, 'test');
    const risk = new RiskScorer();
    const deps = {
      codes,
      risk,
      getQueue: () => undefined,
      defaultGraph: westwindGraph,
      crypto,
      now: () => new Date(),
    };
    const sessions = new ChannelSessions({
      crypto,
      defaultGraph: westwindGraph,
      submit: (req, input) => submitIntake(deps, req, input),
      media: dataUrlFetcher(),
      objects: {
        client: {
          send: async (cmd: { input: { Key: string; Body: Buffer } }) => {
            objectStore.set(cmd.input.Key, cmd.input.Body);
            return {};
          },
        } as unknown as S3Client,
        bucket: 'test',
        maxBytes: 6 * 1024 * 1024,
      },
      publicBase: 'https://localhost',
    });
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: crypto,
      publicRoutes: [
        publicRoutes({
          resolver,
          codes,
          risk,
          getQueue: () => undefined,
          residentTokenSecret: 'test-secret-'.repeat(4),
          defaultGraph: westwindGraph,
          ai: { providerFor: async () => fakeProvider },
        }),
      ],
      webhookRoutes: [
        webhookRoutes({
          resolver,
          sessions,
          twilio: { authToken: AUTH_TOKEN },
          publicBase: 'https://localhost',
          simulator: true,
        }),
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  async function text(
    from: string,
    body: string,
    media?: { contentType: string; dataBase64: string }[],
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/simulator/sms',
      payload: { from, to: SEED_COUNTY_NUMBER, body, ...(media ? { media } : {}) },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().replies as string[];
  }

  async function voice(
    from: string,
    step: string,
    input: { digits?: string; speech?: string } = {},
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/simulator/voice',
      payload: { from, to: SEED_COUNTY_NUMBER, step, ...input },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { twiml: string; say: string[]; nextStep: string | null; hangup: boolean };
  }

  it('a whole report by text: keyword, numbered answers, BACK, SKIP, HELP, a wrong reply, needs, consent, SEND → reference code (CHN-03, INT-05/06)', async () => {
    const first = await text(phone, 'DAMAGE');
    expect(first).toHaveLength(2);
    expect(first[0]).toContain("You're signed up for messages");
    expect(first[0]).toContain('Westwind County');
    expect(first[1]).toContain('Is anyone in danger right now?');
    expect(first[1]).toContain('1 Yes, someone is in danger');
    expect(first[1]).not.toMatch(/Test Product/);

    let reply = await text(phone, '2'); // no danger
    expect(reply[0]).toContain('reporting'); // relationship question
    reply = await text(phone, '1'); // own home
    expect(reply[0]).toContain('Where is the home?');
    reply = await text(phone, 'skip'); // address is required
    expect(reply[0]).toContain('We need this one');
    expect(reply[0]).toContain('Where is the home?');
    reply = await text(phone, `${run} Elm Ct, Westwind 63001`);
    expect(reply[0]).toContain('What kind of home');
    reply = await text(phone, 'back');
    expect(reply[0]).toContain('Where is the home?');
    await text(phone, `${run} Elm Ct, Westwind 63001`);
    reply = await text(phone, '9'); // not an option
    expect(reply[0]).toContain('Please reply with one of the numbers');
    expect(reply[0]).toContain('What kind of home');
    reply = await text(phone, 'HELP');
    expect(reply[0]).toContain('help line');
    expect(reply[0]).toContain('(314) 555-0142');
    reply = await text(phone, '1'); // house

    // Walk the rest by answering 1 (or skipping optional questions) until the needs step.
    for (let i = 0; i < 25 && !reply[0]?.includes('Do you need help with any of these?'); i++) {
      const prompt = reply[0] ?? '';
      const answer = /^1 /m.test(prompt)
        ? '1'
        : prompt.includes('Reply with a number')
          ? '1'
          : prompt.includes('own words')
            ? 'A tree fell on the roof'
            : prompt.includes('photos')
              ? 'skip'
              : 'skip';
      reply = await text(phone, answer);
    }
    expect(reply[0]).toContain('Do you need help with any of these?');
    reply = await text(phone, '1 3');
    expect(reply[0]).toContain('Who may see your request for help?');
    reply = await text(phone, '1');
    expect(reply[0]).toContain('What is your name?');
    reply = await text(phone, 'Ana Ruiz');
    expect(reply[0]).toContain('SEND');
    reply = await text(phone, 'send');
    expect(reply[0]).toMatch(/Your reference number is [A-HJKMNP-Z]{4}-[2-9]{4}/);
    expect(reply[0]).toContain('Call 911');
    expect(reply[0]).toContain('Westwind County');

    const code = reply[0]!.match(/([A-HJKMNP-Z]{4}-[2-9]{4})/)![1]!;
    const stored = await dbWorker
      .selectFrom('cg.intake_submission')
      .selectAll()
      .where('reference_code', '=', code)
      .executeTakeFirstOrThrow();
    expect(stored.channel).toBe('sms');
    expect(stored.status).toBe('stored'); // no queue in this test
    const payload = JSON.parse(await crypto.decrypt(tenantId, stored.payload_enc)) as Record<
      string,
      unknown
    >;
    expect(payload['channel']).toBe('sms');
    expect(payload['smsOptIn']).toBe(true);
    expect(payload['confirmationSent']).toBe(true);
    expect(payload['needs']).toEqual(['shelter_tonight', 'cleanup_tarp']);
    expect(payload['consent']).toMatchObject({ volunteer_cleanup: true, relief_agencies: false });
    expect(payload['ownWords']).toBe('A tree fell on the roof');
    expect(
      (payload['answers'] as Record<string, { value: Record<string, string> }>)['contact']?.value,
    ).toMatchObject({ phone, preferred: 'text' });
    expect(
      (payload['answers'] as Record<string, { value: Record<string, string> }>)['address']?.value,
    ).toMatchObject({ postal: '63001' });
    expect(code).toMatch(CODE_PATTERN);

    const session = await dbWorker
      .selectFrom('cg.intake_session')
      .select(['state', 'cursor', 'channel'])
      .where('execution_id', '=', stored.execution_id)
      .executeTakeFirstOrThrow();
    expect(session.state).toBe('submitted');
    const audit = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', tenantId)
      .where('action', 'in', ['channel.session_started', 'intake.submit', 'channel.submitted'])
      .where('execution_id', '=', stored.execution_id)
      .execute();
    expect(new Set(audit.map((a) => a.action))).toEqual(
      new Set(['channel.session_started', 'intake.submit', 'channel.submitted']),
    );
  });

  it('DAÑOS starts in Spanish; a picture attaches to the report; STOP ends it and opts the number out (CHN-03/04)', async () => {
    const es = `+1314556${run.slice(-4)}`;
    const first = await text(es, 'daños');
    expect(first[0]).toContain('Manejo de Emergencias');
    expect(first[1]).toContain('¿Hay alguien en peligro ahora mismo?');
    expect(first[1]).toContain('ATRAS');
    const picture = Buffer.from('not-really-a-jpeg').toString('base64');
    const withPhoto = await text(es, '2', [{ contentType: 'image/jpeg', dataBase64: picture }]);
    expect(withPhoto[0]).toContain('Recibimos 1 foto.');
    const photos = await dbWorker
      .selectFrom('cg.photo')
      .innerJoin('cg.intake_session', 'cg.intake_session.execution_id', 'cg.photo.execution_id')
      .select([
        'cg.photo.source as source',
        'cg.photo.status as status',
        'cg.photo.object_key_original as key',
      ])
      .where('cg.intake_session.channel', '=', 'sms')
      .where('cg.intake_session.state', '=', 'active')
      .where('cg.intake_session.language', '=', 'es')
      .execute();
    expect(photos.some((p) => p.source === 'mms' && p.status === 'uploaded')).toBe(true);
    expect(objectStore.has(photos[0]!.key)).toBe(true);
    const queued = await dbWorker
      .selectFrom('cg.outbox')
      .select('topic')
      .where('tenant_id', '=', tenantId)
      .where('topic', '=', 'photo.process')
      .where('published_at', 'is', null)
      .execute();
    expect(queued.length).toBeGreaterThan(0);
    const stop = await text(es, 'ALTO');
    expect(stop[0]).toContain('Ya no recibirá mensajes');
    const sessions = await dbWorker
      .selectFrom('cg.intake_session')
      .select(['state', 'opt_out'])
      .where('tenant_id', '=', tenantId)
      .where('language', '=', 'es')
      .orderBy('created_at', 'desc')
      .limit(1)
      .execute();
    expect(sessions[0]).toEqual({ state: 'stopped', opt_out: true });
    const after = await text(es, '1');
    expect(after).toHaveLength(2); // a new report: the program notice again, then the first question
    expect(after[1]).toContain('Is anyone in danger'); // any text starts fresh in the county default language
  });

  it('SHELTER with a ZIP answers with the three nearest open sites; REFUGIO in Spanish; without a place it says how to ask (PUB-08)', async () => {
    const near = await text(`+1314557${run.slice(-4)}`, 'shelter 63005');
    expect(near[0]).toContain('Open sites nearest Harmon City (63005):');
    expect(near[0]).toContain('Harmon High School gym (shelter) (0 km away)');
    expect(near[0]).toContain('400 Schoolhouse Rd');
    expect(near[0]).toContain('Open 24 hours');
    expect(near[0]).toContain('service animals only');
    expect(near[0]).not.toContain('Safe Harbor');
    expect(near[0]!.split('\n').length - 1).toBeLessThanOrEqual(3);
    expect(near[1]).toContain('https://localhost/county/help');
    expect(near[1]).toContain('911');
    const es = await text(`+1314557${run.slice(-4)}`, 'REFUGIO 63002');
    expect(es[0]).toContain('Sitios abiertos cerca de Cedar Ridge (63002):');
    expect(es[0]).toContain('Iglesia Nueva Esperanza fellowship hall (comida)');
    expect(es[1]).toContain('ALTO');
    const bare = await text(`+1314557${run.slice(-4)}`, 'shelter');
    expect(bare[0]).toContain('Open sites:');
    expect(bare[1]).toContain('Text SHELTER and your ZIP code');
  });

  it('a call: press 3, enter a ZIP, hear the nearest open sites, then report damage (PUB-09)', async () => {
    const caller = `+1314559${run.slice(-4)}`;
    const start = await voice(caller, 'start');
    expect(start.say.join(' ')).toContain('press 3');
    expect(start.say.join(' ')).toContain('oprima el 4');
    const ask = await voice(caller, 'language', { digits: '3' });
    expect(ask.say[0]).toContain('five digits of your ZIP code');
    expect(ask.twiml).toContain('numDigits="5"');
    expect(ask.nextStep).toBe('sites_en');
    const list = await voice(caller, 'sites_en', { digits: '63005' });
    const spoken = list.say.join(' ');
    expect(spoken).toContain('Harmon High School gym, a shelter');
    expect(spoken).toContain('400 Schoolhouse Rd');
    expect(spoken).toContain('To hear this again, press 1');
    expect(list.nextStep).toBe('sites_menu_en');
    const es = await voice(caller, 'sites_es', { digits: '63002' });
    expect(es.say.join(' ')).toContain('Iglesia Nueva Esperanza fellowship hall, comida');
    const report = await voice(caller, 'sites_menu_en', { digits: '2' });
    expect(report.say.join(' ')).toContain('Is anyone in danger right now?');
    const bye = await voice(caller, 'sites_menu_en', { digits: '9' });
    expect(bye.hangup).toBe(true);
  });

  it('a call: greeting and language choice, questions by keypad and speech, agent transfer, send with a texted code (CHN-05)', async () => {
    const caller = `+1314558${run.slice(-4)}`;
    const start = await voice(caller, 'start');
    expect(start.say[0]).toContain('disaster help line');
    expect(start.say[0]).toContain('call 911');
    expect(start.nextStep).toBe('language');
    let step = await voice(caller, 'language', { digits: '1' });
    expect(step.say.join(' ')).toContain('Is anyone in danger right now?');
    expect(step.say.join(' ')).toContain('Press 1: Yes');
    expect(step.twiml).toContain('numDigits="1"');
    step = await voice(caller, 'answer', { digits: '2' });
    expect(step.say.join(' ')).toContain('reporting');
    step = await voice(caller, 'answer', { speech: 'one' });
    expect(step.say.join(' ')).toContain('Where is the home?');
    const agent = await voice(caller, 'answer', { digits: '0' });
    expect(agent.twiml).toContain('<Dial>3145550142</Dial>');
    step = await voice(caller, 'repeat');
    expect(step.say.join(' ')).toContain('Where is the home?');
    step = await voice(caller, 'answer', { speech: `${run} Elm Court Westwind 63001` });
    for (let i = 0; i < 25 && !step.say.join(' ').includes('Last step'); i++) {
      const spoken = step.say.join(' ');
      step = await voice(
        caller,
        'answer',
        spoken.includes('Press 1:')
          ? { digits: '1' }
          : spoken.includes('Reply with a number')
            ? { digits: '1' }
            : { speech: spoken.includes('own words') ? 'the roof is gone' : 'skip' },
      );
    }
    expect(step.say.join(' ')).toContain('Press 1 to send your report and get a text');
    const sent = await voice(caller, 'answer', { digits: '1' });
    expect(sent.hangup).toBe(true);
    expect(sent.say.join(' ')).toContain('Your report was sent');
    expect(sent.twiml).toContain('interpret-as="characters"');
    expect(sent.say.join(' ')).toContain('text it to this phone');
    const stored = await dbWorker
      .selectFrom('cg.intake_submission')
      .select(['channel', 'payload_enc'])
      .where('tenant_id', '=', tenantId)
      .where('channel', '=', 'voice')
      .orderBy('received_at', 'desc')
      .executeTakeFirstOrThrow();
    const payload = JSON.parse(await crypto.decrypt(tenantId, stored.payload_enc)) as Record<
      string,
      unknown
    >;
    expect(payload['smsOptIn']).toBe(true);
    expect(payload['confirmationSent']).toBe(true);
    expect((payload['answers'] as Record<string, { value: string }>)['relationship']?.value).toBe(
      'own_home',
    );
  });

  it('Twilio webhooks are refused without a valid signature and accepted with one (CHN-04)', async () => {
    const url = 'https://localhost/api/webhooks/twilio/sms';
    const params = {
      From: `+1314559${run.slice(-4)}`,
      To: SEED_COUNTY_NUMBER,
      Body: 'HELP',
      NumMedia: '0',
    };
    const form = new URLSearchParams(params).toString();
    const unsigned = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form,
    });
    expect(unsigned.statusCode).toBe(403);
    const wrong = await app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature('other', url, params),
      },
      payload: form,
    });
    expect(wrong.statusCode).toBe(403);
    const signed = await app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature(AUTH_TOKEN, url, params),
      },
      payload: form,
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.headers['content-type']).toContain('text/xml');
    expect(signed.body).toContain('<Message>Westwind County Emergency Mgmt disaster help line.');
    const unknownNumber = await app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature(AUTH_TOKEN, url, { ...params, To: '+15550000000' }),
      },
      payload: new URLSearchParams({ ...params, To: '+15550000000' }).toString(),
    });
    expect(unknownNumber.statusCode).toBe(404);
  });

  it('delivery receipts move a sent message to delivered or failed (BRD:FR-17.05)', async () => {
    const sid = `SM${run}`;
    await withTenant(dbWorker, { tenantId }, (trx) =>
      trx
        .insertInto('cg.message')
        .values({
          tenant_id: tenantId,
          channel: 'sms',
          to_enc: Buffer.from('x'),
          template: 'confirmation',
          body_enc: Buffer.from('x'),
          state: 'sent',
          provider: 'twilio',
          provider_message_id: sid,
        })
        .execute(),
    );
    const url = 'https://localhost/api/webhooks/twilio/status';
    const params = {
      MessageSid: sid,
      MessageStatus: 'delivered',
      From: SEED_COUNTY_NUMBER,
      To: '+13145550199',
    };
    const res = await app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature(AUTH_TOKEN, url, params),
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(res.statusCode).toBe(204);
    const row = await dbWorker
      .selectFrom('cg.message')
      .select(['state', 'delivered_at'])
      .where('provider_message_id', '=', sid)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });
});
