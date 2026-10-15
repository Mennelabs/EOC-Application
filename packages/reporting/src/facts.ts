/**
 * The facts an official report states (layer-6 task E; F15, RULE-02,
 * RULE-10, CON-06, AC-15B, DCL:DEC-07/08): computed from the records inside
 * the caller's transaction (row-level security), each citing its definition
 * and version, and for damage the exact record versions it used. Unknown is
 * null and reads "unknown", never zero. A narrative is drafted from the
 * facts by template and labelled as drafted until a person edits it (no AI
 * in this layer). `compareFacts` gives "what changed since the last
 * briefing"; `contentHash` fixes an issued report's content.
 */
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database, PartnerCategory, PartnerRollup } from '@cg/db';
import { countDamage, DEGREES } from './counting.ts';
import { loadDamageRecords } from './load.ts';
import {
  ALL_PARTNERS,
  applyRollup,
  includesCategory,
  partnerCounts,
  partnerOrganizations,
  rollupStatement,
} from './partners.ts';

export interface Definition {
  key: string;
  version: number;
  text: string;
}

/** Version 1 of each definition; task G moves them into the governed definitions store. */
export const DEFINITIONS = {
  damage: {
    key: 'counting_rule',
    version: 1,
    text: 'Housing units with approved, desktop- or field-verified damage to a primary residence, one home counted once; self-reported, awaiting review, unreachable, witness, pre-existing, non-primary and non-residential records are shown apart and never added. Records made after the cutoff are left out.',
  },
  reports: {
    key: 'reports_received',
    version: 1,
    text: 'Resident reports submitted in the period up to the cutoff. Awaiting review: submitted by the cutoff, not withdrawn or merged, with no decision when the facts were computed.',
  },
  outages: {
    key: 'outages_open',
    version: 1,
    text: 'Outages logged by staff or confirmed by a person, open at the cutoff (started by then, not restored by then). Over 72 hours: open more than 72 hours at the cutoff.',
  },
  casualties: {
    key: 'casualties_official',
    version: 1,
    text: "The latest count of each kind entered from an official source by the cutoff; residents' answers are never added (DEC-08). No entry reads unknown.",
  },
  shelters: {
    key: 'shelters_open',
    version: 1,
    text: 'Shelters open, limited or full when the facts were computed, with their last reported occupancy and capacity; confidential shelters are counted without their names.',
  },
  partners: {
    key: 'partner_counts',
    version: 1,
    text: "Counts from partner organizations' own records for the event when the facts were computed: needs they met, meals and other services their teams logged, people and households in shelters they run, and teams checked in. Numbers only, never a name, household or record. All partner organizations and counts unless the county chose; the report states what it includes.",
  },
} as const satisfies Record<string, Definition>;

export type FactKey = keyof typeof DEFINITIONS;

export interface FactRow {
  key: string;
  label: string;
  /** Null is unknown, never zero (RULE-02, AC-15B). */
  value: number | null;
  detail?: string;
}

export interface RecordRef {
  type: 'report' | 'field_assessment';
  id: string;
  version: number;
}

export interface Fact {
  key: FactKey;
  title: string;
  rows: FactRow[];
  note: string | null;
  definition: Definition;
  /** The records behind the figure (damage only): what an issued report cites (RULE-10). */
  records: RecordRef[];
}

export interface FactScope {
  /** The county whose report it is: partner counts answer only for it. */
  tenantId: string;
  eventId: string;
  periodFrom: Date;
  periodTo: Date;
  cutoff: Date;
  /** Which partner counts the report states (2026-10-15); all unless the county chose. */
  partnerRollup?: PartnerRollup;
}

const DEGREE_LABEL = {
  affected: 'Affected',
  minor: 'Minor',
  major: 'Major',
  destroyed: 'Destroyed',
};
const OUTAGE_LABEL: Record<string, string> = {
  hospital: 'Hospitals',
  water: 'Drinking water',
  wastewater: 'Wastewater',
  police: 'Police',
  fire_ems: 'Fire and EMS',
  school: 'Schools',
  child_care: 'Child care',
  eldercare: 'Eldercare',
  roads: 'Roads',
  power: 'Power',
};

async function damageFact(trx: Transaction<Database>, s: FactScope): Promise<Fact> {
  const records = await loadDamageRecords(trx, s.eventId, { cutoff: s.cutoff });
  const t = countDamage(records);
  const byId = new Map(records.map((r) => [r.id, r]));
  const apart = t.shownSeparately;
  return {
    key: 'damage',
    title: 'Verified damage to homes',
    rows: [
      ...DEGREES.map((d) => ({
        key: d,
        label: `${DEGREE_LABEL[d]}, housing units`,
        value: t.counted.byDegree[d],
      })),
      { key: 'units', label: 'Housing units counted', value: t.counted.units },
      { key: 'homes', label: 'Homes and buildings counted', value: t.counted.homes },
      { key: 'selfReported', label: 'Self-reported, not yet verified', value: apart.selfReported },
      { key: 'awaitingReview', label: 'Verified, awaiting review', value: apart.awaitingReview },
      {
        key: 'inaccessible',
        label: 'Could not be reached',
        value: apart.inaccessible.total,
        ...(apart.inaccessible.total
          ? {
              detail: Object.entries(apart.inaccessible.byReason)
                .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
                .map(([r, n]) => `${r.replace(/_/g, ' ')}: ${n}`)
                .join('; '),
            }
          : {}),
      },
      { key: 'witness', label: 'Seen by a witness only', value: apart.witness },
      { key: 'preExisting', label: 'Damage from before the incident', value: apart.preExisting },
      {
        key: 'notPrimaryResidence',
        label: 'Not a primary residence',
        value: apart.notPrimaryResidence,
      },
      { key: 'nonResidential', label: 'Not a home', value: apart.nonResidential },
    ],
    note: t.counted.unknownUnitBuildings
      ? `${t.counted.unknownUnitBuildings} apartment building(s) counted as one unit each because the number of homes is unknown.`
      : null,
    definition: DEFINITIONS.damage,
    records: t.counted.recordIds.map((id) => {
      const r = byId.get(id)!;
      return { type: r.kind === 'report' ? 'report' : 'field_assessment', id, version: r.version };
    }),
  };
}

async function reportsFact(trx: Transaction<Database>, s: FactScope): Promise<Fact> {
  const r = await sql<{ in_period: string; by_cutoff: string; awaiting: string }>`
    select
      count(*) filter (where submitted_at >= ${s.periodFrom} and submitted_at < ${s.periodTo}) as in_period,
      count(*) as by_cutoff,
      count(*) filter (where withdrawn_at is null and duplicate_of is null
        and review_state in ('submitted', 'under_review', 'needs_information')) as awaiting
    from cg.report
    where event_id = ${s.eventId} and submitted_at <= ${s.cutoff}`.execute(trx);
  const row = r.rows[0]!;
  return {
    key: 'reports',
    title: 'Reports from residents',
    rows: [
      { key: 'inPeriod', label: 'Received in this period', value: Number(row.in_period) },
      { key: 'byCutoff', label: 'Received since the event began', value: Number(row.by_cutoff) },
      { key: 'awaiting', label: 'Awaiting review', value: Number(row.awaiting) },
    ],
    note: null,
    definition: DEFINITIONS.reports,
    records: [],
  };
}

async function outagesFact(trx: Transaction<Database>, s: FactScope): Promise<Fact> {
  const r = await sql<{ kind: string; open: string; over72: string }>`
    select kind, count(*) as open,
      count(*) filter (where ${s.cutoff}::timestamptz - started_at > interval '72 hours') as over72
    from cg.outage
    where event_id = ${s.eventId}
      and started_at <= ${s.cutoff}
      and (restored_at is null or restored_at > ${s.cutoff})
      and (source = 'staff' or confirmed_at is not null)
    group by kind order by kind`.execute(trx);
  const open = r.rows.reduce((n, x) => n + Number(x.open), 0);
  const over = r.rows.reduce((n, x) => n + Number(x.over72), 0);
  return {
    key: 'outages',
    title: 'Outages of critical facilities and services',
    rows: [
      { key: 'open', label: 'Open at the cutoff', value: open },
      { key: 'over72', label: 'Open longer than 72 hours', value: over },
      ...r.rows.map((x) => ({
        key: `open.${x.kind}`,
        label: `Open: ${OUTAGE_LABEL[x.kind] ?? x.kind}`,
        value: Number(x.open),
      })),
    ],
    note: null,
    definition: DEFINITIONS.outages,
    records: [],
  };
}

async function casualtiesFact(trx: Transaction<Database>, s: FactScope): Promise<Fact> {
  const r = await sql<{ kind: string; count: number; official_source: string; as_of: Date }>`
    select distinct on (kind) kind, count, official_source, as_of
    from cg.casualty_count
    where event_id = ${s.eventId} and as_of <= ${s.cutoff}
    order by kind, as_of desc, created_at desc`.execute(trx);
  const of = (k: string) => r.rows.find((x) => x.kind === k);
  return {
    key: 'casualties',
    title: 'Casualties (official counts)',
    rows: (['injured', 'missing', 'deceased'] as const).map((k) => {
      const x = of(k);
      return {
        key: k,
        label: k.charAt(0).toUpperCase() + k.slice(1),
        value: x ? x.count : null,
        ...(x
          ? { detail: `${x.official_source}, as of ${new Date(x.as_of).toISOString()}` }
          : { detail: 'No official count' }),
      };
    }),
    note: null,
    definition: DEFINITIONS.casualties,
    records: [],
  };
}

/** Shelters open now with their reported occupancy and capacity; a total is unknown unless every open shelter gave its figure. */
export async function shelterFigures(trx: Transaction<Database>, eventId: string) {
  const r = await sql<{
    open: string;
    reported: string;
    occupancy: string | null;
    with_capacity: string;
    capacity: string | null;
  }>`
    select count(*) as open,
      count(occupancy) as reported, sum(occupancy) as occupancy,
      count(capacity) as with_capacity, sum(capacity) as capacity
    from cg.site
    where kind = 'shelter' and status in ('open', 'limited', 'full')
      and (event_id = ${eventId} or event_id is null)`.execute(trx);
  const x = r.rows[0]!;
  const open = Number(x.open);
  const reported = Number(x.reported);
  const withCapacity = Number(x.with_capacity);
  return {
    open,
    reported,
    withCapacity,
    occupancyKnown: Number(x.occupancy ?? 0),
    capacityKnown: Number(x.capacity ?? 0),
    occupancy: open > 0 && reported < open ? null : Number(x.occupancy ?? 0),
    capacity: open > 0 && withCapacity < open ? null : Number(x.capacity ?? 0),
  };
}

async function sheltersFact(trx: Transaction<Database>, s: FactScope): Promise<Fact> {
  const f = await shelterFigures(trx, s.eventId);
  const { open, reported, withCapacity } = f;
  return {
    key: 'shelters',
    title: 'Shelters',
    rows: [
      { key: 'open', label: 'Shelters open', value: open },
      {
        key: 'occupancy',
        label: 'People in shelters',
        // All open shelters reported, or the total is not known.
        value: f.occupancy,
        ...(open > 0 && reported < open
          ? {
              detail: `${reported} of ${open} shelters reported; at least ${f.occupancyKnown}`,
            }
          : {}),
      },
      {
        key: 'capacity',
        label: 'Shelter capacity',
        value: f.capacity,
        ...(open > 0 && withCapacity < open
          ? { detail: `${withCapacity} of ${open} shelters gave a capacity` }
          : {}),
      },
    ],
    note: null,
    definition: DEFINITIONS.shelters,
    records: [],
  };
}

/** DCL:DEC-09 (2026-10-15): partner counts, all or as the county chose, with what is included. */
async function partnersFact(trx: Transaction<Database>, s: FactScope): Promise<Fact> {
  const rollup = s.partnerRollup ?? ALL_PARTNERS;
  const view = rollupStatement(rollup, await partnerOrganizations(trx, s.tenantId));
  const { totals } = applyRollup(await partnerCounts(trx, s.tenantId, s.eventId), rollup);
  const has = (k: PartnerCategory) => includesCategory(rollup, k);
  const rows: FactRow[] = [
    ...(has('needs_met')
      ? [{ key: 'needsMet', label: 'Needs met by partners', value: totals.needsMet }]
      : []),
    ...(has('services')
      ? [
          { key: 'meals', label: 'Meals served', value: totals.meals },
          { key: 'waterCases', label: 'Cases of water handed out', value: totals.waterCases },
          { key: 'peopleServed', label: 'People served', value: totals.peopleServed },
        ]
      : []),
    ...(has('sheltered')
      ? [
          {
            key: 'shelteredPeople',
            label: 'People sheltered by partners',
            value: totals.shelteredPeople,
          },
          {
            key: 'shelteredHouseholds',
            label: 'Households sheltered by partners',
            value: totals.shelteredHouseholds,
          },
        ]
      : []),
    ...(has('teams')
      ? [{ key: 'teams', label: 'Partner teams checked in', value: totals.teams }]
      : []),
    {
      key: 'organizations',
      label: 'Partner organizations included',
      value: view.partners.length,
      // The CSV carries rows only: the organizations included go with the figure.
      detail: view.partners.map((o) => o.organization).join('; ') || 'none',
    },
  ];
  return {
    key: 'partners',
    title: 'Partner organizations',
    rows,
    note: view.statement,
    definition: DEFINITIONS.partners,
    records: [],
  };
}

/** Every fact a situation report or briefing states, in report order. */
export async function computeFacts(trx: Transaction<Database>, s: FactScope): Promise<Fact[]> {
  return [
    await damageFact(trx, s),
    await reportsFact(trx, s),
    await outagesFact(trx, s),
    await casualtiesFact(trx, s),
    await sheltersFact(trx, s),
    await partnersFact(trx, s),
  ];
}

const said = (v: number | null | undefined) =>
  v === null || v === undefined ? 'unknown' : v.toLocaleString('en-US');

/** The summary drafted from the facts; a person edits it before review (F15.02). */
export function draftSummary(facts: Fact[], cutoff: Date, timeZone: string): string {
  const row = (f: FactKey, k: string) =>
    facts.find((x) => x.key === f)?.rows.find((r) => r.key === k)?.value;
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(cutoff);
  return [
    `As of ${when}, ${said(row('damage', 'units'))} housing units have verified damage: ${said(row('damage', 'destroyed'))} destroyed, ${said(row('damage', 'major'))} major, ${said(row('damage', 'minor'))} minor and ${said(row('damage', 'affected'))} affected. A further ${said(row('damage', 'selfReported'))} self-reported homes are not yet verified, and ${said(row('damage', 'inaccessible'))} could not be reached.`,
    `${said(row('reports', 'inPeriod'))} reports were received in this period; ${said(row('reports', 'awaiting'))} await review.`,
    `${said(row('outages', 'open'))} outages of critical facilities or services are open, ${said(row('outages', 'over72'))} of them longer than 72 hours.`,
    `Official casualty counts: ${said(row('casualties', 'injured'))} injured, ${said(row('casualties', 'missing'))} missing, ${said(row('casualties', 'deceased'))} deceased.`,
    `${said(row('shelters', 'open'))} shelters are open with ${said(row('shelters', 'occupancy'))} people.`,
  ].join(' ');
}

export interface FactChange {
  fact: FactKey;
  title: string;
  key: string;
  label: string;
  before: number | null;
  after: number | null;
}

/** What changed between two sets of facts (CON-06): every row whose value differs, appears or goes. */
export function compareFacts(before: readonly Fact[], after: readonly Fact[]): FactChange[] {
  const out: FactChange[] = [];
  const keys = [...new Set([...after.map((f) => f.key), ...before.map((f) => f.key)])];
  for (const k of keys) {
    const a = after.find((f) => f.key === k);
    const b = before.find((f) => f.key === k);
    const rows = new Map<string, { label: string; before: number | null; after: number | null }>();
    for (const r of b?.rows ?? [])
      rows.set(r.key, { label: r.label, before: r.value, after: null });
    for (const r of a?.rows ?? [])
      rows.set(r.key, { label: r.label, before: rows.get(r.key)?.before ?? null, after: r.value });
    for (const [key, r] of rows)
      if (r.before !== r.after) out.push({ fact: k, title: (a ?? b)!.title, key, ...r });
  }
  return out;
}

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

export const contentHash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
