# ADR-0011: In-house policy engine with coded guardrails, Postgres RLS as backstop

- Status: proposed
- Date: 2026-10-12
- Requirements: FR-00.01, SEC-06, ADM-04, ADM-05, AC-00A, AC-C05

## Decision
A TypeScript policy engine (`packages/authz`) evaluates `decide(subject, action, resource, fields)`. Evaluation order: (1) guardrails written in code that no configuration can change; (2) tenant roles as versioned data (action × record scope × data category); (3) default deny. Every decision returns allowed fields (a mask), and restricted reads are audited. The same function backs the "what can this role do" preview, the API, the command window and the field-app sync.

## Alternatives considered
| Option | Why not |
| --- | --- |
| Open Policy Agent (Rego) | Powerful, but a second language and a sidecar; county admins need a UI over data, not policy code. |
| AWS Cedar | Good fit for the model, but young JS tooling; could replace the role-evaluation layer later behind the same interface. |
| OpenFGA / Zanzibar-style | Great for relationships; our gates are attributes (geography, data category, event), which fit worse. |
| Keycloak authorization services | Ties authorization to the IdP; the enclave and field sessions would need their own copies. |

## Why it fits SCL-11 and the government-cloud move
Plain library code in the API container; no external service.

## Consequences
Guardrails get a dedicated test file each and a security test suite that tries to bypass them through every entry point (GATE-04).
