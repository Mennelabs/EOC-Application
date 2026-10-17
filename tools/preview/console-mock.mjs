/**
 * The console's mock API for previews and frame checks: synthetic data only
 * (SCL-12), one role per server, every unknown endpoint an empty list.
 * Serves the built console (apps/web-console/dist) beside it.
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = join(ROOT, 'apps/web-console/dist');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ name: 'Dana Reyes', email: 'dana.director@example.org', preferred_username: 'dana.director@example.org' })}.x`;
/** The session the browser stores (tokens are synthetic; the mock never checks them). */
export const session = {
  realm: 'county',
  accessToken: 'synthetic',
  refreshToken: null,
  idToken,
  expiresAt: Date.now() + 3600e3,
  issuer: 'http://x',
  endSession: null,
};

const EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'WESTWIND',
  hazardType: 'tornado',
  status: 'active',
  openedAt: new Date(Date.now() - 39 * 3600e3).toISOString(),
  closedAt: null,
};
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
    'reentry_pass.read',
    'job_aid.edit',
    'job_aid.approve',
    'event.template_edit',
    'tenant.config.read',
    'license.read',
    'public_records.export',
  ],
  nurse: ['shelter_stay.read', 'health_note.read', 'me.read', 'event.read'],
  partner: [
    'need.read',
    'need.claim',
    'need.release',
    'need.done',
    'shared.read',
    'referral.create',
    'referral.respond',
    'message.send',
    'site.read',
    'dsa.read',
    'dashboard.read',
    'me.read',
    'tenant.read',
    'event.read',
  ],
};
export function routesFor(role) {
  const me = {
    accountId: 'a',
    tenantId: 't',
    tenantKind: role === 'partner' ? 'partner_org' : 'county',
    status: 'active',
    roles: [
      {
        key:
          role === 'nurse'
            ? 'shelter_nurse'
            : role === 'partner'
              ? 'ngo_incident_commander'
              : 'county_em_director',
        version: 1,
        templateKey:
          role === 'nurse'
            ? 'shelter_nurse'
            : role === 'partner'
              ? 'ngo_incident_commander'
              : 'county_em_director',
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
      {
        id: 'm1',
        title: 'Confirm the Cedar Ridge shelter census',
        dueAt: ago(50),
        state: 'overdue',
      },
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
    ...(role !== 'partner'
      ? {}
      : {
          '/api/v1/shared/reports': [
            {
              grantIds: ['g1'],
              reportId: 'r1',
              referenceCode: 'KXMR-4827',
              orgTypes: ['feeding'],
              sections: ['needs', 'contact', 'household'],
              maskedSections: ['location'],
              name: 'Exercise Resident',
              contact: { phone: '+13145550199' },
              contactPreference: 'sms',
              address: null,
              area: { city: 'Westwind', postal: '63001' },
              householdBand: '3-4',
              needs: [{ id: 'n1', category: 'food', status: 'claimed' }],
              accessNeeds: ['medical_power'],
              grantedAt: ago(40),
            },
          ],
          '/api/v1/needs': [
            {
              id: 'n1',
              version: 1,
              reportId: 'r1',
              referenceCode: 'KXMR-4827',
              eventId: EVENT.id,
              category: 'food_water',
              status: 'claimed',
              source: 'resident',
              detail: null,
              area: { city: 'Westwind', postal: '63001' },
              address: null,
              claimed: true,
              claim: {
                tenantId: 't',
                tenantName: 'Hope Canteen Services',
                accountId: null,
                at: ago(20),
              },
              sharedWith: [{ tenantId: 't', name: 'Hope Canteen Services' }],
              doneAt: null,
              doneNote: null,
              createdAt: ago(40),
            },
          ],
          '/api/v1/referrals': [
            {
              id: 'ref1',
              status: 'open',
              fromTenantName: 'Westwind County',
              toTenantName: 'Hope Canteen Services',
              toTenantId: 't',
              fromTenantId: 'county',
              referenceCode: 'KXMR-4827',
              purpose: 'Meals for a household of four',
              outcome: null,
              createdAt: ago(30),
            },
          ],
        }),
    '/config.json': {
      productName: 'Showcase County Tools',
      countyName: 'Westwind County',
      helpPhone: '',
    },
  };
  return routes;
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
/**
 * Serves the built console with the mock API for one role. `port` 0 picks a
 * free port. Returns the port, the session the browser stores and `close()`.
 */
export async function startConsoleMock({ role = 'director', port = 0 } = {}) {
  const routes = routesFor(role);
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
  await new Promise((r) => server.listen(port, r));
  return {
    port: server.address().port,
    session,
    close: () => new Promise((r) => server.close(r)),
  };
}
