/**
 * FEMA form mappings (DCL:DEC-12, DEC-13, DEC-15): every shipped version-1
 * mapping is valid against the vocabulary; a mapping naming an element that
 * does not exist, a slice the element cannot take, a value that is not in
 * the slice, an element of the wrong grain, or a repeated code is refused;
 * and no element in the vocabulary is a personal detail.
 */
import { describe, expect, it } from 'vitest';
import {
  ELEMENTS,
  FORM_KEYS,
  FORMS,
  SHIPPED,
  validateMapping,
  type MappingField,
} from '../src/fema/index.ts';

describe('FEMA form mappings', () => {
  it('ships a valid version 1 of every form', () => {
    for (const form of FORM_KEYS) {
      const m = SHIPPED[form];
      expect(m.mappingVersion, form).toBe(1);
      expect(validateMapping(form, m.fields), form).toEqual([]);
    }
    expect(FORM_KEYS).toHaveLength(10);
  });

  it('draws the insurance matrix and tick sheet as full grids', () => {
    const cells = (form: 'home_insurance_matrix' | 'ia_tick_sheet') => SHIPPED[form].fields;
    expect(cells('home_insurance_matrix')).toHaveLength(4 * 2 * 3);
    expect(cells('ia_tick_sheet')).toHaveLength(5 * 4);
    expect(cells('home_insurance_matrix').every((f) => f.row && f.column)).toBe(true);
  });

  it('refuses what cannot be exported', () => {
    const ok: MappingField = {
      code: 'A',
      label: 'Major',
      element: 'ia.units',
      where: { degree: 'major' },
    };
    const cases: [MappingField[], RegExp][] = [
      [[{ ...ok, element: 'resident.name' as never }], /not a data element/],
      [[{ ...ok, where: { category: 'A' } }], /cannot be narrowed by category/],
      [[{ ...ok, where: { degree: 'catastrophic' as never } }], /not a degree/],
      [[{ ...ok, element: 'home.degree' }], /describes one home/],
      [[ok, { ...ok, label: 'Again' }], /used twice/],
      [[{ ...ok, row: 'Major' }], /both a row and a column/],
      [[], /at least one field/],
    ];
    for (const [fields, message] of cases)
      expect(
        validateMapping('ia_summary_sheet', fields)
          .map((p) => p.message)
          .join(' '),
      ).toMatch(message);
    expect(validateMapping('ia_summary_sheet', [ok])).toEqual([]);
  });

  it('DEC-13: offers no personal detail to map', () => {
    const keys = Object.keys(ELEMENTS).join(' ');
    // Site and event names are public; nothing about a resident is in the vocabulary.
    expect(keys).not.toMatch(/phone|email|address|line1|birth|ssn|resident\./i);
    // Locations are generalized: the 100 m grid cell, ZIP, tract and jurisdiction.
    expect(ELEMENTS['location.usng'].description).toMatch(/100 m/);
    for (const form of FORM_KEYS) expect(FORMS[form].title.length).toBeGreaterThan(0);
  });
});
