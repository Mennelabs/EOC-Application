# ADR-0021: CJIS enclave as a separate Compose project with its own network, data, keys and identity

- Status: accepted (proposed 2026-10-12; built in layer 5, refined by ADR-0036, ADR-0037 and ADR-0038)
- Date: 2026-10-14
- Requirements: SEC-12, SCL-12, PPL-01, ADM-05, SEC-10, SEC-13, SEC-18, CLAUDE.md rule 2

## Decision

The enclave lives in `compose.cjis.yaml`, included by `compose.yaml` so one `docker compose up` starts both, with its own internal network `cg_cjis`, its own volumes and its own secrets: `cjis-db` (PostgreSQL, databases `cjis` and `cjis_idp`), `cjis-keys` (OpenBao transit, per-agency keys), `cjis-idp` (Keycloak, realm `cjis`), `cjis-api`, `cjis-worker`, `cjis-web` and the one-shot `cjis-migrate` and `cjis-provision`. No platform service is on `cg_cjis`, and no enclave service is on the platform network. The only surface outside the enclave is `cjis-gateway`, which also sits on a small edge network (`cg_cjis_edge`) so it can publish `https://localhost:8443` on the loopback address (Docker publishes no port from an internal network). The gateway serves the enclave's own web app (ADR-0038), its API and its sign-in pages; it refuses the identity provider's administration and master-realm paths.

The platform stores one opaque value per mission, `mission.cji_ref` (random 256 bits, base64url), set by a law-enforcement liaison (`POST /missions/:id/cji-link`, action `mission.cji.link`). The enclave keys its record by (agency, `cji_ref`). The two systems never call each other: the console shows a link to the enclave's own address, and the enclave's browser app talks only to the enclave. In the cloud the enclave moves to a separate account or subscription with its own boundary.

## Alternatives considered

| Option                                                   | Why not                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Same database, separate schema                           | Fails SEC-12 ("own account, network boundary, keys and identity").                                                         |
| Platform API proxies CJI to the browser                  | CJI would pass through platform logs, queue and memory; harder to keep the platform out of CJIS scope.                     |
| Console fetches CJI from the enclave with a second token | The console's origin, scripts and storage would handle CJI; ADR-0038 keeps CJI on the enclave's own origin.                |
| A separate Compose project started with its own command  | Two commands to remember; `include` keeps one `docker compose up` (SCL-11) while networks, volumes and secrets stay apart. |

## Why it fits SCL-11 and the government-cloud move

The enclave images (`cjis-api`, `cjis-migrate`, `cjis-web`) are deployed to their own authorized environment unchanged; the database, keys and identity provider become that environment's managed services through environment variables. In production the enclave refuses to start unless `CJIS_AUTHORIZED_ENVIRONMENT` and `CJIS_STATE_AUDIT_PASSED_ON` are set (SCL-12).

## Consequences

CJIS-qualified people sign in twice: once to the console, once to the enclave. The enclave holds no real CJI until it is in an authorized cloud and has passed the state CJIS audit. Tests prove the boundary on every push: marker strings written in the enclave appear in no platform table and no service log, tokens are refused across the boundary, and phones never learn about the link (`tests/integration/layer5.int.test.ts`).
