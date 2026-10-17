/**
 * Minimum-field sharing rules (NED-04, NED-05, AC-17C, FL-03, SEC-05/06,
 * BRD:RULE-12). A partner organization never reads a resident's record; it
 * reads a projection cut to what its service needs, and only while the
 * resident's consent for that organization type stands and the county's
 * agreement with the partner names the data categories. Everything here is
 * pure so the worker, the API and the tests agree on one table.
 */
import type { DataCategory } from './types.ts';

/** What a partner does for residents (the county's agreement names one). */
export type SharingService =
  'cleanup' | 'feeding' | 'shelter' | 'counseling' | 'legal' | 'coordination' | 'case_management';

export const SHARING_SERVICES: readonly SharingService[] = [
  'cleanup',
  'feeding',
  'shelter',
  'counseling',
  'legal',
  'coordination',
  // FL-13, FL:FR-18, FL:FR-27: caseworkers, the SBA and the long-term recovery group.
  'case_management',
];

/** A section of a shared record. The names are stable: they go into grants and audit rows. */
export type SharingSection =
  | 'name'
  | 'contact'
  | 'contact_preference'
  | 'address_exact'
  | 'area'
  | 'household_band'
  | 'need'
  | 'access_needs'
  // Case management (plan §3.7): live sections read from the case, never copied into a projection.
  | 'help_received'
  | 'recovery_plan'
  | 'appointments';

/** The data category each section belongs to; the agreement must name it unless it is basic. */
export const SECTION_CATEGORY: Record<SharingSection, DataCategory> = {
  name: 'basic',
  contact: 'contact',
  contact_preference: 'contact',
  address_exact: 'location_exact',
  area: 'basic',
  household_band: 'household',
  need: 'basic',
  access_needs: 'access_needs',
  help_received: 'financial',
  recovery_plan: 'basic',
  appointments: 'contact',
};

/** Sections that leave the county only encrypted (restricted); the rest is a queryable projection. */
export const RESTRICTED_SECTIONS: readonly SharingSection[] = ['name', 'contact', 'access_needs'];

/** NED-04 table: the most a service may receive. Shelter's access needs come only with a shelter need. */
export const SECTIONS_BY_SERVICE: Record<SharingService, readonly SharingSection[]> = {
  cleanup: ['name', 'contact', 'contact_preference', 'address_exact', 'need'],
  feeding: ['area', 'household_band', 'need'],
  shelter: ['contact', 'need', 'access_needs'],
  counseling: ['contact'],
  legal: ['name', 'contact'],
  coordination: [],
  // A case manager's organization: the household's record plus the case sections (plan §3.7).
  // Dollar values need the financial category on the agreement as on the role (FL-13).
  case_management: [
    'name',
    'contact',
    'contact_preference',
    'address_exact',
    'household_band',
    'need',
    'recovery_plan',
    'help_received',
    'appointments',
  ],
};

/** The sections a case_management grant must carry for a partner to reach the case at all. */
export const CASE_SECTION: SharingSection = 'recovery_plan';

export function isSharingService(value: unknown): value is SharingService {
  return typeof value === 'string' && (SHARING_SERVICES as readonly string[]).includes(value);
}

export interface SharingAgreement {
  id: string;
  toTenantId: string;
  orgType: string;
  service: SharingService;
  /** Data categories the agreement allows (basic is always allowed). */
  dataCategories: readonly string[];
  signed: boolean;
}

export interface SharingConsent {
  id: string;
  orgType: string;
  granted: boolean;
}

export interface SharingSubject {
  /** Need categories the resident chose (graph values such as shelter_tonight). */
  needs: readonly string[];
  /** A withdrawn report shares nothing. */
  withdrawn: boolean;
}

export interface DerivedGrant {
  agreementId: string;
  toTenantId: string;
  orgType: string;
  consentId: string;
  service: SharingService;
  sections: SharingSection[];
}

/** The sections a service gets under an agreement for this resident; empty means no grant. */
export function sectionsFor(
  service: SharingService,
  dataCategories: readonly string[],
  subject: Pick<SharingSubject, 'needs'>,
): SharingSection[] {
  const askedShelter = subject.needs.includes('shelter_tonight');
  return SECTIONS_BY_SERVICE[service].filter((section) => {
    if (section === 'access_needs' && !askedShelter) return false;
    const category = SECTION_CATEGORY[section];
    return category === 'basic' || dataCategories.includes(category);
  });
}

/**
 * One grant per signed agreement whose organization type the resident
 * consented to, carrying the sections the service may see. Order is stable
 * (agreement order) so repeated derivation changes nothing (BRD:FR-00.06).
 */
export function deriveGrants(
  agreements: readonly SharingAgreement[],
  consents: readonly SharingConsent[],
  subject: SharingSubject,
): DerivedGrant[] {
  if (subject.withdrawn) return [];
  const out: DerivedGrant[] = [];
  for (const agreement of agreements) {
    if (!agreement.signed) continue;
    const consent = consents.find((c) => c.orgType === agreement.orgType && c.granted);
    if (!consent) continue;
    const sections = sectionsFor(agreement.service, agreement.dataCategories, subject);
    if (sections.length === 0) continue;
    out.push({
      agreementId: agreement.id,
      toTenantId: agreement.toTenantId,
      orgType: agreement.orgType,
      consentId: consent.id,
      service: agreement.service,
      sections,
    });
  }
  return out;
}

/** Household size as a band, never the number (feeding needs portions, not people). */
export function householdBand(size: number | null | undefined): string | null {
  if (size === null || size === undefined || !Number.isFinite(size) || size < 1) return null;
  if (size <= 2) return '1-2';
  if (size <= 4) return '3-4';
  if (size <= 7) return '5-7';
  return '8+';
}

export interface SharingFacts {
  name: string | null;
  contact: { phone?: string; email?: string; preferred?: string } | null;
  address: {
    line1?: string | null;
    unit?: string | null;
    city?: string | null;
    state?: string | null;
    postal?: string | null;
    landmark?: string | null;
    note?: string | null;
  } | null;
  householdSize: number | null;
  needs: readonly { id: string; category: string; status: string }[];
  accessNeeds: readonly string[] | null;
}

export interface Projection {
  /** Queryable part (sensitive at most): area, address, band, needs, preference. */
  clear: Record<string, unknown>;
  /** Encrypted part (restricted): name, contact, access needs. */
  restricted: Record<string, unknown>;
}

const compact = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  ) as Partial<T>;

/** Cuts the facts down to the granted sections. Nothing outside the sections survives. */
export function project(sections: readonly SharingSection[], facts: SharingFacts): Projection {
  const clear: Record<string, unknown> = {};
  const restricted: Record<string, unknown> = {};
  const has = (s: SharingSection) => sections.includes(s);
  if (has('name') && facts.name) restricted['name'] = facts.name;
  if (has('contact') && facts.contact) {
    const c = compact({ phone: facts.contact.phone, email: facts.contact.email });
    if (Object.keys(c).length > 0) restricted['contact'] = c;
  }
  if (has('contact_preference') && facts.contact?.preferred)
    clear['contactPreference'] = facts.contact.preferred;
  if (has('address_exact') && facts.address) {
    const a = compact({
      line1: facts.address.line1,
      unit: facts.address.unit,
      city: facts.address.city,
      state: facts.address.state,
      postal: facts.address.postal,
      landmark: facts.address.landmark,
      note: facts.address.note,
    });
    if (Object.keys(a).length > 0) clear['address'] = a;
  }
  if (has('area') && facts.address) {
    const area = compact({ city: facts.address.city, postal: facts.address.postal });
    if (Object.keys(area).length > 0) clear['area'] = area;
  }
  if (has('household_band')) {
    const band = householdBand(facts.householdSize);
    if (band) clear['householdBand'] = band;
  }
  if (has('need'))
    clear['needs'] = facts.needs.map((n) => ({ id: n.id, category: n.category, status: n.status }));
  if (has('access_needs') && facts.accessNeeds && facts.accessNeeds.length > 0)
    restricted['accessNeeds'] = [...facts.accessNeeds];
  return { clear, restricted };
}
