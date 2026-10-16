# ADR-0023: Structured logs with pino, metrics in the Prometheus format, alert rules with named owners

- Status: accepted (logs 2026-10-12; metrics and alerts 2026-10-16)
- Date: 2026-10-12, updated 2026-10-16
- Requirements: NFR-10, SEC-11, CLAUDE.md rule 9

## Decision

**Logs.** JSON logs with pino. A redaction layer drops any field registered as `sensitive`/`restricted` and known secret patterns. Prompts and resident content are never logged (FR-C11).

**Metrics (2026-10-16).** The api and the worker each serve `/metrics` in the Prometheus text exposition format on their own port, which only the platform network reaches. The gateway routes `/api/*`, `/auth/*` and `/tiles/*` and never `/metrics`, which the DAST suite checks. A small registry in `@cg/adapters` (counters, gauges, latency histograms) writes the format. Label values are route templates and fixed vocabularies only. Anything else becomes `other`, and each metric stops at 1,000 label sets, so no input can put an id or content into a metric or grow it without bound. What is measured, mapped to NFR-10, is in `docs/operations/alerts.md`.

**Alerts.** `infra/prometheus/alerts.yml` holds the rules. Each carries an `owner` label and a runbook link, and the owners and runbooks are in `docs/operations/alerts.md`. promtool checks the rules and runs their unit tests in CI (`scripts/check-alerts.sh`). A vitest suite checks that every rule's owner, runbook section and metrics exist. Locally, `docker compose --profile monitoring up -d prometheus` scrapes both services and evaluates the rules.

**Traces.** Request and execution ids already link logs, the outbox and the audit trail. Distributed traces through the OpenTelemetry SDK stay for the cloud move, when the provider's collector is chosen.

## Alternatives considered

| Option                            | Why not                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| winston                           | Slower; pino integrates with Fastify.                                                                                                                               |
| Vendor APM agents                 | Paid; cloud-specific.                                                                                                                                               |
| OpenTelemetry SDK for metrics now | Several new runtime dependencies for what a small registry does. An OTel collector scrapes the Prometheus format unchanged, so the cloud move needs no code change. |
| prom-client                       | A good library. Ours adds the label guard (vocabulary and series cap) that NFR-10's "without sensitive content leakage" needs, and keeps the dependency count down. |

## Why it fits SCL-11 and the government-cloud move

The Prometheus text format is read by every managed monitor: Amazon Managed Service for Prometheus, Azure Monitor managed Prometheus, Google Managed Prometheus and any OpenTelemetry collector. The same rules file loads into each. Locally it is one more opt-in container from the same `compose.yaml`.

## Consequences

- Every request and job logs an `execution_id` and `tenant_id`, never personal data.
- Metrics carry no tenant id. They are platform-wide signals, and per-county figures stay in the console's own reports.
- The people who fill each owner role are named in the deployment's on-call roster. The roles are fixed here.
