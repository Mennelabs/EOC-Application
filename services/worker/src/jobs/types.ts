/**
 * Worker job model (ADR-0007). Two kinds of work:
 *  - outbox topics: written by the API inside business transactions, relayed
 *    to the queue by the worker, consumed by a handler keyed on the topic;
 *  - schedules: periodic system jobs (anchors, expiry, retention housekeeping).
 * Every handler runs as the cg_worker database role and records what it did
 * in the audit log as actor_kind 'system' (SEC-18).
 */
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '@cg/db';
import type { KeycloakAdmin } from '../idp/keycloak.ts';
import type { Mailer } from '../mail.ts';

export interface JobContext {
  db: Kysely<Database>;
  log: Logger;
  idp: KeycloakAdmin;
  mail: Mailer;
  /** Public URLs the worker needs to put into realms and emails. */
  urls: { gatewayPublic: string; idpPublic: string; idpInternal: string };
  objects: { putAnchor(key: string, body: string): Promise<void> } | null;
  devDirectGrant: boolean;
}

export interface OutboxMessage {
  id: number;
  tenantId: string;
  topic: string;
  payload: Record<string, unknown>;
  executionId: string | null;
}

export type TopicHandler = (ctx: JobContext, msg: OutboxMessage) => Promise<void>;

export interface Schedule {
  name: string;
  everyMs: number;
  run(ctx: JobContext): Promise<void>;
}
