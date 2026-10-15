/**
 * Official reports against the database (layer-6 task E; F15, RULE-10,
 * RULE-14, CON-06, AC-15A/B/C, A7, G4): a reporting officer drafts a
 * situation report from synthetic reviewed reports; its damage fact is the
 * counting rule's own figure with the record versions it used; facts cannot
 * be typed over; the author neither reviews nor issues; a summary still as
 * drafted cannot be approved; a change after review sends it back; a draft
 * is never issued without review; issuing needs a confirmed reason and
 * freezes the content with its hash, which no role can change; a record
 * changed afterwards leaves the issued report as it was, and an amendment
 * (issued in turn) supersedes it; "what changed" names the change; the
 * worker writes the locked copy once. Runs only with API_DB_TEST_APP_URL
 * and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { contentHash, countDamage, loadDamageRecords } from '@cg/reporting';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { officialReportIssued } from '../../worker/src/jobs/official-reports.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const HOUR = 3_600_000;

interface Section {
  key: string;
  kind: 'fact' | 'judgment' | 'narrative';
  title: string;
  content: { text?: string; rows?: { key: string; value: number | null; detail?: string }[] };
  definition: { key: string; version: number } | null;
  recordCount: number;
  drafted: boolean;
  editedByName: string | null;
}
interface Report {
  id: string;
  version: number;
  title: string;
  state: string;
  authorName: string | null;
  reviewerName: string | null;
  issuerName: string | null;
  amends: string | null;
  amendedBy: string | null;
  sections: Section[];
  snapshot: {
    id: string;
    contentHash: string;
    recordCount: number;
    lock: { objectKey: string; lockMode: string } | null;
  } | null;
  code?: string;
}

describe.skipIf(!appUrl || !workerUrl)('official reports (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let otherEvent = '';
  const run = randomUUID().slice(0, 8);
  const people: Record<string, string> = {};
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(dbWorker, { tenantId: county }, fn);

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-reports-${run}`,
        name: `Exercise reports county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const events = await tx(async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) })
        .execute();
      const ev = (name: string) =>
        trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `${name} ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(Date.now() - 24 * HOUR),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      const ids = [(await ev('Exercise flood')).id, (await ev('Exercise quiet event')).id];
      // Staff accounts, so the report names who wrote, reviewed and issued it.
      for (const [who, name] of [
        ['author', 'Exercise Reporting Officer'],
        ['director', 'Exercise EM Director'],
      ] as const)
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
      return ids;
    });
    eventId = events[0]!;
    otherEvent = events[1]!;
    await loadDamageReports(dbWorker, {
      tenantId: county,
      eventId,
      reviewerId: randomUUID(),
      count: 40,
      tag: `rpt${run}`,
    });

    const subject = (template: string, accountId: string = randomUUID()): AccountSubject => {
      const r = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId,
        tenantId: county,
        tenantPath: c.path,
        tenantKind: c.kind,
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
    };
    const subjects: Record<string, AccountSubject> = {
      author: subject('reporting_planning', people['author']!),
      director: subject('county_em_director', people['director']!),
      pio: subject('public_information_officer'),
      coordinator: subject('damage_assessment_coordinator'),
    };
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
      routes: routesWith(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', '=', `exercise-reports-${run}`)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async <T = Report>(
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
    return { status: res.statusCode, body: res.json() as T };
  };
  const v = (r: { version: number }) => ({ 'if-match': `"${r.version}"` });
  const confirm = { 'x-confirm': 'true', 'x-reason': 'Exercise: approved for release to partners' };
  const section = (r: Report, key: string) => r.sections.find((x) => x.key === key)!;
  const row = (r: Report, fact: string, key: string) =>
    section(r, fact).content.rows!.find((x) => x.key === key)!.value;

  const periodFrom = new Date(Date.now() - 12 * HOUR).toISOString();
  const periodTo = new Date(Date.now() + HOUR).toISOString();
  let draft: Report;
  let issued: Report;
  let changedRecord = '';

  it('F15: drafts a situation report from the records; damage is the counting rule with the record versions it used', async () => {
    const clientUuid = randomUUID();
    const body = { clientUuid, eventId, kind: 'sitrep', periodFrom, periodTo };
    const res = await call('author', 'POST', '/official-reports', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    draft = res.body;
    expect(draft.title).toBe('Situation report 1');
    expect(draft.state).toBe('draft');
    expect(draft.authorName).toBe('Exercise Reporting Officer');
    expect(draft.sections.map((x) => [x.key, x.kind])).toEqual([
      ['summary', 'narrative'],
      ['damage', 'fact'],
      ['reports', 'fact'],
      ['outages', 'fact'],
      ['casualties', 'fact'],
      ['shelters', 'fact'],
      ['outlook', 'judgment'],
      ['priorities', 'judgment'],
    ]);
    expect(section(draft, 'summary').drafted).toBe(true);
    expect(section(draft, 'damage').definition).toMatchObject({ key: 'counting_rule', version: 1 });
    const want = countDamage(
      await withTenant(dbApp, { tenantId: county }, (trx) =>
        loadDamageRecords(trx, eventId, { cutoff: new Date(periodTo) }),
      ),
    );
    expect(row(draft, 'damage', 'units')).toBe(want.counted.units);
    expect(row(draft, 'damage', 'destroyed')).toBe(want.counted.byDegree.destroyed);
    expect(section(draft, 'damage').recordCount).toBe(want.counted.recordIds.length);
    expect(row(draft, 'reports', 'inPeriod')).toBe(40);
    // AC-15B: no official count reads unknown, never zero.
    expect(row(draft, 'casualties', 'injured')).toBeNull();
    expect(section(draft, 'summary').content.text).toContain('unknown injured');
    // FR-00.06: the same request again is the same report.
    const again = await call('author', 'POST', '/official-reports', body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(draft.id);
  });

  it('keeps facts to the records, and only the people with the grant draft or read', async () => {
    const fact = await call(
      'author',
      'PUT',
      `/official-reports/${draft.id}/sections/damage`,
      { text: '99' },
      v(draft),
    );
    expect(fact.status).toBe(409);
    expect(fact.body.code).toBe('fact_not_editable');
    expect((await call('pio', 'GET', `/official-reports/${draft.id}`)).status).toBe(200);
    expect(
      (
        await call('pio', 'POST', '/official-reports', {
          clientUuid: randomUUID(),
          eventId,
          kind: 'briefing',
          periodFrom,
          periodTo,
        })
      ).status,
    ).toBe(403);
    expect((await call('coordinator', 'GET', `/official-reports/${draft.id}`)).status).toBe(404);
  });

  it('A7, F15.02: the author never reviews; a summary still as drafted is not approved; a change after review sends it back', async () => {
    const own = await call(
      'author',
      'POST',
      `/official-reports/${draft.id}/review`,
      { decision: 'approve' },
      v(draft),
    );
    expect(own.status).toBe(403);
    const early = await call(
      'director',
      'POST',
      `/official-reports/${draft.id}/review`,
      { decision: 'approve' },
      v(draft),
    );
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('narrative_not_confirmed');
    const returned = await call(
      'director',
      'POST',
      `/official-reports/${draft.id}/review`,
      { decision: 'return', note: 'Add the outlook for tomorrow.' },
      v(draft),
    );
    expect(returned.status).toBe(200);
    draft = returned.body;
    for (const [key, text] of [
      ['summary', `${section(draft, 'summary').content.text} River crest expected Thursday.`],
      ['outlook', 'Exercise: more rain on Thursday; levee watch continues.'],
    ] as const) {
      const res = await call(
        'author',
        'PUT',
        `/official-reports/${draft.id}/sections/${key}`,
        { text },
        v(draft),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      draft = res.body;
    }
    expect(section(draft, 'summary').drafted).toBe(false);
    expect(section(draft, 'outlook').editedByName).toBe('Exercise Reporting Officer');
    const ok = await call(
      'director',
      'POST',
      `/official-reports/${draft.id}/review`,
      { decision: 'approve' },
      v(draft),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.state).toBe('reviewed');
    expect(ok.body.reviewerName).toBe('Exercise EM Director');
    // The reviewer approved what they read: an edit afterwards needs a new review.
    const edited = await call(
      'author',
      'PUT',
      `/official-reports/${draft.id}/sections/priorities`,
      { text: 'Exercise: clear the Route 9 culverts first.' },
      v(ok.body),
    );
    expect(edited.body.state).toBe('draft');
    expect(edited.body.reviewerName).toBeNull();
    draft = edited.body;
  });

  it('AC-15C, RULE-14: never issued without review; the author never issues; issuing needs a confirmed reason', async () => {
    const unreviewed = await call(
      'director',
      'POST',
      `/official-reports/${draft.id}/issue`,
      undefined,
      { ...v(draft), ...confirm },
    );
    expect(unreviewed.status).toBe(409);
    expect(unreviewed.body.code).toBe('not_reviewed');
    const reviewed = (
      await call(
        'director',
        'POST',
        `/official-reports/${draft.id}/review`,
        { decision: 'approve' },
        v(draft),
      )
    ).body;
    expect(
      (
        await call('author', 'POST', `/official-reports/${draft.id}/issue`, undefined, {
          ...v(reviewed),
          ...confirm,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'director',
          'POST',
          `/official-reports/${draft.id}/issue`,
          undefined,
          v(reviewed),
        )
      ).status,
    ).toBe(428);
    const res = await call('director', 'POST', `/official-reports/${draft.id}/issue`, undefined, {
      ...v(reviewed),
      ...confirm,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    issued = res.body;
    expect(issued.state).toBe('issued');
    expect(issued.issuerName).toBe('Exercise EM Director');
    expect(issued.snapshot?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.snapshot?.recordCount).toBe(section(draft, 'damage').recordCount);
    const snap = await call<{
      content: { sections: { key: string }[] };
      contentHash: string;
      hashMatches: boolean;
    }>('pio', 'GET', `/official-reports/${issued.id}/snapshot`);
    expect(snap.body.hashMatches).toBe(true);
    expect(contentHash(snap.body.content)).toBe(snap.body.contentHash);
    // Each step is in the audit chain, and so are the refusals: the author's attempts to review
    // and issue (G4) and the coordinator's attempt to read.
    const actions = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'reason'])
        .where('target_id', '=', issued.id)
        .execute(),
    );
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set([
        'official_report.draft',
        'official_report.review',
        'official_report.issue',
        'authz.deny',
      ]),
    );
    expect(
      actions
        .filter((a) => a.action === 'authz.deny')
        .map((a) => a.reason)
        .sort(),
    ).toEqual([
      'official_report.issue: guardrail:G4:self_review',
      'official_report.read: no_grant',
      'official_report.review: guardrail:G4:self_review',
    ]);
  });

  it('RULE-10: an issued report is never changed, by the API or by any database role', async () => {
    for (const [method, url, body] of [
      ['PUT', `/official-reports/${issued.id}/sections/outlook`, { text: 'changed' }],
      ['POST', `/official-reports/${issued.id}/refresh`, undefined],
      ['POST', `/official-reports/${issued.id}/withdraw`, { reason: 'Exercise: try to withdraw' }],
    ] as const) {
      const res = await call('author', method, url, body, v(issued));
      expect(res.status, url).toBe(409);
    }
    for (const db of [dbApp, dbWorker])
      await expect(
        withTenant(db, { tenantId: county }, (trx) =>
          sql`update cg.official_report_snapshot set reason = 'changed' where report_id = ${issued.id}`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow();
    await expect(
      withTenant(dbWorker, { tenantId: county }, (trx) =>
        sql`delete from cg.official_report_snapshot where report_id = ${issued.id}`.execute(trx),
      ),
    ).rejects.toThrow();
  });

  it('AC-15A, CON-06: a record changed after issue leaves the issued report as it was; "what changed" names it; an amendment supersedes', async () => {
    const before = (
      await call<{ contentHash: string }>('pio', 'GET', `/official-reports/${issued.id}/snapshot`)
    ).body;
    // A counted home is found to be destroyed after the report went out.
    const counted = await withTenant(dbApp, { tenantId: county }, (trx) =>
      loadDamageRecords(trx, eventId),
    );
    const t = countDamage(counted);
    const target = counted.find(
      (r) => t.counted.recordIds.includes(r.id) && r.kind === 'report' && r.degree !== 'destroyed',
    )!;
    changedRecord = target.id;
    await tx((trx) =>
      trx
        .updateTable('cg.report')
        .set({ fema_degree: 'destroyed', version: sql`version + 1` })
        .where('id', '=', target.id)
        .execute(),
    );
    const after = (
      await call<{ contentHash: string; hashMatches: boolean }>(
        'pio',
        'GET',
        `/official-reports/${issued.id}/snapshot`,
      )
    ).body;
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.hashMatches).toBe(true);

    const changes = await call<{
      since: { reportId: string } | null;
      changes: { fact: string; key: string; before: number | null; after: number | null }[];
    }>('pio', 'GET', `/events/${eventId}/changes`);
    expect(changes.body.since?.reportId).toBe(issued.id);
    const destroyed = changes.body.changes.find(
      (c) => c.fact === 'damage' && c.key === 'destroyed',
    )!;
    expect(destroyed.after).toBe(destroyed.before! + 1);
    const quiet = await call<{ since: null; changes: unknown[] }>(
      'pio',
      'GET',
      `/events/${otherEvent}/changes`,
    );
    expect(quiet.body).toMatchObject({ since: null, changes: [] });

    const amendment = await call('author', 'POST', `/official-reports/${issued.id}/amend`, {
      clientUuid: randomUUID(),
    });
    expect(amendment.status, JSON.stringify(amendment.body)).toBe(201);
    let a = amendment.body;
    expect(a.title).toBe('Situation report 1, amendment 1');
    expect(a.amends).toBe(issued.id);
    expect(row(a, 'damage', 'destroyed')).toBe(row(issued, 'damage', 'destroyed')! + 1);
    expect(section(a, 'outlook').content.text).toBe(
      'Exercise: more rain on Thursday; levee watch continues.',
    );
    expect(section(a, 'summary').drafted).toBe(true);
    expect(
      (
        await call('author', 'POST', `/official-reports/${issued.id}/amend`, {
          clientUuid: randomUUID(),
        })
      ).status,
    ).toBe(409);

    a = (
      await call(
        'author',
        'PUT',
        `/official-reports/${a.id}/sections/summary`,
        { text: `${section(a, 'summary').content.text} Corrected: one more home destroyed.` },
        v(a),
      )
    ).body;
    a = (
      await call(
        'director',
        'POST',
        `/official-reports/${a.id}/review`,
        { decision: 'approve' },
        v(a),
      )
    ).body;
    const done = await call('director', 'POST', `/official-reports/${a.id}/issue`, undefined, {
      ...v(a),
      ...confirm,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const original = (await call('pio', 'GET', `/official-reports/${issued.id}`)).body;
    expect(original.state).toBe('superseded');
    expect(original.amendedBy).toBe(a.id);
    expect(
      (
        await call('author', 'POST', `/official-reports/${issued.id}/amend`, {
          clientUuid: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(changedRecord).not.toBe('');
  });

  it('ADR-0010: the worker writes the locked copy once, with the records retention', async () => {
    const puts: { key: string; retainUntil: Date; body: string }[] = [];
    const ctx = {
      db: dbWorker,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      objects: {
        async putLocked(key: string, body: string, _type: string, retainUntil: Date) {
          puts.push({ key, body, retainUntil });
          return { versionId: 'v1', mode: 'COMPLIANCE' as const };
        },
      },
    } as unknown as JobContext;
    const msg = {
      id: 1,
      tenantId: county,
      topic: 'official_report.issued',
      payload: { reportId: issued.id, snapshotId: issued.snapshot!.id },
      executionId: null,
    };
    await officialReportIssued(ctx, msg);
    await officialReportIssued(ctx, msg);
    // The stack's own worker may have taken the message first (CI runs these suites beside it),
    // so the outcome is checked in the database: one locked copy, whichever worker wrote it.
    expect(puts.length).toBeLessThanOrEqual(1);
    const key = `tenant/${county}/official-reports/${issued.id}/${issued.snapshot!.id}.json`;
    if (puts[0]) {
      expect(puts[0].key).toBe(key);
      expect(JSON.parse(puts[0].body).contentHash).toBe(issued.snapshot!.contentHash);
    }
    const locks = await tx((trx) =>
      trx
        .selectFrom('cg.official_report_lock')
        .selectAll()
        .where('snapshot_id', '=', issued.snapshot!.id)
        .execute(),
    );
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ object_key: key, content_hash: issued.snapshot!.contentHash });
    // SEC-13 default: records are kept seven years from issue.
    const years = (locks[0]!.retain_until.getTime() - Date.now()) / (365.25 * 24 * HOUR);
    expect(years).toBeGreaterThan(6.9);
    expect(years).toBeLessThan(7.1);
    const now = (await call('pio', 'GET', `/official-reports/${issued.id}`)).body;
    expect(now.snapshot?.lock).toMatchObject({ lockMode: 'COMPLIANCE' });
  });

  it('withdraws a draft that is not needed', async () => {
    const d = (
      await call('author', 'POST', '/official-reports', {
        clientUuid: randomUUID(),
        eventId,
        kind: 'briefing',
        periodFrom,
        periodTo,
      })
    ).body;
    expect(d.title).toBe('Briefing 1');
    const w = await call(
      'author',
      'POST',
      `/official-reports/${d.id}/withdraw`,
      { reason: 'Exercise: drafted twice' },
      v(d),
    );
    expect(w.body.state).toBe('withdrawn');
    const list = await call<{ id: string; state: string }[]>(
      'pio',
      'GET',
      `/official-reports?eventId=${eventId}`,
    );
    expect(list.body.map((r) => r.state).sort()).toEqual(['issued', 'superseded', 'withdrawn']);
  });
});
