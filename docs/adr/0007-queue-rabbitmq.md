# ADR-0007: RabbitMQ (AMQP 0-9-1, quorum queues) with a transactional outbox

- Status: proposed
- Date: 2026-10-12
- Requirements: SCL-03, SCL-06, FR-00.04/06, CLAUDE.md rule 8

## Decision

RabbitMQ 4 with quorum queues and publisher confirms for intake and background jobs, dead-letter queues for poison messages, and a transactional outbox table for events produced inside database transactions (relayed by the worker). Consumers are idempotent by `execution_id`.

## Alternatives considered

| Option                            | Why not                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kafka / Redpanda                  | Built for streams and replay at a scale we do not need; heavier to run; managed options in government regions are fewer.                                 |
| NATS JetStream                    | Light and fast, but no managed FedRAMP offering; we would run it ourselves.                                                                              |
| Redis streams                     | Durability depends on persistence settings; not a "standard message queue".                                                                              |
| Postgres-only queue (SKIP LOCKED) | Simplest, but intake would depend on the database being up, which is what the queue protects against. Kept as the fallback path when the broker is down. |
| SQS directly                      | Cloud-only; no local equivalent without an emulator.                                                                                                     |

## Why it fits SCL-11 and the government-cloud move

Amazon MQ for RabbitMQ runs in AWS GovCloud, so the protocol and client code do not change. An SQS adapter can be added behind the same `queue` interface if a different cloud is chosen.

## Consequences

The API acknowledges a submission only after the broker confirms it (or after the database fallback commits). Load tests in layer 2 must include broker failover.
