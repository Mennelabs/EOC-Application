/**
 * Equity rules without a database (EQ-12, EQ-13, CON-07): small counts are
 * hidden, a gap needs the ratio and an hour, and every flag says what to do.
 */
import { describe, expect, it } from 'vitest';
import { EQUITY_DEFAULTS, bandLabel, hide, isGap, outreachFor } from '../src/equity.ts';

describe('equity rules', () => {
  it('EQ-13: counts from 1 to 10 are hidden; none and 11 or more are shown', () => {
    expect(EQUITY_DEFAULTS.minCell).toBe(11);
    expect(hide(0, 11)).toBe(0);
    for (const n of [1, 5, 10]) expect(hide(n, 11)).toBeNull();
    expect(hide(11, 11)).toBe(11);
  });

  it('EQ-12: a gap is over the ratio and at least an hour longer, even when the event median is zero', () => {
    expect(isGap(80, 0, 1.5)).toBe(true);
    expect(isGap(0.5, 0, 1.5)).toBe(false);
    expect(isGap(16, 10, 1.5)).toBe(true);
    expect(isGap(14, 10, 1.5)).toBe(false);
    expect(isGap(null, 10, 1.5)).toBe(false);
    expect(isGap(20, null, 1.5)).toBe(false);
  });

  it('every flag carries outreach a coordinator can act on', () => {
    expect(outreachFor('coverage', 'tract', 'tract 29999000300')).toContain('canvass');
    expect(outreachFor('review_gap', 'language', 'Spanish')).toContain('speak Spanish');
    expect(outreachFor('help_gap', 'tenure', 'Renter')).toContain('renters');
    expect(outreachFor('coverage', 'income_band', bandLabel(1))).toContain('Band 1');
  });
});
