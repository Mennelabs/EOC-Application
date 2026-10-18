/**
 * Appointment reminders (FL:FR-18; docs/plans/case-management.md §3.4). The
 * day before a scheduled appointment the survivor gets one reminder through
 * the message pipeline: a text when they opted in, else an email, else nothing
 * and the appointment says so. The reminder carries the time and place and
 * never the purpose (plan §5.5). During the county's quiet hours
 * (`reminders.quiet_hours`, BRD:FR-09.06) the reminder waits for the period
 * to end. An appointment made less than a day ahead gets no second text: the
 * notice at scheduling is enough. Each appointment is reminded once.
 */
import { formatAppointmentWhen } from '@cg/adapters';
import { allTenantIds, asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import { inQuietHours, quietHoursOf } from './quiet-hours.ts';
import type { JobContext } from './types.ts';

const HOUR = 3_600_000;
const nowOf = (ctx: JobContext): Date => (ctx.now ?? (() => new Date()))();

export interface AppointmentReminderRun {
  queued: number;
  skipped: number;
  held: number;
}

export async function remindAppointments(ctx: JobContext): Promise<AppointmentReminderRun> {
  const now = nowOf(ctx);
  const run: AppointmentReminderRun = { queued: 0, skipped: 0, held: 0 };
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const due = await trx
        .selectFrom('cg.appointment')
        .innerJoin('cg.case', 'cg.case.id', 'cg.appointment.case_id')
        .innerJoin('cg.report', 'cg.report.id', 'cg.case.report_id')
        .leftJoin('cg.party', 'cg.party.id', 'cg.report.reporter_party_id')
        .select([
          'cg.appointment.id as id',
          'cg.appointment.starts_at as starts_at',
          'cg.appointment.created_at as created_at',
          'cg.appointment.place as place',
          'cg.appointment.with_label as with_label',
          'cg.report.id as report_id',
          'cg.report.execution_id as execution_id',
          'cg.party.id as party_id',
          'cg.party.contact_enc as contact_enc',
          'cg.party.sms_opt_in as sms_opt_in',
          'cg.party.language as language',
        ])
        .where('cg.appointment.tenant_id', '=', tenantId)
        .where('cg.appointment.status', '=', 'scheduled')
        .where('cg.appointment.reminder_queued_at', 'is', null)
        .where('cg.appointment.starts_at', '>', now)
        .where('cg.appointment.starts_at', '<=', new Date(now.getTime() + 24 * HOUR))
        .orderBy('cg.appointment.starts_at')
        .limit(200)
        .execute();
      if (!due.length) return;
      const tenant = await trx
        .selectFrom('cg.tenant')
        .select(['timezone'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow();
      const quiet = quietHoursOf(
        (
          await trx
            .selectFrom('cg.tenant_config')
            .select('value')
            .where('tenant_id', '=', tenantId)
            .where('key', '=', 'reminders.quiet_hours')
            .executeTakeFirst()
        )?.value,
      );
      if (inQuietHours(now, tenant.timezone, quiet)) {
        run.held += due.length;
        return;
      }
      for (const a of due) {
        // Made less than a day ahead: the notice at scheduling already said when and where.
        const madeAhead =
          new Date(a.starts_at).getTime() - new Date(a.created_at).getTime() > 24 * HOUR;
        const contact = a.contact_enc
          ? (JSON.parse(await ctx.crypto.decrypt(tenantId, a.contact_enc)) as {
              phone?: string;
              email?: string;
            })
          : {};
        let channel: 'sms' | 'email' | null = null;
        let to: string | null = null;
        if (madeAhead && contact.phone && a.sms_opt_in) {
          channel = 'sms';
          to = contact.phone;
        } else if (madeAhead && contact.email) {
          channel = 'email';
          to = contact.email;
        }
        await trx
          .updateTable('cg.appointment')
          .set({ reminder_queued_at: now, updated_at: now })
          .where('id', '=', a.id)
          .where('reminder_queued_at', 'is', null)
          .execute();
        if (!channel || !to) {
          run.skipped += 1;
          await systemAudit(trx, tenantId, 'appointment.remind', {
            action: 'appointment.reminder_skipped',
            targetType: 'appointment',
            targetId: a.id,
            reason: madeAhead ? 'no opted-in channel on file' : 'made less than a day ahead',
          });
          continue;
        }
        const language = a.language ?? 'en';
        await enqueueOutbox(
          trx,
          tenantId,
          'message.send',
          {
            template: 'appointment_reminder',
            channel,
            toEnc: (await ctx.crypto.encrypt(tenantId, to)).toString('base64'),
            language,
            reportId: a.report_id,
            ...(a.party_id ? { partyId: a.party_id } : {}),
            appointmentId: a.id,
            appointmentNotice: 'reminder',
            variables: {
              when: formatAppointmentWhen(new Date(a.starts_at), tenant.timezone, language),
              place: a.place,
              withOrg: a.with_label,
            },
          },
          a.execution_id,
        );
        run.queued += 1;
        await systemAudit(trx, tenantId, 'appointment.remind', {
          action: 'appointment.reminder_queued',
          targetType: 'appointment',
          targetId: a.id,
          changes: { fields: [{ name: 'channel', to: channel }] },
        });
      }
    });
  }
  return run;
}
