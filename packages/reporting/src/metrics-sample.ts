/**
 * A synthetic metrics result (SCL-12) for unit tests and the veraPDF sample:
 * every shipped metric with a made-up value, one unknown, one with records
 * left out, and a breakdown label that looks like a formula.
 */
import { METRICS, METRIC_KEYS, type MetricsResult } from './metrics.ts';

export function sampleMetrics(): MetricsResult {
  return {
    scope: {
      eventId: 'sample',
      from: '2026-10-13T12:00:00.000Z',
      to: '2026-10-15T00:00:00.000Z',
      timeZone: 'America/Chicago',
      filters: {},
    },
    generatedAt: '2026-10-15T00:05:00.000Z',
    metrics: METRIC_KEYS.map((k, i) => ({
      key: k,
      group: METRICS[k].group,
      title: METRICS[k].title,
      unit: METRICS[k].unit,
      value: i === 3 ? null : i * 3,
      parts: i === 0 ? [{ key: 'minor', label: '=Minor', value: 4 }] : [],
      incomplete: i === 2 ? { count: 5, note: 'reports with no review decision yet' } : null,
      definition: {
        key: k,
        version: 1,
        source: 'shipped',
        text: METRICS[k].text,
        params: METRICS[k].params,
      },
    })),
    trends: {
      periods: [
        { from: '2026-10-13T12:00:00.000Z', to: '2026-10-14T00:00:00.000Z', label: 'Oct 13, 7 AM' },
        { from: '2026-10-14T00:00:00.000Z', to: '2026-10-14T12:00:00.000Z', label: 'Oct 13, 7 PM' },
      ],
      series: [{ key: 'reports.received', title: 'Reports received', values: [12, 3] }],
    },
    exclusions: ['No metric carries a name, contact detail or address.'],
  };
}
