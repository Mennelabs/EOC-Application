/**
 * An ICS form's PDF (tagged, PDF/UA-1, ADR-0040) and CSV from its frozen
 * content (CON-13). Both name the form, its edition and, when issued, the
 * SHA-256 of the content, so a copy can be checked against the record.
 */
import type { Block, Cell, PdfDocumentModel } from '@cg/pdf';
import { toCsv, type CsvValue } from '../csv.ts';
import { when, type IcsFormContent } from './forms.ts';

export function icsPdf(
  c: IcsFormContent,
  opts: { productName: string; contentHash?: string | null; sequence?: number | null },
): PdfDocumentModel {
  const title = `${c.number} ${c.title}: ${c.incident}`;
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: title },
    {
      kind: 'paragraph',
      small: true,
      text: `${c.edition}. Prepared by ${c.preparedBy.name}${c.preparedBy.position ? `, ${c.preparedBy.position}` : ''}, ${when(c.preparedAt, c.timeZone)}.${
        opts.sequence ? ` Issue ${opts.sequence}.` : ''
      }${
        opts.contentHash
          ? ` Frozen when issued; SHA-256 of the content: ${opts.contentHash}.`
          : ' Preview: not issued.'
      }`,
    },
  ];
  for (const b of c.blocks) {
    if (b.kind === 'table') {
      blocks.push({ kind: 'heading', level: 2, text: `${b.no}. ${b.label}` });
      if (b.rows.length)
        blocks.push({
          kind: 'table',
          caption: `${b.no}. ${b.label}`,
          columns: b.columns,
          rows: b.rows.map((r) => r.map((x): Cell => (x === undefined ? null : x))),
        });
      else blocks.push({ kind: 'paragraph', text: 'None.' });
    } else if (b.kind === 'text') {
      blocks.push({ kind: 'heading', level: 2, text: `${b.no}. ${b.label}` });
      const paragraphs = (b.text ?? '').split(/\n\s*\n/).filter((p) => p.trim());
      if (!paragraphs.length) blocks.push({ kind: 'paragraph', text: 'None.' });
      for (const p of paragraphs) blocks.push({ kind: 'paragraph', text: p.trim() });
    }
  }
  const values = c.blocks.filter((b) => b.kind === 'value');
  if (values.length)
    blocks.splice(2, 0, {
      kind: 'pairs',
      caption: 'Form blocks',
      headers: ['Block', 'Value'],
      items: values.map((b) => [`${b.no}. ${b.label}`, b.kind === 'value' ? b.value : null]),
    });
  return {
    title,
    lang: 'en-US',
    author: c.preparedBy.name,
    subject: `${c.number} ${c.title}, ${c.edition}`,
    producer: opts.productName,
    footer: `${c.number} · ${c.incident} · ${opts.contentHash ? `issue ${opts.sequence ?? ''}`.trim() : 'preview'}`,
    blocks,
  };
}

/** One row per block value, or per table cell: block, label, row, column, value. */
export function icsCsv(c: IcsFormContent): string {
  const rows: CsvValue[][] = [
    ['form', c.number, null, null, `${c.title}: ${c.edition}`],
    ['incident', 'Incident name', null, null, c.incident],
    ['prepared', 'Prepared by', null, null, c.preparedBy.name],
    ['prepared', 'Prepared at', null, null, c.preparedAt],
  ];
  for (const b of c.blocks) {
    if (b.kind === 'value') rows.push([b.no, b.label, null, null, b.value]);
    else if (b.kind === 'text') rows.push([b.no, b.label, null, null, b.text]);
    else
      b.rows.forEach((r, ri) =>
        r.forEach((v, ci) => rows.push([b.no, b.label, ri + 1, b.columns[ci] ?? '', v])),
      );
  }
  return toCsv(['Block', 'Label', 'Row', 'Column', 'Value'], rows);
}
