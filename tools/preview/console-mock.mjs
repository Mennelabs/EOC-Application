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
    'resource_request.read',
    'resource_request.write',
    'resource_request.submit',
    'resource_request.approve',
    'resource_request.place',
    'resource_request.cancel',
    'incident_objective.read',
    'incident_objective.write',
    'general_message.read',
    'general_message.write',
    'general_message.approve',
    'general_message.send',
    'ics_form.read',
    'ics_form.issue',
    'ics_form.export',
    'briefing.read',
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
    // REC-12: the planning factors screen reads defaults and the county's overrides.
    '/api/v1/recommendations/planning-factors': {
      defaults: {
        shelterSqftPerPerson: 40,
        peoplePerShower: 25,
        personsPerHousehold: 2.5,
        coverageKm: 16,
        staleDays: 365,
        mealsPerPersonPerStop: 1,
        stopsPerCanteen: 3,
        feedingFirstStartHour: 11,
        feedingWindowHours: 1.5,
        feedingGapHours: 1,
        feedingClusterKm: 0.8,
        feedingSiteKm: 0.5,
        feedingCoverageKm: 1.6,
        languageNotePct: 5,
      },
      overrides: {},
    },
    '/api/v1/events': [EVENT],
    // CON-11: the wall briefing.
    '/api/v1/briefing': {
      asOf: ago(0),
      refreshSeconds: 60,
      event: {
        id: EVENT.id,
        name: EVENT.name,
        hazardType: 'tornado',
        status: 'active',
        openedAt: EVENT.openedAt,
      },
      damage: {
        byDegree: { destroyed: 14, major: 38, minor: 61, affected: 97 },
        verified: 210,
        awaitingReview: 346,
      },
      shelters: [
        { name: 'Harmon High School gym', status: 'open', capacity: 220, occupancy: 180 },
        { name: 'Lincoln Elementary', status: 'open', capacity: 120, occupancy: 64 },
      ],
      needs: { open: 612, byCategory: { food: 210, shelter: 96, medical: 41, cleanup: 265 } },
      missions: { byState: { open: 23, en_route: 6, on_scene: 11, closed: 140 } },
      resourceRequests: { byStatus: { submitted: 1, en_route: 1 } },
      objectives: [
        {
          position: 1,
          objective: 'Shelter everyone displaced by the tornado',
          owner: 'Mass Care Coordinator',
          status: 'open',
        },
        {
          position: 2,
          objective: 'Clear Commercial Row for utility crews',
          owner: 'Operations Section Chief',
          status: 'met',
        },
      ],
      significantEvents: [
        {
          occurredAt: ago(12),
          kind: 'dispatch',
          summary: 'WW-0015 dispatched: Commercial Row debris',
        },
        {
          occurredAt: ago(48),
          kind: 'site',
          summary: 'Lincoln Elementary shelter opened with 120 cots',
        },
        {
          occurredAt: ago(130),
          kind: 'hazard',
          summary: 'Downed lines reported along Commercial Row',
        },
      ],
      liveConditions: [],
    },
    // CON-13: ICS forms as documents.
    '/api/v1/ics-forms': [
      {
        form: 'ics_201',
        number: 'ICS 201',
        title: 'Incident Briefing',
        edition: 'ICS 201, FEMA 2018 edition (as shipped)',
        scope: 'An event and an operational period',
      },
      {
        form: 'ics_213',
        number: 'ICS 213',
        title: 'General Message',
        edition: 'ICS 213, FEMA 2018 edition (as shipped)',
        scope: 'One general message',
      },
      {
        form: 'ics_213rr',
        number: 'ICS 213 RR',
        title: 'Resource Request Message',
        edition: 'ICS 213 RR, FEMA 2018 edition (as shipped)',
        scope: 'One resource request',
      },
      {
        form: 'ics_214',
        number: 'ICS 214',
        title: 'Activity Log',
        edition: 'ICS 214, FEMA 2018 edition (as shipped)',
        scope: 'A person or a team over an operational period',
      },
      {
        form: 'ics_309',
        number: 'ICS 309',
        title: 'Communications Log',
        edition: 'ICS 309, FEMA 2018 edition (as shipped)',
        scope: 'A net over an operational period',
      },
    ],
    '/api/v1/incident-objectives': [
      {
        id: 'o1',
        version: 1,
        periodFrom: ago(300),
        periodTo: ago(-420),
        position: 1,
        objective: 'Shelter everyone displaced by the tornado',
        ownerPosition: 'Mass Care Coordinator',
        status: 'open',
      },
      {
        id: 'o2',
        version: 1,
        periodFrom: ago(300),
        periodTo: ago(-420),
        position: 2,
        objective: 'Clear Commercial Row for utility crews',
        ownerPosition: 'Operations Section Chief',
        status: 'met',
      },
    ],
    '/api/v1/general-messages': [
      {
        id: 'g1',
        version: 4,
        messageNumber: 'WESTWIND-GM-0001',
        status: 'replied',
        to: { name: 'Luis Ortega (exercise)', position: 'Mass Care Coordinator' },
        from: { name: 'Marcus Bell (exercise)', position: 'Planning Section Chief' },
        subject: 'Second shelter opening',
        body: 'Open the Lincoln Elementary shelter by 18:00 today.',
        writtenBy: 'Marcus Bell (exercise)',
        writtenByYou: false,
        approvedBy: 'Dana Reyes',
        sentAt: ago(200),
        reply: 'Lincoln Elementary open at 17:40 with 80 cots.',
        repliedBy: { name: 'Luis Ortega (exercise)', position: 'Mass Care Coordinator' },
        updatedAt: ago(30),
      },
      {
        id: 'g2',
        version: 1,
        messageNumber: 'WESTWIND-GM-0002',
        status: 'draft',
        to: { name: 'Casey Nguyen (exercise)', position: 'Logistics Section Chief' },
        from: { name: 'Marcus Bell (exercise)', position: 'Planning Section Chief' },
        subject: 'Generator fuel',
        body: 'Confirm 72 hours of fuel for the distribution point generators.',
        writtenBy: 'Marcus Bell (exercise)',
        writtenByYou: false,
        approvedBy: null,
        sentAt: null,
        reply: null,
        repliedBy: null,
        updatedAt: ago(12),
      },
    ],
    '/api/v1/ics-forms/issues': [
      {
        id: 'i1',
        form: 'ics_201',
        number: 'ICS 201',
        edition: 'ICS 201, FEMA 2018 edition (as shipped)',
        sequence: 1,
        title: 'ICS 201 Incident Briefing: WESTWIND',
        contentHash: 'e'.repeat(64),
        issuedAt: ago(90),
        issuedBy: 'Marcus Bell (exercise)',
      },
    ],
    // CON-13: resource requests to the state, most urgent first.
    '/api/v1/resource-requests': [
      {
        id: 'rr-1',
        version: 6,
        updatedAt: ago(9),
        eventId: EVENT.id,
        eventName: EVENT.name,
        requestNumber: 'WESTWIND-RR-0001',
        status: 'en_route',
        priority: 'urgent',
        supplyRequestId: null,
        deliveryLocation: 'Harmon High School gym (shelter), loading dock',
        requestedByName: 'Luis Ortega (exercise)',
        requestedByPosition: 'Mass Care Coordinator',
        substitutes: 'Folding camp beds acceptable in place of cots.',
        suggestedSources: 'State logistics warehouse; Red Cross regional chapter.',
        notes: 'Shelter at 180 of 220 after the second night.',
        costEstimate: 18400,
        financeReply: 'Approved against the shelter operations line (exercise).',
        financeRepliedAt: ago(18),
        submittedAt: ago(19),
        submittedBy: 'Luis Ortega (exercise)',
        submittedByYou: false,
        approvedAt: ago(17),
        approvedBy: 'Dana Whitfield (exercise)',
        placedAt: ago(16),
        placedWith: 'state',
        stateTrackingNumber: 'SEMA-EX-4471',
        supplier: null,
        logisticsOrderNumber: null,
        eta: ago(-10),
        arrivedAt: null,
        receivedAt: null,
        cancelledAt: null,
        financeReplyNeeded: false,
        lines: [
          {
            lineNo: 1,
            quantity: 200,
            unit: 'each',
            kind: 'Cots',
            type: 'Standard shelter cot',
            description: 'For the Harmon High shelter',
            eta: null,
            cost: null,
          },
          {
            lineNo: 2,
            quantity: 400,
            unit: 'each',
            kind: 'Blankets',
            type: 'Wool or fleece',
            description: null,
            eta: null,
            cost: null,
          },
        ],
        steps: [
          {
            step: 'drafted',
            fromStatus: null,
            toStatus: 'draft',
            reason: null,
            stateTrackingNumber: null,
            occurredAt: ago(20),
            actorKind: 'account',
            actorName: 'Luis Ortega (exercise)',
          },
          {
            step: 'submitted',
            fromStatus: 'draft',
            toStatus: 'submitted',
            reason: 'Shelter near capacity',
            stateTrackingNumber: null,
            occurredAt: ago(19),
            actorKind: 'account',
            actorName: 'Luis Ortega (exercise)',
          },
          {
            step: 'approved',
            fromStatus: 'submitted',
            toStatus: 'approved',
            reason: 'Confirmed with the shelter manager',
            stateTrackingNumber: null,
            occurredAt: ago(17),
            actorKind: 'account',
            actorName: 'Dana Whitfield (exercise)',
          },
          {
            step: 'placed',
            fromStatus: 'approved',
            toStatus: 'placed',
            reason: 'Placed with state logistics',
            stateTrackingNumber: 'SEMA-EX-4471',
            occurredAt: ago(16),
            actorKind: 'account',
            actorName: 'Casey Nguyen (exercise)',
          },
          {
            step: 'en_route',
            fromStatus: 'placed',
            toStatus: 'en_route',
            reason: null,
            stateTrackingNumber: null,
            occurredAt: ago(9),
            actorKind: 'account',
            actorName: 'Casey Nguyen (exercise)',
          },
        ],
      },
      {
        id: 'rr-2',
        version: 2,
        updatedAt: ago(14),
        eventId: EVENT.id,
        eventName: EVENT.name,
        requestNumber: 'WESTWIND-RR-0002',
        status: 'submitted',
        priority: 'high',
        supplyRequestId: null,
        deliveryLocation: 'Commercial Row distribution point',
        requestedByName: 'Marcus Bell (exercise)',
        requestedByPosition: 'Planning Section Chief',
        substitutes: null,
        suggestedSources: 'State public works fleet.',
        notes: 'Power out along Commercial Row.',
        costEstimate: 6000,
        financeReply: null,
        financeRepliedAt: null,
        submittedAt: ago(14),
        submittedBy: 'Marcus Bell (exercise)',
        submittedByYou: false,
        approvedAt: null,
        approvedBy: null,
        placedAt: null,
        placedWith: null,
        stateTrackingNumber: null,
        supplier: null,
        logisticsOrderNumber: null,
        eta: null,
        arrivedAt: null,
        receivedAt: null,
        cancelledAt: null,
        financeReplyNeeded: false,
        lines: [
          {
            lineNo: 1,
            quantity: 4,
            unit: 'each',
            kind: 'Generators',
            type: 'Towable, 20 kW',
            description: 'With fuel for 72 hours',
            eta: null,
            cost: null,
          },
        ],
        steps: [
          {
            step: 'drafted',
            fromStatus: null,
            toStatus: 'draft',
            reason: null,
            stateTrackingNumber: null,
            occurredAt: ago(15),
            actorKind: 'account',
            actorName: 'Marcus Bell (exercise)',
          },
          {
            step: 'submitted',
            fromStatus: 'draft',
            toStatus: 'submitted',
            reason: 'Distribution point cannot run after dark',
            stateTrackingNumber: null,
            occurredAt: ago(14),
            actorKind: 'account',
            actorName: 'Marcus Bell (exercise)',
          },
        ],
      },
    ],
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
