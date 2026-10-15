/**
 * Filing against a real PostgreSQL (migrations applied, seed loaded): a stored
 * submission becomes a report with parties, location, needs, consent and
 * flags; the reference code is bound; filing is idempotent (AC-11B); the
 * confirmation goes out through the SMS adapter and is recorded (CHN-03);
 * photos are processed with metadata stripped and duplicates flagged
 * (PHO-06/07/15). Runs only with API_DB_TEST_WORKER_URL set; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import sharp from 'sharp';
import { SimulatorSms } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, randomCode, withTenant, type Database, type ReportFlag } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { sql, type Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../src/idp/keycloak.ts';
import { fileSubmission, sweepStoredSubmissions, topUpReferenceCodes } from '../src/jobs/intake.ts';
import { messageSend } from '../src/jobs/messages.ts';
import { photoProcess } from '../src/jobs/photos.ts';
import type { JobContext } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!workerUrl)('worker filing (database-backed)', () => {
  let db: Kysely<Database>;
  let tenantId: string;
  let eventId: string | null;
  let ctx: JobContext;
  const sms = new SimulatorSms();
  const mails: { to: string; subject: string; text: string }[] = [];
  const store = new Map<string, { body: Buffer; contentType: string }>();
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());

  const answers = (address: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    danger_now: { kind: 'value', value: 'no' },
    relationship: { kind: 'value', value: 'own_home' },
    address: { kind: 'value', value: address },
    home_type: { kind: 'value', value: 'house' },
    cause: { kind: 'value', value: 'wind_tornado' },
    damage_types: { kind: 'value', value: ['roof'] },
    roof_state: { kind: 'value', value: 'large_hole' },
    habitable: { kind: 'value', value: 'no' },
    tonight: { kind: 'value', value: 'yes' },
    insurance: { kind: 'unknown' },
    contact_name: { kind: 'value', value: 'Ana Ruiz' },
    contact: { kind: 'value', value: { phone: '314-555-0199', preferred: 'text' } },
    ...extra,
  });

  async function store_(executionId: string, payload: Record<string, unknown>) {
    const code = randomCode();
    const full = {
      executionId,
      channel: 'web',
      language: 'en',
      graphKey: westwindGraph.key,
      graphVersion: westwindGraph.version,
      relationship: 'own_home',
      needs: ['cleanup_tarp', 'shelter_tonight'],
      consent: { volunteer_cleanup: true, faith_based: false },
      smsOptIn: true,
      afterSubmission: {
        household_size: { kind: 'value', value: '3' },
        access_needs: { kind: 'value', value: ['medical_power'] },
      },
      eventId,
      hazards: ['tornado', 'wind'],
      risk: { decision: 'allow', score: 0 },
      receivedAt: new Date().toISOString(),
      ...payload,
    };
    const enc = await crypto.encrypt(tenantId, JSON.stringify(full));
    await withTenant(db, { tenantId }, (trx) =>
      trx
        .insertInto('cg.intake_submission')
        .values({
          execution_id: executionId,
          tenant_id: tenantId,
          event_id: eventId,
          channel: 'web',
          reference_code: code,
          payload_enc: enc,
          status: 'stored',
        })
        .execute(),
    );
    return code;
  }

  beforeAll(async () => {
    db = createDb(workerUrl!, 2);
    const seeded = await loadSeed(db);
    tenantId = seeded.tenants['county']!;
    const event = await db
      .selectFrom('cg.event')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('intake_slug', '=', 'westwind')
      .executeTakeFirst();
    eventId = event?.id ?? null;
    await withTenant(db, { tenantId }, (trx) =>
      trx
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: tenantId,
          key: 'intake.help_phone',
          value: JSON.stringify('(314) 555-0142'),
        })
        .onConflict((oc) => oc.doNothing())
        .execute(),
    );
    ctx = {
      db,
      log: pino({ level: 'silent' }),
      idp: {} as unknown as KeycloakAdmin,
      mail: { send: async (m) => void mails.push(m) },
      sms,
      crypto,
      urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
      objects: {
        async get(key) {
          const o = store.get(key);
          if (!o) throw new Error(`no object ${key}`);
          return o;
        },
        async put(key, body, contentType) {
          store.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType });
        },
        async putAnchor() {},
        async putLocked() {
          return { versionId: null, mode: 'GOVERNANCE' as const };
        },
      },
      devDirectGrant: false,
      ai: { providerFor: async () => fakeProvider },
      defaultGraph: westwindGraph,
    };
  });

  afterAll(async () => {
    await db?.destroy();
  });

  let firstReportId: string;
  let firstExecution: string;
  const address = { line1: `${Date.now() % 100000} Elm Ct`, city: 'Westwind', postal: '63001' };

  it('files a stored submission: report, parties, location, needs, consent, after-saving answers, code bound, confirmation queued (AC-11B, INT-22, NED-01/03)', async () => {
    firstExecution = randomUUID();
    const code = await store_(firstExecution, { answers: answers(address) });
    const filed = await sweepStoredSubmissions(ctx);
    expect(filed).toBeGreaterThanOrEqual(1);

    const report = await db
      .selectFrom('cg.report')
      .selectAll()
      .where('execution_id', '=', firstExecution)
      .executeTakeFirstOrThrow();
    firstReportId = report.id;
    expect(report.reference_code).toBe(code);
    expect(report.review_state).toBe('submitted');
    expect(report.relationship).toBe('own_home');
    expect(report.reporter_party_id).toBe(report.subject_party_id);
    expect(report.need_signals).toMatchObject({ displaced: true, medical: true, unsafe: false });
    expect(report.answers).toHaveProperty('home_type');
    expect(report.answers).not.toHaveProperty('contact');
    expect(report.answers).not.toHaveProperty('contact_name');
    expect(report.answers).not.toHaveProperty('address');
    expect(report.answers_enc).toBeNull(); // nothing restricted among the main answers of this path
    expect(report.danger_flag).toBe(false);
    expect(report.flags).toEqual([]);

    const party = await db
      .selectFrom('cg.party')
      .selectAll()
      .where('id', '=', report.reporter_party_id!)
      .executeTakeFirstOrThrow();
    expect(party.kind).toBe('resident');
    expect(party.sms_opt_in).toBe(true);
    expect(party.phone_bidx).not.toBeNull();
    expect(JSON.parse(await crypto.decrypt(tenantId, party.contact_enc!))).toMatchObject({
      phone: '+13145550199',
    });
    expect(await crypto.decrypt(tenantId, party.display_name_enc!)).toBe('Ana Ruiz');

    const location = await db
      .selectFrom('cg.location')
      .selectAll()
      .where('id', '=', report.location_id!)
      .executeTakeFirstOrThrow();
    expect(location.line1).toBe(address.line1);
    expect(location.address_key).toContain('63001');
    expect(location.no_fixed_address).toBe(false);

    const needs = await db
      .selectFrom('cg.need')
      .select(['category', 'status'])
      .where('report_id', '=', report.id)
      .execute();
    expect(needs.map((n) => n.category).sort()).toEqual(['cleanup_tarp', 'shelter_tonight']);
    const consent = await db
      .selectFrom('cg.consent')
      .select(['org_type', 'granted'])
      .where('report_id', '=', report.id)
      .execute();
    expect(Object.fromEntries(consent.map((c) => [c.org_type, c.granted]))).toEqual({
      volunteer_cleanup: true,
      faith_based: false,
    });
    const after = await db
      .selectFrom('cg.post_submission_answers')
      .selectAll()
      .where('report_id', '=', report.id)
      .executeTakeFirstOrThrow();
    expect(after.aggregate_answers).toHaveProperty('household_size');
    expect(after.aggregate_answers).not.toHaveProperty('access_needs');
    expect(
      JSON.parse(await crypto.decrypt(tenantId, after.restricted_answers_enc!)),
    ).toHaveProperty('access_needs');

    const bound = await db
      .selectFrom('cg.reference_code')
      .select(['state', 'report_id'])
      .where('tenant_id', '=', tenantId)
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    expect(bound).toEqual({ state: 'used', report_id: report.id });

    const submission = await db
      .selectFrom('cg.intake_submission')
      .select(['status', 'processed_at'])
      .where('execution_id', '=', firstExecution)
      .executeTakeFirstOrThrow();
    expect(submission.status).toBe('processed');
    expect(submission.processed_at).not.toBeNull();

    // Relayed rows stay in the outbox (a worker on the same database may have relayed them already).
    const outbox = await db
      .selectFrom('cg.outbox')
      .select(['topic', 'payload'])
      .where('tenant_id', '=', tenantId)
      .where('topic', '=', 'message.send')
      .orderBy('id')
      .execute();
    const templates = outbox
      .map((o) => o.payload as { template: string; reportId: string })
      .filter((p) => p.reportId === report.id)
      .map((p) => p.template);
    expect(templates).toEqual(['opt_in_confirmation', 'confirmation']);

    const audit = await db
      .selectFrom('cg.audit_event')
      .select(['action', 'actor_kind'])
      .where('tenant_id', '=', tenantId)
      .where('target_id', '=', report.id)
      .where('action', '=', 'report.filed')
      .executeTakeFirst();
    expect(audit?.actor_kind).toBe('system');
  });

  it('files the same execution id only once (AC-11B)', async () => {
    await db
      .updateTable('cg.intake_submission')
      .set({ status: 'stored' })
      .where('execution_id', '=', firstExecution)
      .execute();
    await sweepStoredSubmissions(ctx);
    const reports = await db
      .selectFrom('cg.report')
      .select('id')
      .where('execution_id', '=', firstExecution)
      .execute();
    expect(reports).toHaveLength(1);
    const row = await db
      .selectFrom('cg.intake_submission')
      .select('status')
      .where('execution_id', '=', firstExecution)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('processed');
    const sub = await db
      .selectFrom('cg.intake_submission')
      .select('payload_enc')
      .where('execution_id', '=', firstExecution)
      .executeTakeFirstOrThrow();
    const again = await fileSubmission(ctx, {
      tenantId,
      executionId: firstExecution,
      referenceCode: 'XXXX-2222',
      eventId,
      channel: 'web',
      payloadEnc: sub.payload_enc,
      path: 'queue',
    });
    expect(again).toMatchObject({ reportId: firstReportId, created: false });
  });

  it('flags a second report at the same address as a possible duplicate for a person (PHO-15)', async () => {
    const executionId = randomUUID();
    await store_(executionId, {
      answers: answers(
        { ...address, line1: address.line1.toUpperCase() },
        { habitable: { kind: 'value', value: 'yes' } },
      ),
      risk: { decision: 'verify', score: 60 },
      aiAssisted: true,
    });
    await sweepStoredSubmissions(ctx);
    const report = await db
      .selectFrom('cg.report')
      .select(['flags'])
      .where('execution_id', '=', executionId)
      .executeTakeFirstOrThrow();
    const flags = report.flags as ReportFlag[];
    expect(flags.map((f) => f.kind).sort()).toEqual([
      'ai_assisted',
      'possible_duplicate',
      'verify_suggested',
    ]);
    expect(flags.find((f) => f.kind === 'possible_duplicate')).toMatchObject({
      reason: 'same_address',
      reportId: firstReportId,
    });
  });

  it('files a helper report with a separate affected-person party and a no-fixed-address location (HLP, EQ-03)', async () => {
    const executionId = randomUUID();
    await store_(executionId, {
      relationship: 'helper',
      smsOptIn: false,
      answers: {
        danger_now: { kind: 'value', value: 'no' },
        relationship: { kind: 'value', value: 'helper' },
        helper_name: { kind: 'value', value: 'Sam Okafor' },
        helper_consent: { kind: 'value', value: 'yes' },
        subject_name: { kind: 'value', value: 'Rosa Delgado' },
        address: {
          kind: 'value',
          value: { landmark: 'blue house next to the church on Mill Rd', city: 'Westwind' },
        },
        home_type: { kind: 'value', value: 'mobile' },
        cause: { kind: 'value', value: 'wind_tornado' },
        damage_types: { kind: 'value', value: ['structure'] },
        roof_state: { kind: 'unknown' },
        habitable: { kind: 'value', value: 'no' },
        tonight: { kind: 'value', value: 'no' },
        insurance: { kind: 'unknown' },
        contact: { kind: 'value', value: { email: 'Sam@Example.org' } },
      },
      needs: [],
      consent: {},
      afterSubmission: {},
    });
    await sweepStoredSubmissions(ctx);
    const report = await db
      .selectFrom('cg.report')
      .selectAll()
      .where('execution_id', '=', executionId)
      .executeTakeFirstOrThrow();
    expect(report.helper_party_id).toBe(report.reporter_party_id);
    expect(report.subject_party_id).not.toBe(report.reporter_party_id);
    const subject = await db
      .selectFrom('cg.party')
      .selectAll()
      .where('id', '=', report.subject_party_id!)
      .executeTakeFirstOrThrow();
    expect(subject.kind).toBe('resident');
    expect(subject.contact_enc).toBeNull();
    expect(await crypto.decrypt(tenantId, subject.display_name_enc!)).toBe('Rosa Delgado');
    const reporter = await db
      .selectFrom('cg.party')
      .selectAll()
      .where('id', '=', report.reporter_party_id!)
      .executeTakeFirstOrThrow();
    expect(reporter.kind).toBe('helper');
    expect(reporter.email_bidx).not.toBeNull();
    expect(reporter.sms_opt_in).toBe(false);
    const location = await db
      .selectFrom('cg.location')
      .selectAll()
      .where('id', '=', report.location_id!)
      .executeTakeFirstOrThrow();
    expect(location.no_fixed_address).toBe(true);
    expect(location.address_key).toBeNull();
    const outbox = await db
      .selectFrom('cg.outbox')
      .select('payload')
      .where('topic', '=', 'message.send')
      .execute();
    const mine = outbox
      .map((o) => o.payload as { reportId: string; channel: string; template: string })
      .filter((p) => p.reportId === report.id);
    expect(mine).toEqual([{ ...mine[0], channel: 'email', template: 'confirmation' }]);
  });

  it('sends the confirmation through the SMS adapter once and records the message (CHN-03, SEC-10)', async () => {
    // The filed report's confirmation, as the worker's outbox carries it. The job is built here
    // with its own outbox id: a worker running against the same database may already have relayed
    // and sent the real row, and this case is about one sending per delivery, not about the relay.
    const report = await db
      .selectFrom('cg.report')
      .select(['reporter_party_id', 'reference_code'])
      .where('id', '=', firstReportId)
      .executeTakeFirstOrThrow();
    const outboxId = 800_000_000 + Math.floor(Math.random() * 99_999_999);
    const msg = {
      id: outboxId,
      tenantId,
      topic: 'message.send',
      payload: {
        template: 'confirmation',
        channel: 'sms',
        toEnc: (await crypto.encrypt(tenantId, '+13145550199')).toString('base64'),
        language: 'en',
        reportId: firstReportId,
        partyId: report.reporter_party_id,
        variables: { referenceCode: report.reference_code },
      },
      executionId: firstExecution,
    };
    const before = sms.sent.length;
    await messageSend(ctx, msg);
    await messageSend(ctx, msg); // redelivery
    expect(sms.sent.length).toBe(before + 1);
    const text = sms.sent.at(-1)!;
    expect(text.to).toBe('+13145550199');
    expect(text.body).toContain('Westwind County');
    expect(text.body).toContain('911');
    const message = await db
      .selectFrom('cg.message')
      .selectAll()
      .where('report_id', '=', firstReportId)
      .where('template', '=', 'confirmation')
      .where(sql`provider_evidence->>'outboxId'`, '=', String(outboxId))
      .execute();
    expect(message).toHaveLength(1);
    expect(message[0]!.state).toBe('sent');
    expect(message[0]!.provider).toBe('simulator');
    expect(message[0]!.provider_message_id).toMatch(/^sim-/);
    expect(await crypto.decrypt(tenantId, message[0]!.body_enc)).toBe(text.body);
    expect(await crypto.decrypt(tenantId, message[0]!.to_enc)).toBe('+13145550199');
  });

  it('suppresses a text to a number without opt-in and records why (docs/06)', async () => {
    const party = await db
      .selectFrom('cg.report')
      .select('reporter_party_id')
      .where('id', '=', firstReportId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('cg.party')
      .set({ sms_opt_in: false })
      .where('id', '=', party.reporter_party_id!)
      .execute();
    const before = sms.sent.length;
    await messageSend(ctx, {
      id: 900_000_000 + Math.floor(Math.random() * 99_999_999), // outbox ids are unique in production; this run's stays unique across re-runs
      tenantId,
      topic: 'message.send',
      payload: {
        template: 'withdrawn',
        channel: 'sms',
        toEnc: (await crypto.encrypt(tenantId, '+13145550199')).toString('base64'),
        language: 'en',
        reportId: firstReportId,
        partyId: party.reporter_party_id,
        variables: { referenceCode: 'KXMR-4827' },
      },
      executionId: null,
    });
    expect(sms.sent.length).toBe(before);
    const suppressed = await db
      .selectFrom('cg.message')
      .select(['state', 'error'])
      .where('report_id', '=', firstReportId)
      .where('template', '=', 'withdrawn')
      .executeTakeFirstOrThrow();
    expect(suppressed).toEqual({ state: 'failed', error: 'no_sms_opt_in' });
    await db
      .updateTable('cg.party')
      .set({ sms_opt_in: true })
      .where('id', '=', party.reporter_party_id!)
      .execute();
  });

  async function uploadPhoto(
    executionId: string,
    reportId: string | null,
    bytes: Buffer,
  ): Promise<string> {
    const id = await withTenant(db, { tenantId }, async (trx) => {
      const row = await trx
        .insertInto('cg.photo')
        .values({
          tenant_id: tenantId,
          execution_id: executionId,
          report_id: reportId,
          shot: 'exterior',
          source: 'web',
          object_key_original: '',
          content_type: 'image/jpeg',
          bytes: bytes.length,
          status: 'uploaded',
          uploaded_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const key = `tenants/${tenantId}/originals/${executionId}/${row.id}`;
      await trx
        .updateTable('cg.photo')
        .set({ object_key_original: key })
        .where('id', '=', row.id)
        .execute();
      store.set(key, { body: bytes, contentType: 'image/jpeg' });
      return row.id;
    });
    return id;
  }

  const photoBytes = async () =>
    sharp({ create: { width: 1200, height: 900, channels: 3, background: '#884422' } })
      .jpeg()
      .withExif({ IFD0: { ImageDescription: 'gps and names would be here' } })
      .toBuffer();

  it('processes an uploaded photo: metadata-free derivatives, no detector → restricted (PHO-06/07)', async () => {
    const bytes = await photoBytes();
    const photoId = await uploadPhoto(firstExecution, firstReportId, bytes);
    await photoProcess(ctx, {
      id: 1,
      tenantId,
      topic: 'photo.process',
      payload: { photoId },
      executionId: null,
    });
    const photo = await db
      .selectFrom('cg.photo')
      .selectAll()
      .where('id', '=', photoId)
      .executeTakeFirstOrThrow();
    expect(photo.status).toBe('processed');
    expect(photo.exif_stripped).toBe(true);
    expect(photo.blur_status).toBe('skipped_no_detector');
    expect(photo.width).toBe(1200);
    expect(photo.sha256).not.toBeNull();
    const keys = photo.derivative_keys as Record<string, string>;
    expect(Object.keys(keys).sort()).toEqual(['review', 'thumb']);
    expect(keys['review']).toContain('/restricted/');
    const review = store.get(keys['review']!)!;
    expect(review.contentType).toBe('image/webp');
    expect((await sharp(review.body).metadata()).exif).toBeUndefined();
    await photoProcess(ctx, {
      id: 1,
      tenantId,
      topic: 'photo.process',
      payload: { photoId },
      executionId: null,
    }); // idempotent
  });

  it('flags the report when the same photo bytes arrive on another report (PHO-15)', async () => {
    const bytes = await photoBytes();
    const other = await db
      .selectFrom('cg.report')
      .select(['id', 'execution_id'])
      .where('tenant_id', '=', tenantId)
      .where('id', '<>', firstReportId)
      .orderBy('submitted_at', 'desc')
      .executeTakeFirstOrThrow();
    const photoId = await uploadPhoto(other.execution_id, other.id, bytes);
    await photoProcess(ctx, {
      id: 2,
      tenantId,
      topic: 'photo.process',
      payload: { photoId },
      executionId: null,
    });
    const report = await db
      .selectFrom('cg.report')
      .select('flags')
      .where('id', '=', other.id)
      .executeTakeFirstOrThrow();
    // Earlier runs of this suite leave twins behind too; the newest twin is this run's first report.
    const dup = (report.flags as ReportFlag[]).filter((f) => f.kind === 'duplicate_photo');
    expect(dup.length).toBeGreaterThan(0);
    expect(dup.every((f) => f.photoId === photoId)).toBe(true);
    expect(dup.some((f) => f.reportId === firstReportId)).toBe(true);
  });

  it('keeps the reference-code pool topped up (INT-22)', async () => {
    await topUpReferenceCodes(ctx, 500, 600);
    const free = await db
      .selectFrom('cg.reference_code')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId)
      .where('state', '=', 'free')
      .executeTakeFirstOrThrow();
    expect(Number(free.n)).toBeGreaterThanOrEqual(500);
  });

  it('keeps a submission that cannot be filed, with its error, for a person (SCL-06)', async () => {
    const executionId = randomUUID();
    await store_(executionId, {
      answers: answers(address),
      graphKey: 'no-such-graph',
      graphVersion: 9,
    });
    await sweepStoredSubmissions(ctx);
    const row = await db
      .selectFrom('cg.intake_submission')
      .select(['status', 'attempts', 'last_error'])
      .where('execution_id', '=', executionId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('stored');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('no-such-graph');
  });
});
