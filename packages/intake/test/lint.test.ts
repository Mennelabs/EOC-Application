/** INT-08, INT-09, INT-17, INT-18: string rules measured in CI. */
import { describe, expect, it } from 'vitest';
import { gradeTable, lintGraph, lintText, readingGrade, westwindGraph } from '../src/index.ts';

describe('reading grade', () => {
  it('scores plain questions low and jargon high', () => {
    expect(readingGrade('What kind of home is it?')).toBeLessThanOrEqual(2);
    expect(
      readingGrade('Is the residence habitable following the meteorological event?'),
    ).toBeGreaterThan(8);
  });
});

describe('default graph strings', () => {
  it('every prompt is at or below grade 5 and no string breaks the tone rules', () => {
    const findings = lintGraph(westwindGraph);
    expect(
      findings.map((f) => `${f.nodeId} ${f.field} [${f.locale}] ${f.rule}: ${f.detail}`),
    ).toEqual([]);
    for (const row of gradeTable(westwindGraph)) expect(row.grade, row.id).toBeLessThanOrEqual(5);
  });

  it('flags exclamation marks, emoji, blame and FEMA jargon', () => {
    const out: ReturnType<typeof lintGraph> = [];
    lintText('x', 'prompt', 'en', 'Great job!', 5, out);
    lintText('x', 'prompt', 'en', 'Why did you not evacuate?', 5, out);
    lintText('x', 'prompt', 'en', 'Is the dwelling habitable?', 5, out);
    lintText('x', 'prompt', 'en', 'Nice 🎉', 5, out);
    expect(out.map((f) => f.rule)).toEqual(
      expect.arrayContaining(['exclamation', 'blame', 'jargon', 'emoji']),
    );
    const es: ReturnType<typeof lintGraph> = [];
    lintText('x', 'prompt', 'es', '¡Hola!', null, es);
    expect(es[0]?.rule).toBe('exclamation');
  });
});
