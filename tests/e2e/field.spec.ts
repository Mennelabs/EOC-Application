/**
 * The field app's web build on a phone viewport (layer-4 plan §9; FLD-01,
 * FLD-03, FLD-08, FLD-11, FLD-13, FLD-14, FLD-16, DCL:DEC-17, ADR-0014): the seeded
 * field lead of the Field Exercise Team sets a PIN, checks in by the event
 * code, saves a quick report while offline ("On this phone") that is
 * received once the signal returns, reports how a site looks for dispatch
 * (FLD-11), records a damage assessment with the
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
          actions: [...me.actions, 'survivor.find', 'document.capture', 'report.read'],
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

    // FLD-08, DCL:DEC-17: an assessment with the damage seen and the details FEMA asks for
    // (depth in feet and inches, renter, flood insurance, utilities out) is received as entered;
    // a depth that is not one is named back and blocks saving.
    const tag = `e2e assessment ${Date.now()}`;
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'New property' }).click();
    await expect(page.getByRole('heading', { name: 'Find the property' })).toBeVisible();
    const thisOne = page.getByRole('button', { name: 'Yes, this one' });
    const landmarkInstead = page.getByRole('button', { name: 'Add a landmark note instead' });
    await expect(thisOne.or(landmarkInstead).first()).toBeVisible({ timeout: 30_000 });
    const atParcel = await thisOne.isVisible();
    await (atParcel ? thisOne : landmarkInstead).click();
    await expect(page.getByRole('heading', { name: 'Damage at this property' })).toBeVisible();
    if (!atParcel) await page.getByLabel('Landmark note').fill('Exercise: blue shed by the levee');
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
    await page.getByLabel('Note (optional)').fill(tag);
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
          return list.find((a) => a.note === tag) ?? null;
        },
        { timeout: 60_000 },
      )
      .toMatchObject({
        degree: 'minor',
        observations: {
          seen: ['roof'],
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
