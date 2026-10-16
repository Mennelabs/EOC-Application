/**
 * The field app's web build on a phone viewport (layer-4 plan §9; FLD-01,
 * FLD-03, FLD-08, FLD-11, FLD-13, FLD-14, FLD-16, DCL:DEC-17, ADR-0014): the seeded
 * field lead of the Field Exercise Team sets a PIN, checks in by the event
 * code, saves a quick report while offline ("On this phone") that is
 * received once the signal returns, reports how a site looks for dispatch
 * (FLD-11), checks stock and sends the resupply draft (FL:FR-21, FL:FR-22),
 * matches a lost pet and reads the shelter census (FL:FR-08), works a
 * canteen stop (FL:FR-17; all three with answers stubbed), finds the property on its lot drawn
 * from the outline with the pin (FLD-04), records a damage assessment with the
 * details FEMA asks for, asks the command window for its reminders, opens
 * the conversation note-taker (consent in Spanish; AI off here), uses live
 * translation (medical refused; off here) and asks for an interpreter, presses
 * the help button, leaves a hand-over for the next shift and checks out. Every screen
 * passes axe WCAG 2.2 AA. The session comes from the development test
 * client (the browser sign-in itself is covered by the console journeys);
 * the app keeps it in sessionStorage exactly as after its own sign-in.
 */
import { expect, test } from '@playwright/test';
import { api, expectNoViolations, token } from './support/console.ts';

const LEAD = 'rowan.field@example.org';

test.describe('field app (web build)', () => {
  test.use({
    geolocation: { latitude: 38.7951, longitude: -90.871 },
    permissions: ['geolocation', 'camera'],
  });

  test('check in, offline capture, help, check out', async ({ page, context }, testInfo) => {
    // One account and one shift: the phone project runs it; desktop has the console.
    test.skip(testInfo.project.name !== 'phone', 'field journey runs on the phone viewport');
    test.setTimeout(180_000);
    const accessToken = await token('county', LEAD);
    // A shift left open by an earlier run ends first.
    const open = (await api(accessToken, '/check-ins?mine=true')).body as {
      id: string;
      endedAt: string | null;
    }[];
    for (const c of open.filter((c) => !c.endedAt))
      await api(accessToken, `/check-ins/${c.id}/end`, { body: { reason: 'checked_out' } });
    // CMD-06: dispatch gives the lead's team a job before the shift, so it is on the phone.
    const dispatcher = await token('county', 'casey.dispatch@example.org');
    const events = (await api(dispatcher, '/events')).body as { id: string; name: string }[];
    const westwind = events.find((e) => /westwind/i.test(e.name)) ?? events[0]!;
    const teams = (await api(dispatcher, '/teams')).body as { id: string; key: string }[];
    const fieldTeam = teams.find((x) => x.key === 'field-exercise')!;
    const job = await api(dispatcher, '/missions', {
      body: {
        eventId: westwind.id,
        kind: 'other',
        source: 'staff',
        summary: `Exercise: check the culvert on Cedar Ct (${Date.now()})`,
        location: {
          line1: '140 Cedar Ct',
          city: 'Harmon City',
          position: { lat: 38.795, lon: -90.87 },
          state: 'approximate',
        },
      },
    });
    expect(job.status).toBe(201);
    const jobId = job.body['id'] as string;
    const jobRef = job.body['reference'] as string;
    // Other journeys may leave the team booked or out of service; dispatch overrides with a reason.
    const assigned = await api(dispatcher, `/missions/${jobId}/assignments`, {
      body: {
        resources: [{ kind: 'team', id: fieldTeam.id }],
        overrideReason: 'Exercise: field journey job',
      },
      confirm: 'Exercise: field journey job',
    });
    expect(assigned.status).toBe(201);
    // HAZ-01, BRD:FR-04.05: a downed line reported at the job before the shift reaches the phone.
    const lineDown = `Exercise: line down across the driveway (${Date.now()})`;
    const hazard = await api(dispatcher, '/hazards', {
      body: {
        eventId: westwind.id,
        kind: 'downed_line',
        severity: 'caution',
        summary: lineDown,
        position: { lat: 38.795, lon: -90.87 },
        radiusM: 40,
      },
    });
    expect(hazard.status, JSON.stringify(hazard.body)).toBe(201);
    await context.addInitScript((tok) => {
      sessionStorage.setItem(
        'cgf.session',
        JSON.stringify({
          realm: 'county',
          accessToken: tok,
          refreshToken: null,
          idToken: null,
          expiresAt: Date.now() + 240_000,
          endSession: null,
          tokenEndpoint: '/auth/realms/county/protocol/openid-connect/token',
        }),
      );
    }, accessToken);

    // FL-02: the lead's role reads no reports, so the survivor lookup's answers are stubbed for
    // the phone screen; the lookup itself runs against the database in survivor-lookup.db.test.ts
    // and end to end in the console journey (console-l7.spec.ts).
    await page.route('**/api/v1/me', async (route) => {
      const res = await route.fetch();
      const me = (await res.json()) as { actions: string[] };
      await route.fulfill({
        response: res,
        json: {
          ...me,
          actions: [
            ...me.actions,
            'survivor.find',
            'document.capture',
            'report.read',
            'stock.read',
            'stock.write',
            'pet_intake.read',
            'pet_intake.write',
            'canteen_stop.write',
          ],
        },
      });
    });
    const survivor = {
      reportId: crypto.randomUUID(),
      referenceCode: 'KXRT-4827',
      eventId: null,
      submittedAt: new Date().toISOString(),
      channel: 'sms',
      reviewState: 'submitted',
    };
    await page.route('**/api/v1/survivor-lookup/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/phone'))
        return route.fulfill({
          status: 202,
          json: { status: 'sent', message: 'If that number is on a report, a text is on its way.' },
        });
      if (url.endsWith('/phone/verify')) return route.fulfill({ json: { reports: [survivor] } });
      if (url.endsWith('/address'))
        return route.fulfill({
          json: {
            candidates: [
              {
                reportId: survivor.reportId,
                submittedAt: survivor.submittedAt,
                channel: 'sms',
              },
            ],
          },
        });
      return route.fulfill({ json: survivor });
    });
    // FL-01: a resident's code, scanned or typed, opens the stubbed record.
    await page.route(
      (url) => url.pathname === '/api/v1/reports' && url.searchParams.get('reference') !== null,
      (route) =>
        route.fulfill({
          json:
            new URL(route.request().url()).searchParams.get('reference') === 'KXRT-4827'
              ? [
                  {
                    id: survivor.reportId,
                    referenceCode: 'KXRT-4827',
                    submittedAt: survivor.submittedAt,
                    channelOfOrigin: 'sms',
                    reviewState: 'submitted',
                  },
                ]
              : [],
        }),
    );
    // FL-09: the document is asked for and sent to the stubbed record; nothing else is kept.
    const documentId = crypto.randomUUID();
    const documentRequests: { method: string; body: unknown }[] = [];
    await page.route('**/api/v1/reports/*/documents', (route) => {
      documentRequests.push({
        method: route.request().method(),
        body: route.request().postDataJSON(),
      });
      return route.fulfill({
        status: 201,
        json: {
          documentId,
          uploadPath: `/api/v1/documents/${documentId}/content`,
          status: 'uploading',
        },
      });
    });
    await page.route('**/api/v1/documents/*/content', (route) => {
      documentRequests.push({ method: route.request().method(), body: null });
      return route.fulfill({ json: { documentId, status: 'uploaded' } });
    });

    // FL:FR-21, FL:FR-22: the lead's role holds no stock, so the stock screen's answers are
    // stubbed here; the API itself runs against the database in fieldrecords.db.test.ts.
    const water = {
      id: crypto.randomUUID(),
      sku: 'EX-WATER',
      name: 'Exercise water',
      unit: 'case',
      quantity: 6,
      barcode: '0123456789012',
      reorderAt: 10,
      runningLow: true,
      usedLastDay: 24,
      hoursLeft: 6,
    };
    const tarps = {
      ...water,
      id: crypto.randomUUID(),
      sku: 'EX-TARP',
      name: 'Exercise tarps',
      unit: 'each',
      barcode: null,
      runningLow: false,
      usedLastDay: 0,
      hoursLeft: null,
    };
    const draftLine = {
      stockItemId: water.id,
      name: water.name,
      unit: 'case',
      quantity: 26,
      suggested: 26,
    };
    const supply = (status: string, id = crypto.randomUUID(), siteName = 'Exercise site') => ({
      id,
      version: 1,
      siteId: crypto.randomUUID(),
      siteName,
      status,
      draftedAutomatically: status === 'draft',
      lines: [draftLine],
      note: null,
      sentAt: null,
      filledAt: null,
      missionId: null,
      canceledAt: null,
    });
    const draftId = crypto.randomUUID();
    const supplySteps: { url: string; ifMatch: string | undefined; body: unknown }[] = [];
    await page.route('**/api/v1/field-records/stock_item**', (route) =>
      route.fulfill({ json: [water, tarps] }),
    );
    await page.route('**/api/v1/supply-requests**', (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        supplySteps.push({
          url: req.url(),
          ifMatch: req.headers()['if-match'],
          body: req.postDataJSON(),
        });
        return route.fulfill({ json: supply(req.url().endsWith('/send') ? 'sent' : 'filled') });
      }
      return route.fulfill({
        json: req.url().includes('status=sent')
          ? [supply('sent', crypto.randomUUID(), 'Exercise north pantry')]
          : [supply('draft', draftId)],
      });
    });

    // FL:FR-08: the same for the pets screen; matching runs against the database in
    // fieldrecords.db.test.ts.
    const lostDog = {
      id: crypto.randomUUID(),
      species: 'dog',
      description: 'Brown terrier, red collar',
      ownerReferenceCode: 'WW7M2P',
      status: 'lost_report',
      matchedWith: null,
    };
    const shelteredDog = {
      ...lostDog,
      id: crypto.randomUUID(),
      description: 'Small brown terrier',
      ownerReferenceCode: null,
      status: 'sheltered',
    };
    const homeward = {
      ...lostDog,
      id: crypto.randomUUID(),
      species: 'cat',
      description: 'Grey tabby',
      matchedWith: crypto.randomUUID(),
    };
    const petSteps: { url: string; body: unknown }[] = [];
    await page.route('**/api/v1/field-records/pet_intake**', (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() === 'POST') {
        petSteps.push({ url, body: req.postDataJSON() });
        return route.fulfill({ json: lostDog });
      }
      if (url.includes('/census'))
        return route.fulfill({
          json: [
            {
              siteId: crypto.randomUUID(),
              siteName: 'Exercise shelter',
              total: 3,
              bySpecies: { dog: 2, cat: 1 },
            },
          ],
        });
      if (url.includes('/candidates'))
        return route.fulfill({ json: [{ record: shelteredDog, shared: ['brown', 'terrier'] }] });
      return route.fulfill({ json: [lostDog, homeward] });
    });

    await page.goto('/field/');
    await expect(page.getByRole('heading', { name: 'Choose a PIN for this phone' })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
    await page.getByLabel('PIN (at least 6 digits)').fill('246810');
    await page.getByLabel('Enter the PIN again').fill('246810');
    await page.getByRole('button', { name: 'Save PIN' }).click();

    // FLD-03: check in by the event code.
    await expect(page.getByRole('heading', { name: 'Check in' })).toBeVisible({ timeout: 30_000 });
    await expectNoViolations(page);
    await page.getByLabel('Event code').fill('westwind');
    await page.getByRole('button', { name: 'Check in' }).click();
    await expect(page.getByRole('heading', { name: 'My shift' })).toBeVisible({ timeout: 30_000 });
    await expectNoViolations(page);

    // FLD-13: a quick report saved with no signal waits on the phone, then is received.
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Quick report' }).click();
    await expect(page.getByRole('heading', { name: 'Quick report' })).toBeVisible();
    await page.getByRole('radio', { name: 'gas leak' }).click();
    await page.getByRole('radio', { name: 'Dangerous' }).click();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByText(/Saved on this phone/)).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('link', { name: 'On this phone' }).click();
    await expect(page.getByRole('heading', { name: 'On this phone' })).toBeVisible();
    await expect(page.getByText('On this phone', { exact: true }).last()).toBeVisible();
    await expectNoViolations(page);
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByText(/Received|Nothing waiting/).first()).toBeVisible({
      timeout: 60_000,
    });

    // FLD-11: how a site looks, from the same quick report: an observation with the phone's
    // position that reaches dispatch, not the site's status of record.
    const siteNote = `Exercise: line out the door (${Date.now()})`;
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Quick report' }).click();
    await page.getByRole('radio', { name: 'How a site looks' }).click();
    await page.getByRole('radiogroup', { name: 'Which site?' }).getByRole('radio').first().click();
    await page.getByRole('radio', { name: 'Full', exact: true }).click();
    await page.getByLabel('Note (optional)').fill(siteNote);
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByText(/a site's lead still confirms its status/)).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('link', { name: 'On this phone' }).click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect
      .poll(
        async () => {
          const board = await api(dispatcher, `/dispatch/board?eventId=${westwind.id}`);
          const reports = (board.body['fieldReports'] ?? []) as {
            note: string | null;
            siteStatus: string | null;
          }[];
          return reports.find((r) => r.note === siteNote)?.siteStatus ?? null;
        },
        { timeout: 60_000 },
      )
      .toBe('full');

    // FL:FR-21, FL:FR-22: stock shows how fast it runs down; the resupply draft started at the
    // reorder point is checked and sent by a person; the warehouse marks a site's request filled.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Stock' }).click();
    await expect(page.getByRole('heading', { name: 'Stock', level: 1 })).toBeVisible();
    await page.getByRole('radiogroup', { name: 'Site' }).getByRole('radio').first().click();
    await expect(
      page.getByText('Handed out in the last day: 24 case · lasts about 6 hours at that rate'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Resupply request (not sent yet)' }),
    ).toBeVisible();
    await expect(page.getByText(/nothing is sent until you send it/)).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Send request to the warehouse' }).click();
    await expect(page.getByText('Request sent to the warehouse.')).toBeVisible();
    expect(supplySteps[0]).toMatchObject({
      ifMatch: '"1"',
      body: { lines: [{ stockItemId: water.id, quantity: 26 }] },
    });
    expect(supplySteps[0]!.url).toContain(`/supply-requests/${draftId}/send`);
    await page.getByRole('button', { name: 'Mark filled: Exercise north pantry' }).click();
    await expect(page.getByText('Request marked filled.')).toBeVisible();
    expect(supplySteps[1]!.url).toMatch(/\/fill$/);
    // An item found by its barcode, typed when there is no camera.
    await page.getByRole('textbox', { name: 'Barcode', exact: true }).first().fill('0123456789012');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(
      page.getByRole('heading', { name: 'Exercise water', level: 3, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Exercise tarps', level: 3, exact: true }),
    ).toHaveCount(0);
    await expectNoViolations(page);

    // FL:FR-08: the shelter census, a lost report matched by a person from a suggestion that
    // says which words the descriptions share, and a matched pet marked gone home.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Pets: shelters, lost and found' }).click();
    await expect(page.getByText('Exercise shelter: 3 (Dog 2, Cat 1)')).toBeVisible();
    await expect(
      page.getByText('Dog: Brown terrier, red collar · owner’s code WW7M2P'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Possible matches for this Dog' }).click();
    await expect(page.getByText('Words in common: brown, terrier')).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'This is the same pet' }).click();
    await expect(page.getByText('Match confirmed.')).toBeVisible();
    expect(petSteps[0]).toMatchObject({ body: { otherId: shelteredDog.id } });
    expect(petSteps[0]!.url).toContain(`/pet_intake/${lostDog.id}/match`);
    await page.getByRole('button', { name: 'This Cat went home' }).click();
    await expect(page.getByText('Marked as gone home.')).toBeVisible();
    expect(petSteps[1]!.url).toContain(`/pet_intake/${homeward.id}/reunite`);
    await expectNoViolations(page);

    // FL:FR-17: a canteen stop checked in, meals counted, checked out with what is left and an
    // allergen note. The lead's role holds no canteen grant, so for this step the command upload
    // is stubbed and the queued commands are read; the API runs in fieldrecords.db.test.ts.
    const uploaded: { id: string; kind: string; body: Record<string, unknown> }[] = [];
    await page.route('**/api/v1/field/commands', (route) => {
      const req = route.request().postDataJSON() as { commands: typeof uploaded };
      uploaded.push(...req.commands);
      return route.fulfill({
        json: {
          results: req.commands.map((c) => ({
            id: c.id,
            kind: c.kind,
            result: 'applied',
            status: 200,
            record: null,
          })),
          device: null,
        },
      });
    });
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Canteen route' }).click();
    await expect(page.getByRole('heading', { name: 'Canteen route', level: 1 })).toBeVisible();
    await expect(
      page.getByText('Your route is not on this phone. Name each stop as you arrive.'),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Stop', exact: true }).fill('Exercise Pine Park lot');
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Check in at this stop' }).click();
    await expect(page.getByText('Checked in at Exercise Pine Park lot.')).toBeVisible();
    await page.getByRole('button', { name: '+10 meals' }).click();
    await page.getByRole('button', { name: '+1 meal', exact: true }).click();
    await expect(page.getByText('Meals served here: 11')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Supplies left on the truck' })
      .fill('40 meals, 3 cases of water');
    await page
      .getByRole('textbox', { name: 'Allergen note (optional)' })
      .fill('Chili contains peanuts');
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Check out of this stop' }).click();
    await expect(page.getByText('Checked out of Exercise Pine Park lot: 11 meals.')).toBeVisible();
    await expect
      .poll(
        () => uploaded.find((c) => c.kind === 'record.canteen_stop.check_out')?.body['mealsServed'],
        {
          timeout: 30_000,
        },
      )
      .toBe(11);
    const arrival = uploaded.find((c) => c.kind === 'record.canteen_stop')!;
    expect(arrival.body).toMatchObject({ stopName: 'Exercise Pine Park lot' });
    expect(uploaded.find((c) => c.kind === 'record.canteen_stop.check_out')!.body).toMatchObject({
      stopClientUuid: arrival.id,
      suppliesLeft: '40 meals, 3 cases of water',
      allergenNote: 'Chili contains peanuts',
    });
    await page.unroute('**/api/v1/field/commands');

    // FLD-08, DCL:DEC-17: an assessment with the damage seen and the details FEMA asks for
    // (depth in feet and inches, renter, flood insurance, utilities out) is received as entered;
    // a depth that is not one is named back and blocks saving.
    const tag = `e2e assessment ${Date.now()}`;
    await page.getByRole('link', { name: 'Home' }).click();
    // Standing on a lot of the seeded Cedar Ridge grid (100 Hickory Way, SYN-CED-0001).
    await context.setGeolocation({ latitude: 38.79527, longitude: -90.869654 });
    await page.getByRole('button', { name: 'New property' }).click();
    await expect(page.getByRole('heading', { name: 'Find the property' })).toBeVisible();
    const thisOne = page.getByRole('button', { name: 'Yes, this one' });
    // FLD-04: on the lot, the question shows its address and the lot drawn from its outline with
    // the pin, one image named in words.
    await expect(thisOne).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('img', {
        name: 'Outline of the lot at 100 Hickory Way, Harmon City, with the lots around it. Your position is inside this lot.',
      }),
    ).toBeVisible();
    await expectNoViolations(page);
    await thisOne.click();
    await expect(page.getByRole('heading', { name: 'Damage at this property' })).toBeVisible();
    await page.getByRole('radio', { name: /^Minor/ }).click();
    await page.getByRole('checkbox', { name: 'Roof', exact: true }).click();
    await page.getByLabel('Basement, feet').fill('5');
    await page.getByLabel('Basement, inches').fill('10');
    await page.getByLabel('Crawl space, inches').fill('14');
    await expect(page.getByText(/Crawl space: enter feet, and 0 to 11 inches/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Crawl space, inches').fill('4');
    await page.getByRole('radio', { name: 'Renter' }).click();
    await page.getByRole('checkbox', { name: 'Flood', exact: true }).click();
    await page
      .getByRole('radiogroup', { name: 'Is power, water or gas out?' })
      .getByRole('radio', { name: 'Yes' })
      .click();
    // GATE-08, FLD-09, INT-13: each field drafted from the volunteer's words waits for a yes or
    // no; only a yes changes the form. The stack has no AI provider (ADR-0043), so the draft
    // reply is stood in for; the assessment itself goes to the real server.
    const voiceDraftId = crypto.randomUUID();
    await page.route('**/api/v1/field-assessments/draft', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          draftId: voiceDraftId,
          drafts: [
            { field: 'seen', value: 'tree_on_home', evidence: 'a tree came down on it' },
            { field: 'water_inside', value: 'yes', evidence: 'water by the door' },
          ],
          injectionSuspected: false,
          provider: { provider: 'stand-in', model: 'e2e' },
          notice: 'A computer drafted these from your words. Check each one.',
        }),
      }),
    );
    const tree = page.getByRole('checkbox', { name: 'Tree on the home', exact: true });
    await expect(tree).not.toBeChecked();
    await page
      .getByLabel('Note (optional)')
      .fill(`${tag}: a tree came down on it, water by the door`);
    await page.getByRole('button', { name: 'Fill in from my words' }).click();
    await expect(page.getByText('You said: “a tree came down on it”')).toBeVisible();
    await expect(page.getByText('Damage seen: Tree on the home')).toBeVisible();
    await expect(page.getByText('Water got into the living area')).toBeVisible();
    // Nothing is used until the volunteer answers each one.
    await expect(tree).not.toBeChecked();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Yes, use it' }).first().click();
    await expect(tree).toBeChecked();
    await page.getByRole('button', { name: 'No', exact: true }).click();
    await expect(page.getByText('Used', { exact: true })).toBeVisible();
    await expect(page.getByText('Not used', { exact: true })).toBeVisible();
    await page.unroute('**/api/v1/field-assessments/draft');
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Saved on this phone/)).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('link', { name: 'On this phone' }).click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect
      .poll(
        async () => {
          const list = (await api(accessToken, '/field-assessments?limit=20')).body as {
            note: string | null;
            degree: string;
            observations: Record<string, unknown>;
          }[];
          return list.find((a) => a.note?.startsWith(tag)) ?? null;
        },
        { timeout: 60_000 },
      )
      .toMatchObject({
        degree: 'minor',
        observations: {
          seen: ['roof', 'tree_on_home'],
          // The water draft was turned down: the form keeps what the volunteer had.
          water_inside: 'unknown',
          voice_draft: voiceDraftId,
          voice_used: ['seen:tree_on_home'],
          flood_depth_basement_in: 70,
          flood_depth_crawl_space_in: 4,
          occupancy: 'rent',
          insurance: ['flood'],
          utilities_out: 'yes',
        },
      });

    // FL-07, CMD-34: ask or command from the phone; it needs the connection and keeps nothing.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Ask or command' }).click();
    await expect(page.getByRole('heading', { name: 'Ask or command' }).first()).toBeVisible();
    await page.getByLabel('What you need').fill('/reminders');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page.getByText(/open reminder|reminders?:/i)).toBeVisible();
    await expectNoViolations(page);
    // CMD-34: without signal nothing is sent, and nothing goes later by itself.
    await context.setOffline(true);
    await page.getByLabel('What you need').fill('/remind in 30m Exercise offline line');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page.getByText(/Commands need a connection\. Nothing was sent/)).toBeVisible();
    await expectNoViolations(page);
    await context.setOffline(false);
    await page.getByLabel('What you need').fill('/reminders');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page.getByText(/open reminder|reminders?:/i)).toBeVisible();
    await expect(page.getByText(/Exercise offline line/)).toHaveCount(0);

    // CMD-06: opened from a job, "this" means that job's mission, and the screen says so.
    await page.getByRole('link', { name: 'Home' }).click();
    const jobCard = page
      .getByRole('heading', { name: new RegExp(`^${jobRef} `) })
      .locator('xpath=..');
    await jobCard.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('heading', { name: 'Hazards at this job' })).toBeVisible();
    // The seeded exercise has hazards near Cedar Ct too; this one is the line down at the job.
    await expect(
      page.getByText(`The job is inside a hazard area: downed power line — ${lineDown}`),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Ask or command about this job' }).click();
    await expect(page.getByText(`"This" means mission ${jobRef}`, { exact: false })).toBeVisible();
    await page.getByLabel('What you need').fill('/mission this');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page.getByText(new RegExp(jobRef)).last()).toBeVisible();
    await expect(page.getByText(/check the culvert on Cedar Ct/).last()).toBeVisible();
    await expectNoViolations(page);

    // FL-02: a survivor without their code shows it is them before anything is shown.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: "Find a survivor's record" }).click();
    await expect(page.getByRole('heading', { name: "Find a survivor's record" })).toBeVisible();
    await expectNoViolations(page);
    // FL-01: their code from the confirmation's QR link, or typed; a code nobody has says so.
    await page.getByLabel('Reference code').fill('ZZZZ-2222');
    await page.getByRole('button', { name: 'Open their record' }).click();
    await expect(page.getByText(/No report you can see has that code/)).toBeVisible();
    await page
      .getByLabel('Reference code')
      .fill('https://help.example.org/county/my-report?ref=KXRT-4827');
    await page.getByRole('button', { name: 'Open their record' }).click();
    await expect(page.getByText(/Reference code KXRT-4827/)).toBeVisible();
    await page.getByRole('radio', { name: /By phone/ }).click();
    await page.getByLabel('Their phone number').fill('314 555 0142');
    await page.getByRole('button', { name: 'Text them a code' }).click();
    await expect(page.getByText(/they get a text with a code/)).toBeVisible();
    await page.getByLabel('Code they read to you').fill('123456');
    await page.getByRole('button', { name: 'Check the code' }).click();
    await expect(page.getByText(/Reference code KXRT-4827/)).toBeVisible();
    await page.getByRole('radio', { name: /By address and name/ }).click();
    await page.getByLabel('Street address').fill('140 Cedar Ct');
    await page.getByLabel('Their name').fill('Maria Lopez');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText(/KXRT-4827/)).toHaveCount(0);
    await page.getByRole('button', { name: /They say this is theirs/ }).click();
    await expect(page.getByText(/Reference code KXRT-4827/)).toBeVisible();
    await expectNoViolations(page);

    // FL-09: a document they choose to share goes straight into the record, asked in their language.
    await page.getByRole('button', { name: 'Add a document they share' }).click();
    await expect(page.getByRole('heading', { name: 'Add a document they share' })).toBeVisible();
    await page.getByRole('radio', { name: 'Lease or rental agreement' }).click();
    await page.getByRole('radio', { name: 'Español' }).click();
    await expect(
      page.getByText(/¿Puedo tomar una foto de su contrato de arrendamiento/),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'They said no' }).click();
    await expect(page.getByText('Nothing was taken.')).toBeVisible();
    expect(documentRequests).toEqual([]);
    await page.getByRole('radio', { name: 'Lease or rental agreement' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /They tapped yes/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'lease.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(page.getByText(/The photo is in their record/)).toBeVisible({ timeout: 15_000 });
    expect(documentRequests.map((r) => r.method)).toEqual(['POST', 'PUT']);
    expect(documentRequests[0]!.body).toMatchObject({
      kind: 'lease',
      contentType: 'image/jpeg',
      consent: { method: 'tapped', language: 'es' },
    });
    expect((documentRequests[0]!.body as { consent: { text: string } }).consent.text).toMatch(
      /^¿Puedo tomar una foto de su contrato de arrendamiento/,
    );
    await expectNoViolations(page);

    // FL-04, FL-05, FL-18: the conversation note-taker asks first, in the person's language,
    // and is never for counseling; with no AI provider configured it says so and records nothing.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Conversation note-taker' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation note-taker' })).toBeVisible();
    await expect(page.getByText(/Never for counseling, spiritual care or prayer/)).toBeVisible();
    await page.getByRole('radio', { name: 'Español' }).click();
    await expect(page.getByText(/¿Puedo usar un asistente de notas/)).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'They tapped yes' }).click();
    await expect(page.getByText(/The scribe is off here/)).toBeVisible();
    await expect(page.getByText(/^Listening/)).toHaveCount(0);

    // FL-14, FL:FR-24: live translation is labelled and never for consent, legal or medical
    // conversations; an interpreter is one tap away (with no AI provider, translation is off).
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Live translation' }).click();
    await expect(page.getByRole('heading', { name: 'Live translation' })).toBeVisible();
    await page.getByRole('radio', { name: 'Medical' }).click();
    await expect(page.getByText(/always use a human interpreter/)).toBeVisible();
    await expect(page.getByLabel('What you say')).toHaveCount(0);
    await page.getByRole('radio', { name: 'General' }).click();
    await page.getByLabel('What you say').fill('We have water and cots tonight.');
    await page.getByRole('button', { name: 'Translate for them' }).click();
    await expect(page.getByText(/Machine translation is off here/)).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Bring in an interpreter' }).click();
    await expect(page.getByText(/Interpreter requested by phone/)).toBeVisible();
    // Mass care reads the interpreter queue (FL:FR-24); the request is there once it is sent.
    const massCare = await token('county', 'luis.masscare@example.org');
    await expect
      .poll(
        async () => {
          const r = await api(massCare, '/field-records/interpreter_request?state=open');
          return Array.isArray(r.body)
            ? (r.body as { note: string | null }[]).some((x) => x.note === 'From live translation')
            : r.status;
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    // FLD-16: the help button asks once, then dispatch has the alert.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: /Need help/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Send a help alert to dispatch?' }),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Send help alert' }).click();
    await expect(page.getByText(/Dispatch has your help alert|Help alert saved/)).toBeVisible({
      timeout: 30_000,
    });
    // The exercise field coordinator clears it so the board journeys start quiet.
    const staff = await token('county', 'casey.dispatch@example.org');
    const alerts = (await api(staff, '/safety-alerts?open=true')).body as {
      id: string;
      version: number;
      kind: string;
    }[];
    for (const a of alerts.filter((a) => a.kind === 'help_button'))
      await api(staff, `/safety-alerts/${a.id}/acknowledge`, { body: {}, version: a.version });
    // The exercise job is canceled so the board journeys start quiet too.
    const current = await api(dispatcher, `/missions/${jobId}`);
    await api(dispatcher, `/missions/${jobId}/cancel`, {
      method: 'POST',
      version: current.body['version'] as number,
      confirm: 'Exercise job for the field journey (e2e)',
    });

    // FLD-14: check-out ends the shift and clears resident details from the phone.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'My shift' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expectNoViolations(page);
    // FL-12: the hand-over for the next shift, drafted from this shift's own records, then check-out.
    await page.getByRole('button', { name: 'Hand-over for the next shift' }).click();
    await expect(page.getByRole('heading', { name: 'Hand-over for the next shift' })).toBeVisible();
    const note = page.getByLabel('Hand-over note');
    await expect(note).toHaveValue(/Damage assessments recorded: \d+/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Draft with the AI assistant' }).click();
    await expect(page.getByText(/The AI drafting assistant is off here/)).toBeVisible();
    await expectNoViolations(page);
    const handoverTag = `Exercise: north door sticks ${Date.now()}`;
    await note.fill(`${await note.inputValue()} ${handoverTag}`);
    await page.getByRole('button', { name: 'Save and check out' }).click();
    await expect
      .poll(
        async () =>
          (
            (await api(accessToken, '/handovers?mine=true&limit=5')).body as { text: string }[]
          ).some((h) => h.text.includes(handoverTag)),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (
            (await api(accessToken, '/check-ins?mine=true')).body as { endedAt: string | null }[]
          ).every((c) => c.endedAt !== null),
        { timeout: 30_000 },
      )
      .toBe(true);
    // The exercise hazard is cleared so other journeys do not walk into it.
    const cleared = await api(dispatcher, `/hazards/${hazard.body['id'] as string}/clear`, {
      body: {},
      version: hazard.body['version'] as number,
      confirm: 'Exercise: journey finished',
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  });
});
