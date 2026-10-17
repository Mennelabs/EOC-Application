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
 * With a need open on the board (CMD-06), "/need this claim" plans for it;
 * a note typed but not saved is asked about before the claim runs, kept or
 * discarded (CMD-29, AC-C09); set aside, "this" finds nothing. A batch over 50
 * records waits for the count typed, and a partly done batch names what it
 * did not change (CMD-30). An EM director prepares a public-records release
 * for the event, confirmed with a reason, and downloads it (SEC-13).
 *
 * Recommendations (REC-02–REC-12): mass care asks for a shelter; the top
 * three come with reasons, the fairgrounds lot is set aside as no shelter,
 * inputs carry their age and the equity check shows; mass care accepts with
 * a reason. Feeding stops, a POD and a MARC render too. Axe runs on each.
 *
 * Resource discovery (REC-13): a partner posts a service; county EM asks for
 * a run, finds the place in the queue with where it came from and the
 * pre-check, and qualifies it into the registry (desktop) or sets it aside
 * (phone), with a reason.
 *
 * Public text (PUB-11, PUB-12, PUB-14, AI-10): the PIO adds a site and asks
 * for its alert drafts; the social post, the radio loop and the amateur-net
 * read-out sit with the WEA and mass-notification texts in both languages;
 * a graphic per language is named by its alt text and downloads as PNG;
 * with no AI provider configured, the assistant says it is off and the rules'
 * texts stay; the net read-out is ready to speak, and the AI voice says it is
 * off too. A file the AI voice made (stood in for) can be downloaded for air
 * only after it played to the end and was cleared with a reason (GATE-08).
 */
import { devices, expect, test } from '@playwright/test';
import {
  BASE,
  api,
  administrators,
  expectNoViolations,
  expectReflow,
  goTo,
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

    // AC-C11, CMD-08, CMD-31: two reminders match, so the window asks; the question is a radio
    // group answered by keyboard, and the plan it leads to is cancelled by keyboard. Nothing changes.
    for (const side of ['north', 'south']) {
      await box.fill(`/remind in 30m Refuel generator ${tag} ${side}`);
      await box.press('Enter');
      await expect(dialog.getByRole('heading', { name: 'Check the plan' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Confirm' }).click();
      await expect(dialog.getByRole('heading', { name: 'Saved' })).toBeVisible();
    }
    await box.fill(`/reminder Refuel generator ${tag} done Exercise: refuelled`);
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'One question first' })).toBeVisible();
    const which = dialog.getByRole('group', { name: 'Which one?' });
    await expect(which.getByRole('radio')).toHaveCount(2);
    await expectNoViolations(page);
    await which.getByRole('radio').first().focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await expect(which.getByRole('radio').nth(1)).toBeChecked();
    const picked = (await which.getByRole('radio').nth(1).locator('xpath=..').innerText()).trim();
    await dialog.getByRole('button', { name: 'Continue' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Check the plan' })).toBeVisible();
    await expect(dialog.getByRole('definition').first()).toContainText(
      picked.includes('south') ? 'south' : 'north',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Cancelled' })).toBeVisible();
    await expectNoViolations(page);
    await box.fill('/reminders');
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Found' })).toBeVisible();
    await expect(dialog).toContainText(`Refuel generator ${tag} north`);
    await expect(dialog).toContainText(`Refuel generator ${tag} south`);

    // CMD-34: without a connection nothing is sent, nothing changes and nothing is retried later;
    // the line stays in the box for the person to send again.
    await page.context().setOffline(true);
    await box.fill(`/remind in 30m Offline line ${tag}`);
    await box.press('Enter');
    await expect(
      dialog.getByText(/Not sent: the connection dropped\. Nothing changed\./).first(),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.context().setOffline(false);
    await expect(box).toHaveValue(`/remind in 30m Offline line ${tag}`);
    await box.fill('/reminders');
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Found' })).toBeVisible();
    await expect(dialog).not.toContainText(`Offline line ${tag}`);

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

  test('CMD-06, CMD-29, AC-C09: "this" is the need open on the board; a claim over an unsaved note asks first', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'mass_care_coordinator',
      `Mass care this ${tag}`,
      `l7c-${testInfo.project.name}`,
    );
    const executionId = crypto.randomUUID();
    const filed = await fetch(`${BASE}/api/public/needs/county/westwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': executionId },
      body: JSON.stringify({
        executionId,
        language: 'en',
        needs: ['food_water'],
        address: { line1: `${tag} Context St`, city: 'Westwind', postal: '63003' },
        contactName: 'Context Tester',
        contact: { phone: '+13145550188', email: `context-${tag}@example.org`, preferred: 'email' },
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

    await page.goto('/console/needs');
    await page.getByLabel('Reference').fill(code);
    const row = page.getByRole('row').filter({ hasText: code });
    await row.getByRole('button', { name: 'Act' }).click();
    const note = page.getByLabel('Note');
    await note.fill('Exercise: half typed');

    await page.getByRole('button', { name: /command window/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Command window' });
    const offer = dialog.getByRole('checkbox', {
      name: new RegExp(`need ${code}, open on your screen`),
    });
    await expect(offer).toBeChecked();
    const box = dialog.getByRole('textbox', { name: 'Command' });
    await box.fill('/need this claim');
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Check the plan' })).toBeVisible();
    await expect(dialog.getByRole('definition').first()).toContainText(code);
    // AC-C09: the unsaved note is asked about; there is no plain Confirm.
    const unsaved = dialog.getByRole('group', { name: 'Unsaved changes' });
    await expect(unsaved).toContainText('the note');
    await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
    await expectNoViolations(page);
    await unsaved.getByRole('button', { name: 'Keep my changes and go back to them' }).click();
    await expect(dialog).toBeHidden();
    await expect(note).toBeFocused();
    await expect(note).toHaveValue('Exercise: half typed');
    expect(await statusOf()).toBe('open');

    await page.getByRole('button', { name: /command window/i }).click();
    await box.fill('/need this claim');
    await box.press('Enter');
    await unsaved.getByRole('button', { name: 'Discard my changes and confirm' }).click();
    await expect(dialog.getByRole('heading', { name: 'Saved' })).toBeVisible();
    expect(await statusOf()).toBe('claimed');
    await page.keyboard.press('Escape');
    // The board read the need again.
    await expect(row).toContainText('claimed');

    // Set aside, "this" means nothing and nothing is guessed.
    await page.getByRole('button', { name: /command window/i }).click();
    if (await offer.isVisible()) await offer.uncheck();
    await box.fill('/need this release');
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Nothing found' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await statusOf()).toBe('claimed');
  });

  test('CMD-30: a batch over 50 asks for the count typed; a partly done batch names what it did not change', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(180_000);
    await onboard(
      page,
      context,
      'mass_care_coordinator',
      `Mass care batch ${tag}`,
      `l7b-${testInfo.project.name}`,
    );
    // The engine's batch rules run in commands.db.test.ts against the database; here the two
    // command calls are answered in the browser so the shared exercise needs stay as they are.
    const id = crypto.randomUUID();
    const meta = {
      name: 'needs.claim_many',
      title: 'Claim the open needs a filter names, for your organization',
      usage: '/needs open [category:<category>] [postal:<code>] claim [note]',
      phase: 4,
      kind: 'change',
      confirmation: 'full_review',
      reversal: 'compensating',
      sideEffects: 'Claims each open need the filter names for your organization, one at a time.',
    };
    const base = {
      id,
      usage: meta.usage,
      command: meta,
      options: [],
      error: null,
      undoUntil: null,
      reversalOf: null,
      undoneBy: null,
      createdAt: new Date().toISOString(),
      commands: [],
      aliases: [],
    };
    const plan = {
      description:
        'Claim 51 open needs in food water for your organization: B1, B2, B3, B4, B5 and 46 more.',
      args: { category: 'food_water' },
      target: null,
      eventId: null,
      interpretation: null,
      count: 51,
    };
    let confirmed: unknown = null;
    await page.route('**/api/v1/commands', (route) =>
      route.fulfill({
        json: {
          ...base,
          executionId: crypto.randomUUID(),
          status: 'awaiting_confirmation',
          message: 'Check the plan, then confirm or cancel.',
          plan,
          planHash: 'a'.repeat(64),
          result: null,
        },
      }),
    );
    await page.route(`**/api/v1/commands/${id}/confirm`, (route) => {
      confirmed = route.request().postDataJSON();
      return route.fulfill({
        json: {
          ...base,
          executionId: crypto.randomUUID(),
          status: 'partially_succeeded',
          message:
            'Claimed 50 of 51 needs. Not changed: B7 (That is not available to you, or no longer exists.).',
          plan,
          planHash: null,
          result: {
            state: 'saved',
            summary: 'Claimed 50 of 51 needs.',
            records: [],
            failures: [
              {
                id: crypto.randomUUID(),
                label: 'B7',
                code: 'not_available',
                message: 'That is not available to you, or no longer exists.',
              },
            ],
          },
        },
      });
    });

    await page.goto('/console/');
    await page.getByRole('button', { name: /command window/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Command window' });
    const box = dialog.getByRole('textbox', { name: 'Command' });
    await box.fill('/needs open category:food_water claim');
    await box.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'Check the plan' })).toBeVisible();
    await expect(dialog).toContainText('Claim 51 open needs');
    const count = dialog.getByRole('textbox', { name: 'Type 51 to confirm all of them' });
    const go = dialog.getByRole('button', { name: 'Confirm', exact: true });
    await expect(go).toBeDisabled();
    await count.fill('50');
    await expect(go).toBeDisabled();
    await expectNoViolations(page);
    await count.fill('51');
    await go.click();
    await expect(dialog.getByRole('heading', { name: 'Partly done' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Not changed' })).toBeVisible();
    await expect(dialog.getByRole('listitem').filter({ hasText: 'B7' })).toBeVisible();
    expect(confirmed).toMatchObject({ count: 51 });
    await expectNoViolations(page);
    await page.keyboard.press('Escape');
  });

  test('SEC-13: an EM director prepares a public-records release, confirmed with a reason, and downloads it', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'county_em_director',
      `EM director records ${tag}`,
      `l7p-${testInfo.project.name}`,
    );
    const reference = `PRR-${tag}-${testInfo.project.name}`;
    await page.goto('/console/public-records');
    await expect(page.getByRole('heading', { level: 1, name: 'Records requests' })).toBeVisible();
    await expect(page.getByText(/withheld, column by column/)).toBeVisible();
    await expectNoViolations(page);
    if (testInfo.project.name === 'phone') await expectReflow(page);
    await page.getByLabel('Request reference').fill(reference);
    await page.getByRole('checkbox', { name: 'Sites (confidential sites are left out)' }).check();
    await page.getByRole('checkbox', { name: 'Issued official reports' }).check();
    await page.getByRole('button', { name: 'Prepare the release…' }).click();
    // RULE-14: preparing a release is confirmed with a reason.
    const dialog = page.getByRole('dialog', { name: 'Please confirm' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reason').fill(`Exercise: answering ${reference}`);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText(/The release is being prepared/)).toBeVisible();
    const row = page
      .getByRole('table', { name: 'Releases prepared for this event' })
      .getByRole('row')
      .filter({ hasText: reference });
    const get = row.getByRole('button', { name: `Download release ${reference}` });
    await expect(get).toBeVisible({ timeout: 90_000 });
    await expectNoViolations(page);
    const [file] = await Promise.all([page.waitForEvent('download'), get.click()]);
    expect(file.suggestedFilename()).toMatch(/^public-records-.*\.zip$/);
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

  test('REC-02–REC-12: mass care asks for a shelter, reads why, and accepts it with a reason', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'mass_care_coordinator',
      `Mass care R ${tag}`,
      `l7r-${testInfo.project.name}`,
    );
    await page.goto('/console/recommendations');
    await expect(page.getByRole('heading', { level: 1, name: 'Recommendations' })).toBeVisible();
    await page.getByLabel('What to recommend').selectOption('shelter');
    await page.getByRole('button', { name: 'Work it out' }).click();
    const panel = page.getByRole('region', { name: /^Shelter for tonight, asked/ });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('table', { name: 'Top three shelters' })).toContainText(
      'Harmon High School gym',
    );
    await expect(panel.getByRole('table', { name: 'Places set aside, with why' })).toContainText(
      'a parking lot is not a shelter',
    );
    await expect(panel.getByRole('table', { name: 'Inputs and their age' })).toContainText(
      'Facility registry (oldest re-check)',
    );
    await expect(
      panel.getByRole('heading', { name: 'Who is in reach (equity check)' }),
    ).toBeVisible();
    await expectNoViolations(page);
    if (testInfo.project.name === 'phone') await expectReflow(page);
    await panel
      .getByLabel('Reason for the decision')
      .fill('Exercise: gym has a generator and showers');
    await panel.getByRole('button', { name: 'Record the decision' }).click();
    await expect(page.getByText('Shelter for tonight: accepted.')).toBeVisible();
    await expect(panel.getByText('Accepted', { exact: false }).first()).toBeVisible();

    // The other kinds render with their own tables, and pass axe.
    for (const [kind, title, table] of [
      ['feeding', 'Feeding stops for the canteens', 'Inputs and their age'],
      ['pod', 'Point of distribution and walk-up points', 'Inputs and their age'],
      ['marc', 'Multi-Agency Resource Center', 'Inputs and their age'],
    ] as const) {
      await page.getByLabel('What to recommend').selectOption(kind);
      await page.getByRole('button', { name: 'Work it out' }).click();
      const shown = page.getByRole('region', { name: new RegExp(`^${title}, asked`) });
      await expect(shown).toBeVisible();
      await expect(shown.getByRole('region', { name: table })).toBeVisible();
      // REC-06: each canteen's crew on the roster is shown and counted against the minimum.
      if (kind === 'feeding')
        await expect(
          shown.getByRole('table', { name: 'Canteens on the roster' }).getByRole('columnheader', {
            name: 'Crew on the roster',
          }),
        ).toBeVisible();
      await expectNoViolations(page);
    }
    await expect(page.getByRole('table', { name: 'Recommendations for this event' })).toContainText(
      'Exercise: gym has a generator and showers',
    );
  });

  test('REC-13: a partner posts a service; county EM finds it through discovery and decides it with a reason', async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(360_000);
    const phone = testInfo.project.name === 'phone';
    const name = `Exercise Community Center ${tag} ${testInfo.project.name}`;
    // The partner posts a draft service (the first discovery source).
    await onboard(
      page,
      context,
      'ngo_incident_commander',
      `Canteen lead D ${tag}`,
      `l7d-${testInfo.project.name}`,
      'canteen',
    );
    await goTo(page, 'Our services');
    await page.getByLabel('Kind', { exact: true }).selectOption('feeding');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Street address', { exact: true }).fill('30 Exercise Loop');
    await page.getByLabel('City', { exact: true }).fill('Westwind');
    await page.getByLabel('ZIP', { exact: true }).fill('63003');
    await page.getByLabel('Latitude', { exact: true }).fill('38.802');
    await page.getByLabel('Longitude', { exact: true }).fill('-90.861');
    await page.getByLabel('Wheelchair accessible').check();
    await page.getByRole('button', { name: 'Post as draft' }).click();
    await expect(page.getByRole('status')).toContainText('posted as a draft');

    const project = phone ? devices['Pixel 7'] : devices['Desktop Chrome'];
    const second = await browser.newContext({ ...project, baseURL: BASE, ignoreHTTPSErrors: true });
    try {
      const em = await second.newPage();
      await onboard(
        em,
        second,
        'county_em_director',
        `EM director D ${tag}`,
        `l7d2-${testInfo.project.name}`,
      );
      await em.goto('/console/discovery');
      await expect(em.getByRole('heading', { level: 1, name: 'Resource discovery' })).toBeVisible();
      await expectNoViolations(em);
      await em.getByRole('button', { name: 'Find now' }).click();
      await expect(em.getByText('Asked: the next run starts within a minute')).toBeVisible();
      // The worker runs it within a minute.
      await expect(async () => {
        await em.getByRole('button', { name: 'Refresh' }).click();
        await expect(em.getByRole('table', { name: 'Places found' })).toContainText(name, {
          timeout: 3_000,
        });
      }).toPass({ timeout: 180_000, intervals: [5_000] });
      await em.getByRole('table', { name: 'Places found' }).getByRole('button', { name }).click();
      const detail = em.getByRole('region', { name });
      await expect(detail).toContainText('Posted by Hope Canteen Services as a feeding site');
      await expect(
        detail.getByRole('table', { name: 'Pre-check against the registry criteria' }),
      ).toContainText('Shelter');
      await expect(detail).toContainText('ada: yes');
      await expectNoViolations(em);
      if (phone) await expectReflow(em);
      if (phone) {
        await detail.getByLabel('Decision', { exact: true }).selectOption('reject');
        await detail
          .getByLabel('Reason for the decision')
          .fill('Exercise: a canteen stop, not a building');
        await detail.getByRole('button', { name: 'Record the decision' }).click();
        await expect(em.getByText(`${name}: set aside.`)).toBeVisible();
      } else {
        await detail
          .getByLabel('Reason for the decision')
          .fill('Exercise: walked it with the partner');
        await detail.getByRole('button', { name: 'Record the decision' }).click();
        await expect(em.getByText(`${name}: qualified in.`)).toBeVisible();
        await em.goto('/console/facilities');
        await expect(em.getByRole('table', { name: 'Facilities' })).toContainText(name);
      }
    } finally {
      await second.close();
    }
  });

  test('PUB-11, PUB-12, PUB-14, GATE-08: the PIO reads the social, radio and net texts; the AI assistant says it is off; an AI voice file goes to air only once played through and cleared', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(180_000);
    await onboard(
      page,
      context,
      'public_information_officer',
      `PIO ${tag}`,
      `l7p-${testInfo.project.name}`,
    );
    await page.goto('/console/sites');
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
    const siteName = `Exercise cooling center ${tag} ${testInfo.project.name}`;
    await page.getByLabel('Kind', { exact: true }).selectOption('cooling');
    await page.getByLabel('Name', { exact: true }).fill(siteName);
    await page.getByLabel('Street address', { exact: true }).fill('9 Civic Plaza');
    await page.getByLabel('City', { exact: true }).fill('Westwind');
    await page.getByLabel('ZIP', { exact: true }).fill('63003');
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('status').first()).toContainText('added');
    // GATE-08, PUB-14: an AI voice file is downloaded for air only after a person played it to the
    // end and cleared it with a reason. The stack has no AI voice (ADR-0043), so one file the
    // voice made is stood in for; the server's own gate is proven in drafting.db.test.ts.
    const audioId = crypto.randomUUID();
    let clearedForAir: { by: string; at: string } | null = null;
    const audioFile = (() => {
      const samples = 1600; // 0.2 s of silence at 8 kHz, 8-bit mono
      const b = Buffer.alloc(44 + samples, 0x80);
      b.write('RIFF', 0, 'ascii');
      b.writeUInt32LE(36 + samples, 4);
      b.write('WAVEfmt ', 8, 'ascii');
      b.writeUInt32LE(16, 16);
      b.writeUInt16LE(1, 20);
      b.writeUInt16LE(1, 22);
      b.writeUInt32LE(8000, 24);
      b.writeUInt32LE(8000, 28);
      b.writeUInt16LE(1, 32);
      b.writeUInt16LE(8, 34);
      b.write('data', 36, 'ascii');
      b.writeUInt32LE(samples, 40);
      return b;
    })();
    const audioRow = () => ({
      id: audioId,
      siteId: audioId,
      form: 'netReadout',
      language: 'en',
      script: 'This announcement is read by a computer-generated voice. Exercise net read-out.',
      mimeType: 'audio/wav',
      bytes: audioFile.length,
      sha256: 'stand-in',
      provider: 'stand-in',
      model: 'e2e',
      createdAt: new Date().toISOString(),
      clearedForAir,
    });
    const json = (body: unknown, status = 200) => ({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    await page.route('**/api/v1/alerts/audio?siteId=*', (route) =>
      route.fulfill(json([audioRow()])),
    );
    let airDownloads = 0;
    await page.route(`**/api/v1/alerts/audio/${audioId}/**`, (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname.endsWith('/clear')) {
        if (!req.headers()['x-confirm'])
          return route.fulfill(
            json(
              {
                code: 'confirmation_required',
                message: 'Confirm and give a reason.',
                fields: [],
                retryable: false,
                details: { action: 'site.publish' },
              },
              428,
            ),
          );
        expect(req.headers()['x-reason']).toBe(
          'Exercise: played to the end, it matches the script',
        );
        expect(req.postDataJSON()).toEqual({ heardToTheEnd: true });
        clearedForAir = { by: audioId, at: new Date().toISOString() };
        return route.fulfill(json(audioRow()));
      }
      if (url.searchParams.get('for') === 'listening')
        return route.fulfill({ status: 200, contentType: 'audio/wav', body: audioFile });
      airDownloads++;
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: audioFile });
    });
    const row = page.getByRole('row').filter({ hasText: siteName });
    await row.getByRole('button', { name: 'Alert draft' }).click();
    const drafts = page.getByRole('region', { name: `Alert drafts for ${siteName}` });
    await expect(drafts).toBeVisible();
    for (const label of [
      'English, 90',
      'Social media post',
      'Radio loop (TIS)',
      'Amateur radio net read-out',
      'Publicación en redes sociales',
    ])
      await expect(drafts.getByRole('term').filter({ hasText: label }).first()).toBeVisible();
    await expect(drafts).toContainText('This message repeats.');
    await expect(drafts).toContainText('End of traffic.');
    // PUB-12: a graphic per language, named by its alt text, which is shown with it.
    await expect(
      drafts.getByRole('img', { name: new RegExp(`Cooling center open: ${siteName}`) }),
    ).toBeVisible();
    await expect(
      drafts.getByRole('img', { name: new RegExp(`Centro de enfriamiento abierto: ${siteName}`) }),
    ).toBeVisible();
    const png = page.waitForEvent('download');
    await drafts.getByRole('button', { name: 'Download the English image (PNG)' }).click();
    expect((await png).suggestedFilename()).toBe('site-post-en.png');
    await expectNoViolations(page);
    await drafts.getByLabel('Text', { exact: true }).selectOption('radioLoop');
    await drafts.getByRole('button', { name: 'Draft with the AI assistant' }).click();
    await expect(drafts.getByText('The AI drafting assistant is off here.')).toBeVisible();
    // PUB-14: the radio script is ready to speak; with no AI voice configured, it says so.
    await drafts.getByLabel('Script', { exact: true }).selectOption('netReadout');
    await expect(drafts.getByLabel('Script to speak')).toHaveValue(/End of traffic\.$/);
    await drafts.getByRole('button', { name: 'Make the audio file with the AI voice' }).click();
    await expect(drafts.getByText('The AI voice is off here.')).toBeVisible();
    const files = drafts.getByRole('list', { name: `Audio files for ${siteName}` });
    await expect(
      files.getByText('Not cleared for air yet: play it to the end first.'),
    ).toBeVisible();
    await expect(files.getByRole('button', { name: 'Download for air' })).toHaveCount(0);
    const clearButton = files.getByRole('button', { name: 'Clear for air' });
    await expect(clearButton).toBeDisabled();
    await files.getByRole('button', { name: 'Play' }).click();
    const player = files.getByLabel('Amateur radio net read-out, English');
    await expect(player).toBeVisible();
    await expect(clearButton).toBeDisabled();
    // Played to the end (a headless browser has no speakers; the end of the file is what counts).
    await player.evaluate((a: HTMLAudioElement) => a.dispatchEvent(new Event('ended')));
    await expect(files.getByText('Played to the end.', { exact: false })).toBeVisible();
    await expectNoViolations(page);
    await clearButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reason').fill('Exercise: played to the end, it matches the script');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(
      drafts.getByText('Cleared for air. The file can now be downloaded.'),
    ).toBeVisible();
    await expect(files.getByText(/^Cleared for air /)).toBeVisible();
    const wav = page.waitForEvent('download');
    await files.getByRole('button', { name: 'Download for air' }).click();
    expect((await wav).suggestedFilename()).toBe('net-readout-en.wav');
    expect(airDownloads).toBe(1);
    await expectNoViolations(page);
    if (testInfo.project.name === 'phone') await expectReflow(page);
  });

  test("FL-02: mass care finds a survivor's report by address and name; the code shows once they confirm", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    // A resident's report, sent without the worker: they have no code with them later.
    const graph = (await (await fetch(`${BASE}/api/public/intake/county/westwind`)).json()) as {
      graph: { key: string; version: number };
    };
    const executionId = crypto.randomUUID();
    const n = 1000 + (Date.now() % 8000);
    const who = `Ines ${tag}${testInfo.project.name}`;
    const submitted = await fetch(`${BASE}/api/public/intake/county/westwind/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': executionId },
      body: JSON.stringify({
        executionId,
        channel: 'web',
        language: 'en',
        graphKey: graph.graph.key,
        graphVersion: graph.graph.version,
        relationship: 'own_home',
        answers: {
          danger_now: { kind: 'value', value: 'no' },
          relationship: { kind: 'value', value: 'own_home' },
          address: {
            kind: 'value',
            value: { line1: `${n} Survivor Ln`, city: 'Westwind', postal: '63002' },
          },
          home_type: { kind: 'value', value: 'house' },
          cause: { kind: 'value', value: 'wind_tornado' },
          damage_types: { kind: 'value', value: ['roof'] },
          roof_state: { kind: 'value', value: 'large_hole' },
          habitable: { kind: 'value', value: 'no' },
          tonight: { kind: 'value', value: 'no' },
          insurance: { kind: 'unknown' },
          contact_name: { kind: 'value', value: `Exercise ${who}` },
          contact: { kind: 'value', value: { phone: `314557${n}`, preferred: 'text' } },
        },
        needs: [],
        consent: {},
      }),
    });
    expect(submitted.status).toBe(202);
    const code = ((await submitted.json()) as { referenceCode: string }).referenceCode;

    await onboard(
      page,
      context,
      'mass_care_coordinator',
      `Mass care lookup ${tag}`,
      `l7f-${testInfo.project.name}`,
    );
    await page.goto('/console/find-survivor');
    await expect(
      page.getByRole('heading', { level: 1, name: "Find a survivor's record" }),
    ).toBeVisible();
    await expectNoViolations(page);
    if (testInfo.project.name === 'phone') await expectReflow(page);

    // By phone: the same answer whether or not the number is on file, and a wrong code is refused.
    await page.getByLabel('Their phone number').fill(`314 557 ${n}`);
    await page.getByRole('button', { name: 'Text them a code' }).click();
    await expect(
      page.getByText(/If that number is on a report, the survivor gets a text/),
    ).toBeVisible();
    await page.getByLabel('Code they read to you').fill('000000');
    await page.getByRole('button', { name: 'Check the code' }).click();
    await expect(page.getByText(/That code did not match/)).toBeVisible();
    await expectNoViolations(page);

    // By address and name: only the day and how it came in, until they say it is theirs.
    await page.getByRole('radio', { name: /By address and name/ }).check();
    await page.getByLabel('Street address').fill(`${n} survivor ln`);
    await page.getByLabel('Their name').fill(who.toLowerCase());
    const theirs = page.getByRole('button', { name: /They say this one is theirs/ });
    // The intake worker files the report in the background; search again until it has.
    await expect(async () => {
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(theirs).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000, intervals: [4_000] });
    await expect(page.getByText(code)).toHaveCount(0);
    await expect(page.getByText(`${n} Survivor Ln`)).toHaveCount(0);
    await expectNoViolations(page);
    await page.getByLabel('What they recognised (optional)').fill('The day and the online form');
    await theirs.click();
    await expect(page.getByText(`Their reference code is ${code}`)).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('link', { name: 'Open the report' }).click();
    await expect(page).toHaveURL(/\/console\/reports\//);
    // FL-09: documents a survivor shared are shown only when asked for, and only to their readers.
    await page.getByRole('button', { name: 'Show the documents they shared' }).click();
    await expect(page.getByText('Documents are not shown to your role.')).toBeVisible();
    await expectNoViolations(page);
  });
});
