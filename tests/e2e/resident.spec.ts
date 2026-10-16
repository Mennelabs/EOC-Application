/**
 * Resident journey against the running stack (AC-11A, AC-11C, GATE-03,
 * GATE-06, RES-01/02, EQ-06, ACC-07, CHN-08): keyboard only from the deep
 * link to a reference number with an axe scan on every screen, the optional
 * questions, then "my report" through the one-time code from the mail sink
 * (with the resident's own PDF copy, FL:FR-32, and a photo added afterwards,
 * CHN-09), a consent change and a withdrawal. A Spanish run and a 320 px reflow check.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MAIL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';
const CODE = /[A-HJKMNP-Z]{4}-[2-9]{4}/;
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
// A real 1×1 PNG: the smallest picture the photo step will accept.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

async function pressButton(page: Page, name: string | RegExp) {
  const button = page.getByRole('button', { name });
  await button.focus();
  await page.keyboard.press('Enter');
}

async function chooseRadio(page: Page, name: string | RegExp) {
  const radio = page.getByRole('radio', { name });
  await radio.focus();
  await page.keyboard.press('Space');
}

async function mailFor(address: string, subjectPart: string, attempts = 60): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    const body = (await res.json()) as { messages: { ID: string; Subject: string }[] };
    const hit = body.messages.find((m) => m.Subject.toLowerCase().includes(subjectPart));
    if (hit) {
      const msg = (await (await fetch(`${MAIL}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      return msg.Text;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no mail to ${address} about "${subjectPart}"`);
}

/** Answers whatever screen is showing with the keyboard, until the review screen. */
async function answerUntilReview(
  page: Page,
  email: string,
  seen: Set<string>,
  stopAt = 'Check your answers',
  street = '12 Oak St',
) {
  for (let i = 0; i < 40; i++) {
    const heading =
      (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim() ?? '';
    if (heading.startsWith(stopAt)) return;
    if (!seen.has(heading)) {
      seen.add(heading);
      await expectNoViolations(page);
    }
    if (heading.startsWith('Is anyone in danger')) {
      await chooseRadio(page, 'No, everyone is safe');
    } else if (
      heading.startsWith('Where is the home') ||
      heading.startsWith('Where is this place')
    ) {
      await page.getByLabel('Street address or description').fill(street);
      await page.getByLabel('City or town').fill('Westwind');
      await page.getByLabel('ZIP code').fill('63001');
    } else if (heading.startsWith('What is the name of your business')) {
      await page.getByRole('textbox').first().fill('Exercise Oak Street Apartments');
    } else if (heading.startsWith('How can we reach you')) {
      await page.getByLabel('Email (optional)').fill(email);
      await chooseRadio(page, 'Email');
    } else if (heading.startsWith('Or tell us in your own words')) {
      // INT-12, AIG-06: speaking goes only through the county's AI service; with none set up
      // here there is no "Speak instead", and never the browser's own speech recognition.
      await expect(page.getByRole('button', { name: 'Speak instead' })).toHaveCount(0);
      await page
        .getByLabel('What happened?')
        .fill('A tree fell on the back bedroom and water came in.');
    } else if (heading.startsWith('Photos of the damage')) {
      await pressButton(page, /Skip photos/);
      continue;
    } else if (heading.startsWith('Do you need help')) {
      const first = page.getByRole('checkbox').first();
      await first.focus();
      await page.keyboard.press('Space');
    } else if (heading.startsWith('Who may see')) {
      // defaults stay "No" (NED-03)
    } else if (heading.startsWith('Please get help first')) {
      await pressButton(page, /continue my report/);
      continue;
    } else {
      const radios = page.getByRole('radio');
      const boxes = page.getByRole('checkbox');
      const number = page.getByRole('spinbutton');
      if ((await radios.count()) > 0) {
        await radios.first().focus();
        await page.keyboard.press('Space');
      } else if ((await boxes.count()) > 0) {
        await boxes.first().focus();
        await page.keyboard.press('Space');
      } else if ((await number.count()) > 0) {
        await number.first().fill('1');
      } else {
        const box = page.getByRole('textbox').first();
        if ((await box.count()) > 0) await box.fill('Ana Ruiz');
      }
    }
    await pressButton(page, 'Continue');
  }
  throw new Error(`${stopAt} not reached`);
}

test.describe('resident report', () => {
  test('keyboard only, English: deep link → questions → review → reference number → optional questions → my report (AC-11A, AC-11C, RES-01/02)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const email = `resident-${Date.now().toString(36)}@example.org`;
    const seen = new Set<string>();
    await page.goto('/county/westwind');
    await expect(page.getByRole('heading', { name: 'In danger right now?' })).toBeVisible();
    await expect(page.getByText(/Reporting damage from: /)).toBeVisible();
    await expectNoViolations(page);
    await pressButton(page, 'Start');
    await answerUntilReview(page, email, seen);

    // Review (INT-21): grouped, editable, then send.
    await expectNoViolations(page);
    await expect(page.getByRole('heading', { name: 'Your home' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What happened' })).toBeVisible();
    await expect(page.getByText('12 Oak St')).toBeVisible();
    await pressButton(page, 'Send my report');

    // Confirmation (INT-22, ACC-30, ACC-50): the code in text, what happens next, no promise of aid.
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
    const codeText = (await page.locator('.reference').textContent()) ?? '';
    const code = codeText.match(CODE)?.[0];
    expect(code).toBeTruthy();
    await expect(
      page.getByText('This report does not decide whether you get help', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('img', { name: /scan/ })).toBeVisible();

    // Optional questions after saving (INT-19): skip them all, then finish.
    await pressButton(page, 'Answer a few optional questions');
    await expect(page.getByRole('heading', { name: 'A few optional questions' })).toBeVisible();
    await expectNoViolations(page);
    for (let i = 0; i < 12; i++) {
      const skip = page.getByRole('button', { name: 'Skip' });
      if (!(await skip.isVisible().catch(() => false))) break;
      await skip.focus();
      await page.keyboard.press('Enter');
    }
    // Nothing answered: straight back to the confirmation, nothing sent (INT-19).
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 15_000,
    });

    // The worker filed it and emailed the confirmation with the same code (CHN-01, INT-22).
    const confirmation = await mailFor(email, 'damage report');
    expect(confirmation).toContain(code!);

    // My report (RES-01, SEC-09): reference + email → one-time code → status, consent, withdrawal.
    await page.goto('/county/my-report');
    await expectNoViolations(page);
    await page.getByLabel('Reference number').fill(code!);
    await page.getByLabel('Phone number or email on the report').fill(email);
    await pressButton(page, 'Send me a code');
    await expect(
      page.getByText('If the details match a report, a code is on its way.'),
    ).toBeVisible();
    const otpMail = await mailFor(email, 'one-time code');
    const otp = otpMail.match(/\b(\d{6})\b/)?.[1];
    expect(otp).toBeTruthy();
    await page.getByLabel('One-time code').fill(otp!);
    await pressButton(page, 'Open my report');
    await expect(page.getByText('Status:', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(code!)).toBeVisible();
    await expectNoViolations(page);
    const volunteers = page.getByRole('checkbox', { name: 'Volunteer cleanup groups' });
    await expect(volunteers).not.toBeChecked(); // NED-03: no is the default
    await volunteers.focus();
    await page.keyboard.press('Space');
    await expect(volunteers).toBeChecked({ timeout: 10_000 });
    // FL:FR-32: a copy for the resident or their insurer, as a PDF named by the reference.
    const download = page.waitForEvent('download');
    await pressButton(page, 'Download my copy (PDF)');
    const file = await download;
    expect(file.suggestedFilename()).toBe(`damage-report-${code!}.pdf`);
    await expect(page.getByText('Your copy was downloaded.')).toBeVisible();
    // CHN-09: a photo added afterwards from the web joins the same report.
    await page.getByLabel('Add a photo').setInputFiles({
      name: 'later.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(
      page.getByText('Photo added. The county will look at it with your report.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^\d+ photos? on your report\.$/)).toBeVisible();
    await expectNoViolations(page);
    page.once('dialog', (d) => void d.accept());
    await pressButton(page, 'Withdraw my report');
    await expect(page.getByText('Your report was withdrawn.')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.card').first()).toContainText('Withdrawn');
  });

  test('Spanish: the whole flow switches language, questions come from the graph in Spanish (EQ-06, AC-A05)', async ({
    page,
  }) => {
    await page.goto('/county/westwind');
    await page.getByLabel('Language').selectOption('es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(
      page.getByRole('heading', { name: '¿Está en peligro ahora mismo?' }),
    ).toBeVisible();
    await expectNoViolations(page);
    await pressButton(page, 'Comenzar');
    await expect(
      page.getByRole('heading', { name: '¿Hay alguien en peligro ahora mismo?' }),
    ).toBeVisible();
    await expect(page.getByRole('radio', { name: 'No, todos están a salvo' })).toBeVisible();
    await expectNoViolations(page);
  });

  test('AIG-09: the resident can tell the county that computer help went wrong, by a fixed reason, and their report is not changed', async ({
    page,
  }) => {
    // The running stack has no AI provider (ADR-0043), so the answers read from the words are
    // stood in for; the complaint itself goes to the real server.
    await page.route('**/api/public/intake/county/extract', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          extractionId: crypto.randomUUID(),
          candidates: [
            {
              questionId: 'employees_affected',
              value: { kind: 'value', value: 12 },
              confidence: 0.8,
              evidence: 'twelve of us work there',
            },
          ],
          language: 'en',
          injectionSuspected: false,
          notice: 'A computer helped fill in these answers. Please check them.',
        }),
      }),
    );
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await answerUntilReview(
      page,
      `aig09-${Date.now()}@example.org`,
      new Set(),
      'Or tell us in your own words',
    );
    await page
      .getByLabel('What happened?')
      .fill('The wind took the roof. Twelve of us work there.');
    await pressButton(page, 'Help me fill in the answers');
    await expect(page.getByText('You said: 12. Is that right?', { exact: false })).toBeVisible();
    await pressButton(page, 'This computer help got something wrong');
    await chooseRadio(page, 'It did not understand my language');
    await expectNoViolations(page);
    const sent = page.waitForResponse('**/ai-complaint');
    await pressButton(page, 'Tell the county');
    expect((await sent).status()).toBe(202);
    await expect(page.getByText(/The county will see that this help went wrong/)).toBeVisible();
    // The suggestion is still the resident's to accept or not.
    await expect(page.getByRole('radio', { name: 'Yes, that is right' })).toBeVisible();
    await expectNoViolations(page);
  });

  test('GATE-08, AIG-01, INT-16: each answer read from the words waits for the resident; only a yes is used, a no is left for them to answer', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // The running stack has no AI provider (ADR-0043): the reply from the words is stood in
    // for; the report itself goes to the real server.
    const extractionId = crypto.randomUUID();
    await page.route('**/api/public/intake/county/extract', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          extractionId,
          candidates: [
            {
              questionId: 'employees_affected',
              value: { kind: 'value', value: 12 },
              confidence: 0.8,
              evidence: 'twelve of us work there',
            },
            {
              questionId: 'time_out_of_work',
              value: { kind: 'value', value: 'months' },
              confidence: 0.6,
              evidence: 'out for a while',
            },
          ],
          language: 'en',
          injectionSuspected: false,
          notice: 'A computer helped fill in these answers. Please check them.',
        }),
      }),
    );
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    const email = `gate08-${Date.now()}@example.org`;
    const seen = new Set<string>();
    await answerUntilReview(page, email, seen, 'Or tell us in your own words');
    await page
      .getByLabel('What happened?')
      .fill('The wind took the roof. Twelve of us work there and we are out for a while.');
    await pressButton(page, 'Help me fill in the answers');
    await expect(page.getByText('A computer helped fill in these answers.')).toBeVisible();
    const twelve = page.getByRole('group', { name: /You said: 12\. Is that right\?/ });
    const months = page.getByRole('group', {
      name: /You said: Months or longer\. Is that right\?/,
    });
    await expect(twelve).toBeVisible();
    await expect(months).toBeVisible();
    // Nothing is chosen for the resident: each suggestion starts unanswered, its words shown.
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(twelve.getByText('“twelve of us work there”')).toBeVisible();
    await expectNoViolations(page);
    const yes = twelve.getByRole('radio', { name: 'Yes, that is right' });
    await yes.focus();
    await page.keyboard.press('Space');
    const no = months.getByRole('radio', { name: 'No, I will answer myself' });
    await no.focus();
    await page.keyboard.press('Space');
    await pressButton(page, 'Continue');
    await answerUntilReview(page, email, seen);
    const sent = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/intake\/county\/[^/]+\/submissions$/.test(r.url()),
    );
    await pressButton(page, 'Send my report');
    const body = (await sent).postDataJSON() as {
      answers: Record<string, unknown>;
      aiAssisted: boolean;
      extractionId?: string;
      ownWords?: string;
    };
    // The yes is the resident's answer, marked as helped; the no was never filled in for them.
    expect(body.answers['employees_affected']).toEqual({ kind: 'value', value: 12 });
    expect(body.answers['time_out_of_work']).toBeUndefined();
    expect(body.aiAssisted).toBe(true);
    expect(body.extractionId).toBe(extractionId);
    expect(body.ownWords).toContain('Twelve of us work there');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('ORG-01: a business reports two places in one visit, each its own report; who they are is asked once', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const email = `org-${Date.now().toString(36)}@example.org`;
    const org = 'Exercise Oak Street Apartments';
    await page.goto('/county/westwind');
    await pressButton(page, 'I am reporting for a business, landlord or group');
    const first = new Set<string>();
    await answerUntilReview(page, email, first, 'Check your answers', '1 Oak St');
    expect([...first].some((h) => h.startsWith('What is the name of your business'))).toBe(true);
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    const firstCode = ((await page.locator('.reference').textContent()) ?? '').match(CODE)?.[0];
    expect(firstCode).toBeTruthy();
    await expect(page.getByRole('heading', { name: `Other places for ${org}` })).toBeVisible();
    await expectNoViolations(page);

    // The second place: a new report; the organization and its contact are not asked again.
    await pressButton(page, `Report another place for ${org}`);
    const second = new Set<string>();
    await answerUntilReview(page, email, second, 'Check your answers', '3 Oak St');
    expect([...second][0]).toMatch(/^Is anyone in danger/);
    expect([...second].some((h) => h.startsWith('What is the name of your business'))).toBe(false);
    expect([...second].some((h) => h.startsWith('How can we reach you'))).toBe(false);
    await expect(page.getByText('3 Oak St')).toBeVisible();
    await expect(page.getByText(org)).toBeVisible();
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    const secondCode = ((await page.locator('.reference').textContent()) ?? '').match(CODE)?.[0];
    expect(secondCode).toBeTruthy();
    expect(secondCode).not.toBe(firstCode);
    await expect(page.getByText('Places reported in this visit (2):')).toBeVisible();
    await expect(page.locator('.codes')).toHaveText(`${firstCode}, ${secondCode}`);
    await expectNoViolations(page);
  });

  test('danger: yes shows the emergency instructions before anything else (INT-07, CON-10)', async ({
    page,
  }) => {
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await chooseRadio(page, 'Yes, someone is in danger');
    await pressButton(page, 'Continue');
    await expect(page.getByRole('heading', { name: 'Please get help first' })).toBeVisible();
    await expect(page.getByRole('link', { name: /911/ })).toBeVisible();
    await expectNoViolations(page);
  });

  test('ACC-07: a question screen reflows at 320 px without horizontal scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  test('AC-A01, AC-A02, AC-A05: at 320 px an error is announced and fixed by keyboard; review, confirmation and optional questions reflow; a number error names its range, in Spanish too', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 320, height: 740 });
    const reflows = async (where: string) =>
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
        `${where} scrolls sideways at 320 px`,
      ).toBe(false);
    const email = `reflow-${Date.now().toString(36)}@example.org`;
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    // Continue with nothing chosen: the error is announced with the question; choosing fixes it.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Is anyone in danger/);
    await pressButton(page, 'Continue');
    await expect(page.getByRole('alert')).toContainText('Please choose an answer.');
    await chooseRadio(page, 'No, everyone is safe');
    await pressButton(page, 'Continue');
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Is anyone in danger/);
    await answerUntilReview(page, email, new Set());
    await reflows('the review');
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    await reflows('the confirmation');
    await pressButton(page, 'Answer a few optional questions');
    await expect(page.getByRole('heading', { name: 'A few optional questions' })).toBeVisible();
    await reflows('the optional questions');
    const people = page.getByRole('spinbutton', { name: 'How many people live in your home?' });
    for (let i = 0; i < 12 && !(await people.isVisible().catch(() => false)); i++)
      await pressButton(page, 'Skip');
    await expect(people).toBeVisible();
    // Out of range: the error names the range and is tied to the field.
    await people.fill('99');
    await pressButton(page, 'Continue');
    await expect(page.getByRole('alert')).toContainText('Enter a number from 1 to 50.');
    await expect(people).toHaveAttribute('aria-invalid', 'true');
    // The same mistake in Spanish reads in Spanish (AC-A05), never the engine's English.
    await page.getByLabel('Language').selectOption('es');
    const personas = page.getByRole('spinbutton', {
      name: '¿Cuántas personas viven en su hogar?',
    });
    await expect(personas).toBeVisible();
    await personas.fill('99');
    await pressButton(page, 'Continuar');
    await expect(page.getByRole('alert')).toContainText('Escriba un número del 1 al 50.');
    await expect(page.getByText('out of range')).toHaveCount(0);
    // Corrected, it goes on.
    await personas.fill('3');
    await pressButton(page, 'Continuar');
    await expect(personas).toHaveCount(0);
  });

  test('photos: when the objects host cannot be reached, the photo goes through the gateway (SCL-04, SCL-06, PHO-05)', async ({
    page,
  }) => {
    // A browser that does not trust the objects host's certificate, or a network that blocks it.
    await page.route('https://objects.localhost/**', (route) => route.abort());
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await answerUntilReview(
      page,
      `photo-${Date.now().toString(36)}@example.org`,
      new Set(),
      'Photos of the damage',
    );
    await page.getByLabel('Choose from my photos').setInputFiles({
      name: 'roof.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_1X1, 'base64'),
    });
    const keep = page.getByRole('button', { name: 'Keep this photo' });
    if (
      await keep.waitFor({ state: 'visible', timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    ) {
      await keep.click();
    }
    await expect(page.getByRole('status').filter({ hasText: '1 photo added' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('You are offline')).toHaveCount(0);
  });

  test('pause and resume with a code (INT-20)', async ({ page }) => {
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await chooseRadio(page, 'No, everyone is safe');
    await pressButton(page, 'Continue');
    await pressButton(page, 'Pause and finish later');
    await expect(page.getByRole('heading', { name: 'Your report is paused' })).toBeVisible();
    const resumeCode = (await page.locator('.reference').textContent())?.trim() ?? '';
    expect(resumeCode).toMatch(/^[A-Z0-9]{6}$/);
    await page.goto('/county/westwind/resume');
    await page.getByLabel('Your resume code').fill(resumeCode);
    await pressButton(page, 'Continue');
    // Back on the question after the safety one, with the earlier answer kept. Start chose
    // "own home", so the next question is the address; wait for it before pressing Back
    // (the resume screen has a Back of its own).
    await expect(page.getByRole('heading', { name: 'Where is the home?' })).toBeVisible({
      timeout: 15_000,
    });
    await pressButton(page, 'Back');
    await expect(page.getByRole('radio', { name: 'No, everyone is safe' })).toBeChecked();
  });
});
