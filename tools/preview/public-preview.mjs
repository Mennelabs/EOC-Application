/* global document */
/**
 * The resident app and the public Find help page without the stack: a mock
 * public API (synthetic data only, SCL-12) around the built apps, screenshots
 * on a phone and a desktop in both themes, and axe at WCAG 2.2 AA on each
 * (ADR-0045, GATE-03).
 *
 *   pnpm --filter @cg/web-resident build && pnpm --filter @cg/web-help build && node tools/preview/public-preview.mjs
 *
 * Screenshots land in test-results/public-preview/. PW_CHROMIUM_PATH points at a Chromium.
 */
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESIDENT = join(ROOT, 'apps/web-resident/dist');
const HELP = join(ROOT, 'apps/web-help/dist');
const OUT = join(ROOT, 'test-results/public-preview');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT ?? 4320);
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const site = (id, name, kind, status, services, km) => ({
  id,
  slug: id,
  kind,
  name,
  status,
  address: {
    line1: `${100 + km * 10} Cedar Ridge Rd`,
    unit: null,
    city: 'Westwind',
    state: 'MO',
    postal: '63001',
  },
  position: { lat: 38.6, lon: -90.4 },
  distanceKm: km,
  hours: {
    always: status === 'open' && kind === 'shelter' ? true : undefined,
    today: '8 AM – 8 PM',
  },
  services,
  pets: kind === 'shelter' ? 'yes' : 'no',
  accessibility: { wheelchair: true },
  medicalPower: kind === 'shelter',
  languages: ['en', 'es'],
  transit: 'Route 12 stops at the door',
  directions: null,
  lastConfirmedAt: ago(90),
  nextNearest:
    status === 'full'
      ? { id: 'cr', slug: 'cr', name: 'Cedar Ridge Community Center', distanceKm: 3.2 }
      : null,
});
const help = {
  tenant: { name: 'Westwind County', slug: 'county', locales: ['en', 'es'] },
  lang: 'en',
  generatedAt: ago(2),
  near: { query: '63001', resolved: true, label: 'ZIP 63001', how: 'zip' },
  sites: [
    site(
      'cr',
      'Cedar Ridge Community Center',
      'shelter',
      'open',
      ['shelter', 'meals', 'showers'],
      1.4,
    ),
    site('ok', 'Oak Hollow Church', 'feeding', 'limited', ['meals', 'water'], 2.8),
    site('fg', 'Fairgrounds distribution point', 'pod', 'full', ['water', 'tarps', 'ice'], 4.1),
  ],
  resources: [
    {
      slug: 'fema',
      type: 'program',
      category: 'aid',
      title: 'Apply for FEMA assistance',
      summary: 'Register by phone or online; the deadline is 60 days after the declaration.',
      url: '/help/resources/fema',
      referenceUrl: null,
      expiresAt: null,
    },
  ],
  accessibility: {
    statement: 'This page meets WCAG 2.2 AA. Tell us about any barrier.',
    supportPhone: '(314) 555-0142',
  },
  notices: ['Boil water advisory for Oak Hollow until further notice.'],
};
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const serveFrom = (dir, rel, res) => {
  let file = join(dir, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
};
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        productName: 'Showcase County Tools',
        countyName: 'Westwind County',
        helpPhone: '(314) 555-0142',
      }),
    );
  }
  if (p.startsWith('/api/public/help/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(help));
  }
  if (p.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ code: 'not_found', message: 'mock', fields: [], retryable: false }),
    );
  }
  if (p.startsWith('/help/')) return serveFrom(HELP, p.slice('/help/'.length), res);
  if (/^\/[a-z0-9-]+\/help\/?$/.test(p)) return serveFrom(HELP, 'index.html', res);
  return serveFrom(RESIDENT, p.slice(1), res);
});
await new Promise((r) => server.listen(PORT, r));

const executablePath = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const pages = [
  ['resident-welcome', '/county/westwind'],
  ['resident-report', '/county/westwind/report'],
  ['help', '/county/help?near=63001'],
  ['help-es', '/county/help?lang=es'],
];
let problems = 0;
for (const [name, dev] of [
  ['phone', devices['Pixel 7']],
  ['desktop', devices['Desktop Chrome']],
]) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ ...dev, colorScheme: theme });
    const page = await ctx.newPage();
    for (const [slug, path] of pages) {
      await page.goto(`http://localhost:${PORT}${path}`);
      await page.waitForSelector('h1', { timeout: 15000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(OUT, `${slug}-${theme}-${name}.png`), fullPage: true });
      const res = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      for (const v of res.violations) {
        problems++;
        console.log(`${name} ${theme} ${slug} VIOLATION ${v.id}: ${v.help}`);
        for (const n of v.nodes.slice(0, 2))
          console.log(
            '   ',
            n.html.slice(0, 140),
            '|',
            n.failureSummary.split('\n')[1]?.slice(0, 120),
          );
      }
      const [sw, cw] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      if (sw > cw + 1) {
        problems++;
        console.log(`${name} ${theme} ${slug} OVERFLOW ${sw} > ${cw}`);
      }
    }
    await ctx.close();
  }
}
await browser.close();
server.close();
console.log(problems ? `${problems} problems` : 'public preview clean');
