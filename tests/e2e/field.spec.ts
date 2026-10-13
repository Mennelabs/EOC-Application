/**
 * The field app's web build on a phone viewport (layer-4 plan §9; FLD-01,
 * FLD-03, FLD-13, FLD-14, FLD-16, ADR-0014): the seeded field lead of the
 * Field Exercise Team sets a PIN, checks in by the event code, saves a
 * quick report while offline ("On this phone") that is received once the
 * signal returns, presses the help button, and checks out. Every screen
 * passes axe WCAG 2.2 AA. The session comes from the development test
 * client (the browser sign-in itself is covered by the console journeys);
 * the app keeps it in sessionStorage exactly as after its own sign-in.
 */
import { expect, test } from '@playwright/test';
import { api, expectNoViolations, token } from './support/console.ts';

const LEAD = 'rowan.field@example.org';

test.describe('field app (web build)', () => {
  test.use({
    geolocation: { latitude: 38.7951, longitude: -90.871 },
    permissions: ['geolocation'],
  });

  test('check in, offline capture, help, check out', async ({ page, context }, testInfo) => {
    // One account and one shift: the phone project runs it; desktop has the console.
    test.skip(testInfo.project.name !== 'phone', 'field journey runs on the phone viewport');
    test.setTimeout(180_000);
    const accessToken = await token('county', LEAD);
    // A shift left open by an earlier run ends first.
    const open = (await api(accessToken, '/check-ins?mine=true')).body as {
      id: string;
      endedAt: string | null;
    }[];
    for (const c of open.filter((c) => !c.endedAt))
      await api(accessToken, `/check-ins/${c.id}/end`, { body: { reason: 'checked_out' } });
    await context.addInitScript((tok) => {
      sessionStorage.setItem(
        'cgf.session',
        JSON.stringify({
          realm: 'county',
          accessToken: tok,
          refreshToken: null,
          idToken: null,
          expiresAt: Date.now() + 240_000,
          endSession: null,
          tokenEndpoint: '/auth/realms/county/protocol/openid-connect/token',
        }),
      );
    }, accessToken);

    await page.goto('/field/');
    await expect(page.getByRole('heading', { name: 'Choose a PIN for this phone' })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
    await page.getByLabel('PIN (at least 6 digits)').fill('246810');
    await page.getByLabel('Enter the PIN again').fill('246810');
    await page.getByRole('button', { name: 'Save PIN' }).click();

    // FLD-03: check in by the event code.
    await expect(page.getByRole('heading', { name: 'Check in' })).toBeVisible({ timeout: 30_000 });
    await expectNoViolations(page);
    await page.getByLabel('Event code').fill('westwind');
    await page.getByRole('button', { name: 'Check in' }).click();
    await expect(page.getByRole('heading', { name: 'My shift' })).toBeVisible({ timeout: 30_000 });
    await expectNoViolations(page);

    // FLD-13: a quick report saved with no signal waits on the phone, then is received.
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Quick report' }).click();
    await expect(page.getByRole('heading', { name: 'Quick report' })).toBeVisible();
    await page.getByRole('radio', { name: 'gas leak' }).click();
    await page.getByRole('radio', { name: 'Dangerous' }).click();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByText(/Saved on this phone/)).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('link', { name: 'On this phone' }).click();
    await expect(page.getByRole('heading', { name: 'On this phone' })).toBeVisible();
    await expect(page.getByText('On this phone', { exact: true }).last()).toBeVisible();
    await expectNoViolations(page);
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByText(/Received|Nothing waiting/).first()).toBeVisible({
      timeout: 60_000,
    });

    // FLD-16: the help button asks once, then dispatch has the alert.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: /Need help/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Send a help alert to dispatch?' }),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Send help alert' }).click();
    await expect(page.getByText(/Dispatch has your help alert|Help alert saved/)).toBeVisible({
      timeout: 30_000,
    });
    // The exercise field coordinator clears it so the board journeys start quiet.
    const staff = await token('county', 'casey.dispatch@example.org');
    const alerts = (await api(staff, '/safety-alerts?open=true')).body as {
      id: string;
      kind: string;
    }[];
    for (const a of alerts.filter((a) => a.kind === 'help_button'))
      await api(staff, `/safety-alerts/${a.id}/acknowledge`, { body: {} });

    // FLD-14: check-out ends the shift and clears resident details from the phone.
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Check out' }).click();
    await expect
      .poll(
        async () =>
          (
            (await api(accessToken, '/check-ins?mine=true')).body as { endedAt: string | null }[]
          ).every((c) => c.endedAt !== null),
        { timeout: 30_000 },
      )
      .toBe(true);
  });
});
