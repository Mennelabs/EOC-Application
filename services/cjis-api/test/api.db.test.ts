/**
 * The enclave API end to end against a throwaway enclave database
 * (`eval "$(scripts/cjis-test-db.sh)"`), with tokens signed by a local key
 * set and an in-memory key service (SEC-12, PPL-01, ADM-05, SEC-13, SEC-18,
 * BRD:FR-07.01–07.06, BRD:FR-00.05/06). Each run makes its own agencies.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { createCjisDb, type CjisDatabase, type EnclaveRole } from '@cg/cjis-db';
import { FieldCrypto, InMemoryKeyService } from '@cg/crypto';
import { buildEnclaveApp, type EnclaveApp } from '../src/app.ts';
import { createSubjectLoader } from '../src/auth/subject.ts';
import { createTokenVerifier } from '../src/auth/token.ts';
import { agencyKeyStore } from '../src/crypto.ts';
import {
  copySignInEvents,
  endExpiredShares,
  runIdentityOutbox,
  suspendInactive,
  sweepRetention,
  type IdentityAdmin,
} from '../src/jobs.ts';
import type { IdpEvent } from '../src/idp/keycloak.ts';

const appUrl = process.env['CJIS_DB_TEST_APP_URL'];
const jobUrl = process.env['CJIS_DB_TEST_JOB_URL'];
const ISSUER = 'https://localhost:8443/auth/realms/cjis';
/** A marker that must never appear in clear anywhere in the database (SEC-10). */
const MARKER = `ZZMARKER${randomBytes(4).toString('hex')}`;

describe.skipIf(!appUrl || !jobUrl)('enclave API (database-backed)', () => {
  let app: EnclaveApp;
  let db: Kysely<CjisDatabase>;
  let job: Kysely<CjisDatabase>;
  let crypto: FieldCrypto;
  let sign: (sub: string, amr?: string[], iss?: string) => Promise<string>;
  const run = randomUUID().slice(0, 8);
  const agencies: Record<'sheriff' | 'police', string> = { sheriff: '', police: '' };
  const people: Record<string, { id: string; sub: string }> = {};
  const fakeIdp = {
    created: [] as string[],
    disabled: [] as string[],
    queued: [] as IdpEvent[],
    async createUser(_realm: string, u: { email: string; temporaryPassword: string }) {
      expect(u.temporaryPassword.length).toBeGreaterThanOrEqual(15);
      this.created.push(u.email);
      return `sub-new-${u.email}`;
    },
    async setEnabled(_realm: string, userId: string, enabled: boolean) {
      if (!enabled) this.disabled.push(userId);
    },
    async events(_realm: string, since: number) {
      return this.queued.filter((e) => e.time > since);
    },
  } satisfies IdentityAdmin & Record<string, unknown>;

  const ref = () => `${run}${randomBytes(18).toString('base64url')}`.slice(0, 40);

  /** The worker takes 20 due items a run; earlier runs may leave items in this shared database. */
  async function drainOutboxFor(personId: string) {
    for (let i = 0; i < 25; i++) {
      await runIdentityOutbox({ db: job, crypto, idp: fakeIdp, realm: 'cjis' });
      const pending = await job
        .selectFrom('cjis.identity_outbox')
        .select('id')
        .where('person_id', '=', personId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (!pending) return;
    }
    throw new Error('identity outbox did not drain');
  }

  async function addPerson(
    key: string,
    agency: 'sheriff' | 'police',
    roles: EnclaveRole[],
    opts: { trainingExpires?: string; fingerprint?: 'cleared' | 'pending' } = {},
  ) {
    const sub = `sub-${key}-${run}`;
    const row = await job
      .insertInto('cjis.person')
      .values({
        agency_id: agencies[agency],
        idp_subject: sub,
        email: `${key}.${run}@${agency}.example.org`,
        display_name: `Test ${key}`,
        status: 'active',
        fingerprint_status: opts.fingerprint ?? 'cleared',
        fingerprint_adjudicated_on:
          (opts.fingerprint ?? 'cleared') === 'cleared' ? '2026-01-05' : null,
        training_completed_on: '2025-01-01',
        training_expires_on: opts.trainingExpires ?? '2099-01-01',
        identity_state: 'created',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const role of roles)
      await job
        .insertInto('cjis.role_grant')
        .values({ agency_id: agencies[agency], person_id: row.id, role })
        .execute();
    people[key] = { id: row.id, sub };
  }

  async function call(
    who: string,
    method: string,
    url: string,
    init: { body?: unknown; version?: number; confirm?: string; key?: string; token?: string } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${init.token ?? (await sign(people[who]!.sub))}`,
      'idempotency-key': init.key ?? randomUUID(),
    };
    if (init.version !== undefined) headers['if-match'] = `"${init.version}"`;
    if (init.confirm) {
      headers['x-confirm'] = 'true';
      headers['x-reason'] = init.confirm;
    }
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers,
      ...(init.body !== undefined ? { payload: init.body as object } : {}),
    });
    return {
      status: res.statusCode,
      // Parsed JSON, inspected loosely by the cases below.
      body: (res.headers['content-type']?.toString().includes('json')
        ? res.json()
        : res.body) as ReturnType<typeof JSON.parse>,
      headers: res.headers,
    };
  }

  beforeAll(async () => {
    db = createCjisDb(appUrl!, 6);
    job = createCjisDb(jobUrl!, 4);
    crypto = new FieldCrypto(new InMemoryKeyService(), agencyKeyStore(db));
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' } as JWK;
    sign = (sub, amr = ['pwd', 'hwk'], iss = ISSUER) =>
      new SignJWT({ amr, sid: `sid-${sub}` })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(iss)
        .setAudience('cjis-api')
        .setSubject(sub)
        .setExpirationTime('5m')
        .sign(privateKey);
    const verify = createTokenVerifier({
      issuer: ISSUER,
      audience: 'cjis-api',
      secondFactors: ['hwk'],
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
    app = await buildEnclaveApp({
      db,
      crypto,
      subjects: createSubjectLoader(db, verify),
      logLevel: 'warn',
    });
    for (const [k, name] of [
      ['sheriff', 'Sheriff'],
      ['police', 'Police'],
    ] as const) {
      agencies[k] = (
        await job
          .insertInto('cjis.agency')
          .values({ name: `${name} ${run}`, agency_identifier: `TEST-${k}-${run}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      for (const category of ['records', 'audit'] as const)
        await job
          .insertInto('cjis.retention_policy')
          .values({ agency_id: agencies[k], category, keep_days: 2557, basis: 'test default' })
          .execute();
    }
    await addPerson('officer', 'sheriff', ['officer']);
    await addPerson('officer2', 'sheriff', ['officer']);
    await addPerson('supervisor', 'sheriff', ['supervisor']);
    await addPerson('clerk', 'sheriff', ['records_clerk']);
    await addPerson('admin', 'sheriff', ['agency_admin']);
    await addPerson('laso', 'sheriff', ['security_officer']);
    await addPerson('auditor', 'sheriff', ['auditor']);
    await addPerson('lapsed', 'sheriff', ['officer'], { trainingExpires: '2026-01-01' });
    await addPerson('pending', 'sheriff', ['officer'], { fingerprint: 'pending' });
    await addPerson('cityOfficer', 'police', ['officer']);
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    await job?.destroy();
  });

  describe('authentication and qualification (SEC-12, ADM-05)', () => {
    it('the system use notification is public; nothing else is', async () => {
      const notice = await app.inject({ method: 'GET', url: '/api/v1/notice' });
      expect(notice.statusCode).toBe(200);
      expect(notice.json().text).toMatch(/criminal justice information system/);
      expect((await app.inject({ method: 'GET', url: '/api/v1/records' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/v1/anything' })).statusCode).toBe(403);
    });

    it('a token from another issuer (a platform realm) is refused', async () => {
      const r = await call('officer', 'GET', '/me', {
        token: await sign(
          people['officer']!.sub,
          ['pwd', 'hwk'],
          'https://localhost/auth/realms/county',
        ),
      });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('invalid_token');
    });

    it('a sign-in without the second factor is refused and recorded', async () => {
      const r = await call('officer2', 'GET', '/me', {
        token: await sign(people['officer2']!.sub, ['pwd']),
      });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('second_factor_required');
      const rows = await job
        .selectFrom('cjis.audit_event')
        .select(['action', 'outcome'])
        .where('actor_person_id', '=', people['officer2']!.id)
        .where('action', '=', 'auth.deny')
        .execute();
      expect(rows).toEqual([{ action: 'auth.deny', outcome: 'denied' }]);
    });

    it('a token for nobody the enclave knows is refused', async () => {
      const r = await call('officer', 'GET', '/me', { token: await sign(`stranger-${run}`) });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('unknown_account');
    });

    it('lapsed training or a pending check: the account but no records, with what is missing', async () => {
      const me = await call('lapsed', 'GET', '/me');
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ qualified: false, missing: ['security_training'] });
      const lapsed = await call('lapsed', 'GET', '/records');
      expect(lapsed.status).toBe(403);
      expect(lapsed.body).toMatchObject({
        code: 'not_cjis_qualified',
        details: { missing: ['security_training'] },
      });
      const pending = await call('pending', 'GET', '/records');
      expect(pending.body.details.missing).toEqual(['fingerprint_check']);
      const denied = await job
        .selectFrom('cjis.audit_event')
        .select('reason')
        .where('actor_person_id', '=', people['lapsed']!.id)
        .where('action', '=', 'authz.deny')
        .execute();
      expect(denied[0]?.reason).toContain('E2:not_qualified');
    });
  });

  describe('records (PPL-01, BRD:FR-07)', () => {
    const r1 = ref();
    let version = 0;

    it('an officer creates the record for a linked mission; a retry answers the same record', async () => {
      const key = randomUUID();
      const body = {
        ref: r1,
        platformMissionReference: 'M-00012',
        platformCounty: 'county',
        origin: '911',
        classification: 'looting',
        offenseCodes: ['EX-2401'],
        caseNumber: `WCSO-${MARKER}-01`,
        summary: `Synthetic exercise summary ${MARKER}`,
      };
      const first = await call('officer', 'POST', '/records', { body, key });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        ref: r1,
        classification: 'looting',
        caseNumber: body.caseNumber,
      });
      const again = await call('officer', 'POST', '/records', { body, key });
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body.ref).toBe(r1);
      version = first.body.version;
    });

    it('people involved, a weapon and a body-camera reference are recorded once each', async () => {
      const suspect = await call('officer', 'POST', `/records/${r1}/people`, {
        version,
        body: {
          role: 'suspect',
          name: `Exercise Person ${MARKER}`,
          birthDate: '1990-02-03',
          demographics: { sex: 'unknown', height: '5-10' },
          identifiers: `DL-${MARKER}`,
        },
      });
      expect(suspect.status).toBe(201);
      version = suspect.body.record.version;
      const weapon = await call('officer', 'POST', `/records/${r1}/weapons`, {
        version,
        body: {
          kind: 'firearm',
          description: `Exercise handgun ${MARKER}`,
          serialNumber: `SN-${MARKER}`,
          disposition: 'seized',
          personId: suspect.body.id,
        },
      });
      expect(weapon.status).toBe(201);
      version = weapon.body.record.version;
      const cam = await call('officer', 'POST', `/records/${r1}/bodycams`, {
        version,
        body: {
          cameraLabel: 'BWC-07',
          officerPersonId: people['officer']!.id,
          recordedFrom: '2026-10-13T10:00:00Z',
          recordedTo: '2026-10-13T10:20:00Z',
          evidenceReference: `EVID-${MARKER}`,
        },
      });
      expect(cam.status).toBe(201);
      version = cam.body.record.version;
      const rec = await call('officer', 'GET', `/records/${r1}`);
      expect(rec.status).toBe(200);
      expect(rec.body.people).toHaveLength(1);
      expect(rec.body.people[0]).toMatchObject({
        role: 'suspect',
        name: `Exercise Person ${MARKER}`,
      });
      expect(rec.body.weapons[0]).toMatchObject({ kind: 'firearm', serialNumber: `SN-${MARKER}` });
      expect(rec.body.bodycams[0]).toMatchObject({
        cameraLabel: 'BWC-07',
        officer: 'Test officer',
      });
      expect(rec.body.timeline.map((e: { kind: string }) => e.kind)).toEqual([
        'created',
        'person_added',
        'weapon_added',
        'bodycam_added',
      ]);
    });

    it('a stale version gets 409 with the current record (BRD:FR-00.05)', async () => {
      const stale = await call('officer2', 'PATCH', `/records/${r1}`, {
        version: version - 1,
        body: { classification: 'theft' },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.details.version).toBe(version);
      const ok = await call('officer2', 'PATCH', `/records/${r1}`, {
        version,
        body: { classification: 'burglary' },
      });
      expect(ok.status).toBe(200);
      version = ok.body.version;
    });

    it('narratives are appended; an amendment names what it amends (BRD:FR-07.01)', async () => {
      const n = await call('officer', 'POST', `/records/${r1}/narratives`, {
        body: { body: `Responding narrative ${MARKER}` },
      });
      expect(n.status).toBe(201);
      const a = await call('supervisor', 'POST', `/records/${r1}/narratives`, {
        body: { body: 'Correction: time of arrival 10:05', amendsEventId: n.body.id },
      });
      expect(a.status).toBe(201);
      const tl = a.body.record.timeline;
      expect(tl.find((e: { id: string }) => e.id === n.body.id)).toMatchObject({
        kind: 'narrative',
        narrativeRole: 'officer',
      });
      expect(tl.find((e: { kind: string }) => e.kind === 'amendment')).toMatchObject({
        narrativeRole: 'supervisor',
        amendsEventId: n.body.id,
      });
      version = a.body.record.version;
    });

    it('removing an entry keeps it with its reason (BRD:FR-07.06)', async () => {
      const rec = await call('officer', 'GET', `/records/${r1}`);
      const cam = rec.body.bodycams[0];
      const removed = await call('officer', 'POST', `/records/${r1}/bodycams/${cam.id}/remove`, {
        version: cam.version,
        body: { reason: 'Wrong camera entered' },
      });
      expect(removed.status).toBe(200);
      expect(removed.body.bodycams[0]).toMatchObject({
        status: 'removed',
        removedReason: 'Wrong camera entered',
      });
      version = removed.body.version;
    });

    it('a disposition needs confirmation, closes the record, and stops new entries', async () => {
      const unconfirmed = await call('officer', 'POST', `/records/${r1}/disposition`, {
        version,
        body: { disposition: 'arrest_made' },
      });
      expect(unconfirmed.status).toBe(428);
      const done = await call('officer', 'POST', `/records/${r1}/disposition`, {
        version,
        body: { disposition: 'arrest_made', note: `Booked ${MARKER}` },
        confirm: 'Exercise arrest recorded',
      });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ state: 'closed', disposition: 'arrest_made' });
      version = done.body.version;
      const more = await call('officer', 'POST', `/records/${r1}/people`, {
        version,
        body: { role: 'witness', name: 'Late Witness' },
      });
      expect(more.status).toBe(409);
      expect(more.body.code).toBe('record_closed');
    });

    it('a supervisor reviews; nobody reviews their own disposition (E6); a supervisor reopens', async () => {
      const review = await call('supervisor', 'POST', `/records/${r1}/review`, {
        version,
        confirm: 'Reviewed for the exercise',
      });
      expect(review.status).toBe(200);
      expect(review.body.reviewedBy).toBe('Test supervisor');
      version = review.body.version;
      const reopened = await call('supervisor', 'POST', `/records/${r1}/reopen`, {
        version,
        confirm: 'New information',
      });
      expect(reopened.status).toBe(200);
      version = reopened.body.version;
      const own = await call('supervisor', 'POST', `/records/${r1}/disposition`, {
        version,
        body: { disposition: 'report_filed' },
        confirm: 'Supervisor closes',
      });
      expect(own.status).toBe(200);
      const selfReview = await call('supervisor', 'POST', `/records/${r1}/review`, {
        version: own.body.version,
        confirm: 'Own review',
      });
      expect(selfReview.status).toBe(403);
    });

    it('another agency sees nothing; an auditor reads no records', async () => {
      expect((await call('cityOfficer', 'GET', `/records/${r1}`)).status).toBe(404);
      expect((await call('cityOfficer', 'GET', '/records')).body).toEqual([]);
      expect((await call('auditor', 'GET', `/records/${r1}`)).status).toBe(404);
    });

    it('SEC-10: identifying and free-text values are only ciphertext in the database', async () => {
      const tables = [
        'record',
        'record_person',
        'record_weapon',
        'record_bodycam',
        'record_event',
        'idempotency_key',
        'audit_event',
      ];
      for (const t of tables) {
        const { rows } = await sql<{ n: string }>`
          select count(*)::text as n from ${sql.table(`cjis.${t}`)} x
          where x::text like ${`%${MARKER}%`}`.execute(job);
        expect({ table: t, n: Number(rows[0]?.n) }).toEqual({ table: t, n: 0 });
      }
    });

    it('SEC-18: every read and write is in the audit, by field name only', async () => {
      const rows = await job
        .selectFrom('cjis.audit_event')
        .select(['action', 'fields'])
        .where('agency_id', '=', agencies.sheriff)
        .where('target_id', '=', r1)
        .execute();
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'record.create',
          'record.read',
          'record.update',
          'record.narrative',
          'record.amendment',
          'record.disposition',
          'record.review',
          'record.reopen',
        ]),
      );
      expect(rows.find((r) => r.action === 'record.read')?.fields).toContain('people');
    });
  });

  describe('mutual aid (SEC-12, decision 2026-10-15; plan §14 q4)', () => {
    const r2 = ref();
    let version = 0;
    let shareId = '';
    const inOneDay = () => new Date(Date.now() + 86_400_000).toISOString();

    it('a supervisor of the owning agency shares a record with another agency for a set period', async () => {
      const made = await call('officer', 'POST', '/records', {
        body: {
          ref: r2,
          platformMissionReference: 'M-00031',
          platformCounty: 'county',
          origin: 'field_report',
          classification: 'looting',
          offenseCodes: ['EX-2401'],
          caseNumber: `WCSO-${MARKER}-MA`,
          summary: `Synthetic mutual-aid exercise ${MARKER}`,
        },
      });
      expect(made.status).toBe(201);
      version = made.body.version;
      // An officer cannot share; only a supervisor or administrator of the owner (policy).
      const byOfficer = await call('officer', 'POST', `/records/${r2}/shares`, {
        version,
        confirm: 'Officer tries',
        body: { toAgencyId: agencies.police, endsAt: inOneDay(), purpose: 'Joint patrol' },
      });
      expect(byOfficer.status).toBe(403);
      // Not with one's own agency, not in the past, not beyond 90 days.
      for (const body of [
        { toAgencyId: agencies.sheriff, endsAt: inOneDay(), purpose: 'Own agency' },
        { toAgencyId: agencies.police, endsAt: '2020-01-01T00:00:00.000Z', purpose: 'Past' },
        {
          toAgencyId: agencies.police,
          endsAt: new Date(Date.now() + 120 * 86_400_000).toISOString(),
          purpose: 'Too long',
        },
      ]) {
        const bad = await call('supervisor', 'POST', `/records/${r2}/shares`, {
          version,
          confirm: 'Supervisor shares',
          body,
        });
        expect(bad.status).toBe(400);
      }
      const shared = await call('supervisor', 'POST', `/records/${r2}/shares`, {
        version,
        confirm: 'Supervisor shares for the joint looting patrol',
        body: {
          toAgencyId: agencies.police,
          endsAt: inOneDay(),
          purpose: 'Joint looting patrol, mission M-00031',
          platformMissionReference: 'M-00031',
        },
      });
      expect(shared.status).toBe(201);
      expect(shared.body.ownAgency).toBe(true);
      expect(shared.body.shares).toHaveLength(1);
      expect(shared.body.shares[0]).toMatchObject({
        toAgencyId: agencies.police,
        toAgencyName: 'Police',
        status: 'active',
        purpose: 'Joint looting patrol, mission M-00031',
      });
      shareId = shared.body.shares[0].id;
      version = shared.body.version;
      // The same agency cannot hold two standing shares.
      const twice = await call('supervisor', 'POST', `/records/${r2}/shares`, {
        version,
        confirm: 'Again',
        body: { toAgencyId: agencies.police, endsAt: inOneDay(), purpose: 'Again' },
      });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('already_shared');
    });

    it('the helping agency reads and lists the record, read-only, and every read is audited against it', async () => {
      const read = await call('cityOfficer', 'GET', `/records/${r2}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ ref: r2, ownAgency: false, ownerName: 'Sheriff' });
      expect(read.body.shares).toHaveLength(1);
      const list = await call('cityOfficer', 'GET', '/records');
      expect(list.status).toBe(200);
      const row = list.body.find((x: { ref: string }) => x.ref === r2);
      expect(row).toMatchObject({ sharedBy: 'Sheriff' });
      expect(typeof row.sharedUntil).toBe('string');
      // No writes through a share: it reads as not found to the writer.
      const patch = await call('cityOfficer', 'PATCH', `/records/${r2}`, {
        version,
        body: { summary: 'changed by the helper' },
      });
      expect(patch.status).toBe(404);
      const person = await call('cityOfficer', 'POST', `/records/${r2}/people`, {
        version,
        body: { role: 'witness', name: 'Helper Adds' },
      });
      expect(person.status).toBe(404);
      // The helping agency's own share is in its audit, with the owner named.
      const audit = await job
        .selectFrom('cjis.audit_event')
        .select(['agency_id', 'action', 'reason'])
        .where('actor_person_id', '=', people['cityOfficer']!.id)
        .where('action', '=', 'record.read')
        .orderBy('occurred_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      expect(audit).toMatchObject({ agency_id: agencies.police, action: 'record.read' });
      expect(audit!.reason).toContain('mutual-aid share from Sheriff');
      // An officer whose training lapsed reads nothing, shared or not (E2 comes first).
      expect((await call('lapsed', 'GET', `/records/${r2}`)).status).toBe(403);
    });

    it('an expired share ends on its own and the record disappears from the helper', async () => {
      const far = new Date(Date.now() + 2 * 86_400_000);
      const ended = await endExpiredShares({ db: job, now: () => far });
      expect(ended.ended).toBeGreaterThanOrEqual(1);
      expect((await call('cityOfficer', 'GET', `/records/${r2}`)).status).toBe(404);
      const own = await call('supervisor', 'GET', `/records/${r2}`);
      expect(own.body.shares[0]).toMatchObject({ id: shareId, status: 'ended' });
      expect(typeof own.body.shares[0].endedAt).toBe('string');
      const events = await job
        .selectFrom('cjis.record_event as e')
        .innerJoin('cjis.record as r', 'r.id', 'e.record_id')
        .select('e.kind')
        .where('r.cji_ref', '=', r2)
        .execute();
      expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['shared', 'share_ended']));
      version = own.body.version;
    });

    it('a share is ended early with a reason, and a revoked share cannot be revoked twice', async () => {
      const again = await call('supervisor', 'POST', `/records/${r2}/shares`, {
        version,
        confirm: 'Second grant',
        body: { toAgencyId: agencies.police, endsAt: inOneDay(), purpose: 'Second grant' },
      });
      expect(again.status).toBe(201);
      const share = again.body.shares.find((x: { status: string }) => x.status === 'active');
      expect((await call('cityOfficer', 'GET', `/records/${r2}`)).status).toBe(200);
      // The helping agency cannot revoke (not the owner), nor can an officer.
      const byHelper = await call(
        'cityOfficer',
        'POST',
        `/records/${r2}/shares/${share.id}/revoke`,
        {
          version: share.version,
          confirm: 'Helper revokes',
        },
      );
      expect(byHelper.status).toBe(404);
      const byOfficer = await call('officer', 'POST', `/records/${r2}/shares/${share.id}/revoke`, {
        version: share.version,
        confirm: 'Officer revokes',
      });
      expect(byOfficer.status).toBe(403);
      const revoked = await call('supervisor', 'POST', `/records/${r2}/shares/${share.id}/revoke`, {
        version: share.version,
        confirm: 'Mission M-00031 stood down',
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.shares.find((x: { id: string }) => x.id === share.id)).toMatchObject({
        status: 'revoked',
        revokeReason: 'Mission M-00031 stood down',
      });
      expect((await call('cityOfficer', 'GET', `/records/${r2}`)).status).toBe(404);
      expect((await call('cityOfficer', 'GET', '/records')).body).toEqual([]);
      const twice = await call('supervisor', 'POST', `/records/${r2}/shares/${share.id}/revoke`, {
        version: share.version + 1,
        confirm: 'Again',
      });
      expect(twice.status).toBe(409);
    });

    it('GET /agencies lists the other active agencies a record can be shared with', async () => {
      const res = await call('supervisor', 'GET', '/agencies');
      expect(res.status).toBe(200);
      expect(res.body.map((a: { id: string }) => a.id)).toContain(agencies.police);
      expect(res.body.map((a: { id: string }) => a.id)).not.toContain(agencies.sheriff);
    });
  });

  describe('accounts, screening and roles (ADM-05, plan §4)', () => {
    let newId = '';
    let v = 0;

    it('an administrator creates an account and records screening; not their own', async () => {
      const created = await call('admin', 'POST', '/accounts', {
        body: { email: `new.${run}@sheriff.example.org`, displayName: 'New Deputy' },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'invited', qualified: false });
      newId = created.body.id;
      const screened = await call('admin', 'POST', `/accounts/${newId}/screening`, {
        version: created.body.version,
        body: {
          fingerprintStatus: 'cleared',
          fingerprintAdjudicatedOn: '2026-09-01',
          trainingCompletedOn: '2026-09-15',
        },
      });
      expect(screened.status).toBe(200);
      expect(screened.body.trainingExpiresOn).toBe('2027-09-15');
      v = screened.body.version;
      const own = await call('admin', 'GET', '/me');
      const self = await call('admin', 'POST', `/accounts/${people['admin']!.id}/screening`, {
        version: 1,
        body: { trainingCompletedOn: '2026-10-01' },
      });
      expect(own.status).toBe(200);
      expect(self.status).toBe(403);
    });

    it('a role takes a second administrator; the requester cannot approve', async () => {
      const req = await call('admin', 'POST', '/permission-requests', {
        body: { personId: newId, role: 'officer', change: 'grant', reason: 'New deputy' },
      });
      expect(req.status).toBe(201);
      const self = await call('admin', 'POST', `/permission-requests/${req.body.id}/approve`, {
        version: req.body.version,
        confirm: 'Approving my own request',
      });
      expect(self.status).toBe(403);
      const ok = await call('laso', 'POST', `/permission-requests/${req.body.id}/approve`, {
        version: req.body.version,
        confirm: 'Second administrator approves',
      });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('approved');
      const acct = await call('admin', 'GET', `/accounts/${newId}`);
      expect(acct.body.roles).toEqual(['officer']);
      v = acct.body.version;
    });

    it('activation shows a one-time password once; the worker creates the identity and clears it', async () => {
      const act = await call('admin', 'POST', `/accounts/${newId}/activate`, {
        version: v,
        confirm: 'Handing over in person',
      });
      expect(act.status).toBe(200);
      expect(act.body.temporaryPassword).toMatch(/^Tmp-/);
      expect(act.body.account).toMatchObject({ status: 'active', identityState: 'pending' });
      const before = await job
        .selectFrom('cjis.identity_outbox')
        .select(['payload_enc', 'status'])
        .where('person_id', '=', newId)
        .executeTakeFirstOrThrow();
      expect(before.payload_enc?.toString('latin1')).not.toContain(act.body.temporaryPassword);
      await drainOutboxFor(newId);
      const after = await job
        .selectFrom('cjis.identity_outbox')
        .select(['payload_enc', 'status'])
        .where('person_id', '=', newId)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({ payload_enc: null, status: 'done' });
      expect(fakeIdp.created).toContain(`new.${run}@sheriff.example.org`);
      const acct = await call('admin', 'GET', `/accounts/${newId}`);
      expect(acct.body).toMatchObject({ identityState: 'created', qualified: true });
      v = acct.body.version;
    });

    it('a suspension takes effect on the next request and closes the identity', async () => {
      const sus = await call('laso', 'POST', `/accounts/${people['officer2']!.id}/suspend`, {
        version: (await call('admin', 'GET', `/accounts/${people['officer2']!.id}`)).body.version,
        confirm: 'Exercise suspension',
      });
      expect(sus.status).toBe(200);
      const next = await call('officer2', 'GET', '/records');
      expect(next.status).toBe(403);
      expect(next.body.details.missing).toContain('account_not_active');
      await drainOutboxFor(people['officer2']!.id);
      expect(fakeIdp.disabled).toContain(people['officer2']!.sub);
    });

    it('officers cannot administer accounts', async () => {
      expect((await call('officer', 'GET', '/accounts')).status).toBe(403);
    });
  });

  describe('audit review and retention (SEC-18, SEC-13)', () => {
    it('security officers read, verify, export with confirmation and record the weekly review', async () => {
      const list = await call('laso', 'GET', '/audit?limit=50');
      expect(list.status).toBe(200);
      expect(list.body.length).toBeGreaterThan(5);
      const verified = await call('laso', 'POST', '/audit/verify');
      expect(verified.body).toMatchObject({ ok: true });
      const from = new Date(Date.now() - 3600_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const unconfirmed = await call(
        'laso',
        'GET',
        `/audit/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      expect(unconfirmed.status).toBe(428);
      const csv = await call(
        'auditor',
        'GET',
        `/audit/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {
          confirm: 'Weekly review export',
        },
      );
      expect(csv.status).toBe(200);
      expect(String(csv.body).split('\n')[0]).toBe(
        'seq,occurred_at,recorded_at,actor_kind,actor_person_id,action,target_type,target_id,target_version,outcome,reason,fields,source_ip,hash',
      );
      const review = await call('laso', 'POST', '/audit/reviews', {
        body: {
          periodFrom: from,
          periodTo: to,
          note: 'Weekly review: no anomalies in the exercise',
        },
      });
      expect(review.status).toBe(201);
      expect(review.body.chainOk).toBe(true);
      expect((await call('officer', 'GET', '/audit')).status).toBe(403);
    });

    it('retention floors hold; a legal hold keeps a record the sweep would delete', async () => {
      const ret = await call('laso', 'GET', '/retention');
      const records = ret.body.policies.find((p: { category: string }) => p.category === 'records');
      const short = await call('laso', 'PUT', '/retention/records', {
        version: records.version,
        body: { keepDays: 30, basis: 'too short' },
        confirm: 'Testing the floor',
      });
      expect(short.status).toBe(400);
      // Two closed records; one under a hold.
      const kept = ref();
      const gone = ref();
      for (const r of [kept, gone]) {
        const c = await call('officer', 'POST', '/records', { body: { ref: r } });
        await call('officer', 'POST', `/records/${r}/disposition`, {
          version: c.body.version,
          body: { disposition: 'no_action_taken' },
          confirm: 'Closing',
        });
      }
      const hold = await call('laso', 'POST', '/holds', {
        body: { ref: kept, reason: 'Litigation hold (exercise)' },
        confirm: 'Counsel asked',
      });
      expect(hold.status).toBe(201);
      const later = new Date(Date.now() + 2600 * 24 * 3600 * 1000);
      const swept = await sweepRetention({ db: job, now: () => later });
      expect(swept.held).toBeGreaterThanOrEqual(1);
      expect((await call('officer', 'GET', `/records/${kept}`)).status).toBe(200);
      expect((await call('officer', 'GET', `/records/${gone}`)).status).toBe(404);
      const log = await call('laso', 'GET', '/retention');
      expect(log.body.deletions[0]).toMatchObject({ category: 'records' });
      expect(log.body.holds[0]).toMatchObject({ ref: kept, scope: 'record' });
    });
  });

  describe('worker jobs (AU-2, AC-2)', () => {
    it('sign-in events land in the audit against the person’s agency, once', async () => {
      const t = Date.now();
      fakeIdp.queued.push(
        {
          time: t,
          type: 'LOGIN',
          userId: people['officer']!.sub,
          ipAddress: '10.0.0.5',
          sessionId: 's-1',
        },
        {
          time: t + 1,
          type: 'LOGIN_ERROR',
          userId: people['officer']!.sub,
          error: 'invalid_user_credentials',
        },
        { time: t + 2, type: 'LOGIN_ERROR', error: 'user_not_found' },
      );
      const copied = await copySignInEvents({ db: job, crypto, idp: fakeIdp, realm: 'cjis' });
      expect(copied).toBeGreaterThanOrEqual(3);
      expect(await copySignInEvents({ db: job, crypto, idp: fakeIdp, realm: 'cjis' })).toBe(0);
      const rows = await job
        .selectFrom('cjis.audit_event')
        .select(['action', 'outcome', 'agency_id'])
        .where('actor_person_id', '=', people['officer']!.id)
        .where('action', 'like', 'identity.%')
        .execute();
      expect(rows).toEqual(
        expect.arrayContaining([
          { action: 'identity.login', outcome: 'success', agency_id: agencies.sheriff },
          { action: 'identity.login_error', outcome: 'failure', agency_id: agencies.sheriff },
        ]),
      );
    });

    it('accounts unused for 90 days are suspended (runs last: it touches every account)', async () => {
      const later = new Date(Date.now() + 91 * 24 * 3600 * 1000);
      const n = await suspendInactive({ db: job, now: () => later });
      expect(n).toBeGreaterThan(0);
      const me = await call('officer', 'GET', '/me');
      expect(me.body).toMatchObject({ status: 'suspended', qualified: false });
    });
  });
});
