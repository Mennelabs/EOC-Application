# Design foundation status

Resume record for the design foundation decided 2026-10-15. Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then `docs/design/users-and-needs.md` and ADR-0045.
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name`. Do not build on a red tree.
3. See the design system: `pnpm --filter @cg/ui showcase` (a page on port 5173) or `pnpm --filter @cg/ui build:showcase && pnpm --filter @cg/ui test:showcase` (axe and screenshots, no stack needed; `PW_CHROMIUM_PATH` points at a preinstalled Chromium).
4. Layer 7 resumes at task F (`docs/plans/layer-7-status.md`) once the tasks below are merged.

## Tasks

| Task | What                                                                                                                                     | State | Commits | Notes |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ----- |
| R    | Decision recorded; user-needs research; ADR-0045; this plan                                                                              | done  |         |       |
| A    | `packages/ui`: tokens, fonts, base, skin for existing classes, shell, React Aria components, icons, showcase with axe and screenshots    | done  |         |       |
| B    | Console frame: top bar, event chip, command bar, person and display menu, grouped navigation by permission with counts, drawer on phones |       |         |       |
| C    | Situation home, work home, briefing mode (CON-11)                                                                                        |       |         |       |
| D    | Resident app and Find help on the tokens and the public font, inside the budget                                                          |       |         |       |
| E    | Traceability, a11y records, README, layer-7 status pointer                                                                               |       |         |       |

## Open items

- Field app restyle deferred (see the plan).
