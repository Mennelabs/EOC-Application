import { describe, expect, it } from 'vitest';
import { cantReachReasonOf, feetAndInches, toInches } from '../src/fema.ts';

describe('FEMA per-home details (DCL:DEC-17)', () => {
  it('reads feet and inches as whole inches; blank is not measured', () => {
    expect(toInches('5', '10')).toBe(70);
    expect(toInches('', '8')).toBe(8);
    expect(toInches('2', '')).toBe(24);
    expect(toInches(' ', '')).toBeNull();
    expect(feetAndInches(70)).toEqual({ feet: 5, inches: 10 });
  });

  it('refuses what is not a depth instead of guessing', () => {
    for (const [f, i] of [
      ['-1', '0'],
      ['1', '12'],
      ['1.5', '0'],
      ['abc', ''],
      ['51', '0'],
    ] as const)
      expect(toInches(f, i), `${f} ft ${i} in`).toBe('invalid');
    expect(toInches('50', '0')).toBe(600);
  });

  it('puts resident access answers and field reasons in one vocabulary (public vs private road or bridge)', () => {
    expect(cantReachReasonOf('no_private_road')).toBe('private_road_or_bridge');
    expect(cantReachReasonOf('no_public_road')).toBe('public_road_or_bridge');
    expect(cantReachReasonOf('debris')).toBe('debris');
    expect(cantReachReasonOf('yes')).toBeNull();
    expect(cantReachReasonOf(undefined)).toBeNull();
  });
});
