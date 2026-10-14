/**
 * SEC-12 guard on the platform's data dictionary: the platform holds no
 * criminal-justice information, so no platform column may be classified
 * `cji`; the only trace of the enclave is the opaque mission reference.
 * A new column that carried CJI would have to be classified here first, and
 * this test fails the build when it is.
 */
import { describe, expect, it } from 'vitest';
import { dictionary } from '../src/dictionary.ts';

describe('platform data dictionary (SEC-12, SEC-11)', () => {
  it('classifies no platform column as criminal-justice information', () => {
    const cji = Object.entries(dictionary).flatMap(([table, cols]) =>
      Object.entries(cols)
        .filter(([, e]) => e.c === 'cji')
        .map(([column]) => `${table}.${column}`),
    );
    expect(cji).toEqual([]);
  });

  it('holds the enclave link only as an opaque reference on the mission', () => {
    const enclaveish = Object.entries(dictionary).flatMap(([table, cols]) =>
      Object.keys(cols)
        .filter((c) => /cji|enclave|bodycam|arrest|suspect/i.test(c))
        .map((c) => `${table}.${c}`),
    );
    expect(enclaveish.sort()).toEqual([
      'mission.cji_linked_at',
      'mission.cji_linked_by',
      'mission.cji_ref',
    ]);
  });
});
