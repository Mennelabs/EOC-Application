/* global document */
/**
 * The console without the stack: a mock API (synthetic data only, SCL-12) around
 * the built console, screenshots of a few screens in both themes on a desktop
 * and a phone, and axe at WCAG 2.2 AA on each (ADR-0045, GATE-03).
 *
 *   pnpm --filter @cg/web-console build && node tools/preview/console-preview.mjs [/console/ ...]
 *   ROLE=nurse node tools/preview/console-preview.mjs /console/
 *
 * Screenshots land in test-results/console-preview/. PW_CHROMIUM_PATH points at a Chromium.
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium, devices } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = join(ROOT, 'apps/web-console/dist');
const OUT = join(ROOT, 'test-results/console-preview');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT ?? 4319);
const EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'WESTWIND',
  hazardType: 'tornado',
  status: 'active',
  openedAt: new Date(Date.now() - 39 * 3600e3).toISOString(),
  closedAt: null,
};
const role = process.env.ROLE ?? 'director';
const ACTIONS = {
  director: [
    'dashboard.read',
    'report.read',
    'need.read',
    'site.read',
    'team.read',
    'dispatch.read',
    'recommendation.request',
    'recommendation.decide',
    'discovery.review',
    'event.read',
    'event.create',
    'declaration.read',
    'official_report.read',
    'metric.read',
    'equity.read',
    'joint_assessment.read',
    'facility.read',
    'facility.approve',
    'significant_event.read',
    'reminder.read',
    'mission.read',
    'account.read',
    'personnel.read',
    'refdata.read',
    'fema_mapping.read',
    'intake_graph.read',
    'ai_register.read',
    'resource.read',
    'publication.read',
    'contact.read',
    'dsa.read',
  ],
  nurse: ['shelter_stay.read', 'health_note.read', 'me.read', 'event.read'],
};
const me = {
  accountId: 'a',
  tenantId: 't',
  tenantKind: 'county',
  status: 'active',
  roles: [
    {
      key: role === 'nurse' ? 'shelter_nurse' : 'county_em_director',
      version: 1,
      templateKey: role === 'nurse' ? 'shelter_nurse' : 'county_em_director',
    },
  ],
  agreementTenantIds: [],
  breakGlass: null,
  actions: ACTIONS[role],
  ownRecordsOnly: [],
};
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const routes = {
  '/api/v1/me': me,
  '/api/v1/events': [EVENT],
  '/api/v1/dashboard/counts': {
    asOf: ago(3),
    reports: {
      total: 1612,
      byState: { submitted: 346, under_review: 120, approved: 1146 },
      danger: 4,
    },
    needs: { total: 1236, byStatus: { open: 612, claimed: 498, met: 126 }, standalone: 41 },
    sites: { byStatus: { open: 9, full: 2, closed: 1 }, published: 9 },
    sharing: { activeGrants: 7, partners: 4 },
    claims: [
      { name: 'Salvation Army', count: 212 },
      { name: 'COAD', count: 150 },
    ],
  },
  '/api/v1/recommendations': [{ id: 'r1', state: 'open', kind: 'pod', createdAt: ago(25) }],
  '/api/v1/facility-changes': [
    {
      id: 'f1',
      facilityName: 'Cedar Ridge church hall',
      change: 'create',
      source: 'public_form',
      createdAt: ago(140),
    },
  ],
  '/api/v1/permission-changes': [],
  '/api/v1/reminders': [
    { id: 'm1', title: 'Confirm the Cedar Ridge shelter census', dueAt: ago(50), state: 'overdue' },
  ],
  '/api/v1/significant-events': [
    {
      id: 's1',
      occurredAt: ago(12),
      kind: 'utility_feed',
      summary: 'Restoration estimate for 6,200 customers moved to 3–5 days',
    },
    {
      id: 's2',
      occurredAt: ago(33),
      kind: 'field_team',
      summary: 'Field team 3 finished the Willow Bend route: 41 homes verified',
    },
    {
      id: 's3',
      occurredAt: ago(77),
      kind: 'road_status',
      summary: 'Road closed: debris on the fairgrounds access road',
    },
    {
      id: 's4',
      occurredAt: ago(109),
      kind: 'partner',
      summary: 'Canteen 2 at the Cedar Ridge stop; 380 meals planned',
    },
  ],
  [`/api/v1/events/${EVENT.id}/declaration`]: {
    clock: { daysLeft: 28, overdue: false, deadline: '2026-11-12' },
  },
  '/config.json': {
    productName: 'Showcase County Tools',
    countyName: 'Westwind County',
    helpPhone: '',
  },
};
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p in routes) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(routes[p]));
  }
  if (p.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('[]');
  }
  let file = p.startsWith('/console/') ? join(DIST, p.slice('/console/'.length)) : null;
  if (!file || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ name: 'Dana Reyes', email: 'dana.director@example.org', preferred_username: 'dana.director@example.org' })}.x`;
const session = {
  realm: 'county',
  accessToken: 'synthetic',
  refreshToken: null,
  idToken,
  expiresAt: Date.now() + 3600e3,
  issuer: 'http://x',
  endSession: null,
};
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
      await page.goto(`http://localhost:${PORT}${path}`);
      await page.waitForSelector('main h1', { timeout: 15000 });
      await page.waitForTimeout(600);
      const slug = path.replace(/\//g, '_') || 'root';
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
server.close();
console.log(violations ? `${violations} problems` : 'console preview clean');
