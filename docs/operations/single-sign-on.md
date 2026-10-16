# Single sign-on with the county's identity provider (SEC-07)

A county's staff can sign in with their county account, through the county's own identity provider. That can be Microsoft Entra ID, Okta, ADFS, Google Workspace or any SAML 2.0 or OpenID Connect provider. This page is for the county's administrators and its identity team.

## What changes for staff

- The sign-in page gets a button with the name the county chose, for example "Westwind County account". Pressing it takes the person to the county's own sign-in page.
- The county's sign-in replaces the password. **The person's passkey is still asked for** afterwards, on every sign-in. A person without a passkey registers one the first time.
- Only people the county has invited in **Staff accounts** can sign in this way. The county account and the invitation are matched on the work email address. Someone with a county account but no invitation sees "does not exist. Please contact your administrator", and no account is made for them.
- Accounts invited while single sign-on is on are asked only to register a passkey; there is no password to set. Invitations still waiting for a password when single sign-on comes on stop asking for one.
- Switching single sign-on off takes the button away. Staff then sign in with a password and their passkey; someone who never set a password uses "Forgot password?".

## Setting it up

1. In the console, open **Single sign-on**. Under "Give these to your identity provider" are:
   - the **Entity ID** (also called the audience, or identifier);
   - the **reply address**: the assertion consumer service URL for SAML, the redirect URI for OpenID Connect.
2. In the identity provider, register an application with those two values. It must send the person's **work email address**: as the SAML Name ID (format "email address"), or as the `email` claim for OpenID Connect. Assign the application to the staff who use the platform.
3. Back in the console, under "Propose a provider":
   - **SAML:** paste the provider's federation metadata (XML). Metadata with a document type declaration is refused. It must name the provider, its sign-in address and its signing certificate.
   - **OpenID Connect:** enter the issuer, authorization, token and signing-keys (JWKS) addresses from the provider's discovery document (all https), and the client ID and client secret. The secret is kept encrypted and never shown again.
4. Give a reason and confirm. **A second administrator approves it**: the person who proposed it cannot. Once approved, the screen says "Being put on the sign-in page", then "On the sign-in page since …" within a minute or so. If it cannot be applied (for example, metadata the identity service cannot read), the screen says why and the platform tries again.
5. Sign in once with a test account before telling staff.

Only one provider is in force at a time. Approving a newer one replaces it, and only one proposal waits at a time: decline it before proposing another. Every proposal, decision and switch-off is in the audit log with its reason. The metadata itself and the client secret are never written to the audit.

## What is checked

- SAML assertions must be signed, and the signature is checked against the certificate in the metadata. Sign-in requests to the provider are signed.
- OpenID Connect uses PKCE, and tokens are checked against the provider's published keys.
- A county sign-in never creates an account, and it never takes the place of the passkey.

## For the platform team

Keycloak holds the provider on the county's realm as `county-sso`. It uses two flows: `cg-first-broker` (link to an existing user by email; fail when none) and `cg-post-broker` (passkey required). The worker's `sso.apply` job reconciles the realm with what is in force (`services/worker/src/jobs/sso.ts`, `services/worker/src/idp/keycloak.ts`). ADR-0008 records the decision.
