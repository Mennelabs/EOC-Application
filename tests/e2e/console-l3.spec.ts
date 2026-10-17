/**
 * Layer 3 console journeys (CON-04, CON-08, CON-09, PUB-06, NED-07, CNT-01,
 * GATE-02/03): a mass care coordinator sees the key counts, claims and
 * finishes a need on the board, adds a site, confirms it, publishes it
 * through the approval dialog and sees it in the publication log, and opens
 * the contacts registry; a partner organization posts and publishes its own
 * service and the county withdraws it (partner posting, 2026-10-15); every
 * screen passes axe WCAG 2.2 AA.
 */
import { expect, test } from '@playwright/test';
import { BASE, MAIL, expectNoViolations, goTo, onboard } from './support/console.ts';

const tag = Date.now().toString(36);

test.describe('layer 3 console', () => {
  test.describe.configure({ mode: 'serial' });

  test('key counts, needs board, sites, publication log, contacts', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    // A need without a damage report, filed through the public API, for the board.
    const executionId = crypto.randomUUID();
    const filed = await fetch(`${BASE}/api/public/needs/county/westwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': executionId },
      body: JSON.stringify({
        executionId,
        language: 'en',
        needs: ['food_water'],
        address: { line1: `${tag} Board St`, city: 'Westwind', postal: '63003' },
        contactName: 'Board Tester',
        contact: { phone: '+13145550188', email: `board-${tag}@example.org`, preferred: 'email' },
        consent: { relief_agencies: true },
      }),
    });
    expect(filed.status).toBe(202);
    const code = ((await filed.json()) as { referenceCode: string }).referenceCode;

    await onboard(
      page,
      context,
      'mass_care_coordinator',
      `Mass Care ${tag}`,
      `l3-${testInfo.project.name}`,
    );

    // Home: key counts with their as-of time (CON-04).
    await expect(page.getByRole('heading', { name: 'Key counts' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/As of /)).toBeVisible();
    await expectNoViolations(page);

    // Needs board: the filed need appears once the worker swept it; claim it, then finish it (CON-08, NED-07).
    await goTo(page, 'Needs board');
    await expect(page.getByRole('heading', { name: 'Needs board' })).toBeVisible();
    await page.getByLabel('Reference').fill(code);
    const row = page.getByRole('row').filter({ hasText: code });
    await expect(row).toBeVisible({ timeout: 90_000 });
    await expectNoViolations(page);
    await row.getByRole('button', { name: 'Act' }).click();
    await page.getByLabel('Note').fill('Canteen covers Westwind today');
    await page.getByRole('button', { name: 'Claim' }).click();
    await expect(page.getByRole('status')).toContainText('claimed');
    await expect(row).toContainText('claimed');
    await row.getByRole('button', { name: 'Act' }).click();
    await page.getByLabel('Note').fill('Meals delivered');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('status')).toContainText('marked done');
    await expect(row).toContainText('met');

    // Sites: add, confirm, publish with a reason, see it in the log (CON-09, PUB-06).
    await goTo(page, 'Sites');
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
    await expectNoViolations(page);
    const siteName = `Console warming center ${tag}`;
    await page.getByLabel('Kind', { exact: true }).selectOption('warming');
    await page.getByLabel('Name', { exact: true }).fill(siteName);
    await page.getByLabel('Street address', { exact: true }).fill('7 Civic Plaza');
    await page.getByLabel('City', { exact: true }).fill('Westwind');
    await page.getByLabel('ZIP', { exact: true }).fill('63003');
    await page.getByLabel('Latitude', { exact: true }).fill('38.799');
    await page.getByLabel('Longitude', { exact: true }).fill('-90.862');
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('status')).toContainText('added');
    const siteRow = page.getByRole('row').filter({ hasText: siteName });
    await expect(siteRow).toBeVisible();
    await expect(siteRow).toContainText('not published');
    await siteRow.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/reason/i).fill('Opened by the EOC for the cold snap');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('status')).toContainText('published on every channel');
    await expect(siteRow).toContainText('published');
    await goTo(page, 'Publication log');
    await expect(page.getByRole('heading', { name: 'Publication log' })).toBeVisible();
    const logRow = page.getByRole('row').filter({ hasText: siteName });
    await expect(logRow).toBeVisible();
    await expect(logRow).toContainText('Opened by the EOC for the cold snap');
    await expectNoViolations(page);

    // The public page shows the new site at once (PUB-01).
    const pub = await fetch(`${BASE}/api/public/help/county?lang=en`);
    const help = (await pub.json()) as { sites: { name: string }[] };
    expect(help.sites.some((s) => s.name === siteName)).toBe(true);

    // Contacts registry (CNT-01): readable, names only for roles with the category.
    await goTo(page, 'Contacts');
    await expect(page.getByRole('heading', { name: 'Interagency contacts' })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('partner workspace (ADM-02, NED-04, FL-03, AC-17C)', () => {
  test('a partner organization onboards its own staff; the workspace shows only the consented sections; a claim appears under its claims', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    // A resident's report with consent for relief agencies: the canteen gets its feeding sections.
    const graph = (await (await fetch(`${BASE}/api/public/intake/county/westwind`)).json()) as {
      graph: { key: string; version: number };
    };
    const executionId = crypto.randomUUID();
    const n = Date.now() % 9000;
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
            value: { line1: `${n} Partner Pl`, city: 'Westwind', postal: '63002' },
          },
          home_type: { kind: 'value', value: 'house' },
          cause: { kind: 'value', value: 'wind_tornado' },
          damage_types: { kind: 'value', value: ['roof'] },
          roof_state: { kind: 'value', value: 'large_hole' },
          habitable: { kind: 'value', value: 'no' },
          tonight: { kind: 'value', value: 'no' },
          insurance: { kind: 'unknown' },
          contact_name: { kind: 'value', value: 'Rosa Delgado' },
          contact: { kind: 'value', value: { phone: `314556${1000 + n}`, preferred: 'text' } },
        },
        needs: ['food_water'],
        consent: { relief_agencies: true },
      }),
    });
    expect(submitted.status).toBe(202);
    const code = ((await submitted.json()) as { referenceCode: string }).referenceCode;

    // The canteen's own administrators invite and approve the new coordinator (ADM-02).
    await onboard(
      page,
      context,
      'ngo_incident_commander',
      `Canteen ${tag}`,
      `partner-${testInfo.project.name}`,
      'canteen',
    );

    await goTo(page, 'Partner workspace');
    await expect(page.getByRole('heading', { name: 'Partner workspace' })).toBeVisible();
    const shared = page.getByRole('row').filter({ hasText: code });
    await expect(shared).toBeVisible({ timeout: 90_000 }); // once the worker filed it and derived the grant
    await expect(shared).toContainText(/Westwind,? 63002/); // the feeding service sees the area, not the address
    await expect(shared).not.toContainText('Rosa Delgado'); // never the name (NED-04)
    await expect(shared).not.toContainText('Partner Pl'); // nor the exact address
    await expectNoViolations(page);

    // The partner claims the need on the board and sees it under its own claims (CON-08).
    await goTo(page, 'Needs board');
    await page.getByLabel('Reference').fill(code);
    const need = page.getByRole('row').filter({ hasText: code });
    await expect(need).toBeVisible({ timeout: 30_000 });
    await need.getByRole('button', { name: 'Act' }).click();
    await page.getByLabel('Note').fill('Canteen 2 covers Cedar Ridge');
    await page.getByRole('button', { name: 'Claim' }).click();
    await expect(page.getByRole('status')).toContainText('claimed');
    await goTo(page, 'Partner workspace');
    await expect(
      page.getByRole('table', { name: 'Needs your organization holds' }).getByRole('row').filter({
        hasText: code,
      }),
    ).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('partner posting (2026-10-15; PUB-01, PUB-05, PUB-06, CON-16)', () => {
  test('a partner posts and publishes its own service; it is public at once; the county is told, sees who posted it and withdraws it', async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    const name = `Canteen stop ${tag} ${testInfo.project.name}`;
    await onboard(
      page,
      context,
      'ngo_incident_commander',
      `Canteen lead ${tag}`,
      `post-${testInfo.project.name}`,
      'canteen',
    );

    // The partner drafts its service under "Our services".
    await goTo(page, 'Our services');
    await expect(page.getByRole('heading', { name: 'Our services', level: 1 })).toBeVisible();
    await expectNoViolations(page);
    await page.getByLabel('Kind', { exact: true }).selectOption('feeding');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Street address', { exact: true }).fill('12 Exercise Square');
    await page.getByLabel('City', { exact: true }).fill('Westwind');
    await page.getByLabel('ZIP', { exact: true }).fill('63003');
    await page.getByLabel('Latitude', { exact: true }).fill('38.796');
    await page.getByLabel('Longitude', { exact: true }).fill('-90.871');
    await page.getByLabel('Hours', { exact: true }).fill('11:00–19:00');
    await page.getByLabel('What is offered', { exact: true }).fill('hot meals, water');
    await page.getByLabel('Wheelchair accessible').check();
    await page.getByLabel('Spanish').check();
    await page.getByRole('button', { name: 'Post as draft' }).click();
    await expect(page.getByRole('status')).toContainText('posted as a draft');
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText('not published');

    // Its approver publishes it with a reason (PUB-06); it is on the county's page at once (PUB-01).
    await row.getByRole('button', { name: `Publish ${name}…` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/reason/i).fill('Canteen opens at the square for the exercise');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('status')).toContainText('published on every channel');
    await expect(row).toContainText('published');
    await expectNoViolations(page);
    const onPage = async () =>
      (
        (await (await fetch(`${BASE}/api/public/help/county?lang=en`)).json()) as {
          sites: { name: string }[];
        }
      ).sites.some((s) => s.name === name);
    expect(await onPage()).toBe(true);

    // The county's publishers are told, naming the organization (the publication notices).
    await expect
      .poll(
        async () => {
          const found = (await (
            await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`subject:"${name}"`)}`)
          ).json()) as { messages: { ID: string }[] };
          const id = found.messages[0]?.ID;
          if (!id) return '';
          return ((await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()) as { Text: string })
            .Text;
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toContain('Hope Canteen Services');

    // The county sees who posted it and withdraws it.
    const countyContext = await browser.newContext();
    const county = await countyContext.newPage();
    await onboard(
      county,
      countyContext,
      'mass_care_coordinator',
      `County care ${tag}`,
      `post-county-${testInfo.project.name}`,
    );
    await goTo(county, 'Sites');
    const siteRow = county.getByRole('row').filter({ hasText: name });
    await expect(siteRow).toContainText('Hope Canteen Services');
    await goTo(county, 'Publication log');
    await expect(county.getByRole('row').filter({ hasText: name })).toContainText(
      'Posted by Hope Canteen Services',
    );
    await expectNoViolations(county);
    await goTo(county, 'Sites');
    await siteRow.getByRole('button', { name: 'Unpublish' }).click();
    const withdraw = county.getByRole('dialog');
    await withdraw.getByLabel(/reason/i).fill('County withdraws the exercise post');
    await withdraw.getByRole('button', { name: 'Confirm' }).click();
    await expect(county.getByRole('status')).toContainText('taken off every channel');
    expect(await onPage()).toBe(false);
    await countyContext.close();
  });
});
