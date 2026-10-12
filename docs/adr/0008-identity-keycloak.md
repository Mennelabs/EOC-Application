# ADR-0008: Keycloak for staff identity, SSO brokering and passkey MFA

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-07, SEC-08, FR-01.*, BRD:INT-01, ACCT-01, finding G-01

## Decision
Keycloak 26 (Docker Hub image `keycloak/keycloak`), one realm per tenant. Each realm brokers to the tenant's own IdP (SAML or OIDC). WebAuthn/passkeys are the required second factor; TOTP is allowed only through an audited tenant exception. For tenants with no IdP, Keycloak holds local accounts with mandatory passkeys. Residents never get accounts (SEC-09). The API validates OIDC access tokens (JWKS) and reads tenant and role claims; authorization itself stays in our policy engine (ADR-0011), not in Keycloak roles.

## Alternatives considered
| Option | Why not |
| --- | --- |
| Auth0 / Okta / Entra External ID | Paid SaaS; per-tenant SSO costs add up; would need Adam's approval and a FedRAMP-authorized tier. |
| AWS Cognito | Cloud-only; no local stand-in; weaker SAML brokering. |
| Ory Kratos/Hydra | Good, but more assembly needed for SAML brokering and admin UI. |
| Build our own | Not for a security-critical component. |

## Why it fits SCL-11 and the government-cloud move
The same container runs in the government cloud's Kubernetes with an external managed database. Keycloak is widely used in public-sector deployments and supports FIPS mode.

## Consequences
- The CJIS enclave runs a **second, separate** Keycloak (layer 5).
- Field volunteers checked in by QR do not get a Keycloak account; they get a short-lived device session bound to the check-in (FLD-03, ACCT-01).
