/**
 * Public "Find help" page (PUB-07, PUB-02/04/15, A11Y-01, GATE-03/04/06):
 * no sign-in, list first, English and Spanish, searchable by ZIP, keyboard
 * reachable, printable, reflows at 320 px, no axe violations; the optional
 * map loads only on request and never replaces the list.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoViolations(page: import('@playwright/test').Page) {
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
    // Headless Chromium answers window.print() without a dialog; the poster stays in the page.
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
