/**
 * Worker metrics (NFR-10, ADR-0023): scheduled jobs by name with their
 * duration and whether they failed; outbox messages relayed; queue messages
 * handled by topic and result (requeued means a failure the broker retries,
 * then dead-letters); AI calls by feature and outcome. Served at /metrics on
 * the worker's own port; labels are schedule, topic, feature and outcome names
 * only, never an id or content.
 */
import { Registry } from '@cg/adapters';

export const workerMetrics = new Registry();
export const jobRuns = workerMetrics.counter(
  'cg_job_runs_total',
  'Scheduled job runs by schedule and result (ok, failed)',
);
export const jobDuration = workerMetrics.histogram(
  'cg_job_duration_seconds',
  'Scheduled job duration in seconds by schedule',
);
export const outboxRelayed = workerMetrics.counter(
  'cg_outbox_relayed_total',
  'Outbox messages handed to the queue (ADR-0007)',
);
export const queueMessages = workerMetrics.counter(
  'cg_queue_messages_total',
  'Queue messages handled by topic and result (ok, requeued, dropped)',
);
export const aiCalls = workerMetrics.counter(
  'cg_ai_calls_total',
  'AI calls by feature and outcome (ok, filtered, invalid, refused, timeout, error)',
);
export const integrationCalls = workerMetrics.counter(
  'cg_integration_calls_total',
  'Calls to outside services by integration (sms, email) and outcome (ok, failed)',
);
export const auditChainsBroken = workerMetrics.gauge(
  'cg_audit_chains_broken',
  'Counties whose audit chain failed verification at the last anchoring run (SEC-11)',
);
export const auditChainsChecked = workerMetrics.counter(
  'cg_audit_chains_checked_total',
  'Audit chain verifications by result (ok, broken)',
);
