/* global document */
/**
 * The console without the stack: a mock API (synthetic data only, SCL-12) around
 * the built console, screenshots of a few screens in both themes on a desktop
 * and a phone, and axe at WCAG 2.2 AA on each (ADR-0045, GATE-03).
 *
 *   pnpm --filter @cg/web-console build && node tools/preview/console-preview.mjs [/console/ ...]
 *   ROLE=nurse node tools/preview/console-preview.mjs /console/
 *   ROLE=partner node tools/preview/console-preview.mjs /console/ "@Needs board" "@Partner workspace"
 *
 * An argument starting with "@" is a move through the side navigation by link
 * name, as the journeys make it, so the scan sees the page as a person reaches it.
 *
 * Screenshots land in test-results/console-preview/. PW_CHROMIUM_PATH points at a Chromium.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startConsoleMock } from './console-mock.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'test-results/console-preview');
mkdirSync(OUT, { recursive: true });
const role = process.env.ROLE ?? 'director';
const {
  port: PORT,
  session,
  close,
} = await startConsoleMock({
  role,
  port: Number(process.env.PORT ?? 4319),
});
const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const shots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/console/', '/console/briefing', '/console/reports', '/console/accounts'];
let violations = 0;
for (const [name, dev] of [
  ['desktop', devices['Desktop Chrome']],
  ['phone', devices['Pixel 7']],
]) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ ...dev, colorScheme: theme });
    await ctx.addInitScript(
      (s) => sessionStorage.setItem('cg.session', JSON.stringify(s)),
      session,
    );
    const page = await ctx.newPage();
    for (const path of shots) {
      if (path.startsWith('@')) {
        // A move through the side navigation, the way the journeys make it
        // (goTo in tests/e2e/support/console.ts): the drawer first on a phone.
        const toggle = page.getByRole('button', { name: 'Workspaces' });
        if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true') {
          await toggle.click();
        }
        await page
          .getByRole('navigation', { name: 'Workspaces' })
          .getByRole('link', { name: path.slice(1), exact: true })
          .click();
      } else {
        await page.goto(`http://localhost:${PORT}${path}`);
      }
      const slug = path.replace(/[^a-z0-9]+/gi, '_') || 'root';
      await page.waitForSelector('main h1', { timeout: 15000 }).catch(async (e) => {
        await page.screenshot({
          path: join(OUT, `console-${role}${slug}-${theme}-${name}-stuck.png`),
        });
        throw new Error(
          `${name} ${theme} ${path}: no heading appeared (${e.message.split('\n')[0]})`,
        );
      });
      await page.waitForTimeout(600);
      await page.screenshot({
        path: join(OUT, `console-${role}${slug}-${theme}-${name}.png`),
        fullPage: true,
      });
      const res = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      for (const v of res.violations) {
        violations++;
        console.log(`${name} ${theme} ${path} VIOLATION ${v.id}: ${v.help}`);
        for (const n of v.nodes.slice(0, 2)) console.log('   ', n.html.slice(0, 140));
      }
      const sw = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      if (sw[0] > sw[1] + 1) {
        violations++;
        console.log(`${name} ${theme} ${path} OVERFLOW ${sw[0]} > ${sw[1]}`);
      }
    }
    await ctx.close();
  }
}
await browser.close();
await close();
console.log(violations ? `${violations} problems` : 'console preview clean');
