# ADR-0038: The enclave's screens are its own web app on its own address; the console only links

- Status: accepted (default in force; layer-5 plan §14 question 1 for Adam)
- Date: 2026-10-14
- Requirements: SEC-12, ADM-05, SEC-07, GATE-03, WCAG 2.2 AA, CJIS Security Policy AC-8 and AC-11, ADR-0013, ADR-0021

## Decision

The enclave's screens are a separate React app, `apps/web-cjis`, built into the `cjis-web` image and served only by `cjis-gateway` at `https://localhost:8443` (in the cloud, the enclave's own host name). It signs in with PKCE against realm `cjis`, talks only to the enclave API on the same origin, and keeps tokens in memory and this tab's session storage, never in local storage. Its gateway sends a strict content security policy (`connect-src 'self'`, no inline scripts), `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`.

The console holds no criminal-justice information. On a mission it shows a "Law enforcement (CJIS)" panel: "Restricted: CJIS" for anyone who can read the mission; for holders of `mission.cji.open`, a new-tab link (`rel="noopener noreferrer"`) to `/records/<cji_ref>?mission=<reference>&county=<slug>` on the enclave's address; for holders of `mission.cji.link`, a "Link to the CJIS enclave" action with a reason (RULE-14). Phones, partners and the public never see the marker.

The enclave app shows the system use notification before sign-in (AC-8), locks after 30 minutes without activity and hides the screen while ending the session (AC-11), and offers workspaces by enclave role: records, accounts and screening, approvals by a second administrator, audit review and retention. It uses the console's accessibility building blocks and is checked with axe on every screen.

## Alternatives considered

| Option                                                         | Why not                                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| An enclave panel inside the console, fetching from the enclave | CJI would be handled by the console's origin, its scripts, storage and error reporting; the platform would be in CJIS scope. |
| An iframe of the enclave inside the console                    | Framing invites clickjacking and shared-session confusion; the enclave forbids framing.                                      |
| The console proxies enclave calls                              | CJI would pass through the platform's API and logs (ADR-0021).                                                               |

## Why it fits SCL-11 and the government-cloud move

`cjis-web` is static files in a Caddy image that moves with the enclave to its authorized account; the console's link takes the enclave address from `CJIS_PUBLIC_URL`.

## Consequences

A liaison works in two browser tabs with two sign-ins. The enclave app is English only, like the console (staff screens); Spanish follows the console. `tests/e2e/cjis.spec.ts` and `tests/e2e/console-l5.spec.ts` cover the journeys with axe on desktop and phone; screen-reader passes are recorded by a person in `docs/a11y/screens/cjis-enclave.md`.
