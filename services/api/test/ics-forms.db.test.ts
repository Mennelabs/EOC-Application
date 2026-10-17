/**
 * ICS forms as documents (CON-13; ADM-05 G4; RULE-10; SEC-18), against the
 * database. Planning writes the period's objectives; a general message is
 * drafted, approved by a second person (never its writer), sent and
 * replied to; each form is previewed for its scope and issued frozen with
 * its hash, numbered per event; the PDF and CSV come from the frozen
 * content and every download is audited. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Objective {
  id: string;
  version: number;
  position: number;
  objective: string;
  status: string;
}
interface GM {
  id: string;
  version: number;
  messageNumber: string;
  status: string;
  approvedBy: string | null;
  reply: string | null;
  repliedBy: { name: string; position: string | null } | null;
  code?: string;
}
interface Content {
  form: string;
  edition: string;
  incident: string;
  blocks: {
    no: string;
    label: string;
    kind: string;
    value?: unknown;
    text?: string;
    rows?: unknown[][];
  }[];
}
interface Issue {
  id: string;
  form: string;
  sequence: number;
  contentHash: string;
  issuedBy: string | null;
  content?: Content;
  code?: string;
}

describe.skipIf(!appUrl || !workerUrl)('ICS forms (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let teamId = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-ics-${run}`;
  const people: Record<string, string> = {};
  const subjects: Record<string, AccountSubject> = {};

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
    return {
      status: res.statusCode,
      body: res.json() as T,
      headers: res.headers,
      raw: res.rawPayload,
    };
  };
  const confirmed = (reason: string) => ({ 'x-confirm': 'true', 'x-reason': reason });
  const periodFrom = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const periodTo = new Date(Date.now() + 6 * 3_600_000).toISOString();

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise ICS county ${run}`,
        status: 'active',
        locales: ['en', 'es'],
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const cast = [
      ['planner', 'planning_gis_lead', 'Exercise Planning Lead'],
      ['director', 'county_em_director', 'Exercise EM Director'],
      ['reporter', 'reporting_planning', 'Exercise Reporting Staff'],
      ['netcontrol', 'net_control', 'Exercise Net Control'],
      ['pio', 'public_information_officer', 'Exercise PIO'],
    ] as const;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      for (const [who, , name] of cast)
        people[who] = (
          await trx
            .insertInto('cg.account')
            .values({
              tenant_id: county,
              email: `${who}-${run}@example.org`,
              display_name: name,
              status: 'active',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      // The planner holds an ICS position on the roster; it signs the forms.
      await trx
        .insertInto('cg.personnel')
        .values({
          tenant_id: county,
          account_id: people['planner']!,
          name: 'Exercise Planning Lead',
          agency: 'Exercise County EM',
          department: null,
          operational_role: 'Planning Section Chief',
          contact_enc: null,
          phone_bidx: null,
          hours_limit: null,
          home_tenant_id: null,
          photo_key: null,
          photo_pending_key: null,
          created_by: null,
          updated_by: null,
        })
        .execute();
      eventId = (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise ICS event ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            intake_slug: `ics${run}`,
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      teamId = (
        await trx
          .insertInto('cg.team')
          .values({
            tenant_id: county,
            event_id: eventId,
            key: `tc-${run}`,
            name: 'Exercise traffic control',
            agency: 'Exercise Guard',
            callsign: 'TC-9',
            created_by: null,
            updated_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await trx
        .insertInto('cg.significant_event')
        .values({
          tenant_id: county,
          event_id: eventId,
          kind: 'dispatch',
          summary: 'TC-9 dispatched to Commercial Row (exercise)',
          team_id: teamId,
          mission_id: null,
          ref_kind: null,
          ref_id: null,
          actor_account_id: people['director']!,
        })
        .execute();
      await trx
        .insertInto('cg.comms_log')
        .values([
          {
            tenant_id: county,
            event_id: eventId,
            net: 'Exercise net',
            from_station: 'NET',
            to_station: null,
            team_id: null,
            kind: 'net_open',
            message: 'Net open',
            operator_account_id: people['netcontrol']!,
          },
          {
            tenant_id: county,
            event_id: eventId,
            net: 'Exercise net',
            from_station: 'NET',
            to_station: 'TC-9',
            team_id: teamId,
            kind: 'traffic',
            message: 'Proceed to Commercial Row',
            operator_account_id: people['netcontrol']!,
          },
        ])
        .execute();
    });
    for (const [who, template] of cast) {
      const r = roleTemplates.find((x) => x.key === template)!;
      subjects[who] = {
        kind: 'account',
        accountId: people[who]!,
        tenantId: county,
        tenantPath: c.path as string,
        tenantKind: c.kind,
        tenantTimeZone: 'America/Chicago',
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
      fieldCrypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      subjects: loader,
      routes: routesWith({ icsForms: { productName: 'Test Product' } }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', '=', slug)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  let gm: GM;

  it('ICS 202: planning writes the objectives of the period, numbered in order; the PIO reads, never writes', async () => {
    const one = await call<Objective>('planner', 'POST', '/incident-objectives', {
      eventId,
      periodFrom,
      periodTo,
      objective: 'Shelter everyone displaced (exercise)',
      ownerPosition: 'Mass Care Coordinator',
    });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(one.body).toMatchObject({ position: 1, status: 'open' });
    const two = await call<Objective>('planner', 'POST', '/incident-objectives', {
      eventId,
      periodFrom,
      periodTo,
      objective: 'Clear Commercial Row (exercise)',
    });
    expect(two.body.position).toBe(2);
    const met = await call<Objective>(
      'planner',
      'PATCH',
      `/incident-objectives/${two.body.id}`,
      { status: 'met' },
      { 'if-match': `"${two.body.version}"` },
    );
    expect(met.status).toBe(200);
    expect(met.body.status).toBe('met');
    const list = await call<Objective[]>('pio', 'GET', `/incident-objectives?eventId=${eventId}`);
    expect(list.status).toBe(200);
    expect(list.body.map((o) => o.position)).toEqual([1, 2]);
    expect(
      (
        await call('pio', 'POST', '/incident-objectives', {
          eventId,
          periodFrom,
          periodTo,
          objective: 'Not mine to write',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('planner', 'POST', '/incident-objectives', {
          eventId,
          periodFrom: periodTo,
          periodTo: periodFrom,
          objective: 'Backwards period',
        })
      ).status,
    ).toBe(400);
  });

  it('ICS 213: drafted, approved by a second person with a reason, sent, replied to; the writer cannot approve it', async () => {
    const draft = await call<GM>('planner', 'POST', '/general-messages', {
      eventId,
      to: { name: 'Exercise Mass Care', position: 'Mass Care Coordinator' },
      subject: 'Second shelter opening',
      body: 'Open Lincoln Elementary by 18:00 (exercise).',
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    gm = draft.body;
    expect(gm.messageNumber).toBe(`ICS${run.toUpperCase()}-GM-0001`);
    expect(gm.status).toBe('draft');
    // Not sendable before approval; the writer cannot approve; a reason is required.
    expect(
      (
        await call(
          'planner',
          'POST',
          `/general-messages/${gm.id}/send`,
          {},
          {
            'if-match': `"${gm.version}"`,
            ...confirmed('Exercise'),
          },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call('planner', 'POST', `/general-messages/${gm.id}/approve`, undefined, {
          'if-match': `"${gm.version}"`,
          ...confirmed('Exercise: my own'),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('director', 'POST', `/general-messages/${gm.id}/approve`, undefined, {
          'if-match': `"${gm.version}"`,
        })
      ).status,
    ).toBe(428);
    const approved = await call<GM>(
      'director',
      'POST',
      `/general-messages/${gm.id}/approve`,
      undefined,
      {
        'if-match': `"${gm.version}"`,
        ...confirmed('Exercise: agreed with mass care'),
      },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    gm = approved.body;
    expect(gm).toMatchObject({ status: 'approved', approvedBy: 'Exercise EM Director' });
    const sent = await call<GM>(
      'planner',
      'POST',
      `/general-messages/${gm.id}/send`,
      {},
      {
        'if-match': `"${gm.version}"`,
        ...confirmed('Exercise: handed to the shelter lead'),
      },
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    gm = sent.body;
    expect(gm.status).toBe('sent');
    const replied = await call<GM>(
      'director',
      'POST',
      `/general-messages/${gm.id}/reply`,
      { reply: 'Lincoln Elementary open at 17:40 (exercise).', byPosition: 'Incident Commander' },
      { 'if-match': `"${gm.version}"` },
    );
    expect(replied.status, JSON.stringify(replied.body)).toBe(200);
    gm = replied.body;
    expect(gm).toMatchObject({
      status: 'replied',
      repliedBy: { name: 'Exercise EM Director', position: 'Incident Commander' },
    });
    // The PIO has no part in general messages.
    expect((await call('pio', 'GET', '/general-messages')).status).toBe(403);
  });

  it('forms are previewed for a scope and issued frozen with a hash, numbered per event; the planner signs with their roster position', async () => {
    const forms = await call<{ form: string; edition: string }[]>('reporter', 'GET', '/ics-forms');
    expect(forms.status).toBe(200);
    expect(forms.body.map((f) => f.form)).toEqual([
      'ics_201',
      'ics_213',
      'ics_213rr',
      'ics_214',
      'ics_309',
    ]);

    const preview = await call<Content>('planner', 'POST', '/ics-forms/ics_201/preview', {
      eventId,
      periodFrom,
      periodTo,
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.edition).toContain('ICS 201');
    const objectives = preview.body.blocks.find((b) => b.no === '7')!;
    expect(objectives.rows).toEqual([
      [1, 'Shelter everyone displaced (exercise)', 'Mass Care Coordinator', 'open'],
      [2, 'Clear Commercial Row (exercise)', null, 'met'],
    ]);
    expect(preview.body.blocks.find((b) => b.no === '6')!.value).toBe(
      'Exercise Planning Lead, Planning Section Chief',
    );
    // The 213 needs its message; the 214 a team or a person.
    expect((await call('planner', 'POST', '/ics-forms/ics_213/preview', { eventId })).status).toBe(
      400,
    );
    expect((await call('planner', 'POST', '/ics-forms/ics_214/preview', { eventId })).status).toBe(
      400,
    );
    const m213 = await call<Content>('planner', 'POST', '/ics-forms/ics_213/preview', {
      eventId,
      generalMessageId: gm.id,
    });
    expect(m213.status).toBe(200);
    expect(m213.body.blocks.find((b) => b.no === '7')!.value).toContain('Exercise EM Director');
    expect(m213.body.blocks.find((b) => b.no === '8')!.text).toContain('Lincoln Elementary open');
    const m214 = await call<Content>('planner', 'POST', '/ics-forms/ics_214/preview', {
      eventId,
      teamId,
      periodFrom,
      periodTo,
    });
    expect(m214.status, JSON.stringify(m214.body)).toBe(200);
    expect(m214.body.blocks.find((b) => b.no === '3')!.value).toBe(
      'Exercise traffic control (TC-9)',
    );
    expect(m214.body.blocks.find((b) => b.no === '7')!.rows!.map((r) => r[1])).toContain(
      'TC-9 dispatched to Commercial Row (exercise)',
    );

    // Issue: a reason is required; the PIO may not; the sequence counts per event and form.
    expect(
      (await call('planner', 'POST', '/ics-forms/ics_201/issue', { eventId, periodFrom, periodTo }))
        .status,
    ).toBe(428);
    expect(
      (
        await call(
          'pio',
          'POST',
          '/ics-forms/ics_201/issue',
          { eventId, periodFrom, periodTo },
          confirmed('x'),
        )
      ).status,
    ).toBe(403);
    const issued = await call<Issue>(
      'planner',
      'POST',
      '/ics-forms/ics_201/issue',
      { eventId, periodFrom, periodTo },
      confirmed('Exercise: briefing for the 18:00 shift change'),
    );
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body).toMatchObject({
      form: 'ics_201',
      sequence: 1,
      issuedBy: 'Exercise Planning Lead',
    });
    expect(issued.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await call<Issue>(
      'planner',
      'POST',
      '/ics-forms/ics_201/issue',
      { eventId, periodFrom, periodTo },
      confirmed('Exercise: reissued'),
    );
    expect(again.body.sequence).toBe(2);
    const log = await call<Issue>(
      'netcontrol',
      'POST',
      '/ics-forms/ics_309/issue',
      { eventId, periodFrom, periodTo, net: 'Exercise net' },
      confirmed('Exercise: end of net'),
    );
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    expect(log.body.sequence).toBe(1);

    // The issued record is read back with its content; the list shows every issue of the event.
    const one = await call<Issue>('reporter', 'GET', `/ics-forms/issues/${issued.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body.content!.blocks.find((b) => b.no === '7')!.rows).toHaveLength(2);
    const list = await call<Issue[]>('reporter', 'GET', `/ics-forms/issues?eventId=${eventId}`);
    expect(list.body.map((i) => `${i.form}#${i.sequence}`).sort()).toEqual([
      'ics_201#1',
      'ics_201#2',
      'ics_309#1',
    ]);

    // The frozen content never changes (RULE-10): the table refuses an update.
    await expect(
      withTenant(dbWorker, { tenantId: county }, (trx) =>
        trx
          .updateTable('cg.ics_form_issue')
          .set({ title: 'Edited' })
          .where('id', '=', issued.body.id)
          .execute(),
      ),
    ).rejects.toThrow();

    // SEC-18: the PDF and CSV are drawn from the frozen content and each download is audited.
    const pdf = await call<unknown>('reporter', 'GET', `/ics-forms/issues/${issued.body.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
    const csv = await call<unknown>('reporter', 'GET', `/ics-forms/issues/${log.body.id}/csv`);
    expect(csv.status).toBe(200);
    expect(csv.raw.toString()).toContain('Proceed to Commercial Row');
    expect((await call('pio', 'GET', `/ics-forms/issues/${issued.body.id}/pdf`)).status).toBe(404);
    const audit = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'target_id'])
        .where('action', 'in', ['ics_form.issue', 'ics_form.export'])
        .where('tenant_id', '=', county)
        .execute(),
    );
    expect(audit.filter((a) => a.action === 'ics_form.issue')).toHaveLength(3);
    expect(
      audit
        .filter((a) => a.action === 'ics_form.export')
        .map((a) => a.target_id)
        .sort(),
    ).toEqual([issued.body.id, log.body.id].sort());
  });
});
