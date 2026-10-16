/**
 * Metrics from approved shared definitions (layer-6 task G; BRD:FR-14.01–
 * 14.07, AC-14A/B/C, MET-00, MET-04/05/06/10, Section 19, BRD:DEC-15).
 *
 * Every metric has a definition: what it counts, in words, with the
 * parameters it uses, shipped as version 1. A county publishes its own
 * version through the governed definitions (key `metric.<key>`); the value
 * then names "county version n" and the text and parameters it used. One
 * computation feeds the screen, the CSV and the PDF, so they cannot
 * disagree (AC-14C, MET-06); each output names its scope, the time it was
 * made, the definitions and what was left out (FR-14.05). Damage figures
 * come from the counting rule (verified apart from unverified, FR-14.03,
 * AC-14B). Response times disclose the records missing a milestone instead
 * of guessing (FR-14.07). Nothing personal is ever in a metric.
 */
import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import type { Block, PdfDocumentModel } from '@cg/pdf';
import { DEGREES, countDamage, type Degree } from './counting.ts';
import { toCsv } from './csv.ts';
import { loadDamageRecords } from './load.ts';
import { actions, type ActionMeta } from '@cg/authz';

type Trx = Transaction<Database>;

export type MetricGroup =
  | 'damage'
  | 'reports'
  | 'missions'
  | 'personnel'
  | 'badges'
  | 'needs'
  | 'information'
  | 'ai'
  | 'accountability';

export interface MetricDefinition {
  key: string;
  group: MetricGroup;
  title: string;
  unit: string;
  text: string;
  params: Record<string, unknown>;
  /** Requirement IDs the metric answers. */
  requirements: string[];
}

export const GROUP_TITLE: Record<MetricGroup, string> = {
  damage: 'Damage',
  reports: 'Resident reports and review',
  missions: 'Missions',
  personnel: 'Personnel',
  badges: 'Badges',
  needs: 'Help for residents',
  information: 'Recovery information',
  ai: 'Computer help (AI)',
  accountability: 'Privacy and accountability',
};

const d = (def: MetricDefinition) => def;

/**
 * MET-10: the audit actions that are confirmed decisions. The platform demands a reason for each
 * before it acts (ADM-05), so a record of one without a reason is an incomplete record.
 */
const CONFIRMED_DECISIONS: string[] = Object.entries(actions as Record<string, ActionMeta>)
  .filter(([, meta]) => meta.consequential === true)
  .map(([key]) => key);

/** Shipped version 1 of each metric. */
export const METRICS = {
  'damage.units': d({
    key: 'damage.units',
    group: 'damage',
    title: 'Housing units with verified damage',
    unit: 'housing units',
    text: 'The counting rule as of the end of the period: approved, desktop- or field-verified damage to primary residences, one home once, by degree (affected, minor, major, destroyed). Unverified, unreachable, witness, pre-existing and non-primary records are shown apart and never added.',
    params: {},
    requirements: ['BRD:FR-14.03', 'AC-14B', 'DCL:DEC-03'],
  }),
  'reports.received': d({
    key: 'reports.received',
    group: 'reports',
    title: 'Reports received',
    unit: 'reports',
    text: 'Resident reports submitted in the period, by the channel they came in on.',
    params: {},
    requirements: ['BRD:FR-14.01', 'BRD:FR-14.04'],
  }),
  'reports.time_to_review': d({
    key: 'reports.time_to_review',
    group: 'reports',
    title: 'Median time to first review',
    unit: 'hours',
    text: 'For reports submitted in the period: hours from submission to the first review decision, median. Reports with no decision yet are disclosed, not counted. Section 19 target: within 24 hours.',
    params: { targetHours: 24 },
    requirements: ['MET-05', 'BRD:FR-14.07', 'Section 19'],
  }),
  'reports.duplicates': d({
    key: 'reports.duplicates',
    group: 'reports',
    title: 'Reports merged as duplicates',
    unit: 'reports',
    text: 'Reports submitted in the period that a reviewer marked as a duplicate or superseded by another.',
    params: {},
    requirements: ['MET-05'],
  }),
  'reports.re_review': d({
    key: 'reports.re_review',
    group: 'reports',
    title: 'Reports reviewed more than once',
    unit: 'reports',
    text: 'Reports submitted in the period with two or more review decisions.',
    params: {},
    requirements: ['MET-05'],
  }),
  'reports.completeness': d({
    key: 'reports.completeness',
    group: 'reports',
    title: 'Approved reports with degree, occupancy and insurance known',
    unit: 'percent',
    text: 'Of the approved resident reports submitted in the period: the share whose degree of damage is set and whose occupancy (owner or renter) and insurance are known.',
    params: {},
    requirements: ['MET-05'],
  }),
  'missions.by_state': d({
    key: 'missions.by_state',
    group: 'missions',
    title: 'Missions by state',
    unit: 'missions',
    text: 'Missions of the event created by the end of the period, by their state now.',
    params: {},
    requirements: ['BRD:FR-14.01', 'MET-04'],
  }),
  'missions.closed': d({
    key: 'missions.closed',
    group: 'missions',
    title: 'Missions closed',
    unit: 'missions',
    text: 'Missions closed in the period: in a closed state with a disposition recorded. Cleared missions are not closed; an imported mission marked closed without a disposition is disclosed, not counted.',
    params: { closedStates: ['closed'], requireDisposition: true },
    requirements: ['AC-14A', 'BRD:FR-14.01'],
  }),
  'missions.time_to_close': d({
    key: 'missions.time_to_close',
    group: 'missions',
    title: 'Median time from mission created to closed',
    unit: 'hours',
    text: 'For missions closed in the period (as defined for missions closed): hours from creation to closing, median.',
    params: {},
    requirements: ['MET-04', 'BRD:FR-14.07'],
  }),
  'missions.overdue': d({
    key: 'missions.overdue',
    group: 'missions',
    title: 'Overdue updates',
    unit: 'alerts',
    text: 'Safety alerts raised in the period because a team missed its check-in or did not acknowledge an assignment in time, with the median minutes to acknowledge those that were.',
    params: {},
    requirements: ['MET-04', 'DSP-07'],
  }),
  'missions.conflicts': d({
    key: 'missions.conflicts',
    group: 'missions',
    title: 'Assignments made over a conflict',
    unit: 'assignments',
    text: 'Assignments made in the period although the board warned of a conflict (double booking, missing credential, off duty and the like), each with the reason given; by kind of conflict.',
    params: {},
    requirements: ['MET-04', 'RULE-06'],
  }),
  'personnel.utilization': d({
    key: 'personnel.utilization',
    group: 'personnel',
    title: 'Team utilization',
    unit: 'percent',
    text: "Of the hours teams were on duty in the period (their members' check-ins merged), the share they were on an assignment, by department or organization. People checked in without a team are left out and disclosed.",
    params: {},
    requirements: ['BRD:FR-14.04'],
  }),
  'personnel.checked_in': d({
    key: 'personnel.checked_in',
    group: 'personnel',
    title: 'People checked in',
    unit: 'people',
    text: 'People with a check-in to the event during the period, by the department or organization they came with.',
    params: {},
    requirements: ['BRD:FR-14.01', 'BRD:FR-14.04'],
  }),
  'personnel.hours': d({
    key: 'personnel.hours',
    group: 'personnel',
    title: 'Hours worked',
    unit: 'hours',
    text: 'Hours checked in during the period (the part of each shift inside it), by department or organization. Shifts still open count to the end of the period or now, whichever is earlier, and are disclosed.',
    params: {},
    requirements: ['BRD:FR-14.04'],
  }),
  'badges.by_state': d({
    key: 'badges.by_state',
    group: 'badges',
    title: 'Badges by state',
    unit: 'badges',
    text: 'Badges for the event made by the end of the period, by their state now.',
    params: {},
    requirements: ['BRD:FR-14.01'],
  }),
  'needs.opened': d({
    key: 'needs.opened',
    group: 'needs',
    title: 'Needs recorded',
    unit: 'needs',
    text: 'Needs recorded in the period, by category.',
    params: {},
    requirements: ['BRD:FR-14.01'],
  }),
  'needs.time_to_help': d({
    key: 'needs.time_to_help',
    group: 'needs',
    title: 'Median time to help',
    unit: 'hours',
    text: 'For needs met in the period: hours from the need being recorded to it being met, median. Needs recorded in the period and not met yet are disclosed.',
    params: {},
    requirements: ['BRD:FR-14.07', 'EQ-12'],
  }),
  'resources.current': d({
    key: 'resources.current',
    group: 'information',
    title: 'Recovery information still current',
    unit: 'percent',
    text: 'Published help and program pages whose review date has not passed, as a share of all published pages. Pages as they stand now: their history is not kept.',
    params: {},
    requirements: ['MET-07', 'BRD:FR-16.03'],
  }),
  'resources.broken_links': d({
    key: 'resources.broken_links',
    group: 'information',
    title: 'Broken outside links',
    unit: 'percent',
    text: 'Published pages with an outside link whose last daily check found it broken, as a share of published pages with an outside link. Links not checked yet are disclosed.',
    params: {},
    requirements: ['MET-07', 'BRD:FR-16.03'],
  }),
  'accountability.denied': d({
    key: 'accountability.denied',
    group: 'accountability',
    title: 'Refused attempts',
    unit: 'refusals',
    text: 'Requests the platform refused for lack of permission or a guardrail in the period, from the audit log.',
    params: {},
    requirements: ['MET-10'],
  }),
  'accountability.audit_complete': d({
    key: 'accountability.audit_complete',
    group: 'accountability',
    title: 'Audit records that name who acted and why',
    unit: 'percent',
    text: 'Of the audit records written in the period, the share that name the person who acted (or the system job, or the resident) and give a reason wherever a decision needed one. Also shows how long ago the audit chain was last verified and anchored.',
    params: {},
    requirements: ['MET-10', 'SEC-11'],
  }),
  'ai.outcomes': d({
    key: 'ai.outcomes',
    group: 'ai',
    title: 'AI drafts and suggestions taken as they were',
    unit: 'percent',
    text: 'Of the AI drafts and suggestions people acted on in the period, the share taken without change. Also counts calls that failed or timed out (the manual path ran instead), those the safety filters held back, corrections and rejections, residents saying the help was wrong, and the command window asking to clarify or failing to carry a command out. Counts only: no words, no people.',
    params: {},
    requirements: ['MET-09', 'AIG-09'],
  }),
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export interface DefinitionInUse {
  key: string;
  version: number;
  source: 'shipped' | 'county';
  text: string;
  params: Record<string, unknown>;
}

export interface MetricPart {
  key: string;
  label: string;
  value: number | null;
}

export interface MetricValue {
  key: MetricKey;
  group: MetricGroup;
  title: string;
  unit: string;
  value: number | null;
  parts: MetricPart[];
  /** Records left out because a milestone is missing (FR-14.07), in words. */
  incomplete: { count: number; note: string } | null;
  definition: DefinitionInUse;
}

export interface MetricFilters {
  missionKind?: string;
  priority?: string;
  /** A mission state (BRD:FR-14.02 "status"). */
  missionState?: string;
  /** A department or organization: the mission's owner or the check-in's agency. */
  department?: string;
  degree?: Degree;
}

export interface MetricScope {
  eventId: string;
  from: Date;
  to: Date;
  timeZone: string;
  filters: MetricFilters;
}

export interface TrendSeries {
  key: string;
  title: string;
  values: number[];
}

export interface MetricsResult {
  scope: { eventId: string; from: string; to: string; timeZone: string; filters: MetricFilters };
  generatedAt: string;
  metrics: MetricValue[];
  trends: { periods: { from: string; to: string; label: string }[]; series: TrendSeries[] };
  /** What every figure leaves out, in words (FR-14.05). */
  exclusions: string[];
}

/** The longest period one request may cover (FR-14.02: bounded). */
export const MAX_PERIOD_DAYS = 92;

const HOUR = 3_600_000;

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const v = s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  return Math.round(v * 10) / 10;
}

/** The offset (ms) of `timeZone` from UTC at an instant. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - (instant - (instant % 1000));
}

/** The instant a local wall-clock time occurs in `timeZone`. */
export function zonedTime(y: number, m: number, day: number, h: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, day, h);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone);
  return new Date(t);
}

/**
 * Operational periods between two instants: starting at the local hours
 * given (BRD:DEC-15 default 07:00 and 19:00), clipped to the range.
 */
export function operationalPeriods(
  from: Date,
  to: Date,
  timeZone: string,
  startHours: readonly number[] = [7, 19],
): { from: Date; to: Date }[] {
  const local = (t: Date) => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(t);
    const [y, m, dd] = p.split('-').map(Number) as [number, number, number];
    return { y, m, d: dd };
  };
  const a = local(from);
  const days = Math.ceil((to.getTime() - from.getTime()) / (24 * HOUR)) + 2;
  const bounds: number[] = [];
  for (let i = -1; i <= days; i++) {
    const day = new Date(Date.UTC(a.y, a.m - 1, a.d + i));
    for (const h of startHours)
      bounds.push(
        zonedTime(
          day.getUTCFullYear(),
          day.getUTCMonth() + 1,
          day.getUTCDate(),
          h,
          timeZone,
        ).getTime(),
      );
  }
  const inside = [...new Set(bounds)]
    .filter((b) => b > from.getTime() && b < to.getTime())
    .sort((x, y) => x - y);
  const edges = [from.getTime(), ...inside, to.getTime()];
  return edges.slice(0, -1).map((e, i) => ({ from: new Date(e), to: new Date(edges[i + 1]!) }));
}

/** Each metric's definition in use: the county's latest version, or the shipped one. */
export async function definitionsInUse(
  trx: Trx,
  tenantId: string,
): Promise<Record<MetricKey, DefinitionInUse>> {
  const rows = await sql<{ key: string; version: number; value: unknown }>`
    select key, version, value from cg.governed_definition_current
    where tenant_id = ${tenantId}::uuid and key like 'metric.%'`.execute(trx);
  const out = {} as Record<MetricKey, DefinitionInUse>;
  for (const k of METRIC_KEYS) {
    const shipped = METRICS[k];
    const row = rows.rows.find((r) => r.key === `metric.${k}`);
    const v = (row?.value ?? null) as { text?: unknown; params?: unknown } | null;
    out[k] = row
      ? {
          key: k,
          version: row.version,
          source: 'county',
          text: typeof v?.text === 'string' && v.text.trim() ? v.text : shipped.text,
          params: {
            ...shipped.params,
            ...(v?.params && typeof v.params === 'object' ? (v.params as object) : {}),
          },
        }
      : { key: k, version: 1, source: 'shipped', text: shipped.text, params: shipped.params };
  }
  return out;
}

const DEGREE_LABEL: Record<Degree, string> = {
  affected: 'Affected',
  minor: 'Minor',
  major: 'Major',
  destroyed: 'Destroyed',
};
const label = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' ');
const parts = (rows: { k: string | null; n: number | string }[], none = 'Unknown'): MetricPart[] =>
  rows.map((r) => ({ key: r.k ?? 'unknown', label: r.k ? label(r.k) : none, value: Number(r.n) }));

/** Computes every metric for one scope. */
export async function computeMetrics(
  trx: Trx,
  tenantId: string,
  scope: MetricScope,
  now = new Date(),
): Promise<MetricsResult> {
  const defs = await definitionsInUse(trx, tenantId);
  const { eventId, from, to, filters } = scope;
  const end = to.getTime() < now.getTime() ? to : now;
  const value = (
    key: MetricKey,
    v: number | null,
    ps: MetricPart[] = [],
    incomplete: MetricValue['incomplete'] = null,
  ): MetricValue => ({
    key,
    group: METRICS[key].group,
    title: METRICS[key].title,
    unit: METRICS[key].unit,
    value: v,
    parts: ps,
    incomplete,
    definition: defs[key],
  });
  const out: MetricValue[] = [];

  // ---------------------------------------------------------------- damage (counting rule)
  const records = await loadDamageRecords(trx, eventId, { cutoff: to });
  const damage = countDamage(records);
  const degrees = filters.degree ? [filters.degree] : [...DEGREES];
  out.push(
    value(
      'damage.units',
      degrees.reduce((n, g) => n + damage.counted.byDegree[g], 0),
      [
        ...degrees.map((g) => ({
          key: g,
          label: DEGREE_LABEL[g],
          value: damage.counted.byDegree[g],
        })),
        {
          key: 'shown_apart_self_reported',
          label: 'Shown apart: self-reported',
          value: damage.shownSeparately.selfReported,
        },
        {
          key: 'shown_apart_awaiting_review',
          label: 'Shown apart: awaiting review',
          value: damage.shownSeparately.awaitingReview,
        },
        {
          key: 'shown_apart_inaccessible',
          label: 'Shown apart: could not be reached',
          value: damage.shownSeparately.inaccessible.total,
        },
      ],
    ),
  );

  // ---------------------------------------------------------------- reports
  const reportsIn = sql`r.event_id = ${eventId}::uuid and r.submitted_at >= ${from} and r.submitted_at < ${to}`;
  const byChannel = await sql<{ k: string; n: string }>`
    select r.channel_of_origin as k, count(*) as n from cg.report r where ${reportsIn}
    group by 1 order by 1`.execute(trx);
  out.push(
    value(
      'reports.received',
      byChannel.rows.reduce((n, r) => n + Number(r.n), 0),
      parts(byChannel.rows),
    ),
  );
  const review = await sql<{ hours: number | null }>`
    select extract(epoch from (
      (select min(d.created_at) from cg.review_decision d where d.report_id = r.id) - r.submitted_at
    )) / 3600 as hours
    from cg.report r where ${reportsIn}`.execute(trx);
  const decided = review.rows.filter((r) => r.hours !== null).map((r) => Number(r.hours));
  const target = Number(defs['reports.time_to_review'].params['targetHours'] ?? 24);
  const waiting = review.rows.length - decided.length;
  out.push(
    value(
      'reports.time_to_review',
      median(decided),
      [
        { key: 'reviewed', label: 'Reviewed', value: decided.length },
        {
          key: 'within_target',
          label: `Reviewed within ${target} hours`,
          value: decided.filter((h) => h <= target).length,
        },
      ],
      waiting ? { count: waiting, note: 'reports with no review decision yet' } : null,
    ),
  );
  const dup = await sql<{ n: string }>`
    select count(*) as n from cg.report r
    where ${reportsIn} and (r.review_state in ('duplicate', 'superseded') or r.duplicate_of is not null)`.execute(
    trx,
  );
  out.push(value('reports.duplicates', Number(dup.rows[0]?.n ?? 0)));
  const rer = await sql<{ n: string }>`
    select count(*) as n from cg.report r
    where ${reportsIn} and (select count(*) from cg.review_decision d where d.report_id = r.id) > 1`.execute(
    trx,
  );
  out.push(value('reports.re_review', Number(rer.rows[0]?.n ?? 0)));
  const approved = records.filter(
    (r) =>
      r.kind === 'report' &&
      r.reviewState === 'approved' &&
      r.at >= from.toISOString() &&
      r.at < to.toISOString(),
  );
  const missingDegree = approved.filter((r) => r.degree === null).length;
  const unknownTenure = approved.filter((r) => r.tenure === 'unknown').length;
  const unknownInsurance = approved.filter((r) => r.insurance === 'unknown').length;
  const complete = approved.filter(
    (r) => r.degree !== null && r.tenure !== 'unknown' && r.insurance !== 'unknown',
  ).length;
  out.push(
    value(
      'reports.completeness',
      approved.length ? Math.round((complete / approved.length) * 1000) / 10 : null,
      [
        { key: 'approved', label: 'Approved reports', value: approved.length },
        { key: 'complete', label: 'Complete', value: complete },
        { key: 'degree_missing', label: 'Degree not set', value: missingDegree },
        { key: 'tenure_unknown', label: 'Occupancy unknown', value: unknownTenure },
        { key: 'insurance_unknown', label: 'Insurance unknown', value: unknownInsurance },
      ],
    ),
  );

  // ---------------------------------------------------------------- missions
  const missionWhere = sql`m.event_id = ${eventId}::uuid
    ${filters.missionKind ? sql`and m.kind = ${filters.missionKind}` : sql``}
    ${filters.priority ? sql`and m.priority = ${filters.priority}` : sql``}
    ${filters.missionState ? sql`and m.state = ${filters.missionState}` : sql``}
    ${filters.department ? sql`and coalesce(m.owning_tenant_id, m.tenant_id) = ${filters.department}::uuid` : sql``}`;
  const byState = await sql<{ k: string; n: string }>`
    select m.state as k, count(*) as n from cg.mission m
    where ${missionWhere} and m.created_at < ${to} group by 1 order by 1`.execute(trx);
  out.push(
    value(
      'missions.by_state',
      byState.rows.reduce((n, r) => n + Number(r.n), 0),
      parts(byState.rows),
    ),
  );
  const closedDef = defs['missions.closed'].params;
  const closedStates = Array.isArray(closedDef['closedStates'])
    ? (closedDef['closedStates'] as string[])
    : ['closed'];
  const needDisposition = closedDef['requireDisposition'] !== false;
  const closed = await sql<{ hours: number | null; disposition: string | null }>`
    select extract(epoch from (coalesce(m.closed_at, m.cleared_at) - m.created_at)) / 3600 as hours,
      m.disposition
    from cg.mission m
    where ${missionWhere} and m.state = any(${closedStates}::text[])
      and coalesce(m.closed_at, m.cleared_at) >= ${from}
      and coalesce(m.closed_at, m.cleared_at) < ${to}`.execute(trx);
  const counted = closed.rows.filter((r) => !needDisposition || r.disposition !== null);
  const noDisposition = closed.rows.length - counted.length;
  const byDisposition = new Map<string, number>();
  for (const r of counted)
    byDisposition.set(
      r.disposition ?? 'none',
      (byDisposition.get(r.disposition ?? 'none') ?? 0) + 1,
    );
  out.push(
    value(
      'missions.closed',
      counted.length,
      [...byDisposition].map(([k, n]) => ({ key: k, label: label(k), value: n })),
      noDisposition
        ? { count: noDisposition, note: 'missions closed without a disposition' }
        : null,
    ),
  );
  out.push(
    value(
      'missions.time_to_close',
      median(counted.filter((r) => r.hours !== null).map((r) => Number(r.hours))),
      [{ key: 'closed', label: 'Missions closed', value: counted.length }],
    ),
  );

  // MET-04: overdue updates (DSP-07); department filters do not apply to safety alerts.
  const overdue = await sql<{ kind: string; minutes: number | null }>`
    select a.kind, extract(epoch from (a.acknowledged_at - a.raised_at)) / 60 as minutes
    from cg.safety_alert a
    where a.event_id = ${eventId}::uuid
      and a.kind in ('missed_check_in', 'unacknowledged_assignment')
      and a.raised_at >= ${from} and a.raised_at < ${to}`.execute(trx);
  const acked = overdue.rows.filter((r) => r.minutes !== null).map((r) => Number(r.minutes));
  out.push(
    value(
      'missions.overdue',
      overdue.rows.length,
      [
        {
          key: 'missed_check_in',
          label: 'Missed check-ins',
          value: overdue.rows.filter((r) => r.kind === 'missed_check_in').length,
        },
        {
          key: 'unacknowledged_assignment',
          label: 'Assignments not acknowledged in time',
          value: overdue.rows.filter((r) => r.kind === 'unacknowledged_assignment').length,
        },
        {
          key: 'median_minutes_to_acknowledge',
          label: 'Median minutes to acknowledge',
          value: median(acked),
        },
      ],
      overdue.rows.length - acked.length
        ? { count: overdue.rows.length - acked.length, note: 'alerts not acknowledged yet' }
        : null,
    ),
  );

  // MET-04: assignments made over a conflict the board warned of.
  const conflicts = await sql<{ k: string; n: string }>`
    select coalesce(c->>'kind', 'other') as k, count(distinct a.id) as n
    from cg.assignment a
    join cg.mission m on m.id = a.mission_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(a.conflicts) = 'array' then a.conflicts else '[]'::jsonb end) c
    where ${missionWhere} and a.assigned_at >= ${from} and a.assigned_at < ${to}
    group by 1 order by 2 desc`.execute(trx);
  const conflicted = await sql<{ n: string }>`
    select count(*) as n from cg.assignment a join cg.mission m on m.id = a.mission_id
    where ${missionWhere} and a.assigned_at >= ${from} and a.assigned_at < ${to}
      and jsonb_typeof(a.conflicts) = 'array' and jsonb_array_length(a.conflicts) > 0`.execute(trx);
  out.push(value('missions.conflicts', Number(conflicted.rows[0]?.n ?? 0), parts(conflicts.rows)));

  // ---------------------------------------------------------------- personnel
  const shifts = await sql<{
    dept: string | null;
    personnel_id: string;
    hours: number;
    open: boolean;
  }>`
    select coalesce(t.name, 'County staff') as dept, c.personnel_id,
      greatest(0, extract(epoch from (
        least(coalesce(c.ended_at, ${end}), ${to}) - greatest(c.started_at, ${from})
      )) / 3600) as hours,
      c.ended_at is null as open
    from cg.check_in c
    left join cg.tenant t on t.id = c.agency_tenant_id
    where c.event_id = ${eventId}::uuid and c.started_at < ${to}
      and (c.ended_at is null or c.ended_at > ${from})
      ${filters.department ? sql`and coalesce(c.agency_tenant_id, c.tenant_id) = ${filters.department}::uuid` : sql``}`.execute(
    trx,
  );
  const depts = new Map<string, { people: Set<string>; hours: number }>();
  for (const s of shifts.rows) {
    const k = s.dept ?? 'County staff';
    const e = depts.get(k) ?? { people: new Set<string>(), hours: 0 };
    e.people.add(s.personnel_id);
    e.hours += Number(s.hours);
    depts.set(k, e);
  }
  const people = new Set(shifts.rows.map((s) => s.personnel_id));
  const openShifts = shifts.rows.filter((s) => s.open).length;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  // FR-14.04: utilization, the share of each team's time on duty spent on an assignment.
  const util = await sql<{ dept: string; duty: string; busy: string }>`
    with duty as (
      select c.team_id,
        range_agg(tstzrange(greatest(c.started_at, ${from}), least(coalesce(c.ended_at, ${end}), ${to}))) as r
      from cg.check_in c
      where c.event_id = ${eventId}::uuid and c.team_id is not null
        and c.started_at < ${to} and coalesce(c.ended_at, ${end}) > ${from}
      group by c.team_id
    ), work as (
      select a.team_id,
        range_agg(tstzrange(greatest(a.assigned_at, ${from}),
          least(coalesce(a.released_at, a.cleared_at, ${end}), ${to}))) as r
      from cg.assignment a join cg.mission m on m.id = a.mission_id
      where m.event_id = ${eventId}::uuid and a.team_id is not null and a.state <> 'declined'
        and a.assigned_at < ${to} and coalesce(a.released_at, a.cleared_at, ${end}) > ${from}
      group by a.team_id
    )
    select coalesce(t.name, 'County staff') as dept,
      sum((select coalesce(sum(extract(epoch from upper(x) - lower(x))), 0) from unnest(d.r) x)) as duty,
      sum((select coalesce(sum(extract(epoch from upper(x) - lower(x))), 0)
        from unnest(d.r * coalesce(w.r, '{}'::tstzmultirange)) x)) as busy
    from duty d
    join cg.team tm on tm.id = d.team_id
    left join work w on w.team_id = d.team_id
    left join cg.tenant t on t.id = tm.agency_tenant_id
    ${filters.department ? sql`where coalesce(tm.agency_tenant_id, tm.tenant_id) = ${filters.department}::uuid` : sql``}
    group by 1 order by 1`.execute(trx);
  const pctOf = (busy: number, duty: number) =>
    duty > 0 ? Math.round((busy / duty) * 1000) / 10 : null;
  const dutyAll = util.rows.reduce((n, r) => n + Number(r.duty), 0);
  const busyAll = util.rows.reduce((n, r) => n + Number(r.busy), 0);
  const noTeam = await sql<{ n: string }>`
    select count(distinct c.personnel_id) as n from cg.check_in c
    where c.event_id = ${eventId}::uuid and c.team_id is null
      and c.started_at < ${to} and coalesce(c.ended_at, ${end}) > ${from}`.execute(trx);
  const loose = Number(noTeam.rows[0]?.n ?? 0);
  out.push(
    value(
      'personnel.utilization',
      pctOf(busyAll, dutyAll),
      util.rows.map((r) => ({
        key: r.dept,
        label: r.dept,
        value: pctOf(Number(r.busy), Number(r.duty)),
      })),
      loose ? { count: loose, note: 'people checked in without a team' } : null,
    ),
  );
  out.push(
    value(
      'personnel.checked_in',
      people.size,
      [...depts].map(([k, e]) => ({ key: k, label: k, value: e.people.size })),
    ),
  );
  out.push(
    value(
      'personnel.hours',
      round1(shifts.rows.reduce((n, s) => n + Number(s.hours), 0)),
      [...depts].map(([k, e]) => ({ key: k, label: k, value: round1(e.hours) })),
      openShifts
        ? { count: openShifts, note: 'shifts still open, counted to the end of the period or now' }
        : null,
    ),
  );

  // ---------------------------------------------------------------- badges
  const badges = await sql<{ k: string; n: string }>`
    select b.state as k, count(*) as n from cg.badge b
    where b.event_id = ${eventId}::uuid and b.created_at < ${to} group by 1 order by 1`.execute(
    trx,
  );
  out.push(
    value(
      'badges.by_state',
      badges.rows.reduce((n, r) => n + Number(r.n), 0),
      parts(badges.rows),
    ),
  );

  // ---------------------------------------------------------------- needs
  const opened = await sql<{ k: string; n: string }>`
    select n.category as k, count(*) as n from cg.need n
    where n.event_id = ${eventId}::uuid and n.created_at >= ${from} and n.created_at < ${to}
    group by 1 order by 1`.execute(trx);
  out.push(
    value(
      'needs.opened',
      opened.rows.reduce((n, r) => n + Number(r.n), 0),
      parts(opened.rows),
    ),
  );
  const help = await sql<{ hours: number }>`
    select extract(epoch from (n.done_at - n.created_at)) / 3600 as hours from cg.need n
    where n.event_id = ${eventId}::uuid and n.status in ('met', 'closed')
      and n.done_at >= ${from} and n.done_at < ${to}`.execute(trx);
  const notMet = await sql<{ n: string }>`
    select count(*) as n from cg.need n
    where n.event_id = ${eventId}::uuid and n.created_at >= ${from} and n.created_at < ${to}
      and n.status not in ('met', 'closed', 'withdrawn')`.execute(trx);
  const pending = Number(notMet.rows[0]?.n ?? 0);
  out.push(
    value(
      'needs.time_to_help',
      median(help.rows.map((r) => Number(r.hours))),
      [{ key: 'met', label: 'Needs met', value: help.rows.length }],
      pending ? { count: pending, note: 'needs recorded in the period and not met yet' } : null,
    ),
  );

  // ---------------------------------------------------------------- recovery information (MET-07)
  const pages = (
    await sql<{
      published: string;
      stale: string;
      undated: string;
      linked: string;
      broken: string;
      unchecked: string;
    }>`
      select count(*) as published,
        count(*) filter (where review_at is not null and review_at < ${end}) as stale,
        count(*) filter (where review_at is null) as undated,
        count(*) filter (where reference_url is not null) as linked,
        count(*) filter (where reference_url is not null and link_status = 'broken') as broken,
        count(*) filter (where reference_url is not null and link_status = 'unchecked') as unchecked
      from cg.resource
      where tenant_id = ${tenantId}::uuid and status = 'published'
        and (expires_at is null or expires_at > ${end})`.execute(trx)
  ).rows[0]!;
  const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : null);
  const published = Number(pages.published);
  const stale = Number(pages.stale);
  out.push(
    value('resources.current', share(published - stale, published), [
      { key: 'published', label: 'Published pages', value: published },
      { key: 'review_passed', label: 'Review date passed', value: stale },
      { key: 'no_review_date', label: 'No review date', value: Number(pages.undated) },
    ]),
  );
  const linked = Number(pages.linked);
  const unchecked = Number(pages.unchecked);
  out.push(
    value(
      'resources.broken_links',
      share(Number(pages.broken), linked - unchecked),
      [
        { key: 'with_link', label: 'Pages with an outside link', value: linked },
        { key: 'broken', label: 'Broken at the last check', value: Number(pages.broken) },
      ],
      unchecked ? { count: unchecked, note: 'links not checked yet' } : null,
    ),
  );

  // ---------------------------------------------------------------- accountability
  const denied = await sql<{ k: string; n: string }>`
    select a.target_type as k, count(*) as n from cg.audit_event a
    where a.tenant_id = ${tenantId}::uuid and a.action = 'authz.deny'
      and a.occurred_at >= ${from} and a.occurred_at < ${to} group by 1 order by 2 desc limit 12`.execute(
    trx,
  );
  out.push(
    value(
      'accountability.denied',
      denied.rows.reduce((n, r) => n + Number(r.n), 0),
      parts(denied.rows),
    ),
  );

  // MET-10: an account's record must name the account; a confirmed decision must carry its reason.
  const audit = (
    await sql<{ total: string; no_actor: string; decisions: string; no_reason: string }>`
      select count(*) as total,
        count(*) filter (where a.actor_kind in ('account', 'break_glass')
          and a.actor_account_id is null) as no_actor,
        count(*) filter (where a.action = any(${CONFIRMED_DECISIONS}::text[])) as decisions,
        count(*) filter (where a.action = any(${CONFIRMED_DECISIONS}::text[])
          and coalesce(btrim(a.reason), '') = '') as no_reason
      from cg.audit_event a
      where a.tenant_id = ${tenantId}::uuid and a.occurred_at >= ${from} and a.occurred_at < ${to}`.execute(
      trx,
    )
  ).rows[0]!;
  const anchor = (
    await sql<{ at: Date | null }>`
      select max(anchored_at) as at from cg.audit_anchor where tenant_id = ${tenantId}::uuid`.execute(
      trx,
    )
  ).rows[0]!;
  const auditRecords = Number(audit.total);
  const lacking = Number(audit.no_actor) + Number(audit.no_reason);
  out.push(
    value('accountability.audit_complete', share(auditRecords - lacking, auditRecords), [
      { key: 'records', label: 'Audit records', value: auditRecords },
      { key: 'no_actor', label: 'Without the person who acted', value: Number(audit.no_actor) },
      { key: 'decisions', label: 'Confirmed decisions', value: Number(audit.decisions) },
      { key: 'no_reason', label: 'Decisions without a reason', value: Number(audit.no_reason) },
      {
        key: 'hours_since_anchor',
        label: 'Hours since the chain was last verified and anchored',
        value: anchor.at
          ? Math.round((now.getTime() - new Date(anchor.at).getTime()) / 360_000) / 10
          : null,
      },
    ]),
  );

  // MET-09: what people did with the AI's help, and how often it was not there.
  const ai = (
    await sql<{
      calls: string;
      failed: string;
      held: string;
      accepted: string;
      edited: string;
      rejected: string;
      wrong: string;
    }>`
      select count(*) as calls,
        count(*) filter (where outcome in ('timeout', 'error', 'invalid')) as failed,
        count(*) filter (where outcome in ('filtered', 'refused')) as held,
        count(*) filter (where human_action = 'accepted') as accepted,
        count(*) filter (where human_action = 'edited') as edited,
        count(*) filter (where human_action = 'rejected') as rejected,
        count(*) filter (where complaint = 'wrong') as wrong
      from cg.ai_output
      where tenant_id = ${tenantId}::uuid and created_at >= ${from} and created_at < ${to}`.execute(
      trx,
    )
  ).rows[0]!;
  const commands = (
    await sql<{ answers: string; clarify: string; failed: string }>`
      select coalesce(sum(n), 0) as answers,
        coalesce(sum(n) filter (where outcome = 'clarify'), 0) as clarify,
        coalesce(sum(n) filter (where outcome = 'failed'), 0) as failed
      from cg.command_outcome
      where tenant_id = ${tenantId}::uuid
        and day >= (${from}::timestamptz at time zone 'utc')::date
        and day <= (${to}::timestamptz at time zone 'utc')::date`.execute(trx)
  ).rows[0]!;
  const actedOn = Number(ai.accepted) + Number(ai.edited) + Number(ai.rejected);
  out.push(
    value('ai.outcomes', share(Number(ai.accepted), actedOn), [
      { key: 'calls', label: 'AI calls', value: Number(ai.calls) },
      { key: 'failed', label: 'Failed or timed out (manual path used)', value: Number(ai.failed) },
      { key: 'held', label: 'Held back by the safety filters', value: Number(ai.held) },
      { key: 'accepted', label: 'Taken as they were', value: Number(ai.accepted) },
      { key: 'edited', label: 'Corrected by a person', value: Number(ai.edited) },
      { key: 'rejected', label: 'Rejected by a person', value: Number(ai.rejected) },
      { key: 'wrong', label: 'Residents who said it was wrong', value: Number(ai.wrong) },
      { key: 'commands', label: 'Command window answers', value: Number(commands.answers) },
      { key: 'clarify', label: 'Command window asked to clarify', value: Number(commands.clarify) },
      {
        key: 'command_failed',
        label: 'Commands that failed to carry out',
        value: Number(commands.failed),
      },
    ]),
  );

  // ---------------------------------------------------------------- trends (FR-14.04)
  const periods = operationalPeriods(from, to, scope.timeZone).slice(-62);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: scope.timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
  });
  const bucket = async (q: RawBuilder<{ at: Date }>) => {
    const rows = (await q.execute(trx)).rows.map((r) => new Date(r.at).getTime());
    return periods.map(
      (p) => rows.filter((t) => t >= p.from.getTime() && t < p.to.getTime()).length,
    );
  };
  const series: TrendSeries[] = [
    {
      key: 'reports.received',
      title: 'Reports received',
      values: await bucket(
        sql<{ at: Date }>`select r.submitted_at as at from cg.report r where ${reportsIn}`,
      ),
    },
    {
      key: 'reports.reviewed',
      title: 'Review decisions',
      values: await bucket(sql<{ at: Date }>`
        select d.created_at as at from cg.review_decision d join cg.report r on r.id = d.report_id
        where r.event_id = ${eventId}::uuid and d.created_at >= ${from} and d.created_at < ${to}`),
    },
    {
      key: 'needs.met',
      title: 'Needs met',
      values: await bucket(sql<{ at: Date }>`
        select n.done_at as at from cg.need n where n.event_id = ${eventId}::uuid
          and n.status in ('met', 'closed') and n.done_at >= ${from} and n.done_at < ${to}`),
    },
    {
      key: 'missions.closed',
      title: 'Missions closed',
      values: await bucket(sql<{ at: Date }>`
        select coalesce(m.closed_at, m.cleared_at) as at from cg.mission m
        where ${missionWhere} and m.state = any(${closedStates}::text[])
          ${needDisposition ? sql`and m.disposition is not null` : sql``}
          and coalesce(m.closed_at, m.cleared_at) >= ${from}
          and coalesce(m.closed_at, m.cleared_at) < ${to}`),
    },
  ];

  return {
    scope: {
      eventId,
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: scope.timeZone,
      filters,
    },
    generatedAt: now.toISOString(),
    metrics: out,
    trends: {
      periods: periods.map((p) => ({
        from: p.from.toISOString(),
        to: p.to.toISOString(),
        label: fmt.format(p.from),
      })),
      series,
    },
    exclusions: [
      'Damage counts only approved, verified damage to primary residences, one home once; everything else is shown apart.',
      'No metric carries a name, contact detail or address.',
      'Response times leave out records missing a milestone and say how many.',
      ...(filters.missionKind || filters.priority || filters.missionState || filters.department
        ? ['Mission and personnel figures are limited to the filters shown.']
        : []),
      ...(filters.degree ? ['Damage is limited to the degree shown.'] : []),
    ],
  };
}

/** The CSV of one result: one row per figure, each naming its definition and scope (FR-14.05/06). */
export function metricsCsv(r: MetricsResult): string {
  const rows: (string | number | null)[][] = [];
  for (const m of r.metrics) {
    const common = [
      m.definition.key,
      m.definition.source === 'county'
        ? `county ${m.definition.version}`
        : `shipped ${m.definition.version}`,
      r.scope.from,
      r.scope.to,
      r.scope.timeZone,
      r.generatedAt,
    ];
    rows.push([
      m.group,
      m.title,
      'Total',
      m.value,
      m.unit,
      m.incomplete ? m.incomplete.count : 0,
      m.incomplete?.note ?? '',
      ...common,
    ]);
    for (const p of m.parts)
      rows.push([m.group, m.title, p.label, p.value, m.unit, '', '', ...common]);
  }
  return toCsv(
    [
      'group',
      'metric',
      'part',
      'value',
      'unit',
      'left_out',
      'left_out_reason',
      'definition',
      'definition_version',
      'period_from',
      'period_to',
      'time_zone',
      'generated_at',
    ],
    rows,
    { unknown: 'Unknown' },
  );
}

const showValue = (v: number | null, unit: string) =>
  v === null ? 'Unknown' : unit === 'percent' ? `${v}%` : v.toLocaleString('en-US');

/** The accessible PDF of one result (FR-14.06, NFR-12): the same figures as the screen and CSV. */
export function metricsPdf(
  r: MetricsResult,
  opts: { productName: string; eventName: string; countyName: string },
): PdfDocumentModel {
  const when = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: r.scope.timeZone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(iso));
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: `Metrics: ${opts.eventName}` },
    {
      kind: 'pairs',
      caption: 'Scope',
      items: [
        ['County', opts.countyName],
        ['From', when(r.scope.from)],
        ['To', when(r.scope.to)],
        ['Generated', when(r.generatedAt)],
        [
          'Filters',
          [
            r.scope.filters.missionKind ? `mission kind ${label(r.scope.filters.missionKind)}` : '',
            r.scope.filters.priority ? `priority ${r.scope.filters.priority}` : '',
            r.scope.filters.missionState
              ? `mission state ${label(r.scope.filters.missionState)}`
              : '',
            r.scope.filters.department ? 'one department' : '',
            r.scope.filters.degree ? `degree ${r.scope.filters.degree}` : '',
          ]
            .filter(Boolean)
            .join('; ') || 'None',
        ],
      ],
    },
  ];
  for (const g of Object.keys(GROUP_TITLE) as MetricGroup[]) {
    const ms = r.metrics.filter((m) => m.group === g);
    if (!ms.length) continue;
    blocks.push({ kind: 'heading', level: 2, text: GROUP_TITLE[g] });
    blocks.push({
      kind: 'table',
      caption: `${GROUP_TITLE[g]}: figures`,
      columns: ['Metric', 'Value', 'Breakdown', 'Left out'],
      rowHeaders: true,
      widths: [3, 1, 4, 2],
      rows: ms.map((m) => [
        m.title,
        `${showValue(m.value, m.unit)} ${m.unit === 'percent' ? '' : m.unit}`.trim(),
        m.parts.map((p) => `${p.label}: ${showValue(p.value, m.unit)}`).join('; ') || '—',
        m.incomplete ? `${m.incomplete.count} ${m.incomplete.note}` : 'None',
      ]),
    });
  }
  const shown = r.trends.periods.slice(-14);
  if (shown.length)
    blocks.push(
      { kind: 'heading', level: 2, text: 'By operational period' },
      {
        kind: 'table',
        caption: 'Trends by operational period (the latest 14 periods)',
        columns: ['Period starting', ...r.trends.series.map((s) => s.title)],
        rowHeaders: true,
        rows: shown.map((p, i) => {
          const at = r.trends.periods.length - shown.length + i;
          return [p.label, ...r.trends.series.map((s) => s.values[at] ?? 0)];
        }),
      },
    );
  blocks.push(
    { kind: 'heading', level: 2, text: 'Definitions used' },
    {
      kind: 'list',
      items: r.metrics.map(
        (m) =>
          `${m.title} (${m.definition.source === 'county' ? 'county' : 'shipped'} version ${m.definition.version}): ${m.definition.text}`,
      ),
    },
    { kind: 'heading', level: 2, text: 'Left out of every figure' },
    { kind: 'list', items: r.exclusions },
  );
  return {
    title: `Metrics: ${opts.eventName}`,
    lang: 'en-US',
    author: opts.countyName,
    producer: opts.productName,
    footer: `${opts.countyName} · generated ${when(r.generatedAt)}`,
    blocks,
  };
}
