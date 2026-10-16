/**
 * Facility registry re-checks (layer-7 task D; REC-01, SEC-18): a month
 * before an entry's yearly re-check falls due, its own contacts (read from the
 * encrypted contacts, audited) and the people who approve the registry hear
 * once for that cycle. A stale entry is marked as such where it is listed;
 * nothing is removed. Confirming the entry starts the next cycle.
 *
 * The facility's own contacts get a single-use link to look over the entry
 * and send what changed, or say nothing has (REC-01: "facility owners update
 * their own details"). Only the link's SHA-256 is stored; the link itself
 * travels encrypted to the message job. What they send is a proposal for
 * the county's approval queue.
 */
import { createHash, randomBytes } from 'node:crypto';
import { enqueueOutbox } from '../system.ts';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import { claimReminder, sendReminder } from './reminders.ts';
import { staffRecipients } from './recipients.ts';
import type { JobContext } from './types.ts';

const DAY = 86_400_000;
/** REC-01: every 12 months. */
export const RECHECK_DAYS = 365;
/** The notice goes this long before the re-check falls due. */
export const NOTICE_DAYS = 30;
/** An owner's link works this long after the re-check falls due. */
export const LINK_GRACE_DAYS = 30;

const nowOf = (ctx: JobContext): Date => ctx.now?.() ?? new Date();
const day = (d: Date) => d.toISOString().slice(0, 10);

export async function remindFacilityRechecks(ctx: JobContext): Promise<number> {
  const now = nowOf(ctx);
  const noticeFrom = new Date(now.getTime() - (RECHECK_DAYS - NOTICE_DAYS) * DAY);
  let sentTotal = 0;
  for (const tenantId of await allTenantIds(ctx.db)) {
    sentTotal += await asSystem(ctx.db, tenantId, async (trx) => {
      const due = await trx
        .selectFrom('cg.facility')
        .select(['id', 'name', 'last_confirmed_at', 'contacts_enc'])
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'approved')
        .where('last_confirmed_at', '<=', noticeFrom)
        .execute();
      let sent = 0;
      for (const f of due) {
        const dueAt = new Date(f.last_confirmed_at.getTime() + RECHECK_DAYS * DAY);
        const id = await claimReminder(trx, tenantId, {
          kind: 'facility_recheck',
          subjectKind: 'facility',
          subjectId: f.id,
          cycleKey: f.last_confirmed_at.toISOString(),
          dueAt,
        });
        if (!id) continue;
        const own: string[] = [];
        if (f.contacts_enc) {
          const contacts = JSON.parse(await ctx.crypto.decrypt(tenantId, f.contacts_enc)) as {
            email?: string;
          }[];
          for (const c of contacts) if (c.email) own.push(c.email);
          await systemAudit(trx, tenantId, 'facility.recheck', {
            action: 'facility.read_contacts',
            targetType: 'facility',
            targetId: f.id,
            classificationRead: ['contact'],
            reason: 'yearly re-check reminder',
          });
        }
        const staff = await staffRecipients(trx, tenantId, ['facility.approve']);
        // The owners' single-use link (one for this cycle, shared by the facility's contacts).
        const owners = [...new Set(own.map((e) => e.trim().toLowerCase()).filter(Boolean))];
        if (owners.length) {
          const token = randomBytes(32).toString('base64url');
          await trx
            .insertInto('cg.facility_update_link')
            .values({
              tenant_id: tenantId,
              facility_id: f.id,
              token_hash: createHash('sha256').update(token).digest(),
              expires_at: new Date(dueAt.getTime() + LINK_GRACE_DAYS * DAY),
            })
            .execute();
          const slug = (
            await trx
              .selectFrom('cg.tenant')
              .select('slug')
              .where('id', '=', tenantId)
              .executeTakeFirstOrThrow()
          ).slug;
          const url = `${ctx.urls.gatewayPublic}/${slug}/help?view=offer&update=${token}`;
          const secretVariablesEnc = (
            await ctx.crypto.encrypt(tenantId, JSON.stringify({ url }))
          ).toString('base64');
          for (const email of owners)
            await enqueueOutbox(trx, tenantId, 'message.send', {
              template: 'facility_recheck_owner',
              channel: 'email',
              toEnc: (await ctx.crypto.encrypt(tenantId, email)).toString('base64'),
              language: 'en',
              variables: { county: staff.tenantName, site: f.name, dueAt: day(dueAt) },
              secretVariablesEnc,
            });
        }
        const n =
          owners.length +
          (await sendReminder(
            ctx,
            trx,
            tenantId,
            id,
            staff.emails.filter((e) => !owners.includes(e.trim().toLowerCase())),
            'facility_recheck',
            { county: staff.tenantName, site: f.name, dueAt: day(dueAt) },
          ));
        if (owners.length)
          await trx
            .updateTable('cg.notice_log')
            .set({ recipient_count: n })
            .where('id', '=', id)
            .execute();
        await systemAudit(trx, tenantId, 'facility.recheck', {
          action: 'facility.recheck_reminded',
          targetType: 'facility',
          targetId: f.id,
          reason: `${n} recipient(s); re-check due ${day(dueAt)}`,
        });
        sent += n;
      }
      return sent;
    });
  }
  return sentTotal;
}
