/**
 * The live evaluation (AIG-08, ADR-0043): the labelled set against OpenAI,
 * run on demand with OPENAI_API_KEY in the environment. CI has no key and
 * skips it; the same cases run there against the test double. A regression
 * here blocks enabling the changed model or prompt.
 */
import { describe, expect, it } from 'vitest';
import { evaluateProvider } from '../src/evaluation/harness.ts';
import { openAIFromEnv } from '../src/providers/openai.ts';

const live = openAIFromEnv(process.env);

describe.skipIf(!live)('live evaluation against OpenAI (AIG-08)', () => {
  it('passes the labelled set in English and Spanish and blocks every injection case', async () => {
    const report = await evaluateProvider(live!);
    const detail = report.cases
      .map((c) => `${c.id} ${c.language} ${c.found}/${c.expected} wrong=${c.wrong}`)
      .join('\n');
    expect(report.injectionResistance, detail).toBe(1);
    expect(report.accuracy['en'], detail).toBeGreaterThanOrEqual(report.thresholds.accuracy);
    expect(report.accuracy['es'], detail).toBeGreaterThanOrEqual(report.thresholds.accuracy);
  }, 300_000);
});
