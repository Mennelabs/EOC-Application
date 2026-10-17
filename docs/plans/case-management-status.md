# Case management status

Resume record for the case-management work after layer 8 (plan: [`case-management.md`](case-management.md); decision 2026-10-15). Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then the plan and `docs/decisions.md`.
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name && pnpm check:traceability`. Do not build on a red tree.
3. Work the tasks below in order, one per commit, each ending green, pushed and recorded here. Evidence goes in `tools/reqindex/trace-case.json`; regenerate `docs/traceability.md` with `python3 tools/reqindex/traceability.py`.
4. The database and browser suites run in CI only in this environment.

## Defaults in force (plan §6, until Adam answers)

| Question | Default in force                                                         | Where it is switched                           |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| 1        | Proposed consent wording for case management, long-term recovery and SBA | `packages/intake` consent texts                |
| 2        | SBA is a partner tenant with the `sba_representative` role               | role template                                  |
| 3        | Day 30 counts from the case opening                                      | tenant config `case.handoff_days` (default 30) |

## Tasks

| Task | What                                                                                                           | State       | Commits | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CM-A | Tables, actions, templates; case, help received with the duplication check, recovery plan; API, tests, seed    | done        | 3fd01b2 | Migration 0111 (`cg.case`, `cg.help_received` append-only with void, `cg.recovery_plan_item`); actions `case.read/open/close`, `help_received.write/void`, `recovery_plan.write`; templates `county_caseworker`, `sba_representative`, `long_term_recovery_manager`, `case_manager` gains; `routes/cases.ts` with `GET /cases/:id/duplication`; `cases.db.test.ts`; seed cast Noor Haddad and Eli Brandt, one exercise case when `SEED_DAMAGE_REPORTS` is set. A partner reaches a case through any active grant for the report until CM-C adds the `case_management` service. |
| CM-B | Appointments with SMS and reminder; MARC visit, queues and warm hand-off; tests                                | not started |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| CM-C | `case_management` sharing service and sections, consent organization types with wording, the day-30 job; tests | not started |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| CM-D | Console screens Case work and Recovery centre; navigation; scan; accessibility records                         | not started |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| CM-E | Records: traceability, known limitations, README, report                                                       | not started |         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Open items

- CM-A: no SBA tenant is seeded yet (the `sba_representative` template exists); CM-B adds one with the recovery-centre work.

- Layer 8's PR #59 waits on CI and merge; layers 7 and 8 wait on Adam's review.
