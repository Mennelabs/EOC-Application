/**
 * Reviewer agreement with the AI severity suggestion (layer-7 task I; PHO-13
 * as decided 2026-10-15): per model version, overall and by hazard, home
 * type and income band; a group is behind only with enough decisions and
 * more than the margin under the model's overall agreement; unknown groups
 * are reported and never alerted.
 */
import { describe, expect, it } from 'vitest';
import { agreementByModel, type AgreementRow } from '../src/agreement.ts';

const rows = (n: number, agreed: number, r: Partial<AgreementRow> = {}): AgreementRow[] =>
  Array.from({ length: n }, (_, i) => ({
    model: 'openai / gpt-5 / severity-1',
    hazard: 'flood',
    homeType: 'conventional',
    incomeBand: 3,
    agreed: i < agreed,
    ...r,
  }));

describe('agreementByModel', () => {
  it('reports each model version apart, overall and per group', () => {
    const out = agreementByModel([
      ...rows(4, 3),
      ...rows(2, 2, { model: 'openai / gpt-5 / severity-2', hazard: 'wind' }),
    ]);
    expect(out.map((m) => [m.model, m.decisions, m.agreed, m.rate])).toEqual([
      ['openai / gpt-5 / severity-1', 4, 3, 0.75],
      ['openai / gpt-5 / severity-2', 2, 2, 1],
    ]);
    expect(out[0]!.slices).toEqual([
      { dimension: 'hazard', group: 'flood', decisions: 4, agreed: 3, rate: 0.75, behind: false },
      {
        dimension: 'home_type',
        group: 'conventional',
        decisions: 4,
        agreed: 3,
        rate: 0.75,
        behind: false,
      },
      {
        dimension: 'income_band',
        group: 'band 3',
        decisions: 4,
        agreed: 3,
        rate: 0.75,
        behind: false,
      },
    ]);
  });

  it('PHO-13: a group with enough decisions more than the margin behind is behind', () => {
    // Overall 70/100 = 0.7; manufactured 10/30 = 0.33, conventional 60/70 = 0.86.
    const out = agreementByModel([
      ...rows(70, 60),
      ...rows(30, 10, { homeType: 'manufactured', incomeBand: 1 }),
    ]);
    const behind = out[0]!.slices.filter((s) => s.behind).map((s) => `${s.dimension}:${s.group}`);
    expect(behind).toEqual(['home_type:manufactured', 'income_band:band 1']);
  });

  it('too few decisions, or within the margin, is not behind', () => {
    // 19 decisions at 0% is under the default minimum of 20.
    const few = agreementByModel([...rows(81, 81), ...rows(19, 0, { hazard: 'wind' })]);
    expect(few[0]!.slices.some((s) => s.behind)).toBe(false);
    // Overall 80/100 = 0.8; wind at 14/20 = 0.7 sits exactly on the margin and is not behind.
    const edge = agreementByModel([...rows(80, 66), ...rows(20, 14, { hazard: 'wind' })]);
    expect(edge[0]!.rate).toBe(0.8);
    expect(edge[0]!.slices.find((s) => s.group === 'wind')!.behind).toBe(false);
    // One fewer agreement in the group puts it behind.
    const under = agreementByModel([...rows(80, 67), ...rows(20, 13, { hazard: 'wind' })]);
    expect(under[0]!.slices.find((s) => s.group === 'wind')!.behind).toBe(true);
    // A smaller minimum and margin are the county's to set.
    const strict = agreementByModel([...rows(81, 81), ...rows(19, 0, { hazard: 'wind' })], {
      minimum: 5,
      margin: 0.05,
    });
    expect(strict[0]!.slices.find((s) => s.group === 'wind')!.behind).toBe(true);
  });

  it('unknown hazard, home type or band is shown and never called behind', () => {
    const out = agreementByModel([
      ...rows(40, 40),
      ...rows(30, 0, { hazard: null, homeType: null, incomeBand: null }),
    ]);
    const unknown = out[0]!.slices.filter((s) => s.group === 'unknown');
    expect(unknown.map((s) => [s.dimension, s.decisions, s.behind])).toEqual([
      ['hazard', 30, false],
      ['home_type', 30, false],
      ['income_band', 30, false],
    ]);
  });
});
