/**
 * Staff console (CON-01, SEC-07, BRD:FR-01.02, ACC-*): sign-in screen
 * accessibility, and the real onboarding journey: invited through the API,
 * invitation email picked up from the mail sink, password set and passkey
 * registered on a virtual authenticator (Chromium CDP), then the console
 * home shows the role a second administrator approved. Each run creates its
 * own account, so projects never race on a shared user.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BASE = process.env['BASE_URL'] ?? 'https://localhost';
const MAIL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';
const PASSWORD = 'Westwind-Exercise-2026!';
// Node-side fetches in the test trust Caddy's development CA like the browser does.
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

async function token(realm: string, user: string): Promise<string> {
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

interface Call {
  method?: string;
  body?: unknown;
  version?: number;
  confirm?: string;
}

async function api(tok: string, path: string, init: Call = {}) {
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

async function invitationLink(email: string): Promise<string> {
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

test.describe('console sign-in', () => {
  test('sign-in screen is accessible and asks only for the organization', async ({ page }) => {
    await page.goto('/console/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in');
    await expect(page.getByLabel('Organization')).toBeVisible();
    await expectNoViolations(page);
  });

  test('unknown organization gets a plain error, no stack trace', async ({ page }) => {
    await page.goto('/console/');
    await page.getByLabel('Organization').fill('no-such-realm');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('Unknown organization');
  });

  test('invited staff member: email link, password, passkey, then the console shows the approved role', async ({
    page,
    context,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'virtual authenticator needs Chromium CDP');
    // Once is enough: the journey is the same on every viewport, and parallel
    // runs would race on the shared administrator accounts.
    test.skip(testInfo.project.name !== 'desktop', 'runs on the desktop project only');
    test.setTimeout(120_000);
    const email = `e2e-${testInfo.project.name}-${Date.now().toString(36)}@example.org`;

    // Admin invites; a second administrator approves a role for the new account.
    const admin = await token('county', 'admin@example.org');
    const security = await token('county', 'security.admin@example.org');
    const invited = await api(admin, '/accounts/invite', {
      body: { email, displayName: 'E2E Planner' },
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
    const planner = (roles.body as { id: string; key: string }[]).find(
      (r) => r.key === 'planning_gis_lead',
    )!;
    const request = await api(admin, '/permission-changes', {
      body: { kind: 'assign_role', accountId, roleId: planner.id, scope: {} },
    });
    expect(request.status).toBe(201);
    const approved = await api(security, `/permission-changes/${request.body['id']}/approve`, {
      method: 'POST',
      version: request.body['version'] as number,
      confirm: 'e2e onboarding',
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
    if (await proceed.isVisible({ timeout: 3_000 }).catch(() => false)) await proceed.click();
    // Required action 1: set a password.
    await page.getByRole('textbox', { name: /new password/i }).fill(PASSWORD);
    await page.getByRole('textbox', { name: /confirm password/i }).fill(PASSWORD);
    await page
      .getByRole('button', { name: /submit|save|sign in/i })
      .first()
      .click();
    // Required action 2: register a passkey.
    await page
      .getByRole('button', { name: /register|sign in with (security key|passkey)/i })
      .first()
      .click({ timeout: 15_000 });
    const label = page.getByRole('textbox', { name: /label|name/i });
    if (await label.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await label.fill('Exercise passkey');
      await page
        .getByRole('button', { name: /ok|save|submit|register/i })
        .first()
        .click();
    }

    // Keycloak confirms the account update and offers the way back.
    const back = page.getByRole('link', { name: /back to application/i });
    if (await back.isVisible({ timeout: 10_000 }).catch(() => false)) await back.click();
    await page.waitForURL(/\/console\/?/, { timeout: 30_000 });

    // Sign in to the console: organization, then Keycloak (password + passkey) unless SSO carries over.
    const org = page.getByLabel('Organization');
    if (await org.isVisible({ timeout: 5_000 }).catch(() => false)) {
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
        if (await useKey.isVisible({ timeout: 8_000 }).catch(() => false)) await useKey.click();
      }
    }
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('planning_gis_lead')).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole('link', { name: 'Events' }).click();
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('link', { name: 'Permission changes' }).click();
    await expect(page.getByRole('alert')).toContainText('permission');
  });
});
