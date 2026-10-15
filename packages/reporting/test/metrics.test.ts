/**
 * The metrics engine's pure parts (BRD:FR-14.02/04/05/06, BRD:DEC-15):
 * medians, operational periods at 07:00 and 19:00 local across a daylight
 * saving change, the CSV naming each figure's definition, scope and
 * generation time with the formula guard, and the PDF.
 */
import { describe, expect, it } from 'vitest';
import { renderPdf } from '@cg/pdf';
import { median, metricsCsv, metricsPdf, operationalPeriods, zonedTime } from '../src/metrics.ts';
import { sampleMetrics } from '../src/metrics-sample.ts';

describe('metrics', () => {
  it('medians round to a tenth; none is unknown, not zero', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 9, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([0.04, 0.05])).toBe(0);
  });

  it('BRD:DEC-15: operational periods start at 07:00 and 19:00 local, across a clock change', () => {
    // US daylight saving ends 2026-11-01 at 02:00 Central.
    expect(zonedTime(2026, 10, 31, 19, 'America/Chicago').toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(zonedTime(2026, 11, 1, 7, 'America/Chicago').toISOString()).toBe(
      '2026-11-01T13:00:00.000Z',
    );
    const p = operationalPeriods(
      new Date('2026-10-31T15:00:00Z'),
      new Date('2026-11-02T00:00:00Z'),
      'America/Chicago',
    );
    expect(p.map((x) => x.from.toISOString())).toEqual([
      '2026-10-31T15:00:00.000Z', // the start of the range, mid-period
      '2026-11-01T00:00:00.000Z', // 19:00 CDT
      '2026-11-01T13:00:00.000Z', // 07:00 CST, after a 13-hour night
    ]);
    expect(p.at(-1)!.to.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(p[1]!.to.getTime() - p[1]!.from.getTime()).toBe(13 * 3_600_000);
  });

  it('BRD:FR-14.05/06: every CSV row names its definition, scope and time; text cannot run as a formula', () => {
    const csv = metricsCsv(sampleMetrics()).replace(/^\uFEFF/, '');
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(
      'group,metric,part,value,unit,left_out,left_out_reason,definition,definition_version,period_from,period_to,time_zone,generated_at',
    );
    expect(lines[1]).toContain('damage.units,shipped 1,2026-10-13T12:00:00.000Z');
    expect(lines[1]).toContain('2026-10-15T00:05:00.000Z');
    // A breakdown label that looks like a formula stays text.
    expect(csv).toContain("'=Minor");
    // Unknown is a word, never 0; what was left out says so.
    expect(csv).toMatch(
      /Median time to first review,Total,6,hours,5,reports with no review decision yet/,
    );
    expect(csv).toMatch(/,Total,Unknown,/);
  });

  it('BRD:FR-14.06: the same figures as an accessible PDF', async () => {
    const model = metricsPdf(sampleMetrics(), {
      productName: 'Test Product',
      eventName: 'Exercise WESTWIND flood',
      countyName: 'Westwind County (exercise)',
    });
    expect(model.blocks.filter((b) => b.kind === 'table').length).toBeGreaterThan(3);
    const pdf = await renderPdf(model);
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.7');
  });
});
