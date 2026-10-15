/**
 * Layer 7 in the console: the command window (CON-12, CMD-01, CMD-20–CMD-28,
 * CMD-31–CMD-34, AC-C06, AC-C08, AC-C11, Section 30.2, WCAG 2.2 AA). A mass
 * care coordinator opens it with the keyboard shortcut, reads the help, looks
 * up a need filed through the public API by its reference code, prepares a claim, checks the plan
 * and confirms it; the need is claimed on the board; then undoes it within
 * the window; keeps a personal alias for the lookup and removes it; reads its
 * own command history and clears it. Escape closes the window and returns focus to where it was
 * opened; "/" opens it when the cursor is not in a text field. Axe runs on
 * each state and, on the phone project, the window reflows at phone width.
 */
import { devices, expect, test } from '@playwright/test';
import {
  BASE,
  api,
  administrators,
  expectNoViolations,
  expectReflow,
  onboard,
  token,
} from './support/console.ts';

const tag = Date.now().toString(36);

test.describe('layer 7 console: the command window', () => {
  test('a coordinator claims a need through a confirmed plan and undoes it', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'mass_care_coordinator',
      `Mass care ${tag}`,
      `l7-${testInfo.project.name}`,
    );
    // A need filed through the public API; the worker puts it on the board.
    const executionId = crypto.randomUUID();
    const filed = await fetch(`${BASE}/api/public/needs/county/westwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': executionId },
      body: JSON.stringify({
        executionId,
        language: 'en',
        needs: ['food_water'],
        address: { line1: `${tag} Command St`, city: 'Westwind', postal: '63003' },
        contactName: 'Command Tester',
        contact: { phone: '+13145550189', email: `command-${tag}@example.org`, preferred: 'email' },
        consent: { relief_agencies: true },
      }),
    });
    expect(filed.status).toBe(202);
    const code = ((await filed.json()) as { referenceCode: string }).referenceCode;
    const admin = await token('county', administrators('county').admin);
    const statusOf = async () =>
      ((await api(admin, `/needs?reference=${code}`)).body as unknown as { status: string }[])[0]
        ?.status;
    await expect.poll(statusOf, { timeout: 90_000 }).toBe('open');

    await page.goto('/console/');
    const opener = page.getByRole('button', { name: /command window/i });
    await expect(opener).toBeVisible();
    await opener.focus();
    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Command window' });
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole('textbox', { name: 'Command' });
    await expect(box).toBeFocused();

    await box.fill('/help');
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'What you can do here' })).toBeVisible();
    await expect(
      dialog.getByRole('listitem').filter({ hasText: '/need <reference code> claim' }),
    ).toBeVisible();
    await expectNoViolations(page);
    // WCAG 1.4.10: on the phone project the window reflows without sideways scrolling.
    if (testInfo.project.name === 'phone') await expectReflow(page);

    await box.fill(`/needs ${code}`);
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Found' })).toBeVisible();
    await expect(dialog).toContainText(code);

    await box.fill(`/need ${code} claim note:"Exercise: our kitchen has it"`);
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Check the plan' })).toBeVisible();
    await expect(dialog.getByRole('definition').first()).toContainText(code);
    await expect(dialog).toContainText('You can undo this for 15 minutes');
    await expectNoViolations(page);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByRole('heading', { name: 'Saved' })).toBeVisible();
    await expect(dialog).toContainText('claimed');
    expect(await statusOf()).toBe('claimed');

    await dialog.getByRole('button', { name: /^Undo/ }).click();
    await expect(dialog.getByRole('heading', { name: 'Undone' })).toBeVisible();
    expect(await statusOf()).toBe('open');
    await expectNoViolations(page);

    // CMD-04: a personal alias for a lookup, shown in the help, used, then removed.
    await dialog.getByText('Aliases', { exact: true }).click();
    await dialog.getByLabel('Alias name').fill('mine');
    await dialog.getByLabel('Stands for').fill(`/needs ${code}`);
    await dialog.getByRole('button', { name: 'Save alias' }).click();
    await expect(dialog.getByRole('button', { name: 'Remove /mine' })).toBeVisible();
    await box.fill('/mine');
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Found' })).toBeVisible();
    await expect(dialog).toContainText(code);
    await expectNoViolations(page);
    await dialog.getByRole('button', { name: 'Remove /mine' }).click();
    await expect(dialog.getByText('No aliases yet.')).toBeVisible();

    // CMD-36: the person's own history, kept 30 days, cleared on request.
    await dialog.getByText('Your recent commands').click();
    const kept = dialog.getByRole('list').filter({ hasText: 'You:' });
    await expect(kept).toContainText(`/need ${code} claim`);
    await expectNoViolations(page);
    await dialog.getByRole('button', { name: 'Clear my history' }).click();
    await expect(dialog.getByText(/Nothing kept/)).toBeVisible();

    // Escape closes it; focus goes back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    // "/" opens it from anywhere but a text field, with the slash typed.
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('/');
    await expect(dialog).toBeVisible();
    await expect(box).toHaveValue(/^\//);
    await page.keyboard.press('Escape');
  });

  test('REC-01: the COAD proposes a facility; county EM approves it in their own browser and re-checks it', async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    const name = `Exercise Union Hall ${tag}-${testInfo.project.name}`;
    await onboard(page, context, 'coad_chair', `COAD chair ${tag}`, `l7f-${testInfo.project.name}`);
    await page.goto('/console/facilities');
    await expect(page.getByRole('heading', { level: 1, name: 'Facility registry' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Facilities' })).toContainText(
      'Harmon High School gym',
    );
    await expectNoViolations(page);
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Kind of place').selectOption('community_center');
    await page.getByLabel('Street address').fill('7 Union St');
    await page.getByLabel('Usable space (square feet)').fill('6000');
    await page.getByLabel('Kitchen').selectOption('yes');
    await page.getByRole('button', { name: 'Add the facility' }).click();
    await expect(page.getByText(`${name}: sent for approval.`)).toBeVisible();
    if (testInfo.project.name === 'phone') await expectReflow(page);

    const project =
      testInfo.project.name === 'phone' ? devices['Pixel 7'] : devices['Desktop Chrome'];
    const second = await browser.newContext({ ...project, baseURL: BASE, ignoreHTTPSErrors: true });
    try {
      const em = await second.newPage();
      await onboard(
        em,
        second,
        'county_em_director',
        `EM director F ${tag}`,
        `l7f2-${testInfo.project.name}`,
      );
      await em.goto('/console/facility-approvals');
      await expect(em.getByRole('heading', { level: 1, name: 'Facility approvals' })).toBeVisible();
      await em.getByRole('button', { name: `Decide ${name}` }).click();
      await em
        .getByLabel('Reason for the decision')
        .fill('Exercise: walked the hall with the COAD');
      await expectNoViolations(em);
      await em.getByRole('button', { name: 'Record the decision' }).click();
      await expect(em.getByText(`${name}: approved.`)).toBeVisible();

      await em.goto('/console/facilities');
      const table = em.getByRole('table', { name: 'Facilities' });
      await expect(table).toContainText(name);
      await table.getByRole('button', { name }).click();
      await expect(em.getByRole('heading', { level: 2, name })).toBeVisible();
      await em.getByRole('button', { name: `Confirm ${name} is still right` }).click();
      await expect(em.getByText(`${name}: confirmed as still right.`)).toBeVisible();
      await expectNoViolations(em);
    } finally {
      await second.close();
    }
  });
});
