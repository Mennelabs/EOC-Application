/**
 * One PDF of each kind this package draws, from synthetic data, for veraPDF
 * in CI (ADR-0040; NFR-12, ACC-49, GATE-03):
 * `pnpm --filter @cg/reporting samples <dir>`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPdf } from '@cg/pdf';
import { SHIPPED, buildPackage, samplePackageData } from './fema/index.ts';

export async function writeReportingSamples(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const pkg = buildPackage(samplePackageData(), SHIPPED, {
    productName: 'Sample Product',
    generatedAt: new Date('2026-10-14T18:05:00Z'),
  });
  const file = join(dir, 'ida-package.pdf');
  writeFileSync(file, await renderPdf(pkg.pdf));
  return [file];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: samples <dir>');
  for (const f of await writeReportingSamples(dir)) process.stdout.write(`${f}\n`);
}
