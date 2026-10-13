# ADR-0024: Intake as a versioned question graph (data) with one deterministic engine for every channel

- Status: accepted
- Date: 2026-10-12
- Requirements: INT-01–INT-06, INT-14, INT-16, CHN-01, CHN-03, CHN-05, SCL-07, EQ-06

## Decision

Intake questions are data, not code: a JSON question graph validated by zod (`packages/intake`), versioned per tenant in `cg.intake_graph`, with branching by relationship, hazard and earlier answers, a `required` flag that still accepts "I don't know", FEMA/PDA field mapping and a classification per question. One pure engine (visible nodes, next node, remaining count, validation, summary, need signals, FEMA mapping) runs the web app, the SMS and voice sessions and assisted mode. String rules (grade ≤ 5, no exclamation marks, emoji, blame or FEMA jargon) are enforced by a unit test in CI and printed as a table for the human review.

## Alternatives considered

| Option                                          | Why not                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Questions coded as React components             | A county could not change wording, add a hazard or a language without a release (INT-01, SCL-07, EQ-06).   |
| A third-party form builder (SurveyJS, Typeform) | Branching and FEMA mapping live outside the audit trail; SMS and voice would need a second implementation. |
| Letting the language model drive the dialogue   | Non-deterministic, unavailable when AI is off (INT-16), and against the "graph decides, AI assists" rule.  |

## Why it fits SCL-11 and the government-cloud move

The graph is a row in the tenant's database; the engine is a dependency-free TypeScript package. Nothing changes between Docker Desktop and the cloud.

## Consequences

Every channel shows the same questions in the same order with the same validation. Adding a language is a translation task on the graph JSON. The reading-level lint applies to English; other languages are tone-checked and professionally translated before go-live (EQ-07).
