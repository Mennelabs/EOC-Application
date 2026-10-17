/**
 * NFR-10: every alert rule names an owner defined in
 * docs/operations/alerts.md, links a runbook section that exists there, and
 * only uses metrics the api or worker actually serves. The expressions
 * themselves are unit-tested by promtool (infra/prometheus/alerts.test.yml,
 * run in CI).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workerMetrics } from '../src/metrics.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const rulesText = readFileSync(join(root, 'infra/prometheus/alerts.yml'), 'utf8');
const doc = readFileSync(join(root, 'docs/operations/alerts.md'), 'utf8');
const apiSource = readFileSync(join(root, 'services/api/src/plugins/metrics.ts'), 'utf8');

interface Rule {
  alert: string;
  expr: string;
  owner: string | undefined;
  runbook: string | undefined;
  severity: string | undefined;
}

const rules: Rule[] = rulesText
  .split(/^\s+- alert: /m)
  .slice(1)
  .map((block) => ({
    alert: block.split('\n')[0]!.trim(),
    expr: block.slice(block.indexOf('expr:'), block.indexOf('labels:')),
    owner: /^\s+owner: (\S+)/m.exec(block)?.[1],
    runbook: /^\s+runbook: (\S+)/m.exec(block)?.[1],
    severity: /^\s+severity: (\S+)/m.exec(block)?.[1],
  }));

/** The owner keys in the doc's Owners table: | `platform-oncall` | … */
const owners = new Set(
  [
    ...doc
      .slice(doc.indexOf('## Owners'), doc.indexOf('## Runbooks'))
      .matchAll(/^\| `([a-z-]+)` +\|/gm),
  ].map((m) => m[1]!),
);
const anchors = new Set([...doc.matchAll(/^### (\S+)$/gm)].map((m) => m[1]!.toLowerCase()));

const served = new Set([
  ...[...workerMetrics.expose().matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]!),
  ...[...apiSource.matchAll(/'(cg_[a-z_]+)'/g)].map((m) => m[1]!),
  'up',
]);
const base = (name: string) => name.replace(/_(bucket|sum|count)$/, '');

describe('NFR-10: alert rules', () => {
  it('there are rules for each thing NFR-10 measures', () => {
    expect(rules.length).toBeGreaterThanOrEqual(10);
    const exprs = rules.map((r) => r.expr).join('\n');
    for (const metric of [
      'cg_http_requests_total', // save failures
      'cg_http_request_duration_seconds_bucket', // latency
      'cg_api_errors_total', // conflicts
      'cg_field_commands_total', // command failures
      'cg_integration_calls_total', // integration failures
      'cg_ai_calls_total',
      'cg_audit_chains_broken', // audit completeness
      'cg_job_runs_total',
      'cg_queue_messages_total',
    ])
      expect(exprs, metric).toContain(metric);
  });

  it('every rule has a severity, an owner from the Owners table and a runbook section', () => {
    expect(owners.size).toBeGreaterThanOrEqual(3);
    for (const r of rules) {
      expect(['critical', 'warning'], r.alert).toContain(r.severity);
      expect(owners.has(r.owner ?? ''), `${r.alert} owner ${r.owner}`).toBe(true);
      expect(r.runbook, r.alert).toBe(`docs/operations/alerts.md#${r.alert.toLowerCase()}`);
      expect(anchors.has(r.alert.toLowerCase()), `runbook section for ${r.alert}`).toBe(true);
    }
  });

  it('every metric a rule uses is one the services serve', () => {
    for (const r of rules)
      for (const m of r.expr.matchAll(/\b(cg_[a-z_]+|up)\b/g))
        expect(served.has(base(m[1]!)), `${r.alert} uses ${m[1]}`).toBe(true);
  });

  it('no rule groups by a label that could carry an id or content', () => {
    for (const r of rules)
      for (const m of r.expr.matchAll(/by \(([^)]*)\)/g))
        for (const label of m[1]!.split(',').map((s) => s.trim()))
          expect(['le', 'schedule', 'topic', 'route', 'feature', 'kind', 'job'], r.alert).toContain(
            label,
          );
  });
});
