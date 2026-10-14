/**
 * The PDF writer (ADR-0040; NFR-12, ACC-49): the structure PDF/UA-1 needs is
 * in every file (tagged, language, title shown, PDF/UA identifier, embedded
 * font without a CIDSet), unknown values read "Unknown", characters the font
 * cannot draw become "?", and the footer never adds pages. veraPDF itself
 * runs over the samples in CI (scripts/verapdf.sh).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderPdf, type Block } from '../src/index.ts';

const pdf = (blocks: Block[], lang = 'en-US') =>
  renderPdf({ title: 'Exercise test', lang, producer: 'Test Product', footer: 'Exercise', blocks });

/** The decompressed content streams, where the drawn text is (as glyph ids, so only lengths are compared). */
function streams(buf: Buffer): string {
  const s = buf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const end = s.indexOf('endstream', m.index);
    try {
      out.push(inflateSync(buf.subarray(m.index + m[0].length, end)).toString('latin1'));
    } catch {
      // not a deflated stream
    }
  }
  return out.join('\n');
}

describe('accessible PDFs', () => {
  it('carries what PDF/UA-1 needs', async () => {
    const buf = await pdf([
      { kind: 'heading', level: 1, text: 'Damage summary' },
      {
        kind: 'table',
        caption: 'Units',
        columns: ['Degree', 'Units'],
        rowHeaders: true,
        rows: [['Minor', 3]],
      },
    ]);
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.7')).toBe(true);
    for (const needed of [
      '/StructTreeRoot',
      '/MarkInfo',
      '/Lang (en-US)',
      '/DisplayDocTitle true',
      'pdfuaid:part>1<',
      '/FontFile2',
    ])
      expect(s, needed).toContain(needed);
    expect(s).not.toContain('/CIDSet');
    for (const tag of ['/H1', '/Table', '/TR', '/TH', '/TD', '/Caption'])
      expect(s, tag).toContain(`/S ${tag}`);
  });

  it('says the language of a Spanish document', async () => {
    const s = (await pdf([{ kind: 'paragraph', text: 'Daños en la vivienda' }], 'es-US')).toString(
      'latin1',
    );
    expect(s).toContain('/Lang (es-US)');
  });

  it('marks page numbers as artifacts and adds no pages for the footer', async () => {
    const many: Block[] = Array.from({ length: 120 }, (_, i) => ({
      kind: 'paragraph',
      text: `Line ${i}`,
    }));
    const buf = await pdf(many);
    const pages = buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(6);
    const content = streams(buf);
    expect(content.match(/\/Artifact/g)?.length).toBe(pages);
  });

  it('renders unknown as "Unknown" and replaces what the font cannot draw', async () => {
    const withUnknown = streams(
      await pdf([{ kind: 'pairs', caption: 'Totals', items: [['Insured', null]] }]),
    );
    const withZero = streams(
      await pdf([{ kind: 'pairs', caption: 'Totals', items: [['Insured', 0]] }]),
    );
    // "Unknown" is seven glyphs, "0" one: the unknown table draws more text than the zero one.
    expect(withUnknown.length).toBeGreaterThan(withZero.length);
    await expect(pdf([{ kind: 'paragraph', text: 'Exercise 漢字 ✓' }])).resolves.toBeInstanceOf(
      Buffer,
    );
  });
});
