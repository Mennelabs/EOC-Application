/**
 * Every console screen that no task journey opens gets its axe scan here
 * (GATE-03, NFR-01): the layer-1 administration screens (events,
 * organizations, staff accounts, personnel, roles, permission changes,
 * audit, emergency access, retention) and the layer-3 and layer-4 screens the
 * journeys pass by (resources, partner agreements, board replay, shelters,
 * volunteer reception, reminders, field devices, messages to the field, net
 * control, badges). Each one opens with its heading, settles without an
 * error, passes axe with WCAG 2.2 AA rules and, on the phone, reflows without
 * sideways scrolling (ACC-07). Two screens also check what they promise:
 * retention reads in years and days (SEC-13), and an overdue reminder says so
 * in words and a symbol, not by colour or sound (FR-09.05). A badge photo
 * taken in the console waits for a second person (BRD:FR-13.01). A role refused a
 * field screen still hears its heading before the reason (WCAG 1.3.1, 2.4.6).
 * A walk-up volunteer signs up on their own phone through the desk code and
 * reception registers them (FL:FR-20). A health notice is approved by someone
 * other than its drafter and shows on Find help for its ZIP until lifted
 * (FL:FR-06).
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoViolations, expectReflow, onboard } from './support/console.ts';

const tag = Date.now().toString(36);

const SCREENS: [path: string, heading: string][] = [
  ['events', 'Events'],
  ['tenants', 'Organizations'],
  ['accounts', 'Staff accounts'],
  ['personnel', 'Personnel'],
  ['roles', 'Roles'],
  ['approvals', 'Permission changes'],
  ['audit', 'Audit log'],
  ['break-glass', 'Emergency access (break-glass)'],
  ['retention', 'Retention and legal holds'],
  ['resources', 'Resources'],
  ['partners', 'Partner organizations'],
  ['replay', 'Board replay'],
  ['shelters', 'Shelters'],
  ['reception', 'Volunteer reception'],
  ['health-notices', 'Health notices'],
  ['reminders', 'Reminders'],
  ['devices', 'Field devices'],
  ['field-messages', 'Messages to the field'],
  ['net-control', 'Net control log'],
  ['badges', 'Badges'],
  ['roster', 'Roster and check-in'],
];

/** Opens a screen and waits until it has loaded: heading shown, nothing still loading. */
async function open(page: Page, path: string, heading: string) {
  await page.goto(`/console/${path}`);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('main').getByText(/Loading/)).toHaveCount(0, { timeout: 15_000 });
}

/** A local date-time two days ago, as a datetime-local input takes it. */
function twoDaysAgo(): string {
  const d = new Date(Date.now() - 2 * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

test.describe('every console screen, one by one', () => {
  test('GATE-03: an administrator opens each screen; axe finds nothing; it reflows on the phone', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(420_000);
    await onboard(
      page,
      context,
      'tenant_admin',
      `Administrator ${tag}`,
      `scr-${testInfo.project.name}`,
    );
    const phone = testInfo.project.name === 'phone';

    for (const [path, heading] of SCREENS) {
      await test.step(heading, async () => {
        await open(page, path, heading);
        await expect(page.getByRole('alert'), `${heading}: no error on opening`).toHaveCount(0);

        if (path === 'retention') {
          // SEC-13: the stored interval reads back as years or days, never "null days".
          const audit = page.getByRole('row').filter({ hasText: /^audit/ });
          await expect(audit).toContainText('7 years');
          await expect(page.getByRole('row').filter({ hasText: /^position trail/ })).toContainText(
            '30 days',
          );
          await expect(page.getByText(/null days|0 years/)).toHaveCount(0);
        }

        if (path === 'roster') {
          // FLD-03: the staging check-in code, with its QR code and the code in letters beside it.
          const panel = page.getByRole('region', { name: 'Staging check-in code' });
          await expect(panel).toBeVisible();
          const qr = panel.getByRole('img', { name: /^Check-in code / });
          if (await qr.count()) await expect(panel.locator('.staging-code-text')).not.toBeEmpty();
        }

        if (path === 'reminders') {
          // FR-09.05: an overdue reminder says so in words, with a symbol hidden from
          // screen readers; nothing depends on colour or sound.
          const title = `Call the shelter manager ${tag}`;
          await page.getByLabel('Title').fill(title);
          await page.getByLabel('Due').fill(twoDaysAgo());
          await page.getByRole('button', { name: 'Set reminder' }).click();
          await expect(page.getByRole('status').filter({ hasText: 'Reminder set.' })).toBeVisible();
          const row = page.getByRole('row').filter({ hasText: title });
          await expect(row).toContainText('Overdue ·');
          // BRD:FR-00.08: the due time is on the county's clock (Central), named, whatever
          // zone the browser runs in (UTC on CI).
          await expect(row).toContainText(/\d (AM|PM) C[DS]T/);
          await expect(row.locator('[aria-hidden="true"]')).toHaveText('⚠ ');
          // Done with it: completed with what was done, it leaves the open list.
          await row.getByLabel(`What was done for “${title}”`).fill('Called; beds confirmed.');
          await row.getByRole('button', { name: 'Complete', exact: true }).click();
          await expect(page.getByRole('status').filter({ hasText: 'Completed.' })).toBeVisible();
          await expect(row).toHaveCount(0);
        }

        await expectNoViolations(page);
        if (phone) await expectReflow(page);
      });
    }
  });

  test('WCAG 1.3.1, 2.4.6: a role refused a field screen still hears its heading, then the reason', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'security_admin',
      `Security ${tag}`,
      `scr-sec-${testInfo.project.name}`,
    );
    for (const [path, heading] of [
      ['field-messages', 'Messages to the field'],
      ['net-control', 'Net control log'],
      // FL-16: peer-support requests are for the peer-support role only.
      ['peer-support', 'Peer support'],
    ] as const) {
      await page.goto(`/console/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole('alert')).toContainText('You do not have permission');
      await expectNoViolations(page);
    }
  });

  test('BRD:FR-13.01, ADM-05 G4: a badge photo taken in the console waits for someone else to approve it; axe finds nothing', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'personnel_coordinator',
      `Photos ${tag}`,
      `scr-photo-${testInfo.project.name}`,
    );
    await open(page, 'personnel', 'Personnel');
    // A person of this county, added here (partner agencies keep their own people).
    const who = `Exercise Photo ${tag}-${testInfo.project.name}`;
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(who);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText(`Added ${who}.`)).toBeVisible();
    await page.getByRole('table', { name: 'Personnel' }).getByRole('button', { name: who }).click();
    await expect(page.getByRole('heading', { name: 'Badge photo', level: 3 })).toBeVisible();
    await page.getByLabel('Take or upload a badge photo').setInputFiles({
      name: 'badge.png',
      mimeType: 'image/png',
      // A tiny synthetic image; the server re-encodes whatever it gets.
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(
      page.getByText('Photo saved. It waits for a second person to approve it.'),
    ).toBeVisible();
    await expect(page.getByRole('img', { name: /waiting for approval$/ })).toBeVisible();
    // Whoever took it cannot approve it.
    await page.getByRole('button', { name: /^Approve photo of/ }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expectNoViolations(page);
  });

  test('FL-16: the peer-support role opens its list of private requests; axe finds nothing', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'crisis_counselor',
      `Peer ${tag}`,
      `scr-peer-${testInfo.project.name}`,
    );
    await open(page, 'peer-support', 'Peer support');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // A county with nobody waiting shows a sentence, not an empty table.
    await expect(
      page
        .getByRole('table', { name: 'Open requests, oldest first' })
        .or(page.getByText('Nobody is waiting.')),
    ).toBeVisible();
    await expect(
      page.getByText('their lead, dispatch and coordinators are not told'),
    ).toBeVisible();
    await expectNoViolations(page);
    if (testInfo.project.name === 'phone') await expectReflow(page);
  });

  test('FL:FR-20: a walk-up signs up on their own phone through the desk code, in either language; reception registers them; axe finds nothing', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    await onboard(
      page,
      context,
      'volunteer_reception',
      `Reception ${tag}`,
      `scr-signup-${testInfo.project.name}`,
    );
    await open(page, 'reception', 'Volunteer reception');
    await page
      .getByLabel('Waiver text in English (optional)')
      .fill('Exercise waiver: I volunteer at my own risk.');
    await page.getByRole('button', { name: 'Open a sign-up code', exact: true }).click();
    await expect(
      page.getByRole('img', { name: 'Code that opens the volunteer sign-up' }),
    ).toBeVisible();
    const link = new URL((await page.locator('.signup-code .url').textContent())!);
    await expectNoViolations(page);

    // The volunteer's own phone: no sign-in; Spanish says the waiver is in English.
    const visitor = await context.newPage();
    await visitor.goto(`${link.pathname}${link.search}&lang=es`);
    await expect(
      visitor.getByRole('heading', { level: 1, name: 'Inscríbase como voluntario' }),
    ).toBeVisible();
    await expect(visitor.getByText('El condado dio esta exención en inglés.')).toBeVisible();
    await expectNoViolations(visitor);
    await visitor.getByRole('link', { name: 'English' }).click();
    await expect(
      visitor.getByRole('heading', { level: 1, name: 'Sign up to volunteer' }),
    ).toBeVisible();
    await expect(visitor.getByText('Exercise waiver: I volunteer at my own risk.')).toBeVisible();
    const who = `Exercise Walkup ${tag}-${testInfo.project.name}`;
    await visitor.getByLabel('Your full name').fill(who);
    await visitor.getByLabel('Phone (optional)').fill('+13145550188');
    await visitor.getByLabel('Chainsaw').check();
    await visitor.getByLabel('I have read the waiver and I accept it.').check();
    await visitor.getByRole('button', { name: 'Sign up', exact: true }).click();
    const code = visitor.locator('#desk-code');
    await expect(code).toHaveText(/^[2-9A-HJ-NP-Z]{4}$/);
    await expect(code).toBeFocused();
    const desk = (await code.textContent())!;
    await expectNoViolations(visitor);

    // Reception sees the request, never the phone number, and registers it.
    await open(page, 'reception', 'Volunteer reception');
    const row = page
      .getByRole('table', { name: 'Waiting at the desk' })
      .getByRole('row')
      .filter({ hasText: desk });
    await expect(row).toContainText(who);
    await expect(row).toContainText('Accepted on the phone');
    await expect(row).not.toContainText('5550188');
    await expectNoViolations(page);
    await row.getByRole('button', { name: `Register ${desk}` }).click();
    await expect(page.getByLabel('Full name')).toHaveValue(who);
    await expect(page.getByText(`desk code ${desk}`)).toBeVisible();
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText(`${who} is registered and checked in.`)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Registered at reception' })).toContainText(who);
    await expect(
      page.getByRole('table', { name: 'Waiting at the desk' }).getByText(desk),
    ).toHaveCount(0);

    // A closed code says so on the phone.
    await page
      .getByRole('button', { name: /^Close the code open until/ })
      .first()
      .click();
    await expect(page.getByText('The sign-up code is closed.')).toBeVisible();
    await visitor.goto(`${link.pathname}${link.search}`);
    await expect(visitor.getByRole('alert')).toContainText('This sign-up code has closed.');
    await visitor.close();
  });

  test('FL:FR-06: public health drafts a boil-water notice; the drafter cannot approve it; someone else does; it shows on Find help for the ZIP in English and Spanish until lifted; axe finds nothing', async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    await onboard(
      page,
      context,
      'public_health_inspector',
      `Health ${tag}`,
      `scr-health-${testInfo.project.name}`,
    );
    await open(page, 'health-notices', 'Health notices');
    const title = `Boil water ${tag}-${testInfo.project.name}`;
    await page.getByLabel('Area, as the public reads it').fill('Exercise Cedar Ridge water system');
    await page.getByLabel('ZIP codes').fill('63002');
    await page.getByLabel('Title in English').fill(title);
    await page
      .getByLabel('Notice in English')
      .fill('Boil tap water for one minute before drinking or cooking.');
    await page
      .getByLabel('Título en español')
      .fill(`Hierva el agua ${tag}-${testInfo.project.name}`);
    await page
      .getByLabel('Aviso en español')
      .fill('Hierva el agua de la llave un minuto antes de beberla o cocinar.');
    await page.getByRole('button', { name: 'Save the draft' }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: title });
    await expect(row).toContainText('waiting for a second person');
    await row.getByRole('button', { name: `Check reach of ${title}` }).click();
    await expect(row).toContainText(/\d+ by text, \d+ by email, \d+ cannot be reached/);
    await expectNoViolations(page);
    // ADM-05 G4: whoever drafted it cannot approve it.
    // ADM-05 G4 refuses before any reason is asked.
    await row.getByRole('button', { name: `Approve and publish ${title}` }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(row).toContainText('waiting for a second person');

    // A second person approves it with a reason.
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await onboard(
      other,
      otherContext,
      'public_information_officer',
      `Health approver ${tag}`,
      `scr-health2-${testInfo.project.name}`,
    );
    await open(other, 'health-notices', 'Health notices');
    const otherRow = other.getByRole('row').filter({ hasText: title });
    await otherRow.getByRole('button', { name: `Approve and publish ${title}` }).click();
    const dialog = other.getByRole('dialog');
    await dialog.getByLabel(/reason/i).fill('Exercise: water main break confirmed');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(other.getByText(`"${title}" is published`)).toBeVisible();
    await expect(otherRow).toContainText('In force');

    // The public page shows it first for the ZIP, in either language.
    const visitor = await context.newPage();
    await visitor.goto('/county/help?near=63002');
    const notices = visitor.getByRole('region', { name: 'Health notices' });
    await expect(notices.getByRole('heading', { name: title })).toBeVisible();
    await expect(notices).toContainText('For your area');
    await expectNoViolations(visitor);
    await visitor.goto('/county/help?near=63002&lang=es');
    await expect(
      visitor
        .getByRole('region', { name: 'Avisos de salud' })
        .getByRole('heading', { name: `Hierva el agua ${tag}-${testInfo.project.name}` }),
    ).toBeVisible();
    await expectNoViolations(visitor);

    // Lifted, it leaves the page.
    await open(other, 'health-notices', 'Health notices');
    await otherRow.getByRole('button', { name: `Lift ${title}` }).click();
    const lift = other.getByRole('dialog');
    await lift.getByLabel(/reason/i).fill('Exercise: water tests clear');
    await lift.getByRole('button', { name: 'Confirm' }).click();
    await expect(other.getByText(`"${title}" has ended (lifted)`)).toBeVisible();
    await visitor.goto('/county/help?near=63002');
    await expect(visitor.getByRole('heading', { name: title })).toHaveCount(0);
    await visitor.close();
    await otherContext.close();
  });
});
