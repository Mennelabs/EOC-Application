/**
 * The field app's web build on a phone viewport (layer-4 plan §9; FLD-01,
 * FLD-03, FLD-08, FLD-13, FLD-14, FLD-16, DCL:DEC-17, ADR-0014): the seeded
 * field lead of the Field Exercise Team sets a PIN, checks in by the event
 * code, saves a quick report while offline ("On this phone") that is
 * received once the signal returns, records a damage assessment with the
 * details FEMA asks for, presses the help button, and checks out. Every screen
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

    // FLD-08, DCL:DEC-17: an assessment with the damage seen and the details FEMA asks for
    // (depth in feet and inches, renter, flood insurance, utilities out) is received as entered;
    // a depth that is not one is named back and blocks saving.
    const tag = `e2e assessment ${Date.now()}`;
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'New property' }).click();
    await expect(page.getByRole('heading', { name: 'Find the property' })).toBeVisible();
    const thisOne = page.getByRole('button', { name: 'Yes, this one' });
    const landmarkInstead = page.getByRole('button', { name: 'Add a landmark note instead' });
    await expect(thisOne.or(landmarkInstead).first()).toBeVisible({ timeout: 30_000 });
    const atParcel = await thisOne.isVisible();
    await (atParcel ? thisOne : landmarkInstead).click();
    await expect(page.getByRole('heading', { name: 'Damage at this property' })).toBeVisible();
    if (!atParcel) await page.getByLabel('Landmark note').fill('Exercise: blue shed by the levee');
    await page.getByRole('radio', { name: /^Minor/ }).click();
    await page.getByRole('checkbox', { name: 'Roof', exact: true }).click();
    await page.getByLabel('Basement, feet').fill('5');
    await page.getByLabel('Basement, inches').fill('10');
    await page.getByLabel('Crawl space, inches').fill('14');
    await expect(page.getByText(/Crawl space: enter feet, and 0 to 11 inches/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Crawl space, inches').fill('4');
    await page.getByRole('radio', { name: 'Renter' }).click();
    await page.getByRole('checkbox', { name: 'Flood', exact: true }).click();
    await page
      .getByRole('radiogroup', { name: 'Is power, water or gas out?' })
      .getByRole('radio', { name: 'Yes' })
      .click();
    await page.getByLabel('Note (optional)').fill(tag);
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Saved on this phone/)).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('link', { name: 'On this phone' }).click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect
      .poll(
        async () => {
          const list = (await api(accessToken, '/field-assessments?limit=20')).body as {
            note: string | null;
            degree: string;
            observations: Record<string, unknown>;
          }[];
          return list.find((a) => a.note === tag) ?? null;
        },
        { timeout: 60_000 },
      )
      .toMatchObject({
        degree: 'minor',
        observations: {
          seen: ['roof'],
          flood_depth_basement_in: 70,
          flood_depth_crawl_space_in: 4,
          occupancy: 'rent',
          insurance: ['flood'],
          utilities_out: 'yes',
        },
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
      version: number;
      kind: string;
    }[];
    for (const a of alerts.filter((a) => a.kind === 'help_button'))
      await api(staff, `/safety-alerts/${a.id}/acknowledge`, { body: {}, version: a.version });

    // FLD-14: check-out ends the shift and clears resident details from the phone.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'My shift' })).toBeVisible({ timeout: 30_000 });
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
