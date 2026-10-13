/**
 * Helpers shared by the integration and e2e suites. The stack is "up" when
 * `docker compose up --wait` returns, but the worker then provisions the
 * synthetic tenants (realms, the development test client, the cast
 * accounts) through the outbox for a minute or two. Tests that sign in
 * before that see "Invalid client" or "Invalid user credentials", so both
 * suites wait here first (SCL-11; development test client only).
 */
export const STACK_URL = process.env['STACK_URL'] ?? process.env['BASE_URL'] ?? 'https://localhost';
export const DEV_PASSWORD = 'Westwind-Exercise-2026!';

/** Cast accounts the suites sign in with (realm slug = tenant key). */
export const CAST_ACCOUNTS: ReadonlyArray<readonly [realm: string, user: string]> = [
  ['county', 'admin@example.org'],
  ['county', 'security.admin@example.org'],
  ['county', 'dana.director@example.org'],
  ['county', 'priya.assessment@example.org'],
  ['county', 'marcus.gis@example.org'],
  ['county', 'tomas.pio@example.org'],
  ['county', 'luis.masscare@example.org'],
  ['county', 'keisha.afn@example.org'],
  ['state', 'state.liaison@example.org'],
  // Partner organizations (layer 3): their realms are provisioned the same way.
  ['canteen', 'ruth.canteen@example.org'],
  ['shelter-ngo', 'nurse@example.org'],
  ['coad', 'jen.coad@example.org'],
  // Their administrators (ADM-02, decision 2026-10-13), who onboard their own staff.
  ...(['coad', 'canteen', 'shelter-ngo', 'cleanup', 'legal'] as const).flatMap(
    (realm) =>
      [
        [realm, `admin.${realm}@example.org`],
        [realm, `security.${realm}@example.org`],
      ] as const,
  ),
];

async function canSignIn(realm: string, user: string): Promise<boolean> {
  try {
    const res = await fetch(`${STACK_URL}/auth/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'cg-tests',
        client_secret: 'cg-tests-dev-secret',
        username: user,
        password: DEV_PASSWORD,
      }),
    });
    const body = (await res.json()) as { access_token?: string };
    return Boolean(body.access_token);
  } catch {
    return false;
  }
}

/**
 * Resolves once every cast account can obtain a token, or throws after
 * `timeoutMs` naming the accounts still missing.
 */
export async function waitForProvisioning(timeoutMs = 300_000): Promise<void> {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // Caddy's local CA, development only.
  const pending = new Set(CAST_ACCOUNTS.map(([realm, user]) => `${user}@${realm}`));
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    for (const [realm, user] of CAST_ACCOUNTS) {
      const key = `${user}@${realm}`;
      if (pending.has(key) && (await canSignIn(realm, user))) pending.delete(key);
    }
    if (pending.size === 0) break;
    if (Date.now() > deadline) {
      throw new Error(
        `stack at ${STACK_URL} not provisioned after ${timeoutMs / 1000}s; still missing: ${[...pending].join(', ')}. ` +
          'Is the worker running? `docker compose logs worker`',
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
