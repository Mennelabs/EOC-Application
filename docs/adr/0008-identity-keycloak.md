# ADR-0008: Keycloak for staff identity, SSO brokering and passkey MFA

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-07, SEC-08, FR-01.*, BRD:INT-01, ACCT-01, finding G-01

## Decision

Keycloak 26 (Docker Hub image `keycloak/keycloak`), one realm per tenant. Each realm brokers to the tenant's own IdP (SAML or OIDC). WebAuthn/passkeys are the required second factor; TOTP is allowed only through an audited tenant exception. For tenants with no IdP, Keycloak holds local accounts with mandatory passkeys. Residents never get accounts (SEC-09). The API validates OIDC access tokens (JWKS) and reads tenant and role claims; authorization itself stays in our policy engine (ADR-0011), not in Keycloak roles.

## Alternatives considered

| Option                           | Why not                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Auth0 / Okta / Entra External ID | Paid SaaS; per-tenant SSO costs add up; would need Adam's approval and a FedRAMP-authorized tier. |
| AWS Cognito                      | Cloud-only; no local stand-in; weaker SAML brokering.                                             |
| Ory Kratos/Hydra                 | Good, but more assembly needed for SAML brokering and admin UI.                                   |
| Build our own                    | Not for a security-critical component.                                                            |

## Why it fits SCL-11 and the government-cloud move

The same container runs in the government cloud's Kubernetes with an external managed database. Keycloak is widely used in public-sector deployments and supports FIPS mode.

## Consequences

- The CJIS enclave runs a **second, separate** Keycloak (layer 5).
- Field volunteers checked in by QR do not get a Keycloak account; they get a short-lived device session bound to the check-in (FLD-03, ACCT-01).

## Brokering to the county's identity provider (2026-10-16, SEC-07)

- **Configured per county, approved by two administrators.** An administrator proposes the provider on the console's Single sign-on screen: SAML metadata, or OpenID Connect addresses with a client ID and secret. A second administrator approves it (ADM-05). The worker's `sso.apply` job then puts it on the county's realm as the identity provider `county-sso`. The OIDC client secret is encrypted under the tenant key (SEC-10) and decrypted only to hand to Keycloak. See `docs/operations/single-sign-on.md`.
- **Link only, never create.** The first-broker-login flow `cg-first-broker` detects the existing user by email and links to it. When there is none, the sign-in fails. A county account therefore reaches only someone the county invited, and the county's sign-in can never mint an account.
- **The passkey stays.** The post-broker-login flow `cg-post-broker` requires the person's WebAuthn passkey after the county sign-in. SSO replaces the password, never the phishing-resistant factor. This is the stricter reading of SEC-07 (plan reading 49).
- **Signed and checked.** SAML assertions must be signed and the signature is validated; AuthnRequests are signed; the Name ID is the email address. OIDC uses PKCE and validates tokens against the provider's JWKS. `trustEmail` is off.
- **Switching off** disables the provider and keeps its links, so switching it back on needs no relinking. Invitations under SSO ask for a passkey only; the pending password step is dropped when SSO comes on.
- **Tested end to end:** `tests/e2e/sso.spec.ts` stands up a second realm as the county's SAML identity provider. It then proposes, approves, signs an invited person in with a passkey, and refuses a county user nobody invited.
