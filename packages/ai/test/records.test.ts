/**
 * `callAi` (AI-10, AIG-01): a provider's failure, refusal, timeout or bad
 * reply is an outcome the caller records and falls back from; it never
 * escapes as an exception.
 */
import { describe, expect, it } from 'vitest';
import { callAi } from '../src/records.ts';
import { AiProviderError } from '../src/providers/openai.ts';

const ok = { output: 1, provider: { provider: 'openai', model: 'm' }, latencyMs: 12 };

describe('callAi (AI-10)', () => {
  it('passes a good reply through', async () => {
    expect(await callAi(async () => ok)).toEqual({ ok: true, out: ok });
  });

  it('turns each failure into an outcome with its latency', async () => {
    let t = 0;
    const now = () => (t += 50);
    const cases: [unknown, string][] = [
      [new AiProviderError('timeout'), 'timeout'],
      [new AiProviderError('refused'), 'refused'],
      [new AiProviderError('http', 503), 'error'],
      [new AiProviderError('incomplete'), 'invalid'],
      [new AiProviderError('invalid_output'), 'invalid'],
      [new Error('socket hang up'), 'error'],
    ];
    for (const [err, outcome] of cases) {
      const r = await callAi(async () => {
        throw err;
      }, now);
      expect(r).toEqual({ ok: false, outcome, latencyMs: 50 });
    }
  });
});
