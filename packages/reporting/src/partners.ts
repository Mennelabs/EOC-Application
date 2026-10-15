/**
 * Partner counts and the county's roll-up choice (decided 2026-10-15;
 * DCL:DEC-09, F15, RULE-10). The counts come from each partner
 * organization's own records through `cg.partner_counts` (migration 0053),
 * which returns numbers per organization and category, never a row. The
 * declaration view and every official report roll up all of them by
 * default; the county may instead choose the organizations and categories,
 * and the figure states exactly what it includes. A category left out reads
 * as not included (null), never as zero.
 */
import { sql, type Transaction } from 'kysely';
import type { Database, PartnerCategory, PartnerRollup } from '@cg/db';

type Trx = Transaction<Database>;

/** The categories the county chooses from, in the order screens and reports list them. */
export const PARTNER_CATEGORY_KEYS = [
  'needs_met',
  'services',
  'sheltered',
  'teams',
  'donated',
] as const satisfies readonly PartnerCategory[];

export const PARTNER_CATEGORIES: readonly { key: PartnerCategory; label: string }[] = [
  { key: 'needs_met', label: 'Households helped (needs met)' },
  { key: 'services', label: 'Meals and other services served' },
  { key: 'sheltered', label: 'People and households sheltered' },
  { key: 'teams', label: 'Teams checked in' },
  { key: 'donated', label: 'Donated equipment and hours' },
];

export const ALL_PARTNERS: PartnerRollup = { all: true };

/** A stored choice read safely: anything unexpected rolls everything up. */
export function rollupOf(value: unknown): PartnerRollup {
  const v = value as Partial<{ all: unknown; partners: unknown; categories: unknown }> | null;
  if (!v || v.all !== false || !Array.isArray(v.partners) || !Array.isArray(v.categories))
    return ALL_PARTNERS;
  return {
    all: false,
    partners: v.partners.filter((p): p is string => typeof p === 'string'),
    categories: v.categories.filter((c): c is PartnerCategory =>
      (PARTNER_CATEGORY_KEYS as readonly string[]).includes(c as string),
    ),
  };
}

export const includesPartner = (r: PartnerRollup, partnerId: string) =>
  r.all || r.partners.includes(partnerId);
export const includesCategory = (r: PartnerRollup, category: PartnerCategory) =>
  r.all || r.categories.includes(category);

export interface PartnerOrganization {
  id: string;
  organization: string;
}

/** The county's partner organizations, for the chooser and the statement. */
export async function partnerOrganizations(
  trx: Trx,
  countyId: string,
): Promise<PartnerOrganization[]> {
  const rows = await trx
    .selectFrom('cg.tenant')
    .select(['id', 'name'])
    .where('parent_id', '=', countyId)
    .where('kind', '=', 'partner_org')
    .orderBy('name')
    .execute();
  return rows.map((r) => ({ id: r.id, organization: r.name }));
}

/** The chosen organizations that are not this county's partner organizations. */
export async function foreignPartners(
  trx: Trx,
  countyId: string,
  rollup: PartnerRollup,
): Promise<string[]> {
  if (rollup.all || rollup.partners.length === 0) return [];
  const mine = new Set((await partnerOrganizations(trx, countyId)).map((o) => o.id));
  return rollup.partners.filter((id) => !mine.has(id));
}

export interface PartnerCounts extends PartnerOrganization {
  needsMet: number;
  needsByCategory: Record<string, number>;
  services: Record<string, number>;
  shelteredHouseholds: number;
  shelteredPeople: number;
  teams: number;
}

/** Each partner organization's counts for the event, from its own records (numbers only). */
export async function partnerCounts(
  trx: Trx,
  countyId: string,
  eventId: string,
): Promise<PartnerCounts[]> {
  const rows = await sql<{
    partner_id: string;
    organization: string;
    category: PartnerCategory;
    item: string;
    n: string;
  }>`select partner_id, organization, category, item, n
      from cg.partner_counts(${countyId}, ${eventId})`.execute(trx);
  const orgs = new Map<string, PartnerCounts>();
  for (const r of rows.rows) {
    const o = orgs.get(r.partner_id) ?? {
      id: r.partner_id,
      organization: r.organization,
      needsMet: 0,
      needsByCategory: {},
      services: {},
      shelteredHouseholds: 0,
      shelteredPeople: 0,
      teams: 0,
    };
    const n = Number(r.n);
    if (r.category === 'needs_met') {
      o.needsMet += n;
      o.needsByCategory[r.item] = n;
    } else if (r.category === 'services') o.services[r.item] = n;
    else if (r.category === 'sheltered') {
      if (r.item === 'households') o.shelteredHouseholds = n;
      else o.shelteredPeople = n;
    } else if (r.category === 'teams') o.teams = n;
    orgs.set(r.partner_id, o);
  }
  return [...orgs.values()].sort((a, b) => a.organization.localeCompare(b.organization));
}

/** One organization's figures as the choice states them: a category left out is null. */
export interface PartnerFigures extends PartnerOrganization {
  needsMet: number | null;
  needsByCategory: Record<string, number> | null;
  services: Record<string, number> | null;
  shelteredHouseholds: number | null;
  shelteredPeople: number | null;
  teams: number | null;
}

export interface PartnerTotals {
  needsMet: number | null;
  meals: number | null;
  waterCases: number | null;
  tarps: number | null;
  cots: number | null;
  rides: number | null;
  peopleServed: number | null;
  shelteredHouseholds: number | null;
  shelteredPeople: number | null;
  teams: number | null;
}

export interface RollupView {
  all: boolean;
  /** The organizations whose counts are included. */
  partners: PartnerOrganization[];
  categories: PartnerCategory[];
  /** What the figures include, in words, for the screen, the report and its exports. */
  statement: string;
}

/** What a choice includes, in words. */
export function rollupStatement(
  rollup: PartnerRollup,
  organizations: readonly PartnerOrganization[],
): RollupView {
  if (rollup.all)
    return {
      all: true,
      partners: [...organizations],
      categories: [...PARTNER_CATEGORY_KEYS],
      statement: 'All partner organizations and all their counts are rolled up.',
    };
  const partners = organizations.filter((o) => rollup.partners.includes(o.id));
  const categories = PARTNER_CATEGORY_KEYS.filter((k) => rollup.categories.includes(k));
  const label = (k: PartnerCategory) =>
    PARTNER_CATEGORIES.find((c) => c.key === k)!.label.toLowerCase();
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
  return {
    all: false,
    partners,
    categories,
    statement: `Chosen by the county. Organizations included: ${list(partners.map((p) => p.organization))}. Counts included: ${list(categories.map(label))}.`,
  };
}

/** The figures the choice includes, per organization and in total. */
export function applyRollup(
  counts: readonly PartnerCounts[],
  rollup: PartnerRollup,
): { byOrganization: PartnerFigures[]; totals: PartnerTotals } {
  const has = (k: PartnerCategory) => includesCategory(rollup, k);
  const byOrganization = counts
    .filter((o) => includesPartner(rollup, o.id))
    .map((o) => ({
      id: o.id,
      organization: o.organization,
      needsMet: has('needs_met') ? o.needsMet : null,
      needsByCategory: has('needs_met') ? o.needsByCategory : null,
      services: has('services') ? o.services : null,
      shelteredHouseholds: has('sheltered') ? o.shelteredHouseholds : null,
      shelteredPeople: has('sheltered') ? o.shelteredPeople : null,
      teams: has('teams') ? o.teams : null,
    }));
  const sum = (k: PartnerCategory, f: (o: PartnerCounts) => number) =>
    has(k)
      ? counts.filter((o) => includesPartner(rollup, o.id)).reduce((n, o) => n + f(o), 0)
      : null;
  const service = (kind: string) => sum('services', (o) => o.services[kind] ?? 0);
  return {
    byOrganization,
    totals: {
      needsMet: sum('needs_met', (o) => o.needsMet),
      meals: service('meal'),
      waterCases: service('water_case'),
      tarps: service('tarp'),
      cots: service('cot'),
      rides: service('ride'),
      peopleServed: service('person_served'),
      shelteredHouseholds: sum('sheltered', (o) => o.shelteredHouseholds),
      shelteredPeople: sum('sheltered', (o) => o.shelteredPeople),
      teams: sum('teams', (o) => o.teams),
    },
  };
}
