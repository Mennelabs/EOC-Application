/**
 * ICS forms as documents (CON-13; layer-8 plan §4): the ICS 201 incident
 * briefing, 213 general message, 213 RR resource request, 214 activity log
 * and 309 communications log, built from the event's records into one
 * content model (packages/reporting/src/ics). A form is previewed for a
 * scope, then issued: frozen with its SHA-256 (RULE-10) and numbered per
 * event; PDF (tagged, PDF/UA-1) and CSV are drawn from the frozen content,
 * and every download is audited with its scope (SEC-18). Forms carry staff
 * names and positions and counts, never a resident (plan §12).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, IcsFormKey } from '@cg/db';
import { renderPdf } from '@cg/pdf';
import {
  ICS_FORMS,
  ICS_FORM_KEYS,
  contentHash,
  ics201,
  ics213,
  ics213rr,
  ics214,
  ics309,
  icsCsv,
  icsPdf,
  type IcsFormContent,
  type Signer,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { signerOf } from './general-messages.ts';
import { enqueueOutbox, iso, listQuery, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type IssueRow = Selectable<Database['cg.ics_form_issue']>;

const formKey = z.enum(['ics_201', 'ics_213', 'ics_213rr', 'ics_214', 'ics_309']);
/** What a form covers; which keys matter depends on the form. */
const scopeIn = z.object({
  eventId: z.uuid(),
  periodFrom: z.iso.datetime().optional(),
  periodTo: z.iso.datetime().optional(),
  generalMessageId: z.uuid().optional(),
  resourceRequestId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  personnelId: z.uuid().optional(),
  net: z.string().trim().max(120).optional(),
});
type Scope = z.infer<typeof scopeIn>;

const contentOut = z.object({
  form: formKey,
  number: z.string(),
  title: z.string(),
  edition: z.string(),
  incident: z.string(),
  timeZone: z.string(),
  preparedBy: z.object({ name: z.string(), position: z.string().nullable() }),
  preparedAt: z.iso.datetime(),
  blocks: z.array(
    z.object({
      no: z.string(),
      label: z.string(),
      kind: z.enum(['value', 'text', 'table']),
      value: z.union([z.string(), z.number()]).nullable().optional(),
      text: z.string().nullable().optional(),
      columns: z.array(z.string()).optional(),
      rows: z.array(z.array(z.union([z.string(), z.number()]).nullable())).optional(),
    }),
  ),
});
const issueOut = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  form: formKey,
  number: z.string(),
  edition: z.string(),
  sequence: z.number().int(),
  title: z.string(),
  scope: z.record(z.string(), z.unknown()),
  contentHash: z.string(),
  issuedAt: z.iso.datetime(),
  issuedBy: z.string().nullable(),
});

export interface IcsFormDeps {
  productName?: string;
}

export const icsFormRoutesWith =
  (deps: IcsFormDeps = {}): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();
    const productName = deps.productName ?? 'the platform';
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    const names = async (trx: Trx, ids: (string | null)[]) => {
      const wanted = [...new Set(ids.filter((x): x is string => !!x))];
      if (!wanted.length) return new Map<string, string>();
      const rows = await trx
        .selectFrom('cg.account')
        .select(['id', 'display_name'])
        .where('id', 'in', wanted)
        .execute();
      return new Map(rows.map((r) => [r.id, r.display_name]));
    };
    /** A staff member's name and roster position as a form signs them. */
    const signerFor = async (trx: Trx, accountId: string | null): Promise<Signer | null> => {
      if (!accountId) return null;
      try {
        return await signerOf(trx, accountId);
      } catch {
        return null;
      }
    };
    const periodOf = (scope: Scope, fallbackFrom: Date | null) => {
      const to = scope.periodTo ? new Date(scope.periodTo) : new Date();
      const from = scope.periodFrom
        ? new Date(scope.periodFrom)
        : (fallbackFrom ?? new Date(to.getTime() - 12 * 3_600_000));
      if (to <= from)
        throw errors.validation([{ name: 'periodTo', message: 'after the period start' }]);
      return { from, to };
    };

    // ------------------------------------------------------------ loaders
    async function build(
      trx: Trx,
      tenantId: string,
      me: { accountId: string; tz: string },
      form: IcsFormKey,
      scope: Scope,
    ): Promise<IcsFormContent> {
      const event = await trx
        .selectFrom('cg.event')
        .select(['id', 'name', 'intake_slug', 'opened_at', 'footprint', 'created_at'])
        .where('id', '=', scope.eventId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!event)
        throw errors.validation([{ name: 'eventId', message: 'an event of this organization' }]);
      const preparedBy = (await signerFor(trx, me.accountId)) ?? {
        name: 'Unknown',
        position: null,
      };
      const common = {
        incident: event.name,
        timeZone: me.tz,
        preparedBy,
        preparedAt: new Date().toISOString(),
      };

      if (form === 'ics_201') {
        const { from, to } = periodOf(scope, null);
        const [places, objectives, missions, checkIns, teams, requests, sitrep] = await Promise.all(
          [
            trx
              .selectFrom('cg.site')
              .select(['name', 'kind', 'status'])
              .where('tenant_id', '=', tenantId)
              .where('event_id', '=', event.id)
              .orderBy('name')
              .execute(),
            trx
              .selectFrom('cg.incident_objective')
              .select(['position', 'objective', 'owner_position', 'status'])
              .where('event_id', '=', event.id)
              .where('period_from', '<', to)
              .where('period_to', '>', from)
              .orderBy('period_from', 'desc')
              .orderBy('position')
              .execute(),
            trx
              .selectFrom('cg.mission')
              .select(['reference', 'kind', 'state', 'priority', 'summary'])
              .where('event_id', '=', event.id)
              .where('state', 'in', ['open', 'en_route', 'on_scene'])
              .orderBy('priority', 'desc')
              .orderBy('reference')
              .limit(200)
              .execute(),
            trx
              .selectFrom('cg.check_in as c')
              .innerJoin('cg.personnel as p', 'p.id', 'c.personnel_id')
              .select(['p.name', 'p.operational_role', 'p.agency'])
              .where('c.event_id', '=', event.id)
              .where('c.ended_at', 'is', null)
              .where('p.operational_role', 'is not', null)
              .orderBy('p.operational_role')
              .orderBy('p.name')
              .limit(200)
              .execute(),
            trx
              .selectFrom('cg.team as t')
              .leftJoin('cg.team_status as st', (j) =>
                j
                  .onRef('st.team_id', '=', 't.id')
                  .on('st.id', '=', (eb) =>
                    eb
                      .selectFrom('cg.team_status as s2')
                      .select('s2.id')
                      .whereRef('s2.team_id', '=', 't.id')
                      .orderBy('s2.created_at', 'desc')
                      .limit(1),
                  ),
              )
              .select(['t.name', 't.callsign', 't.agency', 'st.status', 'st.created_at as since'])
              .where('t.tenant_id', '=', tenantId)
              .where((eb) => eb.or([eb('t.event_id', '=', event.id), eb('t.event_id', 'is', null)]))
              .orderBy('t.name')
              .limit(200)
              .execute(),
            trx
              .selectFrom('cg.resource_request as r')
              .select([
                'r.request_number',
                'r.status',
                'r.submitted_at',
                'r.placed_at',
                'r.eta',
                'r.arrived_at',
                'r.state_tracking_number',
                (eb) =>
                  eb
                    .selectFrom('cg.resource_request_line as l')
                    .select(
                      sql<string>`string_agg(l.quantity::text || ' ' || l.kind, '; ' order by l.line_no)`.as(
                        'x',
                      ),
                    )
                    .whereRef('l.request_id', '=', 'r.id')
                    .as('items'),
              ])
              .where('r.event_id', '=', event.id)
              .where('r.status', 'in', ['submitted', 'approved', 'placed', 'en_route', 'received'])
              .orderBy('r.request_number')
              .execute(),
            trx
              .selectFrom('cg.official_report as r')
              .innerJoin('cg.official_report_snapshot as s', 's.report_id', 'r.id')
              .select(['r.title', 's.issued_at', 's.content'])
              .where('r.event_id', '=', event.id)
              .where('r.kind', '=', 'sitrep')
              .where('r.state', '=', 'issued')
              .orderBy('s.issued_at', 'desc')
              .limit(1)
              .executeTakeFirst(),
          ],
        );
        const summaryOf = (content: unknown): string => {
          const sections = (
            content as { sections?: { key?: string; content?: { text?: string } }[] }
          )?.sections;
          const s = sections?.find((x) => x.key === 'summary') ?? sections?.[0];
          return s?.content?.text ?? '';
        };
        return ics201({
          ...common,
          incidentNumber: event.intake_slug ? event.intake_slug.toUpperCase() : null,
          initiatedAt: iso(event.opened_at ?? event.created_at),
          periodFrom: from.toISOString(),
          periodTo: to.toISOString(),
          places: places.map((p) => ({ name: p.name, kind: p.kind, status: p.status })),
          hasGeometry: event.footprint !== null,
          situation: sitrep
            ? {
                title: sitrep.title,
                issuedAt: iso(sitrep.issued_at)!,
                text: summaryOf(sitrep.content),
              }
            : null,
          safety: null,
          objectives: objectives.map((o) => ({
            position: o.position,
            objective: o.objective,
            owner: o.owner_position,
            status: o.status,
          })),
          actions: missions.map((m) => ({
            reference: m.reference,
            kind: m.kind,
            state: m.state,
            priority: m.priority,
            summary: m.summary,
          })),
          organization: checkIns.map((c) => ({
            position: c.operational_role ?? 'Unknown',
            name: c.name,
            agency: c.agency,
          })),
          resources: [
            ...teams.map((t) => ({
              resource: t.name,
              identifier: t.callsign,
              ordered: null,
              eta: null,
              arrived: null,
              status: t.status ?? 'unknown',
              notes: t.agency,
            })),
            ...requests.map((r) => ({
              resource: r.items ?? r.request_number,
              identifier: r.request_number,
              ordered: iso(r.placed_at ?? r.submitted_at),
              eta: iso(r.eta),
              arrived: iso(r.arrived_at),
              status: r.status,
              notes: r.state_tracking_number ? `State number ${r.state_tracking_number}` : null,
            })),
          ],
        });
      }

      if (form === 'ics_213') {
        if (!scope.generalMessageId)
          throw errors.validation([{ name: 'generalMessageId', message: 'the message' }]);
        const m = await trx
          .selectFrom('cg.general_message')
          .selectAll()
          .where('id', '=', scope.generalMessageId)
          .where('event_id', '=', event.id)
          .executeTakeFirst();
        if (!m)
          throw errors.validation([
            { name: 'generalMessageId', message: 'a message of this event' },
          ]);
        const approver = await signerFor(trx, m.approved_by);
        return ics213({
          ...common,
          messageNumber: m.message_number,
          to: { name: m.to_name, position: m.to_position },
          from: { name: m.from_name, position: m.from_position },
          subject: m.subject,
          sentAt: iso(m.sent_at),
          body: m.body,
          approvedBy: approver,
          approvedAt: iso(m.approved_at),
          reply: m.reply,
          repliedBy: m.reply_by_name
            ? { name: m.reply_by_name, position: m.reply_by_position }
            : null,
          repliedAt: iso(m.replied_at),
        });
      }

      if (form === 'ics_213rr') {
        if (!scope.resourceRequestId)
          throw errors.validation([{ name: 'resourceRequestId', message: 'the request' }]);
        const r = await trx
          .selectFrom('cg.resource_request')
          .selectAll()
          .where('id', '=', scope.resourceRequestId)
          .where('event_id', '=', event.id)
          .executeTakeFirst();
        if (!r)
          throw errors.validation([
            { name: 'resourceRequestId', message: 'a request of this event' },
          ]);
        const lines = await trx
          .selectFrom('cg.resource_request_line')
          .selectAll()
          .where('request_id', '=', r.id)
          .orderBy('line_no')
          .execute();
        const [approver, placer, finance] = await Promise.all([
          signerFor(trx, r.approved_by),
          signerFor(trx, r.placed_by),
          signerFor(trx, r.finance_replied_by),
        ]);
        return ics213rr({
          ...common,
          requestNumber: r.request_number,
          requestedAt: iso(r.submitted_at ?? r.created_at),
          lines: lines.map((l) => ({
            quantity: Number(l.quantity),
            unit: l.unit,
            kind: l.kind,
            type: l.type,
            description: l.description,
            eta: iso(l.eta),
            cost: l.cost === null ? null : Number(l.cost),
          })),
          deliveryLocation: r.delivery_location,
          substitutes: r.substitutes,
          suggestedSources: r.suggested_sources,
          requestedBy: { name: r.requested_by_name, position: r.requested_by_position },
          priority: r.priority,
          approvedBy: approver,
          approvedAt: iso(r.approved_at),
          logisticsOrderNumber: r.logistics_order_number,
          supplier: r.supplier,
          notes: r.notes,
          placedBy: placer,
          placedAt: iso(r.placed_at),
          placedWith:
            r.placed_with === 'state'
              ? 'the state'
              : r.placed_with === 'local'
                ? 'a local supplier'
                : null,
          stateTrackingNumber: r.state_tracking_number,
          eta: iso(r.eta),
          financeReply: r.finance_reply,
          financeBy: finance,
          financeAt: iso(r.finance_replied_at),
          status: r.status,
        });
      }

      if (form === 'ics_214') {
        if (!scope.teamId && !scope.personnelId)
          throw errors.validation([{ name: 'teamId', message: 'a team or a person' }]);
        const { from, to } = periodOf(scope, null);
        let subject: { name: string; position: string | null; agency: string | null };
        let assigned: { name: string; position: string | null; agency: string | null }[] = [];
        const activities: { at: string; activity: string }[] = [];
        if (scope.teamId) {
          const t = await trx
            .selectFrom('cg.team')
            .select(['id', 'name', 'kind', 'agency', 'callsign'])
            .where('id', '=', scope.teamId)
            .where('tenant_id', '=', tenantId)
            .executeTakeFirst();
          if (!t)
            throw errors.validation([{ name: 'teamId', message: 'a team of this organization' }]);
          subject = {
            name: t.callsign ? `${t.name} (${t.callsign})` : t.name,
            position: t.kind,
            agency: t.agency,
          };
          const members = await trx
            .selectFrom('cg.team_member as m')
            .innerJoin('cg.personnel as p', 'p.id', 'm.personnel_id')
            .select(['p.name', 'p.operational_role', 'p.agency', 'm.role'])
            .where('m.team_id', '=', t.id)
            .where((eb) => eb.or([eb('m.left_at', 'is', null), eb('m.left_at', '>', from)]))
            .where('m.joined_at', '<', to)
            .orderBy('p.name')
            .execute();
          assigned = members.map((m) => ({
            name: m.name,
            position: m.operational_role ?? m.role,
            agency: m.agency,
          }));
          const [events, assignments, statuses, checkIns] = await Promise.all([
            trx
              .selectFrom('cg.significant_event')
              .select(['occurred_at', 'summary'])
              .where('event_id', '=', event.id)
              .where('team_id', '=', t.id)
              .where('occurred_at', '>=', from)
              .where('occurred_at', '<', to)
              .execute(),
            trx
              .selectFrom('cg.assignment as a')
              .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
              .select(['a.assigned_at', 'a.state', 'm.reference', 'm.summary'])
              .where('a.team_id', '=', t.id)
              .where('a.assigned_at', '>=', from)
              .where('a.assigned_at', '<', to)
              .execute(),
            trx
              .selectFrom('cg.team_status')
              .select(['created_at', 'status', 'note'])
              .where('team_id', '=', t.id)
              .where('created_at', '>=', from)
              .where('created_at', '<', to)
              .execute(),
            trx
              .selectFrom('cg.check_in as c')
              .innerJoin('cg.personnel as p', 'p.id', 'c.personnel_id')
              .select(['c.started_at', 'c.ended_at', 'p.name'])
              .where('c.team_id', '=', t.id)
              .where('c.event_id', '=', event.id)
              .where('c.started_at', '<', to)
              .where((eb) => eb.or([eb('c.ended_at', 'is', null), eb('c.ended_at', '>', from)]))
              .execute(),
          ]);
          for (const e of events) activities.push({ at: iso(e.occurred_at)!, activity: e.summary });
          for (const a of assignments)
            activities.push({
              at: iso(a.assigned_at)!,
              activity: `${a.reference} assigned (${a.state})${a.summary ? `: ${a.summary}` : ''}`,
            });
          for (const st of statuses)
            activities.push({
              at: iso(st.created_at)!,
              activity: `Status ${st.status.replace('_', ' ')}${st.note ? `: ${st.note}` : ''}`,
            });
          for (const c of checkIns) {
            if (c.started_at >= from)
              activities.push({ at: iso(c.started_at)!, activity: `${c.name} checked in` });
            if (c.ended_at && c.ended_at < to)
              activities.push({ at: iso(c.ended_at)!, activity: `${c.name} checked out` });
          }
        } else {
          const p = await trx
            .selectFrom('cg.personnel')
            .select(['id', 'name', 'operational_role', 'agency', 'account_id'])
            .where('id', '=', scope.personnelId!)
            .where('tenant_id', '=', tenantId)
            .executeTakeFirst();
          if (!p)
            throw errors.validation([
              { name: 'personnelId', message: 'a person of this organization' },
            ]);
          subject = { name: p.name, position: p.operational_role, agency: p.agency };
          const [assignments, checkIns, events] = await Promise.all([
            trx
              .selectFrom('cg.assignment as a')
              .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
              .select(['a.assigned_at', 'a.state', 'm.reference', 'm.summary'])
              .where('a.personnel_id', '=', p.id)
              .where('a.assigned_at', '>=', from)
              .where('a.assigned_at', '<', to)
              .execute(),
            trx
              .selectFrom('cg.check_in as c')
              .leftJoin('cg.team as t', 't.id', 'c.team_id')
              .select(['c.started_at', 'c.ended_at', 't.name as team'])
              .where('c.personnel_id', '=', p.id)
              .where('c.event_id', '=', event.id)
              .where('c.started_at', '<', to)
              .where((eb) => eb.or([eb('c.ended_at', 'is', null), eb('c.ended_at', '>', from)]))
              .execute(),
            p.account_id
              ? trx
                  .selectFrom('cg.significant_event')
                  .select(['occurred_at', 'summary'])
                  .where('event_id', '=', event.id)
                  .where('actor_account_id', '=', p.account_id)
                  .where('occurred_at', '>=', from)
                  .where('occurred_at', '<', to)
                  .execute()
              : Promise.resolve([]),
          ]);
          for (const a of assignments)
            activities.push({
              at: iso(a.assigned_at)!,
              activity: `${a.reference} assigned (${a.state})${a.summary ? `: ${a.summary}` : ''}`,
            });
          for (const c of checkIns) {
            if (c.started_at >= from)
              activities.push({
                at: iso(c.started_at)!,
                activity: `Checked in${c.team ? ` with ${c.team}` : ''}`,
              });
            if (c.ended_at && c.ended_at < to)
              activities.push({ at: iso(c.ended_at)!, activity: 'Checked out' });
          }
          for (const e of events) activities.push({ at: iso(e.occurred_at)!, activity: e.summary });
        }
        activities.sort((a, b) => a.at.localeCompare(b.at));
        return ics214({
          ...common,
          periodFrom: from.toISOString(),
          periodTo: to.toISOString(),
          subject,
          assigned,
          activities,
        });
      }

      // ics_309
      const { from, to } = periodOf(scope, null);
      let q = trx
        .selectFrom('cg.comms_log')
        .select([
          'net',
          'entry_at',
          'from_station',
          'to_station',
          'kind',
          'message',
          'operator_account_id',
        ])
        .where('event_id', '=', event.id)
        .where('entry_at', '>=', from)
        .where('entry_at', '<', to)
        .orderBy('entry_at')
        .limit(2000);
      if (scope.net) q = q.where('net', '=', scope.net);
      const entries = await q.execute();
      const operators = await names(
        trx,
        entries.map((e) => e.operator_account_id),
      );
      const operatorIds = [...new Set(entries.map((e) => e.operator_account_id).filter(Boolean))];
      const operator: Signer | null =
        operatorIds.length === 1
          ? await signerFor(trx, operatorIds[0]!)
          : operatorIds.length > 1
            ? {
                name: operatorIds.map((id) => operators.get(id!) ?? 'Unknown').join('; '),
                position: 'Net control',
              }
            : null;
      return ics309({
        ...common,
        periodFrom: from.toISOString(),
        periodTo: to.toISOString(),
        net: scope.net ?? ([...new Set(entries.map((e) => e.net))].join(', ') || 'All nets'),
        operator,
        entries: entries.map((e) => ({
          at: iso(e.entry_at)!,
          from: e.from_station,
          to: e.to_station,
          message: e.message ?? e.kind.replace('_', ' '),
        })),
      });
    }

    const issueView = (r: IssueRow, who: Map<string, string>): z.infer<typeof issueOut> => ({
      id: r.id,
      eventId: r.event_id,
      form: r.form,
      number: ICS_FORMS[r.form].number,
      edition: r.edition,
      sequence: r.sequence,
      title: r.title,
      scope: r.scope,
      contentHash: r.content_hash,
      issuedAt: iso(r.issued_at)!,
      issuedBy: who.get(r.issued_by) ?? null,
    });
    const tzOf = (request: FastifyRequest) => account(request).tenantTimeZone ?? 'UTC';

    // ------------------------------------------------------------ routes
    app.get(
      '/ics-forms',
      {
        schema: {
          tags: ['ics forms'],
          response: {
            200: z.array(
              z.object({
                form: formKey,
                number: z.string(),
                title: z.string(),
                edition: z.string(),
                scope: z.string(),
              }),
            ),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('ics_form.read', { type: 'ics_form', tenantId: s.tenantId });
        return ICS_FORM_KEYS.map((form) => ({ form, ...ICS_FORMS[form] }));
      },
    );

    app.post(
      '/ics-forms/:form/preview',
      {
        schema: {
          tags: ['ics forms'],
          params: z.object({ form: formKey }),
          body: scopeIn,
          response: { 200: contentOut },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('ics_form.read', {
          type: 'ics_form',
          tenantId: s.tenantId,
          eventId: request.body.eventId,
        });
        return request.tx((trx) =>
          build(
            trx,
            s.tenantId,
            { accountId: s.accountId, tz: tzOf(request) },
            request.params.form,
            request.body,
          ),
        );
      },
    );

    app.post(
      '/ics-forms/:form/issue',
      {
        schema: {
          tags: ['ics forms'],
          params: z.object({ form: formKey }),
          body: scopeIn,
          response: { 201: issueOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const form = request.params.form;
        await request.authorize('ics_form.issue', {
          type: 'ics_form',
          tenantId: s.tenantId,
          eventId: request.body.eventId,
        });
        const { reason } = request.confirmation();
        const out = await request.tx(async (trx) => {
          const content = await build(
            trx,
            s.tenantId,
            { accountId: s.accountId, tz: tzOf(request) },
            form,
            request.body,
          );
          await trx
            .selectFrom('cg.event')
            .select('id')
            .where('id', '=', request.body.eventId)
            .forUpdate()
            .executeTakeFirst();
          const n = await trx
            .selectFrom('cg.ics_form_issue')
            .select(sql<string>`count(*)`.as('n'))
            .where('event_id', '=', request.body.eventId)
            .where('form', '=', form)
            .executeTakeFirstOrThrow();
          const hash = contentHash(content);
          const r = await trx
            .insertInto('cg.ics_form_issue')
            .values({
              tenant_id: s.tenantId,
              event_id: request.body.eventId,
              form,
              edition: content.edition,
              sequence: Number(n.n) + 1,
              title: `${content.number} ${content.title}: ${content.incident}`,
              scope: JSON.stringify(request.body),
              content: JSON.stringify(content),
              content_hash: hash,
              issued_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'ics_form.issue',
            targetType: 'ics_form_issue',
            targetId: r.id,
            reason,
            changes: { form, sequence: r.sequence, contentHash: hash, scope: request.body },
          });
          await enqueueOutbox(
            trx,
            s.tenantId,
            'ics_form.issued',
            { issueId: r.id },
            request.executionId,
          );
          return issueView(r, await names(trx, [r.issued_by]));
        });
        return reply.code(201).send(out);
      },
    );

    app.get(
      '/ics-forms/issues',
      {
        schema: {
          tags: ['ics forms'],
          querystring: listQuery.extend({ eventId: z.uuid(), form: formKey.optional() }),
          response: { 200: z.array(issueOut) },
        },
      },
      async (request) => {
        const s = account(request);
        const q = request.query;
        await request.authorize('ics_form.read', {
          type: 'ics_form',
          tenantId: s.tenantId,
          eventId: q.eventId,
        });
        return request.tx(async (trx) => {
          let x = trx
            .selectFrom('cg.ics_form_issue')
            .selectAll()
            .where('tenant_id', '=', s.tenantId)
            .where('event_id', '=', q.eventId)
            .orderBy('issued_at', 'desc')
            .limit(q.limit)
            .offset(q.offset);
          if (q.form) x = x.where('form', '=', q.form);
          const rows = await x.execute();
          const who = await names(
            trx,
            rows.map((r) => r.issued_by),
          );
          return rows.map((r) => issueView(r, who));
        });
      },
    );

    const loadIssue = async (request: FastifyRequest, id: string, action: string) => {
      const s = account(request);
      const r = await request.tx((trx) =>
        trx.selectFrom('cg.ics_form_issue').selectAll().where('id', '=', id).executeTakeFirst(),
      );
      if (!r || r.tenant_id !== s.tenantId) throw errors.notFound();
      await request.authorize(
        action,
        { type: 'ics_form', id: r.id, tenantId: r.tenant_id, eventId: r.event_id },
        { asNotFound: true },
      );
      const content = r.content as unknown as IcsFormContent;
      if (contentHash(content) !== r.content_hash)
        throw new ApiError(409, 'content_mismatch', 'The stored content does not match its hash.');
      return { r, content };
    };

    app.get(
      '/ics-forms/issues/:id',
      {
        schema: {
          tags: ['ics forms'],
          params: uuidParam,
          response: { 200: issueOut.extend({ content: contentOut }) },
        },
      },
      async (request) => {
        const { r, content } = await loadIssue(request, request.params.id, 'ics_form.read');
        const who = await request.tx((trx) => names(trx, [r.issued_by]));
        return { ...issueView(r, who), content };
      },
    );

    /** SEC-18: every download is audited with the form, its issue and scope. */
    for (const format of ['pdf', 'csv'] as const)
      app.get(
        `/ics-forms/issues/:id/${format}`,
        { schema: { tags: ['ics forms'], params: uuidParam } },
        async (request, reply) => {
          const { r, content } = await loadIssue(request, request.params.id, 'ics_form.export');
          await request.tx((trx) =>
            request.audit(trx, {
              action: 'ics_form.export',
              targetType: 'ics_form_issue',
              targetId: r.id,
              changes: {
                form: r.form,
                sequence: r.sequence,
                format,
                scope: r.scope,
                contentHash: r.content_hash,
              },
            }),
          );
          const name = `${r.form.replace('_', '-')}-${r.sequence}.${format}`;
          if (format === 'csv')
            return reply
              .header('content-type', 'text/csv; charset=utf-8')
              .header('content-disposition', `attachment; filename="${name}"`)
              .send(icsCsv(content));
          const pdf = await renderPdf(
            icsPdf(content, { productName, contentHash: r.content_hash, sequence: r.sequence }),
          );
          return reply
            .header('content-type', 'application/pdf')
            .header('content-disposition', `attachment; filename="${name}"`)
            .send(pdf);
        },
      );
  };
