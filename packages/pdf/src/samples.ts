/**
 * Writes one PDF of every kind the platform produces, from synthetic data,
 * so CI can check each against PDF/UA-1 with veraPDF (NFR-12, ACC-49,
 * GATE-03): `pnpm --filter @cg/pdf samples <dir>`. Each later document kind
 * (the IDA package, an issued report, the resident's own report) registers
 * its own sample here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { renderPdf, type PdfDocumentModel } from './index.ts';

export const samples: Record<string, () => PdfDocumentModel | Promise<PdfDocumentModel>> = {
  // Every building block, in English and in Spanish, across several pages.
  'blocks-en': () => blocks('en-US'),
  'blocks-es': () => blocks('es-US'),
};

/** A synthetic picture (a sky-to-ground gradient with a water line), as PNG, for samples and tests. */
export function samplePng(width = 240, height = 160): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    const water = y > height * 0.62;
    for (let x = 0; x < width; x++) {
      const t = y / height;
      const at = row + 1 + x * 3;
      raw[at] = water ? 70 : Math.round(150 - 60 * t);
      raw[at + 1] = water ? 90 : Math.round(185 - 50 * t);
      raw[at + 2] = water ? 110 : Math.round(220 - 40 * t);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
      {
        kind: 'figure',
        image: samplePng(),
        alt: es
          ? 'Ilustración sintética: cielo claro sobre agua de inundación oscura.'
          : 'Synthetic illustration: pale sky above dark flood water.',
        caption: es ? 'Foto 1. Ilustración sintética.' : 'Photo 1. Synthetic illustration.',
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
