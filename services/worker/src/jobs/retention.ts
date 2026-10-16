/**
 * Retention sweeps by data category (SEC-13). Each tenant sets how long each
 * category is kept (cg.retention_policy; 7 years when it sets nothing, with
 * the shorter defaults the product ships for one-time codes, drafts, abuse
 * signals, sessions, reminders, child records, badges and contacts). Daily,
 * for each category below, rows whose clock started longer ago than that are
 * deleted, a batch at a time:
 *
 * - only finished rows: an open reminder, a child still checked in, an active
 *   contact, a badge still valid or an unresolved safety alert never expire;
 * - a legal hold wins: on the category, on the row (targetType and targetId),
 *   or on the event the row belongs to;
 * - rows another record still points at stay until that record goes, and the
 *   row's own history (reminder events, badge events) goes with it;
 * - every deletion is counted in cg.deletion_log and audited, never listed.
 *
 * Field records are kept for the period after their event closes: a crew's
 * records of an event still open never expire, and a legal hold on the
 * mission or report a field record belongs to keeps it too.
 *
 * Position trails, command conversations, scribe audio and reference data
 * have their own sweeps; CJIS data stays in the enclave under its own rules.
 * Not swept here yet: the core records (reports, needs, missions, photos and
 * their free text), whose deletion runs across many linked tables and object
 * storage, and the roster (people, teams, credentials, devices, stock), which
 * outlives events.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

export interface Sweep {
  /** cg.retention_policy.data_category */
  category: string;
  /** Table in schema cg; its key is `id`. */
  table: string;
  /** When a row's clock starts (SQL over its columns). */
  clock: string;
  /** Only rows for which this holds are finished and can expire. */
  finished?: string;
  /** The event a row belongs to, for event-wide holds (SQL over its columns). */
  eventOf?: string;
  /** Row history that goes with the row. */
  children?: { table: string; column: string }[];
  /** Other records that, while they point at a row, keep it. */
  keptBy?: { table: string; column: string }[];
  /** Records a row belongs to: a legal hold on one of them keeps the row (SQL over its columns). */
  heldWith?: { type: string; id: string }[];
  /** A row naming its related record by type and id columns: a hold on that record keeps it. */
  heldVia?: { typeColumn: string; idColumn: string };
}

/** When the event a field record belongs to closed; null (never expires) while it is open. */
const eventClosed = (eventId: string) =>
  `(select e.closed_at from cg.event e where e.id = ${eventId})`;
/** Field records of one event, kept for the period after it closes. */
const fieldRecord = (table: string, extra: Partial<Sweep> = {}): Sweep => ({
  category: 'field_records',
  table,
  clock: eventClosed('t.event_id'),
  eventOf: 't.event_id',
  ...extra,
});
const MISSION_EVENT = '(select m.event_id from cg.mission m where m.id = t.mission_id)';
const SITE_EVENT = '(select s.event_id from cg.site s where s.id = t.site_id)';

/** The sweeps, in an order that lets children go before what they point at. */
export const SWEEPS: readonly Sweep[] = [
  { category: 'otp', table: 'otp_challenge', clock: 'created_at' },
  {
    category: 'otp',
    table: 'facility_update_link',
    clock: 'coalesce(used_at, expires_at)',
    finished: 'used_at is not null or expires_at < now()',
  },
  { category: 'drafts', table: 'draft', clock: 'created_at' },
  { category: 'abuse_signals', table: 'abuse_signal', clock: 'created_at' },
  {
    category: 'sessions',
    table: 'intake_session',
    clock: 'coalesce(last_inbound_at, updated_at)',
    eventOf: 'event_id',
  },
  { category: 'sessions', table: 'client_command', clock: 'received_at' },
  {
    category: 'reminders',
    table: 'reminder',
    clock: 'coalesce(completed_at, canceled_at)',
    finished: "state in ('completed', 'canceled')",
    eventOf: 'event_id',
    children: [{ table: 'reminder_event', column: 'reminder_id' }],
    keptBy: [{ table: 'canvass_visit', column: 'reminder_id' }],
  },
  {
    category: 'reminders',
    table: 'notice_log',
    clock: 'coalesce(completed_at, sent_at, due_at)',
    finished: "state in ('completed', 'canceled')",
  },
  {
    category: 'child_records',
    table: 'child_check_in',
    clock: 'checked_out_at',
    finished: 'checked_out_at is not null',
    eventOf: '(select s.event_id from cg.site s where s.id = site_id)',
  },
  {
    category: 'badges',
    table: 'badge',
    clock: 'coalesce(revoked_at, valid_to, updated_at)',
    finished: "state in ('revoked', 'expired', 'replaced') or valid_to < now()",
    eventOf: 'event_id',
    children: [{ table: 'badge_event', column: 'badge_id' }],
    keptBy: [
      { table: 'volunteer_registration', column: 'badge_id' },
      { table: 'badge', column: 'replaces_badge_id' },
    ],
  },
  {
    category: 'contacts',
    table: 'partner_contact',
    clock: 'updated_at',
    finished: 'active = false',
    keptBy: [
      { table: 'site', column: 'lead_contact_id' },
      { table: 'partner_contact', column: 'backup_of' },
    ],
  },
  // The 7-year categories (SEC-13 default) with records that stand alone.
  {
    category: 'comms',
    table: 'field_message',
    clock: 'coalesce(sent_at, created_at)',
    eventOf: 'event_id',
    children: [{ table: 'field_message_receipt', column: 'message_id' }],
  },
  { category: 'comms', table: 'comms_log', clock: 'entry_at', eventOf: 'event_id' },
  {
    category: 'referrals',
    table: 'referral',
    clock: 'coalesce(closed_at, updated_at)',
    finished: "status in ('declined', 'done')",
    eventOf:
      'coalesce((select n.event_id from cg.need n where n.id = need_id), (select r.event_id from cg.report r where r.id = report_id))',
  },
  {
    category: 'sharing',
    table: 'share_grant',
    clock: 'revoked_at',
    finished: 'revoked_at is not null',
    eventOf:
      'coalesce((select n.event_id from cg.need n where n.id = need_id), (select r.event_id from cg.report r where r.id = report_id))',
    keptBy: [{ table: 'referral', column: 'share_grant_id' }],
  },
  {
    category: 'publications',
    table: 'publication',
    clock: 'coalesce(unpublished_at, approved_at)',
    // A publication still in force (not withdrawn, nothing newer for its subject) stays.
    finished:
      'unpublished_at is not null or exists (select 1 from cg.publication p2 where p2.subject_kind = t.subject_kind and p2.subject_id = t.subject_id and p2.approved_at > t.approved_at)',
  },
  {
    category: 'safety',
    table: 'safety_alert',
    clock: 'resolved_at',
    finished: "state in ('resolved', 'false_alarm') and resolved_at is not null",
    eventOf: 'event_id',
  },
  // Field records (SEC-13), after the safety alerts and communications that point at
  // check-ins and assignments, and leaves before what they point at.
  fieldRecord('shift_handover'),
  fieldRecord('service_log', { heldWith: [{ type: 'mission', id: 't.mission_id' }] }),
  fieldRecord('search_mark', { heldWith: [{ type: 'mission', id: 't.mission_id' }] }),
  fieldRecord('placard', { heldWith: [{ type: 'report', id: 't.report_id' }] }),
  fieldRecord('road_status'),
  fieldRecord('debris_ticket'),
  fieldRecord('inspection'),
  fieldRecord('pet_intake'),
  fieldRecord('interpreter_request', { heldWith: [{ type: 'mission', id: 't.mission_id' }] }),
  fieldRecord('canvass_visit', {
    heldWith: [
      { type: 'mission', id: 't.mission_id' },
      { type: 'report', id: 't.report_id' },
    ],
  }),
  fieldRecord('field_assessment', {
    keptBy: [{ table: 'field_assessment', column: 'duplicate_of' }],
    heldWith: [
      { type: 'mission', id: 't.mission_id' },
      { type: 'report', id: 't.report_id' },
    ],
  }),
  {
    category: 'field_records',
    table: 'assignment',
    clock: `(select e.closed_at from cg.mission m join cg.event e on e.id = m.event_id where m.id = t.mission_id)`,
    eventOf: MISSION_EVENT,
    children: [{ table: 'assignment_event', column: 'assignment_id' }],
    keptBy: [
      { table: 'safety_alert', column: 'assignment_id' },
      { table: 'field_assessment', column: 'assignment_id' },
    ],
    heldWith: [{ type: 'mission', id: 't.mission_id' }],
  },
  fieldRecord('check_in', {
    // The team's status reports made under a check-in are its history.
    children: [{ table: 'team_status', column: 'check_in_id' }],
    keptBy: [
      { table: 'safety_alert', column: 'check_in_id' },
      { table: 'comms_log', column: 'check_in_id' },
      { table: 'shift_handover', column: 'check_in_id' },
    ],
  }),
  // FL-04: a conversation note has no event; it is kept for the period after it was confirmed
  // (or the session was discarded or expired), never while audio is still stored.
  {
    category: 'field_records',
    table: 'scribe_session',
    clock: 'coalesce(t.confirmed_at, t.updated_at)',
    finished: "t.state in ('confirmed', 'discarded', 'expired') and t.audio_object_key is null",
    heldVia: { typeColumn: 'related_type', idColumn: 'related_id' },
  },
  {
    category: 'field_records',
    table: 'site_walkthrough',
    clock: `(select e.closed_at from cg.site s join cg.event e on e.id = s.event_id where s.id = t.site_id)`,
    eventOf: SITE_EVENT,
    heldWith: [{ type: 'site', id: 't.site_id' }],
  },
];

/** Rows per table per tenant per run; the next day takes the rest. */
export const BATCH = 5000;

interface Holds {
  categories: Set<string>;
  records: Map<string, Set<string>>;
  events: string[];
}

async function activeHolds(trx: Transaction<Database>, tenantId: string): Promise<Holds> {
  const rows = await trx
    .selectFrom('cg.legal_hold')
    .select('scope')
    .where('tenant_id', '=', tenantId)
    .where('released_at', 'is', null)
    .execute();
  const holds: Holds = { categories: new Set(), records: new Map(), events: [] };
  const uuid = /^[0-9a-f-]{36}$/i;
  for (const h of rows) {
    const sc = (h.scope ?? {}) as Record<string, unknown>;
    const category = typeof sc['dataCategory'] === 'string' ? sc['dataCategory'] : null;
    const type = typeof sc['targetType'] === 'string' ? sc['targetType'] : null;
    const id = typeof sc['targetId'] === 'string' ? sc['targetId'] : null;
    const event = typeof sc['eventId'] === 'string' ? sc['eventId'] : null;
    if (category && !type && !id && !event) holds.categories.add(category);
    // A hold on a whole kind of record, without an id, keeps the whole kind.
    if (type && !id) holds.categories.add(`table:${type}`);
    if (type && id && uuid.test(id)) {
      const set = holds.records.get(type) ?? new Set();
      set.add(id);
      holds.records.set(type, set);
    }
    if (event && uuid.test(event)) holds.events.push(event);
  }
  return holds;
}

/** Days the tenant keeps each category, for those kept for a set duration. */
async function keepDays(trx: Transaction<Database>, tenantId: string) {
  const rows = await sql<{ data_category: string; days: string }>`
    select data_category, (extract(epoch from keep_for) / 86400)::text as days
    from cg.retention_policy
    where tenant_id = ${tenantId} and rule = 'duration' and keep_for is not null`.execute(trx);
  return new Map(rows.rows.map((r) => [r.data_category, Number(r.days)]));
}

export async function sweepOne(
  trx: Transaction<Database>,
  tenantId: string,
  sweep: Sweep,
  cutoff: Date,
  holds: Holds,
): Promise<{ count: number; oldest: Date | null; newest: Date | null }> {
  const none = { count: 0, oldest: null, newest: null };
  if (holds.categories.has(sweep.category) || holds.categories.has(`table:${sweep.table}`))
    return none;
  const heldIds = [...(holds.records.get(sweep.table) ?? [])];
  const t = sql.raw(`cg.${sweep.table}`);
  const clock = sql.raw(`(${sweep.clock})`);
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`${clock} < ${cutoff}`,
    ...(sweep.finished ? [sql`(${sql.raw(sweep.finished)})`] : []),
    ...(heldIds.length ? [sql`not (t.id = any(${heldIds}::uuid[]))`] : []),
    ...(sweep.eventOf && holds.events.length
      ? [
          sql`(${sql.raw(sweep.eventOf)} is null or not (${sql.raw(sweep.eventOf)} = any(${holds.events}::uuid[])))`,
        ]
      : []),
    ...(sweep.keptBy ?? []).map(
      (k) =>
        sql`not exists (select 1 from ${sql.raw(`cg.${k.table}`)} r where r.${sql.raw(k.column)} = t.id)`,
    ),
    ...(sweep.heldVia
      ? [...holds.records.entries()].map(
          ([type, held]) =>
            sql`not (${sql.ref(`t.${sweep.heldVia!.typeColumn}`)} is not distinct from ${type} and ${sql.ref(`t.${sweep.heldVia!.idColumn}`)} = any(${[...held]}::uuid[]))`,
        )
      : []),
    ...(sweep.heldWith ?? []).flatMap((p) => {
      const held = [...(holds.records.get(p.type) ?? [])];
      return held.length
        ? [sql`(${sql.raw(p.id)} is null or not (${sql.raw(p.id)} = any(${held}::uuid[])))`]
        : [];
    }),
  ];
  const due = await sql<{ id: string; clock: Date }>`
    select t.id, ${clock} as clock from ${t} t
    where ${sql.join(conditions, sql` and `)}
    order by ${clock}
    limit ${BATCH}`.execute(trx);
  if (due.rows.length === 0) return none;
  const ids = due.rows.map((r) => r.id);
  for (const c of sweep.children ?? [])
    await sql`delete from ${sql.raw(`cg.${c.table}`)} where ${sql.raw(c.column)} = any(${ids}::uuid[])`.execute(
      trx,
    );
  const gone = await sql<{ id: string }>`
    delete from ${t} where id = any(${ids}::uuid[]) returning id`.execute(trx);
  const times = due.rows.map((r) => new Date(r.clock).getTime());
  return {
    count: gone.rows.length,
    oldest: new Date(Math.min(...times)),
    newest: new Date(Math.max(...times)),
  };
}

/**
 * SEC-13: the field change feed is kept for the `sessions` period, then pruned a batch at a time.
 * The highest sequence removed is kept per tenant, so a phone whose cursor is below it is told to
 * download its area again rather than silently missing changes (routes/field-sync.ts).
 */
export async function pruneChangeFeed(
  trx: Transaction<Database>,
  tenantId: string,
  cutoff: Date,
  holds: Holds,
): Promise<{ count: number; oldest: Date | null; newest: Date | null }> {
  const none = { count: 0, oldest: null, newest: null };
  if (holds.categories.has('sessions') || holds.categories.has('table:change_feed')) return none;
  const gone = await sql<{ seq: string; created_at: Date }>`
    delete from cg.change_feed
    where seq in (
      select seq from cg.change_feed
      where tenant_id = ${tenantId} and created_at < ${cutoff}
      order by seq
      limit ${BATCH})
    returning seq, created_at`.execute(trx);
  if (gone.rows.length === 0) return none;
  const through = gone.rows.reduce((m, r) => (BigInt(r.seq) > m ? BigInt(r.seq) : m), 0n);
  await sql`
    insert into cg.change_feed_pruned (tenant_id, through_seq, pruned_at)
    values (${tenantId}, ${through.toString()}, now())
    on conflict (tenant_id) do update
      set through_seq = greatest(cg.change_feed_pruned.through_seq, excluded.through_seq),
          pruned_at = now()`.execute(trx);
  const times = gone.rows.map((r) => new Date(r.created_at).getTime());
  return {
    count: gone.rows.length,
    oldest: new Date(Math.min(...times)),
    newest: new Date(Math.max(...times)),
  };
}

/** Daily: every sweep for every tenant; returns the rows deleted. */
export async function sweepRetention(ctx: JobContext): Promise<number> {
  const now = ctx.now?.() ?? new Date();
  const executionId = randomUUID();
  let total = 0;
  for (const tenantId of await allTenantIds(ctx.db)) {
    total += await asSystem(ctx.db, tenantId, async (trx) => {
      const days = await keepDays(trx, tenantId);
      const holds = await activeHolds(trx, tenantId);
      let n = 0;
      // The change feed has no id column; it is pruned by sequence (pruneChangeFeed).
      const feed: Sweep = { category: 'sessions', table: 'change_feed', clock: 'created_at' };
      for (const sweep of [...SWEEPS, feed]) {
        const d = days.get(sweep.category);
        if (d === undefined || !Number.isFinite(d) || d <= 0) continue;
        const cutoff = new Date(now.getTime() - d * 86_400_000);
        const r =
          sweep === feed
            ? await pruneChangeFeed(trx, tenantId, cutoff, holds)
            : await sweepOne(trx, tenantId, sweep, cutoff, holds);
        if (r.count === 0) continue;
        n += r.count;
        await trx
          .insertInto('cg.deletion_log')
          .values({
            tenant_id: tenantId,
            data_category: sweep.category,
            target_type: sweep.table,
            deleted_count: r.count,
            oldest: r.oldest,
            newest: r.newest,
            execution_id: executionId,
          })
          .execute();
        await systemAudit(trx, tenantId, 'retention.sweep', {
          action: 'retention.delete',
          targetType: sweep.table,
          targetId: `${r.count} rows`,
          executionId,
        });
      }
      return n;
    });
  }
  if (total) ctx.log.info({ total }, 'retention sweep deleted expired rows');
  return total;
}
