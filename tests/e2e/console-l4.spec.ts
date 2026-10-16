/**
 * Layer 4 console journeys (layer-4 plan §9; CALL-01, DSP-01/02/03/04/07, FLD-11, FL:FR-19,
 * AC-06C, CON-03, PER-01, DSP-10, BDG-01, ACC-07): a field coordinator takes
 * a phone request as a mission, assigns it from the dispatch board with the
 * keyboard only (a conflict needs a recorded reason and the confirmation dialog), acknowledges any open
 * alert, and opens the roster, the situation map, the net control log and
 * badges; every screen passes axe WCAG 2.2 AA.
 */
import { expect, test } from '@playwright/test';
import {
  BASE,
  administrators,
  api,
  appears,
  expectNoViolations,
  onboard,
  token,
} from './support/console.ts';

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
    // BRD:FR-03.02: an address typed is looked up in the county's parcels, words in any order;
    // a match is the address of record, verified (FR-03.01). A street the county does not know
    // is kept as typed.
    await page.getByLabel('Street address').fill('Cedar Drive 100');
    await page.getByLabel('City').fill('Harmon');
    await page.getByRole('button', { name: 'Find the address', exact: true }).click();
    const found = page.getByRole('list', { name: 'Addresses found' });
    await found.getByRole('button', { name: /^Use 100 Cedar Drive, Harmon City/ }).click();
    await expect(page.getByText("the county's address of record, verified")).toBeVisible();
    await expect(page.getByLabel('Street address')).toHaveValue('100 Cedar Drive');
    await page.getByLabel('Street address').fill(`${tag.slice(-3)} Exercise Ln`);
    await page.getByLabel('Cross streets (optional)').fill('Exercise Ln and Main St');
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Save for dispatch' }).click();
    const heading = page.getByRole('heading', { level: 1, name: /M-\d+/ });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    const reference = /M-\d+/.exec((await heading.innerText()) ?? '')![0];
    // FL:FR-19: the work order lists the equipment the crew logs on the phone, with its hours.
    await expect(
      page.getByRole('table', { name: 'Equipment on this work order: 0 hours in all' }),
    ).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Equipment used', level: 2 })).toBeVisible();
    await expect(page.getByText('None logged.')).toBeVisible();
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
    // AC-06C, RULE-14: a team with conflicts is assigned only with a recorded reason, and the
    // override is consequential, so the confirmation dialog asks for it to be confirmed.
    const why = page.getByLabel('Why assign anyway (recorded)');
    if (!(await appears(done, 8000)) && (await appears(why, 2000))) {
      const reason = 'Exercise: the closest team, checked with the lead by radio';
      await why.fill(reason);
      await send.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      if (await appears(dialog, 8000)) {
        await expectNoViolations(page);
        const field = dialog.getByLabel(/reason/i);
        if (!(await field.inputValue())) await field.fill(reason);
        await dialog.getByRole('button', { name: 'Confirm' }).focus();
        await page.keyboard.press('Enter');
      }
    }
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expectNoViolations(page);

    // DSP-03, MIS-01: a resident's need waits on the board until it is made a mission.
    const intake = (await (await fetch(`${BASE}/api/public/intake/county/westwind`)).json()) as {
      graph: { key: string; version: number };
    };
    const needExecution = crypto.randomUUID();
    const n = Date.now() % 9000;
    const filed = await fetch(`${BASE}/api/public/intake/county/westwind/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': needExecution },
      body: JSON.stringify({
        executionId: needExecution,
        channel: 'web',
        language: 'en',
        graphKey: intake.graph.key,
        graphVersion: intake.graph.version,
        relationship: 'own_home',
        answers: {
          danger_now: { kind: 'value', value: 'no' },
          relationship: { kind: 'value', value: 'own_home' },
          address: {
            kind: 'value',
            value: { line1: `${n} Board Need Ct`, city: 'Westwind', postal: '63001' },
          },
          home_type: { kind: 'value', value: 'house' },
          cause: { kind: 'value', value: 'wind_tornado' },
          damage_types: { kind: 'value', value: ['roof'] },
          roof_state: { kind: 'value', value: 'large_hole' },
          habitable: { kind: 'value', value: 'no' },
          tonight: { kind: 'value', value: 'yes' },
          insurance: { kind: 'unknown' },
          contact_name: { kind: 'value', value: 'Exercise Resident Board' },
          contact: { kind: 'value', value: { phone: `314555${1000 + n}`, preferred: 'text' } },
        },
        needs: ['food_water'],
        consent: {},
      }),
    });
    expect(filed.status).toBe(202);
    const needsTable = page.getByRole('table', {
      name: 'Open needs nobody has made a mission for, oldest first',
    });
    const westwind = async () => {
      const picker = page.getByLabel('Event', { exact: true });
      if (await picker.count()) await picker.selectOption({ label: 'Exercise WESTWIND tornado' });
    };
    await westwind();
    // The worker files the report and its need in the background.
    for (let i = 0; i < 20 && !(await appears(needsTable, 3000)); i++) {
      await page.reload();
      await westwind();
    }
    await expect(needsTable).toBeVisible();
    await expectNoViolations(page);
    await needsTable
      .getByRole('button', { name: /^Make a mission for/ })
      .first()
      .click();
    await expect(page.getByText(/^Mission M-\d+ made for the need\.$/)).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);

    // FLD-11: a resource a field lead came across reaches the board; dispatch marks it noted.
    const admin = await token('county', administrators('county').admin);
    const events = (await api(admin, '/events')).body as unknown as { id: string; name: string }[];
    const ww = events.find((e) => e.name === 'Exercise WESTWIND tornado')!;
    const place = `Exercise water tank ${tag}`;
    const seen = await api(
      await token('county', 'rowan.field@example.org'),
      '/field-records/field_report',
      {
        body: {
          clientUuid: crypto.randomUUID(),
          eventId: ww.id,
          category: 'resource_seen',
          resourceKind: 'water',
          place,
          position: { lat: 38.79, lon: -90.86 },
        },
      },
    );
    expect(seen.status, JSON.stringify(seen.body)).toBe(201);
    await page.reload();
    await westwind();
    const fieldReports = page.getByRole('table', {
      name: 'Site status and resources seen, newest first',
    });
    await expect(fieldReports.getByRole('row', { name: new RegExp(place) })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
    // DSP-01: each open field route's parcel area is listed and outlined on the map.
    const routeAreas = page.getByRole('table', {
      name: 'The parcel area each open field route covers (outlined on the map)',
    });
    await expect(routeAreas.getByRole('row', { name: /willow bend/ })).toBeVisible();
    // DSP-01: route areas, needs, closures and field reports are map layers too, each with its own toggle.
    await page.getByRole('button', { name: 'Show map' }).click();
    await expect(
      page.getByRole('region', {
        name: 'Map of teams, work, route areas, needs, hazards, road closures, sites and field reports. The lists below show the same.',
      }),
    ).toBeVisible();
    const mapLayers = page.getByRole('group', { name: 'Map layers' });
    for (const name of ['Route areas', 'Needs', 'Road closures', 'Field reports'])
      await expect(mapLayers.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['Needs', 'Route areas']) {
      await mapLayers.getByRole('button', { name }).click();
      await expect(mapLayers.getByRole('button', { name })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
    await expectNoViolations(page, { mapMarkers: true });
    await page.getByRole('button', { name: 'Hide map' }).click();
    await fieldReports
      .getByRole('row', { name: new RegExp(place) })
      .getByRole('button', { name: 'Mark noted: water' })
      .click();
    await expect(page.getByText('Report marked noted.')).toBeVisible();
    await expect(fieldReports.getByRole('row', { name: new RegExp(place) })).toHaveCount(0);

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
    // FL:FR-01: where search marks were left, so no block is searched twice.
    await expect(page.getByRole('button', { name: /^Searched/ })).toHaveAttribute(
      'aria-pressed',
      /true|false/,
    );
    await expectNoViolations(page);
  });
});
