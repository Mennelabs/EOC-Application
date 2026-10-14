# ADR-0036: Enclave identity: its own realm, a second factor proven in the token, and the CJIS values

- Status: accepted
- Date: 2026-10-14
- Requirements: SEC-12, SEC-07, ADM-05, SCL-12, CJIS Security Policy v6.x (AC-2, AC-7, AC-8, AC-11, AT-2, IA-2, IA-5, PS-3, AU-2), ADR-0008, ADR-0021

## Decision

**Own identity.** `cjis-idp` is a separate Keycloak with its own database (`cjis_idp`) and one realm, `cjis`. No federation with the platform realms, no shared accounts, no single sign-on from the console. `cjis-provision` creates the realm idempotently: flows, values, clients (`cjis-web`, a public PKCE client; `cjis-api-admin`, the worker's service account), an audience mapper (`aud` = `cjis-api`) and an `amr` mapper.

**Second factor proven in the token.** The browser flow `cjis-browser` is "cookie, or password then passkey" (WebAuthn, user verification required). Each authenticator carries a method reference (`pwd`, `hwk`); the AMR mapper writes the methods used into `amr`. The enclave API accepts a token only if it is from the enclave realm, names the `cjis-api` audience and has at least one `amr` value in `CJIS_SECOND_FACTORS` (production: `hwk` only). A flow that is mis-set therefore fails closed, and the refusal is audited (`auth.deny`). `acr` was rejected: Keycloak's level-of-authentication mapping proves a level, not which factor, and is easy to misconfigure.

Two findings from the build are recorded here. (1) The authenticator config's `maxAge` decides how long a method stays in `amr`; with `0` a token issued a second after the check (the redirect back, a refresh) lost the method. Provisioning sets it to the session's maximum lifespan (36,000 seconds) and updates existing configs. (2) At the very first sign-in the passkey is registered as a required action, so that session proved the password only. The API refuses it like any other, and the enclave app asks the person to sign in again with the passkey (`prompt=login`).

**Development only.** On a synthetic stack (`DATA_CLASSIFICATION_MODE=synthetic` and `CJIS_DEV_ACCOUNTS=true`), provisioning adds the exercise accounts and a confidential test client, `cjis-tests`, whose direct-grant flow `cjis-direct` asks for password and a time-based code (`otp`); the compose file sets `CJIS_SECOND_FACTORS=hwk,otp` so suites can sign in without a browser. Provisioning refuses exercise accounts anywhere else (SCL-12).

**CJIS-qualified, per request.** The token proves who signed in and how; qualification comes from the enclave database on every request: active account, adjudicated fingerprint-based check (PS-3, before access), security awareness training within 12 months (AT-2), active agency, an approved role. Anything missing returns `403 not_cjis_qualified` with what is missing (for the account's own page) and an audited denial. Screening rows hold status and dates only.

**Configured values** (to be confirmed by the agency's CJIS Systems Officer against the policy text; the policy hosts are blocked from this build environment):

| Control                    | Value                                                                                                        | Where                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| AC-7 unsuccessful sign-ins | 5 failures within 15 minutes lock the account for 10 minutes                                                 | realm brute-force detection                    |
| AC-11 session lock         | 30 minutes idle ends the identity session; the app locks and hides content after 30 minutes without activity | realm `ssoSessionIdleTimeout`, `apps/web-cjis` |
| AC-8 system use notice     | shown and acknowledged before sign-in; text from `CJIS_SYSTEM_USE_NOTICE`                                    | `GET /api/v1/notice`, the app's first screen   |
| AC-2 inactive accounts     | suspended after 90 days without a sign-in, audited                                                           | `cjis-worker`                                  |
| IA-5 passwords             | at least 15 characters, not the username or email, last 10 not reused; MFA always on top                     | realm password policy                          |
| AU-2 sign-in events        | successful and failed sign-ins, lockouts, credential changes copied into the enclave audit                   | `cjis-worker`                                  |
| Access tokens              | 5 minutes                                                                                                    | realm                                          |

**Onboarding without email or texts.** The enclave has no mail server. An agency administrator creates the account and records screening; a second administrator approves the first role (the requester cannot); activation creates the identity through the worker's outbox with a one-time temporary password, shown once to the administrator and handed over in person; the person sets a password and registers a passkey at first sign-in.

## Alternatives considered

| Option                                           | Why not                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| A realm in the platform's Keycloak               | Shares the identity provider, its database and administrators with the platform; fails SEC-12. |
| Trust a role claim for "CJIS-qualified"          | Screening and training lapse on dates; a token issued yesterday would still carry the claim.   |
| Time-based codes as the production second factor | Phishable; SEC-07 asks for phishing-resistant MFA. Kept only for the development test client.  |
| Email invitations                                | Needs a mail relay inside the enclave boundary; in-person hand-over is simpler and auditable.  |

## Why it fits SCL-11 and the government-cloud move

The same Keycloak image runs in the authorized environment with an external database; values are realm configuration applied by `cjis-provision`, so the CJIS Systems Officer can review them as code. A managed identity service could replace it behind the same token checks (issuer, audience, `amr`).

## Consequences

Each person needs a platform-supported authenticator (a passkey on a managed device or a security key). Lockout releases and passkey resets are administrator actions in the enclave identity provider until the enclave app offers them. The tests `services/cjis-api/test/token.test.ts`, `realm.test.ts`, `api.db.test.ts`, the stack cases in `tests/integration/stack.int.test.ts` (password alone refused, lockout) and `tests/e2e/cjis.spec.ts` (passkey sign-in on a virtual authenticator) prove the decision.
