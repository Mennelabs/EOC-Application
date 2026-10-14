/**
 * Layer 6 in the console: reference data (ADR-0039, ADR-0041, SCL-09,
 * SCL-06, WCAG 2.2 AA). A planning/GIS lead sees each dataset with its
 * source, the data in use and its age (filled from the recorded synthetic
 * WESTWIND responses on this stack), asks for a pull now, and imports a
 * risk and vulnerability file (an import-only dataset): a wrong column
 * choice is caught by the check, named by row and field without the value;
 * the fixed mapping passes and applies. Axe runs on each state.
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
});
