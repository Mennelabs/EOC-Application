/**
 * Staff console (CON-01, SEC-07, BRD:FR-01.02, ACC-*): sign-in screen
 * accessibility, and the real onboarding journey: invited through the API,
 * invitation email picked up from the mail sink, password set and passkey
 * registered on a virtual authenticator (Chromium CDP), then the console
 * home shows the role a second administrator approved. Each run creates its
 * own account, so projects never race on a shared user.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

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

/** True once the element is visible, false after `ms`. `isVisible()` alone never waits. */
async function appears(locator: Locator, ms: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout: ms }).then(
    () => true,
    () => false,
  );
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

/**
 * Invites a fresh account through the API, has a second administrator
 * approve `roleKey`, then takes the browser through the invitation email,
 * password, passkey registration on a virtual authenticator and the console
 * sign-in. Returns the account's email. Each caller gets its own account, so
 * projects never race on a shared user (SEC-07, ADM-05 G6).
 */
async function onboard(
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
    await onboard(page, context, 'planning_gis_lead', 'E2E Planner', 'planner');
    await expect(page.getByText('planning_gis_lead')).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole('link', { name: 'Events' }).click();
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('link', { name: 'Permission changes' }).click();
    await expect(page.getByRole('alert')).toContainText('permission');
  });
});

test.describe('console review (CON-02, CON-05, BRD:FR-12, DCL:DEC-02/03, AIG-01, GATE-03)', () => {
  test('review journey: queue → report → decision with confirmation; intake setup, assisted entry and the AI register are accessible', async ({
    page,
    context,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'virtual authenticator needs Chromium CDP');
    test.skip(testInfo.project.name !== 'desktop', 'runs on the desktop project only');
    test.setTimeout(240_000);

    // A resident's web report for the queue; the worker files it while the reviewer signs in.
    const graph = (await (await fetch(`${BASE}/api/public/intake/county/westwind`)).json()) as {
      graph: { key: string; version: number };
    };
    const executionId = crypto.randomUUID();
    const n = Date.now() % 9000;
    const submitted = await fetch(`${BASE}/api/public/intake/county/westwind/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': executionId },
      body: JSON.stringify({
        executionId,
        channel: 'web',
        language: 'en',
        graphKey: graph.graph.key,
        graphVersion: graph.graph.version,
        relationship: 'own_home',
        answers: {
          danger_now: { kind: 'value', value: 'no' },
          relationship: { kind: 'value', value: 'own_home' },
          address: {
            kind: 'value',
            value: { line1: `${n} Console Ct`, city: 'Westwind', postal: '63001' },
          },
          home_type: { kind: 'value', value: 'house' },
          cause: { kind: 'value', value: 'wind_tornado' },
          damage_types: { kind: 'value', value: ['roof'] },
          roof_state: { kind: 'value', value: 'large_hole' },
          habitable: { kind: 'value', value: 'no' },
          tonight: { kind: 'value', value: 'yes' },
          insurance: { kind: 'unknown' },
          contact_name: { kind: 'value', value: 'Rosa Delgado' },
          contact: { kind: 'value', value: { phone: `314555${1000 + n}`, preferred: 'text' } },
        },
        needs: ['shelter_tonight'],
        consent: {},
      }),
    });
    expect(submitted.status).toBe(202);
    const code = ((await submitted.json()) as { referenceCode: string }).referenceCode;

    await onboard(page, context, 'damage_assessment_coordinator', 'E2E Reviewer', 'reviewer');

    // Queue: need signals first, filter by reference, every row a link (CON-05, PHO-14).
    await page.getByRole('link', { name: 'Review queue' }).click();
    await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
    await page.getByLabel('Reference number').fill(code);
    const row = page.getByRole('link', { name: code });
    for (let i = 0; i < 30 && !(await appears(row, 2_000)); i++) {
      await page.getByRole('button', { name: 'Apply' }).click();
    }
    await expect(row).toBeVisible();
    await expectNoViolations(page);

    // Detail: answers as the resident gave them, the FEMA matrix, no notes to the resident.
    await row.click();
    await expect(page.getByRole('heading', { name: `Report ${code}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Answers' })).toBeVisible();
    await expect(page.getByText('Rosa Delgado')).toBeVisible(); // the role holds the contact category
    await expectNoViolations(page);

    // Claim, then approve: the server asks for confirmation and a reason (RULE-14, FR-12.02).
    await page.getByRole('button', { name: 'Start review' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'under review' })).toBeVisible();
    const decide = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Record decision' }),
    });
    await decide.getByLabel('Decision').selectOption('approve');
    await decide.getByLabel('Reason').fill('Photos and answers agree.');
    await decide.getByRole('button', { name: 'Record decision' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Please confirm' })).toBeVisible();
    await expectNoViolations(page);
    await dialog.getByLabel('Reason').fill('Photos and answers agree.');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Done: approve' })).toBeVisible();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();

    // The other layer-2 console screens, each scanned (GATE-03).
    for (const name of ['Intake setup', 'Assisted report', 'AI use register']) {
      await page.getByRole('link', { name }).click();
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      await expectNoViolations(page);
    }
    await expect(page.getByText(/Kiosk \/ assisted link/)).toBeVisible();
    await expect(page.getByRole('img', { name: /Code that opens/ })).toBeVisible();
  });
});
