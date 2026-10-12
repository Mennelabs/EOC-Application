# ADR-0017: Pluggable AI interfaces with a deterministic fake provider

- Status: proposed
- Date: 2026-10-12
- Requirements: AIG-01..12, AI-01..12, PHO-09..13, INT-12..16, OWASP LLM Top 10

## Decision
Four interfaces in `packages/adapters/ai`: `llm` (structured output only, validated against a zod schema), `stt`, `translate` and `image` (quality coaching), plus a separate `damage` classifier interface for PHO-12. Each call carries a purpose, a data-classification budget and a tenant. Untrusted text is passed in delimited data fields, never in system instructions (AIG-02). Outputs record provider, model, version and latency. A provider is selectable per tenant only if its registry entry declares US processing, zero retention and no training (AIG-06), and the tenant's evaluation run passed (AIG-08). The **fake provider** returns deterministic outputs from fixtures and is the default in development and tests. The `damage` classifier is disabled until a validated model exists.

## Alternatives considered
| Option | Why not |
| --- | --- |
| Call one vendor SDK directly | Violates AIG-12; blocks per-tenant choice and testing. |
| LangChain-style frameworks | Large dependency surface; we need a few narrow, typed calls. |

## Why it fits SCL-11 and the government-cloud move
Providers are configured by env/tenant config. Government-authorized model endpoints (e.g. in AWS GovCloud or Azure Government) are just another implementation.

## Consequences
An evaluation harness (`tools/ai-eval`) runs on every prompt or model change and blocks release on regression (AIG-08).
