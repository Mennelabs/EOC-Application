/**
 * FEMA form mappings (layer-6 task F; DCL:DEC-12, DEC-13, DEC-15): each FEMA
 * form is an ordered list of its fields, each field naming one data element
 * from the closed vocabulary below (and, for counts, which slice). When FEMA
 * changes a form, a county drafts and activates a new mapping version in the
 * console; no release is needed as long as the data exists. Every export
 * names the form, the FEMA form version and the mapping version it used.
 *
 * Grains: `home` (one row per home: street sheet, IA survey, GIS layer),
 * `site` (one row per public damage site) and `summary` (one value per
 * field: summary and tick sheets, insurance matrix, cost survey, Form
 * 010-0-13). No element carries a name, phone, email or exact address
 * (DEC-13): a home's place is its 100 m grid cell, ZIP, tract and
 * jurisdiction.
 */

export type Grain = 'home' | 'site' | 'summary';

export const FORMS = {
  ia_street_sheet: { title: 'IA street sheet', grain: 'home' },
  ia_survey_single_family: { title: 'IA survey: single-family homes', grain: 'home' },
  ia_survey_multi_family: { title: 'IA survey: multi-family buildings', grain: 'home' },
  home_insurance_matrix: { title: 'Home insurance matrix', grain: 'summary' },
  ia_summary_sheet: { title: 'IA summary sheet', grain: 'summary' },
  ia_tick_sheet: { title: 'IA tick sheet', grain: 'summary' },
  pa_site_sheet: { title: 'PA site sheet', grain: 'site' },
  pa_cost_survey: { title: 'PA cost survey', grain: 'summary' },
  form_010_0_13: { title: 'Form 010-0-13 data (governor’s request)', grain: 'summary' },
  pda_gis_layer: { title: 'PDA GIS layer', grain: 'home' },
} as const satisfies Record<string, { title: string; grain: Grain }>;

export type FormKey = keyof typeof FORMS;
export const FORM_KEYS = Object.keys(FORMS) as FormKey[];

/** The slices a count can be narrowed to; values match the counting rule's categories. */
export const FILTERS = {
  degree: ['affected', 'minor', 'major', 'destroyed'],
  tenure: ['owner', 'renter', 'other', 'unknown'],
  insurance: ['insured', 'uninsured', 'unknown'],
  homeType: ['single_family', 'multi_family', 'manufactured', 'other', 'unknown'],
  verification: ['desktop_verified', 'field_verified'],
  apart: [
    'selfReported',
    'awaitingReview',
    'inaccessible',
    'witness',
    'preExisting',
    'notPrimaryResidence',
    'nonResidential',
    'noDamage',
    'degreeNotSet',
  ],
  reason: [
    'private_road_or_bridge',
    'public_road_or_bridge',
    'flood_water',
    'debris',
    'hazard',
    'no_permission',
    'other',
    'not given',
  ],
  category: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  casualty: ['injured', 'missing', 'deceased'],
} as const;
export type FilterKey = keyof typeof FILTERS;
export type Where = Partial<{ [K in FilterKey]: (typeof FILTERS)[K][number] }>;

interface ElementMeta {
  grain: Grain;
  description: string;
  /** Slices this element may be narrowed by. */
  filters?: readonly FilterKey[];
}

const home = (description: string): ElementMeta => ({ grain: 'home', description });
const site = (description: string): ElementMeta => ({ grain: 'site', description });
const sum = (description: string, filters?: readonly FilterKey[]): ElementMeta => ({
  grain: 'summary',
  description,
  ...(filters ? { filters } : {}),
});

/** The closed vocabulary of data elements a mapping may use. */
export const ELEMENTS = {
  // ---- one home (no name, phone, email or exact address: DEC-13)
  'record.ref': home('Short record reference, not the resident’s reference code'),
  'home.status': home('Counted, or why it is shown apart'),
  'location.usng': home('US National Grid cell, 100 m'),
  'location.lat': home('Latitude of the 100 m cell (3 decimals)'),
  'location.lon': home('Longitude of the 100 m cell (3 decimals)'),
  'location.postal': home('ZIP code'),
  'location.tract': home('Census tract GEOID'),
  'location.jurisdiction': home('City or county the home is in'),
  'location.tract_poverty_pct': home(
    'Share of the tract below poverty (ACS); income is never asked per home',
  ),
  'home.type': home('Structure type in FEMA’s terms'),
  'home.units': home('Housing units the record stands for'),
  'home.occupancy': home('Owner, renter, other or unknown'),
  'home.primary_residence': home('Primary residence (lived in more than six months a year)'),
  'home.degree': home('FEMA degree of damage, as set by a reviewer or assessor'),
  'home.verification': home('Self-reported, verified at the desk or in the field'),
  'home.inaccessible': home('Could not be reached: yes or no'),
  'home.inaccessible_reason': home('Why it could not be reached'),
  'home.insured': home('Insured for the peril: insured, uninsured or unknown'),
  'home.insurance_types': home('Insurance types named'),
  'home.utilities_out': home('Utilities out'),
  'home.water_depth_basement': home('Water depth in the basement, feet and inches'),
  'home.water_depth_first_floor': home('Water depth on the first floor, feet and inches'),
  'home.water_depth_crawl_space': home('Water depth in the crawl space, feet and inches'),
  'home.tribal_ownership': home('Owned by the tribe or privately'),
  'home.pre_existing': home('Damage from before the incident'),
  'home.assessed_on': home('Date the finding was made'),
  'home.source': home('Resident report or field assessment'),
  'home.photos': home('Representative photos staff chose'),
  'business.employees': home('Employees out of work (businesses)'),
  'business.days_closed': home('Days the business expects to be closed'),

  // ---- one public damage site
  'site.applicant': site('Applicant (public body or eligible nonprofit)'),
  'site.name': site('Site name'),
  'site.description': site('Description of the damage'),
  'site.category': site('Category of work A–G'),
  'site.usng': site('US National Grid of the site'),
  'site.cost': site('Estimated or verified cost (USD)'),
  'site.cost_basis': site('Estimate or verified'),
  'site.percent_complete': site('Percent of work complete'),
  'site.insured': site('Insured: yes, no or unknown'),
  'site.other_federal_agency': site('Responsibility of another federal agency'),
  'site.debris_cubic_yards': site('Debris, cubic yards'),
  'site.photos': site('Photos on file'),

  // ---- counts and values for the whole event
  'ia.units': sum('Counted housing units', [
    'degree',
    'tenure',
    'insurance',
    'homeType',
    'verification',
  ]),
  'ia.homes': sum('Counted homes and buildings'),
  'ia.percent_insured': sum('Percent of counted units insured, of those whose insurance is known', [
    'degree',
  ]),
  'ia.unknown_unit_buildings': sum(
    'Buildings counted as one unit because their unit count is unknown',
  ),
  'ia.apart': sum('Homes shown apart, never added in', ['apart']),
  'ia.inaccessible': sum('Homes that could not be reached', ['reason']),
  'area.population': sum('Population of the affected tracts (ACS)'),
  'area.households': sum('Households in the affected tracts (ACS)'),
  'area.poverty_pct': sum('Share below poverty in the affected tracts (ACS)'),
  'area.age65_pct': sum('Share aged 65 and over (ACS)'),
  'area.disability_pct': sum('Share with a disability (ACS)'),
  'area.limited_english_households': sum('Limited-English households (ACS)'),
  'area.renter_households': sum('Renter households (ACS)'),
  'outage.open': sum('Outages open now'),
  'outage.over72': sum('Outages open longer than 72 hours'),
  'casualty.count': sum('Official casualty count', ['casualty']),
  'shelter.open': sum('Shelters open'),
  'shelter.occupancy': sum('People in shelters'),
  'pa.sites': sum('Public damage sites', ['category']),
  'pa.cost': sum('Public damage cost (USD)', ['category']),
  'pa.verified_cost': sum('Verified public damage cost (USD)'),
  'pa.county_threshold': sum('Countywide per-capita indicator (USD)'),
  'pa.state_threshold': sum('Statewide per-capita indicator (USD)'),
  'pa.county_per_capita': sum('Countywide per-capita figure (USD per person)'),
  'pa.state_per_capita': sum('Statewide per-capita figure (USD per person)'),
  'pa.fiscal_year': sum('Fiscal year of the indicators'),
  'donated.volunteer_hours': sum('Volunteer hours donated'),
  'declaration.incident_type': sum('Incident type (Box 7)'),
  'declaration.incident_period': sum('Incident period (Box 7)'),
  'declaration.box8': sum('Box 8 draft: the incident and its effects'),
  'declaration.box9': sum('Box 9 draft: resources committed'),
  'declaration.requested_areas': sum('Areas and programs requested (Box 11)'),
  'joint_pda.dates': sum('Joint PDA dates (Box 10)'),
  'joint_pda.areas': sum('Joint PDA areas (Box 10)'),
  'event.name': sum('Event'),
  'event.as_of': sum('Figures as of'),
} as const satisfies Record<string, ElementMeta>;

export type ElementKey = keyof typeof ELEMENTS;

export interface MappingField {
  /** The field's code or number on FEMA's form. */
  code: string;
  /** The field's label on FEMA's form. */
  label: string;
  element: ElementKey;
  where?: Where;
  /** Summary forms: groups fields; with `row` and `column` a group is drawn as a matrix. */
  section?: string;
  row?: string;
  column?: string;
}

export interface Mapping {
  form: FormKey;
  /** Which FEMA edition of the form this follows. */
  femaFormVersion: string;
  mappingVersion: number;
  sourceDocument: string;
  /** Home-grain forms: which homes the form lists. */
  scope?: { homeType?: (typeof FILTERS)['homeType'][number][] };
  fields: MappingField[];
}

export interface MappingProblem {
  field?: number;
  message: string;
}

/** Checks a mapping against its form and the vocabulary; empty when it can be activated. */
export function validateMapping(form: FormKey, fields: readonly MappingField[]): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const grain = FORMS[form].grain;
  if (!fields.length) problems.push({ message: 'A mapping needs at least one field.' });
  const codes = new Set<string>();
  fields.forEach((f, i) => {
    const at = { field: i };
    if (!f.code.trim() || f.code.length > 40)
      problems.push({ ...at, message: 'Each field needs a code of at most 40 characters.' });
    else if (codes.has(f.code)) problems.push({ ...at, message: `Code ${f.code} is used twice.` });
    codes.add(f.code);
    if (!f.label.trim() || f.label.length > 200)
      problems.push({ ...at, message: 'Each field needs a label of at most 200 characters.' });
    const meta = (ELEMENTS as Record<string, ElementMeta>)[f.element];
    if (!meta) {
      problems.push({ ...at, message: `${f.element} is not a data element.` });
      return;
    }
    if (meta.grain !== grain)
      problems.push({
        ...at,
        message: `${f.element} describes ${meta.grain === 'summary' ? 'the whole event' : `one ${meta.grain}`}, but this form lists ${grain === 'summary' ? 'totals' : `one row per ${grain}`}.`,
      });
    for (const [k, v] of Object.entries(f.where ?? {})) {
      if (!meta.filters?.includes(k as FilterKey))
        problems.push({ ...at, message: `${f.element} cannot be narrowed by ${k}.` });
      else if (!(FILTERS[k as FilterKey] as readonly string[]).includes(String(v)))
        problems.push({ ...at, message: `${String(v)} is not a ${k}.` });
    }
    if ((f.row === undefined) !== (f.column === undefined))
      problems.push({ ...at, message: 'A matrix cell needs both a row and a column.' });
  });
  return problems;
}
