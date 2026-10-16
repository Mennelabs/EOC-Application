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
 * off too.
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
    await page.getByRole('link', { name: 'Our services' }).click();
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

  test('PUB-11, PUB-12, PUB-14: the PIO reads the social, radio and net texts; the AI assistant says it is off', async ({
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
    await expectNoViolations(page);
    if (testInfo.project.name === 'phone') await expectReflow(page);
  });
});
