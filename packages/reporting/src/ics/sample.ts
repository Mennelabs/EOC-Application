/**
 * Synthetic inputs for one of each ICS form (CON-13), for the veraPDF
 * samples in CI and the unit tests. Exercise names only (SCL-12).
 */
import {
  ics201,
  ics213,
  ics213rr,
  ics214,
  ics309,
  type IcsFormContent,
  type IcsFormKey,
} from './forms.ts';

const common = {
  incident: 'WESTWIND (exercise)',
  timeZone: 'America/Chicago',
  preparedBy: { name: 'Marcus Bell (exercise)', position: 'Planning Section Chief' },
  preparedAt: '2026-10-15T18:00:00.000Z',
};

export function sampleIcsForm(form: IcsFormKey): IcsFormContent {
  switch (form) {
    case 'ics_201':
      return ics201({
        ...common,
        incidentNumber: 'WESTWIND',
        initiatedAt: '2026-10-14T02:50:00.000Z',
        periodFrom: '2026-10-15T12:00:00.000Z',
        periodTo: '2026-10-16T00:00:00.000Z',
        places: [
          { name: 'Harmon High School gym', kind: 'shelter', status: 'open' },
          { name: 'Commercial Row distribution point', kind: 'distribution', status: 'open' },
        ],
        hasGeometry: true,
        situation: {
          title: 'Situation report 3',
          issuedAt: '2026-10-15T00:00:00.000Z',
          text: 'Exercise: 52 housing units have verified damage. River crest expected Thursday.',
        },
        safety: 'Downed lines along Commercial Row; treat every line as live.',
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
            status: 'open',
          },
        ],
        actions: [
          {
            reference: 'WW-0012',
            kind: 'welfare_check',
            state: 'open',
            priority: 'high',
            summary: 'Oxygen-dependent resident on Elm St',
          },
          {
            reference: 'WW-0015',
            kind: 'road_clearance',
            state: 'on_scene',
            priority: 'urgent',
            summary: 'Commercial Row debris',
          },
        ],
        organization: [
          {
            position: 'Incident Commander',
            name: 'Dana Whitfield (exercise)',
            agency: 'Westwind County EM',
          },
          {
            position: 'Planning Section Chief',
            name: 'Marcus Bell (exercise)',
            agency: 'Westwind County EM',
          },
        ],
        resources: [
          {
            resource: 'Guard TC-1',
            identifier: 'Team',
            ordered: null,
            eta: null,
            arrived: '2026-10-14T12:00:00.000Z',
            status: 'on_task',
            notes: 'Traffic control',
          },
          {
            resource: 'Cots, 200',
            identifier: 'WESTWIND-RR-0001',
            ordered: '2026-10-15T04:00:00.000Z',
            eta: '2026-10-16T06:00:00.000Z',
            arrived: null,
            status: 'en_route',
            notes: 'State number SEMA-EX-4471',
          },
        ],
      });
    case 'ics_213':
      return ics213({
        ...common,
        messageNumber: 'WESTWIND-GM-0001',
        to: { name: 'Luis Ortega (exercise)', position: 'Mass Care Coordinator' },
        from: { name: 'Marcus Bell (exercise)', position: 'Planning Section Chief' },
        subject: 'Second shelter opening',
        sentAt: '2026-10-15T15:00:00.000Z',
        body: 'Open the Lincoln Elementary shelter by 18:00 today.\n\nExpect 60 arrivals from the Elm St evacuation.',
        approvedBy: { name: 'Dana Whitfield (exercise)', position: 'Incident Commander' },
        approvedAt: '2026-10-15T14:50:00.000Z',
        reply: 'Lincoln Elementary open at 17:40 with 80 cots.',
        repliedBy: { name: 'Luis Ortega (exercise)', position: 'Mass Care Coordinator' },
        repliedAt: '2026-10-15T22:45:00.000Z',
      });
    case 'ics_213rr':
      return ics213rr({
        ...common,
        requestNumber: 'WESTWIND-RR-0001',
        requestedAt: '2026-10-15T01:00:00.000Z',
        lines: [
          {
            quantity: 200,
            unit: 'each',
            kind: 'Cots',
            type: 'Standard shelter cot',
            description: 'For the Harmon High shelter',
            eta: null,
            cost: null,
          },
          {
            quantity: 400,
            unit: 'each',
            kind: 'Blankets',
            type: 'Wool or fleece',
            description: null,
            eta: null,
            cost: null,
          },
        ],
        deliveryLocation: 'Harmon High School gym (shelter), loading dock',
        substitutes: 'Folding camp beds acceptable in place of cots.',
        suggestedSources: 'State logistics warehouse; Red Cross regional chapter.',
        requestedBy: { name: 'Luis Ortega (exercise)', position: 'Mass Care Coordinator' },
        priority: 'urgent',
        approvedBy: { name: 'Dana Whitfield (exercise)', position: 'Incident Commander' },
        approvedAt: '2026-10-15T03:00:00.000Z',
        logisticsOrderNumber: null,
        supplier: null,
        notes: 'Shelter at 180 of 220 after the second night.',
        placedBy: { name: 'Casey Nguyen (exercise)', position: 'Logistics Section Chief' },
        placedAt: '2026-10-15T04:00:00.000Z',
        placedWith: 'the state',
        stateTrackingNumber: 'SEMA-EX-4471',
        eta: '2026-10-16T06:00:00.000Z',
        financeReply: 'Approved against the shelter operations line (exercise).',
        financeBy: { name: 'Dana Whitfield (exercise)', position: 'Finance Section Chief' },
        financeAt: '2026-10-15T02:00:00.000Z',
        status: 'en_route',
      });
    case 'ics_214':
      return ics214({
        ...common,
        periodFrom: '2026-10-15T12:00:00.000Z',
        periodTo: '2026-10-16T00:00:00.000Z',
        subject: {
          name: 'Guard TC-1',
          position: 'Traffic control team',
          agency: 'National Guard (exercise)',
        },
        assigned: [
          {
            name: 'Sgt. Rivera (exercise)',
            position: 'Team lead',
            agency: 'National Guard (exercise)',
          },
          {
            name: 'Spc. Okafor (exercise)',
            position: 'Member',
            agency: 'National Guard (exercise)',
          },
        ],
        activities: [
          { at: '2026-10-15T12:05:00.000Z', activity: 'Checked in at staging' },
          { at: '2026-10-15T12:40:00.000Z', activity: 'WW-0015 dispatched: Commercial Row debris' },
          { at: '2026-10-15T13:10:00.000Z', activity: 'On scene at Commercial Row' },
        ],
      });
    case 'ics_309':
      return ics309({
        ...common,
        periodFrom: '2026-10-15T12:00:00.000Z',
        periodTo: '2026-10-16T00:00:00.000Z',
        net: 'County ARES net',
        operator: { name: 'Casey Nguyen (exercise)', position: 'Net control' },
        entries: [
          { at: '2026-10-15T12:00:00.000Z', from: 'NET', to: null, message: 'Net open' },
          {
            at: '2026-10-15T12:41:00.000Z',
            from: 'NET',
            to: 'TC-1',
            message: 'WW-0015 passed to TC-1 by radio; acknowledgement pending',
          },
          {
            at: '2026-10-15T12:43:00.000Z',
            from: 'TC-1',
            to: 'NET',
            message: 'Acknowledged, en route',
          },
        ],
      });
  }
}
