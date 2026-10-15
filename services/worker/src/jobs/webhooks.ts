/**
 * Webhook deliveries (layer-6 task H; SCL-09).
 *
 * An event ("report issued", "export ready") is queued as one delivery per
 * approved webhook that asked for it, inside the transaction that made the
 * event true; the unique (webhook, event, subject) index means a retried
 * job never queues twice. A delivery is claimed before it is sent (a
 * two-minute lease, FOR UPDATE SKIP LOCKED), so two workers never send the
 * same one at once; it is signed with the webhook's secret (Standard
 * Webhooks) and sent once; a failure is retried with backoff up to eight
 * attempts, then marked failed. The payload names records, never people.
 */
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import {
  httpsWebhookSender,
  signWebhook,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffMs,
  type WebhookEventName,
  type WebhookSender,
} from '@cg/adapters';
import type { Database } from '@cg/db';
import { systemAudit } from '../system.ts';
import type { JobContext, Schedule } from './types.ts';

type Trx = Transaction<Database>;

const LEASE_MS = 120_000;

export interface ClaimedDelivery {
  id: string;
  tenant_id: string;
  webhook_id: string;
  event: WebhookEventName;
  payload: unknown;
  attempts: number;
}

/** Queues the event for every active webhook of the tenant that asked for it; returns the new delivery ids. */
export async function queueWebhookEvent(
  trx: Trx,
  tenantId: string,
  event: WebhookEventName,
  subjectId: string,
  data: Record<string, unknown>,
  now: Date = new Date(),
): Promise<string[]> {
  const hooks = await trx
    .selectFrom('cg.webhook')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .where(sql<boolean>`${event} = any(events)`)
    .execute();
  if (!hooks.length) return [];
  const rows = await trx
    .insertInto('cg.webhook_delivery')
    .values(
      hooks.map((h) => ({
        tenant_id: tenantId,
        webhook_id: h.id,
        event,
        subject_id: subjectId,
        payload: JSON.stringify({ type: event, timestamp: now.toISOString(), data }),
        next_attempt_at: now,
      })),
    )
    .onConflict((oc) => oc.columns(['webhook_id', 'event', 'subject_id']).doNothing())
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Claims due deliveries (the named ones, or any due) for one attempt: the
 * attempt is counted and the next one is pushed past the lease, so another
 * worker skips them while this one sends.
 */
export async function claimDeliveries(
  trx: Trx,
  opts: { ids?: string[]; limit?: number; now?: Date } = {},
): Promise<ClaimedDelivery[]> {
  const now = opts.now ?? new Date();
  if (opts.ids && !opts.ids.length) return [];
  const due = await trx
    .selectFrom('cg.webhook_delivery')
    .select('id')
    .where('status', '=', 'pending')
    .where('next_attempt_at', '<=', now)
    .$if(!!opts.ids, (q) => q.where('id', 'in', opts.ids!))
    .orderBy('next_attempt_at')
    .limit(opts.limit ?? 50)
    .forUpdate()
    .skipLocked()
    .execute();
  if (!due.length) return [];
  return (await trx
    .updateTable('cg.webhook_delivery')
    .set({
      attempts: sql`attempts + 1`,
      last_attempt_at: now,
      next_attempt_at: new Date(now.getTime() + LEASE_MS),
    })
    .where(
      'id',
      'in',
      due.map((d) => d.id),
    )
    .returning(['id', 'tenant_id', 'webhook_id', 'event', 'payload', 'attempts'])
    .execute()) as ClaimedDelivery[];
}

/** Sends claimed deliveries and records each outcome. */
export async function sendClaimed(
  ctx: JobContext,
  claimed: ClaimedDelivery[],
  send: WebhookSender = ctx.webhookSender ?? httpsWebhookSender(),
): Promise<void> {
  for (const d of claimed) {
    const now = ctx.now?.() ?? new Date();
    const hook = await ctx.db
      .selectFrom('cg.webhook')
      .select(['id', 'url', 'status', 'secret_enc'])
      .where('id', '=', d.webhook_id)
      .executeTakeFirst();
    let status: number | null = null;
    let error: string | null;
    if (!hook || hook.status !== 'active') {
      error = 'The webhook is no longer active.';
    } else {
      const body = JSON.stringify(d.payload);
      const secret = await ctx.crypto.decrypt(d.tenant_id, hook.secret_enc);
      const timestamp = Math.floor(now.getTime() / 1000);
      try {
        const result = await send({
          url: hook.url,
          headers: signWebhook(secret, d.id, timestamp, body),
          body,
        });
        status = result.status;
        error = result.error;
      } catch {
        error = 'Could not send.';
      }
    }
    const delivered = error === null;
    const final =
      delivered || !hook || hook.status !== 'active' || d.attempts >= WEBHOOK_MAX_ATTEMPTS;
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('cg.webhook_delivery')
        .set({
          status: delivered ? 'delivered' : final ? 'failed' : 'pending',
          last_status: status,
          last_error: error?.slice(0, 300) ?? null,
          delivered_at: delivered ? now : null,
          next_attempt_at: final ? null : new Date(now.getTime() + webhookBackoffMs(d.attempts)),
        })
        .where('id', '=', d.id)
        .execute();
      // The record of what left the system and where (SEC-18); never the body or secret.
      if (final)
        await systemAudit(trx, d.tenant_id, 'webhook.deliver', {
          action: delivered ? 'webhook.delivered' : 'webhook.failed',
          targetType: 'webhook_delivery',
          targetId: d.id,
          changes: { webhookId: d.webhook_id, event: d.event, attempts: d.attempts, status, error },
        });
    });
  }
}

/** Queues an event and sends it straight away; what fails is retried by the schedule. */
export async function publishWebhookEvent(
  ctx: JobContext,
  tenantId: string,
  event: WebhookEventName,
  subjectId: string,
  data: Record<string, unknown>,
  trx?: Trx,
): Promise<ClaimedDelivery[]> {
  const run = async (t: Trx) => {
    const ids = await queueWebhookEvent(t, tenantId, event, subjectId, data);
    return claimDeliveries(t, { ids });
  };
  return trx ? run(trx) : ctx.db.transaction().execute(run);
}

/** Every minute: deliveries due a first try or a retry, any tenant. */
export async function deliverDueWebhooks(ctx: JobContext, send?: WebhookSender): Promise<number> {
  let total = 0;
  for (let round = 0; round < 10; round++) {
    const claimed = await ctx.db
      .transaction()
      .execute((trx) => claimDeliveries(trx, { limit: 50 }));
    if (!claimed.length) break;
    await sendClaimed(ctx, claimed, send);
    total += claimed.length;
  }
  return total;
}

export const webhookSchedule: Schedule = {
  name: 'webhook-deliveries',
  everyMs: 60_000,
  run: async (ctx) => {
    await deliverDueWebhooks(ctx);
  },
};
