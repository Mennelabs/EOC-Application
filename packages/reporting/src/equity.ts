/**
 * The equity dashboard's data (layer-6 task G; EQ-11, EQ-12, EQ-13, CON-07,
 * Section 19). For one event:
 *
 * - every tract in the event's footprint (or, without one, in the county's
 *   tract snapshot, so tracts with no report at all are seen): reports and
 *   needs against households and residential structures, renter share,
 *   poverty share (the tract's income band, by quintile of poverty within
 *   the tracts shown) and limited-English households;
 * - coverage: a tract, or an income band, whose reports per 100 residential
 *   structures (per 1,000 households when the inventory is missing) fall
 *   below the tenant's share (default 70%) of the best-covered income band
 *   is flagged as under-reported (CON-07, Section 19);
 * - time to first review and time to help by income band, owner or renter,
 *   language and channel; a group whose median exceeds the tenant's
 *   multiple (default 1.5) of the event's median, and by at least an hour,
 *   is flagged (EQ-12);
 * - every count of residents or households from 1 to 10 is hidden, and so
 *   is any rate or median drawn from it (EQ-13). Census figures are public
 *   and are not hidden.
 *
 * Each flag carries suggested outreach. Counts only, never a person.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { currentSnapshot } from './area.ts';
import { loadDamageRecords } from './load.ts';
import { median } from './metrics.ts';

type Trx = Transaction<Database>;

export const EQUITY_DEFAULTS = { coverageRatio: 0.7, gapRatio: 1.5, minCell: 11 } as const;

export interface EquityThresholds {
  coverageRatio: number;
  gapRatio: number;
  /** EQ-13: counts below this are hidden; never lower than 11. */
  minCell: number;
}

export type Dimension = 'income_band' | 'tenure' | 'language' | 'channel';
export type AlertKind = 'coverage' | 'review_gap' | 'help_gap';
export type SubjectKind = 'tract' | Dimension;

export interface TractRow {
  geoid: string;
  name: string | null;
  population: number | null;
  households: number | null;
  renterSharePct: number | null;
  povertyPct: number | null;
  limitedEnglishPct: number | null;
  /** 1 = the highest poverty share (lowest income) … 5 = the lowest; null when unknown. */
  incomeBand: number | null;
  structures: number | null;
  /** Null when hidden (1–10, EQ-13). */
  reports: number | null;
  needs: number | null;
  reportsPer1000Households: number | null;
  reportsPer100Structures: number | null;
  needsPer1000Households: number | null;
  underReported: boolean;
}

export interface BandRow {
  band: number;
  tracts: number;
  reports: number | null;
  /** The coverage rate the band is compared on. */
  rate: number | null;
  basis: 'structures' | 'households';
  underReported: boolean;
}

export interface GroupRow {
  dimension: Dimension;
  group: string;
  label: string;
  reports: number | null;
  reviewMedianHours: number | null;
  needs: number | null;
  helpMedianHours: number | null;
  reviewGap: boolean;
  helpGap: boolean;
}

export interface AlertCandidate {
  kind: AlertKind;
  subjectKind: SubjectKind;
  subject: string;
  label: string;
  /** Null when the figure is hidden (EQ-13). */
  value: number | null;
  threshold: number;
  outreach: string;
}

export interface EquityData {
  eventId: string;
  asOf: string;
  thresholds: EquityThresholds;
  basis: 'footprint' | 'county' | 'none';
  tracts: TractRow[];
  bands: BandRow[];
  groups: GroupRow[];
  eventMedians: { reviewHours: number | null; helpHours: number | null };
  alerts: AlertCandidate[];
}

const LANGUAGE: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  vi: 'Vietnamese',
  zh: 'Chinese',
  ar: 'Arabic',
  so: 'Somali',
  fr: 'French',
  ht: 'Haitian Creole',
};
const CHANNEL: Record<string, string> = {
  web: 'Web',
  sms: 'Text message',
  voice: 'Phone',
  assisted: 'Assisted (staff or kiosk)',
  standalone: 'Recorded by staff',
  staff: 'Recorded by staff',
  report: 'From a report',
};
const TENURE: Record<string, string> = { owner: 'Owner', renter: 'Renter', unknown: 'Unknown' };
export const bandLabel = (b: number) =>
  b === 1
    ? 'Band 1 (highest poverty share)'
    : b === 5
      ? 'Band 5 (lowest poverty share)'
      : `Band ${b}`;
const DIMENSION_LABEL: Record<Dimension, string> = {
  income_band: 'income band',
  tenure: 'occupancy',
  language: 'language',
  channel: 'channel',
};

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The tenant's thresholds (versioned tenant configuration), or the defaults (plan §14 question 3). */
export async function equityThresholds(trx: Trx, tenantId: string): Promise<EquityThresholds> {
  const rows = await trx
    .selectFrom('cg.tenant_config')
    .select(['key', 'value'])
    .where('tenant_id', '=', tenantId)
    .where('key', 'in', ['equity.coverage_ratio', 'equity.gap_ratio'])
    .execute();
  const get = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(rows.find((r) => r.key === k)?.value);
    return Number.isFinite(v) && v >= lo && v <= hi ? v : d;
  };
  return {
    coverageRatio: get('equity.coverage_ratio', EQUITY_DEFAULTS.coverageRatio, 0.1, 1),
    gapRatio: get('equity.gap_ratio', EQUITY_DEFAULTS.gapRatio, 1.05, 10),
    minCell: EQUITY_DEFAULTS.minCell,
  };
}

/**
 * EQ-12: a group waits too long when its median is over the event's median
 * times the tenant's ratio and at least an hour longer, so an event whose
 * median is near zero still shows a group left waiting.
 */
export const isGap = (group: number | null, event: number | null, ratio: number): boolean =>
  group !== null && event !== null && group > event * ratio && group - event >= 1;

/** EQ-13: a count of 1 to minCell − 1 is hidden. */
export const hide = (n: number, minCell: number): number | null =>
  n > 0 && n < minCell ? null : n;

/** Suggested outreach for a flag, in words a coordinator can act on. */
export function outreachFor(kind: AlertKind, subjectKind: SubjectKind, label: string): string {
  if (kind === 'coverage')
    return subjectKind === 'tract'
      ? `Fewer reports than expected from ${label}: send the canvass team or a text broadcast there in its main languages, ask partners and faith groups working there to share the report link, and check the structure count.`
      : `${label} is under-reported: plan outreach in its tracts first (door-to-door, partners, the help line in every language).`;
  const what = kind === 'review_gap' ? 'first review' : 'help';
  if (subjectKind === 'language')
    return `${label} speakers wait longer for ${what}: assign staff or partners who speak ${label}, and check the translations on the intake and messages.`;
  if (subjectKind === 'tenure')
    return `${label}s wait longer for ${what}: ask partners serving ${label.toLowerCase()}s to take open needs, and check landlord or owner questions are not holding reports.`;
  if (subjectKind === 'channel')
    return `Reports by ${label.toLowerCase()} wait longer for ${what}: look at that queue first and check the channel is reaching reviewers.`;
  return `${label} waits longer for ${what}: review the oldest reports and needs there first and ask partners working there to help.`;
}

export async function equityData(
  trx: Trx,
  tenantId: string,
  eventId: string,
  now = new Date(),
): Promise<EquityData | null> {
  const event = await trx
    .selectFrom('cg.event')
    .select(['id', sql<boolean>`footprint is not null`.as('has_footprint')])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) return null;
  const t = await equityThresholds(trx, tenantId);
  const tractSnap = await currentSnapshot(trx, tenantId, 'tract');
  const profileSnap = await currentSnapshot(trx, tenantId, 'tract_profile');
  const structureSnap = await currentSnapshot(trx, tenantId, 'structure');

  // ---------------------------------------------------------------- the tracts in view
  let basis: EquityData['basis'] = 'none';
  let universe: { geoid: string; name: string | null }[] = [];
  if (tractSnap) {
    basis = event.has_footprint ? 'footprint' : 'county';
    universe = (
      await sql<{ geoid: string; name: string | null }>`
        select t.geoid, t.name from cg.ref_tract t
        ${event.has_footprint ? sql`join cg.event e on e.id = ${eventId}::uuid and st_intersects(t.geom, e.footprint)` : sql``}
        where t.snapshot_id = ${tractSnap.id}::uuid order by t.geoid`.execute(trx)
    ).rows;
  }
  const geoids = universe.map((u) => u.geoid);
  const profile = new Map<string, Record<string, unknown>>();
  if (profileSnap && geoids.length)
    for (const p of (
      await sql<Record<string, unknown>>`
        select geoid, population, households, renter_households, poverty_pct,
          limited_english_households
        from cg.ref_tract_profile where snapshot_id = ${profileSnap.id}::uuid
          and geoid = any(${geoids}::text[])`.execute(trx)
    ).rows)
      profile.set(String(p['geoid']), p);
  const structures = new Map<string, number>();
  if (structureSnap && geoids.length)
    for (const s of (
      await sql<{ geoid: string; n: string }>`
        select tract_geoid as geoid, count(*) as n from cg.ref_structure
        where snapshot_id = ${structureSnap.id}::uuid and tract_geoid = any(${geoids}::text[])
          and home_type in ('single_family', 'multi_family', 'manufactured')
        group by 1`.execute(trx)
    ).rows)
      structures.set(s.geoid, Number(s.n));

  // ---------------------------------------------------------------- reports and needs
  const reports = (
    await sql<{
      id: string;
      channel: string;
      language: string | null;
      geoid: string | null;
      review_hours: number | null;
    }>`
      select r.id, r.channel_of_origin as channel, p.language, g.tract_geoid as geoid,
        extract(epoch from (
          (select min(d.created_at) from cg.review_decision d where d.report_id = r.id) - r.submitted_at
        )) / 3600 as review_hours
      from cg.report r
      left join cg.party p on p.id = r.reporter_party_id
      left join cg.location_geo g on g.location_id = r.location_id
        ${tractSnap ? sql`and g.tract_snapshot_id = ${tractSnap.id}::uuid` : sql``}
      where r.event_id = ${eventId}::uuid and r.withdrawn_at is null
        and r.duplicate_of is null and r.review_state not in ('duplicate', 'superseded')`.execute(
      trx,
    )
  ).rows;
  const needs = (
    await sql<{
      report_id: string | null;
      source: string;
      language: string | null;
      geoid: string | null;
      help_hours: number | null;
    }>`
      select n.report_id, n.source, cp.language, g.tract_geoid as geoid,
        case when n.status in ('met', 'closed') and n.done_at is not null
          then extract(epoch from (n.done_at - n.created_at)) / 3600 end as help_hours
      from cg.need n
      left join cg.report r on r.id = n.report_id
      left join cg.party cp on cp.id = coalesce(n.contact_party_id, r.reporter_party_id)
      left join cg.location_geo g on g.location_id = coalesce(n.location_id, r.location_id)
        ${tractSnap ? sql`and g.tract_snapshot_id = ${tractSnap.id}::uuid` : sql``}
      where n.event_id = ${eventId}::uuid and n.status <> 'withdrawn'`.execute(trx)
  ).rows;
  const tenure = new Map(
    (await loadDamageRecords(trx, eventId))
      .filter((r) => r.kind === 'report')
      .map((r) => [r.id, r.tenure as string]),
  );

  // ---------------------------------------------------------------- income bands
  const ranked = universe
    .map((u) => ({ geoid: u.geoid, poverty: num(profile.get(u.geoid)?.['poverty_pct']) }))
    .filter((x): x is { geoid: string; poverty: number } => x.poverty !== null)
    .sort((a, b) => b.poverty - a.poverty || a.geoid.localeCompare(b.geoid));
  const band = new Map<string, number>();
  ranked.forEach((x, i) => band.set(x.geoid, Math.floor((i * 5) / ranked.length) + 1));

  // ---------------------------------------------------------------- tracts
  const count = <T extends { geoid: string | null }>(rows: T[], g: string) =>
    rows.filter((r) => r.geoid === g).length;
  const useStructures = structures.size > 0;
  const tracts: TractRow[] = universe.map((u) => {
    const p = profile.get(u.geoid);
    const hh = num(p?.['households']);
    const renters = num(p?.['renter_households']);
    const lep = num(p?.['limited_english_households']);
    const st = useStructures ? (structures.get(u.geoid) ?? 0) : null;
    const nReports = count(reports, u.geoid);
    const nNeeds = count(needs, u.geoid);
    const shownReports = hide(nReports, t.minCell);
    const shownNeeds = hide(nNeeds, t.minCell);
    const per = (n: number | null, d: number | null, k: number) =>
      n === null || d === null || d === 0 ? null : round1((n / d) * k);
    return {
      geoid: u.geoid,
      name: u.name,
      population: num(p?.['population']),
      households: hh,
      renterSharePct: hh && renters !== null ? round1((renters / hh) * 100) : null,
      povertyPct: num(p?.['poverty_pct']),
      limitedEnglishPct: hh && lep !== null ? round1((lep / hh) * 100) : null,
      incomeBand: band.get(u.geoid) ?? null,
      structures: st,
      reports: shownReports,
      needs: shownNeeds,
      reportsPer1000Households: per(shownReports, hh, 1000),
      reportsPer100Structures: per(shownReports, st, 100),
      needsPer1000Households: per(shownNeeds, hh, 1000),
      underReported: false,
    };
  });

  // ---------------------------------------------------------------- coverage (CON-07, Section 19)
  const alerts: AlertCandidate[] = [];
  const rateOf = (nReports: number, st: number | null, hh: number | null) =>
    useStructures ? (st ? (nReports / st) * 100 : null) : hh ? (nReports / hh) * 1000 : null;
  const bands: (BandRow & { raw: number | null })[] = [1, 2, 3, 4, 5]
    .map((b) => {
      const inBand = universe.filter((u) => band.get(u.geoid) === b);
      const n = inBand.reduce((s, u) => s + count(reports, u.geoid), 0);
      const st = inBand.reduce((s, u) => s + (structures.get(u.geoid) ?? 0), 0);
      const hh = inBand.reduce((s, u) => s + (num(profile.get(u.geoid)?.['households']) ?? 0), 0);
      const rate = rateOf(n, st, hh);
      const shown = hide(n, t.minCell);
      return {
        band: b,
        tracts: inBand.length,
        reports: shown,
        // A rate would give a hidden count away (EQ-13); it is compared, not shown.
        rate: rate === null || shown === null ? null : round1(rate),
        raw: rate,
        basis: useStructures ? ('structures' as const) : ('households' as const),
        underReported: false,
      };
    })
    .filter((b) => b.tracts > 0);
  const best = Math.max(0, ...bands.map((b) => b.raw ?? 0));
  const floor = round1(best * t.coverageRatio);
  if (best > 0) {
    for (const b of bands)
      if (b.raw !== null && b.raw < floor) {
        b.underReported = true;
        alerts.push({
          kind: 'coverage',
          subjectKind: 'income_band',
          subject: String(b.band),
          label: bandLabel(b.band),
          value: b.reports === null ? null : b.rate,
          threshold: floor,
          outreach: outreachFor('coverage', 'income_band', bandLabel(b.band)),
        });
      }
    for (const tr of tracts) {
      const raw = rateOf(count(reports, tr.geoid), tr.structures, tr.households);
      if (raw !== null && raw < floor) {
        tr.underReported = true;
        const name = `tract ${tr.geoid}${tr.name ? ` (${tr.name})` : ''}`;
        alerts.push({
          kind: 'coverage',
          subjectKind: 'tract',
          subject: tr.geoid,
          label: name,
          value: tr.reports === null ? null : round1(raw),
          threshold: floor,
          outreach: outreachFor('coverage', 'tract', name),
        });
      }
    }
  }

  // ---------------------------------------------------------------- groups (EQ-12)
  const reportGroup = (r: (typeof reports)[number], d: Dimension): string =>
    d === 'income_band'
      ? r.geoid && band.has(r.geoid)
        ? String(band.get(r.geoid))
        : 'unknown'
      : d === 'tenure'
        ? (tenure.get(r.id) ?? 'unknown')
        : d === 'language'
          ? (r.language ?? 'unknown')
          : r.channel;
  const byReport = new Map(reports.map((r) => [r.id, r]));
  const needGroup = (n: (typeof needs)[number], d: Dimension): string => {
    const r = n.report_id ? byReport.get(n.report_id) : undefined;
    if (r && d !== 'language') return reportGroup(r, d);
    if (d === 'income_band')
      return n.geoid && band.has(n.geoid) ? String(band.get(n.geoid)) : 'unknown';
    if (d === 'tenure') return 'unknown';
    if (d === 'language') return n.language ?? 'unknown';
    return n.source;
  };
  const labelOf = (d: Dimension, g: string) =>
    g === 'unknown'
      ? 'Unknown'
      : d === 'income_band'
        ? bandLabel(Number(g))
        : d === 'tenure'
          ? (TENURE[g] ?? g)
          : d === 'language'
            ? (LANGUAGE[g] ?? g)
            : (CHANNEL[g] ?? g);
  const reviewAll = median(
    reports.filter((r) => r.review_hours !== null).map((r) => Number(r.review_hours)),
  );
  const helpAll = median(
    needs.filter((n) => n.help_hours !== null).map((n) => Number(n.help_hours)),
  );
  const groups: GroupRow[] = [];
  for (const d of ['income_band', 'tenure', 'language', 'channel'] as Dimension[]) {
    const keys = new Set([
      ...reports.map((r) => reportGroup(r, d)),
      ...needs.map((n) => needGroup(n, d)),
    ]);
    for (const g of [...keys].sort()) {
      const rs = reports.filter((r) => reportGroup(r, d) === g);
      const ns = needs.filter((n) => needGroup(n, d) === g);
      const reviewed = rs.filter((r) => r.review_hours !== null).map((r) => Number(r.review_hours));
      const helped = ns.filter((n) => n.help_hours !== null).map((n) => Number(n.help_hours));
      const reviewMedian = reviewed.length >= t.minCell ? median(reviewed) : null;
      const helpMedian = helped.length >= t.minCell ? median(helped) : null;
      const row: GroupRow = {
        dimension: d,
        group: g,
        label: labelOf(d, g),
        reports: hide(rs.length, t.minCell),
        reviewMedianHours: reviewMedian,
        needs: hide(ns.length, t.minCell),
        helpMedianHours: helpMedian,
        reviewGap: g !== 'unknown' && isGap(reviewMedian, reviewAll, t.gapRatio),
        helpGap: g !== 'unknown' && isGap(helpMedian, helpAll, t.gapRatio),
      };
      groups.push(row);
      const label = `${labelOf(d, g)}`;
      if (row.reviewGap)
        alerts.push({
          kind: 'review_gap',
          subjectKind: d,
          subject: g,
          label: `${label} (${DIMENSION_LABEL[d]})`,
          value: reviewMedian,
          threshold: round1(reviewAll! * t.gapRatio),
          outreach: outreachFor('review_gap', d, label),
        });
      if (row.helpGap)
        alerts.push({
          kind: 'help_gap',
          subjectKind: d,
          subject: g,
          label: `${label} (${DIMENSION_LABEL[d]})`,
          value: helpMedian,
          threshold: round1(helpAll! * t.gapRatio),
          outreach: outreachFor('help_gap', d, label),
        });
    }
  }

  return {
    eventId,
    asOf: now.toISOString(),
    thresholds: t,
    basis,
    tracts,
    bands: bands.map(({ raw: _raw, ...b }) => b),
    groups,
    eventMedians: { reviewHours: reviewAll, helpHours: helpAll },
    alerts,
  };
}

/**
 * Records the flags that hold now: a new one is raised; one already open
 * stays as it is (its acknowledgement kept); an open one that no longer
 * holds is cleared. Run by the worker (EQ-12 alerts, CON-07).
 */
export async function raiseEquityAlerts(
  trx: Trx,
  tenantId: string,
  eventId: string,
  candidates: readonly AlertCandidate[],
): Promise<{ raised: string[]; cleared: string[] }> {
  const open = await trx
    .selectFrom('cg.equity_alert')
    .select(['id', 'kind', 'subject_kind', 'subject'])
    .where('event_id', '=', eventId)
    .where('cleared_at', 'is', null)
    .execute();
  const key = (k: string, sk: string, s: string) => `${k}|${sk}|${s}`;
  const want = new Map(candidates.map((c) => [key(c.kind, c.subjectKind, c.subject), c]));
  const have = new Set(open.map((o) => key(o.kind, o.subject_kind, o.subject)));
  const raised: string[] = [];
  for (const [k, c] of want) {
    if (have.has(k)) continue;
    const row = await trx
      .insertInto('cg.equity_alert')
      .values({
        tenant_id: tenantId,
        event_id: eventId,
        kind: c.kind,
        subject_kind: c.subjectKind,
        subject: c.subject,
        label: c.label,
        value: c.value,
        threshold: c.threshold,
        outreach: c.outreach,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    raised.push(row.id);
  }
  const cleared = open
    .filter((o) => !want.has(key(o.kind, o.subject_kind, o.subject)))
    .map((o) => o.id);
  if (cleared.length)
    await trx
      .updateTable('cg.equity_alert')
      .set({ cleared_at: new Date() })
      .where('id', 'in', cleared)
      .execute();
  return { raised, cleared };
}
