/**
 * Enclave system jobs, run by `cjis-worker` as the `cjis_job` role (SEC-12,
 * SEC-13, ADR-0037). Each run is safe to repeat and to run on two instances
 * at once (a transaction-scoped advisory lock per job):
 * - identity: applies the identity outbox to the enclave's Keycloak
 *   (onboarding with the one-time password, suspension, reactivation) and
 *   clears the password from the database once the identity exists;
 * - sign-in events: copies Keycloak's sign-in, failure, lockout and
 *   credential events into the enclave audit (AU-2), each against the
 *   person's agency;
 * - retention: deletes closed records older than the agency's period unless
 *   a legal hold covers them, and logs each batch (SEC-13);
 * - inactivity: suspends accounts unused for 90 days (AC-2).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { CjisDatabase } from '@cg/cjis-db';
import type { FieldCrypto } from '@cg/crypto';
import { recordEnclaveAudit } from './audit.ts';
import type { IdpEvent } from './idp/keycloak.ts';

export interface IdentityAdmin {
  createUser(
    realm: string,
    user: { email: string; displayName: string; temporaryPassword: string },
  ): Promise<string>;
  setEnabled(realm: string, userId: string, enabled: boolean): Promise<void>;
  events(realm: string, sinceMs: number, max?: number): Promise<IdpEvent[]>;
}

export interface JobDeps {
  db: Kysely<CjisDatabase>;
  crypto: FieldCrypto;
  idp: IdentityAdmin;
  realm: string;
  now?: () => Date;
}

const MAX_ATTEMPTS = 10;
const INACTIVE_DAYS = 90;

async function locked<T>(
  db: Kysely<CjisDatabase>,
  name: string,
  fn: (trx: Transaction<CjisDatabase>) => Promise<T>,
): Promise<T | null> {
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ ok: boolean }>`
      select pg_try_advisory_xact_lock(hashtext(${`cjis.job:${name}`})) as ok`.execute(trx);
    if (!rows[0]?.ok) return null;
    return fn(trx);
  });
}

export async function runIdentityOutbox(deps: JobDeps): Promise<{ done: number; failed: number }> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .selectFrom('cjis.identity_outbox as o')
    .innerJoin('cjis.person as p', 'p.id', 'o.person_id')
    .select([
      'o.id',
      'o.agency_id',
      'o.person_id',
      'o.kind',
      'o.payload_enc',
      'o.attempts',
      'p.idp_subject',
    ])
    .where('o.status', '=', 'pending')
    .where('o.next_attempt_at', '<=', now)
    .orderBy('o.created_at')
    .limit(20)
    .execute();
  let done = 0;
  let failed = 0;
  for (const item of due) {
    try {
      if (item.kind === 'create_user') {
        if (!item.payload_enc) throw new Error('payload missing');
        const payload = JSON.parse(await deps.crypto.decrypt(item.agency_id, item.payload_enc)) as {
          email: string;
          displayName: string;
          temporaryPassword: string;
        };
        const subject = await deps.idp.createUser(deps.realm, payload);
        await deps.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('cjis.person')
            .set({ idp_subject: subject, identity_state: 'created' })
            .where('id', '=', item.person_id)
            .execute();
          // The one-time password leaves the database once the identity exists.
          await trx
            .updateTable('cjis.identity_outbox')
            .set({ status: 'done', done_at: now, payload_enc: null, last_error: null })
            .where('id', '=', item.id)
            .execute();
          await recordEnclaveAudit(trx, {
            agencyId: item.agency_id,
            actorKind: 'system',
            action: 'identity.create',
            targetType: 'person',
            targetId: item.person_id,
            outcome: 'success',
          });
        });
      } else {
        if (!item.idp_subject) throw new Error('no identity to change');
        await deps.idp.setEnabled(deps.realm, item.idp_subject, item.kind === 'enable_user');
        await deps.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('cjis.identity_outbox')
            .set({ status: 'done', done_at: now, last_error: null })
            .where('id', '=', item.id)
            .execute();
          await recordEnclaveAudit(trx, {
            agencyId: item.agency_id,
            actorKind: 'system',
            action: item.kind === 'enable_user' ? 'identity.enable' : 'identity.disable',
            targetType: 'person',
            targetId: item.person_id,
            outcome: 'success',
          });
        });
      }
      done++;
    } catch (err) {
      const attempts = item.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      // Never store the error text of a failed call that might echo a payload: name only.
      const reason =
        err instanceof Error ? err.message.replace(/[^\w :./…-]/g, '').slice(0, 160) : 'error';
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('cjis.identity_outbox')
          .set({
            attempts,
            last_error: reason,
            status: giveUp ? 'failed' : 'pending',
            next_attempt_at: new Date(now.getTime() + Math.min(60, 2 ** attempts) * 1000),
            ...(giveUp ? { payload_enc: null } : {}),
          })
          .where('id', '=', item.id)
          .execute();
        if (giveUp && item.kind === 'create_user')
          await trx
            .updateTable('cjis.person')
            .set({ identity_state: 'failed' })
            .where('id', '=', item.person_id)
            .execute();
        await recordEnclaveAudit(trx, {
          agencyId: item.agency_id,
          actorKind: 'system',
          action: `identity.${item.kind}`,
          targetType: 'person',
          targetId: item.person_id,
          outcome: 'failure',
          reason: `${reason}${giveUp ? ' (gave up)' : ''}`,
        });
      });
      failed++;
    }
  }
  return { done, failed };
}

function outcomeOf(type: string): 'success' | 'failure' | 'denied' {
  if (type.startsWith('USER_DISABLED_BY')) return 'denied';
  return type.endsWith('_ERROR') ? 'failure' : 'success';
}

export async function copySignInEvents(deps: JobDeps): Promise<number> {
  const result = await locked(deps.db, 'idp-events', async (trx) => {
    await trx
      .insertInto('cjis.idp_event_cursor')
      .values({ id: 1, last_time_ms: 0 })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    const cursor = await trx
      .selectFrom('cjis.idp_event_cursor')
      .select('last_time_ms')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const since = Number(cursor.last_time_ms);
    const events = await deps.idp.events(deps.realm, since);
    let newest = since;
    for (const e of events) {
      const person = e.userId
        ? await trx
            .selectFrom('cjis.person')
            .select(['id', 'agency_id'])
            .where('idp_subject', '=', e.userId)
            .executeTakeFirst()
        : undefined;
      await recordEnclaveAudit(trx, {
        agencyId: person?.agency_id ?? null,
        actorKind: person ? 'person' : 'identity_provider',
        actorPersonId: person?.id ?? null,
        action: `identity.${e.type.toLowerCase()}`,
        targetType: 'session',
        targetId: e.sessionId ?? '-',
        outcome: outcomeOf(e.type),
        reason: e.error ?? (e.clientId ? `client ${e.clientId}` : null),
        sourceIp: e.ipAddress ?? null,
        occurredAt: new Date(e.time),
      });
      if (person && e.type === 'LOGIN')
        await trx
          .updateTable('cjis.person')
          .set({ last_seen_at: new Date(e.time) })
          .where('id', '=', person.id)
          .execute();
      newest = Math.max(newest, e.time);
    }
    if (newest > since)
      await trx
        .updateTable('cjis.idp_event_cursor')
        .set({ last_time_ms: newest, updated_at: new Date() })
        .where('id', '=', 1)
        .execute();
    return events.length;
  });
  return result ?? 0;
}

export async function sweepRetention(
  deps: Pick<JobDeps, 'db' | 'now'>,
): Promise<{ deleted: number; held: number }> {
  const now = deps.now?.() ?? new Date();
  const result = await locked(deps.db, 'retention', async (trx) => {
    let deleted = 0;
    let held = 0;
    const policies = await trx
      .selectFrom('cjis.retention_policy')
      .select(['agency_id', 'keep_days'])
      .where('category', '=', 'records')
      .execute();
    for (const p of policies) {
      const cutoff = new Date(now.getTime() - p.keep_days * 24 * 3600 * 1000);
      const expired = await trx
        .selectFrom('cjis.record as r')
        .select(['r.id'])
        .select((eb) =>
          eb
            .exists(
              eb
                .selectFrom('cjis.legal_hold as h')
                .select('h.id')
                .where('h.agency_id', '=', p.agency_id)
                .where('h.released_at', 'is', null)
                .where((w) =>
                  w.or([w('h.record_id', 'is', null), w('h.record_id', '=', w.ref('r.id'))]),
                ),
            )
            .as('on_hold'),
        )
        .where('r.agency_id', '=', p.agency_id)
        .where('r.state', '=', 'closed')
        .where('r.closed_at', '<', cutoff)
        .execute();
      const free = expired.filter((r) => !r.on_hold).map((r) => r.id);
      const onHold = expired.length - free.length;
      if (free.length > 0) await trx.deleteFrom('cjis.record').where('id', 'in', free).execute();
      if (expired.length > 0) {
        await trx
          .insertInto('cjis.deletion_log')
          .values({
            agency_id: p.agency_id,
            category: 'records',
            cutoff,
            deleted: free.length,
            held: onHold,
          })
          .execute();
        await recordEnclaveAudit(trx, {
          agencyId: p.agency_id,
          actorKind: 'system',
          action: 'retention.delete',
          targetType: 'record',
          targetId: '*',
          outcome: 'success',
          reason: `${free.length} closed records past ${p.keep_days} days deleted; ${onHold} kept under legal hold`,
        });
      }
      deleted += free.length;
      held += onHold;
    }
    await trx.deleteFrom('cjis.idempotency_key').where('expires_at', '<', now).execute();
    return { deleted, held };
  });
  return result ?? { deleted: 0, held: 0 };
}

export async function suspendInactive(deps: Pick<JobDeps, 'db' | 'now'>): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - INACTIVE_DAYS * 24 * 3600 * 1000);
  const result = await locked(deps.db, 'inactivity', async (trx) => {
    const stale = await trx
      .selectFrom('cjis.person')
      .select(['id', 'agency_id', 'identity_state'])
      .where('status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('last_seen_at', '<', cutoff),
          eb.and([eb('last_seen_at', 'is', null), eb('created_at', '<', cutoff)]),
        ]),
      )
      .execute();
    for (const p of stale) {
      await trx
        .updateTable('cjis.person')
        .set({ status: 'suspended', status_reason: `No sign-in for ${INACTIVE_DAYS} days (AC-2)` })
        .where('id', '=', p.id)
        .execute();
      if (p.identity_state === 'created')
        await trx
          .insertInto('cjis.identity_outbox')
          .values({ agency_id: p.agency_id, person_id: p.id, kind: 'disable_user' })
          .execute();
      await recordEnclaveAudit(trx, {
        agencyId: p.agency_id,
        actorKind: 'system',
        action: 'account.suspend',
        targetType: 'person',
        targetId: p.id,
        outcome: 'success',
        reason: `inactive ${INACTIVE_DAYS} days (AC-2)`,
      });
    }
    return stale.length;
  });
  return result ?? 0;
}
