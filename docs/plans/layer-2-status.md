# Layer 2 status

The coordination record for layer 2 (resident intake, review queue, verification). Any session resumes from this file, not from chat. Update it in every commit that changes a task's state. Plan: [`layer-2.md`](layer-2.md). Decisions: [`../decisions.md`](../decisions.md). Layer 1 record: [`layer-1-status.md`](layer-1-status.md).

## Resume checklist

1. `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name` green before new work.
2. Stack for integration work: `scripts/init-env.sh` (or `scripts\init-env.ps1`) then `docker compose up -d --wait`; the suites wait for provisioning on their own.
3. Pick the first task below that is not `done`, finish it to green, commit citing requirement IDs, update this file, push.

## Tasks

| #   | Task                                                                                                                                                                        | State | Commits | Verified by | Next / notes                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ----------- | ---------------------------------------------------------------------------- |
| A   | `packages/intake`: graph schema (INT-01), default WESTWIND graph EN/ES (DCL:DEC-01, NED-01/03, WIT/HLP/ORG), engine (INT-02–06, hazards), string lints (INT-08/17)          | todo  |         |             | Graph JSON is tenant configuration; keep FEMA field mapping on each question |
| B   | Migrations 0011–0016, dictionary, retention categories, actions and template grants for reports, photos, needs, consent, sessions, messages                                 | todo  |         |             | `cg.undocumented_columns()` must stay empty                                  |
| C   | Public API: graph, submissions (queue + fallback + reference codes), drafts, uploads, lookup + resident token, abuse protection                                             | todo  |         |             | Never fail a submission (CLAUDE.md rule 8)                                   |
| D   | `packages/ai`: four interfaces, fake provider, AI use register, extraction route, output filter, evaluation harness in CI                                                   | todo  |         |             | Real providers are a layer-7 decision with Adam                              |
| E   | Worker: intake consumer, confirmation messages, photo processing (EXIF strip, derivatives, restricted originals), duplicate flags, corrections                              | todo  |         |             | `sharp` needs build approval in `pnpm.onlyBuiltDependencies`                 |
| F   | Comms adapter (simulator + Twilio), SMS and voice sessions on the same graph, Twilio webhooks with signature checks, message states                                         | todo  |         |             | Templates and keywords from `docs/06`; county name, never product name       |
| G   | Resident PWA: full flow, free text + extraction, photos, needs + consent, review, outbox, confirmation, after-saving questions, my report, assisted mode, manifest, Spanish | todo  |         |             | Mockups in `mockups/resident/`; axe on every screen                          |
| H   | Console: review queue, report detail, decisions with FEMA matrix and verification, event intake setup with QR, assisted workspace, AI register                              | todo  |         |             | Guardrail G4 (no self-review) through the real engine                        |
| I   | Tests: integration cases AC-10/11/12 + channel cases, e2e + axe, keyboard-only journey, k6 load profiles                                                                    | todo  |         |             | Load results go in the report                                                |
| J   | Docs: ADRs 0024–0027, `docs/traceability.md` extended, `layer-2-report.md`, README, `docs/a11y` records                                                                     | todo  |         |             |                                                                              |

## Known issues and deferred items

- See `layer-2.md` §11 for deferred IDs. Spanish strings are drafts pending professional translation and community review (EQ-07) and are marked as such in the resident app's message file.
- The geocoder profile (`COMPOSE_PROFILES=maps`) downloads the Missouri extract; intake never depends on it (SCL-06).

## Boundaries (single session; recorded for a later fan-out if Adam enables it)

| Slice                | Owns                                                                        | Reads only                      |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| Engine + API (A–D)   | `packages/intake/**`, `packages/ai/**`, `services/api/src/routes/public/**` | `packages/db`, `packages/authz` |
| Worker + comms (E–F) | `services/worker/src/jobs/intake*`, `packages/adapters/src/comms*`          | API contracts                   |
| Resident PWA (G)     | `apps/web-resident/**`                                                      | `/api/public/*` contracts       |
| Console (H)          | `apps/web-console/src/screens/review*`                                      | `/api/docs/json`                |
