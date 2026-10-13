# Layer 5 status: CJIS enclave

Resume record for layer 5. Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then `docs/decisions.md` (the 2026-10-13 row that starts layer 5).
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name` on `main` (layer 4 merged in Mennelabs/EOC-Application#7, `4e58689`). Do not build on a red tree.
3. First task is the plan, `docs/plans/layer-5.md`, before any code (CLAUDE.md rule 5).

## Scope (what layer 5 is)

- **SEC-12:** criminal-justice information (law-enforcement mission fields, suspect and other law-enforcement roles in people involved, weapons, arrest dispositions, bodycam references) is stored only in the enclave: its own network boundary, database, keys, identity with its own MFA, audit and personnel screening, to FBI CJIS Security Policy v6.x.
- **PPL-01:** the law-enforcement roles and details of people involved live in the enclave; layer 4 deferred them here.
- **ADM-05:** criminal-justice data only for CJIS-qualified users; no county can configure that away.
- **SEC-13:** CJIS data follows CJIS and state records rules for retention.
- **SCL-12 and CLAUDE.md rule 2:** the enclave is its own container set and holds only synthetic data until it is in an authorized government cloud and has passed the state CJIS audit.
- **Not in scope:** CAD, NCIC or records-system integrations (INT-07, separately approved contracts only); 911 telephony or CAD replacement.

## What already exists (layer 1)

- The `cjis-api`, `cjis-db` (PostGIS), `cjis-keys` and `cjis-keys-init` (OpenBao) services in `compose.cjis.yaml` (included from `compose.yaml`) on their own `cjis` network, unreachable from the platform network (ADR-0021; tested in `tests/integration/stack.int.test.ts`).
- `services/cjis-api` is a skeleton (`src/main.ts`) with health checks only.
- Missions and their people involved (`services/api/src/routes/missions.ts`) exist without any law-enforcement fields; nothing criminal-justice is stored anywhere yet. How the platform mission refers to its enclave record is a plan decision.

## Carried over from layer 4 (not layer 5 work unless Adam says so)

See `docs/plans/layer-4-report.md`, "What did not pass, or is not yet proven" item 5 and "Decisions needed from you". The open defaults are in force.

## Tasks

| Task | What                         | State | Commits | Notes |
| ---- | ---------------------------- | ----- | ------- | ----- |
| P    | Plan `docs/plans/layer-5.md` | todo  |         |       |

## Known issues and deferred items

- None yet.
