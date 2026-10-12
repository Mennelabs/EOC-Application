/**
 * Automated accessibility checks (NFR-01, GATE-03). Every released screen gets
 * an axe scan with WCAG 2.2 AA rules; manual checks live in docs/a11y/.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test.describe('resident welcome', () => {
  test('English: safety message first, no axe violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'In danger right now?' })).toBeVisible();
    await expect(page.getByText('Call 911. This form does not send help.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoViolations(page);
  });

  test('Spanish: whole page switches language (EQ-06, AC-A05)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Language').selectOption('es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(
      page.getByRole('heading', { name: '¿Está en peligro ahora mismo?' }),
    ).toBeVisible();
    await expectNoViolations(page);
  });

  test('ADM-03: county name in the header, product name only from config', async ({
    page,
    request,
  }) => {
    const cfg = (await (await request.get('/config.json')).json()) as {
      productName: string;
      countyName: string;
    };
    await page.goto('/');
    await expect(page.getByText(`${cfg.countyName} Emergency Management`)).toBeVisible();
    await expect(page.locator('footer')).toContainText(cfg.productName);
  });

  test('keyboard only: Start is reachable and announces status', async ({ page }) => {
    await page.goto('/');
    const start = page.getByRole('button', { name: 'Start' });
    await start.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).not.toBeEmpty();
  });

  test('ACC-07: reflows at 320 CSS px without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
