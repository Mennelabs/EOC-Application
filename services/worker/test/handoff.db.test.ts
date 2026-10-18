/**
 * The day-30 hand-off against the database (FL:FR-27, NED-04, NED-05, plan
 * §3.6, §5.2). A case open longer than the county's hand-off period goes to
 * the long-term recovery partner when the survivor consented to that
 * organization type: the grant carries the case sections including the
 * dollars, a referral rides on it, the partner leads the case. Without
 * consent nothing moves and the caseworker who opened the case gets one
 * reminder saying why. A county with no such partner hands off nothing. Runs
 * only with API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { handOffCases, HANDOFF_DAYS_KEY } from '../src/jobs/handoff.ts';
import type { JobContext } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const DAY = 86_400_000;

describe.skipIf(!workerUrl)(
  'day-30 hand-off to the long-term recovery group (database-backed)',
  () => {
    let db: Kysely<Database>;
    let ctx: JobContext;
    let county = '';
    let ltrg = '';
    let caseworker = '';
    const run = randomUUID().slice(0, 8);
    const cases: Record<string, string> = {};
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());

    beforeAll(async () => {
      db = createDb(workerUrl!, 2);
      const seeded = await loadSeed(db);
      const tenant = (kind: 'county' | 'partner_org', parent: string, key: string) =>
        db
          .insertInto('cg.tenant')
          .values({
            kind,
            parent_id: parent,
            slug: `exercise-handoff-${run}-${key}`,
            name: `Exercise ${key} ${run}`,
            status: 'active',
            locales: ['en', 'es'],
            timezone: 'America/Chicago',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      county = (await tenant('county', seeded.tenants['region']!, 'county')).id;
      ltrg = (await tenant('partner_org', county, 'ltrg')).id;
      await withTenant(db, { tenantId: county }, async (trx) => {
        caseworker = (
          await trx
            .insertInto('cg.account')
            .values({
              tenant_id: county,
              email: `caseworker-${run}@example.org`,
              display_name: 'Exercise Caseworker',
              status: 'active',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        const eventId = (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: county,
              name: `Exercise hand-off event ${run}`,
              hazard_type: 'flood',
              status: 'active',
              intake_slug: `handoff${run}`,
              opened_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        // Three households: consented and due; not consented and due; consented but opened yesterday.
        for (const [key, consented, daysOpen] of [
          ['consented', true, 31],
          ['silent', false, 31],
          ['fresh', true, 1],
        ] as const) {
          const party = await trx
            .insertInto('cg.party')
            .values({
              tenant_id: county,
              kind: 'resident',
              contact_enc: await crypto.encrypt(county, JSON.stringify({ phone: '+15555550199' })),
              language: 'en',
              sms_opt_in: true,
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
          if (consented)
            await trx
              .insertInto('cg.consent')
              .values({
                tenant_id: county,
                party_id: party.id,
                report_id: report.id,
                org_type: 'long_term_recovery',
                granted: true,
                granted_at: new Date(),
                channel: 'web',
              })
              .execute();
          const c = await trx
            .insertInto('cg.case')
            .values({
              tenant_id: county,
              report_id: report.id,
              party_id: party.id,
              event_id: eventId,
              status: 'open',
              lead_tenant_id: county,
              opened_by: caseworker,
              opened_at: new Date(Date.now() - daysOpen * DAY),
              created_by: caseworker,
              updated_by: caseworker,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          cases[key] = c.id;
          await trx
            .insertInto('cg.help_received')
            .values({
              tenant_id: county,
              case_id: c.id,
              source_kind: 'fema_ia',
              source_name: 'FEMA IA (exercise)',
              help_type: 'Rental assistance',
              amount: 2950,
              given_on: '2026-10-01',
              recorded_tenant_id: county,
              recorded_by: caseworker,
              created_by: caseworker,
              updated_by: caseworker,
            })
            .execute();
        }
      });
      ctx = {
        db,
        crypto,
        log: { info() {}, warn() {}, error() {}, debug() {} },
        urls: { gatewayPublic: 'https://cg.example.org', idpPublic: '', idpInternal: '' },
        mail: { send: async () => undefined },
      } as unknown as JobContext;
    });

    afterAll(async () => {
      await db
        ?.updateTable('cg.tenant')
        .set({ status: 'closed' })
        .where('slug', 'like', `exercise-handoff-${run}-%`)
        .execute();
      await db?.destroy();
    });

    const caseRow = (id: string) =>
      db.selectFrom('cg.case').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

    it('with no long-term recovery partner under agreement nothing moves', async () => {
      const run1 = await handOffCases(ctx);
      expect(run1.noPartner).toBeGreaterThanOrEqual(1);
      expect((await caseRow(cases['consented']!)).status).toBe('open');
    });

    it('FL:FR-27: a due case with consent is handed to the partner with a grant carrying the dollars and a referral; without consent the caseworker is told once', async () => {
      await withTenant(db, { tenantId: county }, (trx) =>
        trx
          .insertInto('cg.data_sharing_agreement')
          .values({
            from_tenant_id: county,
            to_tenant_id: ltrg,
            scope: 'consented_records',
            data_categories: ['contact', 'household', 'financial', 'free_text'],
            status: 'signed',
            terms: JSON.stringify({ orgType: 'long_term_recovery', service: 'case_management' }),
            signed_at: new Date(),
            signed_by: caseworker,
            created_by: caseworker,
            updated_by: caseworker,
          })
          .execute(),
      );
      const run1 = await handOffCases(ctx);
      expect(run1).toMatchObject({ handedOff: 1, waitingOnConsent: 1 });
      const handed = await caseRow(cases['consented']!);
      expect(handed).toMatchObject({
        status: 'handed_off',
        lead_tenant_id: ltrg,
        handed_off_to_tenant_id: ltrg,
      });
      expect(handed.handed_off_at).not.toBeNull();
      expect(handed.handoff_referral_id).not.toBeNull();
      const grant = await db
        .selectFrom('cg.share_grant')
        .select(['sections', 'org_type', 'revoked_at'])
        .where('report_id', '=', handed.report_id)
        .where('to_tenant_id', '=', ltrg)
        .executeTakeFirstOrThrow();
      expect(grant.org_type).toBe('long_term_recovery');
      expect(grant.revoked_at).toBeNull();
      expect(grant.sections).toEqual(
        expect.arrayContaining(['recovery_plan', 'help_received', 'appointments', 'contact']),
      );
      const referral = await db
        .selectFrom('cg.referral')
        .select(['to_tenant_id', 'status', 'purpose', 'report_id'])
        .where('id', '=', handed.handoff_referral_id!)
        .executeTakeFirstOrThrow();
      expect(referral).toMatchObject({
        to_tenant_id: ltrg,
        status: 'open',
        report_id: handed.report_id,
      });
      expect(referral.purpose).toContain('long-term recovery group');
      // Not consented: open, led by the county, one reminder to the caseworker who opened it.
      expect((await caseRow(cases['silent']!)).status).toBe('open');
      const reminders = await db
        .selectFrom('cg.reminder')
        .select(['owner_account_id', 'title', 'state'])
        .where('subject_kind', '=', 'case')
        .where('subject_id', '=', cases['silent']!)
        .execute();
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({ owner_account_id: caseworker, state: 'active' });
      expect(reminders[0]!.title).toContain("survivor's consent");
      // Opened yesterday: not due.
      expect((await caseRow(cases['fresh']!)).status).toBe('open');
      // A second run hands off nothing more and adds no second reminder.
      const run2 = await handOffCases(ctx);
      expect(run2.handedOff).toBe(0);
      expect(
        (
          await db
            .selectFrom('cg.reminder')
            .select('id')
            .where('subject_kind', '=', 'case')
            .where('subject_id', '=', cases['silent']!)
            .execute()
        ).length,
      ).toBe(1);
    });

    it('plan §6 question 3: the county sets its own period', async () => {
      await withTenant(db, { tenantId: county }, (trx) =>
        trx
          .insertInto('cg.tenant_config')
          .values({ tenant_id: county, key: HANDOFF_DAYS_KEY, value: JSON.stringify(0.5) })
          .execute(),
      );
      // Not an integer: the default of 30 holds, so the fresh case still waits.
      expect((await handOffCases(ctx)).handedOff).toBe(0);
      await withTenant(db, { tenantId: county }, (trx) =>
        trx
          .updateTable('cg.tenant_config')
          .set({ value: JSON.stringify(1) })
          .where('tenant_id', '=', county)
          .where('key', '=', HANDOFF_DAYS_KEY)
          .execute(),
      );
      ctx.now = () => new Date(Date.now() + 2 * DAY);
      expect((await handOffCases(ctx)).handedOff).toBe(1);
      expect((await caseRow(cases['fresh']!)).status).toBe('handed_off');
    });
  },
);
