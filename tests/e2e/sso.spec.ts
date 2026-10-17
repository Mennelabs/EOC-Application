/**
 * Single sign-on through the county's own identity provider (SEC-07, ADM-05,
 * plan reading 49). A second Keycloak realm stands in for the county's
 * identity provider (exercise only; a real county brings Entra ID, Okta,
 * ADFS or any SAML provider). An administrator proposes it on the Single
 * sign-on screen with its metadata; a second administrator approves; the
 * worker puts it on the county's sign-in page. An invited person then signs
 * in with the county account and registers a passkey on first use, so the
 * county's sign-in replaces the password and never the passkey. A county
 * user nobody invited is refused and no account is made. Switched off again
 * at the end.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  BASE,
  administrators,
  api,
  appears,
  expectNoViolations,
  expectReflow,
  invitationLink,
  onboard,
  token,
} from './support/console.ts';

const tag = Date.now().toString(36);
const IDP_REALM = `county-idp-${tag}`;
const IDP_PASSWORD = 'County-Idp-Exercise-2026!';
const BUTTON = `Westwind County account (exercise ${tag})`;
const invitee = `sso-${tag}@example.org`;
const stranger = `stranger-${tag}@example.org`;

/**
 * Development stack only: Keycloak's administration is not routed by the gateway (SEC-15), so
 * the test reaches it on the laptop's published port, with the administrator from the
 * environment or the generated .env.
 */
const IDP_ADMIN =
  process.env['IDP_ADMIN_URL'] ?? `http://127.0.0.1:${process.env['IDP_PORT'] ?? '8081'}/auth`;

function keycloakAdminPassword(): string {
  const fromEnv = process.env['KEYCLOAK_ADMIN_PASSWORD'];
  if (fromEnv) return fromEnv;
  const m = /^KEYCLOAK_ADMIN_PASSWORD=(.*)$/m.exec(readFileSync('.env', 'utf8'));
  if (!m) throw new Error('KEYCLOAK_ADMIN_PASSWORD is not in the environment or .env');
  return m[1]!.trim().replace(/^['"]|['"]$/g, '');
}

async function kc(method: string, path: string, body?: unknown): Promise<Response> {
  const t = await fetch(`${IDP_ADMIN}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'cg-admin',
      password: keycloakAdminPassword(),
    }),
  });
  const { access_token } = (await t.json()) as { access_token: string };
  return fetch(`${IDP_ADMIN}/admin/realms${path}`, {
    method,
    headers: {
      authorization: `Bearer ${access_token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** The stand-in county identity provider: its staff, and the county realm as a SAML client. */
async function standInIdp(sp: { entityId: string; redirectUri: string }) {
  expect(
    (await kc('POST', '', { realm: IDP_REALM, enabled: true, sslRequired: 'external' })).status,
  ).toBe(201);
  for (const [email, first] of [
    [invitee, 'Sam'],
    [stranger, 'Stranger'],
  ] as const)
    expect(
      (
        await kc('POST', `/${IDP_REALM}/users`, {
          username: email,
          email,
          emailVerified: true,
          enabled: true,
          firstName: first,
          lastName: 'Exercise',
          credentials: [{ type: 'password', value: IDP_PASSWORD, temporary: false }],
        })
      ).status,
    ).toBe(201);
  expect(
    (
      await kc('POST', `/${IDP_REALM}/clients`, {
        clientId: sp.entityId,
        protocol: 'saml',
        enabled: true,
        redirectUris: [`${sp.redirectUri}*`],
        attributes: {
          'saml.authnstatement': 'true',
          saml_name_id_format: 'email',
          'saml.force.name.id.format': 'true',
          'saml.client.signature': 'false',
          'saml.server.signature': 'true',
          'saml.assertion.signature': 'true',
          saml_assertion_consumer_url_post: sp.redirectUri,
          'saml.signature.algorithm': 'RSA_SHA256',
        },
      })
    ).status,
  ).toBe(201);
  return (await fetch(`${BASE}/auth/realms/${IDP_REALM}/protocol/saml/descriptor`)).text();
}

async function withPasskeys(context: BrowserContext, page: Page) {
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
}

/** Console → organization → the county's sign-in page → the county account. */
async function countySignIn(page: Page, email: string) {
  await page.goto('/console/');
  const org = page.getByLabel('Organization');
  if (await appears(org, 15_000)) {
    await org.fill('county');
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByRole('link', { name: BUTTON }).click({ timeout: 30_000 });
  await page.waitForURL((u) => u.pathname.includes(`/realms/${IDP_REALM}/`), { timeout: 30_000 });
  await page.getByRole('textbox', { name: /username or email/i }).fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(IDP_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
}

test.describe('single sign-on through the county identity provider (SEC-07)', () => {
  test.describe.configure({ mode: 'serial' });

  test('proposed, approved by a second administrator, then an invited person signs in with the county account and a passkey', async ({
    page,
    context,
    browser,
  }, testInfo) => {
    // One county realm, one provider: the journey runs once (the screen reflows at 320 px below).
    test.skip(testInfo.project.name !== 'desktop', 'runs once, on the desktop project');
    test.setTimeout(300_000);
    const admins = administrators('county');
    const security = await token('county', admins.security);
    const adminToken = await token('county', admins.admin);
    const sp = (await api(adminToken, '/sso')).body['serviceProvider'] as {
      entityId: string;
      redirectUri: string;
    };
    const metadata = await standInIdp(sp);
    try {
      // An administrator proposes the provider on the screen.
      await onboard(page, context, 'tenant_admin', 'Exercise SSO Administrator', `sso${tag}`);
      await page.goto('/console/sso');
      await expect(page.getByRole('heading', { level: 1, name: 'Single sign-on' })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(sp.redirectUri, { exact: true })).toBeVisible();
      await page.getByLabel('Sign-in button').fill(BUTTON);
      await page.getByLabel('Identity provider metadata (XML)').fill(metadata);
      await expectNoViolations(page);
      await page.getByRole('button', { name: 'Propose single sign-on' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Reason').fill('Exercise: staff sign in with the county account');
      await dialog.getByRole('button', { name: 'Confirm' }).click();
      await expect(page.getByText(`${BUTTON} is proposed`)).toBeVisible();
      // The one who proposed it cannot approve it (ADM-05).
      await expect(page.getByText('You proposed it, so another administrator')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve single sign-on' })).toHaveCount(0);

      // The security administrator approves; the worker puts it on the sign-in page.
      const waiting = (await api(security, '/sso')).body['proposed'] as {
        id: string;
        version: number;
      };
      const approved = await api(security, `/sso/${waiting.id}/approve`, {
        method: 'POST',
        version: waiting.version,
        confirm: 'Exercise: second administrator approves the county sign-in',
      });
      expect(approved.status).toBe(200);
      await expect
        .poll(
          async () =>
            ((await api(security, '/sso')).body['active'] as { appliedAt: string | null })
              ?.appliedAt,
          { timeout: 60_000 },
        )
        .not.toBeNull();
      await page.reload();
      await expect(page.getByText(/On the sign-in page since/)).toBeVisible({ timeout: 30_000 });
      await expectNoViolations(page);
      await page.setViewportSize({ width: 320, height: 800 });
      await expectReflow(page);

      // The county invites Sam (no password to set: the county signs Sam in).
      const invited = await api(adminToken, '/accounts/invite', {
        body: { email: invitee, displayName: 'Sam Exercise' },
      });
      expect(invited.status).toBe(201);
      let activated = await api(adminToken, `/accounts/${invited.body['id']}/activate`, {
        method: 'POST',
        body: {},
        version: invited.body['version'] as number,
      });
      for (let i = 0; i < 5 && activated.status === 409; i++) {
        const current = await api(adminToken, `/accounts/${invited.body['id']}`);
        activated = await api(adminToken, `/accounts/${invited.body['id']}/activate`, {
          method: 'POST',
          body: {},
          version: current.body['version'] as number,
        });
      }
      expect(activated.status).toBe(200);
      // The worker made Sam's identity and Keycloak sent the passkey-only invitation.
      expect(await invitationLink(invitee)).toContain('action-token');

      // Sam signs in with the county account, then registers a passkey on first use.
      const sam = await browser.newContext({ ignoreHTTPSErrors: true });
      const samPage = await sam.newPage();
      await withPasskeys(sam, samPage);
      await countySignIn(samPage, invitee);
      const register = samPage.getByRole('button', { name: /register/i }).first();
      await register.click({ timeout: 30_000 });
      const label = samPage.getByRole('textbox', { name: /label|name/i });
      if (await appears(label, 5_000)) {
        await label.fill('Exercise passkey');
        await samPage
          .getByRole('button', { name: /ok|save|submit|register/i })
          .first()
          .click();
      }
      // The console home: its heading reads "Situation" or "Your work" by role (ADR-0045).
      await expect(samPage.locator('main h1#home-h')).toBeVisible({
        timeout: 60_000,
      });
      await sam.close();

      // A county user nobody invited is refused, and no account is made.
      const other = await browser.newContext({ ignoreHTTPSErrors: true });
      const otherPage = await other.newPage();
      await withPasskeys(other, otherPage);
      await countySignIn(otherPage, stranger);
      await expect(otherPage.getByText(/does not exist|contact your administrator/i)).toBeVisible({
        timeout: 30_000,
      });
      await other.close();
      const accounts = (await api(adminToken, `/accounts?q=${encodeURIComponent(stranger)}`)).body;
      expect(JSON.stringify(accounts)).not.toContain(stranger);
    } finally {
      // Switched off again; the stand-in identity provider goes.
      const state = (await api(security, '/sso')).body as unknown as {
        active: { id: string; version: number } | null;
        proposed: { id: string; version: number } | null;
      };
      if (state.active)
        await api(security, `/sso/${state.active.id}/disable`, {
          method: 'POST',
          version: state.active.version,
          confirm: 'Exercise over: county sign-in switched off',
        });
      if (state.proposed)
        await api(security, `/sso/${state.proposed.id}/decline`, {
          method: 'POST',
          version: state.proposed.version,
          confirm: 'Exercise over',
        });
      await kc('DELETE', `/${IDP_REALM}`);
    }
  });
});
