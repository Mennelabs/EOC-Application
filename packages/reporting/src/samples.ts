/**
 * One PDF of each kind this package draws, from synthetic data, for veraPDF
 * in CI (ADR-0040; NFR-12, ACC-49, GATE-03):
 * `pnpm --filter @cg/reporting samples <dir>`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPdf } from '@cg/pdf';
import { SHIPPED, buildPackage, samplePackageData } from './fema/index.ts';
import { reportPdf, type IssuedContent } from './report-export.ts';

const sampleReport: IssuedContent = {
  report: {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'sitrep',
    title: 'Situation report 3',
    periodFrom: '2026-10-14T12:00:00.000Z',
    periodTo: '2026-10-15T00:00:00.000Z',
    timeZone: 'America/Chicago',
    cutoff: '2026-10-15T00:00:00.000Z',
    classification: 'internal',
    amends: null,
    factsAt: '2026-10-14T23:30:00.000Z',
    author: { id: null, name: 'Exercise Reporting Officer' },
    reviewer: { id: null, name: 'Exercise EM Director', at: '2026-10-14T23:40:00.000Z' },
    issuer: { id: null, name: 'Exercise EM Director', at: '2026-10-14T23:45:00.000Z' },
  },
  sections: [
    {
      key: 'summary',
      kind: 'narrative',
      title: 'Summary',
      content: {
        text: 'Exercise: 52 housing units have verified damage.\n\nRiver crest expected Thursday.',
      },
      definition: null,
      editedBy: 'Exercise Reporting Officer',
      editedAt: '2026-10-14T23:35:00.000Z',
    },
    {
      key: 'damage',
      kind: 'fact',
      title: 'Verified damage to homes',
      content: {
        rows: [
          { key: 'units', label: 'Housing units counted', value: 52 },
          {
            key: 'inaccessible',
            label: 'Could not be reached',
            value: 1,
            detail: 'private road or bridge: 1',
          },
        ],
        note: null,
      },
      definition: {
        key: 'counting_rule',
        version: 1,
        text: 'Approved, verified damage to primary residences, one home counted once.',
      },
      editedBy: null,
      editedAt: null,
    },
    {
      key: 'casualties',
      kind: 'fact',
      title: 'Casualties (official counts)',
      content: {
        rows: [
          {
            key: 'injured',
            label: 'Injured',
            value: 3,
            detail: 'Exercise: county medical examiner',
          },
          { key: 'missing', label: 'Missing', value: null, detail: 'No official count' },
        ],
      },
      definition: null,
      editedBy: null,
      editedAt: null,
    },
    {
      key: 'outlook',
      kind: 'judgment',
      title: 'Outlook for the next period',
      content: { text: 'Exercise: more rain on Thursday.' },
      definition: null,
      editedBy: 'Exercise Reporting Officer',
      editedAt: '2026-10-14T23:36:00.000Z',
    },
  ],
};

export async function writeReportingSamples(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const pkg = buildPackage(samplePackageData(), SHIPPED, {
    productName: 'Sample Product',
    generatedAt: new Date('2026-10-14T18:05:00Z'),
  });
  const file = join(dir, 'ida-package.pdf');
  writeFileSync(file, await renderPdf(pkg.pdf));
  const report = join(dir, 'official-report.pdf');
  writeFileSync(
    report,
    await renderPdf(
      reportPdf(sampleReport, { productName: 'Sample Product', contentHash: 'f'.repeat(64) }),
    ),
  );
  return [file, report];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: samples <dir>');
  for (const f of await writeReportingSamples(dir)) process.stdout.write(`${f}\n`);
}
