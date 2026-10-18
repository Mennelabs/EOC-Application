# Queued after layer 8: status

Resume record for the items Adam queued on 2026-10-15 for after layer 8 (`docs/plans/partners-before-layer-7.md` §C, `docs/decisions.md`), worked after case management (`case-management-status.md`). Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file and `docs/decisions.md`.
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name && pnpm check:traceability`. Do not build on a red tree.
3. Work the tasks below in order, one per commit, each ending green, pushed and recorded here. Evidence goes in `tools/reqindex/trace-queued.json`; regenerate `docs/traceability.md` with `python3 tools/reqindex/traceability.py`.

## Tasks

| Task | What                                                                                                                                                                                   | State       | Commits | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BP   | Brother badge printing: label-sized print view for the QL-820NWB and QL-1110NWB through the driver; the label recorded with each print outcome; ADR; records                           | done        | fb53b09 | Migration 0113 `cg.badge.print_layout`; `POST /badges/:id/print` takes `layout`; the badge print view's "Print on" choice sets `@page` and the card's size; ADR-0047. The field app's Brother SDK waits on Adam (licensed binary, native module in CI).                                                                                                                                                                                                                    |
| MA   | CJIS mutual-aid grants: the owning agency grants helping agencies access to a record per mission for a set period, CJIS-qualified users only, every read audited, ending automatically | done        | 77e1901 | Decision 2026-10-15 (replaces the layer-5 default of no sharing). Enclave migration 0006 `cjis.record_share` with read-only row policies for the agency shared with; `POST /records/:ref/shares` (owner's supervisor or administrator, confirmation, ≤ 90 days), `.../revoke` with a reason, `GET /agencies`; the worker's `mutual-aid` job ends shares at their time; web panel, banner and column; the exercise shares the sheriff's record with the police for 30 days. |
| IOS  | iOS readiness: bundle id, permission texts (location, camera, microphone, background location), the build steps for Adam's Mac                                                         | not started |         | Decision 2026-10-15: built by Adam on his own Mac; needs an Apple Developer membership in Mennelabs' name. Android stays in CI.                                                                                                                                                                                                                                                                                                                                            |

## Open items

- MA: sharing stays inside one enclave (both agencies tenants of the same enclave set). Sharing across enclaves, or with the platform, is not built and would need its own decision.

- BP: Brother's mobile SDK in the field app needs Adam's go (ADR-0047 §3): a licensed binary pinned in the repository or a private registry, and a native module the Android CI build compiles.
