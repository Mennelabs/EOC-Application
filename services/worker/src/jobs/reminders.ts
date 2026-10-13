/**
 * Reminders and notices on the worker's own clock (F09, REM-01):
 * - a site lead hears before a site's confirmation window lapses, and again
 *   when it has lapsed and the site left every public channel (PUB-03);
 * - a resource's owner hears when its review date arrives, when its outside
 *   link stops answering, and when it expired and left the public page
 *   (BRD:FR-16.03, AC-16B); the expiry is recorded in the publication log;
 * - the contact owners get one digest a week of interagency contacts due
 *   for re-verification (F17, CNT-01);
 * - the people who carry publications onward (the PIO and the publishers)
 *   hear once per publication and once per withdrawal (PUB-06).
 * One cg.notice_log row per subject and cycle keeps every reminder to one
 * sending whatever the schedule's pace or restarts (BRD:FR-00.06). Reminders
 * go out as messages, so delivery states and evidence are kept (FR-17.05).
 * The full F09 model (owner, snooze, acknowledge, escalation) arrives with
 * missions in layer 4.
 */
import type { Database, NoticeKind } from '@cg/db';
import type { Transaction } from 'kysely';
import { allTenantIds, asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import { accountEmails, staffRecipients } from './recipients.ts';
import type { TemplateName } from './templates.ts';
import type { JobContext } from './types.ts';

type Trx = Transaction<Database>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Contacts due within this many days are in the weekly digest (CNT-01). */
const CONTACT_HORIZON_DAYS = 14;

const nowOf = (ctx: JobContext): Date => (ctx.now ?? (() => new Date()))();
const stamp = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const dateOnly = (d: Date | string): string =>
  (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

interface ReminderSpec {
  kind: NoticeKind;
  subjectKind: 'site' | 'resource' | 'partner_contact' | 'publication' | 'tenant';
  subjectId: string;
  cycleKey: string;
  dueAt: Date;
  ownerAccountId?: string | null;
}

/** Inserts the reminder for this subject and cycle; null when it exists already (sent or pending). */
async function claimReminder(trx: Trx, tenantId: string, r: ReminderSpec): Promise<string | null> {
  const row = await trx
    .insertInto('cg.notice_log')
    .values({
      tenant_id: tenantId,
      kind: r.kind,
      subject_kind: r.subjectKind,
      subject_id: r.subjectId,
      cycle_key: r.cycleKey,
      due_at: r.dueAt,
      owner_account_id: r.ownerAccountId ?? null,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'kind', 'subject_id', 'cycle_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Queues one email per distinct recipient and marks the reminder sent. */
async function sendReminder(
  ctx: JobContext,
  trx: Trx,
  tenantId: string,
  reminderId: string,
  emails: readonly string[],
  template: TemplateName,
  variables: Record<string, string>,
): Promise<number> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  for (const email of unique) {
    await enqueueOutbox(trx, tenantId, 'message.send', {
      template,
      channel: 'email',
      toEnc: (await ctx.crypto.encrypt(tenantId, email)).toString('base64'),
      language: 'en',
      variables,
    });
  }
  await trx
    .updateTable('cg.notice_log')
    .set({ state: 'sent', sent_at: nowOf(ctx), recipient_count: unique.length })
    .where('id', '=', reminderId)
    .execute();
  return unique.length;
}

/** The lead contact's email, read from the restricted registry and audited (SEC-18). */
async function leadContactEmail(
  ctx: JobContext,
  trx: Trx,
  tenantId: string,
  contactId: string | null,
  siteId: string,
): Promise<string[]> {
  if (!contactId) return [];
  const row = await trx
    .selectFrom('cg.partner_contact')
    .select(['id', 'methods_enc', 'active'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', contactId)
    .executeTakeFirst();
  if (!row || !row.active) return [];
  const methods = JSON.parse(await ctx.crypto.decrypt(tenantId, row.methods_enc)) as {
    email?: string;
  };
  await systemAudit(trx, tenantId, 'site.reconfirm', {
    action: 'contact.read',
    targetType: 'partner_contact',
    targetId: row.id,
    classificationRead: ['contact'],
    reason: `site reminder for ${siteId}`,
  });
  return methods.email ? [methods.email] : [];
}

/**
 * PUB-03: a published site must be reconfirmed every `confirm_every_hours`.
 * The lead and the people who can confirm hear once when a quarter of the
 * window (at least an hour) is left, and once more when it lapsed and the
 * public channels stopped showing the site.
 */
export async function remindSiteConfirmations(ctx: JobContext): Promise<void> {
  const now = nowOf(ctx);
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const sites = await trx
        .selectFrom('cg.site')
        .select([
          'id',
          'name',
          'confirm_every_hours',
          'last_confirmed_at',
          'published_at',
          'lead_contact_id',
        ])
        .where('tenant_id', '=', tenantId)
        .where('published_at', 'is not', null)
        .where('unpublished_at', 'is', null)
        .where('confidential', '=', false)
        .where('status', '<>', 'planned')
        .execute();
      for (const s of sites) {
        const base = s.last_confirmed_at ?? s.published_at;
        if (!base) continue;
        const baseMs = new Date(base).getTime();
        const windowMs = s.confirm_every_hours * HOUR;
        const dueMs = baseMs + windowMs;
        const noticeMs = Math.max(Math.min(HOUR, windowMs / 2), windowMs / 4);
        const kind: NoticeKind | null =
          now.getTime() >= dueMs
            ? 'site_hidden'
            : now.getTime() >= dueMs - noticeMs
              ? 'site_reconfirm'
              : null;
        if (!kind) continue;
        const id = await claimReminder(trx, tenantId, {
          kind,
          subjectKind: 'site',
          subjectId: s.id,
          cycleKey: new Date(baseMs).toISOString(),
          dueAt: new Date(dueMs),
        });
        if (!id) continue;
        const emails = [
          ...(await leadContactEmail(ctx, trx, tenantId, s.lead_contact_id, s.id)),
          ...(await staffRecipients(trx, tenantId, ['site.confirm'])).emails,
        ];
        const sent = await sendReminder(ctx, trx, tenantId, id, emails, kind, {
          site: s.name,
          dueAt: stamp(new Date(dueMs)),
        });
        await systemAudit(trx, tenantId, 'site.reconfirm', {
          action: kind === 'site_hidden' ? 'site.hidden_unconfirmed' : 'site.reconfirm_reminded',
          targetType: 'site',
          targetId: s.id,
          reason: `${sent} recipient(s); confirmation due ${new Date(dueMs).toISOString()}`,
        });
      }
    });
  }
}

async function defaultLinkCheck(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5_000),
    });
    if (head.ok) return true;
    if (head.status !== 405 && head.status !== 403) return false;
    const get = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    return get.ok;
  } catch {
    return false;
  }
}

async function resourceTitle(trx: Trx, tenantId: string, resourceId: string): Promise<string> {
  const texts = await trx
    .selectFrom('cg.resource_text')
    .select(['locale', 'title'])
    .where('tenant_id', '=', tenantId)
    .where('resource_id', '=', resourceId)
    .execute();
  return (texts.find((t) => t.locale === 'en') ?? texts[0])?.title ?? resourceId;
}

async function resourceRecipients(trx: Trx, tenantId: string, ownerAccountId: string | null) {
  return [
    ...(await accountEmails(trx, tenantId, [ownerAccountId])),
    ...(await staffRecipients(trx, tenantId, ['resource.edit', 'resource.publish'])).emails,
  ];
}

/**
 * BRD:FR-16.03, AC-16B: expired resources leave the public page and the log
 * says so; review dates and broken outside links reach the owner once per
 * date (links are checked once a day).
 */
export async function reviewResources(ctx: JobContext): Promise<void> {
  const now = nowOf(ctx);
  const today = now.toISOString().slice(0, 10);
  const check = ctx.linkCheck ?? defaultLinkCheck;
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      // 1. Expiry: the status follows the date so nothing expired reads as current.
      const expired = await trx
        .updateTable('cg.resource')
        .set({ status: 'expired' })
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .where('expires_at', 'is not', null)
        .where('expires_at', '<=', now)
        .returning(['id', 'owner_account_id', 'expires_at'])
        .execute();
      for (const r of expired) {
        await trx
          .updateTable('cg.publication')
          .set({ unpublished_at: now })
          .where('tenant_id', '=', tenantId)
          .where('subject_kind', '=', 'resource')
          .where('subject_id', '=', r.id)
          .where('unpublished_at', 'is', null)
          .execute();
        await systemAudit(trx, tenantId, 'resource.review', {
          action: 'resource.expired',
          targetType: 'resource',
          targetId: r.id,
          changes: { fields: [{ name: 'status', from: 'published', to: 'expired' }] },
        });
        const when = r.expires_at ? new Date(r.expires_at) : now;
        const id = await claimReminder(trx, tenantId, {
          kind: 'resource_expired',
          subjectKind: 'resource',
          subjectId: r.id,
          cycleKey: when.toISOString(),
          dueAt: when,
          ownerAccountId: r.owner_account_id,
        });
        if (!id) continue;
        await sendReminder(
          ctx,
          trx,
          tenantId,
          id,
          await resourceRecipients(trx, tenantId, r.owner_account_id),
          'resource_attention',
          {
            title: await resourceTitle(trx, tenantId, r.id),
            what: `expired on ${dateOnly(when)} and left the public page; extend its date or remove it`,
          },
        );
      }

      // 2. Review dates.
      const due = await trx
        .selectFrom('cg.resource')
        .select(['id', 'owner_account_id', 'review_at'])
        .where('tenant_id', '=', tenantId)
        .where('status', 'in', ['draft', 'published'])
        .where('review_at', 'is not', null)
        .where('review_at', '<=', today)
        .execute();
      for (const r of due) {
        const reviewDate = dateOnly(r.review_at!);
        const id = await claimReminder(trx, tenantId, {
          kind: 'resource_review',
          subjectKind: 'resource',
          subjectId: r.id,
          cycleKey: reviewDate,
          dueAt: new Date(`${reviewDate}T00:00:00Z`),
          ownerAccountId: r.owner_account_id,
        });
        if (!id) continue;
        await sendReminder(
          ctx,
          trx,
          tenantId,
          id,
          await resourceRecipients(trx, tenantId, r.owner_account_id),
          'resource_attention',
          {
            title: await resourceTitle(trx, tenantId, r.id),
            what: `is due for review (review date ${reviewDate}); check it is still right and set the next date`,
          },
        );
      }

      // 3. Outside links, once a day, on what the public can see.
      const toCheck = await trx
        .selectFrom('cg.resource')
        .select(['id', 'owner_account_id', 'reference_url', 'link_status', 'link_checked_at'])
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .where('reference_url', 'is not', null)
        .where((eb) =>
          eb.or([
            eb('link_checked_at', 'is', null),
            eb('link_checked_at', '<', new Date(now.getTime() - DAY)),
          ]),
        )
        .execute();
      for (const r of toCheck) {
        const url = r.reference_url!;
        const ok = /^https?:\/\//i.test(url) ? await check(url) : true;
        const status = ok ? 'ok' : 'broken';
        await trx
          .updateTable('cg.resource')
          .set({ link_status: status, link_checked_at: now })
          .where('id', '=', r.id)
          .execute();
        if (status !== r.link_status)
          await systemAudit(trx, tenantId, 'resource.review', {
            action: 'resource.link_checked',
            targetType: 'resource',
            targetId: r.id,
            changes: { fields: [{ name: 'link_status', from: r.link_status, to: status }] },
          });
        if (ok) continue;
        const id = await claimReminder(trx, tenantId, {
          kind: 'resource_link',
          subjectKind: 'resource',
          subjectId: r.id,
          cycleKey: today,
          dueAt: now,
          ownerAccountId: r.owner_account_id,
        });
        if (!id) continue;
        await sendReminder(
          ctx,
          trx,
          tenantId,
          id,
          await resourceRecipients(trx, tenantId, r.owner_account_id),
          'resource_attention',
          {
            title: await resourceTitle(trx, tenantId, r.id),
            what: `has an outside link that did not answer (${url}); fix the link or keep the essential text on the page`,
          },
        );
      }
    });
  }
}

/** The Monday of the week, as the cycle key of a weekly digest. */
function weekKey(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - day * DAY).toISOString().slice(0, 10);
}

/**
 * F17, CNT-01: one digest a week to the contact owners and the people who
 * keep the registry, listing contacts due for re-verification within two
 * weeks or past due. Agencies and dates only; names and numbers stay in the
 * restricted registry.
 */
export async function remindContactVerification(ctx: JobContext): Promise<void> {
  const now = nowOf(ctx);
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + CONTACT_HORIZON_DAYS * DAY).toISOString().slice(0, 10);
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const due = await trx
        .selectFrom('cg.partner_contact')
        .select(['id', 'agency', 'role', 'type', 'verify_by', 'owner_account_id'])
        .where('tenant_id', '=', tenantId)
        .where('active', '=', true)
        .where('verify_by', 'is not', null)
        .where('verify_by', '<=', horizon)
        .orderBy('verify_by')
        .execute();
      if (due.length === 0) return;
      const id = await claimReminder(trx, tenantId, {
        kind: 'contact_reverify',
        subjectKind: 'tenant',
        subjectId: tenantId,
        cycleKey: weekKey(now),
        dueAt: now,
      });
      if (!id) return;
      const items = due
        .map((c) => {
          const by = dateOnly(c.verify_by!);
          return `- ${c.agency}${c.role ? ` (${c.role})` : ''}, ${c.type.replace(/_/g, ' ')}: verify by ${by}${by < today ? ' (past due)' : ''}`;
        })
        .join('\n');
      const emails = [
        ...(await accountEmails(
          trx,
          tenantId,
          due.map((c) => c.owner_account_id),
        )),
        ...(await staffRecipients(trx, tenantId, ['contact.edit'])).emails,
      ];
      const sent = await sendReminder(ctx, trx, tenantId, id, emails, 'contact_reverify', {
        items,
        count: String(due.length),
      });
      await systemAudit(trx, tenantId, 'contact.reverify', {
        action: 'contact.reverify_reminded',
        targetType: 'tenant',
        targetId: tenantId,
        reason: `${due.length} contact(s) due by ${horizon}; ${sent} recipient(s)`,
      });
    });
  }
}

async function approverName(trx: Trx, tenantId: string, accountId: string | null) {
  if (!accountId) return 'the system';
  const a = await trx
    .selectFrom('cg.account')
    .select(['display_name', 'email'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', accountId)
    .executeTakeFirst();
  return a ? `${a.display_name} (${a.email})` : 'a named approver';
}

/**
 * PUB-06: every publication and every withdrawal reaches the people who
 * carry it onward (the PIO and the publishers) once, with what, which
 * version, who approved it, why and on which channels.
 */
export async function noticePublications(ctx: JobContext): Promise<void> {
  const now = nowOf(ctx);
  const recent = new Date(now.getTime() - 30 * DAY);
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('cg.publication')
        .select([
          'id',
          'subject_kind',
          'subject_version',
          'snapshot',
          'approved_by',
          'approved_at',
          'channels',
          'reason',
          'unpublished_at',
          'unpublished_by',
        ])
        .where('tenant_id', '=', tenantId)
        .where((eb) => eb.or([eb('approved_at', '>=', recent), eb('unpublished_at', '>=', recent)]))
        .execute();
      if (rows.length === 0) return;
      let recipients: string[] | null = null;
      for (const p of rows) {
        const snap = (p.snapshot ?? {}) as { name?: unknown; title?: unknown; slug?: unknown };
        const title = String(snap.name ?? snap.title ?? snap.slug ?? p.subject_kind);
        const events: { kind: NoticeKind; at: Date; what: string; by: string | null }[] = [
          {
            kind: 'publication',
            at: new Date(p.approved_at),
            what: 'published',
            by: p.approved_by,
          },
        ];
        if (p.unpublished_at)
          events.push({
            kind: 'publication_withdrawn',
            at: new Date(p.unpublished_at),
            what: 'withdrawn',
            by: p.unpublished_by,
          });
        for (const e of events) {
          const id = await claimReminder(trx, tenantId, {
            kind: e.kind,
            subjectKind: 'publication',
            subjectId: p.id,
            cycleKey: e.at.toISOString(),
            dueAt: e.at,
          });
          if (!id) continue;
          recipients ??= (
            await staffRecipients(trx, tenantId, ['site.publish', 'resource.publish'])
          ).emails;
          await sendReminder(ctx, trx, tenantId, id, recipients, 'publication_notice', {
            kind: p.subject_kind.replace(/_/g, ' '),
            title,
            version: String(p.subject_version),
            approver: await approverName(trx, tenantId, e.by),
            why: p.reason,
            channels: p.channels.join(', '),
            what: e.what,
          });
        }
      }
    });
  }
}
