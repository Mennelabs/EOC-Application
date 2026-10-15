/**
 * Field safety on the worker's clock (layer-4 plan §6, task D; DSP-04,
 * DSP-07, DSP-08, FLD-16, SEC-13):
 * - a team that has not answered its check-in timer turns `overdue` (a
 *   confirmed status fact from the timer, apart from what the team set),
 *   raises one open `missed_check_in` alert and, after the tenant's delay,
 *   escalates it to the safety officers by email;
 * - an assignment dispatched and not acknowledged within the tenant's window
 *   raises one `unacknowledged_assignment` alert;
 * - help alerts raised by the app are escalated the same way when nobody
 *   acknowledges them within the delay;
 * - live position trails older than the position-trail retention are dropped
 *   a day at a time, logged per tenant (DSP-08, SEC-13).
 * Every alert writes an ICS 214 entry for the team (DSP-11).
 */
import type { Database } from '@cg/db';
import { sql, type Transaction } from 'kysely';
import { allTenantIds, asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import { staffRecipients } from './recipients.ts';
import type { JobContext } from './types.ts';

type Trx = Transaction<Database>;
const MINUTE = 60_000;

const nowOf = (ctx: JobContext): Date => (ctx.now ?? (() => new Date()))();

async function configNumber(trx: Trx, key: string, fallback: number): Promise<number> {
  const row = await trx
    .selectFrom('cg.tenant_config')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function activity(
  trx: Trx,
  tenantId: string,
  eventId: string,
  teamId: string | null,
  personnelId: string | null,
  kind: Database['cg.activity_entry']['kind'],
  summary: string,
  refKind: string,
  refId: string,
): Promise<void> {
  await trx
    .insertInto('cg.activity_entry')
    .values({
      tenant_id: tenantId,
      event_id: eventId,
      team_id: teamId,
      personnel_id: personnelId,
      kind,
      summary,
      ref_kind: refKind,
      ref_id: refId,
    })
    .execute();
}

/** Emails the safety officers (and whoever else may acknowledge alerts) about an alert. */
async function notifySafety(
  ctx: JobContext,
  trx: Trx,
  tenantId: string,
  alert: { id: string; kind: string; teamName: string | null; raisedAt: Date; note: string | null },
): Promise<number> {
  const recipients = await staffRecipients(trx, tenantId, ['safety_alert.acknowledge'], {
    includeAdmins: true,
  });
  for (const email of recipients.emails) {
    await enqueueOutbox(trx, tenantId, 'message.send', {
      template: 'help_alert',
      channel: 'email',
      toEnc: (await ctx.crypto.encrypt(tenantId, email)).toString('base64'),
      language: 'en',
      variables: {
        kind: alert.kind.replace(/_/g, ' '),
        site: alert.teamName ?? 'a person in the field',
        dueAt: alert.raisedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        what: alert.note ?? '',
        url: `${ctx.urls.gatewayPublic}/console/dispatch`,
      },
      alertId: alert.id,
    });
  }
  return recipients.emails.length;
}

/**
 * Every minute: check-in timers (DSP-07), acknowledgement windows (DSP-04)
 * and escalation of alerts nobody acknowledged.
 */
export async function watchFieldSafety(ctx: JobContext): Promise<void> {
  const now = nowOf(ctx);
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const escalateAfter = await configNumber(trx, 'field.escalation_minutes', 15);
      const ackWindow = await configNumber(trx, 'dispatch.ack_minutes', 10);

      // Teams with someone checked in: the last confirmed status (any kind, from anyone) is the
      // last time we heard from them; the timer is the team's interval.
      const teams = await trx
        .selectFrom('cg.team as t')
        .innerJoin('cg.check_in as c', 'c.team_id', 't.id')
        .select(['t.id', 't.name', 't.check_in_interval_minutes', 'c.event_id'])
        .distinctOn('t.id')
        .where('t.tenant_id', '=', tenantId)
        .where('t.status', '=', 'active')
        .where('c.ended_at', 'is', null)
        .orderBy('t.id')
        .execute();
      for (const team of teams) {
        const last = await trx
          .selectFrom('cg.team_status')
          .select(['status', 'created_at', 'source'])
          .where('team_id', '=', team.id)
          .where('fact', '=', 'confirmed')
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        const firstCheckIn = await trx
          .selectFrom('cg.check_in')
          .select('started_at')
          .where('team_id', '=', team.id)
          .where('ended_at', 'is', null)
          .orderBy('started_at')
          .executeTakeFirst();
        const heardAt = new Date(last?.created_at ?? firstCheckIn?.started_at ?? now);
        if (last?.status === 'out_of_service' || last?.status === 'overdue') continue;
        if (now.getTime() - heardAt.getTime() < team.check_in_interval_minutes * MINUTE) continue;
        await trx
          .insertInto('cg.team_status')
          .values({
            tenant_id: tenantId,
            team_id: team.id,
            status: 'overdue',
            fact: 'confirmed',
            source: 'timer',
            note: `No check-in for ${team.check_in_interval_minutes} minutes`,
          })
          .execute();
        const open = await trx
          .selectFrom('cg.safety_alert')
          .select('id')
          .where('team_id', '=', team.id)
          .where('kind', '=', 'missed_check_in')
          .where('state', 'in', ['open', 'acknowledged', 'escalated'])
          .executeTakeFirst();
        if (open) continue;
        const alert = await trx
          .insertInto('cg.safety_alert')
          .values({
            tenant_id: tenantId,
            event_id: team.event_id,
            kind: 'missed_check_in',
            team_id: team.id,
            note: `${team.name} missed its ${team.check_in_interval_minutes}-minute check-in`,
            raised_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await activity(
          trx,
          tenantId,
          team.event_id,
          team.id,
          null,
          'alert',
          `Overdue: no check-in for ${team.check_in_interval_minutes} minutes`,
          'safety_alert',
          alert.id,
        );
        await systemAudit(trx, tenantId, 'field.timer', {
          action: 'safety_alert.raise',
          targetType: 'safety_alert',
          targetId: alert.id,
          changes: {
            fields: [
              { name: 'kind', to: 'missed_check_in' },
              { name: 'team', to: team.id },
            ],
          },
        });
      }

      // Dispatched, not acknowledged within the window (DSP-04): one alert per assignment.
      const stale = await trx
        .selectFrom('cg.assignment as a')
        .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
        .leftJoin('cg.team as t', 't.id', 'a.team_id')
        .select([
          'a.id',
          'a.team_id',
          'a.personnel_id',
          'm.event_id',
          'm.reference',
          't.name as team_name',
        ])
        .where('a.tenant_id', '=', tenantId)
        .where('a.state', '=', 'dispatched')
        .where('a.acknowledged_at', 'is', null)
        .where('a.dispatched_at', '<', new Date(now.getTime() - ackWindow * MINUTE))
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('cg.safety_alert as s')
                .select('s.id')
                .whereRef('s.assignment_id', '=', 'a.id')
                .where('s.kind', '=', 'unacknowledged_assignment'),
            ),
          ),
        )
        .execute();
      for (const a of stale) {
        const alert = await trx
          .insertInto('cg.safety_alert')
          .values({
            tenant_id: tenantId,
            event_id: a.event_id,
            kind: 'unacknowledged_assignment',
            team_id: a.team_id,
            personnel_id: a.personnel_id,
            assignment_id: a.id,
            note: `${a.reference}: dispatched ${ackWindow} minutes ago, not acknowledged`,
            raised_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await activity(
          trx,
          tenantId,
          a.event_id,
          a.team_id,
          a.personnel_id,
          'alert',
          `${a.reference}: not acknowledged after ${ackWindow} minutes`,
          'safety_alert',
          alert.id,
        );
      }

      // Escalation: open alerts older than the delay go to the safety officers, once.
      const toEscalate = await trx
        .selectFrom('cg.safety_alert as s')
        .leftJoin('cg.team as t', 't.id', 's.team_id')
        .select([
          's.id',
          's.kind',
          's.raised_at',
          's.note',
          's.event_id',
          's.team_id',
          't.name as team_name',
        ])
        .where('s.tenant_id', '=', tenantId)
        .where('s.state', '=', 'open')
        .where('s.raised_at', '<', new Date(now.getTime() - escalateAfter * MINUTE))
        .execute();
      for (const s of toEscalate) {
        // Only while still open: someone may have acknowledged it since the list
        // was read (the update then waits for them and finds it no longer open).
        const escalated = await trx
          .updateTable('cg.safety_alert')
          .set({ state: 'escalated', escalated_at: now, escalated_to_role: 'safety_officer' })
          .where('id', '=', s.id)
          .where('state', '=', 'open')
          .returning('id')
          .executeTakeFirst();
        if (!escalated) continue;
        const sent = await notifySafety(ctx, trx, tenantId, {
          id: s.id,
          kind: s.kind,
          teamName: s.team_name,
          raisedAt: new Date(s.raised_at),
          note: s.note,
        });
        await activity(
          trx,
          tenantId,
          s.event_id,
          s.team_id,
          null,
          'alert',
          `Escalated to the safety officer after ${escalateAfter} minutes (${sent} notified)`,
          'safety_alert',
          s.id,
        );
        await systemAudit(trx, tenantId, 'field.timer', {
          action: 'safety_alert.escalate',
          targetType: 'safety_alert',
          targetId: s.id,
          changes: {
            fields: [
              { name: 'state', from: 'open', to: 'escalated' },
              { name: 'recipients', to: sent },
            ],
          },
        });
      }
    });
  }
}

/**
 * Daily: live position trails are dropped a day at a time once older than the
 * longest position-trail retention any tenant keeps (partitions are shared), and
 * each tenant's deletion is logged with its own count (SEC-13, DSP-08).
 */
export async function dropPositionTrails(ctx: JobContext): Promise<void> {
  const keep = await sql<{ days: string | null }>`
    select max(extract(epoch from keep_for) / 86400)::text as days
    from cg.retention_policy where data_category = 'position_trail' and keep_for is not null`.execute(
    ctx.db,
  );
  const days = Math.max(1, Math.ceil(Number(keep.rows[0]?.days ?? 30)));
  const cutoff = new Date(nowOf(ctx).getTime() - days * 86_400_000);
  // Count per tenant before the drop so the deletion log can say what left.
  const counts = await ctx.db
    .selectFrom('cg.position')
    .select([
      'tenant_id',
      (eb) => eb.fn.countAll<string>().as('n'),
      (eb) => eb.fn.min('recorded_at').as('oldest'),
      (eb) => eb.fn.max('recorded_at').as('newest'),
    ])
    .where('recorded_at', '<', cutoff)
    .groupBy('tenant_id')
    .execute();
  const dropped = await sql<{ partition_name: string }>`
    select partition_name from cg.drop_position_partitions(make_interval(days => ${days}))`.execute(
    ctx.db,
  );
  if (dropped.rows.length === 0) return;
  const executionId = crypto.randomUUID();
  for (const c of counts) {
    await asSystem(ctx.db, c.tenant_id, async (trx) => {
      await trx
        .insertInto('cg.deletion_log')
        .values({
          tenant_id: c.tenant_id,
          data_category: 'position_trail',
          target_type: 'position',
          deleted_count: Number(c.n),
          oldest: new Date(c.oldest as Date),
          newest: new Date(c.newest as Date),
          execution_id: executionId,
        })
        .execute();
      await systemAudit(trx, c.tenant_id, 'retention.sweep', {
        action: 'retention.delete',
        targetType: 'position',
        targetId: `${c.n} rows in ${dropped.rows.length} day partition(s)`,
        executionId,
      });
    });
  }
  ctx.log.info(
    { days, partitions: dropped.rows.map((r) => r.partition_name) },
    'position trails dropped',
  );
  // Keep the look-ahead so an insert never meets a missing partition (SCL-06).
  await sql`select cg.ensure_position_partitions(3, 1)`.execute(ctx.db);
}

/**
 * Every minute (F09, FR-09.05/09.06): an active reminder past its due time (or
 * its snooze) turns `overdue` with a history row, and one that names an
 * escalation role is escalated once after its delay: the role's holders hear
 * by email through the message pipeline.
 */
export async function watchReminders(ctx: JobContext): Promise<void> {
  const now = nowOf(ctx);
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const due = await trx
        .selectFrom('cg.reminder')
        .select(['id'])
        .where('tenant_id', '=', tenantId)
        .where('state', '=', 'active')
        .where((eb) =>
          eb.or([
            eb.and([eb('snoozed_until', 'is', null), eb('due_at', '<=', now)]),
            eb('snoozed_until', '<=', now),
          ]),
        )
        .execute();
      for (const r of due) {
        // Only while still active: one completed or snoozed since the list was
        // read keeps what its owner did.
        const overdue = await trx
          .updateTable('cg.reminder')
          .set({ state: 'overdue', snoozed_until: null })
          .where('id', '=', r.id)
          .where('state', '=', 'active')
          .where((eb) =>
            eb.or([
              eb.and([eb('snoozed_until', 'is', null), eb('due_at', '<=', now)]),
              eb('snoozed_until', '<=', now),
            ]),
          )
          .returning('id')
          .executeTakeFirst();
        if (!overdue) continue;
        await trx
          .insertInto('cg.reminder_event')
          .values({
            tenant_id: tenantId,
            reminder_id: r.id,
            kind: 'overdue',
            detail: JSON.stringify({ at: now.toISOString() }),
          })
          .execute();
      }
      const toEscalate = await trx
        .selectFrom('cg.reminder')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('state', '=', 'overdue')
        .where('escalated_at', 'is', null)
        .where('escalate_to_role', 'is not', null)
        .where(
          sql<boolean>`due_at + make_interval(mins => coalesce(escalate_after_minutes, 30)) <= ${now}`,
        )
        .execute();
      for (const r of toEscalate) {
        // Only while still overdue and not yet escalated (see above).
        const escalated = await trx
          .updateTable('cg.reminder')
          .set({ escalated_at: now })
          .where('id', '=', r.id)
          .where('state', '=', 'overdue')
          .where('escalated_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!escalated) continue;
        const recipients = await staffRecipients(trx, tenantId, ['reminder.acknowledge'], {
          includeAdmins: true,
        });
        const owner = r.owner_account_id
          ? await trx
              .selectFrom('cg.account')
              .select('email')
              .where('id', '=', r.owner_account_id)
              .executeTakeFirst()
          : null;
        const emails = [...new Set([...(owner?.email ? [owner.email] : []), ...recipients.emails])];
        for (const email of emails) {
          await enqueueOutbox(trx, tenantId, 'message.send', {
            template: 'reminder_overdue',
            channel: 'email',
            toEnc: (await ctx.crypto.encrypt(tenantId, email)).toString('base64'),
            language: 'en',
            variables: {
              title: r.title,
              dueAt: new Date(r.due_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
              what: r.note ?? '',
              url: `${ctx.urls.gatewayPublic}/console/reminders`,
            },
            reminderId: r.id,
          });
        }
        await trx
          .insertInto('cg.reminder_event')
          .values({
            tenant_id: tenantId,
            reminder_id: r.id,
            kind: 'escalated',
            detail: JSON.stringify({ to: r.escalate_to_role, recipients: emails.length }),
          })
          .execute();
        await systemAudit(trx, tenantId, 'reminder.timer', {
          action: 'reminder.escalate',
          targetType: 'reminder',
          targetId: r.id,
          changes: {
            fields: [
              { name: 'escalated_to', to: r.escalate_to_role },
              { name: 'recipients', to: emails.length },
            ],
          },
        });
      }
    });
  }
}
