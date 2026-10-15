/**
 * The showcase under axe (WCAG 2.2 AA) in the light and the dark theme, on a
 * desktop and a phone, with reflow checked and a screenshot of each state kept
 * in test-results for review (ADR-0045, ACC-07, ACC-08, GATE-03).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function noViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  // Each failing node with its reason, so a failure in CI names the element and the colours.
  const found = results.violations.flatMap((v) =>
    v.nodes.map(
      (n) =>
        `${v.id}: ${n.target.join(' ')} ${n.html.slice(0, 160)} :: ${n.failureSummary?.replace(/\s+/g, ' ')}`,
    ),
  );
  expect(found).toEqual([]);
}
async function noSidewaysScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'page wider than the screen').toBeLessThanOrEqual(client + 1);
}

for (const theme of ['light', 'dark'] as const) {
  test(`showcase in the ${theme} theme is accessible and reflows`, async ({ page }, info) => {
    await page.goto('/');
    await page.getByTestId(`theme-${theme}`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: 'Design showcase' })).toBeVisible();
    await noSidewaysScroll(page);
    await noViolations(page);
    await page.screenshot({
      path: info.outputPath(`showcase-${theme}-${info.project.name}.png`),
      fullPage: true,
    });

    // The menu, the dialog and the select open with the keyboard and pass axe open.
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('menuitem', { name: 'Download PDF' })).toBeVisible();
    await noViolations(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open a dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Publish this site?' })).toBeVisible();
    await noViolations(page);
    await page.screenshot({ path: info.outputPath(`dialog-${theme}-${info.project.name}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('the navigation marks the current workspace and keeps counts out of link names', async ({
  page,
}) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Workspaces' });
  if (await page.getByRole('button', { name: 'Workspaces' }).isVisible()) {
    await page.getByRole('button', { name: 'Workspaces' }).click();
  }
  await nav.getByRole('link', { name: 'Review queue', exact: true }).click();
  // On a phone the drawer closes after a move; open it again to read the state.
  if (await page.getByRole('button', { name: 'Workspaces' }).isVisible()) {
    await page.getByRole('button', { name: 'Workspaces' }).click();
  }
  await expect(nav.getByRole('link', { name: 'Review queue', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('874 in the queue')).toBeVisible();
});

test('briefing mode enlarges the type and hides the navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Briefing mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'briefing');
  const size = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(size).toBeGreaterThanOrEqual(22);
  await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeHidden();
  await noViolations(page);
});
