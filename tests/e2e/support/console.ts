/**
 * Shared console test helpers: axe scan, API calls with a password-grant
 * token, the invitation email pick-up and the full onboarding journey
 * (invite, second-administrator approval, password, passkey, sign-in).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export const BASE = process.env['BASE_URL'] ?? 'https://localhost';
export const MAIL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';
export const PASSWORD = 'Westwind-Exercise-2026!';
// Node-side fetches in the test trust Caddy's development CA like the browser does.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

export async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

/** True once the element is visible, false after `ms`. `isVisible()` alone never waits. */
export async function appears(locator: Locator, ms: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout: ms }).then(
    () => true,
    () => false,
  );
}

export async function token(realm: string, user: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'cg-tests',
      client_secret: 'cg-tests-dev-secret',
      username: user,
      password: PASSWORD,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) {
    throw new Error(`no token for ${user}: ${res.status} ${body.error_description ?? ''}`);
  }
  return body.access_token;
}

export interface Call {
  method?: string;
  body?: unknown;
  version?: number;
  confirm?: string;
}

export async function api(tok: string, path: string, init: Call = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${tok}`,
    'idempotency-key': crypto.randomUUID(),
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.version !== undefined) headers['if-match'] = `"${init.version}"`;
  if (init.confirm) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = init.confirm;
  }
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[] };
}

export async function invitationLink(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const search = (await (
      await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as { messages: { ID: string }[] };
    const id = search.messages[0]?.ID;
    if (id) {
      const msg = (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()) as {
        Text: string;
        HTML: string;
      };
      const m = /https?:\/\/[^\s"<>]+login-actions\/action-token[^\s"<>]*/.exec(
        `${msg.Text}\n${msg.HTML}`,
      );
      if (m) return m[0].replace(/&amp;/g, '&');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no invitation email for ${email}`);
}

/**
 * Invites a fresh account through the API, has a second administrator
 * approve `roleKey`, then takes the browser through the invitation email,
 * password, passkey registration on a virtual authenticator and the console
 * sign-in. Returns the account's email. Each caller gets its own account, so
 * projects never race on a shared user (SEC-07, ADM-05 G6).
 */
export async function onboard(
  page: Page,
  context: BrowserContext,
  roleKey: string,
  displayName: string,
  tag: string,
): Promise<string> {
  const email = `e2e-${tag}-${Date.now().toString(36)}@example.org`;

  // Admin invites; a second administrator approves a role for the new account.
  const admin = await token('county', 'admin@example.org');
  const security = await token('county', 'security.admin@example.org');
  const invited = await api(admin, '/accounts/invite', {
    body: { email, displayName },
  });
  expect(invited.status).toBe(201);
  const accountId = invited.body['id'] as string;
  const activated = await api(admin, `/accounts/${accountId}/activate`, {
    method: 'POST',
    body: {},
    version: invited.body['version'] as number,
  });
  expect(activated.status).toBe(200);
  const roles = await api(admin, '/roles');
  const role = (roles.body as { id: string; key: string }[]).find((r) => r.key === roleKey)!;
  const request = await api(admin, '/permission-changes', {
    body: { kind: 'assign_role', accountId, roleId: role.id, scope: {} },
  });
  expect(request.status).toBe(201);
  const approved = await api(security, `/permission-changes/${request.body['id']}/approve`, {
    method: 'POST',
    version: request.body['version'] as number,
    confirm: `e2e onboarding ${tag}`,
  });
  expect(approved.status).toBe(200);

  // The worker created the identity and Keycloak sent the invitation.
  const link = await invitationLink(email);

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(link);
  // Keycloak confirms email links before acting on them.
  const proceed = page.getByRole('link', { name: /click here to proceed/i });
  if (await appears(proceed, 5_000)) await proceed.click();
  // Required action 1: set a password.
  await page.getByRole('textbox', { name: /new password/i }).fill(PASSWORD);
  await page.getByRole('textbox', { name: /confirm password/i }).fill(PASSWORD);
  await page
    .getByRole('button', { name: /submit|save|sign in/i })
    .first()
    .click();
  // Required action 2: register a passkey. The label prompt and the
  // "account updated" page with its way back arrive at the runner's pace,
  // so this handles whatever Keycloak shows until the console is reached.
  await page
    .getByRole('button', { name: /register|sign in with (security key|passkey)/i })
    .first()
    .click({ timeout: 15_000 });
  const label = page.getByRole('textbox', { name: /label|name/i });
  const back = page.getByRole('link', { name: /back to application/i });
  const atConsole = () => /^\/console\/?/.test(new URL(page.url()).pathname);
  let labelled = false;
  let wentBack = false;
  const deadline = Date.now() + 60_000;
  while (!atConsole() && Date.now() < deadline) {
    if (!labelled && (await label.isVisible())) {
      labelled = true;
      await label.fill('Exercise passkey');
      await page
        .getByRole('button', { name: /ok|save|submit|register/i })
        .first()
        .click();
    } else if (!wentBack && (await back.isVisible())) {
      wentBack = true;
      await back.click();
    }
    await page.waitForTimeout(500);
  }
  await page.waitForURL((u) => /^\/console\/?/.test(u.pathname), { timeout: 30_000 });

  // Sign in to the console: organization, then Keycloak (password + passkey) unless SSO carries over.
  const org = page.getByLabel('Organization');
  if (await appears(org, 10_000)) {
    await org.fill('county');
    await page.getByRole('button', { name: 'Continue' }).click();
    // Either Keycloak asks for credentials, or an SSO session lands us home.
    await Promise.any([
      page.waitForURL((u) => u.pathname.startsWith('/auth/realms/'), { timeout: 20_000 }),
      page.getByRole('heading', { name: 'Welcome' }).waitFor({ timeout: 20_000 }),
    ]);
    if (page.url().includes('/auth/realms/')) {
      await page.getByRole('textbox', { name: /username or email/i }).fill(email);
      await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD);
      await page.getByRole('button', { name: /sign in/i }).click();
      const useKey = page.getByRole('button', {
        name: /sign in with (security key|passkey)|authenticate/i,
      });
      if (await appears(useKey, 10_000)) await useKey.click();
    }
  }
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible({ timeout: 30_000 });
  return email;
}
