/**
 * The slow-network and older-device profile (NFR-06) on the resident report
 * (INT-04: median completion of a basic damage report at most 5 minutes on a
 * mid-range phone over 3G). The phone project's device, with the network
 * slowed to 3G (300 ms round trip, 1.6 Mbps down, 750 kbps up) and the
 * processor slowed four times, walks an own-home report with its optional
 * screens. It times only the platform's share: the first load, every step and
 * the send. A person's reading and typing come on top, so the platform's
 * share is held to 90 s, and no step may take more than 5 s. The number of
 * required questions on the shortest path is tested on the graph itself
 * (packages/intake/test/graph.test.ts).
 */
import { expect, test, type Page } from '@playwright/test';

/** NFR-06 profile: the numbers are the test's contract; change them only with the plan. */
const PROFILE = {
  latencyMs: 300,
  downloadBytesPerSecond: (1.6 * 1024 * 1024) / 8,
  uploadBytesPerSecond: (750 * 1024) / 8,
  cpuSlowdown: 4,
};
const BUDGET = { firstLoadMs: 15_000, stepMs: 5_000, totalMs: 90_000 };

async function heading(page: Page): Promise<string> {
  return ((await page.getByRole('heading', { level: 1 }).first().textContent()) ?? '').trim();
}

/** The quickest honest answer on each screen of the own-home path. */
async function answer(page: Page, h: string, email: string): Promise<void> {
  const radio = (name: string | RegExp) => page.getByRole('radio', { name }).check();
  if (h.startsWith('Is anyone in danger')) await radio('No, everyone is safe');
  else if (h.startsWith('Where is the home')) {
    await page.getByLabel('Street address or description').fill('12 Oak St');
    await page.getByLabel('City or town').fill('Westwind');
    await page.getByLabel('ZIP code').fill('63001');
  } else if (h.startsWith('How can we reach you')) {
    await page.getByLabel('Email (optional)').fill(email);
    await radio('Email');
  } else if (h.startsWith('Or tell us in your own words')) {
    await page.getByLabel('What happened?').fill('A tree fell on the roof.');
  } else if (h.startsWith('Photos of the damage')) {
    await page.getByRole('button', { name: /Skip photos/ }).click();
    return;
  } else if (h.startsWith('Do you need help')) {
    await page.getByRole('checkbox').first().check();
  } else if (h.startsWith('Who may see')) {
    // The defaults stay "No" (NED-03).
  } else {
    const radios = page.getByRole('radio');
    const boxes = page.getByRole('checkbox');
    const number = page.getByRole('spinbutton');
    if ((await radios.count()) > 0) await radios.first().check();
    else if ((await boxes.count()) > 0) await boxes.first().check();
    else if ((await number.count()) > 0) await number.first().fill('1');
    else if ((await page.getByRole('textbox').count()) > 0)
      await page.getByRole('textbox').first().fill('Ana Ruiz');
  }
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('NFR-06, INT-04: a basic damage report on a mid-range phone over 3G stays within the platform share of five minutes', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'the profile is a phone');
  test.setTimeout(300_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: PROFILE.latencyMs,
    downloadThroughput: PROFILE.downloadBytesPerSecond,
    uploadThroughput: PROFILE.uploadBytesPerSecond,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });
  const email = `slow-${Date.now().toString(36)}@example.org`;
  const timings: { step: string; ms: number }[] = [];
  const timed = async (step: string, act: () => Promise<unknown>) => {
    const started = Date.now();
    await act();
    timings.push({ step, ms: Date.now() - started });
  };

  // First load: the link from a text message, to the first screen ready to use.
  await timed('first load', async () => {
    await page.goto('/county/westwind');
    await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled({ timeout: 60_000 });
  });
  await timed('start', async () => {
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('In danger right now?');
  });

  let screens = 0;
  for (let i = 0; i < 40; i++) {
    const h = await heading(page);
    if (h.startsWith('Check your answers')) break;
    screens++;
    await timed(h, async () => {
      await answer(page, h, email);
      await expect(page.getByRole('heading', { level: 1 }).first()).not.toHaveText(h, {
        timeout: 30_000,
      });
    });
  }
  await timed('send', async () => {
    await page.getByRole('button', { name: 'Send my report' }).click();
    await expect(page.getByRole('heading', { name: 'We received your report' })).toBeVisible({
      timeout: 60_000,
    });
  });

  const total = timings.reduce((n, t) => n + t.ms, 0);
  await testInfo.attach('nfr-06-timings.json', {
    body: JSON.stringify({ profile: PROFILE, budget: BUDGET, screens, total, timings }, null, 2),
    contentType: 'application/json',
  });
  testInfo.annotations.push({
    type: 'NFR-06',
    description:
      `NFR-06 3G + 4x CPU: ${screens} screens, platform share ${Math.round(total / 1000)} s ` +
      `(first load ${Math.round(timings[0]!.ms / 100) / 10} s, slowest step ` +
      `${Math.round(Math.max(...timings.slice(1).map((t) => t.ms)) / 100) / 10} s)`,
  });
  expect(timings[0]!.ms, 'first load').toBeLessThanOrEqual(BUDGET.firstLoadMs);
  for (const t of timings.slice(1)) expect(t.ms, t.step).toBeLessThanOrEqual(BUDGET.stepMs);
  expect(total, 'the platform share of the report').toBeLessThanOrEqual(BUDGET.totalMs);
});
