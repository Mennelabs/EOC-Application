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

Plan: [`layer-5.md`](layer-5.md). One task per commit; each ends green, pushed, and recorded here.

| Task | What                                                                                                        | State | Commits | Notes |
| ---- | ----------------------------------------------------------------------------------------------------------- | ----- | ------- | ----- |
| P    | Plan `docs/plans/layer-5.md`                                                                                | done  | 3335213 |       |
| A    | Enclave containers and identity (`cjis-idp`, `cjis-provision`, `cjis-web`, `cjis-gateway`, secrets, guard)  | done  | this commit |       |
| B    | Enclave database `packages/cjis-db` (migrations, dictionary, RLS, audit chain, retention, synthetic agency) | todo  |         |       |
| C    | Enclave API (auth, qualification, policy, audit, encryption, routes, jobs)                                  | todo  |         |       |
| D    | Platform side (migration 0041, actions, template, mission routes, seed liaison, dictionary guard)           | todo  |         |       |
| E    | Enclave web app `apps/web-cjis`                                                                             | todo  |         |       |
| F    | Console CJIS panel and link action                                                                          | todo  |         |       |
| G    | Tests and CI (stack suite, browser journeys, enclave database suites, image scans)                          | todo  |         |       |
| H    | Docs (ADRs 0021/0036–0038, architecture, traceability, report, README, accessibility records)               | todo  |         |       |

## Verified by (task A)

- Local stack (`docker compose up`): every enclave service healthy; `cjis-provision` builds realm `cjis` idempotently (two runs). The enclave gateway answers on `https://localhost:8443` with its own CA, the issuer `https://localhost:8443/auth/realms/cjis`, a strict CSP, and 404 for `/auth/admin` and the master realm; unknown API paths are denied (403).
- `tests/integration/stack.int.test.ts` (28 cases locally): the platform API cannot open any enclave service (`cjis-idp`, `cjis-api`, `cjis-keys`, `cjis-gateway`, `cjis-web`, `cjis-db`); the enclave API cannot open the platform's database, identity provider, queue, keys, objects or API; only `cjis-gateway` publishes a port, on 127.0.0.1.
- Second factor settled by experiment on Keycloak 26.0.7 (ADR-0036 to record): the AMR mapper with a method reference on each authenticator puts `amr: ["pwd","otp"]` (direct grant) or `["pwd","hwk"]` (browser, passkey) in the token, and it survives a refresh; a password-only direct grant is refused. The API will accept `amr` values from `CJIS_SECOND_FACTORS` (production `hwk`; the development stack adds `otp` for its test client).
- Unit: `services/cjis-api/test/config.test.ts` (production mode refused without the authorized environment and the audit date, SCL-12), `realm.test.ts` (lockout 5 in 15 minutes for 10 minutes, 30-minute idle, 15-character passwords with history, no self-registration or email reset, events).
- Sandbox notes (not repository changes): Docker Hub rate limits and a blocked Alpine CDN here, so images were pulled through a registry mirror and built with the proxy CA as the Dockerfiles' `extra_ca` secret; MinIO was built from the same pinned source without the `apk` step; RabbitMQ's cookie in a fresh volume needed its owner fixed. CI builds as before.

## Known issues and deferred items

- Deferred IDs in `layer-5.md` §11; readings flagged for Adam in §12; questions with defaults in force in §14.
- The CJIS Security Policy PDF hosts are blocked by this environment's egress policy, so the values in `layer-5.md` §4 come from the policy's known control text and are marked for confirmation by the agency's CJIS Systems Officer.
