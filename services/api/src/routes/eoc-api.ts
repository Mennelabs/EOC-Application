/**
 * The state's read API and callbacks (CON-13, SCL-09; layer-8 plan §7;
 * ADR-0042). A state system that still runs WebEOC receives the county's
 * EOC records through an API key with scope `eoc.read`: resource requests
 * with their lines and history, significant events, issued situation
 * reports and issued ICS forms (JSON, or the form's PDF), for an event and
 * a period. Through a key with scope `resource_request.update` it sets its
 * tracking number and the status of a resource request; each change is a
 * step by the key, audited, and announced by webhook. Keys are approved by
 * a second administrator (0051) and every use is audited. Nothing here
 * names a resident: requests carry counts, logs carry what happened.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { recordAudit } from '@cg/audit';
import { apiKeyMatches, apiKeyPrefix } from '@cg/crypto';
import { withTenant, type Database } from '@cg/db';
import { renderPdf } from '@cg/pdf';
import { ICS_FORMS, icsPdf, type IcsFormContent } from '@cg/reporting';
import { ApiError } from '../errors.ts';
import type { TenantResolver } from '../public/tenant-resolver.ts';
import { enqueueOutbox, iso } from './helpers.ts';

export interface EocApiDeps {
  resolver: Pick<TenantResolver, 'bySlug'>;
  db: Kysely<Database>;
  productName?: string;
  now?: () => Date;
}

type Trx = Transaction<Database>;
type Scope = 'eoc.read' | 'resource_request.update';
interface Who {
  tenantId: string;
  keyId: string;
  prefix: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sendError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ code, message });

export function eocApiRoutes(deps: EocApiDeps): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());
  const productName = deps.productName ?? 'the platform';

  return async (app) => {
    /** The tenant and key for a scope, or an answer already sent (never which part failed). */
    async function admit(
      request: FastifyRequest<{ Params: { tenant: string } }>,
      reply: FastifyReply,
      scope: Scope,
    ): Promise<Who | null> {
      const header = request.headers['x-api-key'];
      const key = typeof header === 'string' ? header : undefined;
      if (!key) {
        await sendError(reply, 401, 'api_key_required', 'An API key is required (x-api-key).');
        return null;
      }
      let tenant;
      try {
        tenant = await deps.resolver.bySlug(request.params.tenant);
      } catch {
        await sendError(reply, 404, 'not_found', 'Not found.');
        return null;
      }
      const prefix = apiKeyPrefix(key);
      const at = now();
      const found = prefix
        ? await withTenant(deps.db, { tenantId: tenant.id }, async (trx) => {
            const row = await trx
              .selectFrom('cg.api_key')
              .select(['id', 'secret_hash', 'status', 'scopes', 'expires_at', 'last_used_at'])
              .where('tenant_id', '=', tenant.id)
              .where('prefix', '=', prefix)
              .executeTakeFirst();
            if (
              !row ||
              !apiKeyMatches(key, row.secret_hash) ||
              row.status !== 'active' ||
              row.expires_at.getTime() <= at.getTime() ||
              !(row.scopes as string[]).includes(scope)
            )
              return null;
            if (!row.last_used_at || at.getTime() - row.last_used_at.getTime() > 60_000)
              await trx
                .updateTable('cg.api_key')
                .set({ last_used_at: at })
                .where('id', '=', row.id)
                .execute();
            return row;
          })
        : null;
      if (!found) {
        await sendError(reply, 401, 'api_key_invalid', 'The API key is not valid for this.');
        return null;
      }
      return { tenantId: tenant.id, keyId: found.id, prefix: prefix! };
    }

    const audit = (trx: Trx, who: Who, request: FastifyRequest, what: Record<string, unknown>) =>
      recordAudit(trx, {
        tenantId: who.tenantId,
        actorKind: 'public',
        actorAccountId: null,
        action: 'api_key.use',
        targetType: 'api_key',
        targetId: who.keyId,
        requestId: request.id,
        reason: `state read API, key ${who.prefix}`,
        changes: what,
      });

    const eventOf = async (trx: Trx, tenantId: string, wanted: string | undefined) => {
      if (wanted !== undefined && !UUID.test(wanted)) return { error: 'event must be an event id' };
      const row = await trx
        .selectFrom('cg.event')
        .select(['id', 'name'])
        .where('tenant_id', '=', tenantId)
        .$if(!!wanted, (q) => q.where('id', '=', wanted!))
        .$if(!wanted, (q) => q.where('status', '=', 'active'))
        .orderBy('opened_at', (ob) => ob.desc().nullsLast())
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row ? { event: row } : { error: 'no such event' };
    };
    const period = (q: Record<string, string | undefined>) => {
      const to = q['to'] ? new Date(q['to']) : now();
      const from = q['from'] ? new Date(q['from']) : new Date(to.getTime() - 7 * 86_400_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
      return { from, to };
    };
    type Q = Record<string, string | undefined>;
    type P = { tenant: string };

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

    /** One resource request as the state reads it: blocks, lines and history; staff names and positions only. */
    async function requestView(trx: Trx, id: string) {
      const r = await trx
        .selectFrom('cg.resource_request')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!r) return null;
      const [lines, steps] = await Promise.all([
        trx
          .selectFrom('cg.resource_request_line')
          .selectAll()
          .where('request_id', '=', r.id)
          .orderBy('line_no')
          .execute(),
        trx
          .selectFrom('cg.resource_request_step')
          .selectAll()
          .where('request_id', '=', r.id)
          .orderBy('occurred_at')
          .execute(),
      ]);
      const who = await names(trx, [
        r.approved_by,
        r.placed_by,
        ...steps.map((s) => s.actor_account_id),
      ]);
      return {
        id: r.id,
        eventId: r.event_id,
        requestNumber: r.request_number,
        status: r.status,
        priority: r.priority,
        deliveryLocation: r.delivery_location,
        requestedBy: { name: r.requested_by_name, position: r.requested_by_position },
        substitutes: r.substitutes,
        suggestedSources: r.suggested_sources,
        notes: r.notes,
        costEstimate: r.cost_estimate === null ? null : Number(r.cost_estimate),
        financeReply: r.finance_reply,
        submittedAt: iso(r.submitted_at),
        approvedAt: iso(r.approved_at),
        approvedBy: r.approved_by ? (who.get(r.approved_by) ?? null) : null,
        placedAt: iso(r.placed_at),
        placedWith: r.placed_with,
        stateTrackingNumber: r.state_tracking_number,
        supplier: r.supplier,
        logisticsOrderNumber: r.logistics_order_number,
        eta: iso(r.eta),
        arrivedAt: iso(r.arrived_at),
        receivedAt: iso(r.received_at),
        cancelledAt: iso(r.cancelled_at),
        updatedAt: iso(r.updated_at),
        version: r.version,
        lines: lines.map((l) => ({
          lineNo: l.line_no,
          quantity: Number(l.quantity),
          unit: l.unit,
          kind: l.kind,
          type: l.type,
          description: l.description,
          eta: iso(l.eta),
          cost: l.cost === null ? null : Number(l.cost),
        })),
        history: steps.map((s) => ({
          step: s.step,
          fromStatus: s.from_status,
          toStatus: s.to_status,
          reason: s.reason,
          stateTrackingNumber: s.state_tracking_number,
          occurredAt: iso(s.occurred_at),
          actorKind: s.actor_kind,
          actorName: s.actor_account_id ? (who.get(s.actor_account_id) ?? null) : null,
        })),
      };
    }

    // ------------------------------------------------------------ reads (eoc.read)
    app.get<{ Params: P; Querystring: Q }>('/:tenant/resource-requests', async (request, reply) => {
      const who = await admit(request, reply, 'eoc.read');
      if (!who) return;
      const q = request.query;
      return withTenant(deps.db, { tenantId: who.tenantId }, async (trx) => {
        const ev = await eventOf(trx, who.tenantId, q['event']);
        if (!ev.event) return sendError(reply, 404, 'not_found', ev.error ?? 'Not found.');
        const since = q['since'] ? new Date(q['since']) : null;
        const ids = await trx
          .selectFrom('cg.resource_request')
          .select('id')
          .where('event_id', '=', ev.event.id)
          .where('status', '<>', 'draft')
          .$if(!!since && !Number.isNaN(since.getTime()), (x) => x.where('updated_at', '>', since!))
          .orderBy('request_number')
          .limit(500)
          .execute();
        const items = [];
        for (const { id } of ids) items.push(await requestView(trx, id));
        await audit(trx, who, request, {
          read: 'resource_requests',
          eventId: ev.event.id,
          count: items.length,
        });
        return { event: ev.event, asOf: now().toISOString(), items };
      });
    });

    app.get<{ Params: P & { id: string } }>(
      '/:tenant/resource-requests/:id',
      async (request, reply) => {
        const who = await admit(request, reply, 'eoc.read');
        if (!who) return;
        if (!UUID.test(request.params.id)) return sendError(reply, 404, 'not_found', 'Not found.');
        return withTenant(deps.db, { tenantId: who.tenantId }, async (trx) => {
          const r = await requestView(trx, request.params.id);
          if (!r || r.status === 'draft') return sendError(reply, 404, 'not_found', 'Not found.');
          await audit(trx, who, request, { read: 'resource_request', requestId: r.id });
          return r;
        });
      },
    );

    app.get<{ Params: P; Querystring: Q }>(
      '/:tenant/significant-events',
      async (request, reply) => {
        const who = await admit(request, reply, 'eoc.read');
        if (!who) return;
        const q = request.query;
        const p = period(q);
        if (!p) return sendError(reply, 400, 'bad_period', 'from must be before to (ISO 8601).');
        return withTenant(deps.db, { tenantId: who.tenantId }, async (trx) => {
          const ev = await eventOf(trx, who.tenantId, q['event']);
          if (!ev.event) return sendError(reply, 404, 'not_found', ev.error ?? 'Not found.');
          const rows = await trx
            .selectFrom('cg.significant_event')
            .select(['id', 'occurred_at', 'kind', 'summary', 'mission_id', 'team_id'])
            .where('event_id', '=', ev.event.id)
            .where('occurred_at', '>=', p.from)
            .where('occurred_at', '<', p.to)
            .orderBy('occurred_at')
            .limit(2000)
            .execute();
          await audit(trx, who, request, {
            read: 'significant_events',
            eventId: ev.event.id,
            count: rows.length,
          });
          return {
            event: ev.event,
            period: { from: p.from.toISOString(), to: p.to.toISOString() },
            asOf: now().toISOString(),
            items: rows.map((e) => ({
              id: e.id,
              occurredAt: iso(e.occurred_at),
              kind: e.kind,
              summary: e.summary,
              missionId: e.mission_id,
              teamId: e.team_id,
            })),
          };
        });
      },
    );

    app.get<{ Params: P; Querystring: Q }>('/:tenant/official-reports', async (request, reply) => {
      const who = await admit(request, reply, 'eoc.read');
      if (!who) return;
      const q = request.query;
      return withTenant(deps.db, { tenantId: who.tenantId }, async (trx) => {
        const ev = await eventOf(trx, who.tenantId, q['event']);
        if (!ev.event) return sendError(reply, 404, 'not_found', ev.error ?? 'Not found.');
        const rows = await trx
          .selectFrom('cg.official_report as r')
          .innerJoin('cg.official_report_snapshot as s', 's.report_id', 'r.id')
          .select([
            'r.id',
            'r.kind',
            'r.title',
            'r.sequence',
            'r.classification',
            's.issued_at',
            's.content_hash',
            's.content',
          ])
          .where('r.event_id', '=', ev.event.id)
          .where('r.state', 'in', ['issued', 'superseded'])
          .orderBy('s.issued_at', 'desc')
          .limit(100)
          .execute();
        await audit(trx, who, request, {
          read: 'official_reports',
          eventId: ev.event.id,
          count: rows.length,
        });
        return {
          event: ev.event,
          asOf: now().toISOString(),
          items: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            sequence: r.sequence,
            classification: r.classification,
            issuedAt: iso(r.issued_at),
            contentHash: r.content_hash,
            content: r.content,
          })),
        };
      });
    });

    app.get<{ Params: P; Querystring: Q }>('/:tenant/ics-forms', async (request, reply) => {
      const who = await admit(request, reply, 'eoc.read');
      if (!who) return;
      const q = request.query;
      return withTenant(deps.db, { tenantId: who.tenantId }, async (trx) => {
        const ev = await eventOf(trx, who.tenantId, q['event']);
        if (!ev.event) return sendError(reply, 404, 'not_found', ev.error ?? 'Not found.');
        const rows = await trx
          .selectFrom('cg.ics_form_issue')
          .selectAll()
          .where('event_id', '=', ev.event.id)
          .$if(!!q['form'], (x) => x.where('form', '=', q['form'] as 'ics_201'))
          .orderBy('issued_at', 'desc')
          .limit(200)
          .execute();
        await audit(trx, who, request, {
          read: 'ics_forms',
          eventId: ev.event.id,
          count: rows.length,
        });
        return {
          event: ev.event,
          asOf: now().toISOString(),
          items: rows.map((r) => ({
            id: r.id,
            form: r.form,
            number: ICS_FORMS[r.form].number,
            edition: r.edition,
            sequence: r.sequence,
            title: r.title,
            scope: r.scope,
            issuedAt: iso(r.issued_at),
            contentHash: r.content_hash,
            content: r.content,
            pdf: `/api/eoc/${request.params.tenant}/ics-forms/${r.id}/pdf`,
          })),
        };
      });
    });

    app.get<{ Params: P & { id: string } }>(
      '/:tenant/ics-forms/:id/pdf',
      async (request, reply) => {
        const who = await admit(request, reply, 'eoc.read');
        if (!who) return;
        if (!UUID.test(request.params.id)) return sendError(reply, 404, 'not_found', 'Not found.');
        const row = await withTenant(deps.db, { tenantId: who.tenantId }, async (trx) => {
          const r = await trx
            .selectFrom('cg.ics_form_issue')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (r)
            await audit(trx, who, request, {
              read: 'ics_form_pdf',
              issueId: r.id,
              form: r.form,
              sequence: r.sequence,
            });
          return r ?? null;
        });
        if (!row) return sendError(reply, 404, 'not_found', 'Not found.');
        const pdf = await renderPdf(
          icsPdf(row.content as unknown as IcsFormContent, {
            productName,
            contentHash: row.content_hash,
            sequence: row.sequence,
          }),
        );
        return reply
          .header('content-type', 'application/pdf')
          .header(
            'content-disposition',
            `attachment; filename="${row.form.replace('_', '-')}-${row.sequence}.pdf"`,
          )
          .send(pdf);
      },
    );

    // ------------------------------------------------------------ callbacks (resource_request.update)
    const callbackIn = z.object({
      stateTrackingNumber: z.string().trim().min(1).max(80).optional(),
      status: z.enum(['placed', 'en_route', 'received']).optional(),
      eta: z.iso.datetime().optional(),
      note: z.string().trim().max(500).optional(),
    });
    const NEXT: Record<string, string[]> = {
      placed: ['approved'],
      en_route: ['placed'],
      received: ['placed', 'en_route'],
    };

    app.post<{ Params: P & { id: string }; Body: unknown }>(
      '/:tenant/resource-requests/:id/state',
      async (request, reply) => {
        const who = await admit(request, reply, 'resource_request.update');
        if (!who) return;
        if (!UUID.test(request.params.id)) return sendError(reply, 404, 'not_found', 'Not found.');
        const parsed = callbackIn.safeParse(request.body ?? {});
        if (!parsed.success)
          return sendError(
            reply,
            400,
            'validation',
            parsed.error.issues.map((i) => i.message).join('; '),
          );
        const b = parsed.data;
        if (!b.stateTrackingNumber && !b.status && !b.eta)
          return sendError(reply, 400, 'validation', 'Give a tracking number, a status or an ETA.');
        try {
          return await withTenant(deps.db, { tenantId: who.tenantId }, async (trx) => {
            const r = await trx
              .selectFrom('cg.resource_request')
              .selectAll()
              .where('id', '=', request.params.id)
              .forUpdate()
              .executeTakeFirst();
            if (!r || r.status === 'draft') throw new ApiError(404, 'not_found', 'Not found.');
            if (['cancelled', 'received'].includes(r.status))
              throw new ApiError(
                409,
                'resource_request_state',
                `A ${r.status} request takes no update.`,
              );
            if (b.status && !NEXT[b.status]!.includes(r.status) && b.status !== r.status)
              throw new ApiError(
                409,
                'resource_request_state',
                `A ${r.status.replace('_', ' ')} request cannot be ${b.status.replace('_', ' ')}.`,
              );
            if (!b.status && r.status === 'submitted')
              throw new ApiError(
                409,
                'resource_request_state',
                'The request is not yet approved by the county.',
              );
            const at = now();
            const to = b.status && b.status !== r.status ? b.status : null;
            const updated = await trx
              .updateTable('cg.resource_request')
              .set({
                ...(b.stateTrackingNumber ? { state_tracking_number: b.stateTrackingNumber } : {}),
                ...(b.eta ? { eta: new Date(b.eta) } : {}),
                ...(to === 'placed'
                  ? { status: 'placed', placed_at: at, placed_with: 'state' }
                  : {}),
                ...(to === 'en_route' ? { status: 'en_route' } : {}),
                ...(to === 'received'
                  ? { status: 'received', arrived_at: at, received_at: at }
                  : {}),
                version: sql`version + 1`,
                updated_by: null,
              })
              .where('id', '=', r.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await trx
              .insertInto('cg.resource_request_step')
              .values({
                tenant_id: r.tenant_id,
                request_id: r.id,
                step: 'state_update',
                from_status: r.status,
                to_status: updated.status,
                reason: b.note ?? null,
                state_tracking_number: b.stateTrackingNumber ?? null,
                actor_account_id: null,
                actor_kind: 'api_key',
                created_by: null,
                updated_by: null,
              })
              .execute();
            await recordAudit(trx, {
              tenantId: who.tenantId,
              actorKind: 'public',
              actorAccountId: null,
              action: 'resource_request.state_update',
              targetType: 'resource_request',
              targetId: r.id,
              targetVersion: updated.version,
              requestId: request.id,
              reason: `state callback, key ${who.prefix}`,
              changes: {
                fields: [
                  { name: 'status', from: r.status, to: updated.status },
                  ...(b.stateTrackingNumber
                    ? [{ name: 'state_tracking_number', to: b.stateTrackingNumber }]
                    : []),
                ],
              },
            });
            await enqueueOutbox(
              trx,
              r.tenant_id,
              'resource_request.updated',
              { requestId: r.id, status: updated.status, by: 'state' },
              null,
            );
            return requestView(trx, r.id);
          });
        } catch (e) {
          if (e instanceof ApiError) return sendError(reply, e.status, e.code, e.message);
          throw e;
        }
      },
    );
  };
}
