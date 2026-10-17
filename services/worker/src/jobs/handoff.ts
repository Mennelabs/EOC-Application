/**
 * The day-30 hand-off to the long-term recovery group (FL:FR-27;
 * docs/plans/case-management.md §3.6). A case open for `case.handoff_days`
 * (default 30, counted from the opening; plan §6 question 3) is handed to the
 * county's long-term recovery partner: the organization whose signed agreement
 * names the `long_term_recovery` type and the `case_management` service. Only
 * with the survivor's consent for that type (plan §5.2): then the grant is
 * cut or refreshed, a referral carries the case, the case is marked handed
 * off and the partner leads it, reading every dollar of help already given.
 * Without consent nothing moves: the case stays with the county and the
 * caseworker who opened it gets a reminder saying why, once.
 */
import { isSharingService } from '@cg/authz';
import { allTenantIds, asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import { syncShareGrants } from './sharing.ts';
import type { JobContext } from './types.ts';

const DAY = 86_400_000;
export const HANDOFF_DAYS_KEY = 'case.handoff_days';
const nowOf = (ctx: JobContext): Date => (ctx.now ?? (() => new Date()))();

export interface HandoffRun {
  handedOff: number;
  /** Cases due with no consent for the long-term recovery group; the caseworker was told. */
  waitingOnConsent: number;
  /** Counties with due cases and no long-term recovery partner under agreement. */
  noPartner: number;
}

export async function handOffCases(ctx: JobContext): Promise<HandoffRun> {
  const now = nowOf(ctx);
  const run: HandoffRun = { handedOff: 0, waitingOnConsent: 0, noPartner: 0 };
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const setting = await trx
        .selectFrom('cg.tenant_config')
        .select('value')
        .where('tenant_id', '=', tenantId)
        .where('key', '=', HANDOFF_DAYS_KEY)
        .executeTakeFirst();
      const days =
        typeof setting?.value === 'number' && Number.isInteger(setting.value) && setting.value > 0
          ? setting.value
          : 30;
      const due = await trx
        .selectFrom('cg.case')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'open')
        .where('opened_at', '<=', new Date(now.getTime() - days * DAY))
        .orderBy('opened_at')
        .limit(200)
        .execute();
      if (!due.length) return;
      // The long-term recovery partner: a signed agreement naming the type and the service.
      const agreements = await trx
        .selectFrom('cg.data_sharing_agreement')
        .select(['id', 'to_tenant_id', 'terms'])
        .where('from_tenant_id', '=', tenantId)
        .where('status', '=', 'signed')
        .execute();
      const partner = agreements.find((a) => {
        const t = (a.terms ?? {}) as { orgType?: unknown; service?: unknown };
        return (
          t.orgType === 'long_term_recovery' &&
          isSharingService(t.service) &&
          t.service === 'case_management'
        );
      });
      if (!partner) {
        run.noPartner += 1;
        return;
      }
      for (const c of due) {
        const consent = await trx
          .selectFrom('cg.consent')
          .select('id')
          .where('report_id', '=', c.report_id)
          .where('org_type', '=', 'long_term_recovery')
          .where('granted', '=', true)
          .executeTakeFirst();
        if (!consent) {
          run.waitingOnConsent += 1;
          await tellCaseworker(trx, tenantId, c, days, now);
          continue;
        }
        // The grant the partner reads the case through; refreshed in case it lapsed.
        await syncShareGrants(ctx, trx, tenantId, { reportId: c.report_id }, 'handoff');
        const grant = await trx
          .selectFrom('cg.share_grant')
          .select('id')
          .where('report_id', '=', c.report_id)
          .where('to_tenant_id', '=', partner.to_tenant_id)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!grant) {
          // Consent stands but the agreement's categories leave nothing to share: the caseworker hears.
          run.waitingOnConsent += 1;
          await tellCaseworker(trx, tenantId, c, days, now);
          continue;
        }
        const actor = c.opened_by ?? c.updated_by ?? c.created_by;
        let referralId: string | null = null;
        if (actor) {
          referralId = (
            await trx
              .insertInto('cg.referral')
              .values({
                tenant_id: tenantId,
                from_tenant_id: tenantId,
                to_tenant_id: partner.to_tenant_id,
                report_id: c.report_id,
                need_id: null,
                party_id: c.party_id,
                share_grant_id: grant.id,
                purpose: `Day-${days} hand-off of the case to the long-term recovery group: the recovery plan, help received and appointments are on the case.`,
                opened_by: actor,
                attempts: JSON.stringify([
                  { at: now.toISOString(), by: 'system', kind: 'opened', why: 'day-30 hand-off' },
                ]),
                created_by: actor,
                updated_by: actor,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
          await enqueueOutbox(trx, tenantId, 'referral.created', { referralId }, null);
        }
        await trx
          .updateTable('cg.case')
          .set({
            status: 'handed_off',
            handed_off_at: now,
            handed_off_to_tenant_id: partner.to_tenant_id,
            handoff_referral_id: referralId,
            lead_tenant_id: partner.to_tenant_id,
            version: c.version + 1,
            updated_at: now,
          })
          .where('id', '=', c.id)
          .where('version', '=', c.version)
          .execute();
        run.handedOff += 1;
        await systemAudit(trx, tenantId, 'case.handoff', {
          action: 'case.handed_off',
          targetType: 'case',
          targetId: c.id,
          reason: `open ${days} days; the survivor consented to the long-term recovery group`,
          changes: {
            fields: [
              { name: 'status', from: 'open', to: 'handed_off' },
              { name: 'lead_tenant_id', from: c.lead_tenant_id, to: partner.to_tenant_id },
              { name: 'referral_id', to: referralId ?? '' },
            ],
          },
        });
      }
    });
  }
  return run;
}

/** One reminder to the caseworker who opened the case; a second run finds it and adds none. */
async function tellCaseworker(
  trx: Parameters<typeof syncShareGrants>[1],
  tenantId: string,
  c: { id: string; opened_by: string | null; event_id: string | null },
  days: number,
  now: Date,
) {
  const existing = await trx
    .selectFrom('cg.reminder')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('subject_kind', '=', 'case')
    .where('subject_id', '=', c.id)
    .where('kind', '=', 'follow_up')
    .where('state', 'in', ['active', 'overdue', 'acknowledged'])
    .executeTakeFirst();
  if (existing) return;
  await trx
    .insertInto('cg.reminder')
    .values({
      tenant_id: tenantId,
      event_id: c.event_id,
      kind: 'follow_up',
      title: `Day-${days} hand-off waits on the survivor's consent for the long-term recovery group`,
      note: 'The case stays with the county until the survivor says yes to the long-term recovery group on their shared record, or it is closed.',
      owner_account_id: c.opened_by,
      owner_team_id: null,
      mission_id: null,
      subject_kind: 'case',
      subject_id: c.id,
      due_at: now,
      recurrence: null,
      recurrence_approved_by: null,
      created_by: c.opened_by,
      updated_by: c.opened_by,
    })
    .execute();
  await systemAudit(trx, tenantId, 'case.handoff', {
    action: 'case.handoff_waiting',
    targetType: 'case',
    targetId: c.id,
    reason: 'no consent for the long-term recovery group',
  });
}
