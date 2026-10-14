/**
 * Layer 6 in the console: reference data (ADR-0039, ADR-0041, SCL-09,
 * SCL-06, WCAG 2.2 AA). A planning/GIS lead sees each dataset with its
 * source, the data in use and its age (filled from the recorded synthetic
 * WESTWIND responses on this stack), asks for a pull now, and imports a
 * risk and vulnerability file (an import-only dataset): a wrong column
 * choice is caught by the check, named by row and field without the value;
 * the fixed mapping passes and applies. Then the county EM director works
 * the declaration data for the open event (DCL:DEC-05–DEC-10, DEC-16): sets
 * the incident period and sees the 30-day clock, logs an outage that has run
 * past 72 hours and marks it restored, records an official casualty count
 * with its source, and adds a public damage site (a cost that is not an
 * amount is named back first) and withdraws it. Axe runs on each state.
 */
import { expect, test } from '@playwright/test';
import { expectNoViolations, onboard } from './support/console.ts';

const tag = Date.now().toString(36);

const RISK_CSV = [
  'GEOID,RISK_SCORE,RISK_RATNG,SVI_PCT,RPL_THEMES',
  '29999000100,71.2,Relatively High,88,0.88',
  '29999000200,64.0,Relatively Moderate,93,0.93',
].join('\n');

test.describe('layer 6 console: reference data', () => {
  test('a GIS lead checks the data in use and imports a risk file', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'planning_gis_lead',
      `GIS lead ${tag}`,
      `l6-${testInfo.project.name}`,
    );

    await page.goto('/console/reference-data');
    await expect(page.getByRole('heading', { level: 1, name: 'Reference data' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Datasets and the data in use' });
    // The stack's worker pulls the recorded responses shortly after it starts.
    await expect(async () => {
      await page.reload();
      await expect(table.getByRole('row').filter({ hasText: 'Census tracts' })).toContainText(
        '5 rows, recorded exercise data',
        { timeout: 2_000 },
      );
    }).toPass({ timeout: 120_000 });
    await expect(
      table.getByRole('row').filter({ hasText: 'Risk and social vulnerability' }),
    ).toContainText('File import only');
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Pull census tracts now' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'pull requested' })).toBeVisible();

    // Step 1: the file.
    await page
      .getByLabel('Dataset', { exact: true })
      .selectOption({ label: 'Risk and social vulnerability' });
    await page.getByLabel('File', { exact: true }).setInputFiles({
      name: `risk-${tag}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(RISK_CSV),
    });
    await page.getByLabel('Licence or terms').fill('Exercise data (synthetic)');
    await page.getByLabel('Edition (optional)').fill('Exercise 2026');
    await page.getByRole('button', { name: 'Upload and read columns' }).click();

    // Step 2: match the columns; the percentage column is the wrong choice for the 0–1 index.
    await expect(page.getByRole('heading', { name: /Step 2 of 3/ })).toBeFocused();
    await page.getByLabel('Census GEOID (required)').selectOption('GEOID');
    await page.getByLabel('National Risk Index score').selectOption('RISK_SCORE');
    await page.getByLabel('National Risk Index rating').selectOption('RISK_RATNG');
    await page.getByLabel('SVI overall (0 to 1)').selectOption('SVI_PCT');
    await page.getByRole('button', { name: 'Check the file' }).click();
    const problems = page.getByRole('table', { name: 'Problems found by the check' });
    await expect(problems).toBeVisible({ timeout: 60_000 });
    await expect(problems.getByRole('row').nth(1)).toContainText('1');
    await expect(problems).toContainText('SVI overall (0 to 1)');
    await expect(problems).not.toContainText('88');
    await expectNoViolations(page);

    // The fixed mapping passes; applying makes it the data in use.
    await page.getByLabel('SVI overall (0 to 1)').selectOption('RPL_THEMES');
    await page.getByRole('button', { name: 'Check the file' }).click();
    await expect(page.getByRole('heading', { name: /Step 3 of 3/ })).toBeFocused({
      timeout: 60_000,
    });
    await expect(page.getByText('The check passed: 2 rows are ready.')).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Apply 2 rows' }).click();
    await expect(
      page.getByText(/Applied: Risk and social vulnerability now come from/),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      table.getByRole('row').filter({ hasText: 'Risk and social vulnerability' }),
    ).toContainText('2 rows, imported from a file, Exercise 2026');
    await expect(
      page
        .getByRole('table', { name: 'Recent imports' })
        .getByRole('row')
        .filter({ hasText: `risk-${tag}.csv` }),
    ).toContainText('applied');
  });

  test('an EM director keeps the declaration data for the event', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'county_em_director',
      `EM director ${tag}`,
      `l6d-${testInfo.project.name}`,
    );
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const local = (offset: number) => {
      const d = new Date(Date.now() + offset * 86_400_000);
      const p = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const run = `${tag}-${testInfo.project.name}`;

    await page.goto('/console/declaration');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Declaration request data' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verified damage to homes' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('table', { name: 'Shown apart, not counted' })).toBeVisible();
    await expectNoViolations(page);

    // DEC-16: the incident end date starts the 30-day clock; an end before the start is refused.
    await page.getByLabel('Incident type').fill('Severe storms and flooding (exercise)');
    await page.getByLabel('Incident start date').fill(day(-5));
    await page.getByLabel('Incident end date').fill(day(-7));
    await expect(page.getByText('The incident cannot end before it starts.')).toBeVisible();
    await page.getByLabel('Incident end date').fill(day(-5));
    await page.getByRole('button', { name: 'Save incident period and drafts' }).click();
    await expect(page.getByText('Incident period and drafts saved.')).toBeVisible();
    await expect(page.getByText(/25 days left/)).toBeVisible();

    // DEC-07: an outage past 72 hours is flagged; restoring it records the time.
    await page.getByLabel('Service', { exact: true }).selectOption({ label: 'Drinking water' });
    await page.getByLabel('Facility name (optional)').fill(`Exercise pump station ${run}`);
    await page.getByLabel('Customers out (optional)').fill('1,200');
    await expect(page.getByText('Enter a whole number, or leave it empty.')).toBeVisible();
    await page.getByLabel('Customers out (optional)').fill('1200');
    await page.getByLabel('Out since').fill(local(-4));
    await page.getByRole('button', { name: 'Log outage' }).click();
    await expect(page.getByText('Outage logged.')).toBeVisible();
    const outage = page
      .getByRole('table', { name: 'Outage log' })
      .getByRole('row')
      .filter({ hasText: `Exercise pump station ${run}` });
    await expect(outage).toContainText('(over 72 hours)');
    await expectNoViolations(page);
    await outage.getByRole('button', { name: 'Mark drinking water restored now' }).click();
    await expect(page.getByText('Drinking water marked restored.')).toBeVisible();
    await expect(outage).toContainText('Restored');

    // DEC-08: an official count with its source; the latest entry is the one shown.
    await page.getByLabel('Kind', { exact: true }).selectOption({ label: 'Injured' });
    await page.getByLabel('Count', { exact: true }).fill('3');
    await page.getByLabel('Official source').fill('Exercise: county medical examiner');
    await page.getByLabel('As of').fill(local(0));
    await page.getByRole('button', { name: 'Record count' }).click();
    await expect(page.getByText('Injured count recorded.')).toBeVisible();
    const injured = page
      .getByRole('table', { name: 'Current official casualty counts' })
      .getByRole('row')
      .filter({ hasText: 'Injured' });
    await expect(injured).toContainText('Exercise: county medical examiner');

    // DEC-10: a public damage site counts toward its category; withdrawing it takes it out.
    const site = `Exercise culvert ${run}`;
    await page.getByLabel('Applicant').fill('Exercise Public Works');
    await page.getByLabel('Site name').fill(site);
    await page
      .getByLabel('Category of work', { exact: true })
      .selectOption({ label: 'C: Roads and bridges' });
    await page.getByLabel('Cost in US dollars (optional)').fill('about 100k');
    await expect(page.getByText('Enter an amount of 0 or more.')).toBeVisible();
    await page.getByLabel('Cost in US dollars (optional)').fill('125000');
    await page.getByLabel('Cost basis').selectOption('verified');
    await page.getByLabel('Percent complete (optional)').fill('10');
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByText(`${site} added.`)).toBeVisible();
    const row = page
      .getByRole('table', { name: 'Public damage sites' })
      .getByRole('row')
      .filter({ hasText: site });
    await expect(row).toContainText('$125,000, verified');
    await row.getByRole('button', { name: `Withdraw ${site}` }).click();
    await expect(page.getByText(`${site} withdrawn.`)).toBeVisible();
    await expect(row).toContainText('Withdrawn');
    await expectNoViolations(page);
  });
});
