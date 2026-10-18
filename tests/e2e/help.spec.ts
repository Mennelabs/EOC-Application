/**
 * Public "Find help" page (PUB-07, PUB-02/04/15, A11Y-01, GATE-03/04/06):
 * no sign-in, list first, English and Spanish, searchable by ZIP, keyboard
 * reachable, printable, reflows at 320 px, no axe violations; the optional
 * map loads only on request and never replaces the list.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { administrators, api, token } from './support/console.ts';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoViolations(page: import('@playwright/test').Page) {
  // A colour mid-transition is what a person sees for a frame, not a state: running
  // transitions and animations finish before the scan (motion is 120 ms, ADR-0045;
  // looping ones are skipped, and nothing waits more than a second).
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((r) => setTimeout(r, 1000)),
    ]),
  );
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test.describe('find help', () => {
  test('lists open sites first, in English, with no sign-in and no axe violations', async ({
    page,
  }) => {
    await page.goto('/county/help');
    await expect(page.getByRole('heading', { level: 1, name: 'Find help' })).toBeVisible();
    await expect(page.getByText('call 911')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open sites' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Harmon High School gym/ })).toBeVisible();
    await expect(page.getByText('Safe Harbor')).toHaveCount(0);
    await expect(page.getByText('never decides who is eligible')).toBeVisible();
    await expectNoViolations(page);
  });

  test('CMD-19, ACC-31: the ask box beside the list finds a shelter and points to the verified status check, never the report', async ({
    page,
  }) => {
    await page.goto('/county/help');
    const ask = page.getByLabel('Ask a question');
    await ask.fill('Where can I sleep tonight? I need a shelter');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = page.locator('.ask-answer');
    await expect(answer).toContainText('Here is what we found');
    await expect(answer.getByRole('link', { name: /Harmon High School gym/ })).toBeVisible();
    await expect(answer.getByRole('link', { name: /Safe Harbor/ })).toHaveCount(0);
    await ask.fill('What is the status of my report?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(
      answer.getByRole('link', { name: 'Check your report (we confirm it is you first)' }),
    ).toBeVisible();
    // The list is still there: the ask box never replaces it (AC-A08).
    await expect(page.getByRole('heading', { name: 'Open sites' })).toBeVisible();
    await expectNoViolations(page);
  });

  test('REC-01: a place offered through the public form reaches the county approval queue, and nothing is echoed back', async ({
    page,
  }) => {
    const name = `Exercise Grange Hall ${Date.now().toString(36)}`;
    await page.goto('/county/help');
    await page.getByRole('link', { name: /Offer it to the county/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Offer a place for disaster use' }),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.getByLabel('Name of the place').fill(name);
    await page.getByLabel('Kind of place').selectOption('community_center');
    await page.getByLabel('Street address').fill('3 Grange Rd');
    await page.getByLabel('City').fill('Westwind');
    await page.getByLabel('Usable floor space (square feet)').fill('4000');
    await page
      .getByRole('group', { name: 'Accessible to wheelchair users?' })
      .getByRole('radio', { name: 'Yes' })
      .check();
    await page.getByLabel('Your name').fill('Exercise Grange Secretary');
    await page.getByLabel('Email').fill('grange@example.org');
    await page.getByLabel('I am allowed to offer this place for disaster use.').check();
    await page.getByRole('button', { name: 'Send the offer' }).click();
    await expect(page.getByText('Thank you. The county will review the offer')).toBeVisible();
    await expect(page.getByText('Exercise Grange Secretary')).toHaveCount(0);
    const admin = await token('county', administrators('county').admin);
    const queue = (await api(admin, '/facility-changes')).body as unknown as {
      facilityName: string | null;
      source: string;
    }[];
    expect(queue.find((c) => c.facilityName === name)?.source).toBe('self_registration');
  });

  test('REC-01: the owner opens the re-check link, sees what the county has, and says nothing changed', async ({
    page,
  }) => {
    // The link's two calls are answered in the browser here; the database test covers the
    // real link (facilities.db.test.ts): single use, expiry, the approval queue.
    const token = 'A'.repeat(43);
    let sent: unknown = null;
    await page.route(`**/api/public/facilities/county/update/${token}*`, (route) => {
      if (route.request().method() === 'POST') {
        sent = route.request().postDataJSON();
        return route.fulfill({
          status: 202,
          json: { received: true, message: 'Thank you.' },
        });
      }
      return route.fulfill({
        json: {
          name: 'Exercise Lakeside Lodge',
          kind: 'commercial',
          address: { line1: '9 Lake Rd', city: 'Westwind', postal: '63003' },
          sqft: 5000,
          ada: true,
          powerBackup: 'generator',
          kitchen: true,
          showers: null,
          parkingSpaces: 40,
          truckAccess: null,
        },
      });
    });
    await page.goto(`/county/help?view=offer&update=${token}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Check your place in the facility registry' }),
    ).toBeVisible();
    await expect(page.getByLabel('Name of the place')).toHaveValue('Exercise Lakeside Lodge');
    await expect(page.getByLabel('Usable floor space (square feet)')).toHaveValue('5000');
    await expect(
      page
        .getByRole('group', { name: 'Accessible to wheelchair users?' })
        .getByRole('radio', { name: 'Yes' }),
    ).toBeChecked();
    await expectNoViolations(page);
    await page.getByLabel('Your name').fill('Exercise Owner');
    await page.getByLabel('Email').fill('lodge@example.org');
    await page.getByLabel('I am allowed to update the details of this place.').check();
    await page.getByRole('button', { name: 'Nothing has changed' }).click();
    await expect(page.getByText('The county will mark the entry as checked.')).toBeVisible();
    expect(sent).toMatchObject({ unchanged: true, submitter: { name: 'Exercise Owner' } });
    expect(sent).not.toHaveProperty('facility');
  });

  test('REC-01: a spent or expired re-check link says so and points back', async ({ page }) => {
    await page.goto(`/county/help?view=offer&update=${'B'.repeat(43)}`);
    await expect(page.getByRole('alert')).toContainText(
      'This link has expired or was already used.',
    );
    await expect(page.getByRole('link', { name: 'Back to Find help' })).toBeVisible();
    await expectNoViolations(page);
  });

  test('Spanish switches the whole page (EQ-06)', async ({ page }) => {
    await page.goto('/county/help?lang=es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('heading', { level: 1, name: 'Encuentre ayuda' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sitios abiertos' })).toBeVisible();
    await expectNoViolations(page);
  });

  test('a ZIP code puts the nearest site first; a closed site points to the next nearest open one (PUB-04)', async ({
    page,
  }) => {
    await page.goto('/county/help?near=63005');
    await expect(page.getByText('Nearest to Harmon City (63005)')).toBeVisible();
    const first = page.locator('.site').first();
    await expect(first.getByRole('heading')).toContainText('Harmon High School gym');
    await expect(first).toContainText('0 km away');
    await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();
  });

  test('keyboard only: search, then the optional map, then print tools are reachable', async ({
    page,
  }) => {
    await page.goto('/county/help');
    await page.getByLabel('Your ZIP code, address or a landmark').fill('63002');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Nearest to Cedar Ridge (63002)')).toBeVisible();
    // The toggle renames itself to "Hide map" once open, so it is found by what it controls.
    const toggle = page.locator('button[aria-controls="map"]');
    await expect(toggle).toHaveText('Show map');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveText('Hide map');
    await expect(page.getByRole('heading', { name: 'Open sites' })).toBeVisible(); // the list stays
    await expect(page.getByRole('button', { name: 'Print a poster' })).toBeVisible();
  });

  test('ACC-07: reflows at 320 CSS px without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/county/help');
    await expect(page.getByRole('heading', { name: 'Open sites' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  test('PUB-15: the poster view carries the phone number, the short address and a QR code, never the QR alone', async ({
    page,
  }) => {
    await page.goto('/county/help');
    await expect(page.getByRole('heading', { name: 'Open sites' })).toBeVisible();
    // Headless Chromium returns from window.print() at once and fires afterprint, which removes the
    // poster; the print call is replaced so the poster stays in the page for the checks.
    await page.evaluate(() => {
      window.print = () => undefined;
    });
    await page.getByRole('button', { name: 'Print a poster' }).click();
    const poster = page.locator('#poster');
    await expect(poster).toBeAttached();
    await expect(poster.locator('.url')).toContainText('/county/help');
    await expect(poster.locator('.qr')).toBeAttached();
    await expect(poster.locator('.phone')).toContainText(/\d{3}/);
    await page.emulateMedia({ media: 'print' });
    await expect(poster).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
  });

  test('the media sheet and a resource page are served as accessible HTML (PUB-13, PUB-18)', async ({
    page,
  }) => {
    await page.goto('/api/public/help/county/media?lang=en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Media sheet');
    await expectNoViolations(page);
    await page.goto('/api/public/help/county/resources/county-help-line?lang=en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'County disaster help line',
    );
    await expectNoViolations(page);
  });
});
