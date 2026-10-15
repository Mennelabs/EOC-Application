/**
 * Reminders and notices against a real PostgreSQL (migrations applied, seed
 * loaded): a published site's lead hears before its confirmation window
 * lapses and again when it lapsed (PUB-03); an expired resource leaves the
 * page, the log records it and the owner hears (BRD:FR-16.03, AC-16B);
 * review dates and broken outside links reach the owner once; the contact
 * digest goes once a week (CNT-01); a publication and its withdrawal are
 * noticed once each (PUB-06), and a partner's own post names the partner
 * and its approver (2026-10-15). Every reminder is sent exactly once however
 * often the job runs (F09, BRD:FR-00.06). Runs only with
 * API_DB_TEST_WORKER_URL set; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { SimulatorSms } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import type { Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../src/idp/keycloak.ts';
import { messageSend } from '../src/jobs/messages.ts';
import {
  noticePublications,
  remindContactVerification,
  remindSiteConfirmations,
  reviewResources,
} from '../src/jobs/reminders.ts';
import type { JobContext } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const HOUR = 3_600_000;

describe.skipIf(!workerUrl)('worker reminders (database-backed)', () => {
  let db: Kysely<Database>;
  let tenantId: string;
  let adminId: string;
  let ctx: JobContext;
  const mails: { to: string; subject: string; text: string }[] = [];
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const tag = randomUUID().slice(0, 8);
  let lastOutboxId = 0;
  let siteId: string;
  let expiredResourceId: string;
  let reviewResourceId: string;
  let contactId: string;
  let publicationId: string;

  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { tenantId }, fn);

  /** Runs the queued emails through the message job; returns the ones sent by this call. */
  async function drain() {
    const rows = await db
      .selectFrom('cg.outbox')
      .select(['id', 'tenant_id', 'topic', 'payload', 'execution_id'])
      .where('tenant_id', '=', tenantId)
      .where('topic', '=', 'message.send')
      .where('id', '>', lastOutboxId)
      .orderBy('id')
      .execute();
    const before = mails.length;
    for (const row of rows) {
      lastOutboxId = Math.max(lastOutboxId, Number(row.id));
      // In CI the stack's own worker shares this database and queues messages under the stack's
      // key; those are not this suite's, and only this suite's key can read its own (SEC-10).
      const toEnc = (row.payload as { toEnc?: string }).toEnc;
      if (toEnc) {
        const readable = await ctx.crypto
          .decrypt(row.tenant_id, Buffer.from(toEnc, 'base64'))
          .then(() => true)
          .catch(() => false);
        if (!readable) continue;
      }
      await messageSend(ctx, {
        id: Number(row.id),
        tenantId: row.tenant_id,
        topic: row.topic,
        payload: row.payload as Record<string, unknown>,
        executionId: row.execution_id,
      });
    }
    return mails.slice(before);
  }

  async function reminders(kind: string, subjectId: string) {
    return db
      .selectFrom('cg.notice_log')
      .select(['id', 'kind', 'state', 'recipient_count', 'cycle_key'])
      .where('tenant_id', '=', tenantId)
      .where('kind', '=', kind as never)
      .where('subject_id', '=', subjectId)
      .execute();
  }

  beforeAll(async () => {
    db = createDb(workerUrl!, 2);
    const seeded = await loadSeed(db);
    tenantId = seeded.tenants['county']!;
    const admin = await db
      .selectFrom('cg.account')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('email', '=', 'admin@example.org')
      .executeTakeFirstOrThrow();
    adminId = admin.id;
    const top = await db
      .selectFrom('cg.outbox')
      .select((eb) => eb.fn.max('id').as('m'))
      .executeTakeFirst();
    lastOutboxId = Number(top?.m ?? 0);
    ctx = {
      db,
      log: pino({ level: 'silent' }),
      idp: {} as unknown as KeycloakAdmin,
      mail: { send: async (m) => void mails.push(m) },
      sms: new SimulatorSms(),
      crypto,
      urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
      objects: null,
      devDirectGrant: false,
      ai: { providerFor: async () => fakeProvider },
      defaultGraph: westwindGraph,
      linkCheck: async () => false,
    };
  });

  afterAll(async () => {
    // Leave the public page as the seed made it (the browser tests read the same database).
    await tx(async (trx) => {
      if (siteId)
        await trx
          .updateTable('cg.site')
          .set({ status: 'closed', unpublished_at: new Date() })
          .where('id', '=', siteId)
          .execute();
      for (const id of [expiredResourceId, reviewResourceId])
        if (id)
          await trx
            .updateTable('cg.resource')
            .set({ status: 'removed', unpublished_at: new Date() })
            .where('id', '=', id)
            .execute();
      if (contactId)
        await trx.deleteFrom('cg.partner_contact').where('id', '=', contactId).execute();
    });
    await db?.destroy();
  });

  it('reminds the people who can confirm a site before its window lapses, once per window (PUB-03, F09)', async () => {
    const now = Date.now();
    siteId = await tx(async (trx) => {
      const row = await trx
        .insertInto('cg.site')
        .values({
          tenant_id: tenantId,
          kind: 'shelter',
          name: `Reminder test shelter ${tag}`,
          slug: `reminder-test-${tag}`,
          status: 'open',
          confirm_every_hours: 2,
          last_confirmed_at: new Date(now - 100 * 60_000), // 20 minutes left of a 2-hour window
          published_version: 1,
          published_at: new Date(now - 24 * HOUR),
          created_by: adminId,
          updated_by: adminId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    await remindSiteConfirmations(ctx);
    const sent = await drain();
    const rows = await reminders('site_reconfirm', siteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('sent');
    expect(rows[0]!.recipient_count).toBeGreaterThan(0);
    const mine = sent.filter((m) => m.subject.includes(`Reminder test shelter ${tag}`));
    expect(mine).toHaveLength(rows[0]!.recipient_count);
    expect(mine[0]!.text).toContain('hidden on every channel');
    expect(new Set(mine.map((m) => m.to)).size).toBe(mine.length);

    await remindSiteConfirmations(ctx);
    expect(await drain()).toHaveLength(0);
    expect(await reminders('site_reconfirm', siteId)).toHaveLength(1);
  });

  it('says so once when the window lapsed and the site left the public channels (PUB-03)', async () => {
    await tx((trx) =>
      trx
        .updateTable('cg.site')
        .set({ last_confirmed_at: new Date(Date.now() - 3 * HOUR) })
        .where('id', '=', siteId)
        .execute(),
    );
    await remindSiteConfirmations(ctx);
    const sent = await drain();
    const rows = await reminders('site_hidden', siteId);
    expect(rows).toHaveLength(1);
    const mine = sent.filter((m) => m.subject.includes('hidden until confirmed'));
    expect(mine).toHaveLength(rows[0]!.recipient_count);
    const audit = await db
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', tenantId)
      .where('target_id', '=', siteId)
      .where('action', '=', 'site.hidden_unconfirmed')
      .execute();
    expect(audit).toHaveLength(1);
    await remindSiteConfirmations(ctx);
    expect(await drain()).toHaveLength(0);
  });

  it('expires a resource past its date, records it in the publication log and tells the owner once (BRD:FR-16.03, AC-16B)', async () => {
    const now = new Date();
    expiredResourceId = await tx(async (trx) => {
      const r = await trx
        .insertInto('cg.resource')
        .values({
          tenant_id: tenantId,
          slug: `reminder-expired-${tag}`,
          type: 'deadline',
          status: 'published',
          owner_account_id: adminId,
          expires_at: new Date(now.getTime() - 60_000),
          published_version: 1,
          published_at: new Date(now.getTime() - HOUR),
          created_by: adminId,
          updated_by: adminId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cg.resource_text')
        .values({
          tenant_id: tenantId,
          resource_id: r.id,
          locale: 'en',
          title: `Reminder test deadline ${tag}`,
          human_reviewed_by: adminId,
          reviewed_at: now,
          created_by: adminId,
          updated_by: adminId,
        })
        .execute();
      await trx
        .insertInto('cg.publication')
        .values({
          tenant_id: tenantId,
          subject_kind: 'resource',
          subject_id: r.id,
          subject_version: 1,
          snapshot: JSON.stringify({ title: `Reminder test deadline ${tag}` }),
          approved_by: adminId,
          reason: 'reminder test',
        })
        .execute();
      return r.id;
    });
    await reviewResources(ctx);
    const sent = await drain();
    const resource = await db
      .selectFrom('cg.resource')
      .select('status')
      .where('id', '=', expiredResourceId)
      .executeTakeFirstOrThrow();
    expect(resource.status).toBe('expired');
    const publication = await db
      .selectFrom('cg.publication')
      .select('unpublished_at')
      .where('subject_id', '=', expiredResourceId)
      .executeTakeFirstOrThrow();
    expect(publication.unpublished_at).not.toBeNull();
    const rows = await reminders('resource_expired', expiredResourceId);
    expect(rows).toHaveLength(1);
    const mine = sent.filter((m) => m.subject.includes(`Reminder test deadline ${tag}`));
    expect(mine).toHaveLength(rows[0]!.recipient_count);
    expect(mine.some((m) => m.to === 'admin@example.org')).toBe(true); // the owner
    expect(mine[0]!.text).toContain('expired on');
    const audit = await db
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', tenantId)
      .where('target_id', '=', expiredResourceId)
      .where('action', '=', 'resource.expired')
      .execute();
    expect(audit).toHaveLength(1);
    await reviewResources(ctx);
    expect((await drain()).filter((m) => m.subject.includes(tag))).toHaveLength(0);
  });

  it('reminds once per review date and once a day for an outside link that does not answer (BRD:FR-16.03)', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * HOUR).toISOString().slice(0, 10);
    reviewResourceId = await tx(async (trx) => {
      const r = await trx
        .insertInto('cg.resource')
        .values({
          tenant_id: tenantId,
          slug: `reminder-review-${tag}`,
          type: 'link',
          status: 'published',
          owner_account_id: adminId,
          review_at: yesterday,
          reference_url: `https://example.org/reminder-${tag}`,
          published_version: 1,
          published_at: new Date(now.getTime() - HOUR),
          created_by: adminId,
          updated_by: adminId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cg.resource_text')
        .values({
          tenant_id: tenantId,
          resource_id: r.id,
          locale: 'en',
          title: `Reminder test link ${tag}`,
          human_reviewed_by: adminId,
          reviewed_at: now,
          created_by: adminId,
          updated_by: adminId,
        })
        .execute();
      return r.id;
    });
    await reviewResources(ctx);
    const sent = (await drain()).filter((m) => m.subject.includes(`Reminder test link ${tag}`));
    const review = await reminders('resource_review', reviewResourceId);
    const link = await reminders('resource_link', reviewResourceId);
    expect(review).toHaveLength(1);
    expect(review[0]!.cycle_key).toBe(yesterday);
    expect(link).toHaveLength(1);
    expect(sent).toHaveLength(review[0]!.recipient_count + link[0]!.recipient_count);
    expect(sent.some((m) => m.text.includes('due for review'))).toBe(true);
    expect(sent.some((m) => m.text.includes('did not answer'))).toBe(true);
    const resource = await db
      .selectFrom('cg.resource')
      .select(['link_status', 'link_checked_at'])
      .where('id', '=', reviewResourceId)
      .executeTakeFirstOrThrow();
    expect(resource.link_status).toBe('broken');
    expect(resource.link_checked_at).not.toBeNull();

    // The link answers now, but it was checked today: nothing changes until tomorrow; the review stays reminded.
    ctx.linkCheck = async () => true;
    await reviewResources(ctx);
    expect((await drain()).filter((m) => m.subject.includes(tag))).toHaveLength(0);
    expect(await reminders('resource_review', reviewResourceId)).toHaveLength(1);

    // MET-07: the checks go out with no transaction open, and a link edited while
    // its check was out keeps its own state rather than the old link's answer.
    const edited = `https://example.org/reminder-${tag}-edited`;
    await db
      .updateTable('cg.resource')
      .set({ link_checked_at: null })
      .where('id', '=', reviewResourceId)
      .execute();
    ctx.linkCheck = async (url) => {
      if (url.endsWith('-edited')) return true;
      // The page's owner fixes the link while the old one is being checked.
      await db
        .updateTable('cg.resource')
        .set({ reference_url: edited })
        .where('id', '=', reviewResourceId)
        .execute();
      return false;
    };
    await reviewResources(ctx);
    const after = await db
      .selectFrom('cg.resource')
      .select(['reference_url', 'link_status', 'link_checked_at'])
      .where('id', '=', reviewResourceId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ reference_url: edited, link_status: 'broken', link_checked_at: null });
    await drain();
  });

  it('sends one digest a week of contacts due for re-verification, without names or numbers (CNT-01, F17)', async () => {
    const agency = `Reminder Test Agency ${tag}`;
    contactId = await tx(async (trx) => {
      await trx
        .deleteFrom('cg.notice_log')
        .where('tenant_id', '=', tenantId)
        .where('kind', '=', 'contact_reverify')
        .execute(); // a previous run this week
      const row = await trx
        .insertInto('cg.partner_contact')
        .values({
          tenant_id: tenantId,
          agency,
          role: 'Duty officer',
          name_enc: await crypto.encrypt(tenantId, 'Pat Example'),
          methods_enc: await crypto.encrypt(
            tenantId,
            JSON.stringify({ phone: '314-555-0100', email: 'pat@example.org' }),
          ),
          type: 'liaison',
          verify_by: new Date(Date.now() + 7 * 24 * HOUR).toISOString().slice(0, 10),
          owner_account_id: adminId,
          created_by: adminId,
          updated_by: adminId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    await remindContactVerification(ctx);
    const sent = (await drain()).filter((m) => m.subject.includes('re-verification'));
    const rows = await reminders('contact_reverify', tenantId);
    expect(rows).toHaveLength(1);
    expect(sent).toHaveLength(rows[0]!.recipient_count);
    expect(sent.some((m) => m.to === 'admin@example.org')).toBe(true); // the owner
    expect(sent[0]!.text).toContain(agency);
    expect(sent[0]!.text).toContain('verify by');
    expect(sent[0]!.text).not.toContain('Pat Example');
    expect(sent[0]!.text).not.toContain('555-0100');
    await remindContactVerification(ctx);
    expect((await drain()).filter((m) => m.subject.includes('re-verification'))).toHaveLength(0);
  });

  it('notices a publication once and its withdrawal once (PUB-06)', async () => {
    publicationId = await tx(async (trx) => {
      const row = await trx
        .insertInto('cg.publication')
        .values({
          tenant_id: tenantId,
          subject_kind: 'site',
          subject_id: siteId,
          subject_version: 1,
          snapshot: JSON.stringify({ name: `Reminder test shelter ${tag}` }),
          approved_by: adminId,
          reason: 'reminder test publish',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    await noticePublications(ctx);
    const published = (await drain()).filter((m) =>
      m.subject.includes(`Reminder test shelter ${tag}`),
    );
    const rows = await reminders('publication', publicationId);
    expect(rows).toHaveLength(1);
    expect(published).toHaveLength(rows[0]!.recipient_count);
    expect(published[0]!.subject).toContain('published');
    expect(published[0]!.text).toContain('reminder test publish');
    expect(published[0]!.text).toContain('admin@example.org');

    await tx((trx) =>
      trx
        .updateTable('cg.publication')
        .set({ unpublished_at: new Date(), unpublished_by: adminId })
        .where('id', '=', publicationId)
        .execute(),
    );
    await noticePublications(ctx);
    const withdrawn = (await drain()).filter((m) =>
      m.subject.includes(`Reminder test shelter ${tag}`),
    );
    expect(await reminders('publication_withdrawn', publicationId)).toHaveLength(1);
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn[0]!.subject).toContain('withdrawn');
    await noticePublications(ctx);
    expect((await drain()).filter((m) => m.subject.includes(tag))).toHaveLength(0);
  });

  it("partner posting (2026-10-15; PUB-06): a partner's own post names its organization and approver", async () => {
    // The partner's approver has no account in the county; the publication records who they are.
    const partnerAccount = randomUUID();
    const id = await tx(async (trx) => {
      const row = await trx
        .insertInto('cg.publication')
        .values({
          tenant_id: tenantId,
          subject_kind: 'site',
          subject_id: siteId,
          subject_version: 2,
          snapshot: JSON.stringify({
            name: `Partner canteen ${tag}`,
            postedBy: {
              tenantId: randomUUID(),
              organization: 'Exercise Relief Corps',
              approver: 'Captain Exercise',
            },
          }),
          approved_by: partnerAccount,
          reason: 'partner posting test',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    await noticePublications(ctx);
    const published = (await drain()).filter((m) => m.subject.includes(`Partner canteen ${tag}`));
    expect(published.length).toBeGreaterThan(0);
    expect(published[0]!.text).toContain('Captain Exercise of Exercise Relief Corps');
    await tx((trx) =>
      trx
        .updateTable('cg.publication')
        .set({ unpublished_at: new Date(), unpublished_by: partnerAccount })
        .where('id', '=', id)
        .execute(),
    );
    await noticePublications(ctx);
    const withdrawn = (await drain()).filter((m) => m.subject.includes(`Partner canteen ${tag}`));
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn[0]!.text).toContain('someone at Exercise Relief Corps');
  });
});
