/** Prints the evaluation report for a provider (default: fake). AIG-08 human review. */
import { providerByName } from '../registry.ts';
import { evaluateProvider } from './harness.ts';

const name = process.argv[2] ?? 'fake';
const provider = providerByName(name);
if (!provider) {
  console.error(`unknown provider ${name}`);
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
