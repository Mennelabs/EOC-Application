/**
 * Service metrics (NFR-10, ADR-0023): counters and latency histograms in the
 * Prometheus text format, served on each service's internal port at
 * /metrics. Any OpenTelemetry collector or Prometheus-compatible monitor in
 * the government cloud scrapes it unchanged. Labels are fixed vocabularies
 * only (route templates, error codes, job and feature names, outcome words):
 * never an id, an address, a person or anything a person wrote, so the
 * metrics can leave the platform without leaking content (NFR-10 "without
 * sensitive prompt/content leakage").
 */

type Labels = Record<string, string>;

/**
 * Callers pass only route templates and fixed vocabularies. As a backstop a
 * value outside a short, plain character set becomes "other", and a metric
 * that reaches MAX_SERIES label sets folds any new set into one "other"
 * series, so no input can grow the metrics without bound.
 */
const SAFE = /^[A-Za-z0-9_.:/{}*-]{1,120}$/;
export const MAX_SERIES = 1000;
const clean = (labels: Labels): Labels =>
  Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, SAFE.test(v) ? v : 'other']));
const overflow = (labels: Labels): Labels =>
  Object.fromEntries(Object.keys(labels).map((k) => [k, 'other']));

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');

const render = (labels: Labels) => {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return `{${keys.map((k) => `${k}="${labels[k]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
};

interface Metric {
  name: string;
  help: string;
  type: 'counter' | 'histogram' | 'gauge';
  lines(): string[];
}

export class Counter implements Metric {
  readonly type = 'counter' as const;
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    let l = clean(labels);
    let k = key(l);
    if (!this.values.has(k) && this.values.size >= MAX_SERIES) {
      l = overflow(l);
      k = key(l);
    }
    const v = this.values.get(k);
    if (v) v.value += by;
    else this.values.set(k, { labels: l, value: by });
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(clean(labels)))?.value ?? 0;
  }
  lines(): string[] {
    return [...this.values.values()].map((v) => `${this.name}${render(v.labels)} ${v.value}`);
  }
}

export class Gauge implements Metric {
  readonly type = 'gauge' as const;
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  set(value: number, labels: Labels = {}): void {
    let l = clean(labels);
    if (!this.values.has(key(l)) && this.values.size >= MAX_SERIES) l = overflow(l);
    this.values.set(key(l), { labels: l, value });
  }
  lines(): string[] {
    return [...this.values.values()].map((v) => `${this.name}${render(v.labels)} ${v.value}`);
  }
}

/** Seconds; the edges follow the response targets (CMD-38: 15 s at most). */
export const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];

export class Histogram implements Metric {
  readonly type = 'histogram' as const;
  private readonly values = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  constructor(name: string, help: string, buckets: number[] = LATENCY_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(seconds: number, labels: Labels = {}): void {
    let l = clean(labels);
    let k = key(l);
    if (!this.values.has(k) && this.values.size >= MAX_SERIES) {
      l = overflow(l);
      k = key(l);
    }
    let v = this.values.get(k);
    if (!v) {
      v = { labels: l, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.values.set(k, v);
    }
    this.buckets.forEach((b, i) => {
      if (seconds <= b) v.counts[i]!++;
    });
    v.sum += seconds;
    v.count++;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const v of this.values.values()) {
      this.buckets.forEach((b, i) =>
        out.push(`${this.name}_bucket${render({ ...v.labels, le: String(b) })} ${v.counts[i]}`),
      );
      out.push(`${this.name}_bucket${render({ ...v.labels, le: '+Inf' })} ${v.count}`);
      out.push(`${this.name}_sum${render(v.labels)} ${v.sum}`);
      out.push(`${this.name}_count${render(v.labels)} ${v.count}`);
    }
    return out;
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];
  counter(name: string, help: string): Counter {
    const m = new Counter(name, help);
    this.metrics.push(m);
    return m;
  }
  gauge(name: string, help: string): Gauge {
    const m = new Gauge(name, help);
    this.metrics.push(m);
    return m;
  }
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const m = new Histogram(name, help, buckets);
    this.metrics.push(m);
    return m;
  }
  /** The Prometheus text exposition (version 0.0.4). */
  expose(): string {
    return (
      this.metrics
        .flatMap((m) => [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.lines()])
        .join('\n') + '\n'
    );
  }
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
