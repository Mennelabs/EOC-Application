/**
 * Worker job model (ADR-0007). Two kinds of work:
 *  - outbox topics: written by the API inside business transactions, relayed
 *    to the queue by the worker, consumed by a handler keyed on the topic;
 *  - schedules: periodic system jobs (anchors, expiry, retention housekeeping,
 *    the stored-submission sweep, reference-code pool top-up).
 * Every handler runs as the cg_worker database role and records what it did
 * in the audit log as actor_kind 'system' (SEC-18).
 */
import type { Kysely, Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { SmsSender } from '@cg/adapters';
import type { AiProvider } from '@cg/ai';
import type { FieldCrypto } from '@cg/crypto';
import type { Database } from '@cg/db';
import type { QuestionGraph } from '@cg/intake';
import type { KeycloakAdmin } from '../idp/keycloak.ts';
import type { Mailer } from '../mail.ts';

/** Object storage as the jobs use it (S3 API; MinIO locally, ADR-0010). */
export interface ObjectStore {
  get(key: string): Promise<{ body: Buffer; contentType: string | null }>;
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  putAnchor(key: string, body: string): Promise<void>;
}

export interface JobContext {
  db: Kysely<Database>;
  log: Logger;
  idp: KeycloakAdmin;
  mail: Mailer;
  /** Texts to residents (simulator locally; Twilio by configuration). */
  sms: SmsSender;
  /** Field-level encryption for everything personal the jobs read or write (SEC-10). */
  crypto: FieldCrypto;
  /** Public URLs the worker needs to put into realms, emails and texts. */
  urls: { gatewayPublic: string; idpPublic: string; idpInternal: string };
  objects: ObjectStore | null;
  devDirectGrant: boolean;
  /** Provider in force for a tenant (AIG-12); the fake provider by default. */
  ai: { providerFor(tenantId: string, trx: Transaction<Database>): Promise<AiProvider> };
  /** Shipped question graph, used when a submission names a version that is not in the database. */
  defaultGraph: QuestionGraph;
  now?: () => Date;
  /** Outside-link check for resources (BRD:FR-16.03); a HEAD request with a short timeout by default. */
  linkCheck?: (url: string) => Promise<boolean>;
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
