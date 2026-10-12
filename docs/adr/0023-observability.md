# ADR-0023: Structured logs with pino (classification-aware redaction), OpenTelemetry later

- Status: proposed
- Date: 2026-10-12
- Requirements: NFR-10, SEC-11, CLAUDE.md rule 9

## Decision
JSON logs with pino. A redaction layer drops any field registered as `sensitive`/`restricted` and known secret patterns. Metrics and traces through OpenTelemetry SDK, exported to an OTel collector added in layer 2 (local: stdout; cloud: the provider's monitoring). Prompts and resident content are never logged (FR-C11).

## Alternatives considered
| Option | Why not |
| --- | --- |
| winston | Slower; pino integrates with Fastify. |
| Vendor APM agents | Paid; cloud-specific. |

## Why it fits SCL-11 and the government-cloud move
OTLP is vendor-neutral; CloudWatch/Azure Monitor accept it.

## Consequences
Every request and job logs an `execution_id` and `tenant_id`, never personal data.
