/**
 * Staff console (CON-01, SEC-07, BRD:FR-01.02, ACC-*): sign-in screen
 * accessibility, and the real onboarding journey: invited through the API,
 * invitation email picked up from the mail sink, password set and passkey
 * registered on a virtual authenticator (Chromium CDP), then the console
 * home shows the role a second administrator approved. Each run creates its
 * own account, so projects never race on a shared user.
 */
import { expect, test } from '@playwright/test';
import { appears, BASE, expectNoViolations, goTo, onboard } from './support/console.ts';

test.describe('console sign-in', () => {
  test('sign-in screen is accessible and asks only for the organization', async ({ page }) => {
    await page.goto('/console/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in');
    await expect(page.getByLabel('Organization')).toBeVisible();
    await expectNoViolations(page);
  });

  test('unknown organization gets a plain error, no stack trace', async ({ page }) => {
    await page.goto('/console/');
    await page.getByLabel('Organization').fill('no-such-realm');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('Unknown organization');
  });

  test('invited staff member: email link, password, passkey, then the console shows the approved role', async ({
    page,
    context,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'virtual authenticator needs Chromium CDP');
    // Once is enough: the journey is the same on every viewport, and parallel
    // runs would race on the shared administrator accounts.
    test.skip(testInfo.project.name !== 'desktop', 'runs on the desktop project only');
    test.setTimeout(120_000);
    await onboard(page, context, 'planning_gis_lead', 'E2E Planner', 'planner');
    await expect(page.getByText('planning_gis_lead')).toBeVisible();
    await expectNoViolations(page);

    await goTo(page, 'Events');
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await expectNoViolations(page);
    // A workspace the person cannot use is not listed (CON-01); the address still shows the denial, never a blank page.
    await expect(page.getByRole('link', { name: 'Permission changes' })).toHaveCount(0);
    await page.goto('/console/approvals');
    await expect(page.getByRole('alert')).toContainText('permission');
  });
});

test.describe('console review (CON-02, CON-05, BRD:FR-12, DCL:DEC-02/03, AIG-01, GATE-03)', () => {
  test('review journey: queue → report → decision with confirmation; intake setup, assisted entry and the AI register are accessible', async ({
    page,
    context,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'virtual authenticator needs Chromium CDP');
    test.skip(testInfo.project.name !== 'desktop', 'runs on the desktop project only');
    test.setTimeout(240_000);

    // Residents' web reports for the queue; the worker files them while the reviewer signs in.
    const graph = (await (await fetch(`${BASE}/api/public/intake/county/westwind`)).json()) as {
      graph: { key: string; version: number };
    };
    const n = Date.now() % 9000;
    const submit = async (
      address: { line1: string; city: string; postal: string },
      phone: string,
    ): Promise<string> => {
      const executionId = crypto.randomUUID();
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
            address: { kind: 'value', value: address },
            home_type: { kind: 'value', value: 'house' },
            cause: { kind: 'value', value: 'wind_tornado' },
            damage_types: { kind: 'value', value: ['roof'] },
            roof_state: { kind: 'value', value: 'large_hole' },
            habitable: { kind: 'value', value: 'no' },
            tonight: { kind: 'value', value: 'yes' },
            insurance: { kind: 'unknown' },
            contact_name: { kind: 'value', value: 'Rosa Delgado' },
            contact: { kind: 'value', value: { phone, preferred: 'text' } },
          },
          needs: ['shelter_tonight'],
          consent: {},
        }),
      });
      expect(submitted.status).toBe(202);
      return ((await submitted.json()) as { referenceCode: string }).referenceCode;
    };
    const code = await submit(
      { line1: `${n} Console Ct`, city: 'Westwind', postal: '63001' },
      `314555${1000 + n}`,
    );
    // CON-05: a report at a parcel of record on a field route, to send to the field.
    const visitCode = await submit(
      { line1: '104 Hickory Way', city: 'Harmon City', postal: '63002' },
      `314556${1000 + n}`,
    );

    await onboard(page, context, 'damage_assessment_coordinator', 'E2E Reviewer', 'reviewer');

    // Queue: need signals first, filter by reference, every row a link (CON-05, PHO-14).
    await goTo(page, 'Review queue');
    await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
    await page.getByLabel('Reference number').fill(code);
    const row = page.getByRole('link', { name: code });
    for (let i = 0; i < 30 && !(await appears(row, 2_000)); i++) {
      await page.getByRole('button', { name: 'Apply' }).click();
    }
    await expect(row).toBeVisible();
    await expectNoViolations(page);

    // Detail: answers as the resident gave them, the FEMA matrix, no notes to the resident.
    await row.click();
    await expect(page.getByRole('heading', { name: `Report ${code}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Answers' })).toBeVisible();
    await expect(page.getByText('Rosa Delgado')).toBeVisible(); // the role holds the contact category
    await expectNoViolations(page);

    // Claim, then approve: the server asks for confirmation and a reason (RULE-14, FR-12.02).
    await page.getByRole('button', { name: 'Start review' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'under review' })).toBeVisible();
    const decide = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Record decision' }),
    });
    await decide.getByLabel('Decision').selectOption('approve');
    await decide.getByLabel('Reason').fill('Photos and answers agree.');
    await decide.getByRole('button', { name: 'Record decision' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Please confirm' })).toBeVisible();
    // The reason written on the form seeds the dialog; the reviewer still confirms it.
    await expect(dialog.getByLabel('Reason')).toHaveValue('Photos and answers agree.');
    await expectNoViolations(page);
    await dialog.getByLabel('Reason').fill('Photos and answers agree. Roof hole seen in photo 1.');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Done: approve' })).toBeVisible();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();

    // CON-05: the second report is sent to the field with a reason; it stays in review and waits
    // under the queue by the route area of its parcel, where a route opens for it.
    await goTo(page, 'Review queue');
    await page.getByLabel('Reference number').fill(visitCode);
    const visitRow = page.getByRole('link', { name: visitCode });
    for (let i = 0; i < 30 && !(await appears(visitRow, 2_000)); i++) {
      await page.getByRole('button', { name: 'Apply' }).click();
    }
    await visitRow.click();
    await page.getByRole('button', { name: 'Start review' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'under review' })).toBeVisible();
    await decide.getByLabel('Decision').selectOption('field_visit');
    await decide.getByLabel('Reason').fill('The photos do not show the roof.');
    await decide.getByRole('button', { name: 'Record decision' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Done: sent to the field' }),
    ).toBeVisible();
    await goTo(page, 'Review queue');
    await page.getByLabel('Event').selectOption({ label: 'Exercise WESTWIND tornado' });
    const visits = page.getByRole('table', {
      name: 'Reports waiting for a field visit, by route area',
    });
    const cedar = visits.getByRole('row', { name: /cedar ridge/ });
    await expect(cedar).toContainText(visitCode, { timeout: 15_000 });
    await expectNoViolations(page);
    await cedar.getByRole('button', { name: 'Open a route for cedar ridge' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /Route .+ opened for \d+ reports? in cedar ridge/ }),
    ).toBeVisible();
    await expect(cedar).toContainText('All on a route');

    // The other layer-2 console screens, each scanned (GATE-03).
    for (const name of ['Intake setup', 'Assisted report', 'AI use register']) {
      // The AI use register is not among the reviewer's workspaces (ai_register.read); its address still shows the screen.
      if (name === 'AI use register') await page.goto('/console/ai-register');
      else await goTo(page, name);
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      if (name === 'Intake setup') {
        // The event's links, keywords and a code to print (CHN-08).
        await expect(page.getByText(/Kiosk \/ assisted link/)).toBeVisible();
        await expect(page.getByRole('img', { name: /Code that opens/ }).first()).toBeVisible({
          timeout: 15_000,
        });
        // FL:FR-28, CHN-08: a door hanger in English and Spanish, each code opening its language.
        await page.getByRole('button', { name: 'Door hanger' }).first().click();
        const hanger = page.getByRole('region', { name: 'Door hanger' }).first();
        await expect(
          hanger.getByRole('img', { name: 'Code that opens the report form in English' }),
        ).toBeVisible();
        await expect(
          hanger.getByRole('img', { name: 'Código que abre el formulario en español' }),
        ).toBeVisible();
        await expect(hanger.getByText('If this is an emergency, call 911.')).toBeVisible();
        await expect(hanger.getByText('Si es una emergencia, llame al 911.')).toBeVisible();
        await expect(hanger.getByText(/lang=es/)).toBeVisible();
        await expectNoViolations(page);
      }
      if (name === 'AI use register') {
        // AIG-09 alerts and PHO-13 agreement sit under the register.
        await expect(page.getByRole('heading', { name: 'Open alerts' })).toBeVisible();
        await expect(
          page.getByRole('heading', { name: 'Severity suggestion: reviewer agreement' }),
        ).toBeVisible();
        // CMD-38: the command window's response times sit there too (this reviewer may not read
        // them; the register's readers see the table, covered in commands.db.test.ts).
        await expect(
          page.getByRole('heading', { name: 'Command window response times' }),
        ).toBeVisible();
      }
      await expectNoViolations(page);
    }
  });
});
