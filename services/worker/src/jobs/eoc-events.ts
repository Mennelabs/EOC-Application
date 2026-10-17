/**
 * EOC record webhooks (CON-13, SCL-09; layer-8 plan §7): when a resource
 * request is submitted or changes, a significant event is logged, or an ICS
 * form is issued, every webhook of the tenant that asked for the event gets
 * a signed delivery (Standard Webhooks, retried by the schedule). Payloads
 * carry identifiers, numbers, statuses and summaries: never a resident.
 */
import { asSystem } from '../system.ts';
import type { TopicHandler } from './types.ts';
import { publishWebhookEvent } from './webhooks.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const resourceRequestEvent: TopicHandler = async (ctx, msg) => {
  const requestId = str(msg.payload['requestId']);
  if (!requestId) return;
  const event =
    msg.topic === 'resource_request.submitted'
      ? 'resource_request.submitted'
      : 'resource_request.updated';
  const r = await asSystem(ctx.db, msg.tenantId, (trx) =>
    trx
      .selectFrom('cg.resource_request')
      .select([
        'id',
        'event_id',
        'request_number',
        'status',
        'priority',
        'state_tracking_number',
        'eta',
        'updated_at',
        'version',
      ])
      .where('id', '=', requestId)
      .executeTakeFirst(),
  );
  if (!r) return;
  await publishWebhookEvent(ctx, msg.tenantId, event, `${r.id}:${r.version}`, {
    requestId: r.id,
    eventId: r.event_id,
    requestNumber: r.request_number,
    status: r.status,
    priority: r.priority,
    stateTrackingNumber: r.state_tracking_number,
    eta: r.eta?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
    by: str(msg.payload['by']) ?? 'county',
  }).catch((err: unknown) =>
    ctx.log.warn({ err, requestId }, 'webhook delivery deferred to the schedule'),
  );
};

export const significantEventCreated: TopicHandler = async (ctx, msg) => {
  const id = str(msg.payload['significantEventId']);
  if (!id) return;
  const e = await asSystem(ctx.db, msg.tenantId, (trx) =>
    trx
      .selectFrom('cg.significant_event')
      .select(['id', 'event_id', 'occurred_at', 'kind', 'summary', 'mission_id', 'team_id'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (!e) return;
  await publishWebhookEvent(ctx, msg.tenantId, 'significant_event.created', e.id, {
    significantEventId: e.id,
    eventId: e.event_id,
    occurredAt: e.occurred_at.toISOString(),
    kind: e.kind,
    summary: e.summary,
    missionId: e.mission_id,
    teamId: e.team_id,
  }).catch((err: unknown) =>
    ctx.log.warn({ err, id }, 'webhook delivery deferred to the schedule'),
  );
};

export const icsFormIssued: TopicHandler = async (ctx, msg) => {
  const id = str(msg.payload['issueId']);
  if (!id) return;
  const f = await asSystem(ctx.db, msg.tenantId, (trx) =>
    trx
      .selectFrom('cg.ics_form_issue')
      .select([
        'id',
        'event_id',
        'form',
        'edition',
        'sequence',
        'title',
        'content_hash',
        'issued_at',
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (!f) return;
  await publishWebhookEvent(ctx, msg.tenantId, 'ics_form.issued', f.id, {
    issueId: f.id,
    eventId: f.event_id,
    form: f.form,
    edition: f.edition,
    sequence: f.sequence,
    title: f.title,
    contentHash: f.content_hash,
    issuedAt: f.issued_at.toISOString(),
  }).catch((err: unknown) =>
    ctx.log.warn({ err, id }, 'webhook delivery deferred to the schedule'),
  );
};
