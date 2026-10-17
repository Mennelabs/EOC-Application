/**
 * The damage classifier's evaluation (AIG-08, PHO-12, PHO-13):
 *
 *   pnpm --filter @cg/ai evaluate:photos <manifest.csv> [--baseline report.json] [--out report.json]
 *
 * Runs an operator-supplied labelled photo set (licensed or synthetic, kept
 * outside the repository; never resident photos from a live county) through
 * OpenAI's classifier with OPENAI_API_KEY from the environment: one paid call
 * per case. Photos are read relative to the manifest. Prints the report and
 * exits 1 when a group is materially less accurate than the whole or when
 * accuracy fell against the baseline, so a changed model or prompt is not
 * switched on (release blocks on regression).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { openAIFromEnv } from '../providers/openai.ts';
import { evaluatePhotos, parsePhotoManifest, type PhotoEvaluation } from './photos.ts';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const manifest = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!manifest) {
  console.error(
    'usage: evaluate:photos <manifest.csv> [--baseline report.json] [--out report.json]',
  );
  process.exit(2);
}
const provider = openAIFromEnv(process.env);
if (!provider?.classifier) {
  console.error('OPENAI_API_KEY is not set: the photo evaluation needs the classifier.');
  process.exit(2);
}
const base = dirname(resolve(manifest));
const cases = parsePhotoManifest(await readFile(manifest, 'utf8'));
const baselinePath = flag('--baseline');
const baseline = baselinePath
  ? (JSON.parse(await readFile(baselinePath, 'utf8')) as PhotoEvaluation)
  : null;
const report = await evaluatePhotos(
  provider.classifier,
  [provider.info.provider, provider.info.model, provider.info.templateVersion]
    .filter(Boolean)
    .join(' / '),
  cases,
  async (file) => ({
    data: await readFile(resolve(base, file)),
    mimeType: MIME[extname(file).toLowerCase()] ?? 'image/jpeg',
  }),
  undefined,
  baseline,
);
const out = flag('--out');
if (out) await writeFile(out, JSON.stringify(report, null, 2));
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
console.log(
  `${report.model}: ${report.cases} cases, exact ${pct(report.exactRate)}, within one degree ${pct(report.withinOneRate)}, cannot tell ${pct(report.cannotTellRate)}, failed ${report.failed}`,
);
for (const s of report.slices)
  console.log(
    `  ${s.dimension.padEnd(11)} ${s.group.padEnd(16)} ${String(s.cases).padStart(4)} cases  ${pct(s.rate)}${s.behind ? '  BEHIND' : ''}`,
  );
for (const p of report.problems) console.log(`problem: ${p}`);
process.exit(report.passed ? 0 : 1);
