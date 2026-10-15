/**
 * Facility registry re-checks (layer-7 task D; REC-01, SEC-18): a month
 * before an entry's yearly re-check falls due, its own contacts (read from the
 * encrypted contacts, audited) and the people who approve the registry hear
 * once for that cycle. A stale entry is marked as such where it is listed;
 * nothing is removed. Confirming the entry starts the next cycle.
 */
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import { claimReminder, sendReminder } from './reminders.ts';
import { staffRecipients } from './recipients.ts';
import type { JobContext } from './types.ts';

const DAY = 86_400_000;
/** REC-01: every 12 months. */
export const RECHECK_DAYS = 365;
/** The notice goes this long before the re-check falls due. */
export const NOTICE_DAYS = 30;

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
        const n = await sendReminder(
          ctx,
          trx,
          tenantId,
          id,
          [...own, ...staff.emails],
          'facility_recheck',
          { county: staff.tenantName, site: f.name, dueAt: day(dueAt) },
        );
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
