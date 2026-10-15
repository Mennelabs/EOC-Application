/**
 * The enclave database on its own (SEC-12, SEC-11, SEC-13, SEC-18,
 * BRD:FR-08.04, ADM-05), against a throwaway enclave database started from
 * the same init script (`eval "$(scripts/cjis-test-db.sh)"`). Each run makes
 * its own agencies, so the verdicts cover only this suite's rows.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely, type Transaction } from 'kysely';
import { beforeCommit, createCjisDb, withAgency, type CjisDatabase } from '../src/index.ts';

const appUrl = process.env['CJIS_DB_TEST_APP_URL'];
const jobUrl = process.env['CJIS_DB_TEST_JOB_URL'];
const migratorUrl = process.env['CJIS_DB_TEST_MIGRATOR_URL'];

describe.skipIf(!appUrl || !jobUrl || !migratorUrl)('enclave database (database-backed)', () => {
  let app: Kysely<CjisDatabase>;
  let job: Kysely<CjisDatabase>;
  let owner: Kysely<CjisDatabase>;
  let agencyA = '';
  let agencyB = '';
  let personA = '';
  let adminA = '';
  let personB = '';
  let recordA = '';
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    app = createCjisDb(appUrl!, 4);
    job = createCjisDb(jobUrl!, 40);
    owner = createCjisDb(migratorUrl!, 2);
    const mk = async (suffix: string) =>
      (
        await job
          .insertInto('cjis.agency')
          .values({
            name: `Test agency ${suffix} ${run}`,
            agency_identifier: `TEST-${suffix}-${run}`,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    agencyA = await mk('A');
    agencyB = await mk('B');
    const person = async (agency: string, email: string) =>
      (
        await job
          .insertInto('cjis.person')
          .values({ agency_id: agency, email, display_name: 'Test Person' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    personA = await person(agencyA, `a.${run}@sheriff.example.org`);
    adminA = await person(agencyA, `admin.a.${run}@sheriff.example.org`);
    personB = await person(agencyB, `b.${run}@police.example.org`);
    recordA = (
      await withAgency(app, { agencyId: agencyA, personId: personA }, (trx) =>
        trx
          .insertInto('cjis.record')
          .values({ agency_id: agencyA, cji_ref: `ref${run}${'x'.repeat(32)}` })
          .returning('id')
          .executeTakeFirstOrThrow(),
      )
    ).id;
  });

  afterAll(async () => {
    await app?.destroy();
    await job?.destroy();
    await owner?.destroy();
  });

  it('SEC-11: every enclave column is in the dictionary', async () => {
    const { rows } = await sql`select * from cjis.undocumented_columns()`.execute(job);
    expect(rows).toEqual([]);
  });

  it('SEC-12: an agency sees only its own people and records', async () => {
    const seen = await withAgency(app, { agencyId: agencyB }, async (trx) => ({
      people: await trx.selectFrom('cjis.person').select('id').execute(),
      records: await trx.selectFrom('cjis.record').select('id').execute(),
      agencies: await trx.selectFrom('cjis.agency').select('id').execute(),
    }));
    expect(seen.people.map((p) => p.id)).toEqual([personB]);
    expect(seen.records).toEqual([]);
    expect(seen.agencies.map((a) => a.id)).toEqual([agencyB]);
  });

  it('SEC-12: without an agency context the request role sees nothing', async () => {
    const people = await app.selectFrom('cjis.person').select('id').execute();
    expect(people).toEqual([]);
  });

  it('SEC-12: a request cannot write into another agency', async () => {
    await expect(
      withAgency(app, { agencyId: agencyB }, (trx) =>
        trx
          .insertInto('cjis.record')
          .values({ agency_id: agencyA, cji_ref: `other${run}${'y'.repeat(32)}` })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('agencies are created by the system only', async () => {
    await expect(
      withAgency(app, { agencyId: agencyA }, (trx) =>
        trx
          .insertInto('cjis.agency')
          .values({ name: 'Rogue', agency_identifier: `ROGUE-${run}` })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a record reference must be opaque and long', async () => {
    await expect(
      withAgency(app, { agencyId: agencyA }, (trx) =>
        trx.insertInto('cjis.record').values({ agency_id: agencyA, cji_ref: 'M-00012' }).execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('ADM-05: a permission request cannot be decided by its requester', async () => {
    const req = await withAgency(app, { agencyId: agencyA }, (trx) =>
      trx
        .insertInto('cjis.permission_request')
        .values({
          agency_id: agencyA,
          person_id: personA,
          role: 'officer',
          change: 'grant',
          reason: 'test',
          requested_by: adminA,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      withAgency(app, { agencyId: agencyA }, (trx) =>
        trx
          .updateTable('cjis.permission_request')
          .set({ status: 'approved', decided_by: adminA, decided_at: new Date() })
          .where('id', '=', req.id)
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('BRD:FR-07.01: the record timeline is append-only for requests', async () => {
    const ev = await withAgency(app, { agencyId: agencyA }, (trx) =>
      trx
        .insertInto('cjis.record_event')
        .values({ agency_id: agencyA, record_id: recordA, kind: 'created' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      withAgency(app, { agencyId: agencyA }, (trx) =>
        trx
          .updateTable('cjis.record_event')
          .set({ kind: 'updated' })
          .where('id', '=', ev.id)
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    const deleted = await withAgency(app, { agencyId: agencyA }, (trx) =>
      trx.deleteFrom('cjis.record_event').where('id', '=', ev.id).executeTakeFirst(),
    );
    expect(Number(deleted.numDeletedRows)).toBe(0);
  });

  it('records leave only through the system role, with their entries (SEC-13)', async () => {
    const ref = `gone${run}${'z'.repeat(32)}`;
    const rec = await withAgency(app, { agencyId: agencyA }, async (trx) => {
      const r = await trx
        .insertInto('cjis.record')
        .values({ agency_id: agencyA, cji_ref: ref })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cjis.record_person')
        .values({
          agency_id: agencyA,
          record_id: r.id,
          role: 'witness',
          name_enc: Buffer.from('ciphertext'),
        })
        .execute();
      return r;
    });
    const byApp = await withAgency(app, { agencyId: agencyA }, (trx) =>
      trx.deleteFrom('cjis.record').where('id', '=', rec.id).executeTakeFirst(),
    );
    expect(Number(byApp.numDeletedRows)).toBe(0);
    const byJob = await job.deleteFrom('cjis.record').where('id', '=', rec.id).executeTakeFirst();
    expect(Number(byJob.numDeletedRows)).toBe(1);
    const people = await job
      .selectFrom('cjis.record_person')
      .select('id')
      .where('record_id', '=', rec.id)
      .execute();
    expect(people).toEqual([]);
  });

  it('SEC-13: retention floors (records one year, audit seven years)', async () => {
    await expect(
      job
        .insertInto('cjis.retention_policy')
        .values({ agency_id: agencyA, category: 'records', keep_days: 30, basis: 'too short' })
        .execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      job
        .insertInto('cjis.retention_policy')
        .values({ agency_id: agencyA, category: 'audit', keep_days: 365, basis: 'too short' })
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('the sign-in event cursor and the dictionary are closed to requests', async () => {
    await expect(app.selectFrom('cjis.idp_event_cursor').selectAll().execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`delete from cjis.data_dictionary where table_name = 'record'`.execute(app),
    ).rejects.toThrow(/permission denied/);
  });

  describe('audit (SEC-18, BRD:FR-08.04)', () => {
    const write = (db: Kysely<CjisDatabase>, agency: string, i: number) =>
      db
        .insertInto('cjis.audit_event')
        .values({
          agency_id: agency,
          actor_kind: 'system',
          action: 'test.audit',
          target_type: 'test',
          target_id: String(i),
          outcome: 'success',
        })
        .execute();

    it('forty concurrent writers leave a chain that verifies', async () => {
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          job.transaction().execute(async (trx) => {
            await write(trx, agencyB, i);
            await sql`select pg_sleep(0.01)`.execute(trx);
          }),
        ),
      );
      const { rows } = await sql<{ ok: boolean; checked: string }>`
        select ok, checked from cjis.audit_verify(${agencyB}::uuid)`.execute(job);
      expect(rows[0]).toMatchObject({ ok: true });
      expect(Number(rows[0]?.checked)).toBe(40);
    });

    it('a writer that audits and then locks a row does not deadlock with one that locked it first', async () => {
      // The audit row goes through the before-commit queue, as recordEnclaveAudit does.
      const audit = (trx: Transaction<CjisDatabase>, action: string) =>
        beforeCommit(trx, () =>
          trx
            .insertInto('cjis.audit_event')
            .values({
              agency_id: agencyA,
              actor_kind: 'system',
              action,
              target_type: 'person',
              target_id: personA,
              outcome: 'success',
            })
            .execute()
            .then(() => undefined),
        );
      let go!: () => void;
      const audited = new Promise<void>((r) => (go = r));
      let locked!: () => void;
      const holding = new Promise<void>((r) => (locked = r));
      const rowFirst = withAgency(job, { agencyId: agencyA }, async (trx) => {
        await trx
          .updateTable('cjis.person')
          .set({ display_name: 'Test Person (row first)' })
          .where('id', '=', personA)
          .execute();
        locked();
        await audited;
        expect(audit(trx, 'test.row_first')).toBe(true);
      });
      await holding;
      const auditFirst = withAgency(job, { agencyId: agencyA }, async (trx) => {
        expect(audit(trx, 'test.audit_first')).toBe(true);
        go();
        await trx
          .updateTable('cjis.person')
          .set({ display_name: 'Test Person (audit first)' })
          .where('id', '=', personA)
          .execute();
      });
      await Promise.all([rowFirst, auditFirst]);
      const rows = await job
        .selectFrom('cjis.audit_event')
        .select('action')
        .where('agency_id', '=', agencyA)
        .where('action', 'in', ['test.row_first', 'test.audit_first'])
        .orderBy('seq')
        .execute();
      expect(rows.map((r) => r.action)).toEqual(['test.row_first', 'test.audit_first']);
      // Outside withAgency there is no queue: the caller writes at once.
      await job.transaction().execute(async (trx) => {
        expect(beforeCommit(trx, async () => undefined)).toBe(false);
      });
    });

    it('nobody updates or deletes an audit row, not even the system role', async () => {
      await write(job, agencyA, 1);
      await expect(
        sql`update cjis.audit_event set reason = 'x' where agency_id = ${agencyA}::uuid`.execute(
          job,
        ),
      ).rejects.toThrow(/permission denied|immutable/);
      await expect(
        sql`delete from cjis.audit_event where agency_id = ${agencyA}::uuid`.execute(job),
      ).rejects.toThrow(/permission denied|immutable/);
      await expect(
        withAgency(app, { agencyId: agencyA }, (trx) =>
          sql`update cjis.audit_event set reason = 'x'`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied|immutable/);
      // Even the schema owner changes nothing: row security is forced and has no update policy.
      const byOwner = await sql`update cjis.audit_event set reason = 'x'
        where agency_id = ${agencyA}::uuid`.execute(owner);
      expect(Number(byOwner.numAffectedRows ?? 0)).toBe(0);
    });

    it('an agency reads only its own audit rows', async () => {
      const rows = await withAgency(app, { agencyId: agencyA }, (trx) =>
        trx.selectFrom('cjis.audit_event').select('agency_id').execute(),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.agency_id))).toEqual(new Set([agencyA]));
    });

    it('a changed row is found by the verifier', async () => {
      const tamper = (
        await job
          .insertInto('cjis.agency')
          .values({ name: `Tamper ${run}`, agency_identifier: `TAMPER-${run}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      for (let i = 0; i < 3; i++) await write(job, tamper, i);
      // Only someone with DDL rights can change a row: switch off forced row security and
      // the immutability trigger, as an attacker holding the schema owner's password could.
      await sql`alter table cjis.audit_event no force row level security`.execute(owner);
      await sql`alter table cjis.audit_event disable trigger audit_no_update`.execute(owner);
      try {
        const changed = await sql`update cjis.audit_event set target_id = 'tampered'
                  where agency_id = ${tamper}::uuid and target_id = '1'`.execute(owner);
        expect(Number(changed.numAffectedRows ?? 0)).toBe(1);
      } finally {
        await sql`alter table cjis.audit_event enable trigger audit_no_update`.execute(owner);
        await sql`alter table cjis.audit_event force row level security`.execute(owner);
      }
      const { rows } = await sql<{ ok: boolean; first_bad_seq: string | null }>`
        select ok, first_bad_seq from cjis.audit_verify(${tamper}::uuid)`.execute(job);
      expect(rows[0]?.ok).toBe(false);
      expect(rows[0]?.first_bad_seq).not.toBeNull();
    });
  });
});
