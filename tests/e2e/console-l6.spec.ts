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
 * amount is named back first) and withdraws it. Then official reports
 * (F15, RULE-10, RULE-14, A7): a reporting officer drafts a situation report
 * for the current period, reads and saves the drafted summary and writes
 * the outlook, and cannot review it; the EM director, in their own browser,
 * approves it and issues it through the confirmation dialog; the issued copy
 * shows its hash and, once the worker has written it, its object lock; an
 * amendment is drafted from it; the issued report is exported as a PDF.
 * The director also makes the IDA package and downloads it, and sees why no
 * photo can be chosen yet (no detector). The joint assessment (FL:FR-10):
 * the director schedules it and draws the sample; a FEMA validator, on a
 * role that ends within 30 days and in their own browser, sees the stops
 * without addresses and marks two. A state liaison reads the county's
 * figures once the county has signed a counts-only agreement with the state
 * (DEC-13): read-only, no sites, no forms. Axe runs on each state, and each layer-6
 * screen is checked for reflow: no sideways scrolling at phone width
 * (WCAG 1.4.10, ACC-07).
 */
import { devices, expect, test } from '@playwright/test';
import { BASE, api, expectNoViolations, expectReflow, onboard, token } from './support/console.ts';

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
    await expectReflow(page);

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
    await expectReflow(page);

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
    await expectReflow(page);

    // PHO-07: a photo can be chosen only once a detector has blurred it; none is enabled here.
    await expect(page.getByRole('heading', { name: 'Representative photos' })).toBeVisible();
    await expect(page.getByText(/No photo is cleared for sharing yet/)).toBeVisible();
    // DEC-11, SEC-18: the worker makes the package; the download is the ZIP.
    await page.getByLabel('Package for').selectOption({ label: 'Whole event' });
    await page.getByLabel('Reason (optional)').fill(`Exercise: state asked, run ${run}`);
    await page.getByRole('button', { name: 'Make the package' }).click();
    await expect(page.getByText(/The package is being made/)).toBeVisible();
    const newest = page
      .getByRole('table', { name: 'Packages made for this event' })
      .getByRole('row')
      .nth(1);
    const zip = newest.getByRole('button', { name: 'Download package for Whole event' });
    await expect(zip).toBeVisible({ timeout: 120_000 });
    await expect(newest).toContainText('housing units counted');
    const [file] = await Promise.all([page.waitForEvent('download'), zip.click()]);
    expect(file.suggestedFilename()).toMatch(/^ida-package-.+\.zip$/);
    await expectNoViolations(page);
    await expectReflow(page);
  });

  test('a reporting officer drafts a situation report; the EM director approves and issues it', async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    await onboard(
      page,
      context,
      'reporting_planning',
      `Reporting officer ${tag}`,
      `l6e-${testInfo.project.name}`,
    );
    await page.goto('/console/official-reports');
    await expect(page.getByRole('heading', { level: 1, name: 'Official reports' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Draft a report' })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
    await expectReflow(page);
    await page.getByLabel('Kind of report').selectOption({ label: 'Situation report' });
    await page.getByRole('button', { name: 'Draft the report' }).click();
    const title = page.getByRole('heading', { level: 1, name: /^Situation report \d+$/ });
    await expect(title).toBeVisible({ timeout: 30_000 });
    const reportUrl = page.url();
    await expect(page.getByRole('table', { name: 'Verified damage to homes' })).toBeVisible();
    await expect(page.getByText('Drafted from the facts.')).toBeVisible();
    // A7: the author does not review their own report.
    await expect(page.getByText('Someone other than you reviews this report.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve the report' })).toHaveCount(0);
    await expectNoViolations(page);
    await expectReflow(page);
    const summary = page.getByRole('textbox', { name: 'Summary', exact: true });
    await summary.fill(`${await summary.inputValue()} Exercise: river crest expected Thursday.`);
    await page.getByRole('button', { name: 'Save summary' }).click();
    await expect(page.getByText('Summary saved.')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Outlook for the next period', exact: true })
      .fill('Exercise: more rain on Thursday; the levee watch continues.');
    await page.getByRole('button', { name: 'Save outlook for the next period' }).click();
    await expect(page.getByText('Outlook for the next period saved.')).toBeVisible();
    await expect(page.getByText(/Written by Reporting officer/).first()).toBeVisible();
    await expectReflow(page);

    // The director, in their own browser.
    const project =
      testInfo.project.name === 'phone' ? devices['Pixel 7'] : devices['Desktop Chrome'];
    const second = await browser.newContext({ ...project, baseURL: BASE, ignoreHTTPSErrors: true });
    try {
      const director = await second.newPage();
      await onboard(
        director,
        second,
        'county_em_director',
        `EM director E ${tag}`,
        `l6e2-${testInfo.project.name}`,
      );
      await director.goto(reportUrl);
      await expect(director.getByRole('button', { name: 'Approve the report' })).toBeVisible({
        timeout: 30_000,
      });
      await expectNoViolations(director);
      await expectReflow(director);
      await director.getByRole('button', { name: 'Approve the report' }).click();
      await expect(director.getByText(/^Approved\./)).toBeVisible();
      await director.getByRole('button', { name: 'Issue the report' }).click();
      const dialog = director.getByRole('dialog', { name: 'Please confirm' });
      await expect(dialog).toBeVisible();
      await expectNoViolations(director);
      await dialog.getByLabel('Reason').fill('Exercise: approved for release to partners');
      await dialog.getByRole('button', { name: 'Confirm' }).click();
      await expect(director.getByText(/^Issued\. The report is frozen/)).toBeVisible();
      await expect(director.getByRole('heading', { name: 'Issued copy' })).toBeVisible();
      await expect(director.locator('code.hash')).toHaveText(/^[0-9a-f]{64}$/);
      // RULE-10, ADR-0010: the worker writes the locked copy shortly after.
      await expect(async () => {
        await director.reload();
        await expect(director.getByText(/Locked copy written/)).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 90_000 });
      await expectNoViolations(director);
      await expectReflow(director);
      // F15, RULE-10: exported from the frozen copy.
      await director.getByRole('button', { name: 'Export as PDF' }).click();
      await expect(director.getByText('The PDF is being made.')).toBeVisible();
      const pdf = director.getByRole('button', { name: 'Download PDF' });
      await expect(pdf).toBeVisible({ timeout: 90_000 });
      const [file] = await Promise.all([director.waitForEvent('download'), pdf.click()]);
      expect(file.suggestedFilename()).toMatch(/\.pdf$/);
      await expectNoViolations(director);
      await director.getByRole('button', { name: 'Draft an amendment' }).click();
      await expect(
        director.getByRole('heading', { level: 1, name: /^Situation report \d+, amendment 1$/ }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await second.close();
    }
  });

  test('the county plans the joint assessment; a FEMA validator marks the sample', async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    const run = `${tag}-${testInfo.project.name}`;
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    await onboard(
      page,
      context,
      'county_em_director',
      `EM director J ${tag}`,
      `l6j-${testInfo.project.name}`,
    );
    await page.goto('/console/joint-assessment');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Joint damage assessment' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sample route' })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
    await expectReflow(page);
    await page.getByLabel('First day').fill(day(3));
    await page.getByLabel('Last day').fill(day(2));
    await expect(page.getByText('The assessment cannot end before it starts.')).toBeVisible();
    await page.getByLabel('Last day').fill(day(4));
    await page.getByLabel('Areas to assess').fill('North river district\nHarmon City');
    await page.getByLabel('Team 1 name').fill(`Team ${run}`);
    await page
      .getByLabel('Team 1 members')
      .fill('FEMA IA validator; SEMA liaison; county assessor');
    await page.getByRole('button', { name: 'Save schedule' }).click();
    await expect(page.getByText('Schedule saved.')).toBeVisible();
    await page.getByLabel('Homes in the sample').fill('six');
    await expect(page.getByText('Enter a whole number from 1 to 500.')).toBeVisible();
    await page.getByLabel('Homes in the sample').fill('6');
    await page.getByRole('button', { name: 'Draw the sample' }).click();
    // A sample a validator has already marked (an earlier run) stands and is not redrawn.
    await expect(
      page.getByText(/^Sample drawn\.$|Validators have marked this sample; it is not redrawn\./),
    ).toBeVisible();
    const route = page.getByRole('table', { name: 'Sample route' });
    await expect(route.getByRole('row').nth(1)).toBeVisible();
    // The director plans; validating is for the validators.
    await expect(page.getByRole('heading', { name: 'Mark a stop' })).toHaveCount(0);
    await expectNoViolations(page);
    await expectReflow(page);

    const project =
      testInfo.project.name === 'phone' ? devices['Pixel 7'] : devices['Desktop Chrome'];
    const second = await browser.newContext({ ...project, baseURL: BASE, ignoreHTTPSErrors: true });
    try {
      const validator = await second.newPage();
      await onboard(
        validator,
        second,
        'fema_validator',
        `FEMA validator ${tag}`,
        `l6v-${testInfo.project.name}`,
        'county',
        { validTo: new Date(Date.now() + 14 * 86_400_000).toISOString() },
      );
      await validator.goto('/console/joint-assessment');
      await expect(validator.getByRole('heading', { name: 'Mark a stop' })).toBeVisible({
        timeout: 30_000,
      });
      // Read-only schedule; the stops show no address.
      await expect(validator.getByRole('button', { name: 'Save schedule' })).toHaveCount(0);
      await expect(validator.getByText(`Team ${run}`)).toBeVisible();
      await expect(validator.getByRole('table', { name: 'Sample route' })).not.toContainText(
        /\d+ [A-Z][a-z]+ (St|Ave|Rd|Road|Street|Drive|Lane)\b/,
      );
      await expectNoViolations(validator);
      await expectReflow(validator);
      const stopLabel = await validator
        .getByLabel('Stop', { exact: true })
        .locator('option:checked')
        .innerText();
      const seq = /^Stop (\d+)/.exec(stopLabel)![1]!;
      await validator.getByLabel('Damage as recorded').check();
      await validator.getByRole('button', { name: `Save mark for stop ${seq}` }).click();
      await expect(validator.getByText(`Stop ${seq} marked.`)).toBeVisible();
      await expect(
        validator.getByRole('table', { name: 'Sample route' }).getByRole('row').nth(Number(seq)),
      ).toContainText('Validated by FEMA validator');
      await validator.getByLabel('A different degree of damage').check();
      await validator.getByLabel('Degree seen').selectOption({ label: 'Major' });
      await validator
        .getByLabel('Note (optional)')
        .fill('Exercise: water line higher than reported.');
      await expectNoViolations(validator);
      const next = /^Stop (\d+)/.exec(
        await validator.getByLabel('Stop', { exact: true }).locator('option:checked').innerText(),
      )![1]!;
      await validator.getByRole('button', { name: `Save mark for stop ${next}` }).click();
      await expect(validator.getByText(`Stop ${next} marked.`)).toBeVisible();
      await expect(
        validator.getByRole('table', { name: 'Sample route' }).getByRole('row').nth(Number(next)),
      ).toContainText('Seen as Major');
      await expectReflow(validator);
    } finally {
      await second.close();
    }
  });

  test('a state liaison reads a county’s figures under its signed agreement', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    // DEC-13, SCL-01: the county offers counts only; the state signs.
    const county = await token('county', 'dana.director@example.org');
    const stateAdmin = await token('state', 'admin.state@example.org');
    const stateId = (await api(stateAdmin, '/me')).body['tenantId'] as string;
    const offered = await api(county, '/agreements', {
      body: { toTenantId: stateId, scope: 'deidentified_counts' },
    });
    expect(offered.status).toBe(201);
    const signed = await api(stateAdmin, `/agreements/${offered.body['id'] as string}/sign`, {
      method: 'POST',
      version: offered.body['version'] as number,
      confirm: `Exercise: declaration figures, counts only (${tag})`,
    });
    expect(signed.status).toBe(200);

    await onboard(
      page,
      context,
      'state_liaison',
      `State liaison ${tag}`,
      `l6l-${testInfo.project.name}`,
      'state',
    );
    await page.goto('/console/shared-declarations');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Shared declaration figures' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verified damage to homes' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole('table', { name: 'Public damage by category of work' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Joint damage assessment' })).toBeVisible();
    // Read-only and de-identified: no sites, no forms.
    await expect(page.getByRole('table', { name: 'Public damage sites' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Log outage' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record count' })).toHaveCount(0);
    await expectNoViolations(page);
    await expectReflow(page);
  });
});
