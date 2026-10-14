/**
 * Fills a FEMA form mapping from the package data (layer-6 task F;
 * DCL:DEC-11, DEC-12, DEC-15, GATE-07): one row per home or site for the
 * per-record forms, one value per field for the summary forms. Summary
 * counts come from the counting rule's cells, so a form's totals add up to
 * the declaration figures; unknown stays null (shown "Unknown"), never 0.
 */
import type { HomeRow, PackageData, SiteRow, Value } from './data.ts';
import type { ElementKey, Mapping, Where } from './vocabulary.ts';

export interface TableOut {
  columns: { code: string; label: string }[];
  rows: Value[][];
}

export type SectionOut =
  | { title: string; kind: 'pairs'; items: { code: string; label: string; value: Value }[] }
  | { title: string; kind: 'matrix'; rows: string[]; columns: string[]; cells: Value[][] };

const round1 = (n: number) => Math.round(n * 10) / 10;
const money = (n: number) => Math.round(n * 100) / 100;

/** Homes a per-home form lists: its scope's home types; a business is never on a home survey. */
function inScope(m: Mapping, h: HomeRow): boolean {
  const types = m.scope?.homeType;
  if (!types) return true;
  return h.homeType !== 'non_residential' && (types as string[]).includes(h.homeType);
}

export function homeTable(m: Mapping, homes: HomeRow[]): TableOut {
  return {
    columns: m.fields.map((f) => ({ code: f.code, label: f.label })),
    rows: homes
      .filter((h) => inScope(m, h))
      .map((h) => m.fields.map((f) => h.values[f.element] ?? null)),
  };
}

export function siteTable(m: Mapping, sites: SiteRow[]): TableOut {
  return {
    columns: m.fields.map((f) => ({ code: f.code, label: f.label })),
    rows: sites.map((s) => m.fields.map((f) => s.values[f.element] ?? null)),
  };
}

/** One summary value: a count narrowed by `where`, or an event figure. */
export function summaryValue(element: ElementKey, where: Where, d: PackageData): Value {
  const dmg = d.damage;
  const decl = d.declaration;
  const cells = dmg.counted.cells.filter(
    (c) =>
      (!where.degree || c.degree === where.degree) &&
      (!where.tenure || c.tenure === where.tenure) &&
      (!where.insurance || c.insurance === where.insurance) &&
      (!where.homeType || c.homeType === where.homeType) &&
      (!where.verification || c.verification === where.verification),
  );
  const units = (xs: typeof cells) => xs.reduce((n, c) => n + c.units, 0);
  const total = decl.profile?.total;
  const ind = decl.publicAssistance.indicators;
  const sites = d.sites.filter(
    (s) => !where.category || s.values['site.category'] === where.category,
  );
  const cost = (xs: SiteRow[]) =>
    money(xs.reduce((n, s) => n + Number(s.values['site.cost'] ?? 0), 0));
  switch (element) {
    case 'ia.units':
      return units(cells);
    case 'ia.homes':
      return dmg.counted.homes;
    case 'ia.percent_insured': {
      const insured = units(cells.filter((c) => c.insurance === 'insured'));
      const uninsured = units(cells.filter((c) => c.insurance === 'uninsured'));
      return insured + uninsured === 0 ? null : round1((insured / (insured + uninsured)) * 100);
    }
    case 'ia.unknown_unit_buildings':
      return dmg.counted.unknownUnitBuildings;
    case 'ia.apart': {
      const s = dmg.shownSeparately;
      if (!where.apart)
        return Object.entries(s).reduce((n, [, v]) => n + (typeof v === 'number' ? v : v.total), 0);
      return where.apart === 'inaccessible' ? s.inaccessible.total : s[where.apart];
    }
    case 'ia.inaccessible':
      return where.reason
        ? (dmg.shownSeparately.inaccessible.byReason[where.reason] ?? 0)
        : dmg.shownSeparately.inaccessible.total;
    case 'area.population':
      return total?.population ?? null;
    case 'area.households':
      return total?.households ?? null;
    case 'area.poverty_pct':
      return total?.povertyPct ?? null;
    case 'area.age65_pct':
      return total?.age65Pct ?? null;
    case 'area.disability_pct':
      return total?.disabilityPct ?? null;
    case 'area.limited_english_households':
      return total?.limitedEnglishHouseholds ?? null;
    case 'area.renter_households':
      return total?.renterHouseholds ?? null;
    case 'outage.open':
      return decl.outages.items.filter((o) => o.confirmed && !o.restoredAt).length;
    case 'outage.over72':
      return decl.outages.items.filter((o) => o.confirmed && !o.restoredAt && o.over72Hours).length;
    case 'casualty.count':
      return where.casualty ? (decl.casualties[where.casualty]?.count ?? null) : null;
    case 'shelter.open':
      return d.shelters.open;
    case 'shelter.occupancy':
      return d.shelters.occupancy;
    case 'pa.sites':
      return sites.length;
    case 'pa.cost':
      return cost(sites);
    case 'pa.verified_cost':
      return cost(d.sites.filter((s) => s.values['site.cost_basis'] === 'Verified'));
    case 'pa.county_threshold':
      return ind.countyThreshold;
    case 'pa.state_threshold':
      return ind.stateThreshold;
    case 'pa.county_per_capita':
      return ind.countywidePerCapita;
    case 'pa.state_per_capita':
      return ind.statewidePerCapita;
    case 'pa.fiscal_year':
      return ind.fiscalYear;
    case 'donated.volunteer_hours':
      return decl.donated.volunteerHours;
    case 'declaration.incident_type':
      return decl.declaration?.incidentType ?? null;
    case 'declaration.incident_period': {
      const x = decl.declaration;
      return x?.incidentStart ? `${x.incidentStart} to ${x.incidentEnd ?? 'continuing'}` : null;
    }
    case 'declaration.box8':
      return decl.declaration?.box8Draft ?? null;
    case 'declaration.box9':
      return decl.declaration?.box9Draft ?? null;
    case 'declaration.requested_areas': {
      const areas = decl.declaration?.requestedAreas ?? [];
      return areas.length
        ? areas.map((a) => `${a.name} (${a.programs.join(', ') || 'no programs'})`).join('; ')
        : null;
    }
    case 'joint_pda.dates':
      return d.jointPda.dates;
    case 'joint_pda.areas':
      return d.jointPda.areas;
    case 'event.name':
      return d.event.name;
    case 'event.as_of':
      return new Intl.DateTimeFormat('en-US', {
        timeZone: d.event.timeZone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(d.asOf));
    default:
      return null;
  }
}

/** A summary form as sections: label–value lists, or matrices where every field names a row and column. */
export function summarySections(m: Mapping, d: PackageData): SectionOut[] {
  const order: string[] = [];
  const groups = new Map<string, Mapping['fields']>();
  for (const f of m.fields) {
    const key = f.section ?? 'Fields';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(f);
  }
  return order.map((title) => {
    const fields = groups.get(title)!;
    if (fields.every((f) => f.row && f.column)) {
      const rows = [...new Set(fields.map((f) => f.row!))];
      const columns = [...new Set(fields.map((f) => f.column!))];
      const cells = rows.map((row) =>
        columns.map((column) => {
          const f = fields.find((x) => x.row === row && x.column === column);
          return f ? summaryValue(f.element, f.where ?? {}, d) : null;
        }),
      );
      return { title, kind: 'matrix' as const, rows, columns, cells };
    }
    return {
      title,
      kind: 'pairs' as const,
      items: fields.map((f) => ({
        code: f.code,
        label: f.label,
        value: summaryValue(f.element, f.where ?? {}, d),
      })),
    };
  });
}
