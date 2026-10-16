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

      // Legal holds: one badge, one event, and the safety category.
      for (const scope of [
        { targetType: 'badge', targetId: ids['badgeHeld'] },
        { eventId: heldEventId },
        { dataCategory: 'safety' },
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
