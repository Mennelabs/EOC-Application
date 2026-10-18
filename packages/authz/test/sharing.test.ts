/**
 * Minimum-field sharing rules (NED-04, NED-05, AC-17C, FL-03): each service
 * gets its table row and nothing more; consent and a signed agreement are
 * both needed; withdrawal removes every grant; the projection carries only
 * the granted sections and keeps the household size as a band.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveGrants,
  householdBand,
  project,
  sectionsFor,
  type SharingAgreement,
  type SharingFacts,
} from '../src/sharing.ts';

const agreements: SharingAgreement[] = [
  {
    id: 'a-cleanup',
    toTenantId: 't-cleanup',
    orgType: 'volunteer_cleanup',
    service: 'cleanup',
    dataCategories: ['contact', 'location_exact'],
    signed: true,
  },
  {
    id: 'a-feeding',
    toTenantId: 't-canteen',
    orgType: 'relief_agencies',
    service: 'feeding',
    dataCategories: ['location_exact', 'household'],
    signed: true,
  },
  {
    id: 'a-shelter',
    toTenantId: 't-shelter',
    orgType: 'relief_agencies',
    service: 'shelter',
    dataCategories: ['contact', 'access_needs'],
    signed: true,
  },
  {
    id: 'a-legal',
    toTenantId: 't-legal',
    orgType: 'relief_agencies',
    service: 'legal',
    dataCategories: ['contact'],
    signed: true,
  },
  {
    id: 'a-coad',
    toTenantId: 't-coad',
    orgType: 'community_groups',
    service: 'coordination',
    dataCategories: [],
    signed: true,
  },
  {
    id: 'a-draft',
    toTenantId: 't-draft',
    orgType: 'faith_based',
    service: 'cleanup',
    dataCategories: ['contact'],
    signed: false,
  },
];
const consents = [
  { id: 'c1', orgType: 'volunteer_cleanup', granted: true },
  { id: 'c2', orgType: 'relief_agencies', granted: true },
  { id: 'c3', orgType: 'community_groups', granted: true },
  { id: 'c4', orgType: 'faith_based', granted: true },
];

describe('sectionsFor (NED-04 table)', () => {
  it('cuts each service to its row and to the agreement categories', () => {
    expect(sectionsFor('cleanup', ['contact', 'location_exact'], { needs: [] })).toEqual([
      'name',
      'contact',
      'contact_preference',
      'address_exact',
      'need',
    ]);
    expect(sectionsFor('cleanup', [], { needs: [] })).toEqual(['name', 'need']);
    expect(sectionsFor('feeding', ['household'], { needs: [] })).toEqual([
      'area',
      'household_band',
      'need',
    ]);
    expect(
      sectionsFor('counseling', ['contact', 'location_exact', 'household'], { needs: [] }),
    ).toEqual(['contact']);
    expect(sectionsFor('legal', ['contact'], { needs: [] })).toEqual(['name', 'contact']);
    expect(sectionsFor('coordination', ['contact', 'household'], { needs: [] })).toEqual([]);
  });

  it('FL-13, FL:FR-27: case management carries the case sections; the dollars only with the financial category', () => {
    expect(
      sectionsFor('case_management', ['contact', 'household', 'financial'], { needs: [] }),
    ).toEqual([
      'name',
      'contact',
      'contact_preference',
      'household_band',
      'need',
      'recovery_plan',
      'help_received',
      'appointments',
    ]);
    // The SBA table's agreement: contact and the dollars, nothing about the home or household.
    expect(sectionsFor('case_management', ['contact', 'financial'], { needs: [] })).toEqual([
      'name',
      'contact',
      'contact_preference',
      'need',
      'recovery_plan',
      'help_received',
      'appointments',
    ]);
    // Without the financial category the partner sees that help was given, never how much.
    expect(sectionsFor('case_management', [], { needs: [] })).toEqual([
      'name',
      'need',
      'recovery_plan',
    ]);
    // The live sections never enter the projection: nothing is copied out of the case.
    const p = project(['recovery_plan', 'help_received', 'appointments', 'need'], {
      name: 'Exercise Person',
      contact: { phone: '+15555550100' },
      address: null,
      householdSize: 3,
      needs: [{ id: 'n1', category: 'cleanup_tarp', status: 'open' }],
      accessNeeds: null,
    });
    expect(Object.keys(p.clear)).toEqual(['needs']);
    expect(p.restricted).toEqual({});
  });

  it('shelter gets access needs only when the resident asked for shelter', () => {
    expect(sectionsFor('shelter', ['contact', 'access_needs'], { needs: ['food_water'] })).toEqual([
      'contact',
      'need',
    ]);
    expect(
      sectionsFor('shelter', ['contact', 'access_needs'], { needs: ['shelter_tonight'] }),
    ).toEqual(['contact', 'need', 'access_needs']);
    expect(sectionsFor('shelter', ['contact'], { needs: ['shelter_tonight'] })).toEqual([
      'contact',
      'need',
    ]);
  });
});

describe('deriveGrants', () => {
  it('needs consent for the organization type and a signed agreement with sections', () => {
    const grants = deriveGrants(agreements, consents, {
      needs: ['shelter_tonight'],
      withdrawn: false,
    });
    expect(grants.map((g) => [g.toTenantId, g.sections.join(',')])).toEqual([
      ['t-cleanup', 'name,contact,contact_preference,address_exact,need'],
      ['t-canteen', 'area,household_band,need'],
      ['t-shelter', 'contact,need,access_needs'],
      ['t-legal', 'name,contact'],
    ]);
    expect(grants.find((g) => g.toTenantId === 't-coad')).toBeUndefined(); // nothing to share
    expect(grants.find((g) => g.toTenantId === 't-draft')).toBeUndefined(); // not signed
    expect(grants[0]!.consentId).toBe('c1');
    expect(grants[1]!.consentId).toBe('c2');
  });

  it('a withdrawn consent or a withdrawn report leaves nothing (NED-05)', () => {
    const partial = consents.map((c) =>
      c.orgType === 'relief_agencies' ? { ...c, granted: false } : c,
    );
    expect(
      deriveGrants(agreements, partial, { needs: [], withdrawn: false }).map((g) => g.toTenantId),
    ).toEqual(['t-cleanup']);
    expect(deriveGrants(agreements, consents, { needs: [], withdrawn: true })).toEqual([]);
  });
});

describe('project', () => {
  const facts: SharingFacts = {
    name: 'Rosa Delgado',
    contact: { phone: '+13145550177', email: 'rosa@example.org', preferred: 'text' },
    address: { line1: '12 Elm St', city: 'Westwind', state: 'MO', postal: '63001', unit: null },
    householdSize: 5,
    needs: [{ id: 'n1', category: 'shelter_tonight', status: 'open' }],
    accessNeeds: ['mobility'],
  };

  it('cleanup: name and contact encrypted, address and preference clear, no household', () => {
    const p = project(['name', 'contact', 'contact_preference', 'address_exact', 'need'], facts);
    expect(p.restricted).toEqual({
      name: 'Rosa Delgado',
      contact: { phone: '+13145550177', email: 'rosa@example.org' },
    });
    expect(p.clear).toEqual({
      contactPreference: 'text',
      address: { line1: '12 Elm St', city: 'Westwind', state: 'MO', postal: '63001' },
      needs: [{ id: 'n1', category: 'shelter_tonight', status: 'open' }],
    });
  });

  it('feeding: area and a band, never the street, the name or the number', () => {
    const p = project(['area', 'household_band', 'need'], facts);
    expect(p.restricted).toEqual({});
    expect(p.clear).toEqual({
      area: { city: 'Westwind', postal: '63001' },
      householdBand: '5-7',
      needs: [{ id: 'n1', category: 'shelter_tonight', status: 'open' }],
    });
  });

  it('shelter: access needs ride encrypted; empty facts leave the key out', () => {
    expect(project(['contact', 'access_needs'], facts).restricted).toEqual({
      contact: { phone: '+13145550177', email: 'rosa@example.org' },
      accessNeeds: ['mobility'],
    });
    expect(
      project(['contact', 'access_needs'], { ...facts, contact: null, accessNeeds: [] }),
    ).toEqual({ clear: {}, restricted: {} });
  });

  it('household bands', () => {
    expect([0, 1, 2, 3, 4, 5, 7, 8, 40].map(householdBand)).toEqual([
      null,
      '1-2',
      '1-2',
      '3-4',
      '3-4',
      '5-7',
      '5-7',
      '8+',
      '8+',
    ]);
    expect(householdBand(null)).toBeNull();
  });
});
