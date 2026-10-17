/**
 * Appointments on a case (FL:FR-18; docs/plans/case-management.md §3.4). The
 * caseworker or a partner holding the grant schedules an appointment with an
 * organization or table, at a place, at a time. Scheduling queues a text to
 * the survivor through the message pipeline (template `appointment`, English
 * or Spanish, texts only with opt-in, else email, else nothing and the
 * appointment says so); the worker sends the reminder the day before. The
 * text carries the time and place and never the purpose (plan §5.5). An
 * appointment is kept, missed or cancelled with a reason, never deleted.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import { formatAppointmentWhen } from '@cg/adapters';
import type { AppointmentStatus, Database } from '@cg/db';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import {
  accountNames,
  caseAccount as account,
  inCounty,
  locateCase,
  tenantNames,
  type CaseRow,
  type Trx,
} from './case-access.ts';
import { enqueueOutbox, iso, stamped, uuidParam } from './helpers.ts';

type Row = Selectable<Database['cg.appointment']>;

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'kept',
  'missed',
  'cancelled',
] as const satisfies readonly AppointmentStatus[];

export const appointmentOut = z.object({
  ...stamped,
  caseId: z.uuid(),
  withTenantId: z.uuid().nullable(),
  withLabel: z.string(),
  siteId: z.uuid().nullable(),
  place: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable(),
  /** Null when this role may not read free text. */
  purpose: z.string().nullable(),
  status: z.enum(APPOINTMENT_STATUSES),
  noticeChannel: z.enum(['sms', 'email']).nullable(),
  noticeQueuedAt: z.iso.datetime().nullable(),
  noticeSent: z.boolean(),
  reminderQueuedAt: z.iso.datetime().nullable(),
  reminderSent: z.boolean(),
  cancelReason: z.string().nullable(),
  scheduledBy: z.string().nullable(),
  scheduledByTenant: z.string().nullable(),
});
export type AppointmentOut = z.infer<typeof appointmentOut>;

const scheduleIn = z.object({
  withTenantId: z.uuid().optional(),
  withLabel: z.string().trim().min(1).max(200),
  siteId: z.uuid().optional(),
  place: z.string().trim().min(1).max(300),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().optional(),
  purpose: z.string().trim().max(500).optional(),
});
const statusIn = z.object({
  status: z.enum(['kept', 'missed', 'cancelled']),
  reason: z.string().trim().min(3).max(500).optional(),
});

/** The appointments of a case as this role may read them (purpose only with free text). */
export async function appointmentsOf(
  trx: Trx,
  c: CaseRow,
  textVisible: boolean,
): Promise<AppointmentOut[]> {
  const rows = await trx
    .selectFrom('cg.appointment')
    .selectAll()
    .where('case_id', '=', c.id)
    .orderBy('starts_at', 'desc')
    .execute();
  const who = await accountNames(
    trx,
    rows.map((r: Row) => r.created_by),
  );
  const orgs = await tenantNames(
    trx,
    rows.map((r: Row) => r.tenant_id),
  );
  // The tenant that scheduled it is the recorder's; stored on created_by's account.
  const accountTenants = rows.length
    ? await trx
        .selectFrom('cg.account')
        .select(['id', 'tenant_id'])
        .where(
          'id',
          'in',
          rows.map((r: Row) => r.created_by).filter((x): x is string => !!x),
        )
        .execute()
    : [];
  const tenantOf = new Map(accountTenants.map((a) => [a.id, a.tenant_id]));
  const moreOrgs = await tenantNames(trx, [...tenantOf.values()]);
  for (const [k, v] of moreOrgs) orgs.set(k, v);
  return rows.map((r: Row) => ({
    id: r.id,
    version: r.version,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    caseId: r.case_id,
    withTenantId: r.with_tenant_id,
    withLabel: r.with_label,
    siteId: r.site_id,
    place: r.place,
    startsAt: iso(r.starts_at)!,
    endsAt: iso(r.ends_at),
    purpose: textVisible ? r.purpose : null,
    status: r.status,
    noticeChannel: r.notice_channel,
    noticeQueuedAt: iso(r.notice_queued_at),
    noticeSent: r.notice_message_id !== null,
    reminderQueuedAt: iso(r.reminder_queued_at),
    reminderSent: r.reminder_message_id !== null,
    cancelReason: r.cancel_reason,
    scheduledBy: r.created_by ? (who.get(r.created_by) ?? null) : null,
    scheduledByTenant: r.created_by ? (orgs.get(tenantOf.get(r.created_by) ?? '') ?? null) : null,
  }));
}

export const appointmentRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  async function readable(request: FastifyRequest, row: CaseRow) {
    const s = account(request);
    const decision = await request.authorize('case.read', {
      type: 'case',
      id: row.id,
      tenantId: s.tenantId,
      fields: [{ name: 'description', category: 'free_text', classification: 'sensitive' }],
    });
    return decision.fields.includes('description');
  }

  app.post(
    '/cases/:id/appointments',
    {
      schema: {
        tags: ['cases'],
        params: uuidParam,
        body: scheduleIn,
        response: { 201: appointmentOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const { where, row } = await locateCase(request, request.params.id);
      await request.authorize('appointment.write', { type: 'appointment', tenantId: s.tenantId });
      const textVisible = await readable(request, row);
      if (row.status === 'closed') throw errors.conflict({ status: row.status });
      const b = request.body;
      const startsAt = new Date(b.startsAt);
      if (startsAt.getTime() <= Date.now())
        throw errors.validation([{ name: 'startsAt', message: 'must be in the future' }]);
      if (b.endsAt && new Date(b.endsAt) <= startsAt)
        throw errors.validation([{ name: 'endsAt', message: 'must follow the start' }]);
      const out = await inCounty(request, where.countyId, async (trx) => {
        if (b.siteId) {
          const site = await trx
            .selectFrom('cg.site')
            .select('id')
            .where('id', '=', b.siteId)
            .executeTakeFirst();
          if (!site) throw errors.validation([{ name: 'siteId', message: 'unknown site' }]);
        }
        // The survivor's contact and language, from the report the case is for.
        const report = await trx
          .selectFrom('cg.report')
          .leftJoin('cg.party', 'cg.party.id', 'cg.report.reporter_party_id')
          .select([
            'cg.report.id as id',
            'cg.report.execution_id as execution_id',
            'cg.party.id as party_id',
            'cg.party.contact_enc as contact_enc',
            'cg.party.sms_opt_in as sms_opt_in',
            'cg.party.language as language',
          ])
          .where('cg.report.id', '=', row.report_id)
          .executeTakeFirstOrThrow();
        const tenant = await trx
          .selectFrom('cg.tenant')
          .select('timezone')
          .where('id', '=', where.countyId)
          .executeTakeFirstOrThrow();
        const contact = report.contact_enc
          ? (JSON.parse(await app.fieldCrypto.decrypt(where.countyId, report.contact_enc)) as {
              phone?: string;
              email?: string;
            })
          : {};
        // docs/06: texts only with opt-in; email otherwise; nothing when the resident left no way.
        let channel: 'sms' | 'email' | null = null;
        let to: string | null = null;
        if (contact.phone && report.sms_opt_in) {
          channel = 'sms';
          to = contact.phone;
        } else if (contact.email) {
          channel = 'email';
          to = contact.email;
        }
        const now = new Date();
        const appt = await trx
          .insertInto('cg.appointment')
          .values({
            tenant_id: where.countyId,
            case_id: row.id,
            with_tenant_id: b.withTenantId ?? null,
            with_label: b.withLabel,
            site_id: b.siteId ?? null,
            place: b.place,
            starts_at: startsAt,
            ends_at: b.endsAt ? new Date(b.endsAt) : null,
            purpose: b.purpose ?? null,
            status: 'scheduled',
            notice_channel: channel,
            notice_queued_at: channel ? now : null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const language = report.language ?? 'en';
        if (channel && to)
          await enqueueOutbox(
            trx,
            where.countyId,
            'message.send',
            {
              template: 'appointment',
              channel,
              toEnc: (await app.fieldCrypto.encrypt(where.countyId, to)).toString('base64'),
              language,
              reportId: report.id,
              ...(report.party_id ? { partyId: report.party_id } : {}),
              appointmentId: appt.id,
              appointmentNotice: 'notice',
              // Time, place and who it is with: never the purpose (plan §5.5).
              variables: {
                when: formatAppointmentWhen(startsAt, tenant.timezone, language),
                place: b.place,
                withOrg: b.withLabel,
              },
            },
            report.execution_id,
          );
        await trx
          .updateTable('cg.case')
          .set({ version: row.version + 1, updated_at: now, updated_by: s.accountId })
          .where('id', '=', row.id)
          .where('version', '=', row.version)
          .execute();
        await request.audit(trx, {
          action: 'appointment.scheduled',
          targetType: 'appointment',
          targetId: appt.id,
          targetVersion: appt.version,
          changes: {
            fields: [
              { name: 'case_id', to: row.id },
              { name: 'starts_at', to: startsAt.toISOString() },
              { name: 'notice_channel', to: channel ?? 'none' },
              { name: 'via_grant', to: String(where.viaGrant) },
            ],
          },
        });
        return (await appointmentsOf(trx, row, textVisible)).find((a) => a.id === appt.id)!;
      });
      return reply.code(201).send(out);
    },
  );

  app.post(
    '/cases/:id/appointments/:apptId/status',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['cases'],
        params: uuidParam.extend({ apptId: z.uuid() }),
        body: statusIn,
        response: { 200: appointmentOut },
      },
    },
    async (request) => {
      const s = account(request);
      const { where, row } = await locateCase(request, request.params.id);
      await request.authorize('appointment.write', {
        type: 'appointment',
        id: request.params.apptId,
        tenantId: s.tenantId,
      });
      const textVisible = await readable(request, row);
      const expected = request.expectedVersion();
      const b = request.body;
      if (b.status === 'cancelled' && !b.reason)
        throw errors.validation([{ name: 'reason', message: 'cancelling needs a reason' }]);
      return inCounty(request, where.countyId, async (trx) => {
        const appt = await trx
          .selectFrom('cg.appointment')
          .selectAll()
          .where('id', '=', request.params.apptId)
          .where('case_id', '=', row.id)
          .executeTakeFirst();
        if (!appt) throw errors.notFound();
        if (appt.status !== 'scheduled') throw errors.conflict({ status: appt.status });
        const updated = assertUpdated(
          await trx
            .updateTable('cg.appointment')
            .set({
              status: b.status,
              cancel_reason: b.status === 'cancelled' ? (b.reason ?? null) : null,
              version: appt.version + 1,
              updated_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', appt.id)
            .where('version', '=', expected)
            .returning(['id', 'version'])
            .executeTakeFirst(),
          { version: appt.version },
        );
        await request.audit(trx, {
          action: `appointment.${b.status}`,
          targetType: 'appointment',
          targetId: updated.id,
          targetVersion: updated.version,
          reason: b.reason ?? null,
          changes: { fields: [{ name: 'status', from: appt.status, to: b.status }] },
        });
        return (await appointmentsOf(trx, row, textVisible)).find((a) => a.id === appt.id)!;
      });
    },
  );
};
