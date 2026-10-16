import { describe, expect, it } from 'vitest';
import { MAX_SERIES, METRICS_CONTENT_TYPE, Registry } from '../src/metrics.ts';

describe('NFR-10: service metrics registry', () => {
  it('exposes counters, gauges and histograms in the Prometheus text format', () => {
    const r = new Registry();
    const c = r.counter('cg_test_total', 'A test counter');
    const g = r.gauge('cg_test_gauge', 'A test gauge');
    const h = r.histogram('cg_test_seconds', 'A test histogram', [0.1, 1]);
    c.inc({ route: '/api/v1/needs/:id', status: '2xx' });
    c.inc({ route: '/api/v1/needs/:id', status: '2xx' }, 2);
    g.set(3);
    h.observe(0.05, { schedule: 'maps-cut' });
    h.observe(0.5, { schedule: 'maps-cut' });
    h.observe(5, { schedule: 'maps-cut' });
    const text = r.expose();
    expect(text).toContain('# TYPE cg_test_total counter');
    expect(text).toContain('cg_test_total{route="/api/v1/needs/:id",status="2xx"} 3');
    expect(text).toContain('cg_test_gauge 3');
    expect(text).toContain('cg_test_seconds_bucket{le="0.1",schedule="maps-cut"} 1');
    expect(text).toContain('cg_test_seconds_bucket{le="1",schedule="maps-cut"} 2');
    expect(text).toContain('cg_test_seconds_bucket{le="+Inf",schedule="maps-cut"} 3');
    expect(text).toContain('cg_test_seconds_count{schedule="maps-cut"} 3');
    expect(METRICS_CONTENT_TYPE).toMatch(/^text\/plain; version=0\.0\.4/);
  });

  it('a label value outside the plain vocabulary becomes "other" (no content leaks)', () => {
    const r = new Registry();
    const c = r.counter('cg_test_total', 'A test counter');
    c.inc({ code: 'Mrs Smith, 12 Oak St' });
    c.inc({ code: 'a"quote' });
    c.inc({ code: 'x'.repeat(200) });
    expect(c.get({ code: 'other' })).toBe(3);
    expect(r.expose()).not.toContain('Smith');
  });

  it('a metric stops growing at MAX_SERIES label sets; later sets fold into "other"', () => {
    const r = new Registry();
    const c = r.counter('cg_test_total', 'A test counter');
    for (let i = 0; i < MAX_SERIES + 50; i++) c.inc({ kind: `kind-${i}`, result: 'ok' });
    const lines = r
      .expose()
      .split('\n')
      .filter((l) => l.startsWith('cg_test_total'));
    expect(lines.length).toBe(MAX_SERIES + 1);
    expect(c.get({ kind: 'other', result: 'other' })).toBe(50);
    // A set already seen still counts on its own line.
    c.inc({ kind: 'kind-1', result: 'ok' });
    expect(c.get({ kind: 'kind-1', result: 'ok' })).toBe(2);
  });
});
