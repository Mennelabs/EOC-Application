# ADR-0004: Fastify + zod for the HTTP API, OpenAPI generated from schemas

- Status: proposed
- Date: 2026-10-12
- Requirements: SCL-09 (documented REST API), FR-00.06/07, NFR-11

## Decision
Fastify 5 with `fastify-type-provider-zod`. Every route declares zod request/response schemas; the OpenAPI document is generated from them and published at `/api/docs`. The API is a modular monolith (modules per domain) with separate worker processes for queue consumers.

## Alternatives considered
| Option | Why not |
| --- | --- |
| NestJS | Strong structure, but decorators/DI add weight; Fastify plus clear module folders is enough. |
| Express | Slower, weaker typing and schema integration. |
| GraphQL | Harder to authorize field-by-field consistently with audit and rate limiting; REST is what SCL-09 asks for. |
| Microservices per domain | Operational cost too high for the team size; the module boundaries keep a later split possible. |

## Why it fits SCL-11 and the government-cloud move
Stateless containers behind the gateway; horizontal scaling with no session affinity.

## Consequences
Idempotency (`Idempotency-Key` header), optimistic concurrency (`If-Match` with record version) and error format are Fastify plugins applied to every route.
