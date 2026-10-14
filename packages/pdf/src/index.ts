/**
 * Accessible PDFs (ADR-0040; NFR-12, ACC-49, GATE-03): a small document model
 * (headings, paragraphs, tables with header cells, lists, label–value pairs)
 * rendered by PDFKit as PDF/UA-1. Every piece of content sits in the
 * structure tree in reading order; tables are Table/TR/TH/TD with column and
 * row header scopes; the language and title are set and the title is shown;
 * fonts are embedded (Noto Sans, SIL OFL); page numbers and the running
 * footer are artifacts, not content. veraPDF checks each kind in CI.
 *
 * Text the font cannot draw becomes "?" rather than an invisible glyph, and
 * unknown values in tables read "Unknown", never 0 (RULE-02).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';

export type Cell = string | number | null;

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string; small?: boolean }
  | {
      kind: 'table';
      /** Shown above the table and used as its title for assistive technology. */
      caption: string;
      columns: string[];
      rows: Cell[][];
      /** The first cell of each row heads that row. */
      rowHeaders?: boolean;
      /** Relative column widths; equal when absent. */
      widths?: number[];
    }
  | { kind: 'list'; items: string[] }
  | { kind: 'pairs'; caption: string; items: [string, Cell][] }
  | { kind: 'pageBreak' };

export interface PdfDocumentModel {
  title: string;
  /** BCP 47, e.g. en-US or es-US. */
  lang: string;
  author?: string;
  subject?: string;
  /** Left side of the running footer, e.g. "Draft for state review". */
  footer?: string;
  /** Producer recorded in the file: the product name from configuration (ADM-03). */
  producer: string;
  blocks: Block[];
}

const require = createRequire(import.meta.url);
const fontFile = (weight: 400 | 700) =>
  readFileSync(
    require.resolve(`@fontsource/noto-sans/files/noto-sans-latin-${weight}-normal.woff`),
  );
let fonts: { regular: Buffer; bold: Buffer } | null = null;
const loadFonts = () => (fonts ??= { regular: fontFile(400), bold: fontFile(700) });

const MARGIN = 54;
const SIZE = { body: 10, small: 8.5, h1: 18, h2: 14, h3: 12 };
const INK = '#1b1b1b';
const MUTED = '#4a4a4a';
const RULE = '#6b6b6b';
const HEAD_FILL = '#e8e8e8';

/** Shown for an unknown value (RULE-02). */
export const UNKNOWN = 'Unknown';
const show = (c: Cell): string =>
  c === null || c === undefined ? UNKNOWN : typeof c === 'number' ? c.toLocaleString('en-US') : c;

type Doc = InstanceType<typeof PDFDocument>;
type Struct = ReturnType<Doc['struct']>;

/** PDFKit's table accepts these accessibility options; the published types predate them. */
interface AccessibleTableOptions {
  structParent: Struct;
  columnStyles: (number | string)[];
  defaultStyle: Record<string, unknown>;
  data: Record<string, unknown>[][];
}

export async function renderPdf(model: PdfDocumentModel): Promise<Buffer> {
  const f = loadFonts();
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: MARGIN + 18, left: MARGIN, right: MARGIN },
    pdfVersion: '1.7',
    subset: 'PDF/UA',
    tagged: true,
    displayTitle: true,
    lang: model.lang,
    bufferPages: true,
    info: {
      Title: model.title,
      ...(model.author ? { Author: model.author } : {}),
      ...(model.subject ? { Subject: model.subject } : {}),
      Producer: model.producer,
      Creator: model.producer,
    },
  } as unknown as ConstructorParameters<typeof PDFDocument>[0]);
  // PDFKit marks PDF/UA as "part 1" in the same field it uses for PDF/A-1, and so also writes a
  // CIDSet, which PDF/A-1 needs and PDF/UA does not. Its CIDSet leaves out the component glyphs
  // of accented letters (ñ, ú), which veraPDF rightly rejects (ISO 14289-1 7.21.4.2). Keep the
  // PDF/UA-1 identifier and write no CIDSet.
  const ua = doc as unknown as { subset: unknown; _getPdfuaid(): string };
  ua.subset = 'UA-1';
  ua._getPdfuaid = () => `
        <rdf:Description xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" rdf:about="">
            <pdfuaid:part>1</pdfuaid:part>
        </rdf:Description>
        `;
  doc.registerFont('regular', f.regular);
  doc.registerFont('bold', f.bold);
  doc.font('regular').fontSize(SIZE.body).fillColor(INK);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // A glyph the embedded font lacks would draw nothing (PDF/UA forbids .notdef); say "?" instead.
  const fontkitFont = () =>
    (doc as unknown as { _font: { font: { hasGlyphForCodePoint(cp: number): boolean } } })._font
      .font;
  const safe = (text: string) => {
    const font = fontkitFont();
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      out += cp === 10 || font.hasGlyphForCodePoint(cp) ? ch : '?';
    }
    return out;
  };

  const root = doc.struct('Document');
  doc.addStructure(root);
  const width = doc.page.width - MARGIN * 2;

  const text = (
    tag: string,
    value: string,
    opts: { font?: 'regular' | 'bold'; size?: number; color?: string; gap?: number } = {},
  ) => {
    doc
      .font(opts.font ?? 'regular')
      .fontSize(opts.size ?? SIZE.body)
      .fillColor(opts.color ?? INK);
    const clean = safe(value);
    root.add(doc.struct(tag, {}, () => doc.text(clean, { width })));
    doc.moveDown(opts.gap ?? 0.5);
  };

  for (const b of model.blocks) {
    switch (b.kind) {
      case 'heading': {
        // Keep a heading with what follows it: start a new page when little room is left.
        if (doc.y > doc.page.height - doc.page.margins.bottom - 90) doc.addPage();
        else if (b.level > 1) doc.moveDown(0.4);
        text(`H${b.level}`, b.text, {
          font: 'bold',
          size: b.level === 1 ? SIZE.h1 : b.level === 2 ? SIZE.h2 : SIZE.h3,
          gap: 0.3,
        });
        break;
      }
      case 'paragraph':
        text('P', b.text, b.small ? { size: SIZE.small, color: MUTED } : {});
        break;
      case 'list': {
        const list = doc.struct('L');
        root.add(list);
        doc.font('regular').fontSize(SIZE.body).fillColor(INK);
        for (const item of b.items) {
          const li = doc.struct('LI');
          list.add(li);
          const y = doc.y;
          li.add(doc.struct('Lbl', {}, () => doc.text('•', MARGIN, y, { width: 12 })));
          li.add(
            doc.struct('LBody', {}, () =>
              doc.text(safe(item), MARGIN + 14, y, { width: width - 14 }),
            ),
          );
          li.end();
          doc.x = MARGIN;
        }
        list.end();
        doc.moveDown(0.5);
        break;
      }
      case 'table':
      case 'pairs': {
        const caption = b.caption;
        // The caption is the table's visible title; it is read before the table.
        text('Caption', caption, { font: 'bold', size: SIZE.body, gap: 0.2 });
        const columns = b.kind === 'pairs' ? ['Item', 'Value'] : b.columns;
        const rows: Cell[][] = b.kind === 'pairs' ? b.items.map(([k, v]) => [k, v]) : b.rows;
        const rowHeaders = b.kind === 'pairs' ? true : (b.rowHeaders ?? false);
        const weights =
          b.kind === 'table' && b.widths?.length === columns.length
            ? b.widths
            : b.kind === 'pairs'
              ? [3, 2]
              : columns.map(() => 1);
        const total = weights.reduce((n, w) => n + w, 0);
        doc.font('regular').fontSize(SIZE.body).fillColor(INK);
        const head = columns.map((c) => ({
          type: 'TH',
          scope: 'Column',
          text: safe(c),
          font: { src: 'bold' },
          backgroundColor: HEAD_FILL,
        }));
        const body = rows.map((r) =>
          r.map((c, i) =>
            i === 0 && rowHeaders
              ? { type: 'TH', scope: 'Row', text: safe(show(c)), font: { src: 'bold' } }
              : { type: 'TD', text: safe(show(c)) },
          ),
        );
        const opts: AccessibleTableOptions = {
          structParent: root,
          columnStyles: weights.map((w) => (width * w) / total),
          defaultStyle: {
            border: 0.5,
            borderColor: RULE,
            padding: { top: 3, right: 4, bottom: 3, left: 4 },
          },
          data: [head, ...body],
        };
        doc.table(opts as unknown as Parameters<Doc['table']>[0]);
        doc.x = MARGIN;
        doc.moveDown(0.8);
        break;
      }
      case 'pageBreak':
        doc.addPage();
        break;
    }
  }
  root.end();

  // Running footer and page numbers: artifacts, outside the structure tree.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Below the content area: lift the bottom margin so writing there does not start a new page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGIN;
    doc.markContent('Artifact', { type: 'Pagination' } as never);
    doc.font('regular').fontSize(SIZE.small).fillColor(MUTED);
    if (model.footer)
      doc.text(safe(model.footer), MARGIN, y, { width: width * 0.7, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + width * 0.7, y, {
      width: width * 0.3,
      align: 'right',
      lineBreak: false,
    });
    doc.endMarkedContent();
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
