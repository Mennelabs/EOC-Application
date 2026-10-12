import { describe, expect, it } from 'vitest';
import { runProbes, safeReason, type Probe } from '../src/health.ts';

describe('runProbes', () => {
  it('reports each dependency by name with ok/failed state', async () => {
    const ok: Probe = { name: 'db', check: async () => undefined };
    const bad: Probe = {
      name: 'queue',
      check: async () => {
        throw new Error('connect ECONNREFUSED amqp://user:pw@queue:5672');
      },
    };
    const results = await runProbes([ok, bad]);
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['db', true],
      ['queue', false],
    ]);
  });

  it('times out a hanging probe instead of hanging readiness', async () => {
    const hang: Probe = { name: 'idp', check: () => new Promise(() => undefined) };
    const [result] = await runProbes([hang], 50);
    expect(result).toMatchObject({ name: 'idp', ok: false, error: 'timeout' });
  });
});

describe('safeReason (CLAUDE.md rule 9: secrets never in logs)', () => {
  it('strips URLs that may carry credentials', () => {
    expect(safeReason(new Error('failed amqp://cg:s3cret@queue:5672/'))).toBe('failed <url>');
  });

  it('redacts key=value secrets', () => {
    expect(safeReason('bad token=abc123 password=hunter2')).toBe(
      'bad token=<redacted> password=<redacted>',
    );
  });
});
