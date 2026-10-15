/**
 * Version 1 of each FEMA form mapping, shipped with the platform from
 * docs/05 (DCL:DEC-12, DEC-15). FEMA's current forms could not be fetched
 * from fema.gov when this was written: compare with fema.gov/pda before the
 * pilot and, where FEMA differs, draft and activate a new version in the
 * console. A county's own active version takes precedence over these.
 */
import { FILTERS, type FormKey, type Mapping, type MappingField } from './vocabulary.ts';

const FEMA_V1 = 'FEMA PDA Guide (July 2025) and IA IDA checklist (2021), as mapped in docs/05';
const SOURCE = 'docs/05-fema-field-mapping.md';
const DEGREE_LABEL = {
  affected: 'Affected',
  minor: 'Minor',
  major: 'Major',
  destroyed: 'Destroyed',
};
const TENURE_LABEL = { owner: 'Owner', renter: 'Renter', other: 'Other', unknown: 'Unknown' };
const INSURANCE_LABEL = { insured: 'Insured', uninsured: 'Uninsured', unknown: 'Unknown' };
const TYPE_LABEL = {
  single_family: 'Single-family',
  multi_family: 'Multi-family (units)',
  manufactured: 'Manufactured home',
  other: 'Other',
  unknown: 'Unknown',
};
const CATEGORY_LABEL = {
  A: 'A: Debris removal',
  B: 'B: Emergency protective measures',
  C: 'C: Roads and bridges',
  D: 'D: Water control facilities',
  E: 'E: Buildings and equipment',
  F: 'F: Utilities',
  G: 'G: Parks, recreational and other',
};

const homeCommon: MappingField[] = [
  { code: 'REF', label: 'Record', element: 'record.ref' },
  { code: 'STATUS', label: 'Status', element: 'home.status' },
  { code: 'USNG', label: 'Location (US National Grid, 100 m)', element: 'location.usng' },
  { code: 'JURIS', label: 'Jurisdiction', element: 'location.jurisdiction' },
  { code: 'ZIP', label: 'ZIP code', element: 'location.postal' },
  { code: 'TRACT', label: 'Census tract', element: 'location.tract' },
];
const homeDamage: MappingField[] = [
  { code: 'TYPE', label: 'Structure type', element: 'home.type' },
  { code: 'OWN_RENT', label: 'Owner or renter', element: 'home.occupancy' },
  { code: 'PRIMARY', label: 'Primary residence', element: 'home.primary_residence' },
  { code: 'DEGREE', label: 'Degree of damage', element: 'home.degree' },
  { code: 'INACCESS', label: 'Inaccessible', element: 'home.inaccessible' },
  { code: 'INACC_RSN', label: 'Reason inaccessible', element: 'home.inaccessible_reason' },
  { code: 'INSURED', label: 'Insured for the peril', element: 'home.insured' },
  { code: 'INS_TYPE', label: 'Insurance types', element: 'home.insurance_types' },
  { code: 'UTIL_OUT', label: 'Utilities out', element: 'home.utilities_out' },
  { code: 'WTR_BSMT', label: 'Water depth: basement', element: 'home.water_depth_basement' },
  { code: 'WTR_FLR1', label: 'Water depth: first floor', element: 'home.water_depth_first_floor' },
  { code: 'WTR_CRAWL', label: 'Water depth: crawl space', element: 'home.water_depth_crawl_space' },
  {
    code: 'LOW_INC',
    label: 'Low income (tract share, ACS)',
    element: 'location.tract_poverty_pct',
  },
  { code: 'TRIBAL', label: 'Tribal ownership', element: 'home.tribal_ownership' },
  { code: 'VERIF', label: 'Verification', element: 'home.verification' },
  { code: 'DATE', label: 'Date of assessment', element: 'home.assessed_on' },
  { code: 'SOURCE', label: 'Source of the information', element: 'home.source' },
];

const matrix = (): MappingField[] => {
  const out: MappingField[] = [];
  for (const degree of FILTERS.degree)
    for (const tenure of ['owner', 'renter'] as const)
      for (const insurance of FILTERS.insurance)
        out.push({
          code: `${degree.slice(0, 3).toUpperCase()}-${tenure.slice(0, 3).toUpperCase()}-${insurance.slice(0, 3).toUpperCase()}`,
          label: `${DEGREE_LABEL[degree]}, ${TENURE_LABEL[tenure].toLowerCase()}, ${INSURANCE_LABEL[insurance].toLowerCase()}`,
          element: 'ia.units',
          where: { degree, tenure, insurance },
          section: 'Housing units by degree of damage, occupancy and insurance',
          row: DEGREE_LABEL[degree],
          column: `${TENURE_LABEL[tenure]}: ${INSURANCE_LABEL[insurance].toLowerCase()}`,
        });
  return out;
};

const tick = (): MappingField[] => {
  const out: MappingField[] = [];
  for (const homeType of FILTERS.homeType)
    for (const degree of FILTERS.degree)
      out.push({
        code: `${homeType.toUpperCase()}-${degree.toUpperCase()}`,
        label: `${TYPE_LABEL[homeType]}, ${DEGREE_LABEL[degree].toLowerCase()}`,
        element: 'ia.units',
        where: { homeType, degree },
        section: 'Housing units by structure type and degree of damage',
        row: TYPE_LABEL[homeType],
        column: DEGREE_LABEL[degree],
      });
  return out;
};

const fields: Record<FormKey, Pick<Mapping, 'fields' | 'scope'>> = {
  ia_street_sheet: { fields: [...homeCommon, ...homeDamage] },
  ia_survey_single_family: {
    scope: { homeType: ['single_family', 'manufactured', 'other', 'unknown'] },
    fields: [
      ...homeCommon,
      ...homeDamage,
      { code: 'BUS_EMP', label: 'Employees out of work', element: 'business.employees' },
      { code: 'BUS_DAYS', label: 'Expected days closed', element: 'business.days_closed' },
    ],
  },
  ia_survey_multi_family: {
    scope: { homeType: ['multi_family'] },
    fields: [
      ...homeCommon,
      { code: 'UNITS', label: 'Units in the building', element: 'home.units' },
      ...homeDamage.filter((f) => f.code !== 'TYPE'),
    ],
  },
  home_insurance_matrix: { fields: matrix() },
  ia_summary_sheet: {
    fields: [
      ...FILTERS.degree.map((degree) => ({
        code: `UNITS-${degree.toUpperCase()}`,
        label: DEGREE_LABEL[degree],
        element: 'ia.units' as const,
        where: { degree },
        section: 'Housing units by degree of damage',
      })),
      {
        code: 'UNITS-TOTAL',
        label: 'Total damaged',
        element: 'ia.units',
        section: 'Housing units by degree of damage',
      },
      {
        code: 'UNITS-OWNER',
        label: 'Owner-occupied',
        element: 'ia.units',
        where: { tenure: 'owner' },
        section: 'Occupancy',
      },
      {
        code: 'UNITS-RENTER',
        label: 'Renter-occupied',
        element: 'ia.units',
        where: { tenure: 'renter' },
        section: 'Occupancy',
      },
      {
        code: 'UNITS-TEN-UNK',
        label: 'Occupancy unknown',
        element: 'ia.units',
        where: { tenure: 'unknown' },
        section: 'Occupancy',
      },
      {
        code: 'INSURED',
        label: 'Insured',
        element: 'ia.units',
        where: { insurance: 'insured' },
        section: 'Insurance',
      },
      {
        code: 'UNINSURED',
        label: 'Uninsured',
        element: 'ia.units',
        where: { insurance: 'uninsured' },
        section: 'Insurance',
      },
      {
        code: 'INS-UNK',
        label: 'Insurance unknown',
        element: 'ia.units',
        where: { insurance: 'unknown' },
        section: 'Insurance',
      },
      {
        code: 'PCT-INSURED',
        label: 'Percent insured (of known)',
        element: 'ia.percent_insured',
        section: 'Insurance',
      },
      {
        code: 'PCT-LOW-INC',
        label: 'Percent low income (below poverty, ACS)',
        element: 'area.poverty_pct',
        section: 'Affected area',
      },
      {
        code: 'POP',
        label: 'Population of affected tracts',
        element: 'area.population',
        section: 'Affected area',
      },
      {
        code: 'AGE65',
        label: 'Aged 65 and over (%)',
        element: 'area.age65_pct',
        section: 'Affected area',
      },
      {
        code: 'DISAB',
        label: 'With a disability (%)',
        element: 'area.disability_pct',
        section: 'Affected area',
      },
      ...FILTERS.apart.map((apart) => ({
        code: `APART-${apart}`,
        label: {
          selfReported: 'Self-reported, not verified',
          awaitingReview: 'Verified, awaiting review',
          inaccessible: 'Inaccessible',
          witness: 'Witness only',
          preExisting: 'Pre-existing damage',
          notPrimaryResidence: 'Not a primary residence',
          nonResidential: 'Not a home',
          noDamage: 'No damage',
          degreeNotSet: 'Degree not set',
        }[apart],
        element: 'ia.apart' as const,
        where: { apart },
        section: 'Not counted (shown apart)',
      })),
      { code: 'SHELTERS', label: 'Shelters open', element: 'shelter.open', section: 'People' },
      {
        code: 'SHELTERED',
        label: 'People in shelters',
        element: 'shelter.occupancy',
        section: 'People',
      },
      ...FILTERS.casualty.map((casualty) => ({
        code: casualty.toUpperCase(),
        label: casualty.charAt(0).toUpperCase() + casualty.slice(1),
        element: 'casualty.count' as const,
        where: { casualty },
        section: 'People',
      })),
      {
        code: 'OUTAGES',
        label: 'Outages open',
        element: 'outage.open',
        section: 'Utilities and services',
      },
      {
        code: 'OUTAGES-72',
        label: 'Outages longer than 72 hours',
        element: 'outage.over72',
        section: 'Utilities and services',
      },
      { code: 'AS-OF', label: 'Figures as of', element: 'event.as_of', section: 'Event' },
    ],
  },
  ia_tick_sheet: { fields: tick() },
  pa_site_sheet: {
    fields: [
      { code: 'APPLICANT', label: 'Applicant', element: 'site.applicant' },
      { code: 'SITE', label: 'Site name', element: 'site.name' },
      { code: 'DESC', label: 'Description of damage', element: 'site.description' },
      { code: 'CAT', label: 'Category of work', element: 'site.category' },
      { code: 'USNG', label: 'Location (US National Grid)', element: 'site.usng' },
      { code: 'COST', label: 'Cost estimate (USD)', element: 'site.cost' },
      { code: 'BASIS', label: 'Estimate or verified', element: 'site.cost_basis' },
      { code: 'PCT', label: 'Percent work complete', element: 'site.percent_complete' },
      { code: 'INS', label: 'Insured', element: 'site.insured' },
      {
        code: 'OFA',
        label: 'Another federal agency responsible',
        element: 'site.other_federal_agency',
      },
      { code: 'DEBRIS', label: 'Debris (cubic yards)', element: 'site.debris_cubic_yards' },
      { code: 'PHOTOS', label: 'Photos', element: 'site.photos' },
    ],
  },
  pa_cost_survey: {
    fields: [
      ...FILTERS.category.flatMap((category) => [
        {
          code: `${category}-SITES`,
          label: `${CATEGORY_LABEL[category]}: sites`,
          element: 'pa.sites' as const,
          where: { category },
          section: 'By category of work',
          row: CATEGORY_LABEL[category],
          column: 'Sites',
        },
        {
          code: `${category}-COST`,
          label: `${CATEGORY_LABEL[category]}: cost`,
          element: 'pa.cost' as const,
          where: { category },
          section: 'By category of work',
          row: CATEGORY_LABEL[category],
          column: 'Cost (USD)',
        },
      ]),
      { code: 'TOTAL', label: 'Total cost (USD)', element: 'pa.cost', section: 'Totals' },
      {
        code: 'VERIFIED',
        label: 'Verified cost (USD)',
        element: 'pa.verified_cost',
        section: 'Totals',
      },
      {
        code: 'CO-PERCAP',
        label: 'Countywide per-capita figure',
        element: 'pa.county_per_capita',
        section: 'Indicators',
      },
      {
        code: 'CO-IND',
        label: 'Countywide indicator',
        element: 'pa.county_threshold',
        section: 'Indicators',
      },
      {
        code: 'ST-PERCAP',
        label: 'Statewide per-capita figure',
        element: 'pa.state_per_capita',
        section: 'Indicators',
      },
      {
        code: 'ST-IND',
        label: 'Statewide indicator',
        element: 'pa.state_threshold',
        section: 'Indicators',
      },
      {
        code: 'FY',
        label: 'Federal fiscal year',
        element: 'pa.fiscal_year',
        section: 'Indicators',
      },
      {
        code: 'VOL-HRS',
        label: 'Volunteer hours donated',
        element: 'donated.volunteer_hours',
        section: 'Credits',
      },
    ],
  },
  form_010_0_13: {
    fields: [
      {
        code: 'BOX7-TYPE',
        label: 'Box 7: incident type',
        element: 'declaration.incident_type',
        section: 'Box 7',
      },
      {
        code: 'BOX7-PERIOD',
        label: 'Box 7: incident period',
        element: 'declaration.incident_period',
        section: 'Box 7',
      },
      {
        code: 'BOX8',
        label: 'Box 8: the incident and its effects (draft)',
        element: 'declaration.box8',
        section: 'Box 8',
      },
      {
        code: 'BOX9',
        label: 'Box 9: resources committed (draft)',
        element: 'declaration.box9',
        section: 'Box 9',
      },
      {
        code: 'BOX10-DATES',
        label: 'Box 10: joint PDA dates',
        element: 'joint_pda.dates',
        section: 'Box 10',
      },
      {
        code: 'BOX10-AREAS',
        label: 'Box 10: joint PDA areas',
        element: 'joint_pda.areas',
        section: 'Box 10',
      },
      {
        code: 'BOX11',
        label: 'Box 11: areas and programs requested',
        element: 'declaration.requested_areas',
        section: 'Box 11',
      },
      ...FILTERS.degree.map((degree) => ({
        code: `ENC-A-${degree.toUpperCase()}`,
        label: `${DEGREE_LABEL[degree]} housing units`,
        element: 'ia.units' as const,
        where: { degree },
        section: 'Enclosure A: Individual Assistance',
      })),
      {
        code: 'ENC-A-INS',
        label: 'Percent insured (of known)',
        element: 'ia.percent_insured',
        section: 'Enclosure A: Individual Assistance',
      },
      {
        code: 'ENC-A-POV',
        label: 'Percent below poverty (ACS)',
        element: 'area.poverty_pct',
        section: 'Enclosure A: Individual Assistance',
      },
      {
        code: 'ENC-A-POP',
        label: 'Population of affected tracts',
        element: 'area.population',
        section: 'Enclosure A: Individual Assistance',
      },
      {
        code: 'ENC-B-TOTAL',
        label: 'Public damage cost (USD)',
        element: 'pa.cost',
        section: 'Enclosure B: Public Assistance',
      },
      {
        code: 'ENC-B-CO-IND',
        label: 'Countywide indicator (USD)',
        element: 'pa.county_threshold',
        section: 'Enclosure B: Public Assistance',
      },
      {
        code: 'ENC-B-ST-IND',
        label: 'Statewide indicator (USD)',
        element: 'pa.state_threshold',
        section: 'Enclosure B: Public Assistance',
      },
    ],
  },
  pda_gis_layer: {
    // Property names a FEMA field validation layer can take (FACT, ArcGIS Field Maps).
    fields: [
      { code: 'RecordID', label: 'Record', element: 'record.ref' },
      { code: 'Status', label: 'Status', element: 'home.status' },
      { code: 'USNG', label: 'US National Grid (100 m)', element: 'location.usng' },
      { code: 'County', label: 'Jurisdiction', element: 'location.jurisdiction' },
      { code: 'ZIP', label: 'ZIP code', element: 'location.postal' },
      { code: 'TractGEOID', label: 'Census tract', element: 'location.tract' },
      { code: 'StructType', label: 'Structure type', element: 'home.type' },
      { code: 'Units', label: 'Units', element: 'home.units' },
      { code: 'Occupancy', label: 'Owner or renter', element: 'home.occupancy' },
      { code: 'PrimaryRes', label: 'Primary residence', element: 'home.primary_residence' },
      { code: 'DmgLevel', label: 'Degree of damage', element: 'home.degree' },
      { code: 'Inaccess', label: 'Inaccessible', element: 'home.inaccessible' },
      { code: 'InaccRsn', label: 'Reason inaccessible', element: 'home.inaccessible_reason' },
      { code: 'Insured', label: 'Insured', element: 'home.insured' },
      { code: 'WtrBsmt', label: 'Water depth: basement', element: 'home.water_depth_basement' },
      {
        code: 'WtrFlr1',
        label: 'Water depth: first floor',
        element: 'home.water_depth_first_floor',
      },
      { code: 'Verified', label: 'Verification', element: 'home.verification' },
      { code: 'AssessDate', label: 'Date of assessment', element: 'home.assessed_on' },
    ],
  },
};

export const SHIPPED: Record<FormKey, Mapping> = Object.fromEntries(
  (Object.keys(fields) as FormKey[]).map((form) => [
    form,
    {
      form,
      femaFormVersion: FEMA_V1,
      mappingVersion: 1,
      sourceDocument: SOURCE,
      ...fields[form],
    },
  ]),
) as Record<FormKey, Mapping>;
