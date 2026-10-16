/**
 * Retention sweeps by category against a real PostgreSQL (SEC-13): expired,
 * finished rows go, with their history, and are counted in the deletion log
 * and the audit; fresh rows, open records (a child still checked in, an
 * unresolved safety alert, an active contact), rows another record still
 * points at, and anything under a legal hold (on the category, the record or
 * its event) stay. Runs only with API_DB_TEST_WORKER_URL set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Kysely } from 'kysely';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { SWEEPS, sweepRetention } from '../src/jobs/retention.ts';
import type { JobContext } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const bytes = (s: string) => Buffer.from(s);

describe.skipIf(!workerUrl)('retention sweeps by category (database-backed)', () => {
  let db: Kysely<Database>;
  let tenantId: string;
  /** The seeded county, read only: its retention categories are the product's defaults. */
  let seededCounty: string;
  let adminId: string;
  let eventId: string;
  let heldEventId: string;
  let personnelId: string;
  let siteId: string;
  const tag = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  const holds: string[] = [];
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { tenantId }, fn);
  const exists = async (table: keyof Database, id: string) =>
    (await db
      .selectFrom(table as 'cg.badge')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst()) !== undefined;

  beforeAll(async () => {
    db = createDb(workerUrl!, 2);
    const seeded = await loadSeed(db);
    seededCounty = seeded.tenants['county']!;
    // A county of its own: the shared seeded county stays as the browser journeys expect it.
    tenantId = (
      await db
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-retention-${tag}`,
          name: `Exercise retention county ${tag}`,
          status: 'provisioning',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    adminId = randomUUID();
    await tx(async (trx) => {
      // The product's defaults for the categories swept here (SEC-13).
      for (const [category, keep] of [
        ['drafts', '7 days'],
        ['reminders', '1 year'],
        ['child_records', '1 year'],
        ['badges', '3 years'],
        ['contacts', '3 years'],
        ['safety', '7 years'],
        ['comms', '7 years'],
        ['referrals', '7 years'],
        ['sharing', '7 years'],
        ['publications', '7 years'],
        ['field_records', '7 years'],
        ['sessions', '90 days'],
      ])
        await trx
          .insertInto('cg.retention_policy')
          .values({
            tenant_id: tenantId,
            data_category: category!,
            keep_for: keep!,
            rule: 'duration',
            note: 'Exercise: retention sweep test',
          })
          .execute();
      const ev = (name: string) =>
        trx
          .insertInto('cg.event')
          .values({
            tenant_id: tenantId,
            name,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      eventId = (await ev(`Exercise retention ${tag}`)).id;
      heldEventId = (await ev(`Exercise retention held ${tag}`)).id;
      personnelId = (
        await trx
          .insertInto('cg.personnel')
          .values({ tenant_id: tenantId, name: `Exercise retention ${tag}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      siteId = (
        await trx
          .insertInto('cg.site')
          .values({
            tenant_id: tenantId,
            event_id: eventId,
            kind: 'shelter',
            name: `Exercise retention site ${tag}`,
            slug: `exercise-retention-${tag}`,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

      // Drafts (7 days by default): one expired, one fresh.
      for (const [k, at] of [
        ['draftOld', ago(10)],
        ['draftNew', ago(1)],
      ] as const)
        ids[k] = (
          await trx
            .insertInto('cg.draft')
            .values({
              tenant_id: tenantId,
              resume_code_hash: bytes(`${tag}${k}`),
              execution_id: randomUUID(),
              payload_enc: bytes('x'),
              expires_at: at,
              created_at: at,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      // Reminders (1 year): completed long ago with its history; still active; a held one.
      const reminder = async (k: string, state: 'completed' | 'active', at: Date, ev: string) => {
        const r = await trx
          .insertInto('cg.reminder')
          .values({
            tenant_id: tenantId,
            event_id: ev,
            kind: 'custom',
            title: `Exercise ${k} ${tag}`,
            due_at: at,
            state,
            ...(state === 'completed' ? { completed_at: at } : {}),
            created_at: at,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.reminder_event')
          .values({ tenant_id: tenantId, reminder_id: r.id, kind: 'created' })
          .execute();
        ids[k] = r.id;
      };
      await reminder('reminderDone', 'completed', ago(400), eventId);
      await reminder('reminderActive', 'active', ago(400), eventId);
      await reminder('reminderHeldEvent', 'completed', ago(400), heldEventId);

      // Child records (1 year): checked out long ago; still checked in.
      for (const [k, out] of [
        ['childOut', ago(400)],
        ['childIn', null],
      ] as const)
        ids[k] = (
          await trx
            .insertInto('cg.child_check_in')
            .values({
              tenant_id: tenantId,
              site_id: siteId,
              child_enc: bytes('c'),
              age_band: '6-9',
              guardian_enc: bytes('g'),
              pickup_code_hash: bytes(`${tag}${k}`),
              checked_in_at: ago(401),
              checked_out_at: out,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      // Badges (3 years): revoked long ago with its history; held by record.
      for (const k of ['badgeOld', 'badgeHeld']) {
        const b = await trx
          .insertInto('cg.badge')
          .values({
            tenant_id: tenantId,
            personnel_id: personnelId,
            event_id: eventId,
            display_name: 'Exercise badge',
            valid_from: ago(1500),
            valid_to: ago(1400),
            state: 'revoked',
            revoked_at: ago(1400),
            code_hash: bytes(`${tag}${k}`),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.badge_event')
          .values({ tenant_id: tenantId, badge_id: b.id, kind: 'revoked' })
          .execute();
        ids[k] = b.id;
      }

      // Contacts (3 years): inactive long ago; inactive but a site's lead; still active.
      const contact = async (k: string, active: boolean) =>
        (ids[k] = (
          await trx
            .insertInto('cg.partner_contact')
            .values({
              tenant_id: tenantId,
              agency: `Exercise agency ${tag}`,
              name_enc: bytes('n'),
              methods_enc: bytes('m'),
              active,
              created_at: ago(1200),
              updated_at: ago(1200),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id);
      await contact('contactGone', false);
      await contact('contactLead', false);
      await contact('contactActive', true);
      await trx
        .updateTable('cg.site')
        .set({ lead_contact_id: ids['contactLead']! })
        .where('id', '=', siteId)
        .execute();

      // Safety alerts (7 years): resolved long ago; resolved long ago but the category is held.
      ids['safetyOld'] = (
        await trx
          .insertInto('cg.safety_alert')
          .values({
            tenant_id: tenantId,
            event_id: eventId,
            kind: 'help_button',
            state: 'resolved',
            raised_at: ago(3000),
            resolved_at: ago(3000),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

      // The 7-year categories: communications, referrals, sharing, publications.
      const message = await trx
        .insertInto('cg.field_message')
        .values({
          tenant_id: tenantId,
          event_id: eventId,
          body: 'Exercise: road closed at the bridge',
          audience_kind: 'event',
          sent_at: ago(3000),
          created_at: ago(3000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids['messageOld'] = message.id;
      await trx
        .insertInto('cg.field_message_receipt')
        .values({ tenant_id: tenantId, message_id: message.id, personnel_id: personnelId })
        .execute();
      ids['commsOld'] = (
        await trx
          .insertInto('cg.comms_log')
          .values({
            tenant_id: tenantId,
            event_id: eventId,
            net: 'Exercise net',
            kind: 'message',
            entry_at: ago(3000),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const grant = async (k: string) =>
        (ids[k] = (
          await trx
            .insertInto('cg.share_grant')
            .values({
              tenant_id: tenantId,
              to_tenant_id: tenantId,
              org_type: 'voad',
              revoked_at: ago(3000),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id);
      await grant('grantGone');
      await grant('grantReferred');
      for (const [k, status, g] of [
        ['referralDone', 'done', null],
        ['referralOpen', 'open', ids['grantReferred']],
      ] as const)
        ids[k] = (
          await trx
            .insertInto('cg.referral')
            .values({
              tenant_id: tenantId,
              from_tenant_id: tenantId,
              to_org_type: 'voad',
              purpose: 'Exercise: food',
              opened_by: adminId,
              status,
              share_grant_id: g,
              ...(status === 'done' ? { closed_at: ago(3000) } : {}),
              updated_at: ago(3000),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      for (const [k, at] of [
        ['publicationOld', ago(3001)],
        ['publicationCurrent', ago(3000)],
      ] as const)
        ids[k] = (
          await trx
            .insertInto('cg.publication')
            .values({
              tenant_id: tenantId,
              subject_kind: 'site',
              subject_id: siteId,
              subject_version: 1,
              snapshot: JSON.stringify({ name: 'Exercise' }),
              approved_by: adminId,
              approved_at: at,
              reason: 'Exercise: published',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      // Field records: kept 7 years after their event closes (SEC-13).
      const closed = async (name: string) =>
        (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: tenantId,
              name,
              hazard_type: 'flood',
              status: 'closed',
              opened_at: ago(3100),
              closed_at: ago(3000),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const closedId = await closed(`Exercise retention closed ${tag}`);
      const closedHeldId = await closed(`Exercise retention closed held ${tag}`);
      for (const [k, ev] of [
        ['logClosed', closedId],
        ['logOpen', eventId],
        ['logHeldEvent', closedHeldId],
      ] as const)
        ids[k] = (
          await trx
            .insertInto('cg.service_log')
            .values({
              tenant_id: tenantId,
              event_id: ev,
              client_uuid: randomUUID(),
              kind: 'meal',
              personnel_id: personnelId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const teamId = (
        await trx
          .insertInto('cg.team')
          .values({ tenant_id: tenantId, key: `retention-${tag}`, name: `Exercise team ${tag}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      for (const k of ['checkInGone', 'checkInNamed'])
        ids[k] = (
          await trx
            .insertInto('cg.check_in')
            .values({
              tenant_id: tenantId,
              personnel_id: personnelId,
              event_id: closedId,
              method: 'event_code',
              started_at: ago(3050),
              ended_at: ago(3049),
              end_reason: 'checked_out',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      ids['teamStatus'] = (
        await trx
          .insertInto('cg.team_status')
          .values({
            tenant_id: tenantId,
            team_id: teamId,
            status: 'available',
            source: 'app',
            check_in_id: ids['checkInGone']!,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // A recent log entry still names the other check-in.
      await trx
        .insertInto('cg.comms_log')
        .values({
          tenant_id: tenantId,
          event_id: eventId,
          net: 'Exercise net',
          kind: 'check_out',
          check_in_id: ids['checkInNamed']!,
          entry_at: ago(1),
        })
        .execute();
      for (const [k, n] of [
        ['missionDone', 1],
        ['missionHeld', 2],
      ] as const) {
        ids[k] = (
          await trx
            .insertInto('cg.mission')
            .values({
              tenant_id: tenantId,
              event_id: closedId,
              reference: `RET-${tag}-${n}`,
              kind: 'other',
              source: 'staff',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        const a = `${k}Assignment`;
        ids[a] = (
          await trx
            .insertInto('cg.assignment')
            .values({
              tenant_id: tenantId,
              mission_id: ids[k]!,
              resource_kind: 'person',
              personnel_id: personnelId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        await trx
          .insertInto('cg.assignment_event')
          .values({ tenant_id: tenantId, assignment_id: ids[a]!, kind: 'assigned' })
          .execute();
      }

      // The field change feed (sessions, 90 days): two old entries and a recent one.
      for (const [k, at] of [
        ['feedOld1', ago(120)],
        ['feedOld2', ago(100)],
        ['feedNew', ago(1)],
      ] as const)
        ids[k] = String(
          (
            await trx
              .insertInto('cg.change_feed')
              .values({
                tenant_id: tenantId,
                scope_kind: 'event',
                scope_id: eventId,
                record_type: 'mission',
                record_id: randomUUID(),
                record_version: 1,
                op: 'upsert',
                created_at: at,
              })
              .returning('seq')
              .executeTakeFirstOrThrow()
          ).seq,
        );

      // Legal holds: one badge, one event, the safety category, a closed event and a mission.
      for (const scope of [
        { targetType: 'badge', targetId: ids['badgeHeld'] },
        { eventId: heldEventId },
        { dataCategory: 'safety' },
        { eventId: closedHeldId },
        { targetType: 'mission', targetId: ids['missionHeld'] },
      ])
        holds.push(
          (
            await trx
              .insertInto('cg.legal_hold')
              .values({
                tenant_id: tenantId,
                scope: JSON.stringify(scope),
                reason: 'Exercise: retention sweep test',
                placed_by: adminId,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id,
        );
    });
  });

  afterAll(async () => {
    if (holds.length)
      await tx((trx) =>
        trx
          .updateTable('cg.legal_hold')
          .set({ released_at: new Date(), released_by: adminId })
          .where('id', 'in', holds)
          .execute(),
      );
    await db
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', tenantId)
      .execute();
    await db?.destroy();
  });

  it('SEC-13: every swept category is one the tenant can set, and every sweep names one', async () => {
    const categories = await db
      .selectFrom('cg.retention_policy')
      .select('data_category')
      .where('tenant_id', '=', seededCounty)
      .execute();
    const known = new Set(categories.map((c) => c.data_category));
    for (const s of SWEEPS) expect(known, s.table).toContain(s.category);
  });

  it('SEC-13: expired, finished rows go with their history; open, referenced and held rows stay; each deletion is logged and audited', async () => {
    const ctx = { db, log: pino({ level: 'silent' }) } as unknown as JobContext;
    const deleted = await sweepRetention(ctx);
    expect(deleted).toBeGreaterThanOrEqual(5);

    expect(await exists('cg.draft', ids['draftOld']!)).toBe(false);
    expect(await exists('cg.draft', ids['draftNew']!)).toBe(true);

    expect(await exists('cg.reminder', ids['reminderDone']!)).toBe(false);
    const history = await db
      .selectFrom('cg.reminder_event')
      .select('id')
      .where('reminder_id', '=', ids['reminderDone']!)
      .execute();
    expect(history).toEqual([]);
    expect(await exists('cg.reminder', ids['reminderActive']!)).toBe(true);
    expect(await exists('cg.reminder', ids['reminderHeldEvent']!)).toBe(true);

    expect(await exists('cg.child_check_in', ids['childOut']!)).toBe(false);
    expect(await exists('cg.child_check_in', ids['childIn']!)).toBe(true);

    expect(await exists('cg.badge', ids['badgeOld']!)).toBe(false);
    expect(await exists('cg.badge', ids['badgeHeld']!)).toBe(true);

    expect(await exists('cg.partner_contact', ids['contactGone']!)).toBe(false);
    expect(await exists('cg.partner_contact', ids['contactLead']!)).toBe(true);
    expect(await exists('cg.partner_contact', ids['contactActive']!)).toBe(true);

    expect(await exists('cg.safety_alert', ids['safetyOld']!)).toBe(true);

    // 7-year categories: old communications go with their receipts; a finished referral and a
    // revoked grant go, but a grant an open referral still uses stays; a superseded publication
    // goes and the one still in force stays.
    expect(await exists('cg.field_message', ids['messageOld']!)).toBe(false);
    expect(
      await db
        .selectFrom('cg.field_message_receipt')
        .select('id')
        .where('message_id', '=', ids['messageOld']!)
        .execute(),
    ).toEqual([]);
    expect(await exists('cg.comms_log', ids['commsOld']!)).toBe(false);
    expect(await exists('cg.referral', ids['referralDone']!)).toBe(false);
    expect(await exists('cg.referral', ids['referralOpen']!)).toBe(true);
    expect(await exists('cg.share_grant', ids['grantGone']!)).toBe(false);
    expect(await exists('cg.share_grant', ids['grantReferred']!)).toBe(true);
    expect(await exists('cg.publication', ids['publicationOld']!)).toBe(false);
    expect(await exists('cg.publication', ids['publicationCurrent']!)).toBe(true);

    // Field records: 7 years after their event closed they go, with their history; an open
    // event's stay, as do a held event's, a check-in a log entry still names, and the
    // assignments of a held mission (the missions themselves are core records).
    expect(await exists('cg.service_log', ids['logClosed']!)).toBe(false);
    expect(await exists('cg.service_log', ids['logOpen']!)).toBe(true);
    expect(await exists('cg.service_log', ids['logHeldEvent']!)).toBe(true);
    expect(await exists('cg.check_in', ids['checkInGone']!)).toBe(false);
    expect(await exists('cg.team_status', ids['teamStatus']!)).toBe(false);
    expect(await exists('cg.check_in', ids['checkInNamed']!)).toBe(true);
    expect(await exists('cg.assignment', ids['missionDoneAssignment']!)).toBe(false);
    expect(
      await db
        .selectFrom('cg.assignment_event')
        .select('id')
        .where('assignment_id', '=', ids['missionDoneAssignment']!)
        .execute(),
    ).toEqual([]);
    expect(await exists('cg.assignment', ids['missionHeldAssignment']!)).toBe(true);
    expect(await exists('cg.mission', ids['missionDone']!)).toBe(true);

    // The change feed: old entries go and the mark says how far, so a phone behind it starts over.
    const feed = await db
      .selectFrom('cg.change_feed')
      .select('seq')
      .where('tenant_id', '=', tenantId)
      .execute();
    const left = feed.map((f) => String(f.seq));
    expect(left).toContain(ids['feedNew']);
    expect(left).not.toContain(ids['feedOld1']);
    expect(left).not.toContain(ids['feedOld2']);
    const mark = await db
      .selectFrom('cg.change_feed_pruned')
      .select('through_seq')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(String(mark.through_seq)).toBe(ids['feedOld2']);

    const log = await db
      .selectFrom('cg.deletion_log')
      .select(['data_category', 'target_type', 'deleted_count'])
      .where('tenant_id', '=', tenantId)
      .where('ran_at', '>', ago(0.01))
      .execute();
    for (const [category, table] of [
      ['drafts', 'draft'],
      ['reminders', 'reminder'],
      ['child_records', 'child_check_in'],
      ['badges', 'badge'],
      ['contacts', 'partner_contact'],
      ['field_records', 'service_log'],
      ['field_records', 'check_in'],
      ['field_records', 'assignment'],
      ['sessions', 'change_feed'],
    ])
      expect(log.find((l) => l.target_type === table)?.data_category, table).toBe(category);
    expect(log.find((l) => l.target_type === 'safety_alert')).toBeUndefined();
    const audited = await db
      .selectFrom('cg.audit_event')
      .select('target_type')
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'retention.delete')
      .where('occurred_at', '>', ago(0.01))
      .execute();
    expect(audited.map((a) => a.target_type)).toEqual(
      expect.arrayContaining(['draft', 'reminder', 'child_check_in', 'badge', 'partner_contact']),
    );

    // A second run finds nothing more of these.
    await sweepRetention(ctx);
    expect(await exists('cg.reminder', ids['reminderActive']!)).toBe(true);
  });

  it('SEC-13: the API role still cannot delete what only the sweep may', async () => {
    const appUrl = process.env['API_DB_TEST_APP_URL'];
    if (!appUrl) return;
    const app = createDb(appUrl, 1);
    try {
      const gone = await withTenant(app, { tenantId }, (trx) =>
        trx.deleteFrom('cg.badge').where('id', '=', ids['badgeHeld']!).executeTakeFirst(),
      );
      expect(Number(gone.numDeletedRows)).toBe(0);
      expect(await exists('cg.badge', ids['badgeHeld']!)).toBe(true);
    } finally {
      await app.destroy();
    }
  });
});
