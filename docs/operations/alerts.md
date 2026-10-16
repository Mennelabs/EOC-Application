# Alerts, owners and runbooks (NFR-10)

NFR-10 asks the platform to measure save, command and integration failures, latency, conflicts, duplicate prevention and audit completeness without leaking prompts or content, and to define who owns each alert. This page covers what is measured and who answers each alert. It also gives the first steps for each alert.

## What is measured

The api and the worker each serve `/metrics` in the Prometheus text format on their own port. That port is on the platform network only: the gateway routes `/api/*`, `/auth/*` and `/tiles/*`, so `https://<gateway>/metrics` never reaches a service. The local Prometheus (`docker compose --profile monitoring up -d prometheus`, http://127.0.0.1:9090) scrapes both. In the government cloud, the provider's managed Prometheus or OpenTelemetry collector scrapes the same endpoints and loads `infra/prometheus/alerts.yml` unchanged (ADR-0023).

| NFR-10 asks for      | Metric                                                                                                                           | Where       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Save failures        | `cg_http_requests_total{route,method,status}` (status class: 2xx, 4xx, 5xx)                                                      | api         |
| Latency              | `cg_http_request_duration_seconds{route,method}` (histogram); `cg_job_duration_seconds{schedule}`                                | api, worker |
| Conflicts            | `cg_api_errors_total{code="version_conflict"}`; `cg_field_commands_total{result="conflict"}`                                     | api         |
| Duplicate prevention | `cg_idempotent_replays_total{route}` (answered from an earlier identical request); `cg_field_commands_total{result="duplicate"}` | api         |
| Command failures     | `cg_field_commands_total{kind,result}`; command window requests by route and status                                              | api         |
| Integration failures | `cg_integration_calls_total{integration="sms"\|"email",outcome}`; `cg_ai_calls_total{feature,outcome}`                           | worker, api |
| Background work      | `cg_job_runs_total{schedule,result}`; `cg_queue_messages_total{topic,result}`; `cg_outbox_relayed_total`                         | worker      |
| Audit completeness   | `cg_audit_chains_checked_total{result}`; `cg_audit_chains_broken` (counties whose chain failed its last check)                   | worker      |
| Refusals by reason   | `cg_api_errors_total{code}`                                                                                                      | api         |

Label values come from fixed vocabularies only: route templates (`/api/v1/needs/:id`, never the id), method, status class, error code, schedule, topic, feature and outcome words. Any other value becomes `other`, so a metric can never carry an id, an address, a name or anything a person wrote (NFR-10, FR-C11). The worker's schedule label is `schedule`, not `job`, because Prometheus already uses `job` for the scrape target.

## Owners

Every rule in `infra/prometheus/alerts.yml` carries an `owner` label. The monitor routes each alert by that label: in the cloud, the managed alerting service sends it to the role's channel; locally, alerts show in Prometheus. The deployment's on-call roster names who fills each role at any given time.

| Owner             | Who                                                                                                                                            | Answers                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `platform-oncall` | Mennelabs platform on-call engineer; escalates to the Mennelabs engineering lead after 30 minutes                                              | Service down, resident submission failures, save failures, conflicts, latency, phone command rejections, queue retries, failing schedules |
| `messaging`       | Mennelabs platform on-call for the Twilio and mail accounts. The county's messaging administrator is told when residents may have missed texts | Text and email send failures                                                                                                              |
| `ai-governance`   | Mennelabs AI owner (the person accountable under AIG-01 and the NIST AI RMF mapping in `docs/ai-rmf.md`)                                       | AI calls failing or timing out                                                                                                            |
| `security`        | Mennelabs security officer (GovRAMP ISSO). The county's administrator is told when their chain is involved                                     | Audit chain broken, audit anchoring stopped                                                                                               |

The CJIS enclave keeps its own audit, alerts and owners (SEC-12, ADR-0037). The enclave's metrics never mix with the platform's.

## Runbooks

### ServiceDown

The api or worker has not answered a scrape for 5 minutes.

1. Run `docker compose ps` (or check the cloud service's task status) and read the service's last logs.
2. Each service restarts itself (`restart: unless-stopped`), and state lives in the database. If it keeps failing, check the database and queue health (`/health/ready` lists each dependency).
3. Residents are not failed while the worker is down: intake writes sit in the outbox until the worker is back (SCL-06).

### ResidentSubmissionFailures

A resident submission got a server error. Even one counts, because SCL-06 says never fail a resident submission.

1. Find the request in the api logs by time and route. Its `execution_id` links it to the outbox and audit.
2. Check the degradation order (AI off, then photo processing deferred, then maps off, then text reports still accepted). A 5xx on the text path means that order broke.
3. The resident app retries with the same idempotency key, so a retry after the fix makes no duplicate.

### SaveFailureRate

More than 2% of staff saves failed with a server error for 10 minutes.

1. Group `cg_http_requests_total{status="5xx"}` by route to find the failing endpoint.
2. Read that route's errors in the api logs (`internal_error` with its `execution_id`).
3. Consoles keep unsaved input and retry with the same idempotency key (BRD:FR-00.06), so nothing is lost while the cause is fixed.

### SaveConflictSpike

More than 50 version conflicts in 15 minutes. A few are normal (two people editing one record). A spike means a screen is saving stale versions or a job is racing staff edits.

1. Group `cg_api_errors_total{code="version_conflict"}` by time against `cg_http_requests_total` by route to find the screen.
2. Check whether a schedule (`cg_job_runs_total`) writes the same records at the same moments.

### ApiLatencyHigh

95th-percentile latency was above 2.5 s for 15 minutes.

1. Find the slow routes: `histogram_quantile(0.95, sum by (le, route) (rate(cg_http_request_duration_seconds_bucket[10m])))`.
2. Check database load and lock waits, then AI provider latency (`cg_ai_calls_total` outcome `timeout`).

### CommandWindowSlow

The command window misses its 15 s deadline at the 95th percentile (CMD-38).

1. The console's command performance screen (`/api/v1/commands/performance`) separates interpretation time from execution time.
2. Slow interpretation points to the AI provider. Slow execution points to the action's own route.

### FieldCommandRejections

More than 10% of commands from phones were rejected or conflicted for 15 minutes.

1. Group `cg_field_commands_total` by `kind` to find which command fails.
2. Conflicts mean phones are saving over newer versions. Check the area download's change feed (phones that fall behind re-download their area).
3. Rejections carry a code on the phone's outbox. A sudden rise after a release means a contract mismatch between the app and the api.

### QueueRequeues

Messages on one topic keep failing and being retried.

1. Read the worker log line `job failed; requeue` for the topic. It names the error, never the content.
2. After 10 deliveries the broker moves the message to the dead-letter queue (`cg.dead-letter.queue`). Nothing is dropped silently (ADR-0007).

### JobFailing

A scheduled job failed 3 or more times in 30 minutes.

1. Read the worker log line `schedule failed` with the schedule's name.
2. Jobs are idempotent and run again on their next tick once the cause is fixed.

### SmsDeliveryFailures

More than 5% of texts failed to send for 10 minutes.

1. Check the Twilio console for the county's toll-free number: verification status, carrier filtering, account balance.
2. Each failed message is marked `failed` on `cg.message` with the provider's error, so the county knows whom to reach by another channel.
3. Never change templates to work around filtering using "emergency alert" wording (docs/06).

### EmailDeliveryFailures

Five or more emails failed in 30 minutes.

1. Check the SMTP relay's status and credentials (secrets store, never logs).
2. Reminder escalations wait for the next run (BRD:FR-09.06 quiet hours still apply).

### AiCallsFailing

More than 20% of AI calls failed or timed out for 15 minutes.

1. Group `cg_ai_calls_total` by `feature` and `outcome`. The `ai-health` schedule also raises the in-app AI health alert (AIG-09).
2. Features fall back to their manual path (AI-10). AI health alerts but does not switch features off (decisions 2026-10-15).
3. Check the provider's status page and the tenant's provider configuration.

### AuditChainBroken

A county's audit chain failed `cg.audit_verify`, and anchoring stopped for that county.

1. Treat it as a security incident. Do not repair rows: audit records cannot be edited (ADM-05).
2. The worker log line `AUDIT CHAIN BROKEN` names the county and the first bad sequence number. Compare against the last anchor in object storage (`tenant/<id>/audit-anchors/`).
3. Record it as a security incident, keep the evidence, and notify the county's administrator. State breach-notification rules apply where records may be affected (SEC-03).

### AuditAnchoringStopped

The audit chain has not been verified and anchored for over an hour.

1. Check the `audit-anchor` schedule in `cg_job_runs_total` and the worker logs.
2. Check the object store's locked bucket, because anchors are written with object lock.
