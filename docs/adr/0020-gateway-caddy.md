# ADR-0020: Caddy as the local gateway (TLS, routing, security headers, static tiles)

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-10 (TLS 1.2+, HSTS), SCL-11

## Decision
Caddy 2 terminates TLS on `https://localhost` with its internal CA, routes to the web, API, identity and tile paths, sets security headers (HSTS, CSP, Referrer-Policy, Permissions-Policy) and serves PMTiles with range requests.

## Alternatives considered
| Option | Why not |
| --- | --- |
| nginx | More configuration for automatic local TLS. |
| Traefik | Label-driven config is convenient, but Caddyfile is easier to review. |

## Why it fits SCL-11 and the government-cloud move
In the cloud the platform ingress (ALB + WAF, or Kubernetes ingress) replaces Caddy; the services behind it do not change.

## Consequences
Developers trust Caddy's local root certificate once (documented in README) or accept the browser warning.
