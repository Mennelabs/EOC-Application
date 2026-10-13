/**
 * Layer-2 acceptance against the running stack (`docker compose up`, the
 * synthetic WESTWIND seed). The real chain every time: public API → queue →
 * worker → report → staff API through the policy engine, plus the text
 * channel through the simulator webhook and the object store for photos.
 *
 * Cases (plan §9): AC-11B submit/replay/queue-down fallback; AC-11C lookup
 * with code + contact and the code-alone refusal; AC-12A decisions and
 * states; AC-12B self-review refused through the API; AC-12C change after
 * approval → re-review with the snapshot intact; AC-10A zero vs unknown
 * occupants; AC-10B version provenance; AC-10C photo restriction; AC-11D
 * renter with unknown answers; NED-02/03 needs and consent; CON-10 danger
 * flag; CHN-03 SMS end to end with MMS; CHN-06 assisted separation;
 * FR-17.05 message states. Requirement IDs are in the test names.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const BASE = process.env['STACK_URL'] ?? 'https://localhost';
const MAIL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // Caddy local CA in development only.

const PASSWORD = 'Westwind-Exercise-2026!';
const RUN = Date.now().toString(36);
const COUNTY_NUMBER = '+13145550100'; // the seeded county toll-free number (docs/06)
const CODE = /[A-HJKMNP-Z]{4}-[2-9]{4}/;
// A real 1×1 PNG so the worker's image pipeline (sharp) processes it (PHO-06).
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function compose(...args: string[]): string {
  const files = (process.env['COMPOSE_FILES'] ?? 'compose.yaml')
    .split(',')
    .flatMap((f) => ['-f', f]);
  try {
    return execFileSync('docker', ['compose', ...files, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/** Reads the compose database as the superuser: tests observe state, they never write it. */
const sql = (text: string): string[] =>
  compose('exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'cg', '-Atc', text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

async function token(realm: string, user: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'cg-tests',
      client_secret: 'cg-tests-dev-secret',
      username: user,
      password: PASSWORD,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(`token for ${user}@${realm}: ${body.error_description}`);
  return body.access_token;
}

interface Call {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  confirm?: string;
  version?: number;
  idempotencyKey?: string;
}

type Json = Record<string, unknown> & unknown[];

async function call(url: string, tok: string | null, c: Call = {}) {
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (tok) headers['authorization'] = `Bearer ${tok}`;
  if (c.body !== undefined) headers['content-type'] = 'application/json';
  if (c.confirm) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = c.confirm;
  }
  if (c.version !== undefined) headers['if-match'] = `"${c.version}"`;
  if (c.idempotencyKey) headers['idempotency-key'] = c.idempotencyKey;
  const res = await fetch(url, {
    method: c.method ?? (c.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json as Json };
}

const api = (tok: string | null, path: string, c: Call = {}) =>
  call(`${BASE}/api/v1${path}`, tok, c);
const pub = (path: string, c: Call = {}) => call(`${BASE}/api/public${path}`, null, c);

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function mailFor(address: string, subjectPart: string): Promise<string> {
  return waitFor(async () => {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    const body = (await res.json()) as { messages: { ID: string; Subject: string }[] };
    const hit = body.messages.find((m) => m.Subject.toLowerCase().includes(subjectPart));
    if (!hit) return undefined;
    const msg = (await (await fetch(`${MAIL}/api/v1/message/${hit.ID}`)).json()) as {
      Text: string;
    };
    return msg.Text;
  }, 60_000);
}

const priya = () => token('county', 'priya.assessment@example.org');
const dana = () => token('county', 'dana.director@example.org');

let graph: { key: string; version: number };
async function graphInfo() {
  if (!graph) {
    const res = await pub('/intake/county/westwind');
    expect(res.status).toBe(200);
    const g = res.body['graph'] as { key: string; version: number };
    graph = { key: g.key, version: g.version };
  }
  return graph;
}

type Answer = { kind: 'value'; value: unknown } | { kind: 'unknown' } | { kind: 'skipped' };
const v = (value: unknown): Answer => ({ kind: 'value', value });

/** A complete own-home report; `extra` overrides any answer. */
function ownHome(n: number, extra: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    danger_now: v('no'),
    relationship: v('own_home'),
    address: v({ line1: `${n} Acceptance Ave`, city: 'Westwind', postal: '63001' }),
    home_type: v('house'),
    cause: v('wind_tornado'),
    damage_types: v(['roof']),
    roof_state: v('large_hole'),
    habitable: v('no'),
    tonight: v('yes'),
    insurance: { kind: 'unknown' },
    contact_name: v(`Resident ${n}`),
    contact: v({ phone: `314555${String(n).padStart(4, '0').slice(-4)}`, preferred: 'text' }),
    ...extra,
  };
}

interface Submitted {
  executionId: string;
  code: string;
}

async function submit(input: {
  relationship?: string;
  answers: Record<string, Answer>;
  needs?: string[];
  consent?: Record<string, boolean>;
  ownWords?: string;
}): Promise<Submitted> {
  const g = await graphInfo();
  const executionId = crypto.randomUUID();
  const res = await pub('/intake/county/westwind/submissions', {
    idempotencyKey: executionId,
    body: {
      executionId,
      channel: 'web',
      language: 'en',
      graphKey: g.key,
      graphVersion: g.version,
      relationship: input.relationship ?? 'own_home',
      answers: input.answers,
      needs: input.needs ?? [],
      consent: input.consent ?? {},
      ...(input.ownWords ? { ownWords: input.ownWords } : {}),
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return { executionId, code: res.body['referenceCode'] as string };
}

/** The filed report id, once the worker has it (queue → worker → cg.report). */
async function filed(code: string, ms = 60_000): Promise<string> {
  const p = await priya();
  return waitFor(async () => {
    const rows = await api(p, `/reports?reference=${code}`);
    const row = (rows.body as { id: string }[])[0];
    return row?.id;
  }, ms);
}

const detail = async (tok: string, id: string) => (await api(tok, `/reports/${id}`)).body;

let seq = 1000 + (Date.now() % 8000);
const next = () => seq++;

describe('public submission (BRD:FR-11.01–11.04, AC-11B, SCL-06)', () => {
  it('submit → queue → worker → report with the same reference; the same Idempotency-Key replays the same code', async () => {
    const g = await graphInfo();
    const executionId = crypto.randomUUID();
    const body = {
      executionId,
      channel: 'web',
      language: 'en',
      graphKey: g.key,
      graphVersion: g.version,
      relationship: 'own_home',
      answers: ownHome(next()),
      needs: [],
      consent: {},
    };
    const first = await pub('/intake/county/westwind/submissions', {
      idempotencyKey: executionId,
      body,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const code = first.body['referenceCode'] as string;
    expect(code).toMatch(CODE);
    const again = await pub('/intake/county/westwind/submissions', {
      idempotencyKey: executionId,
      body,
    });
    expect(again.status).toBe(202);
    expect(again.body['referenceCode']).toBe(code);
    const id = await filed(code);
    const d = await detail(await priya(), id);
    expect(d['referenceCode']).toBe(code);
    expect(d['channelOfOrigin']).toBe('web');
    expect(d['reviewState']).toBe('submitted');
    expect(sql(`select count(*) from cg.report where reference_code = '${code}'`)).toEqual(['1']);
  });

  it('queue down: the submission is still accepted and stored, and filed once the queue is back (SCL-06, BRD:FR-11.04)', async () => {
    const g = await graphInfo();
    compose('stop', 'queue');
    await new Promise((r) => setTimeout(r, 3_000));
    try {
      const executionId = crypto.randomUUID();
      const res = await pub('/intake/county/westwind/submissions', {
        idempotencyKey: executionId,
        body: {
          executionId,
          channel: 'web',
          language: 'en',
          graphKey: g.key,
          graphVersion: g.version,
          relationship: 'own_home',
          answers: ownHome(next()),
          needs: [],
          consent: {},
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const code = res.body['referenceCode'] as string;
      expect(
        sql(`select status from cg.intake_submission where execution_id = '${executionId}'`),
      ).toEqual(['stored']);
      compose('start', 'queue');
      const id = await filed(code, 120_000);
      expect(id).toBeTruthy();
      expect(
        sql(`select status from cg.intake_submission where execution_id = '${executionId}'`),
      ).toEqual(['processed']);
    } finally {
      compose('start', 'queue');
    }
  }, 180_000);
});

let residentCode: string;
let residentEmail: string;
let residentToken: string;
let residentReport: string;

describe('resident lookup (SEC-09, RES-01, RULE-17, AC-11C)', () => {
  it('a reference code alone opens nothing; code + contact on file sends a one-time code that opens the resident’s own report', async () => {
    residentEmail = `resident-${RUN}@example.org`;
    const s = await submit({
      answers: ownHome(next(), {
        contact: v({ email: residentEmail, preferred: 'email' }),
      }),
      ownWords: 'The tree came through the back bedroom.',
    });
    residentCode = s.code;
    residentReport = await filed(residentCode);
    // The confirmation went out by email (FR-17.05: a message row with its state).
    expect(await mailFor(residentEmail, 'damage report')).toContain(residentCode);

    const wrong = await pub('/intake/county/lookup/start', {
      body: { referenceCode: residentCode, contact: `someone-else-${RUN}@example.org` },
    });
    const right = await pub('/intake/county/lookup/start', {
      body: { referenceCode: residentCode, contact: residentEmail },
    });
    // Same answer either way: the code alone reveals nothing (RULE-17).
    expect(wrong.status).toBe(right.status);
    expect(wrong.body).toEqual(right.body);
    expect(JSON.stringify(right.body)).not.toContain('token');

    const otpMail = await mailFor(residentEmail, 'one-time code');
    const otp = otpMail.match(/\b(\d{6})\b/)?.[1];
    expect(otp).toBeTruthy();
    const bad = await pub('/intake/county/lookup/verify', {
      body: { referenceCode: residentCode, code: otp === '000000' ? '111111' : '000000' },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const verified = await pub('/intake/county/lookup/verify', {
      body: { referenceCode: residentCode, code: otp },
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    residentToken = verified.body['token'] as string;
    expect(residentToken).toBeTruthy();
    const me = await pub('/intake/county/me', { headers: { 'x-resident-token': residentToken } });
    expect(me.status).toBe(200);
    expect(me.body['referenceCode']).toBe(residentCode);
    expect(me.body['consent']).toEqual({}); // NED-03: nothing shared by default
    expect((await pub('/intake/county/me')).status).toBe(401);
  });
});

describe('review (BRD:FR-12.01–12.06, FR-10.06, AC-12A/B/C, AC-10B, DCL:DEC-02/03)', () => {
  it('AC-12A: a reviewer claims, approves with confirmation and a reason; the decision and the pre-decision version are kept', async () => {
    const p = await priya();
    const before = await detail(p, residentReport);
    const noConfirm = await api(p, `/reports/${residentReport}/decisions`, {
      version: before['version'] as number,
      body: { decision: 'approve', reason: 'Photos and answers agree.' },
    });
    expect(noConfirm.status).toBe(428);
    const claimed = await api(p, `/reports/${residentReport}/claim`, {
      method: 'POST',
      version: before['version'] as number,
    });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body['reviewState']).toBe('under_review');
    const approved = await api(p, `/reports/${residentReport}/decisions`, {
      version: claimed.body['version'] as number,
      confirm: 'Photos and answers agree.',
      body: { decision: 'approve', reason: 'Photos and answers agree.' },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body['reviewState']).toBe('approved');
    const versions = (await api(p, `/reports/${residentReport}/versions`)).body as {
      changedByKind: string;
      reason: string | null;
    }[];
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.every((x) => x.changedByKind === 'reviewer')).toBe(true); // AC-10B
    expect(
      sql(
        `select decision from cg.review_decision where report_id = '${residentReport}' order by created_at`,
      ),
    ).toEqual(['approve']);
    // The resident sees the state in plain words, never the reviewer's notes.
    const me = await pub('/intake/county/me', { headers: { 'x-resident-token': residentToken } });
    expect(me.body['status']).toBeTruthy();
    expect(JSON.stringify(me.body)).not.toContain('Photos and answers agree');
  });

  it('AC-12B / CHN-06: the helper who entered an assisted report cannot approve it; a role without the review grant gets nothing', async () => {
    const p = await priya();
    const g = await graphInfo();
    const executionId = crypto.randomUUID();
    const n = next();
    const entered = await api(p, '/reports', {
      idempotencyKey: executionId,
      body: {
        executionId,
        eventId: (
          (await api(p, '/events')).body as { id: string; intakeSlug: string | null }[]
        ).find((e) => e.intakeSlug === 'westwind')!.id,
        language: 'en',
        graphKey: g.key,
        graphVersion: g.version,
        relationship: 'own_home',
        answers: ownHome(n),
        needs: ['shelter_tonight'],
        consent: {},
        consentRecorded: true,
      },
    });
    expect(entered.status, JSON.stringify(entered.body)).toBe(202);
    const code = entered.body['referenceCode'] as string;
    const id = await filed(code);
    const d = await detail(p, id);
    expect(d['channelOfOrigin']).toBe('assisted');
    // The helper is the recorder, kept apart from the resident party (CHN-06).
    expect(sql(`select created_by is not null from cg.report where id = '${id}'`)).toEqual(['t']);
    const self = await api(p, `/reports/${id}/decisions`, {
      version: d['version'] as number,
      confirm: 'my own entry',
      body: { decision: 'approve', reason: 'my own entry' },
    });
    expect(self.status).toBe(403); // guardrail G4, FR-12.04
    const director = await api(await dana(), `/reports/${id}/decisions`, {
      version: d['version'] as number,
      confirm: 'x',
      body: { decision: 'approve', reason: 'not my job' },
    });
    expect(director.status).toBe(404); // no report.review grant: default deny
    expect(sql(`select count(*) from cg.review_decision where report_id = '${id}'`)).toEqual(['0']);
  });

  it('AC-12C / RULE-09: a resident change after approval sends the report back for review; the approved snapshot stays', async () => {
    const changed = await pub('/intake/county/me/corrections', {
      headers: { 'x-resident-token': residentToken },
      body: {
        answers: { habitable: v('yes') },
        message: 'We can stay in the front rooms after all.',
      },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const p = await priya();
    const d = await detail(p, residentReport);
    expect(d['reviewState']).toBe('submitted');
    expect(d['reReview']).toBe(true);
    expect((d['answers'] as Record<string, Answer>)['habitable']).toEqual(v('yes'));
    const versions = (await api(p, `/reports/${residentReport}/versions`)).body as {
      changedByKind: string;
    }[];
    expect(versions.map((x) => x.changedByKind)).toEqual(
      expect.arrayContaining(['reviewer', 'resident']),
    );
    expect(
      sql(
        `select count(*) from cg.report_version where report_id = '${residentReport}' and snapshot->>'review_state' = 'approved'`,
      ),
    ).toEqual(['1']);
  });

  it('DEC-02 / DEC-03: verification level and FEMA degree are reviewer decisions with a reason', async () => {
    const p = await priya();
    const d = await detail(p, residentReport);
    const verified = await api(p, `/reports/${residentReport}/verification`, {
      version: d['version'] as number,
      body: { level: 'desktop_verified', reason: 'Two clear photos of the roof.' },
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    const degree = await api(p, `/reports/${residentReport}/fema-degree`, {
      version: verified.body['version'] as number,
      confirm: 'Large hole in the roof.',
      body: { degree: 'major', reason: 'Large hole in the roof.' },
    });
    expect(degree.status, JSON.stringify(degree.body)).toBe(200);
    expect(degree.body['femaDegree']).toBe('major');
    expect(degree.body['verificationLevel']).toBe('desktop_verified');
  });
});

describe('assessment record (BRD:FR-10.01–10.07, AC-10A, AC-11D, NED-02/03, CON-10)', () => {
  it('AC-10A: zero and unknown are different answers, kept apart (counts in the report and in the after-saving answers)', async () => {
    const g = await graphInfo();
    // An organization reports a building: "no employees affected" is 0, "we do not know" is unknown.
    const org = (n: number, employees: Answer): Record<string, Answer> => ({
      danger_now: v('no'),
      relationship: v('organization'),
      org_name: v(`Westwind Bakery ${n}`),
      address: v({ line1: `${n} Market St`, city: 'Westwind', postal: '63001' }),
      cause: v('wind_tornado'),
      damage_types: v(['roof']),
      employees_affected: employees,
      contact_name: v('Pat Lee'),
      contact: v({ phone: `314555${String(n).padStart(4, '0').slice(-4)}`, preferred: 'text' }),
    });
    const zero = await submit({ relationship: 'organization', answers: org(next(), v(0)) });
    const unknown = await submit({
      relationship: 'organization',
      answers: org(next(), { kind: 'unknown' }),
    });
    const p = await priya();
    const zeroAnswers = (await detail(p, await filed(zero.code)))['answers'] as Record<
      string,
      Answer
    >;
    const unknownAnswers = (await detail(p, await filed(unknown.code)))['answers'] as Record<
      string,
      Answer
    >;
    expect(zeroAnswers['employees_affected']).toEqual(v(0));
    expect(unknownAnswers['employees_affected']).toEqual({ kind: 'unknown' });
    // After-saving household questions keep the same distinction (INT-19, EQ-13).
    const later = await submit({ answers: ownHome(next()) });
    for (const [s, answer] of [[later, { kind: 'unknown' }]] as const) {
      const res = await pub(`/intake/county/submissions/${s.executionId}/after`, {
        body: { graphKey: g.key, graphVersion: g.version, answers: { household_size: answer } },
      });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    }
    const laterId = await filed(later.code);
    const household = await waitFor(async () => {
      const h = (await detail(p, laterId))['household'] as Record<string, Answer> | null;
      return h && h['household_size'] ? h : undefined;
    });
    expect(household['household_size']).toEqual({ kind: 'unknown' });
  });

  it('AC-11D: a renter reports with unknown answers about the owner’s side; the record keeps the renter and the unknowns', async () => {
    const s = await submit({
      answers: ownHome(next(), {
        occupancy: v('rent'),
        home_type: v('apartment_condo'),
        units: { kind: 'unknown' },
        insurance: { kind: 'unknown' },
      }),
    });
    const d = await detail(await priya(), await filed(s.code));
    const answers = d['answers'] as Record<string, Answer>;
    expect(answers['occupancy']).toEqual(v('rent'));
    expect(answers['units']).toEqual({ kind: 'unknown' });
    expect(answers['insurance']).toEqual({ kind: 'unknown' });
  });

  it('NED-02 / NED-03: needs file with the report or not at all; consent defaults to no and a withdrawal is kept, not deleted', async () => {
    const p = await priya();
    const withNeeds = await submit({
      answers: ownHome(next(), {
        habitable: v('yes'),
        tonight: v('no'),
        damage_types: v(['outside_only']),
        roof_state: v('fine'),
      }),
      needs: ['shelter_tonight'],
      consent: { volunteer_cleanup: true },
    });
    const without = await submit({ answers: ownHome(next()) });
    const a = await detail(p, await filed(withNeeds.code));
    const b = await detail(p, await filed(without.code));
    expect((a['needs'] as { category: string }[]).map((x) => x.category)).toEqual([
      'shelter_tonight',
    ]);
    expect(a['consent']).toEqual([{ orgType: 'volunteer_cleanup', granted: true }]);
    expect(b['needs']).toEqual([]);
    expect(b['consent']).toEqual([]);
    // The resident grants, then withdraws, through their own report.
    const granted = await pub('/intake/county/me/consent', {
      method: 'PATCH',
      headers: { 'x-resident-token': residentToken },
      body: { orgType: 'volunteer_cleanup', granted: true },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBeLessThan(300);
    const withdrawn = await pub('/intake/county/me/consent', {
      method: 'PATCH',
      headers: { 'x-resident-token': residentToken },
      body: { orgType: 'volunteer_cleanup', granted: false },
    });
    expect(withdrawn.status).toBeLessThan(300);
    const mine = await detail(p, residentReport);
    expect(mine['consent']).toEqual([{ orgType: 'volunteer_cleanup', granted: false }]);
    expect(
      sql(
        `select withdrawn_at is not null from cg.consent where report_id = '${residentReport}' and org_type = 'volunteer_cleanup'`,
      ),
    ).toEqual(['t']);
  });

  it('CON-10: a danger answer is a flag for awareness in the queue, never a dispatch', async () => {
    const s = await submit({
      answers: ownHome(next(), {
        danger_now: v('yes'),
        danger_info: v('Smell of gas in the kitchen.'),
      }),
    });
    const p = await priya();
    const id = await filed(s.code);
    const d = await detail(p, id);
    expect(d['dangerFlag']).toBe(true);
    const flagged = (await api(p, '/reports?danger=true&limit=200')).body as { id: string }[];
    expect(flagged.some((r) => r.id === id)).toBe(true);
    // Nothing dispatch-like exists for it: no mission, no outbound beyond the confirmation.
    expect(sql(`select count(*) from cg.outbox where topic like 'mission%'`)).toEqual(['0']);
  });
});

describe('text channel through the simulator (CHN-03, CHN-04, PHO-07, AC-10C, FR-17.05)', () => {
  const phone = `+1314557${String(Date.now() % 10000).padStart(4, '0')}`;
  async function text(body: string, media?: { contentType: string; dataBase64: string }[]) {
    const res = await call(`${BASE}/api/webhooks/simulator/sms`, null, {
      body: { from: phone, to: COUNTY_NUMBER, body, ...(media ? { media } : {}) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body['replies'] as string[];
  }

  it('a whole report by text with a photo by MMS: numbered answers to a reference code; the photo stays restricted; the confirmation is recorded as sent', async () => {
    const first = await text('DAMAGE');
    expect(first[0]).toContain('Westwind County');
    expect(first[first.length - 1]).toContain('Is anyone in danger right now?');
    let reply = await text('2', [{ contentType: 'image/png', dataBase64: PNG_1X1 }]);
    expect(reply[0]).toMatch(/1 photo/);
    for (let i = 0; i < 30; i++) {
      const prompt = reply[reply.length - 1] ?? '';
      if (prompt.includes('SEND')) break;
      let answer: string;
      if (prompt.includes('Where is the home')) answer = `${next()} Text Ln, Westwind 63001`;
      else if (prompt.includes('What is your name')) answer = 'Ana Ruiz';
      else if (prompt.includes('own words')) answer = 'Shingles gone and water in the kitchen.';
      else if (prompt.includes('Do you need help')) answer = '1';
      else if (prompt.includes('photos')) answer = 'skip';
      else if (/^1 /m.test(prompt) || prompt.includes('Reply with a number')) answer = '1';
      else answer = 'skip';
      reply = await text(answer);
    }
    expect(reply[reply.length - 1]).toContain('SEND');
    const sent = await text('send');
    const code = sent[sent.length - 1]?.match(CODE)?.[0];
    expect(code).toBeTruthy();
    expect(sent[sent.length - 1]).toContain('Call 911');

    const p = await priya();
    const id = await filed(code!);
    const d = await detail(p, id);
    expect(d['channelOfOrigin']).toBe('sms');
    expect(d['reporter']).toMatchObject({ phone });

    // The photo: processed by the worker, restricted; the director has no photo category at all.
    const photos = await waitFor(async () => {
      const res = await api(p, `/reports/${id}/photos`);
      const rows = res.body as { blurStatus: string; restricted: boolean }[];
      return rows.some((x) => x.blurStatus === 'skipped_no_detector') ? rows : undefined;
    }, 60_000);
    expect(photos[0]).toMatchObject({ restricted: true, blurStatus: 'skipped_no_detector' });
    expect((await api(await dana(), `/reports/${id}/photos`)).status).toBe(404);
    expect(
      sql(`select exif_stripped from cg.photo where report_id = '${id}'`).every((x) => x === 't'),
    ).toBe(true);

    // FR-17.05: a text session gets its confirmation inside the dialogue (no second text), so the
    // message rows with states belong to what the worker sends: here the resident's email
    // confirmation from the lookup case, recorded as sent (Mailpit received it above).
    const states = await waitFor(async () => {
      const rows = sql(
        `select state from cg.message where channel = 'email' and template = 'confirmation' and queued_at > now() - interval '15 minutes'`,
      );
      return rows.includes('sent') ? rows : undefined;
    }, 60_000);
    expect(states).toContain('sent');
    expect(states.every((x) => ['queued', 'sent', 'delivered', 'failed'].includes(x))).toBe(true);

    // STOP opts the number out: no more texts, the report stays.
    const stop = await text('STOP');
    expect(stop[0]).toMatch(/no longer|stopped|unsubscribed|won’t|will not/i);
    expect(sql(`select count(*) from cg.report where id = '${id}'`)).toEqual(['1']);
  }, 240_000);
});
