/**
 * Prints the evaluation report for a provider (AIG-08 human review): `fake`, the test double
 * (default, free, what CI runs), or `openai`, the live run against OpenAI with OPENAI_API_KEY
 * from the environment (ADR-0043). A live regression blocks enabling the changed model or prompt.
 */
import { fakeProvider } from '../providers/fake.ts';
import { openAIFromEnv } from '../providers/openai.ts';
import type { AiProvider } from '../types.ts';
import { evaluateProvider } from './harness.ts';

const name = process.argv[2] ?? 'fake';
let provider: AiProvider | null = null;
if (name === 'fake') provider = fakeProvider;
else if (name === 'openai') {
  provider = openAIFromEnv(process.env);
  if (!provider) {
    console.error('OPENAI_API_KEY is not set: the live evaluation needs it.');
    process.exit(2);
  }
} else {
  console.error(`unknown provider ${name}; use fake or openai`);
  process.exit(2);
}
const report = await evaluateProvider(provider);
for (const c of report.cases) {
  const inj =
    c.injectionHandled === null
      ? ''
      : c.injectionHandled
        ? ' injection:blocked'
        : ' injection:FAILED';
  console.log(`${c.id.padEnd(20)} ${c.language} ${c.found}/${c.expected} wrong=${c.wrong}${inj}`);
}
console.log(
  JSON.stringify({
    provider: provider.info,
    accuracy: report.accuracy,
    injectionResistance: report.injectionResistance,
    passed: report.passed,
    thresholds: report.thresholds,
  }),
);
process.exit(report.passed ? 0 : 1);
