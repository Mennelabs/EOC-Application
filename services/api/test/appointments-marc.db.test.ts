/**
 * Appointments and the recovery centre against the database (FL:FR-12,
 * FL:FR-18, SEC-05, SEC-18, RULE-14; plan §3.4–3.5, §5.3, §5.5). A caseworker
 * schedules an appointment: the survivor who opted in gets a Spanish text with
 * the time and place and never the purpose; the worker's reminder job queues
 * one reminder the day before and none for an appointment made the same day;
 * a survivor with no opted-in channel gets nothing and the appointment says
 * so. At the MARC the door checks a survivor in with the tables to see; the
 * SBA representative sees only the visits with a stop at its table and only
 * its own hand-off notes; a hand-off moves the visit on with its one-line why;
 * the queue never carries an address. Runs only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { SimulatorSms } from '@cg/adapters';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { remindAppointments } from '../../worker/src/jobs/appointments.ts';
import { messageSend } from '../../worker/src/jobs/messages.ts';
import type { JobContext, OutboxMessage } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Appointment {
  id: string;
  version: number;
  status: string;
  withLabel: string;
  place: string;
  purpose: string | null;
  noticeChannel: string | null;
  noticeSent: boolean;
  reminderQueuedAt: string | null;
  reminderSent: boolean;
  cancelReason: string | null;
  scheduledBy: string | null;
}
interface Case {
  id: string;
  version: number;
  appointments: Appointment[];
}
interface Stop {
  seq: number;
  tableLabel: string;
  tableTenantId: string | null;
  status: string;
  handoffNote: string | null;
  handedBy: string | null;
  yours: boolean;
}
interface Visit {
  id: string;
  version: number;
  label: string;
  status: string;
  currentTable: string | null;
  stops: Stop[];
}
interface Payload {
  template: string;
  channel: string;
  language: string;
  appointmentId?: string;
  appointmentNotice?: string;
  variables: Record<string, string>;
}

const HOUR = 3_600_000;

describe.skipIf(!appUrl || !workerUrl)(
  'appointments and the recovery centre (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let worker: JobContext;
    let county = '';
    let partner = '';
    let siteId = '';
    const cases: Record<string, string> = {};
    const run = randomUUID().slice(0, 8);
    const slug = `exercise-appt-${run}`;
    const people: Record<string, string> = {};
    const subjects: Record<string, AccountSubject> = {};
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());

    const call = async <T>(
      who: string,
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${who}`, ...headers },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, body: res.json() as T };
    };
    type Queued = Omit<OutboxMessage, 'payload'> & { payload: Payload };
    async function outbox(topic: string): Promise<Queued[]> {
      const rows = await dbWorker
        .selectFrom('cg.outbox')
        .select(['id', 'tenant_id', 'topic', 'payload', 'execution_id'])
        .where('tenant_id', '=', county)
        .where('topic', '=', topic)
        .orderBy('id')
        .execute();
      return rows.map((r) => ({
        id: Number(r.id),
        tenantId: r.tenant_id,
        topic: r.topic,
        payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Payload,
        executionId: r.execution_id,
      }));
    }

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      const tenant = (kind: 'county' | 'partner_org', parent: string, key: string) =>
        dbWorker
          .insertInto('cg.tenant')
          .values({
            kind,
            parent_id: parent,
            slug: `${slug}-${key}`,
            name: `Exercise ${key} ${run}`,
            status: 'active',
            locales: ['en', 'es'],
            timezone: 'America/Chicago',
          })
          .returning(['id', 'path', 'kind'])
          .executeTakeFirstOrThrow();
      const c = await tenant('county', seeded.tenants['region']!, 'county');
      county = c.id;
      const p = await tenant('partner_org', county, 'sba');
      partner = p.id;
      const cast = [
        ['caseworker', 'county_caseworker', 'Exercise County Caseworker', c],
        ['masscare', 'mass_care_coordinator', 'Exercise Mass Care Coordinator', c],
        ['pio', 'public_information_officer', 'Exercise PIO', c],
        ['sba', 'sba_representative', 'Exercise SBA Representative', p],
      ] as const;
      for (const [who, , name, t] of cast)
        await withTenant(dbWorker, { tenantId: t.id }, async (trx) => {
          people[who] = (
            await trx
              .insertInto('cg.account')
              .values({
                tenant_id: t.id,
                email: `${who}-${run}@example.org`,
                display_name: name,
                status: 'active',
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        });
      await withTenant(dbWorker, { tenantId: county }, async (trx) => {
        const eventId = (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: county,
              name: `Exercise appointment event ${run}`,
              hazard_type: 'tornado',
              status: 'active',
              intake_slug: `apptex${run}`,
              opened_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        siteId = (
          await trx
            .insertInto('cg.site')
            .values({
              tenant_id: county,
              event_id: eventId,
              kind: 'marc',
              name: `Exercise recovery centre ${run}`,
              slug: `marc-${run}`,
              status: 'open',
              created_by: null,
              updated_by: null,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        // Three survivors: opted in to texts (Spanish); email only; no way to reach.
        const households = [
          ['texts', { phone: '+15555550101' }, true, 'es'],
          ['email', { email: `survivor-${run}@example.org` }, false, 'en'],
          ['none', {}, false, 'en'],
        ] as const;
        for (const [key, contact, optIn, language] of households) {
          const party = await trx
            .insertInto('cg.party')
            .values({
              tenant_id: county,
              kind: 'resident',
              contact_enc: Object.keys(contact).length
                ? await crypto.encrypt(county, JSON.stringify(contact))
                : null,
              language,
              sms_opt_in: optIn,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const report = await trx
            .insertInto('cg.report')
            .values({
              tenant_id: county,
              event_id: eventId,
              reporter_party_id: party.id,
              reference_code: `SYN-${run}-${key.toUpperCase()}`,
              execution_id: randomUUID(),
              graph_key: 'damage',
              graph_version: 1,
              channel_of_origin: 'web',
              relationship: 'own_home',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          cases[key] = (
            await trx
              .insertInto('cg.case')
              .values({
                tenant_id: county,
                report_id: report.id,
                party_id: party.id,
                event_id: eventId,
                status: 'open',
                lead_tenant_id: county,
                opened_by: null,
                created_by: null,
                updated_by: null,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
          // The SBA table holds the grant for the texting household only.
          if (key === 'texts')
            await trx
              .insertInto('cg.share_grant')
              .values({
                tenant_id: county,
                to_tenant_id: partner,
                org_type: 'sba',
                report_id: report.id,
                sections: ['name', 'contact'],
                projection: JSON.stringify({}),
              })
              .execute();
        }
      });
      for (const [who, template, , t] of cast) {
        const r = roleTemplates.find((x) => x.key === template)!;
        subjects[who] = {
          kind: 'account',
          accountId: people[who]!,
          tenantId: t.id,
          tenantPath: t.path as string,
          tenantKind: t.kind,
          status: 'active',
          roles: [
            {
              roleId: randomUUID(),
              key: r.key,
              version: 1,
              templateKey: r.key,
              grants: r.grants,
              scope: {},
            },
          ],
          resolvedAt: new Date(),
        };
      }
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
        fieldCrypto: crypto,
        subjects: loader,
        routes: routesWith({}),
      });
      worker = {
        db: dbWorker,
        crypto,
        sms: new SimulatorSms(),
        mail: { send: async () => undefined },
        log: { info() {}, warn() {}, error() {}, debug() {} },
        urls: { gatewayPublic: 'https://cg.example.org', idpPublic: '', idpInternal: '' },
      } as unknown as JobContext;
    });

    afterAll(async () => {
      await app?.close();
      await dbWorker
        ?.updateTable('cg.tenant')
        .set({ status: 'closed' })
        .where('slug', 'like', `${slug}-%`)
        .execute();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    const inDays = (days: number, hour = 14) => {
      const d = new Date(Date.now() + days * 24 * HOUR);
      d.setUTCHours(hour, 30, 0, 0);
      return d;
    };
    let appt: Appointment;

    it('FL:FR-18: scheduling texts the survivor who opted in, in their language, with the time and place and never the purpose', async () => {
      const startsAt = inDays(3);
      const res = await call<Appointment>(
        'caseworker',
        'POST',
        `/cases/${cases['texts']}/appointments`,
        {
          withLabel: 'Exercise County Human Services',
          place: 'Harmon Community College, room 112',
          startsAt: startsAt.toISOString(),
          purpose: 'Rental assistance paperwork and duplication check',
        },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      appt = res.body;
      expect(appt).toMatchObject({
        status: 'scheduled',
        noticeChannel: 'sms',
        noticeSent: false,
        purpose: 'Rental assistance paperwork and duplication check',
        scheduledBy: 'Exercise County Caseworker',
      });
      const queued = (await outbox('message.send')).filter(
        (m) => m.payload.appointmentId === appt.id,
      );
      expect(queued).toHaveLength(1);
      const notice = queued[0]!;
      expect(notice.payload).toMatchObject({
        template: 'appointment',
        channel: 'sms',
        language: 'es',
        appointmentNotice: 'notice',
      });
      expect(notice.payload.variables).toEqual({
        when: expect.stringMatching(/ a las \d{2}:30$/),
        place: 'Harmon Community College, room 112',
        withOrg: 'Exercise County Human Services',
      });
      expect(JSON.stringify(notice.payload)).not.toContain('Rental assistance');
      // The worker sends it and the appointment records the message.
      await messageSend(worker, notice as unknown as OutboxMessage);
      const message = await dbWorker
        .selectFrom('cg.message')
        .select(['id', 'state', 'template', 'body_enc'])
        .where('tenant_id', '=', county)
        .where('template', '=', 'appointment')
        .executeTakeFirstOrThrow();
      expect(message.state).toBe('sent');
      const body = await crypto.decrypt(county, message.body_enc);
      expect(body).toContain('Su cita con Exercise County Human Services');
      expect(body).toContain('room 112');
      expect(body).not.toContain('Rental assistance');
      expect(body).not.toMatch(/alerta de emergencia/i);
      const view = await call<Case>('caseworker', 'GET', `/cases/${cases['texts']}`);
      expect(view.body.appointments[0]).toMatchObject({ id: appt.id, noticeSent: true });
      // An appointment in the past is refused; the PIO schedules nothing.
      expect(
        (
          await call('caseworker', 'POST', `/cases/${cases['texts']}/appointments`, {
            withLabel: 'x',
            place: 'y',
            startsAt: new Date(Date.now() - HOUR).toISOString(),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('pio', 'POST', `/cases/${cases['texts']}/appointments`, {
            withLabel: 'x',
            place: 'y',
            startsAt: inDays(1).toISOString(),
          })
        ).status,
      ).toBe(403);
    });

    it('docs/06: without opt-in the notice goes by email; with no way to reach, nothing is queued and the appointment says so', async () => {
      const byEmail = await call<Appointment>(
        'caseworker',
        'POST',
        `/cases/${cases['email']}/appointments`,
        {
          withLabel: 'Exercise insurer',
          place: 'By phone',
          startsAt: inDays(2).toISOString(),
        },
      );
      expect(byEmail.status).toBe(201);
      expect(byEmail.body.noticeChannel).toBe('email');
      const none = await call<Appointment>(
        'caseworker',
        'POST',
        `/cases/${cases['none']}/appointments`,
        {
          withLabel: 'Exercise insurer',
          place: 'By phone',
          startsAt: inDays(2).toISOString(),
        },
      );
      expect(none.status).toBe(201);
      expect(none.body.noticeChannel).toBeNull();
      const queued = (await outbox('message.send')).filter(
        (m) => m.payload.appointmentId === none.body.id,
      );
      expect(queued).toEqual([]);
    });

    it('FL:FR-18: the worker queues one reminder the day before, outside quiet hours, and none for an appointment made the same day', async () => {
      const soon = await call<Appointment>(
        'caseworker',
        'POST',
        `/cases/${cases['texts']}/appointments`,
        {
          withLabel: 'Exercise legal aid',
          place: 'Harmon Community College, room 118',
          startsAt: new Date(Date.now() + 3 * HOUR).toISOString(),
        },
      );
      expect(soon.status).toBe(201);
      // Too early: nothing is due.
      worker.now = () => new Date(Date.now() + 2 * HOUR);
      let run1 = await remindAppointments(worker);
      expect(run1.queued).toBe(0);
      // The appointment made the same day is skipped; the one three days out is not due yet.
      expect(run1.skipped).toBe(1);
      // Quiet hours hold the reminder.
      await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .insertInto('cg.tenant_config')
          .values({
            tenant_id: county,
            key: 'reminders.quiet_hours',
            value: JSON.stringify({ start: '00:00', end: '23:59' }),
          })
          .execute(),
      );
      worker.now = () => new Date(inDays(3).getTime() - 20 * HOUR);
      run1 = await remindAppointments(worker);
      expect(run1).toMatchObject({ queued: 0, held: 1 });
      await withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .deleteFrom('cg.tenant_config')
          .where('tenant_id', '=', county)
          .where('key', '=', 'reminders.quiet_hours')
          .execute(),
      );
      const run2 = await remindAppointments(worker);
      expect(run2.queued).toBe(1);
      const reminders = (await outbox('message.send')).filter(
        (m) => m.payload.template === 'appointment_reminder',
      );
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.payload).toMatchObject({
        appointmentId: appt.id,
        appointmentNotice: 'reminder',
        channel: 'sms',
        language: 'es',
      });
      expect(reminders[0]!.payload.variables['place']).toBe('Harmon Community College, room 112');
      // Once only.
      const run3 = await remindAppointments(worker);
      expect(run3.queued).toBe(0);
      const view = await call<Case>('caseworker', 'GET', `/cases/${cases['texts']}`);
      expect(view.body.appointments.find((a) => a.id === appt.id)!.reminderQueuedAt).not.toBeNull();
      worker.now = undefined as unknown as () => Date;
      delete (worker as { now?: unknown }).now;
    });

    it('RULE-14: an appointment is kept, missed or cancelled with a reason, with its version; never deleted', async () => {
      const stale = await call<Appointment>(
        'caseworker',
        'POST',
        `/cases/${cases['texts']}/appointments/${appt.id}/status`,
        { status: 'cancelled', reason: 'Survivor rescheduled (exercise)' },
        { 'if-match': `"${appt.version + 9}"` },
      );
      expect(stale.status).toBe(409);
      const noReason = await call<Appointment>(
        'caseworker',
        'POST',
        `/cases/${cases['texts']}/appointments/${appt.id}/status`,
        { status: 'cancelled' },
        { 'if-match': `"${appt.version}"` },
      );
      expect(noReason.status).toBe(400);
      const cancelled = await call<Appointment>(
        'caseworker',
        'POST',
        `/cases/${cases['texts']}/appointments/${appt.id}/status`,
        { status: 'cancelled', reason: 'Survivor rescheduled (exercise)' },
        { 'if-match': `"${appt.version}"` },
      );
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(cancelled.body).toMatchObject({
        status: 'cancelled',
        cancelReason: 'Survivor rescheduled (exercise)',
      });
      const view = await call<Case>('caseworker', 'GET', `/cases/${cases['texts']}`);
      expect(view.body.appointments.map((a) => a.status).sort()).toEqual([
        'cancelled',
        'scheduled',
      ]);
    });

    let visit: Visit;

    it('FL:FR-12: the door checks a survivor in with the tables to see; the first table is current', async () => {
      const sites = await call<{ id: string; name: string; waiting: number }[]>(
        'masscare',
        'GET',
        '/marc/sites',
      );
      expect(sites.status).toBe(200);
      expect(sites.body.map((s) => s.id)).toContain(siteId);
      const res = await call<Visit>('masscare', 'POST', `/marc/sites/${siteId}/visits`, {
        caseId: cases['texts'],
        label: `SYN-${run}-TEXTS`,
        tables: [
          { label: 'County human services desk' },
          { tenantId: partner, label: 'SBA' },
          { label: 'Exercise insurer' },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      visit = res.body;
      expect(visit).toMatchObject({
        status: 'in_progress',
        currentTable: 'County human services desk',
      });
      expect(visit.stops.map((s) => [s.seq, s.status])).toEqual([
        [1, 'current'],
        [2, 'waiting'],
        [3, 'waiting'],
      ]);
      // The PIO has no part at the door; the SBA representative does not check people in.
      expect(
        (
          await call('pio', 'POST', `/marc/sites/${siteId}/visits`, {
            label: 'x',
            tables: [{ label: 'y' }],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('sba', 'POST', `/marc/sites/${siteId}/visits`, {
            label: 'x',
            tables: [{ label: 'y' }],
          })
        ).status,
      ).toBe(403);
      // A second visit with no SBA table, for the queue test.
      const other = await call<Visit>('masscare', 'POST', `/marc/sites/${siteId}/visits`, {
        label: 'Maria',
        tables: [{ label: 'County human services desk' }, { label: 'Exercise insurer' }],
      });
      expect(other.status).toBe(201);
    });

    it("SEC-05, plan §5.3: a partner's table sees only the visits with a stop at its table, the label and its own stops' notes; never an address", async () => {
      const county = await call<{ items: Visit[] }>(
        'masscare',
        'GET',
        `/marc/sites/${siteId}/queue`,
      );
      expect(county.status).toBe(200);
      expect(county.body.items.map((v) => v.label).sort()).toEqual([`SYN-${run}-TEXTS`, 'Maria']);
      const sba = await call<{ items: Visit[] }>('sba', 'GET', `/marc/sites/${siteId}/queue`);
      expect(sba.status).toBe(200);
      expect(sba.body.items.map((v) => v.label)).toEqual([`SYN-${run}-TEXTS`]);
      const sbaStop = sba.body.items[0]!.stops.find((s) => s.tableLabel === 'SBA')!;
      expect(sbaStop.yours).toBe(true);
      expect(JSON.stringify(sba.body)).not.toMatch(/line1|postal|address|amount/);
      // Hand-off from the desk to SBA by the county, with the one-line why.
      const handed = await call<Visit>(
        'masscare',
        'POST',
        `/marc/visits/${visit.id}/handoff`,
        { note: 'Needs the SBA loan application started; FEMA IA already in hand.' },
        { 'if-match': `"${visit.version}"` },
      );
      expect(handed.status, JSON.stringify(handed.body)).toBe(200);
      expect(handed.body.currentTable).toBe('SBA');
      expect(handed.body.stops.map((s) => s.status)).toEqual(['done', 'current', 'waiting']);
      visit = handed.body;
      // The SBA table reads the why on its own stop and nothing on the others.
      const sba2 = await call<{ items: Visit[] }>('sba', 'GET', `/marc/sites/${siteId}/queue`);
      const mine = sba2.body.items[0]!.stops.find((s) => s.tableLabel === 'SBA')!;
      expect(mine.handoffNote).toBe(
        'Needs the SBA loan application started; FEMA IA already in hand.',
      );
      expect(mine.handedBy).toBe('Exercise Mass Care Coordinator');
    });

    it('FL:FR-12: the SBA table hands the survivor on; a table cannot hand off a visit that is not at it; the last hand-off ends the visit', async () => {
      // The SBA representative hands to the insurer.
      const next = await call<Visit>(
        'sba',
        'POST',
        `/marc/visits/${visit.id}/handoff`,
        { note: 'Loan application filed; insurer should see the SBA letter.' },
        { 'if-match': `"${visit.version}"` },
      );
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      expect(next.body.currentTable).toBe('Exercise insurer');
      visit = next.body;
      // Not at its table any more: refused.
      expect(
        (
          await call(
            'sba',
            'POST',
            `/marc/visits/${visit.id}/handoff`,
            { note: 'Again' },
            {
              'if-match': `"${visit.version}"`,
            },
          )
        ).status,
      ).toBe(403);
      const done = await call<Visit>(
        'masscare',
        'POST',
        `/marc/visits/${visit.id}/handoff`,
        { note: 'All tables seen.' },
        { 'if-match': `"${visit.version}"` },
      );
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'done', currentTable: null });
      // Gone from the live queue; still in the record.
      const live = await call<{ items: Visit[] }>('masscare', 'GET', `/marc/sites/${siteId}/queue`);
      expect(live.body.items.map((v) => v.label)).toEqual(['Maria']);
      const all = await call<{ items: Visit[] }>(
        'masscare',
        'GET',
        `/marc/sites/${siteId}/queue?includeEnded=true`,
      );
      expect(all.body.items).toHaveLength(2);
      // Hand-offs are audited.
      const audits = await dbWorker
        .selectFrom('cg.audit_event')
        .select('action')
        .where('tenant_id', '=', county)
        .where('target_id', '=', visit.id)
        .execute();
      expect(audits.filter((a) => a.action === 'marc.handoff')).toHaveLength(3);
    });
  },
);
