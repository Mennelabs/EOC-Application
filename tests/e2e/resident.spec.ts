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
  // A colour mid-transition is what a person sees for a frame, not a state: running
  // transitions and animations finish before the scan (motion is 120 ms, ADR-0045;
  // looping ones are skipped, and nothing waits more than a second).
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((r) => setTimeout(r, 1000)),
    ]),
  );
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

/** How many messages to an address carry this text in their subject. */
async function mailCount(address: string, subjectPart: string): Promise<number> {
  const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  const body = (await res.json()) as { messages: { Subject: string }[] };
  return body.messages.filter((m) => m.Subject.includes(subjectPart)).length;
}

/** Answers whatever screen is showing with the keyboard, until the review screen. */
async function answerUntilReview(
  page: Page,
  email: string,
  seen: Set<string>,
  stopAt = 'Check your answers',
  street = '12 Oak St',
  /** Answers a screen itself and returns true, or leaves it to the defaults. */
  custom?: (heading: string) => Promise<boolean>,
) {
  for (let i = 0; i < 40; i++) {
    const heading =
      (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim() ?? '';
    if (heading.startsWith(stopAt)) return;
    if (!seen.has(heading)) {
      seen.add(heading);
      await expectNoViolations(page);
    }
    if (custom && (await custom(heading))) {
      await pressButton(page, 'Continue');
      continue;
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

/** The intake description for the exercise county, as the page receives it. */
const isIntakeInfo = (url: URL) => url.pathname === '/api/public/intake/county/westwind';

/** Everything the app keeps on this device, opened with the device's own key where it can be. */
async function heldOnDevice(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const raw = sessionStorage.getItem('cg.key') ?? localStorage.getItem('cg.key');
    const key = raw
      ? await crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['decrypt'])
      : null;
    const out: string[] = [];
    for (const store of [localStorage, sessionStorage])
      for (const name of Object.keys(store)) {
        if (!name.startsWith('cg.') || name === 'cg.key') continue;
        const value = store.getItem(name) ?? '';
        const [iv, ct] = value.split('.');
        if (key && iv && ct) {
          try {
            const plain = await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: bytes(iv) },
              key,
              bytes(ct),
            );
            out.push(new TextDecoder().decode(plain));
            continue;
          } catch {
            // not this key's: kept as stored
          }
        }
        out.push(value);
      }
    return out.join('\n');
  });
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
    // AC-A04: the way without a voice is in the county's wording here, so it is not said twice.
    await expect(page.getByText(/If you cannot call, text 911 where that works/)).toBeVisible();
    await expect(page.getByText('Cannot call? Text 911 where that works.')).toHaveCount(0);
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
    // Whatever font the device has: the page's own, then a wide one (CI's fonts are wider than
    // this stack's, and a review row overflowed there only).
    const reflows = async (where: string) => {
      for (const font of ['', '"DejaVu Sans", Verdana, sans-serif'])
        expect(
          await page.evaluate((f) => {
            const root = document.documentElement;
            root.style.setProperty('font-family', f);
            const over = root.scrollWidth > root.clientWidth;
            root.style.removeProperty('font-family');
            return over;
          }, font),
          `${where} scrolls sideways at 320 px${font ? ' in a wide font' : ''}`,
        ).toBe(false);
    };
    // A long address with no place to break: it must wrap, not push the page wider (WCAG 1.4.10).
    const email = `reflow-check-with-a-long-address-${Date.now().toString(36)}@example.org`;
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

  test('BRD:FR-01.06: a resident who lost the reference number gets it again at the email on the report, never on the screen', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const email = `lost-${Date.now().toString(36)}@example.org`;
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await answerUntilReview(page, email, new Set());
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    const code = ((await page.locator('.reference').textContent()) ?? '').match(CODE)?.[0];
    expect(code).toBeTruthy();
    await mailFor(email, 'damage report');
    // Later the number is lost: the resident asks for it by the email on the report.
    await page.goto('/county/my-report');
    await pressButton(page, 'Lost your reference number?');
    await expect(
      page.getByRole('heading', { name: 'Get my reference number again' }),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.getByLabel('Phone number or email on the report').fill(email);
    await pressButton(page, 'Send my reference number');
    await expect(page.getByText(/its reference number is on its way there/)).toBeVisible();
    await expect(page.getByText(code!)).toHaveCount(0);
    await expectNoViolations(page);
    // The number comes again to the address on the report, and only there.
    await expect
      .poll(() => mailCount(email, code!), { timeout: 90_000, intervals: [2000] })
      .toBeGreaterThanOrEqual(2);
    await pressButton(page, 'Back to checking my report');
    await expect(page.getByRole('heading', { name: 'Check or change my report' })).toBeVisible();
  });

  test('AC-A07, WCAG 2.2.1: an open report closes after 10 minutes without use, warned a minute before; "I need more time" keeps it open', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.clock.install();
    const email = `idle-${Date.now().toString(36)}@example.org`;
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await answerUntilReview(page, email, new Set());
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    const code = ((await page.locator('.reference').textContent()) ?? '').match(CODE)?.[0];
    expect(code).toBeTruthy();
    await mailFor(email, 'damage report');
    await page.goto('/county/my-report');
    await page.getByLabel('Reference number').fill(code!);
    await page.getByLabel('Phone number or email on the report').fill(email);
    await pressButton(page, 'Send me a code');
    const otp = (await mailFor(email, 'one-time code')).match(/\b(\d{6})\b/)?.[1];
    expect(otp).toBeTruthy();
    await page.getByLabel('One-time code').fill(otp!);
    await pressButton(page, 'Open my report');
    await expect(page.getByText(code!)).toBeVisible({ timeout: 15_000 });
    // Nine minutes without a touch or key: the warning, with a way to stay.
    const warning = page.getByRole('alert').filter({ hasText: 'closes in one minute' });
    await page.clock.fastForward('09:05');
    await expect(warning).toBeVisible();
    await expectNoViolations(page);
    await pressButton(page, 'I need more time');
    await expect(warning).toHaveCount(0);
    await expect(page.getByText(code!)).toBeVisible();
    // Left again: warned, then closed, and the lookup screen says why.
    await page.clock.fastForward('09:05');
    await expect(warning).toBeVisible();
    await page.clock.fastForward('01:00');
    await expect(
      page.getByText(/Your report was closed after 10 minutes without use/),
    ).toBeVisible();
    await expect(page.getByText(code!)).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('cg.resident'))).toBeNull();
    await expectNoViolations(page);
  });
  test("AC-A04: nothing needs a voice: the help line takes texts and relay calls, and the danger screen says to text 911 even in a county's own wording, in Spanish too", async ({
    page,
  }) => {
    // A county's own emergency wording that leaves texting out.
    await page.route(isIntakeInfo, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { graph: Record<string, unknown> };
      body.graph['emergencyInstructions'] = {
        en: 'Call 911 now. Stay away from downed lines.',
        es: 'Llame al 911 ahora. Aléjese de los cables caídos.',
      };
      await route.fulfill({ response: res, json: body });
    });
    await page.goto('/county/westwind');
    await expect(
      page.getByText(
        /Deaf, hard of hearing or unable to speak\? Text .+, or call it through relay by dialing 711\./,
      ),
    ).toBeVisible();
    await pressButton(page, 'Start');
    await chooseRadio(page, 'Yes, someone is in danger');
    await pressButton(page, 'Continue');
    await expect(page.getByRole('heading', { name: 'Please get help first' })).toBeVisible();
    await expect(page.getByText('Call 911 now. Stay away from downed lines.')).toBeVisible();
    await expect(page.getByText('Cannot call? Text 911 where that works.')).toBeVisible();
    await expectNoViolations(page);
    await page.getByLabel('Language').selectOption('es');
    await expect(page.getByRole('heading', { name: 'Primero busque ayuda' })).toBeVisible();
    await expect(
      page.getByText('¿No puede llamar? Envíe un mensaje al 911 donde funcione.'),
    ).toBeVisible();
    await expect(page.getByText(/servicio de retransmisión marcando 711/)).toBeVisible();
    // Help near you says the same.
    await page.goto('/county/help');
    await expect(page.getByText('If you cannot call, text 911 where that works.')).toBeVisible();
    await expect(page.getByText(/through relay by dialing 711/).first()).toBeVisible();
  });

  test('AC-A06: with camera, microphone and location refused, the report is made by typing and a photo chosen from the device', async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await context.clearPermissions();
    await page.addInitScript(() => {
      const refused = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = refused;
      const denied = {
        code: 1,
        message: 'User denied Geolocation',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError;
      navigator.geolocation.getCurrentPosition = (_ok, fail) => fail?.(denied);
      navigator.geolocation.watchPosition = (_ok, fail) => {
        fail?.(denied);
        return 0;
      };
    });
    // The county offers speaking instead of typing here, so the microphone is asked for.
    await page.route(isIntakeInfo, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), dictation: true } });
    });
    const email = `denied-${Date.now().toString(36)}@example.org`;
    const seen = new Set<string>();
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await answerUntilReview(page, email, seen, 'Or tell us in your own words');
    await pressButton(page, 'Speak instead');
    await expect(
      page.getByText('The microphone is not available. Please type your words.'),
    ).toBeVisible();
    await page.getByLabel('What happened?').fill('Water came in through the kitchen ceiling.');
    await pressButton(page, 'Continue');
    await answerUntilReview(page, email, seen, 'Photos of the damage');
    await page.getByLabel('Choose from my photos').setInputFiles({
      name: 'ceiling.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_1X1, 'base64'),
    });
    const keep = page.getByRole('button', { name: 'Keep this photo' });
    if (
      await keep.waitFor({ state: 'visible', timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    )
      await keep.click();
    await expect(page.getByRole('status').filter({ hasText: '1 photo added' })).toBeVisible({
      timeout: 30_000,
    });
    await pressButton(page, 'Continue');
    await answerUntilReview(page, email, seen);
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('.reference')).toHaveText(CODE);
  });

  test('AC-A07: on a shared device the next person finds nothing of the last report: cleared by the resident, and on the kiosk after Done', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const mark = `Wren${Date.now().toString(36)}`;
    // A personal phone or library computer: the resident clears their answers when done.
    await page.goto('/county/westwind');
    await pressButton(page, 'Start');
    await answerUntilReview(
      page,
      `shared-${mark}@example.org`.toLowerCase(),
      new Set(),
      'Check your answers',
      `14 ${mark} Lane`,
    );
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    const first = ((await page.locator('.reference').textContent()) ?? '').match(CODE)?.[0];
    expect(first).toBeTruthy();
    await pressButton(page, /Clear my answers from this device/);
    await expect(page.getByText('Your answers have been cleared from this device.')).toBeVisible();
    expect(
      await page.evaluate(() =>
        [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) =>
          k.startsWith('cg.'),
        ),
      ),
    ).toEqual([]);
    // The next person goes back, then starts: nothing of the last report.
    await page.goBack();
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    await pressButton(page, 'Start');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Is anyone in danger/);
    for (const radio of await page.getByRole('radio').all()) await expect(radio).not.toBeChecked();
    await expect(page.getByText(mark)).toHaveCount(0);
    await expect(page.getByText(first!)).toHaveCount(0);
    expect(await heldOnDevice(page)).not.toContain(mark);

    // A kiosk at a recovery centre: Done hands over a clean kiosk, still a kiosk.
    await page.goto('/county/westwind/kiosk');
    await expect(page.getByRole('status').filter({ hasText: 'Assisted report' })).toBeVisible();
    await answerUntilReview(
      page,
      `kiosk-${mark}@example.org`.toLowerCase(),
      new Set(),
      'Check your answers',
      `16 ${mark} Lane`,
    );
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    const second = ((await page.locator('.reference').textContent()) ?? '').match(CODE)?.[0];
    expect(second).toBeTruthy();
    await pressButton(page, /Done: clear the screen for the next person/);
    await expect(page).toHaveURL(/\/county\/westwind\/kiosk$/);
    await expect(page.getByRole('status').filter({ hasText: 'Assisted report' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const radio of await page.getByRole('radio').all()) await expect(radio).not.toBeChecked();
    await expect(page.getByText(mark)).toHaveCount(0);
    await expect(page.getByText(second!)).toHaveCount(0);
    expect(await heldOnDevice(page)).not.toContain(mark);
    await page.goBack();
    await expect(page.getByText(second!)).toHaveCount(0);
    await expect(page.getByText(mark)).toHaveCount(0);
  });

  test("AC-A09: someone helping another person reports for them; helper and person stay apart, and only the helper's contact opens the report later", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const run = Date.now().toString(36);
    const email = `helper-${run}@example.org`;
    await page.goto('/county/westwind');
    await pressButton(page, 'I am helping someone else report');
    const asked: string[] = [];
    await answerUntilReview(
      page,
      email,
      new Set(),
      'Check your answers',
      '12 Oak St',
      async (h) => {
        if (h.startsWith('What is your name')) {
          asked.push('helper');
          await page.getByRole('textbox').first().fill('Exercise Helper Kim');
        } else if (h.startsWith('Does this person know')) {
          asked.push('consent');
          await chooseRadio(page, 'I cannot ask them right now');
        } else if (h.startsWith('Who are you helping')) {
          asked.push('subject');
          await page.getByRole('textbox').first().fill('Exercise Neighbor Lee');
        } else if (h.startsWith('How can we reach you')) {
          // Asked of the helper, as the helper; the person helped is never asked for a contact.
          asked.push('contact');
          expect(h).toBe('How can we reach you, the helper?');
          await page.getByLabel('Email (optional)').fill(email);
          await chooseRadio(page, 'Email');
        } else return false;
        return true;
      },
    );
    expect(asked).toEqual(['helper', 'consent', 'subject', 'contact']);
    // The review names both, each as who they are.
    await expect(page.getByText('Exercise Helper Kim')).toBeVisible();
    await expect(page.getByText('Exercise Neighbor Lee')).toBeVisible();
    await expect(page.getByText('I cannot ask them right now')).toBeVisible();
    await expectNoViolations(page);
    await pressButton(page, 'Send my report');
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 30_000,
    });
    const code = ((await page.locator('.reference').textContent()) ?? '').match(CODE)?.[0];
    expect(code).toBeTruthy();

    // Follow-up goes to the helper's contact: only it opens the report.
    await page.goto('/county/my-report');
    const other = `someone-else-${run}@example.org`;
    await page.getByLabel('Reference number').fill(code!);
    await page.getByLabel('Phone number or email on the report').fill(other);
    await pressButton(page, 'Send me a code');
    await expect(
      page.getByText('If the details match a report, a code is on its way.'),
    ).toBeVisible();
    await page.goto('/county/my-report');
    await page.getByLabel('Reference number').fill(code!);
    await page.getByLabel('Phone number or email on the report').fill(email);
    await pressButton(page, 'Send me a code');
    const otp = (await mailFor(email, 'one-time code')).match(/\b(\d{6})\b/)?.[1];
    expect(otp).toBeTruthy();
    await page.getByLabel('One-time code').fill(otp!);
    await pressButton(page, 'Open my report');
    await expect(page.getByText(code!)).toBeVisible({ timeout: 15_000 });
    // By now the helper's code has come; nothing went to the address not on the report.
    await expect(mailFor(other, 'one-time code', 1)).rejects.toThrow(/no mail/);
  });
});
