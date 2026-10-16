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
 * in words and a symbol, not by colour or sound (FR-09.05). A role refused a
 * field screen still hears its heading before the reason (WCAG 1.3.1, 2.4.6).
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
    ] as const) {
      await page.goto(`/console/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole('alert')).toContainText('You do not have permission');
      await expectNoViolations(page);
    }
  });
});
