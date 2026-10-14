/**
 * Writes one PDF of every kind the platform produces, from synthetic data,
 * so CI can check each against PDF/UA-1 with veraPDF (NFR-12, ACC-49,
 * GATE-03): `pnpm --filter @cg/pdf samples <dir>`. Each later document kind
 * (the IDA package, an issued report, the resident's own report) registers
 * its own sample here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPdf, type PdfDocumentModel } from './index.ts';

export const samples: Record<string, () => PdfDocumentModel | Promise<PdfDocumentModel>> = {
  // Every building block, in English and in Spanish, across several pages.
  'blocks-en': () => blocks('en-US'),
  'blocks-es': () => blocks('es-US'),
};

function blocks(lang: string): PdfDocumentModel {
  const es = lang.startsWith('es');
  return {
    title: es ? 'Ejercicio WESTWIND: resumen de daños' : 'Exercise WESTWIND: damage summary',
    lang,
    producer: 'Sample Product',
    footer: es ? 'Borrador para revisión estatal' : 'Draft for state review',
    blocks: [
      { kind: 'heading', level: 1, text: es ? 'Resumen de daños' : 'Damage summary' },
      {
        kind: 'paragraph',
        text: es
          ? 'Daños aprobados y verificados en residencias principales. Datos sintéticos.'
          : 'Approved, verified damage to primary residences. Synthetic data.',
      },
      { kind: 'heading', level: 2, text: es ? 'Por grado de daño' : 'By degree of damage' },
      {
        kind: 'table',
        caption: es ? 'Viviendas por grado de daño' : 'Housing units by degree of damage',
        columns: es
          ? ['Grado', 'Dueño', 'Inquilino', 'Desconocido']
          : ['Degree', 'Owner', 'Renter', 'Unknown'],
        rowHeaders: true,
        rows: [
          ['Affected', 3, 4, null],
          ['Minor', 10, 2, 1],
          ['Major', 6, 3, 0],
          ['Destroyed', 1, 0, 0],
        ],
      },
      {
        kind: 'pairs',
        caption: es ? 'Totales' : 'Totals',
        items: [
          [es ? 'Viviendas contadas' : 'Housing units counted', 30],
          [es ? 'Porcentaje asegurado' : 'Percent insured', null],
        ],
      },
      {
        kind: 'list',
        items: es
          ? ['Las viviendas sin verificar se muestran aparte.', 'Desconocido nunca es cero.']
          : ['Self-reported homes are shown apart.', 'Unknown is never zero.'],
      },
      { kind: 'heading', level: 3, text: es ? 'Lista por vivienda' : 'Per-home list' },
      {
        kind: 'table',
        caption: es ? 'Viviendas (sintéticas)' : 'Homes (synthetic)',
        columns: ['Address', 'Degree', 'Insured'],
        widths: [3, 1, 1],
        rows: Array.from({ length: 70 }, (_, i) => [
          `${100 + i} Exercise Road`,
          'Minor',
          i % 3 ? 'Yes' : null,
        ]),
      },
    ],
  };
}

export async function writeSamples(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const [name, make] of Object.entries(samples)) {
    const file = join(dir, `${name}.pdf`);
    writeFileSync(file, await renderPdf(await make()));
    out.push(file);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: samples <dir>');
  for (const f of await writeSamples(dir)) process.stdout.write(`${f}\n`);
}
