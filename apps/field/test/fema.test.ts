/**
 * The FEMA details on the assessment screen (DCL:DEC-17): only questions that
 * fit the home are saved, blanks stay unrecorded, values that are not a depth
 * or a count are named back, and "none" or "not sure" stand alone.
 */
import { describe, expect, it } from 'vitest';
import { emptyFema, femaObservations, femaQuestions, toggleInsurance } from '../src/fema.ts';
import { allKeys } from '../src/i18n.ts';

const label = (l: string) => l;

describe('FEMA details on the assessment screen', () => {
  it('saves nothing when nothing is filled in (unknown is never zero)', () => {
    expect(femaObservations(emptyFema(), 'single_family', false, label)).toEqual({
      observations: {},
      problems: [],
    });
  });

  it('saves depth in inches, household answers and utilities for a house', () => {
    const s = emptyFema();
    s.depth.basement = { feet: '5', inches: '10' };
    s.depth.first_floor = { feet: '', inches: '6' };
    s.occupancy = 'rent';
    s.insurance = ['flood', 'sewer_backup'];
    s.utilitiesOut = 'yes';
    s.units = '12'; // not asked for a house
    s.employees = '4'; // not asked for a house
    expect(femaObservations(s, 'single_family', false, label)).toEqual({
      observations: {
        flood_depth_basement_in: 70,
        flood_depth_first_floor_in: 6,
        occupancy: 'rent',
        insurance: ['flood', 'sewer_backup'],
        utilities_out: 'yes',
      },
      problems: [],
    });
  });

  it('asks units for apartment buildings, business details for businesses, tribal ownership only where the county asks', () => {
    expect(femaQuestions('apartment_building', false)).toMatchObject({
      units: true,
      business: false,
    });
    expect(femaQuestions('commercial', true)).toEqual({
      units: false,
      household: false,
      business: true,
      tribal: true,
    });
    const s = emptyFema();
    s.units = '24';
    s.tribal = 'tribe';
    expect(femaObservations(s, 'apartment_building', false, label).observations).toEqual({
      units: 24,
    });
    expect(femaObservations(s, 'apartment_building', true, label).observations).toEqual({
      units: 24,
      tribal_ownership: 'tribe',
    });
    const b = emptyFema();
    b.employees = '15';
    b.daysClosed = '30';
    expect(femaObservations(b, 'commercial', false, label).observations).toEqual({
      business_employees: 15,
      business_days_closed: 30,
    });
  });

  it('names what is not a depth or a count instead of saving it', () => {
    const s = emptyFema();
    s.depth.crawl_space = { feet: '1', inches: '14' };
    s.units = '0';
    const r = femaObservations(s, 'apartment_building', false, (l) => `place:${l}`);
    expect(r.problems).toEqual([
      { key: 'fema.depth.invalid', params: { where: 'place:crawl_space' } },
      { key: 'fema.units.invalid' },
    ]);
    expect(r.observations).toEqual({});
    const b = emptyFema();
    b.daysClosed = '9999';
    expect(femaObservations(b, 'commercial', false, label).problems).toEqual([
      { key: 'fema.daysClosed.invalid' },
    ]);
  });

  it('keeps "no insurance" and "not sure" on their own', () => {
    expect(toggleInsurance(['flood'], 'none')).toEqual(['none']);
    expect(toggleInsurance(['none'], 'flood')).toEqual(['flood']);
    expect(toggleInsurance(['flood', 'condo'], 'flood')).toEqual(['condo']);
    expect(toggleInsurance(['not_sure'], 'none')).toEqual(['none']);
  });

  it('every problem key is a translated string', () => {
    const keys = new Set<string>(allKeys());
    for (const k of [
      'fema.depth.invalid',
      'fema.units.invalid',
      'fema.employees.invalid',
      'fema.daysClosed.invalid',
    ])
      expect(keys.has(k), k).toBe(true);
  });
});
