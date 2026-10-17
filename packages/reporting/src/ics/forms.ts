/**
 * ICS forms as documents (CON-13; layer-8 plan §4): the ICS 201 incident
 * briefing, 213 general message, 213 RR resource request, 214 activity log
 * and 309 communications log, each built from plain data into one content
 * model that the PDF (tagged, PDF/UA-1) and the CSV are drawn from. The
 * edition is named on every form. Every value is a staff name, an ICS
 * position or a count; a resident never appears on an ICS form (plan §12).
 *
 * Block numbers follow FEMA's 2018 editions of the ICS forms as shipped;
 * compare with fema.gov before release (the same gap as DCL:DEC-12). The
 * ICS 202 objectives are entered per operational period and appear in the
 * 201 (block 7) rather than as a form of their own.
 */

export type IcsFormKey = 'ics_201' | 'ics_213' | 'ics_213rr' | 'ics_214' | 'ics_309';

export const ICS_FORMS: Record<
  IcsFormKey,
  { number: string; title: string; edition: string; scope: string }
> = {
  ics_201: {
    number: 'ICS 201',
    title: 'Incident Briefing',
    edition: 'ICS 201, FEMA 2018 edition (as shipped)',
    scope: 'An event and an operational period',
  },
  ics_213: {
    number: 'ICS 213',
    title: 'General Message',
    edition: 'ICS 213, FEMA 2018 edition (as shipped)',
    scope: 'One general message',
  },
  ics_213rr: {
    number: 'ICS 213 RR',
    title: 'Resource Request Message',
    edition: 'ICS 213 RR, FEMA 2018 edition (as shipped)',
    scope: 'One resource request',
  },
  ics_214: {
    number: 'ICS 214',
    title: 'Activity Log',
    edition: 'ICS 214, FEMA 2018 edition (as shipped)',
    scope: 'A person or a team over an operational period',
  },
  ics_309: {
    number: 'ICS 309',
    title: 'Communications Log',
    edition: 'ICS 309, FEMA 2018 edition (as shipped)',
    scope: 'A net over an operational period',
  },
};
export const ICS_FORM_KEYS = Object.keys(ICS_FORMS) as IcsFormKey[];

export type IcsCell = string | number | null;
export type IcsBlock =
  | { no: string; label: string; kind: 'value'; value: IcsCell }
  | { no: string; label: string; kind: 'text'; text: string | null }
  | { no: string; label: string; kind: 'table'; columns: string[]; rows: IcsCell[][] };

/** A staff member as a form names them: a name and an ICS position, never more. */
export interface Signer {
  name: string;
  position: string | null;
}

export interface IcsFormContent {
  form: IcsFormKey;
  number: string;
  title: string;
  edition: string;
  /** The event's name (block 1 on every form). */
  incident: string;
  timeZone: string;
  preparedBy: Signer;
  preparedAt: string;
  blocks: IcsBlock[];
}

export const when = (iso: string | null | undefined, tz: string): string =>
  iso
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(iso))
    : 'Unknown';
const period = (from: string, to: string, tz: string) => `${when(from, tz)} to ${when(to, tz)}`;
const signer = (s: Signer | null | undefined) =>
  s ? `${s.name}${s.position ? `, ${s.position}` : ''}` : null;

interface Common {
  incident: string;
  timeZone: string;
  preparedBy: Signer;
  preparedAt: string;
}
const base = (form: IcsFormKey, c: Common, blocks: IcsBlock[]): IcsFormContent => ({
  form,
  number: ICS_FORMS[form].number,
  title: ICS_FORMS[form].title,
  edition: ICS_FORMS[form].edition,
  incident: c.incident,
  timeZone: c.timeZone,
  preparedBy: c.preparedBy,
  preparedAt: c.preparedAt,
  blocks,
});

// ---------------------------------------------------------------- ICS 201
export interface Ics201Input extends Common {
  incidentNumber: string | null;
  initiatedAt: string | null;
  periodFrom: string;
  periodTo: string;
  /** Block 4: places on the map, by name and kind; the sketch itself is the situation map. */
  places: { name: string; kind: string; status: string | null }[];
  hasGeometry: boolean;
  /** Block 5: the latest issued situation report's summary, with its title and issue time. */
  situation: { title: string; issuedAt: string; text: string } | null;
  safety: string | null;
  objectives: { position: number; objective: string; owner: string | null; status: string }[];
  actions: {
    reference: string;
    kind: string;
    state: string;
    priority: string;
    summary: string | null;
  }[];
  organization: { position: string; name: string; agency: string | null }[];
  resources: {
    resource: string;
    identifier: string | null;
    ordered: string | null;
    eta: string | null;
    arrived: string | null;
    status: string;
    notes: string | null;
  }[];
}

export function ics201(i: Ics201Input): IcsFormContent {
  const tz = i.timeZone;
  return base('ics_201', i, [
    { no: '1', label: 'Incident name', kind: 'value', value: i.incident },
    { no: '2', label: 'Incident number', kind: 'value', value: i.incidentNumber },
    { no: '3', label: 'Date and time initiated', kind: 'value', value: when(i.initiatedAt, tz) },
    {
      no: '3a',
      label: 'Operational period',
      kind: 'value',
      value: period(i.periodFrom, i.periodTo, tz),
    },
    {
      no: '4',
      label: i.hasGeometry
        ? 'Map or sketch: the places on the situation map at issue; the map itself is the sketch'
        : 'Map or sketch: no geometry is recorded for this event; the places are listed instead',
      kind: 'table',
      columns: ['Place', 'Kind', 'Status'],
      rows: i.places.map((p) => [p.name, p.kind, p.status]),
    },
    {
      no: '5',
      label: 'Situation summary and health and safety briefing',
      kind: 'text',
      text: i.situation
        ? `${i.situation.title}, issued ${when(i.situation.issuedAt, tz)}:\n\n${i.situation.text}${i.safety ? `\n\nSafety: ${i.safety}` : ''}`
        : i.safety
          ? `No situation report has been issued for this event.\n\nSafety: ${i.safety}`
          : 'No situation report has been issued for this event.',
    },
    { no: '6', label: 'Prepared by', kind: 'value', value: signer(i.preparedBy) },
    {
      no: '7',
      label: 'Current and planned objectives',
      kind: 'table',
      columns: ['No.', 'Objective', 'Owner', 'Status'],
      rows: i.objectives.map((o) => [o.position, o.objective, o.owner, o.status]),
    },
    {
      no: '8',
      label: 'Current and planned actions, strategies and tactics',
      kind: 'table',
      columns: ['Mission', 'Kind', 'State', 'Priority', 'Summary'],
      rows: i.actions.map((a) => [a.reference, a.kind, a.state, a.priority, a.summary]),
    },
    {
      no: '9',
      label: 'Current organization',
      kind: 'table',
      columns: ['Position', 'Name', 'Agency'],
      rows: i.organization.map((o) => [o.position, o.name, o.agency]),
    },
    {
      no: '10',
      label: 'Resource summary',
      kind: 'table',
      columns: ['Resource', 'Identifier', 'Ordered', 'ETA', 'Arrived', 'Status', 'Notes'],
      rows: i.resources.map((r) => [
        r.resource,
        r.identifier,
        r.ordered ? when(r.ordered, tz) : null,
        r.eta ? when(r.eta, tz) : null,
        r.arrived ? when(r.arrived, tz) : null,
        r.status,
        r.notes,
      ]),
    },
  ]);
}

// ---------------------------------------------------------------- ICS 213
export interface Ics213Input extends Common {
  messageNumber: string;
  to: Signer;
  from: Signer;
  subject: string;
  sentAt: string | null;
  body: string;
  approvedBy: Signer | null;
  approvedAt: string | null;
  reply: string | null;
  repliedBy: Signer | null;
  repliedAt: string | null;
}

export function ics213(i: Ics213Input): IcsFormContent {
  const tz = i.timeZone;
  return base('ics_213', i, [
    { no: '1', label: 'Incident name', kind: 'value', value: i.incident },
    { no: '1a', label: 'Message number', kind: 'value', value: i.messageNumber },
    { no: '2', label: 'To (name and position)', kind: 'value', value: signer(i.to) },
    { no: '3', label: 'From (name and position)', kind: 'value', value: signer(i.from) },
    { no: '4', label: 'Subject', kind: 'value', value: i.subject },
    { no: '5', label: 'Date and time', kind: 'value', value: when(i.sentAt ?? i.preparedAt, tz) },
    { no: '6', label: 'Message', kind: 'text', text: i.body },
    {
      no: '7',
      label: 'Approved by (name and position)',
      kind: 'value',
      value: i.approvedBy ? `${signer(i.approvedBy)}, ${when(i.approvedAt, tz)}` : null,
    },
    { no: '8', label: 'Reply', kind: 'text', text: i.reply },
    {
      no: '9',
      label: 'Replied by (name, position, date and time)',
      kind: 'value',
      value: i.repliedBy ? `${signer(i.repliedBy)}, ${when(i.repliedAt, tz)}` : null,
    },
  ]);
}

// ---------------------------------------------------------------- ICS 213 RR
export interface Ics213RrInput extends Common {
  requestNumber: string;
  requestedAt: string | null;
  lines: {
    quantity: number;
    unit: string | null;
    kind: string;
    type: string | null;
    description: string | null;
    eta: string | null;
    cost: number | null;
  }[];
  deliveryLocation: string | null;
  substitutes: string | null;
  suggestedSources: string | null;
  requestedBy: Signer;
  priority: string;
  approvedBy: Signer | null;
  approvedAt: string | null;
  logisticsOrderNumber: string | null;
  supplier: string | null;
  notes: string | null;
  placedBy: Signer | null;
  placedAt: string | null;
  placedWith: string | null;
  stateTrackingNumber: string | null;
  eta: string | null;
  financeReply: string | null;
  financeBy: Signer | null;
  financeAt: string | null;
  status: string;
}

export function ics213rr(i: Ics213RrInput): IcsFormContent {
  const tz = i.timeZone;
  return base('ics_213rr', i, [
    { no: '1', label: 'Incident name', kind: 'value', value: i.incident },
    {
      no: '2',
      label: 'Date and time',
      kind: 'value',
      value: when(i.requestedAt ?? i.preparedAt, tz),
    },
    { no: '3', label: 'Resource request number', kind: 'value', value: i.requestNumber },
    {
      no: '4',
      label: 'Order',
      kind: 'table',
      columns: ['Qty', 'Kind', 'Type', 'Detailed item description', 'Arrival requested', 'Cost'],
      rows: i.lines.map((l) => [
        `${l.quantity}${l.unit ? ` ${l.unit}` : ''}`,
        l.kind,
        l.type,
        l.description,
        l.eta ? when(l.eta, tz) : null,
        l.cost,
      ]),
    },
    {
      no: '5',
      label: 'Requested delivery or reporting location',
      kind: 'value',
      value: i.deliveryLocation,
    },
    {
      no: '6',
      label: 'Suitable substitutes and suggested sources',
      kind: 'text',
      text: [i.substitutes, i.suggestedSources].filter(Boolean).join('\n\n') || null,
    },
    {
      no: '7',
      label: 'Requested by (name and position)',
      kind: 'value',
      value: signer(i.requestedBy),
    },
    { no: '8', label: 'Priority', kind: 'value', value: i.priority },
    {
      no: '9',
      label: 'Section chief approval',
      kind: 'value',
      value: i.approvedBy ? `${signer(i.approvedBy)}, ${when(i.approvedAt, tz)}` : null,
    },
    { no: '10', label: 'Logistics order number', kind: 'value', value: i.logisticsOrderNumber },
    { no: '11', label: 'Supplier', kind: 'value', value: i.supplier },
    { no: '12', label: 'Notes', kind: 'text', text: i.notes },
    {
      no: '13',
      label: 'Order placed by (name, position, date and time)',
      kind: 'value',
      value: i.placedBy
        ? `${signer(i.placedBy)}, ${when(i.placedAt, tz)}${i.placedWith ? `; with ${i.placedWith}` : ''}${i.stateTrackingNumber ? `; state number ${i.stateTrackingNumber}` : ''}`
        : null,
    },
    { no: '13a', label: 'Estimated arrival', kind: 'value', value: i.eta ? when(i.eta, tz) : null },
    { no: '14', label: 'Reply or comments from finance', kind: 'text', text: i.financeReply },
    {
      no: '15',
      label: 'Finance section (name, position, date and time)',
      kind: 'value',
      value: i.financeBy ? `${signer(i.financeBy)}, ${when(i.financeAt, tz)}` : null,
    },
    { no: '16', label: 'Status at issue', kind: 'value', value: i.status },
  ]);
}

// ---------------------------------------------------------------- ICS 214
export interface Ics214Input extends Common {
  periodFrom: string;
  periodTo: string;
  /** The person or the team the log is for. */
  subject: { name: string; position: string | null; agency: string | null };
  assigned: { name: string; position: string | null; agency: string | null }[];
  activities: { at: string; activity: string }[];
}

export function ics214(i: Ics214Input): IcsFormContent {
  const tz = i.timeZone;
  return base('ics_214', i, [
    { no: '1', label: 'Incident name', kind: 'value', value: i.incident },
    {
      no: '2',
      label: 'Operational period',
      kind: 'value',
      value: period(i.periodFrom, i.periodTo, tz),
    },
    { no: '3', label: 'Name', kind: 'value', value: i.subject.name },
    { no: '4', label: 'ICS position', kind: 'value', value: i.subject.position },
    { no: '5', label: 'Home agency (and unit)', kind: 'value', value: i.subject.agency },
    {
      no: '6',
      label: 'Resources assigned',
      kind: 'table',
      columns: ['Name', 'ICS position', 'Home agency (and unit)'],
      rows: i.assigned.map((a) => [a.name, a.position, a.agency]),
    },
    {
      no: '7',
      label: 'Activity log',
      kind: 'table',
      columns: ['Date and time', 'Notable activities'],
      rows: i.activities.map((a) => [when(a.at, tz), a.activity]),
    },
    {
      no: '8',
      label: 'Prepared by',
      kind: 'value',
      value: `${signer(i.preparedBy)}, ${when(i.preparedAt, tz)}`,
    },
  ]);
}

// ---------------------------------------------------------------- ICS 309
export interface Ics309Input extends Common {
  periodFrom: string;
  periodTo: string;
  net: string;
  operator: Signer | null;
  entries: { at: string; from: string | null; to: string | null; message: string | null }[];
}

export function ics309(i: Ics309Input): IcsFormContent {
  const tz = i.timeZone;
  return base('ics_309', i, [
    { no: '1', label: 'Incident name', kind: 'value', value: i.incident },
    {
      no: '2',
      label: 'Operational period',
      kind: 'value',
      value: period(i.periodFrom, i.periodTo, tz),
    },
    { no: '2a', label: 'Net', kind: 'value', value: i.net },
    {
      no: '3',
      label: 'Radio operator (name and position)',
      kind: 'value',
      value: signer(i.operator),
    },
    {
      no: '4',
      label: 'Log',
      kind: 'table',
      columns: ['Time', 'From', 'To', 'Message'],
      rows: i.entries.map((e) => [when(e.at, tz), e.from, e.to, e.message]),
    },
    {
      no: '5',
      label: 'Prepared by',
      kind: 'value',
      value: `${signer(i.preparedBy)}, ${when(i.preparedAt, tz)}`,
    },
  ]);
}
