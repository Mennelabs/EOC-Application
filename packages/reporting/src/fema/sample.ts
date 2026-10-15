/**
 * A synthetic package (SCL-12) for unit tests and the veraPDF sample: a
 * fictional county's homes run through the real counting rule and per-home
 * row builder, with every status and the DEC-17 details represented. No
 * database and no real data.
 */
import { classifyHomes, countDamage, type DamageRecord } from '../counting.ts';
import type { DeclarationData } from '../declaration.ts';
import { toHomeRow, type PackageData, type SiteRow } from './data.ts';

const base: Omit<DamageRecord, 'id' | 'parcelId' | 'addressKey'> = {
  kind: 'report',
  version: 1,
  reviewState: 'approved',
  verification: 'desktop_verified',
  degree: 'minor',
  relationship: 'own_home',
  primaryResidence: true,
  preExisting: false,
  withdrawn: false,
  duplicateOf: null,
  reportId: null,
  homeType: 'single_family',
  units: 1,
  wholeBuilding: false,
  tenure: 'owner',
  insurance: 'insured',
  locationId: null,
  tractGeoid: '29999000100',
  inaccessibleReason: null,
  at: '2026-10-12T15:00:00.000Z',
};

const DEGREES = ['affected', 'minor', 'major', 'destroyed'] as const;

export function sampleRecords(): DamageRecord[] {
  const out: DamageRecord[] = [];
  const add = (i: number, over: Partial<DamageRecord>) =>
    out.push({
      ...base,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      parcelId: `SYN-${i}`,
      addressKey: `${i} exercise road|29999`,
      ...over,
    });
  for (let i = 1; i <= 40; i++)
    add(i, {
      degree: DEGREES[i % 4]!,
      tenure: i % 3 === 0 ? 'renter' : i % 7 === 0 ? 'unknown' : 'owner',
      insurance: i % 5 === 0 ? 'uninsured' : i % 6 === 0 ? 'unknown' : 'insured',
      homeType: i % 9 === 0 ? 'manufactured' : 'single_family',
      verification: i % 4 === 0 ? 'field_verified' : 'desktop_verified',
      kind: i % 4 === 0 ? 'assessment' : 'report',
      tractGeoid: i % 2 ? '29999000100' : '29999000200',
    });
  add(41, {
    homeType: 'multi_family',
    wholeBuilding: true,
    units: 12,
    relationship: 'organization',
    kind: 'assessment',
    degree: 'major',
  });
  add(42, { verification: 'self_reported', reviewState: 'submitted' });
  add(43, {
    verification: 'cannot_verify',
    reviewState: 'under_review',
    inaccessibleReason: 'private_road_or_bridge',
  });
  add(44, { relationship: 'witness' });
  add(45, { preExisting: true });
  add(46, { primaryResidence: false });
  add(47, { homeType: 'non_residential', degree: 'major' });
  add(48, { degree: 'no_damage' });
  add(49, { reviewState: 'under_review' });
  return out;
}

export function samplePackageData(): PackageData {
  const records = sampleRecords();
  const damage = countDamage(records);
  const homes = classifyHomes(records).homes.map((h, i) =>
    toHomeRow(
      h,
      {
        lat: 38.79 + i * 0.0011,
        lon: -90.87 - i * 0.0007,
        postal: i % 2 ? '63399' : '63398',
        jurisdiction: i % 2 ? 'Harmon City' : 'Westwind County',
        insurance: h.record.insurance === 'insured' ? ['home_or_renters', 'flood'] : ['none'],
        utilities: h.record.kind === 'assessment' ? 'yes' : ['electricity', 'water'],
        observations:
          h.record.kind === 'assessment'
            ? { flood_depth_basement_in: 70, flood_depth_first_floor_in: 8, utilities_out: 'yes' }
            : null,
      },
      h.record.tractGeoid === '29999000100' ? 18.2 : 9.4,
      'America/Chicago',
    ),
  );
  const sites: SiteRow[] = [
    {
      point: [-90.861, 38.801],
      values: {
        'site.applicant': 'Exercise Public Works',
        'site.name': 'Exercise culvert, Route 9',
        'site.category': 'C',
        'site.cost': 125000,
        'site.cost_basis': 'Verified',
        'site.percent_complete': 10,
        'site.insured': 'No',
        'site.other_federal_agency': 'No',
        'site.photos': 2,
      },
    },
    {
      point: [-90.85, 38.81],
      values: {
        'site.applicant': 'Exercise County',
        'site.name': 'Exercise debris, river parks',
        'site.category': 'A',
        'site.cost': 42000,
        'site.cost_basis': 'Estimate',
        'site.percent_complete': null,
        'site.insured': null,
        'site.debris_cubic_yards': 900,
        'site.photos': 0,
      },
    },
  ];
  const declaration = {
    eventId: 'sample',
    asOf: '2026-10-14T18:00:00.000Z',
    declaration: {
      id: 'sample',
      version: 1,
      incidentType: 'Severe storms and flooding (exercise)',
      incidentStart: '2026-10-10',
      incidentEnd: '2026-10-12',
      requestedAreas: [{ name: 'Westwind County', programs: ['IA', 'PA'] }],
      box8Draft: 'Exercise: river flooding damaged homes in two tracts.',
      box9Draft: 'Exercise: county crews and VOAD partners committed.',
      reviewLabel: 'Draft for state review',
      updatedAt: '2026-10-14T17:00:00.000Z',
    },
    clock: { incidentEnd: '2026-10-12', deadline: '2026-11-11', daysLeft: 28, overdue: false },
    damage: {
      counted: { ...damage.counted, recordIds: undefined },
      shownSeparately: damage.shownSeparately,
      merged: damage.merged,
      excluded: damage.excluded,
    },
    profile: {
      eventId: 'sample',
      basis: 'reports',
      tracts: null,
      profiles: null,
      items: [],
      missing: [],
      total: {
        tracts: 2,
        population: 8120,
        households: 3301,
        renterHouseholds: 1102,
        povertyPct: 14.1,
        snapHouseholdsPct: 11.0,
        ssiHouseholdsPct: 5.2,
        age65Pct: 17.9,
        disabilityPct: 13.4,
        limitedEnglishHouseholds: 96,
        noVehicleHouseholds: 210,
      },
    },
    outages: {
      items: [
        {
          id: 'o1',
          version: 1,
          kind: 'water',
          facilitySourceId: null,
          facilityName: 'Exercise pump station',
          description: null,
          area: 'North river district',
          customersOut: 1200,
          startedAt: '2026-10-10T12:00:00.000Z',
          expectedRestorationAt: null,
          restoredAt: null,
          source: 'staff',
          confirmed: true,
          hoursOut: 102,
          over72Hours: true,
        },
      ],
      open: 1,
      over72Hours: 1,
      unconfirmed: 0,
    },
    casualties: {
      injured: {
        count: 3,
        officialSource: 'Exercise: county medical examiner',
        asOf: '2026-10-13T12:00:00.000Z',
        entries: 1,
      },
      missing: null,
      deceased: null,
    },
    publicAssistance: {
      sites: 2,
      byCategory: {},
      totalCost: 167000,
      verifiedCost: 125000,
      indicators: {
        statewidePerCapita: 1.89,
        countywidePerCapita: 4.72,
        statePopulation: 6200000,
        fiscalYear: 'FY2026 (exercise)',
        countyPopulation: 8120,
        countyThreshold: 38326.4,
        stateThreshold: 11718000,
        meetsCounty: true,
        meetsState: false,
      },
    },
    donated: {
      volunteerHours: 46,
      includesOpenShifts: false,
      byOrganization: [{ organization: 'Exercise VOAD', hours: 46, people: 5 }],
    },
  } as unknown as DeclarationData;
  return {
    event: {
      id: 'sample',
      name: 'Exercise WESTWIND flood',
      tenantName: 'Westwind County (exercise)',
      timeZone: 'America/Chicago',
    },
    jurisdiction: null,
    asOf: '2026-10-14T18:00:00.000Z',
    declaration,
    damage,
    homes,
    sites,
    shelters: { open: 1, occupancy: 37 },
    jointPda: { dates: null, areas: null },
    photos: [
      {
        choiceId: 'sample-1',
        photoId: 'sample-1',
        reviewKey: 'sample/review.webp',
        caption: 'Exercise: water line about three feet up a living room wall.',
        subject: 'home',
        place: {
          usng: '15S YC 012 345',
          postal: '63399',
          tract: '29999000100',
          jurisdiction: 'Harmon City',
          site: null,
        },
      },
      {
        choiceId: 'sample-2',
        photoId: 'sample-2',
        reviewKey: 'sample/review2.webp',
        caption: 'Exercise: culvert washed out under Route 9.',
        subject: 'public_site',
        place: {
          usng: '15S YC 0123 3456',
          postal: null,
          tract: null,
          jurisdiction: null,
          site: 'Exercise culvert, Route 9',
        },
      },
    ],
    photosLeftOut: 0,
  };
}
