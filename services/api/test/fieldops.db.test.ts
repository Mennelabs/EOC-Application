/**
 * Hazards, field messages, reminders, badges, net control and the logs
 * against a real PostgreSQL (layer-4 task E; HAZ-01, BRD:FR-04.03–04.05,
 * AC-04A/B/C, DSP-06, FR-17.05, REM-01, BRD:FR-09.01–09.06, AC-09A/B/C,
 * BDG-01/02, BRD:FR-13.01–13.06, AC-13A/B/C, RULE-11, DSP-10, DSP-11,
 * SEC-18): an AI-suggested hazard stays unverified until a person accepts
 * it; clearing keeps the original and its history; restricted detail shows
 * only to the counseling category and every such read is audited; a message
 * to a team gets a receipt per member, a text fallback for the member with
 * no recent app contact (the message row is linked once the worker sends),
 * and the member's own read and acknowledgement; a reminder is shared state
 * that survives reload, acknowledgement is not completion, completion needs
 * a persisted update, two completions do not double up; a badge's generated,
 * print requested, confirmed and handed out are separate facts, the code
 * returns once and hashes at rest, verification answers valid, revoked or
 * unknown with name, agency and label only; net control's status and
 * position heard land on the team; the activity log carries it all.
 * Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorSms } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { sql, type Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../../worker/src/idp/keycloak.ts';
import { watchReminders } from '../../worker/src/jobs/field.ts';
import { messageSend } from '../../worker/src/jobs/messages.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { submitIntake } from '../src/public/submit.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routes } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Hazard {
  id: string;
  version: number;
  state: string;
  severity: string;
  unverified: boolean;
  aiSuggested: boolean;
  details?: string | null;
  position: { lat: number } | null;
  clearedReason: string | null;
  history?: { kind: string; toState: string | null; reason: string | null }[];
}
interface Message {
  id: string;
  recipientCount: number;
  receipts?: {
    personnelId: string;
    channel: string;
    readAt: string | null;
    acknowledgedAt: string | null;
    smsMessageId: string | null;
  }[];
  mine?: { readAt: string | null; acknowledgedAt: string | null } | null;
}
interface Reminder {
  id: string;
  version: number;
  state: string;
  overdue: boolean;
  snoozedUntil: string | null;
  completion: { kind: string; id: string } | null;
  escalatedAt: string | null;
  history?: { kind: string }[];
}
interface Badge {
  id: string;
  version: number;
  state: string;
  code?: string;
  printConfirmedAt: string | null;
  history?: { kind: string }[];
}

describe.skipIf(!appUrl || !workerUrl)(
  'hazards, messages, reminders, badges, net control (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let tenants: Record<string, string>;
    let subjects: Record<string, AccountSubject>;
    let eventId: string;
    let teamId: string;
    let members: { personnel_id: string; role: string }[];
    let worker: JobContext;
    let clock = Date.now();
    const sms = new SimulatorSms();
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
    const headers = (who: string, extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${who}`,
      ...extra,
    });
    const confirmed = (reason: string, version?: number) => ({
      'x-confirm': 'true',
      'x-reason': reason,
      ...(version !== undefined ? { 'if-match': String(version) } : {}),
    });
    const call = async (
      who: string,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const res = await app.inject({
        method,
        url,
        headers: headers(who, extra),
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
    };

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      tenants = seeded.tenants;
      const county = tenants['county']!;
      const paths = Object.fromEntries(
        (
          await dbWorker
            .selectFrom('cg.tenant')
            .select(['id', 'path', 'kind'])
            .where('id', 'in', Object.values(tenants))
            .execute()
        ).map((t) => [t.id, t]),
      );
      eventId = (
        await dbWorker
          .selectFrom('cg.event')
          .select('id')
          .where('tenant_id', '=', county)
          .where('intake_slug', '=', 'westwind')
          .executeTakeFirstOrThrow()
      ).id;
      // Damage Assessment Team 2: three members; the first gets an app account with a recent device, the second a phone and no app.
      const team = await dbWorker
        .selectFrom('cg.team')
        .select('id')
        .where('tenant_id', '=', county)
        .where('key', '=', 'da-2')
        .executeTakeFirstOrThrow();
      teamId = team.id;
      members = await dbWorker
        .selectFrom('cg.team_member')
        .select(['personnel_id', 'role'])
        .where('team_id', '=', teamId)
        .where('left_at', 'is', null)
        .orderBy('joined_at')
        .execute();
      const ensureAccount = async (email: string, personnelId: string) => {
        const existing = await dbWorker
          .selectFrom('cg.account')
          .select('id')
          .where('tenant_id', '=', county)
          .where('email', '=', email)
          .executeTakeFirst();
        const id =
          existing?.id ??
          (
            await dbWorker
              .insertInto('cg.account')
              .values({
                tenant_id: county,
                email,
                display_name: email,
                status: 'active',
                activated_at: new Date(),
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        await dbWorker
          .updateTable('cg.personnel')
          .set({ account_id: id })
          .where('id', '=', personnelId)
          .execute();
        return id;
      };
      const appUser = await ensureAccount('da2.app@example.org', members[0]!.personnel_id);
      const existingDevice = await dbWorker
        .selectFrom('cg.field_device')
        .select('id')
        .where('account_id', '=', appUser)
        .executeTakeFirst();
      if (existingDevice)
        await dbWorker
          .updateTable('cg.field_device')
          .set({ status: 'active', last_contact_at: new Date() })
          .where('id', '=', existingDevice.id)
          .execute();
      else
        await dbWorker
          .insertInto('cg.field_device')
          .values({
            tenant_id: county,
            account_id: appUser,
            install_id: `da2-${randomUUID()}`,
            platform: 'android',
            last_contact_at: new Date(),
            created_by: appUser,
            updated_by: appUser,
          })
          .execute();
      // The second member has a phone on file and no app.
      await dbWorker
        .updateTable('cg.personnel')
        .set({
          contact_enc: await crypto.encrypt(county, JSON.stringify({ phone: '+13145550144' })),
          phone_bidx: await crypto.blindIndex(county, 'phone', '+13145550144'),
        })
        .where('id', '=', members[1]!.personnel_id)
        .execute();
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
          tenantPath: paths[tenantId]!.path,
          tenantKind: paths[tenantId]!.kind,
          status: 'active',
          roles: [
            {
              roleId: randomUUID(),
              key: t.key,
              version: 1,
              templateKey: t.key,
              grants: t.grants,
              scope: { eventIds: [eventId] },
            },
          ],
          resolvedAt: new Date(),
        };
      };
      subjects = {
        priya: subjectFor(
          'county',
          'field_coordinator',
          seeded.accounts['priya.assessment@example.org']!,
        ),
        counselor: subjectFor('county', 'crisis_counselor', randomUUID()),
        coordinator: subjectFor('county', 'personnel_coordinator', randomUUID()),
        net: subjectFor('county', 'net_control', randomUUID()),
        reception: subjectFor('county', 'volunteer_reception', randomUUID()),
        checkpoint: subjectFor('county', 'checkpoint_officer', randomUUID()),
        appUser: subjectFor('county', 'damage_assessor', appUser),
        calltaker: subjectFor('county', 'dispatcher_call_taker', randomUUID()),
        pio: subjectFor(
          'county',
          'public_information_officer',
          seeded.accounts['tomas.pio@example.org']!,
        ),
      };
      const loader: SubjectLoader = {
        async fromBearer(token) {
          const s = subjects[token];
          if (!s) throw new AuthError('invalid_token');
          return s;
        },
      };
      const resolver = new TenantResolver(dbApp);
      const codes = new ReferenceCodeLeaser(dbApp, 'test');
      const risk = new RiskScorer();
      const submitDeps = {
        codes,
        risk,
        getQueue: () => undefined,
        defaultGraph: westwindGraph,
        crypto,
        now: () => new Date(),
      };
      const ai = { providerFor: async () => fakeProvider };
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
        reportDeps: { ai, submit: (req, input) => submitIntake(submitDeps, req, input) },
        publicRoutes: [
          publicRoutes({
            resolver,
            codes,
            risk,
            getQueue: () => undefined,
            residentTokenSecret: 'test-secret-'.repeat(4),
            defaultGraph: westwindGraph,
            ai,
          }),
        ],
      });
      worker = {
        db: dbWorker,
        log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as JobContext['log'],
        idp: {} as unknown as KeycloakAdmin,
        mail: { send: async () => undefined },
        sms,
        crypto,
        urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
        objects: null,
        devDirectGrant: false,
        ai,
        defaultGraph: westwindGraph,
        now: () => new Date(clock),
      };
      // Clean slate for the team: shifts from earlier local runs.
      await dbWorker
        .updateTable('cg.check_in')
        .set({ ended_at: new Date(), end_reason: 'shift_end' })
        .where('team_id', '=', teamId)
        .where('ended_at', 'is', null)
        .execute();
    });

    afterAll(async () => {
      await app?.close();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    it('hazards: an AI suggestion stays unverified until accepted (AC-04A); correction and clearing keep the original and its reason (AC-04B); restricted detail only to the counseling category, audited (AC-04C)', async () => {
      const suggested = await call('priya', 'POST', '/api/v1/hazards', {
        eventId,
        kind: 'gas_leak',
        severity: 'danger',
        summary: 'Possible gas smell reported in a photo caption',
        position: { lat: 38.8, lon: -90.835 },
        radiusM: 80,
        source: 'ai_suggested',
      });
      expect(suggested.status, suggested.body).toBe(201);
      let h = suggested.json<Hazard>();
      expect(h.unverified).toBe(true);
      expect(h.state).toBe('reported');
      const confirmedH = await call(
        'priya',
        'POST',
        `/api/v1/hazards/${h.id}/confirm`,
        { note: 'Utility crew confirmed by phone' },
        { 'if-match': String(h.version) },
      );
      expect(confirmedH.status, confirmedH.body).toBe(200);
      h = confirmedH.json<Hazard>();
      expect(h.unverified).toBe(false);
      expect(h.aiSuggested).toBe(true);
      expect(h.history!.map((e) => e.kind)).toEqual(['reported', 'accepted']);
      const corrected = await call(
        'priya',
        'POST',
        `/api/v1/hazards/${h.id}/correct`,
        { severity: 'caution', reason: 'Meter shut; residual smell only' },
        { 'if-match': String(h.version) },
      );
      expect(corrected.status, corrected.body).toBe(200);
      h = corrected.json<Hazard>();
      expect(h.severity).toBe('caution');
      expect(h.state).toBe('corrected');
      const cleared = await call(
        'priya',
        'POST',
        `/api/v1/hazards/${h.id}/clear`,
        undefined,
        confirmed('Utility cleared the block', h.version),
      );
      expect(cleared.status, cleared.body).toBe(200);
      h = cleared.json<Hazard>();
      expect(h.state).toBe('cleared');
      expect(h.clearedReason).toBe('Utility cleared the block');
      expect(h.history!.map((e) => e.kind)).toEqual([
        'reported',
        'accepted',
        'corrected',
        'cleared',
      ]);
      expect(h.history![0]!.toState).toBe('reported'); // the original entry stays
      // A restricted behavioural-health hazard: detail only for counseling; the coordinator sees the kind, not the detail.
      const sensitive = await call('calltaker', 'POST', '/api/v1/hazards', {
        eventId,
        kind: 'mental_health_crisis',
        severity: 'danger',
        summary: 'Caller worried about a neighbour',
        details: 'Said they do not want to go on; has medication at home.',
        position: { lat: 38.795, lon: -90.87 },
        source: 'call',
      });
      expect(sensitive.status, sensitive.body).toBe(201);
      const sid = sensitive.json<Hazard>().id;
      const coordinatorView = await call('priya', 'GET', `/api/v1/hazards/${sid}`);
      expect(coordinatorView.status).toBe(200);
      expect(coordinatorView.json<Hazard>().details).toBeUndefined();
      const counselorView = await call('counselor', 'GET', `/api/v1/hazards/${sid}`);
      expect(counselorView.status, counselorView.body).toBe(200);
      expect(counselorView.json<Hazard>().details).toContain('medication');
      const stored = await dbWorker
        .selectFrom('cg.hazard')
        .select('details_enc')
        .where('id', '=', sid)
        .executeTakeFirstOrThrow();
      expect(stored.details_enc!.toString('utf8')).not.toContain('medication');
      const reads = await dbWorker
        .selectFrom('cg.audit_event')
        .select('classification_read')
        .where('action', '=', 'hazard.read')
        .where('target_id', '=', sid)
        .execute();
      expect(reads.some((r) => (r.classification_read as string[]).includes('counseling'))).toBe(
        true,
      );
      expect((await call('pio', 'GET', `/api/v1/hazards/${sid}`)).status).toBe(404);
      // The open list near a point finds the sensitive one and not the cleared one.
      const near = (
        await call(
          'priya',
          'GET',
          `/api/v1/hazards?eventId=${eventId}&open=true&near=38.795,-90.87,500`,
        )
      ).json<Hazard[]>();
      expect(near.map((x) => x.id)).toContain(sid);
      expect(near.map((x) => x.id)).not.toContain(h.id);
    });

    it('DSP-06: a message to a team gets a receipt per member, a text for the member without the app, and the reader’s own read and acknowledgement', async () => {
      const sent = await call(
        'priya',
        'POST',
        '/api/v1/field-messages',
        {
          eventId,
          body: 'Route 2: skip Juniper Ct until the line is cleared.',
          audience: { kind: 'team', teamId },
          requiresAck: true,
          priority: 'high',
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(sent.status, sent.body).toBe(201);
      const m = sent.json<Message>();
      expect(m.recipientCount).toBe(members.length);
      const withPhone = m.receipts!.find((r) => r.personnelId === members[1]!.personnel_id)!;
      expect(withPhone.channel).toBe('sms');
      expect(m.receipts!.find((r) => r.personnelId === members[0]!.personnel_id)!.channel).toBe(
        'app',
      );
      // The worker sends the text through the message pipeline and the receipt records the message row.
      const queued = await dbWorker
        .selectFrom('cg.outbox')
        .select(['id', 'tenant_id', 'topic', 'payload', 'execution_id'])
        .where('tenant_id', '=', tenants['county']!)
        .where('topic', '=', 'message.send')
        .where(sql`payload->>'template'`, '=', 'field_message')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      await messageSend(worker, {
        id: Number(queued.id),
        tenantId: queued.tenant_id,
        topic: queued.topic,
        payload: queued.payload as Record<string, unknown>,
        executionId: queued.execution_id,
      });
      const receiptRow = await dbWorker
        .selectFrom('cg.field_message_receipt')
        .select(['sms_message_id', 'channel'])
        .where('message_id', '=', m.id)
        .where('personnel_id', '=', members[1]!.personnel_id)
        .executeTakeFirstOrThrow();
      expect(receiptRow.sms_message_id).not.toBeNull();
      const text = await dbWorker
        .selectFrom('cg.message')
        .select(['state', 'template', 'channel'])
        .where('id', '=', receiptRow.sms_message_id!)
        .executeTakeFirstOrThrow();
      expect(text).toMatchObject({ state: 'sent', template: 'field_message', channel: 'sms' });
      // The app user reads and acknowledges; the sender sees the receipts.
      const mine = (
        await call('appUser', 'GET', `/api/v1/field-messages?mine=true&unread=true`)
      ).json<Message[]>();
      expect(mine.map((x) => x.id)).toContain(m.id);
      const read = await call('appUser', 'POST', `/api/v1/field-messages/${m.id}/receipt`, {
        read: true,
        acknowledged: true,
      });
      expect(read.status, read.body).toBe(200);
      const after = (await call('priya', 'GET', `/api/v1/field-messages?eventId=${eventId}`))
        .json<Message[]>()
        .find((x) => x.id === m.id)!;
      expect(
        after.receipts!.find((r) => r.personnelId === members[0]!.personnel_id)!.acknowledgedAt,
      ).not.toBeNull();
      expect(
        (await call('appUser', 'GET', `/api/v1/field-messages?mine=true&unread=true`))
          .json<Message[]>()
          .map((x) => x.id),
      ).not.toContain(m.id);
      expect(
        (
          await call(
            'pio',
            'POST',
            '/api/v1/field-messages',
            { eventId, body: 'x', audience: { kind: 'event' } },
            { 'idempotency-key': randomUUID() },
          )
        ).status,
      ).toBe(403);
    });

    it('F09: a reminder is shared state (AC-09A); acknowledgement is not completion; completion needs a persisted update (AC-09B); two completions do not double up (AC-09C); overdue and escalation on the worker clock', async () => {
      const dueAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const created = await call('priya', 'POST', '/api/v1/reminders', {
        eventId,
        kind: 'call_back',
        title: 'Call the Cedar Ct caller back',
        dueAt,
        escalateToRole: 'field_coordinator',
        escalateAfterMinutes: 10,
      });
      expect(created.status, created.body).toBe(201);
      let r = created.json<Reminder>();
      // Another person, another device: the same reminder, from the database (AC-09A).
      const reloaded = await call('calltaker', 'GET', `/api/v1/reminders/${r.id}`);
      expect(reloaded.status).toBe(200);
      expect(reloaded.json<Reminder>().state).toBe('active');
      const snoozed = await call(
        'calltaker',
        'POST',
        `/api/v1/reminders/${r.id}/snooze`,
        { minutes: 1 },
        { 'if-match': String(r.version) },
      );
      expect(snoozed.status, snoozed.body).toBe(200);
      r = snoozed.json<Reminder>();
      expect(r.snoozedUntil).not.toBeNull();
      // 7 minutes on: overdue; 20 minutes on: escalated once with an email queued.
      clock = Date.now() + 7 * 60_000;
      await watchReminders(worker);
      r = (await call('priya', 'GET', `/api/v1/reminders/${r.id}`)).json<Reminder>();
      expect(r.state).toBe('overdue');
      expect(r.overdue).toBe(true);
      clock = Date.now() + 20 * 60_000;
      await watchReminders(worker);
      await watchReminders(worker);
      r = (await call('priya', 'GET', `/api/v1/reminders/${r.id}`)).json<Reminder>();
      expect(r.escalatedAt).not.toBeNull();
      const escalations = (
        await dbWorker
          .selectFrom('cg.outbox')
          .select('payload')
          .where('tenant_id', '=', tenants['county']!)
          .where('topic', '=', 'message.send')
          .execute()
      ).filter((n) => (n.payload as { reminderId?: string }).reminderId === r.id);
      expect(escalations.length).toBeGreaterThanOrEqual(1);
      expect(r.history!.filter((e) => e.kind === 'escalated')).toHaveLength(1);
      // Acknowledged is a state of its own; the reminder stays open (FR-09.03).
      const acked = await call(
        'priya',
        'POST',
        `/api/v1/reminders/${r.id}/acknowledge`,
        undefined,
        { 'if-match': String(r.version) },
      );
      expect(acked.status, acked.body).toBe(200);
      r = acked.json<Reminder>();
      expect(r.state).toBe('acknowledged');
      expect(r.completion).toBeNull();
      // Completion against an update that was never saved is refused and leaves the reminder open (AC-09B).
      const phantom = await call(
        'priya',
        'POST',
        `/api/v1/reminders/${r.id}/complete`,
        { completion: { kind: 'mission_event', id: randomUUID() } },
        { 'if-match': String(r.version) },
      );
      expect(phantom.status).toBe(409);
      expect(phantom.json<{ code: string }>().code).toBe('update_not_persisted');
      expect((await call('priya', 'GET', `/api/v1/reminders/${r.id}`)).json<Reminder>().state).toBe(
        'acknowledged',
      );
      // Two people complete at once: the first wins, the second gets the current record (AC-09C).
      const done = await call(
        'priya',
        'POST',
        `/api/v1/reminders/${r.id}/complete`,
        { completion: { kind: 'note', note: 'Spoke with the caller; neighbour is safe' } },
        { 'if-match': String(r.version) },
      );
      expect(done.status, done.body).toBe(200);
      expect(done.json<Reminder>().state).toBe('completed');
      expect(done.json<Reminder>().completion?.kind).toBe('note');
      const twice = await call(
        'calltaker',
        'POST',
        `/api/v1/reminders/${r.id}/complete`,
        { completion: { kind: 'note', note: 'again' } },
        { 'if-match': String(r.version) },
      );
      expect([400, 409]).toContain(twice.status);
      const events = await dbWorker
        .selectFrom('cg.reminder_event')
        .select('kind')
        .where('reminder_id', '=', r.id)
        .execute();
      expect(events.filter((e) => e.kind === 'completed')).toHaveLength(2); // the update note, then the completion that rests on it
    });

    it("BRD:FR-09.06: during the county's quiet hours an escalation waits, and goes out when they end", async () => {
      const created = await call('priya', 'POST', '/api/v1/reminders', {
        eventId,
        kind: 'call_back',
        title: 'Exercise: call the Birch Ln caller back',
        dueAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        escalateToRole: 'field_coordinator',
        escalateAfterMinutes: 10,
      });
      expect(created.status, created.body).toBe(201);
      const id = created.json<Reminder>().id;
      // A quiet window around the worker's clock, on the county's clock (America/Chicago).
      clock = Date.now() + 20 * 60_000;
      const local = (at: number) =>
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'America/Chicago',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(at));
      const county = tenants['county']!;
      await dbWorker
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: county,
          key: 'reminders.quiet_hours',
          value: JSON.stringify({
            start: local(clock - 60 * 60_000),
            end: local(clock + 60 * 60_000),
          }),
        } as never)
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'key']).doUpdateSet({
            value: JSON.stringify({
              start: local(clock - 60 * 60_000),
              end: local(clock + 60 * 60_000),
            }),
          } as never),
        )
        .execute();
      try {
        await watchReminders(worker);
        let r = (await call('priya', 'GET', `/api/v1/reminders/${id}`)).json<Reminder>();
        expect(r.state).toBe('overdue');
        expect(r.escalatedAt).toBeNull();
        // The quiet hours end: the escalation goes out on the next pass, once.
        clock = Date.now() + 20 * 60_000 + 2 * 60 * 60_000;
        await watchReminders(worker);
        await watchReminders(worker);
        r = (await call('priya', 'GET', `/api/v1/reminders/${id}`)).json<Reminder>();
        expect(r.escalatedAt).not.toBeNull();
        expect(r.history!.filter((e) => e.kind === 'escalated')).toHaveLength(1);
        const mail = (
          await dbWorker
            .selectFrom('cg.outbox')
            .select('payload')
            .where('tenant_id', '=', county)
            .where('topic', '=', 'message.send')
            .execute()
        ).find((n) => (n.payload as { reminderId?: string }).reminderId === id);
        // The due time is on the county's clock with its zone named (BRD:FR-00.08).
        expect((mail!.payload as { variables: { dueAt: string } }).variables.dueAt).toMatch(
          / C[DS]T$/,
        );
      } finally {
        await dbWorker
          .deleteFrom('cg.tenant_config')
          .where('tenant_id', '=', county)
          .where('key', '=', 'reminders.quiet_hours')
          .execute();
      }
    });

    it('F09: a reminder acknowledged while the timer marks it overdue keeps the acknowledgement', async () => {
      const created = await call('priya', 'POST', '/api/v1/reminders', {
        eventId,
        kind: 'call_back',
        title: 'Exercise: acknowledged as the timer runs',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(created.status, created.body).toBe(201);
      const id = created.json<Reminder>().id;
      clock = Date.now() + 5 * 60_000;
      // Someone acknowledges it: the row is theirs until they commit.
      let go!: () => void;
      const released = new Promise<void>((r) => (go = r));
      let locked!: () => void;
      const holding = new Promise<void>((r) => (locked = r));
      const person = withTenant(dbWorker, { tenantId: tenants['county']! }, async (trx) => {
        await trx
          .updateTable('cg.reminder')
          .set({ state: 'acknowledged' })
          .where('id', '=', id)
          .execute();
        locked();
        await released;
      });
      await holding;
      // The timer read it as due and waits on that row (the check uses the other pool).
      const timer = watchReminders(worker);
      try {
        for (let i = 0; ; i++) {
          const { rows } = await sql<{
            n: number;
          }>`select count(*)::int as n from pg_locks where not granted`.execute(dbApp);
          if (rows[0]!.n > 0) break;
          if (i > 1200) throw new Error('the timer never waited on the acknowledged reminder');
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        go();
      }
      await Promise.all([person, timer]);
      const r = (await call('priya', 'GET', `/api/v1/reminders/${id}`)).json<Reminder>();
      expect(r.state).toBe('acknowledged');
      expect(r.history!.filter((e) => e.kind === 'overdue')).toEqual([]);
    }, 60_000);

    it('badges: generated, print requested, confirmed and handed out are separate facts (AC-13A, RULE-11); the code returns once; verification answers with name, agency and label only (AC-13B/C)', async () => {
      const generated = await call('reception', 'POST', '/api/v1/badges', {
        personnelId: members[0]!.personnel_id,
        eventId,
        accessLabel: 'FIELD',
        validDays: 7,
      });
      expect(generated.status, generated.body).toBe(201);
      let b = generated.json<Badge>();
      expect(b.state).toBe('generated');
      expect(b.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(b.printConfirmedAt).toBeNull(); // AC-13A: generating is not printing
      const code = b.code!;
      const again = (await call('reception', 'GET', `/api/v1/badges/${b.id}`)).json<Badge>();
      expect(again.code).toBeUndefined(); // the code is on the badge, not in the database or the API
      const stored = await dbWorker
        .selectFrom('cg.badge')
        .select('code_hash')
        .where('id', '=', b.id)
        .executeTakeFirstOrThrow();
      expect(stored.code_hash.toString('utf8')).not.toContain(code.slice(0, 4));
      // Not printed yet: a checkpoint says so.
      const early = await call('checkpoint', 'POST', '/api/v1/badges/verify', {
        code,
        checkpoint: 'Route 94 perimeter',
      });
      expect(early.json<{ result: string }>().result).toBe('not_yet_printed');
      const requested = await call(
        'reception',
        'POST',
        `/api/v1/badges/${b.id}/print`,
        { outcome: 'requested' },
        { 'if-match': String(b.version) },
      );
      expect(requested.status, requested.body).toBe(200);
      b = requested.json<Badge>();
      expect(b.state).toBe('print_requested');
      const failed = await call(
        'reception',
        'POST',
        `/api/v1/badges/${b.id}/print`,
        { outcome: 'failed', reason: 'Printer jam' },
        { 'if-match': String(b.version) },
      );
      b = failed.json<Badge>();
      expect(b.state).toBe('print_failed');
      const requested2 = await call(
        'reception',
        'POST',
        `/api/v1/badges/${b.id}/print`,
        { outcome: 'requested' },
        { 'if-match': String(b.version) },
      );
      b = requested2.json<Badge>();
      const confirmedPrint = await call(
        'reception',
        'POST',
        `/api/v1/badges/${b.id}/print`,
        { outcome: 'confirmed' },
        { 'if-match': String(b.version) },
      );
      b = confirmedPrint.json<Badge>();
      expect(b.state).toBe('print_confirmed');
      expect(b.printConfirmedAt).not.toBeNull();
      const handed = await call(
        'reception',
        'POST',
        `/api/v1/badges/${b.id}/print`,
        { outcome: 'handed_out' },
        { 'if-match': String(b.version) },
      );
      b = handed.json<Badge>();
      expect(b.state).toBe('handed_out');
      const valid = await call('checkpoint', 'POST', '/api/v1/badges/verify', {
        code: code.toLowerCase(),
        checkpoint: 'Route 94 perimeter',
      });
      expect(valid.status, valid.body).toBe(200);
      const v = valid.json<{
        result: string;
        displayName?: string;
        accessLabel?: string;
        agency?: string;
      }>();
      expect(v.result).toBe('valid');
      expect(v.displayName).toBeTruthy();
      expect(v.accessLabel).toBe('FIELD');
      // "kind" tells the checkpoint a badge from a re-entry pass (FL:FR-03); nothing personal.
      expect(Object.keys(v).sort()).toEqual([
        'accessLabel',
        'agency',
        'displayName',
        'kind',
        'result',
        'roleLabel',
        'validTo',
      ]);
      expect((v as { kind?: string }).kind).toBe('badge');
      expect(
        (
          await call('checkpoint', 'POST', '/api/v1/badges/verify', { code: 'ZZZZ-ZZZZ-ZZZZ' })
        ).json<{ result: string }>().result,
      ).toBe('unknown');
      // Revocation is visible to verification at once (AC-13B); the checkpoint officer and the field coordinator cannot revoke.
      expect(
        (
          await call(
            'checkpoint',
            'POST',
            `/api/v1/badges/${b.id}/revoke`,
            undefined,
            confirmed('x', b.version),
          )
        ).status,
      ).toBe(404);
      const revoked = await call(
        'coordinator',
        'POST',
        `/api/v1/badges/${b.id}/revoke`,
        undefined,
        confirmed('Left the exercise', b.version),
      );
      expect(revoked.status, revoked.body).toBe(200);
      expect(
        (await call('checkpoint', 'POST', '/api/v1/badges/verify', { code })).json<{
          result: string;
        }>().result,
      ).toBe('revoked');
      expect(revoked.json<Badge>().history!.map((e) => e.kind)).toEqual(
        expect.arrayContaining([
          'generated',
          'print_requested',
          'print_failed',
          'print_confirmed',
          'handed_out',
          'verified',
          'revoked',
        ]),
      );
    });

    it('DSP-10 / FLD-17: net control logs status and position heard against the team; the activity log and significant events carry the day (DSP-11)', async () => {
      const lead = members.find((m) => m.role === 'lead')!;
      const checkedIn = await call('priya', 'POST', '/api/v1/check-ins', {
        eventId,
        personnelId: lead.personnel_id,
        teamId,
        method: 'console',
      });
      expect(checkedIn.status, checkedIn.body).toBe(201);
      const heard = await call('net', 'POST', '/api/v1/comms-log', {
        eventId,
        net: 'County ARES',
        kind: 'status_heard',
        fromStation: 'DA-2',
        toStation: 'NET',
        teamId,
        status: 'on_task',
        message: 'DA-2 on task at Prairie Lakes',
      });
      expect(heard.status, heard.body).toBe(201);
      expect(heard.json<{ teamStatusId: string | null }>().teamStatusId).not.toBeNull();
      const team = (await call('priya', 'GET', `/api/v1/teams/${teamId}`)).json<{
        current: { status: string; source: string };
      }>();
      expect(team.current).toMatchObject({ status: 'on_task', source: 'net_control' });
      const pos = await call('net', 'POST', '/api/v1/comms-log', {
        eventId,
        net: 'County ARES',
        kind: 'position_heard',
        fromStation: 'DA-2',
        teamId,
        position: { lat: 38.8, lon: -90.835 },
        usng: '15S YC 1234 5678',
      });
      expect(pos.status, pos.body).toBe(201);
      expect(
        pos.json<{ positionRecordedAt: string | null; message: string }>().positionRecordedAt,
      ).not.toBeNull();
      const latest = (
        await call('priya', 'GET', `/api/v1/positions/latest?eventId=${eventId}&teamId=${teamId}`)
      ).json<{ source: string; lat: number }[]>();
      expect(latest.some((p) => p.source === 'net_control')).toBe(true);
      // Net control cannot read missions' resident details or send messages; it reads its own log.
      expect(
        (await call('net', 'GET', `/api/v1/comms-log?eventId=${eventId}&net=County%20ARES`)).json<
          unknown[]
        >().length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        (
          await call(
            'net',
            'POST',
            '/api/v1/field-messages',
            { eventId, body: 'x', audience: { kind: 'team', teamId } },
            { 'idempotency-key': randomUUID() },
          )
        ).status,
      ).toBe(403);
      const activity = (await call('priya', 'GET', `/api/v1/activity?teamId=${teamId}`)).json<
        { kind: string; summary: string }[]
      >();
      expect(activity.map((a) => a.kind)).toEqual(
        expect.arrayContaining(['check_in', 'status', 'note', 'message']),
      );
      const note = await call('priya', 'POST', '/api/v1/significant-events', {
        eventId,
        kind: 'briefing',
        summary: 'Operational period 2 briefing held',
      });
      expect(note.status, note.body).toBe(201);
      const log = (
        await call('priya', 'GET', `/api/v1/significant-events?eventId=${eventId}`)
      ).json<{ kind: string }[]>();
      expect(log.map((e) => e.kind)).toEqual(
        expect.arrayContaining(['briefing', 'hazard', 'mission_opened']),
      );
      await call('priya', 'POST', `/api/v1/check-ins/${checkedIn.json<{ id: string }>().id}/end`, {
        reason: 'coordinator',
      });
    });
  },
);
