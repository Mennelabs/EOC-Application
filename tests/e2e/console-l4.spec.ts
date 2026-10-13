/**
 * Layer 4 console journeys (layer-4 plan §9; CALL-01, DSP-01/02/03/04/07,
 * AC-06C, CON-03, PER-01, DSP-10, BDG-01, ACC-07): a field coordinator takes
 * a phone request as a mission, assigns it from the dispatch board with the
 * keyboard only (a conflict needs a recorded reason), acknowledges any open
 * alert, and opens the roster, the situation map, the net control log and
 * badges; every screen passes axe WCAG 2.2 AA.
 */
import { expect, test } from '@playwright/test';
import { appears, expectNoViolations, onboard } from './support/console.ts';

const tag = Date.now().toString(36);

test.describe('layer 4 console', () => {
  test.describe.configure({ mode: 'serial' });

  test('mission intake, keyboard dispatch, roster, situation, net control, badges', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(300_000);
    await onboard(
      page,
      context,
      'field_coordinator',
      `Field Coordinator ${tag}`,
      `l4-${testInfo.project.name}`,
    );

    // CALL-01: a phone request becomes a mission ready for dispatch.
    await page.goto('/console/missions');
    await expect(page.getByRole('heading', { name: 'Missions', level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'New request (phone or walk-in)' }).click();
    await page.getByLabel('What is needed').fill(`Exercise: tarp a roof ${tag}`);
    await page.getByLabel('Street address').fill(`${tag.slice(-3)} Exercise Ln`);
    await page.getByLabel('City').fill('Harmon');
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Save for dispatch' }).click();
    const heading = page.getByRole('heading', { level: 1, name: /M-\d+/ });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    const reference = /M-\d+/.exec((await heading.innerText()) ?? '')![0];
    await expectNoViolations(page);

    // DSP-07: an open alert takes over the board until someone acknowledges it.
    await page.goto('/console/dispatch');
    await expect(page.getByRole('heading', { name: 'Dispatch board', level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    const takeover = page.getByRole('heading', { name: 'Alert: a team needs attention' });
    for (let i = 0; i < 10 && (await appears(takeover, 3000)); i++) {
      await expectNoViolations(page);
      await page
        .getByRole('button', { name: /Acknowledge/ })
        .first()
        .click();
      await page.waitForTimeout(1000);
    }
    await expectNoViolations(page);

    // DSP-03, WCAG 2.1.1: assign with the keyboard only.
    const assign = page.getByRole('button', { name: `Assign ${reference}…` });
    await expect(assign).toBeVisible({ timeout: 30_000 });
    await assign.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: `Assign ${reference}` })).toBeVisible();
    await expect(page.getByText('Finding teams…')).toBeHidden({ timeout: 30_000 });
    const radios = page.getByRole('radio');
    if ((await radios.count()) > 0) {
      await radios.first().focus();
      await page.keyboard.press('Space');
    } else {
      await page.getByLabel('Another team').selectOption({ index: 1 });
    }
    await expectNoViolations(page);
    const send = page.getByRole('button', { name: 'Assign and send' });
    await send.focus();
    await page.keyboard.press('Enter');
    const done = page.getByText(/awaiting acknowledgement/);
    // AC-06C: a team with conflicts is assigned only with a recorded reason.
    const why = page.getByLabel('Why assign anyway (recorded)');
    if (!(await appears(done, 8000)) && (await appears(why, 2000))) {
      await why.fill('Exercise: the closest team, checked with the lead by radio');
      await send.focus();
      await page.keyboard.press('Enter');
    }
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expectNoViolations(page);

    for (const [path, name] of [
      ['/console/roster', 'Roster and check-in'],
      ['/console/situation', 'Situation map'],
      ['/console/net-control', 'Net control log'],
      ['/console/badges', 'Badges'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(1000);
      await expectNoViolations(page);
    }
    // ACC-07: the situation map's layers are buttons with a pressed state and a table each.
    await page.goto('/console/situation');
    const reports = page.getByRole('button', { name: /^Reports/ });
    await expect(reports).toHaveAttribute('aria-pressed', /true|false/, { timeout: 30_000 });
  });
});
