# ADR-0025: Pluggable AI behind four interfaces, a deterministic fake provider, and an evaluation gate

- Status: accepted
- Date: 2026-10-12
- Requirements: AIG-01–AIG-03, AIG-05–AIG-08, AIG-10, AIG-12, INT-12, INT-13, INT-16, PHO-12, Q-01

## Decision

`packages/ai` defines one interface each for language models (fixed-schema extraction only in layer 2), speech to text, translation and image analysis (quality and sensitive regions, never severity). Providers register in one map; a tenant names its provider in configuration. A deterministic fake provider (keyword rules in English and Spanish) ships for development and tests and never leaves the process. A feature turns on for a tenant only through the AI use register, and only when the provider is compliant (US processing, zero retention, no training) and has passed the evaluation harness for the tenant's languages: labelled multilingual cases, low-literacy phrasing, code-switching and prompt-injection cases that must yield no candidates. Resident text is redacted before any call and passed as data in a delimited field; outputs are validated against the graph server-side and filtered for eligibility statements, promises, medical or legal advice and contact data. Every output records provider and model.

## Alternatives considered

| Option                                       | Why not                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Call one vendor SDK directly from the routes | Switching providers would be a code change (AIG-12); compliance could not be checked per tenant.     |
| A general agent framework with tools         | Resident-facing AI must have no tools that read records (AIG-03).                                    |
| No fake provider, mocks in tests only        | The flow could not run end to end on a laptop, and the evaluation harness would have nothing to run. |

## Why it fits SCL-11 and the government-cloud move

Real providers are configuration; the registry accepts a FedRAMP-authorized endpoint without touching callers. The fake provider keeps `docker compose up` self-contained.

## Consequences

Layer 2 ships with the fake provider enabled for extraction, transcription, translation and photo quality; the severity suggestion stays locked off (PHO-12, Q-01). Real providers are a paid-service decision with Adam (layer 7).
