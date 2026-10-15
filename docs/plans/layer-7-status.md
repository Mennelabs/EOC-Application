# Layer 7 status: AI features

Resume record for layer 7. Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then `docs/decisions.md` (the 2026-10-15 rows: OpenAI for every AI function, no fake provider in running systems, severity from OpenAI's vision model, alert-only AI health, the command window defaults, discovery sources).
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name`. Do not build on a red tree.
3. The plan is [`layer-7.md`](layer-7.md); the provider and command-window decisions are ADR-0043 and ADR-0044. Work the tasks below in order, one per commit, each ending green, pushed and recorded here.
4. Layer 7 starts after the partner work ([`partners-status.md`](partners-status.md)).

## Environment

- The AI features need the secret `OPENAI_API_KEY` in the environment where they run (the cloud environment's settings, or `.env` on a laptop; never in the repository or in chat). Without it the features are off and the manual paths run; the automated tests use the test double and recorded responses, and the live evaluation suite is skipped.
- As of 2026-10-15 the key is not yet set in the cloud environment.

## Tasks

| Task | What                                                                                                                                                                                                              | State | Commits       | Notes                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | --------------------------------------- |
| P    | Plan approved through Adam's answers (2026-10-15); ADR-0043 (OpenAI for every function, the classifier interface, no fake in running systems) and ADR-0044 (command window execution); ADR-0017 marked superseded | done  | (this commit) | Migrations for this layer start at 0054 |
| A    | AI foundation: the OpenAI provider for the interfaces and the classifier, output records, health alerts, name redaction, model registry, evaluation extensions and the live suite                                 | next  |               | AIG-01–12, AI-01–12                     |
| B    | Command catalog contract and execution engine                                                                                                                                                                     |       |               | CMD, BRD:FR-C, AC-C                     |
| C    | Command window in the console and the field app; shorthand, aliases, history, public coverage                                                                                                                     |       |               |                                         |
| D    | Facility registry and approval queue                                                                                                                                                                              |       |               | REC-01                                  |
| E    | Recommendation engine and panels                                                                                                                                                                                  |       |               | REC-02–12                               |
| F    | Proactive discovery                                                                                                                                                                                               |       |               | REC-13, REC-14                          |
| G    | AI drafting (reports, PIO, Form 010-0-13 boxes)                                                                                                                                                                   |       |               | CMD-16, PUB-11/12/14, DCL:DEC-14        |
| H    | Scribe, hand-over and translation                                                                                                                                                                                 |       |               | FL-04/05/07/12/14/18                    |
| I    | Photo pre-sort                                                                                                                                                                                                    |       |               | PHO-07, PHO-09–15                       |
| J    | Tests, CI, accessibility records                                                                                                                                                                                  |       |               | GATE-02/03/04/05/08                     |
| K    | Docs, traceability, NIST AI RMF mapping, layer-7 report                                                                                                                                                           |       |               | AIG-11                                  |
