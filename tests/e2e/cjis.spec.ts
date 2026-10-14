/**
 * The CJIS enclave in a browser (layer 5; SEC-12, SEC-07, ADM-05, PPL-01,
 * BRD:FR-07, AC-8, AC-11, GATE-03). Each run onboards its own enclave account
 * the way an agency does (an administrator creates it and records screening,
 * a second administrator approves the role, activation hands over a one-time
 * password), so the passkey registered on this browser's virtual
 * authenticator is the account's only one. Then the person reads the system
 * use notification, signs in (password change and passkey registration at
 * first sign-in), opens a mission's enclave record from a console-style link
 * and records people, a weapon, a body-camera reference, a narrative and the
 * disposition. Axe runs on every enclave screen. Synthetic data only.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appears, expectNoViolations } from './support/console.ts';
import { CJIS, CJIS_URL, enclaveApi, enclaveToken } from '../support/cjis.ts';

const NEW_PASSWORD = 'Enclave-Exercise-Passphrase-2026!';

async function onboardEnclaveAccount(tag: string): Promise<{ email: string; password: string }> {
  const email = `e2e-${tag}-${Date.now().toString(36)}@sheriff.example.org`;
  const admin = await enclaveToken(CJIS.admin);
  const security = await enclaveToken(CJIS.security);
  const created = await enclaveApi(admin, '/accounts', {
    body: { email, displayName: `E2E Deputy ${tag}` },
  });
  expect(created.status).toBe(201);
  const id = created.body['id'] as string;
  const today = new Date().toISOString().slice(0, 10);
  const screened = await enclaveApi(admin, `/accounts/${id}/screening`, {
    body: {
      fingerprintStatus: 'cleared',
      fingerprintAdjudicatedOn: today,
      trainingCompletedOn: today,
    },
    version: created.body['version'] as number,
  });
  expect(screened.status).toBe(200);
  const request = await enclaveApi(admin, '/permission-requests', {
    body: { personId: id, role: 'officer', change: 'grant', reason: `e2e ${tag}` },
  });
  expect(request.status).toBe(201);
  const approved = await enclaveApi(
    security,
    `/permission-requests/${request.body['id'] as string}/approve`,
    {
      method: 'POST',
      version: request.body['version'] as number,
      confirm: `Second administrator approves e2e ${tag}`,
    },
  );
  expect(approved.status).toBe(200);
  const account = await enclaveApi(admin, `/accounts/${id}`);
  const activated = await enclaveApi(admin, `/accounts/${id}/activate`, {
    method: 'POST',
    version: account.body['version'] as number,
    confirm: 'Handed over in person (e2e)',
  });
  expect(activated.status).toBe(200);
  // The enclave worker creates the identity from the outbox.
  await expect
    .poll(
      async () => (await enclaveApi(admin, `/accounts/${id}`)).body['identityState'] as string,
      { timeout: 60_000 },
    )
    .toBe('created');
  return { email, password: activated.body['temporaryPassword'] as string };
}

async function virtualPasskey(context: BrowserContext, page: Page) {
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

/** First sign-in: notification, password, new password, passkey registration, back to the app. */
async function firstSignIn(page: Page, email: string, password: string) {
  await page.goto(`${CJIS_URL}/`);
  await expect(page.getByRole('heading', { name: 'System use notification' })).toBeVisible();
  await expectNoViolations(page);
  await page.getByRole('button', { name: /I understand: sign in/ }).click();
  // Keycloak's own pages: its field ids are stable across themes.
  await page.locator('#username').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('#password-new').fill(NEW_PASSWORD);
  await page.locator('#password-confirm').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: /submit/i }).click();
  await page
    .getByRole('button', { name: /register|sign in with (security key|passkey)/i })
    .first()
    .click({ timeout: 15_000 });
  const labelBox = page.getByRole('textbox', { name: /label|name/i });
  const back = page.getByRole('link', { name: /back to application/i });
  const atApp = () => new URL(page.url()).origin === CJIS_URL && !page.url().includes('/auth/');
  const deadline = Date.now() + 60_000;
  let labelled = false;
  while (!atApp() && Date.now() < deadline) {
    if (!labelled && (await labelBox.isVisible())) {
      labelled = true;
      await labelBox.fill('Exercise passkey');
      await page
        .getByRole('button', { name: /ok|save|submit|register/i })
        .first()
        .click();
    } else if (await back.isVisible()) {
      await back.click();
    }
    await page.waitForTimeout(500);
  }
  // The registration session proved the password only; the enclave refuses it (fail closed,
  // ADR-0036) and asks for a sign-in with the passkey itself.
  await page.getByRole('button', { name: 'Sign in with your passkey' }).click({ timeout: 30_000 });
  // Re-authentication keeps the username, read-only; only the password is asked again.
  await page.locator('#password').waitFor({ timeout: 15_000 });
  const username = page.locator('#username');
  if ((await username.count()) > 0) await username.fill(email);
  await page.locator('#password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  // The virtual authenticator answers the passkey step; Keycloak may ask for a click first.
  const usePasskey = page.getByRole('button', { name: /sign in with (security key|passkey)/i });
  if (await appears(usePasskey, 5_000)) await usePasskey.click();
  await expect(page.getByText(/Westwind County Sheriff’s Office \(exercise\)/).first()).toBeVisible(
    {
      timeout: 30_000,
    },
  );
}

test.describe('CJIS enclave (SEC-12)', () => {
  test('an onboarded officer signs in with a passkey and records a mission’s law-enforcement details', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { email, password } = await onboardEnclaveAccount(testInfo.project.name);
    await virtualPasskey(context, page);
    await firstSignIn(page, email, password);
    await expectNoViolations(page);

    // The console's link: an opaque reference and the declared mission.
    const ref = `E2E${testInfo.project.name}${Date.now().toString(36)}`
      .padEnd(43, 'x')
      .slice(0, 43);
    await page.goto(`${CJIS_URL}/records/${ref}?mission=M-09901&county=county`);
    await expect(page.getByRole('heading', { name: 'Mission M-09901' })).toBeVisible();
    await page.getByLabel('Classification').selectOption('looting');
    await page.getByRole('button', { name: 'Create the enclave record' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Enclave record created' }),
    ).toBeVisible();
    await expectNoViolations(page);

    // People involved, a weapon, a body-camera reference (PPL-01, BRD:FR-04.01, BRD:FR-07.04).
    const people = page
      .getByRole('region', { name: 'People involved' })
      .or(page.locator('section', { has: page.getByRole('heading', { name: 'People involved' }) }));
    await page.getByLabel('Role', { exact: true }).selectOption('suspect');
    await page.getByLabel('Name', { exact: true }).fill('Exercise Person E2E');
    await page.getByRole('button', { name: 'Add the person' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Person added' })).toBeVisible();
    await expect(people.getByText('Exercise Person E2E').first()).toBeVisible();

    await page.getByLabel('Serial number', { exact: true }).fill('EX-SN-0001');
    await page.getByRole('button', { name: 'Add the weapon' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Weapon added' })).toBeVisible();

    await page.getByLabel('Camera', { exact: true }).fill('BWC-E2E');
    await page.getByLabel('Evidence reference', { exact: true }).fill('EX-EVIDENCE-E2E');
    await page.getByRole('button', { name: 'Add the reference' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Body-camera reference added' }),
    ).toBeVisible();

    await page
      .getByLabel('Text', { exact: true })
      .fill('Exercise narrative written in the browser test.');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Narrative added' })).toBeVisible();
    await expectNoViolations(page);
    // ACC-07: the record page reflows at phone width without a horizontal page scroll.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);

    // The disposition asks for a reason in the confirmation dialog (RULE-14) and closes the record.
    await page
      .getByRole('combobox', { name: 'Disposition', exact: true })
      .selectOption('arrest_made');
    await page.getByRole('button', { name: 'Record the disposition' }).click();
    const dialog = page.getByRole('dialog', { name: 'Please confirm' });
    await expect(dialog).toBeVisible();
    await expectNoViolations(page);
    await dialog.getByLabel('Reason').fill('Exercise arrest recorded in the browser test');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Disposition recorded; the record is closed' }),
    ).toBeVisible();
    await expect(page.getByText(/Arrest made by E2E Deputy/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add the person' })).toHaveCount(0);

    // AC-11: after the idle limit the app locks, hides the content and ends the session.
    await page.evaluate(() => sessionStorage.setItem('cjis.idleSeconds', '3'));
    await page.reload();
    await expect(page.getByRole('heading', { name: /Mission M-09901/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Exercise Person E2E')).toHaveCount(0);
    await expectNoViolations(page);
  });

  test('an officer whose training has lapsed sees what is missing and no records', async ({
    page,
  }) => {
    // Through the API: the browser flow would ask this exercise account for a passkey.
    const tok = await enclaveToken(CJIS.lapsed);
    const me = await enclaveApi(tok, '/me');
    expect(me.body).toMatchObject({ qualified: false, missing: ['security_training'] });
    const records = await enclaveApi(tok, '/records');
    expect(records.status).toBe(403);
    // The notification is public and readable without signing in.
    await page.goto(`${CJIS_URL}/`);
    expect(await appears(page.getByText(/criminal justice information system/), 10_000)).toBe(true);
  });
});
