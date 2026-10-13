/**
 * Layer 3 console journeys (CON-04, CON-08, CON-09, PUB-06, NED-07, CNT-01,
 * GATE-02/03): a mass care coordinator sees the key counts, claims and
 * finishes a need on the board, adds a site, confirms it, publishes it
 * through the approval dialog and sees it in the publication log, and opens
 * the contacts registry; every screen passes axe WCAG 2.2 AA.
 */
import { expect, test } from '@playwright/test';
import { BASE, expectNoViolations, onboard } from './support/console.ts';

const tag = Date.now().toString(36);

test.describe('layer 3 console', () => {
  test.describe.configure({ mode: 'serial' });

  test('key counts, needs board, sites, publication log, contacts', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    // A need without a damage report, filed through the public API, for the board.
    const executionId = crypto.randomUUID();
    const filed = await fetch(`${BASE}/api/public/needs/county/westwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': executionId },
      body: JSON.stringify({
        executionId,
        language: 'en',
        needs: ['food_water'],
        address: { line1: `${tag} Board St`, city: 'Westwind', postal: '63003' },
        contactName: 'Board Tester',
        contact: { phone: '+13145550188', email: `board-${tag}@example.org`, preferred: 'email' },
        consent: { relief_agencies: true },
      }),
    });
    expect(filed.status).toBe(202);
    const code = ((await filed.json()) as { referenceCode: string }).referenceCode;

    await onboard(
      page,
      context,
      'mass_care_coordinator',
      `Mass Care ${tag}`,
      `l3-${testInfo.project.name}`,
    );

    // Home: key counts with their as-of time (CON-04).
    await expect(page.getByRole('heading', { name: 'Key counts' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/As of /)).toBeVisible();
    await expectNoViolations(page);

    // Needs board: the filed need appears once the worker swept it; claim it, then finish it (CON-08, NED-07).
    await page.getByRole('link', { name: 'Needs board' }).click();
    await expect(page.getByRole('heading', { name: 'Needs board' })).toBeVisible();
    await page.getByLabel('Reference').fill(code);
    const row = page.getByRole('row').filter({ hasText: code });
    await expect(row).toBeVisible({ timeout: 90_000 });
    await expectNoViolations(page);
    await row.getByRole('button', { name: 'Act' }).click();
    await page.getByLabel('Note').fill('Canteen covers Westwind today');
    await page.getByRole('button', { name: 'Claim' }).click();
    await expect(page.getByRole('status')).toContainText('claimed');
    await expect(row).toContainText('claimed');
    await row.getByRole('button', { name: 'Act' }).click();
    await page.getByLabel('Note').fill('Meals delivered');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('status')).toContainText('marked done');
    await expect(row).toContainText('met');

    // Sites: add, confirm, publish with a reason, see it in the log (CON-09, PUB-06).
    await page.getByRole('link', { name: 'Sites' }).click();
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
    await expectNoViolations(page);
    const siteName = `Console warming center ${tag}`;
    await page.getByLabel('Kind').selectOption('warming');
    await page.getByLabel('Name').fill(siteName);
    await page.getByLabel('Street address').fill('7 Civic Plaza');
    await page.getByLabel('City').fill('Westwind');
    await page.getByLabel('ZIP').fill('63003');
    await page.getByLabel('Latitude').fill('38.799');
    await page.getByLabel('Longitude').fill('-90.862');
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('status')).toContainText('added');
    const siteRow = page.getByRole('row').filter({ hasText: siteName });
    await expect(siteRow).toBeVisible();
    await expect(siteRow).toContainText('not published');
    await siteRow.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/reason/i).fill('Opened by the EOC for the cold snap');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('status')).toContainText('published on every channel');
    await expect(siteRow).toContainText('published');
    await page.getByRole('link', { name: 'Publication log' }).click();
    await expect(page.getByRole('heading', { name: 'Publication log' })).toBeVisible();
    const logRow = page.getByRole('row').filter({ hasText: siteName });
    await expect(logRow).toBeVisible();
    await expect(logRow).toContainText('Opened by the EOC for the cold snap');
    await expectNoViolations(page);

    // The public page shows the new site at once (PUB-01).
    const pub = await fetch(`${BASE}/api/public/help/county?lang=en`);
    const help = (await pub.json()) as { sites: { name: string }[] };
    expect(help.sites.some((s) => s.name === siteName)).toBe(true);

    // Contacts registry (CNT-01): readable, names only for roles with the category.
    await page.getByRole('link', { name: 'Contacts' }).click();
    await expect(page.getByRole('heading', { name: 'Interagency contacts' })).toBeVisible();
    await expectNoViolations(page);
  });
});
