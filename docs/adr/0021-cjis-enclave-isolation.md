# ADR-0021: CJIS enclave as a separate Compose project with its own network, data, keys and identity

- Status: proposed (skeleton now, built in layer 5)
- Date: 2026-10-12
- Requirements: SEC-12, SCL-12, PPL-01, ADM-05, CLAUDE.md rule 2

## Decision
The enclave lives in `compose.cjis.yaml` as its own Compose project on network `cg_cjis`, with its own PostgreSQL, OpenBao, Keycloak (layer 5) and API. The platform network cannot reach the enclave database or keys. The only shared surface is `cjis-gateway`, reachable by browsers with an enclave token. The platform stores opaque `cji_ref` IDs only. In the cloud the enclave moves to a separate account/subscription with its own boundary.

## Alternatives considered
| Option | Why not |
| --- | --- |
| Same database, separate schema | Fails SEC-12 ("own account, network boundary, keys and identity"). |
| Platform API proxies CJI to the browser | CJI would pass through platform logs, queue and memory; harder to keep the platform out of CJIS scope. |

## Why it fits SCL-11 and the government-cloud move
The enclave images are deployed to their own authorized environment unchanged.

## Consequences
The console needs a second sign-in for CJIS-qualified users. The enclave holds no real CJI until it is in an authorized cloud and has passed the state CJIS audit.
