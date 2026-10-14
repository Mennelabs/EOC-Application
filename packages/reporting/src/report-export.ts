/**
 * Exports of an issued official report (layer-6 task F; F15, RULE-10,
 * GATE-07, NFR-12): drawn from the frozen snapshot only, so a PDF or CSV made
 * today shows exactly what was issued, with who wrote, reviewed and issued
 * it and the content hash to check it against.
 */
import type { Block, PdfDocumentModel } from '@cg/pdf';
import { toCsv } from './csv.ts';

interface Person {
  id: string | null;
  name: string | null;
  at?: string | null;
}

export interface IssuedContent {
  report: {
    id: string;
    kind: string;
    title: string;
    periodFrom: string | null;
    periodTo: string | null;
    timeZone: string;
    cutoff: string | null;
    classification: string;
    amends: string | null;
    factsAt: string | null;
    author: Person;
    reviewer: Person;
    issuer: Person;
  };
  sections: {
    key: string;
    kind: 'fact' | 'judgment' | 'narrative';
    title: string;
    content: {
      text?: string;
      rows?: { key: string; label: string; value: number | null; detail?: string }[];
      note?: string | null;
    };
    definition: { key: string; version: number; text: string } | null;
    editedBy: string | null;
    editedAt: string | null;
  }[];
}

const when = (iso: string | null | undefined, timeZone: string) =>
  iso
    ? new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(iso))
    : 'unknown';

export function reportPdf(
  c: IssuedContent,
  opts: { productName: string; contentHash: string; author?: string },
): PdfDocumentModel {
  const r = c.report;
  const tz = r.timeZone;
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: r.title },
    {
      kind: 'pairs',
      caption: 'About this report',
      items: [
        ['Period', `${when(r.periodFrom, tz)} to ${when(r.periodTo, tz)}`],
        ['Records up to', when(r.cutoff, tz)],
        ['Written by', r.author.name],
        ['Reviewed by', r.reviewer.name ? `${r.reviewer.name}, ${when(r.reviewer.at, tz)}` : null],
        ['Issued by', r.issuer.name ? `${r.issuer.name}, ${when(r.issuer.at, tz)}` : null],
        ['Classification', r.classification === 'public' ? 'Public' : 'Internal'],
        ...(r.amends ? ([['Amends', `report ${r.amends}`]] as [string, string][]) : []),
      ],
    },
    {
      kind: 'paragraph',
      text: `Frozen when issued. SHA-256 of the issued content: ${opts.contentHash}. Any copy whose content hashes differently is not this report.`,
      small: true,
    },
  ];
  for (const s of c.sections) {
    blocks.push({ kind: 'heading', level: 2, text: s.title });
    if (s.kind === 'fact') {
      blocks.push({
        kind: 'table',
        caption: s.title,
        columns: ['Figure', 'Value', 'Detail'],
        rowHeaders: true,
        widths: [3, 1, 3],
        rows: (s.content.rows ?? []).map((x) => [x.label, x.value, x.detail ?? '']),
      });
      if (s.content.note) blocks.push({ kind: 'paragraph', text: s.content.note });
      if (s.definition)
        blocks.push({
          kind: 'paragraph',
          small: true,
          text: `Definition ${s.definition.key}, version ${s.definition.version}: ${s.definition.text}`,
        });
    } else {
      const paragraphs = (s.content.text ?? '').split(/\n\s*\n/).filter((p) => p.trim());
      if (!paragraphs.length) blocks.push({ kind: 'paragraph', text: 'Nothing written.' });
      for (const p of paragraphs) blocks.push({ kind: 'paragraph', text: p.trim() });
      if (s.editedBy)
        blocks.push({
          kind: 'paragraph',
          small: true,
          text: `Written by ${s.editedBy}${s.editedAt ? `, ${when(s.editedAt, tz)}` : ''}.`,
        });
    }
  }
  return {
    title: r.title,
    lang: 'en-US',
    ...(opts.author ? { author: opts.author } : {}),
    subject: `Official report, issued ${when(r.issuer.at, tz)}`,
    producer: opts.productName,
    footer: `${r.title} · issued ${when(r.issuer.at, tz)} · ${r.classification === 'public' ? 'Public' : 'Internal'}`,
    blocks,
  };
}

/** Every figure of the report, one per row: section, figure, value, detail, definition. */
export function reportCsv(c: IssuedContent): string {
  const rows: (string | number | null)[][] = [];
  for (const s of c.sections)
    if (s.kind === 'fact')
      for (const x of s.content.rows ?? [])
        rows.push([
          s.title,
          x.label,
          x.value,
          x.detail ?? '',
          s.definition ? `${s.definition.key} v${s.definition.version}` : '',
        ]);
  return toCsv(['section', 'figure', 'value', 'detail', 'definition'], rows, {
    unknown: 'Unknown',
  });
}
