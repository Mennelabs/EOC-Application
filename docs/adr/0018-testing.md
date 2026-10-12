# ADR-0018: Vitest, Playwright + axe-core, Testcontainers/Compose, k6

- Status: proposed
- Date: 2026-10-12
- Requirements: CLAUDE.md rule 7, GATE-02..05, SCL-03, NFR-01, SEC-05

## Decision
| Kind | Tool |
| --- | --- |
| Unit | Vitest |
| Integration (DB, queue, storage, keys) | Vitest against real containers started by Docker Compose in CI (`docker compose up --wait`) |
| End-to-end, public and staff tasks | Playwright |
| Automated accessibility | `@axe-core/playwright` on every screen and state, WCAG 2.2 AA rule set |
| Manual accessibility | Checklist per screen in `docs/a11y/` (keyboard, screen reader, zoom/reflow) |
| Security boundaries | Dedicated suites: cross-tenant reads, guardrail bypass attempts, public enumeration |
| Load | k6 scenarios for SCL-03 (layer 2 onward) |
| Reading level | Script measuring grade level per question string (INT-08) |

## Alternatives considered
| Option | Why not |
| --- | --- |
| Jest | Slower; Vitest shares Vite config with the web apps. |
| Cypress | Weaker multi-tab and WebKit support; Playwright covers Safari engines (CHN-02). |
| pa11y | axe-core is the engine either way; Playwright integration is tighter. |
| Gatling / Locust | k6 scripts are JavaScript, like the rest of the stack. |

## Why it fits SCL-11 and the government-cloud move
The same suites run against the cloud staging environment by changing base URLs.

## Consequences
Tests are part of done; each layer's traceability table links IDs to test names.
