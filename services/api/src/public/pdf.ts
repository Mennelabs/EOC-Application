/**
 * Public and resident PDFs (layer-6 task I), in English and Spanish, tagged
 * PDF/UA through @cg/pdf (ADR-0040; ACC-49, NFR-12):
 *
 * - The media sheet (PUB-13): the same sites, resources and times as the
 *   media page, as a file a newsroom can print or attach. Made on request,
 *   so it is as current as the page; "last updated" and "made" are on it.
 * - The resident's own copy (FL:FR-32): what they told the county about
 *   their home and the damage, in their words, with their photos, to keep
 *   or send to their insurer. Only the home and damage answers are in it;
 *   who they are, how to reach them, their household and their needs stay
 *   with the county, and the copy says so. Residents' documents name the
 *   county, never the product.
 */
import type { Block, PdfDocumentModel } from '@cg/pdf';
import { T, addressText, hoursText, type Lang, type MediaPageInput } from './render.ts';

export const PDF_T = {
  en: {
    made: 'Made',
    copyTitle: 'Your damage report',
    copyIntro: (county: string) =>
      `A copy of what you told ${county} about your home. You can keep it, or send it to your insurance company with your claim. It is not a decision about a claim or about aid.`,
    reference: 'Reference code',
    sent: 'Sent',
    where: 'Where it is now',
    state: {
      received: 'Received',
      being_reviewed: 'Being reviewed',
      needs_your_answer: 'The county has a question for you',
      reviewed: 'Reviewed by the county',
      not_accepted: 'Not accepted',
      already_reported: 'Already reported',
      replaced: 'Replaced by a newer report',
      withdrawn: 'Withdrawn',
    } as Record<string, string>,
    about: ['Item', 'Detail'] as [string, string],
    pairs: ['Question', 'Your answer'] as [string, string],
    ownWords: 'In your own words',
    photos: 'Your photos',
    photo: (n: number, shot: string, at: string) => `Photo ${n}: ${shot}. Sent ${at}.`,
    photoAlt: (n: number, shot: string) => `Photo ${n} you sent of your home: ${shot}.`,
    noPhotos: 'No photos were sent with this report.',
    photosLater: (k: number) =>
      `${k} ${k === 1 ? 'photo is' : 'photos are'} still being processed and not in this copy. Download it again later.`,
    leftOut:
      'Your answers about who you are, how to reach you, your household and your needs are not in this copy. They stay with the county.',
    unknown: 'I don’t know',
    skipped: 'Not answered',
    footer: (code: string) => `Your copy · ${code}`,
  },
  es: {
    made: 'Hecho',
    copyTitle: 'Su reporte de daños',
    copyIntro: (county: string) =>
      `Una copia de lo que le dijo a ${county} sobre su vivienda. Puede guardarla o enviarla a su compañía de seguros con su reclamo. No es una decisión sobre un reclamo ni sobre ayuda.`,
    reference: 'Código de referencia',
    sent: 'Enviado',
    where: 'Dónde está ahora',
    state: {
      received: 'Recibido',
      being_reviewed: 'En revisión',
      needs_your_answer: 'El condado tiene una pregunta para usted',
      reviewed: 'Revisado por el condado',
      not_accepted: 'No aceptado',
      already_reported: 'Ya reportado',
      replaced: 'Reemplazado por un reporte más nuevo',
      withdrawn: 'Retirado',
    } as Record<string, string>,
    about: ['Dato', 'Detalle'] as [string, string],
    pairs: ['Pregunta', 'Su respuesta'] as [string, string],
    ownWords: 'En sus propias palabras',
    photos: 'Sus fotos',
    photo: (n: number, shot: string, at: string) => `Foto ${n}: ${shot}. Enviada ${at}.`,
    photoAlt: (n: number, shot: string) => `Foto ${n} que envió de su vivienda: ${shot}.`,
    noPhotos: 'No se enviaron fotos con este reporte.',
    photosLater: (k: number) =>
      `${k} ${k === 1 ? 'foto se está' : 'fotos se están'} procesando y no ${k === 1 ? 'está' : 'están'} en esta copia. Descárguela de nuevo más tarde.`,
    leftOut:
      'Sus respuestas sobre quién es, cómo comunicarnos con usted, su hogar y sus necesidades no están en esta copia. Se quedan con el condado.',
    unknown: 'No sé',
    skipped: 'Sin respuesta',
    footer: (code: string) => `Su copia · ${code}`,
  },
} as const;

const BCP47: Record<Lang, string> = { en: 'en-US', es: 'es-US' };

/** A time in the county's zone, in the reader's language. */
export function localTime(iso: string, lang: Lang, timeZone: string): string {
  return new Intl.DateTimeFormat(BCP47[lang], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

export function mediaSheetPdf(
  i: MediaPageInput & { timeZone: string; publicBase: string; producer: string },
): PdfDocumentModel {
  const t = T[i.lang];
  const at = (iso: string) => localTime(iso, i.lang, i.timeZone);
  const latest = i.sites.reduce<string | null>(
    (acc, s) => (acc && acc > s.updatedAt ? acc : s.updatedAt),
    null,
  );
  const base = i.publicBase.replace(/\/$/, '');
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: `${i.tenantName}: ${t.media}` },
    { kind: 'paragraph', text: t.danger },
    {
      kind: 'paragraph',
      small: true,
      text: `${t.updated}: ${latest ? at(latest) : '—'} · ${PDF_T[i.lang].made}: ${at(i.generatedAt)}`,
    },
    { kind: 'heading', level: 2, text: t.sites },
  ];
  if (i.sites.length)
    blocks.push({
      kind: 'table',
      caption: t.sites,
      columns: [...t.columns, t.lastConfirmed],
      rowHeaders: true,
      widths: [3, 2, 2.2, 3.6, 2.8, 2, 2.6],
      rows: i.sites.map((s) => [
        s.name,
        t.kind[s.kind] ?? s.kind,
        t.status[s.status] + (s.nextNearest ? `. ${t.nextNearest}: ${s.nextNearest.name}` : ''),
        addressText(s),
        hoursText(s.hours, i.lang),
        t.pets[s.pets],
        s.lastConfirmedAt ? at(s.lastConfirmedAt) : '',
      ]),
    });
  else blocks.push({ kind: 'paragraph', text: t.none });
  blocks.push({ kind: 'heading', level: 2, text: t.resources });
  if (i.resources.length)
    blocks.push({
      kind: 'list',
      items: i.resources.map(
        (r) =>
          `${r.title}${r.summary ? `: ${r.summary}` : ''} (${t.updated} ${r.updatedAt.slice(0, 10)}). ` +
          `${base}/api/public/help/${encodeURIComponent(i.tenantSlug)}/resources/${encodeURIComponent(r.slug)}?lang=${i.lang}`,
      ),
    });
  if (i.helpPhone) blocks.push({ kind: 'paragraph', text: `${t.support}: ${i.helpPhone}` });
  blocks.push({
    kind: 'paragraph',
    text: `${t.help}: ${base}/api/public/help/${encodeURIComponent(i.tenantSlug)}?lang=${i.lang}`,
  });
  blocks.push({ kind: 'paragraph', small: true, text: i.statement });
  return {
    title: `${i.tenantName}: ${t.media}`,
    lang: BCP47[i.lang],
    author: i.tenantName,
    subject: t.media,
    footer: `${i.tenantName} · ${t.media}`,
    producer: i.producer,
    blocks,
  };
}

export interface ResidentCopyInput {
  lang: Lang;
  tenantName: string;
  timeZone: string;
  referenceCode: string;
  submittedAt: string;
  /** A RESIDENT_STATE key ("received", "being_reviewed", …) or "withdrawn". */
  state: string;
  /** Home and damage answers, by section, already in the reader's language. */
  sections: { title: string; items: { prompt: string; answer: string }[] }[];
  ownWords: string | null;
  photos: { image: Buffer; shot: string; sentAt: string }[];
  photosPending: number;
  generatedAt: string;
  producer: string;
}

export function residentCopyPdf(i: ResidentCopyInput): PdfDocumentModel {
  const r = PDF_T[i.lang];
  const at = (iso: string) => localTime(iso, i.lang, i.timeZone);
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: r.copyTitle },
    { kind: 'paragraph', text: r.copyIntro(i.tenantName) },
    {
      kind: 'pairs',
      caption: r.copyTitle,
      headers: [...r.about],
      items: [
        [r.reference, i.referenceCode],
        [r.sent, at(i.submittedAt)],
        [r.where, r.state[i.state] ?? i.state],
      ],
    },
  ];
  for (const s of i.sections) {
    if (!s.items.length) continue;
    blocks.push({ kind: 'heading', level: 2, text: s.title });
    blocks.push({
      kind: 'pairs',
      caption: s.title,
      headers: [...r.pairs],
      items: s.items.map((x) => [x.prompt, x.answer]),
    });
  }
  if (i.ownWords) {
    blocks.push({ kind: 'heading', level: 2, text: r.ownWords });
    for (const para of i.ownWords.split(/\n{2,}/))
      if (para.trim()) blocks.push({ kind: 'paragraph', text: para.trim() });
  }
  blocks.push({ kind: 'heading', level: 2, text: r.photos });
  if (!i.photos.length) blocks.push({ kind: 'paragraph', text: r.noPhotos });
  i.photos.forEach((p, n) =>
    blocks.push({
      kind: 'figure',
      image: p.image,
      alt: r.photoAlt(n + 1, p.shot),
      caption: r.photo(n + 1, p.shot, at(p.sentAt)),
    }),
  );
  if (i.photosPending) blocks.push({ kind: 'paragraph', text: r.photosLater(i.photosPending) });
  blocks.push({ kind: 'paragraph', small: true, text: r.leftOut });
  blocks.push({
    kind: 'paragraph',
    small: true,
    text: `${i.tenantName} · ${r.made}: ${at(i.generatedAt)}`,
  });
  return {
    title: `${r.copyTitle}: ${i.referenceCode}`,
    lang: BCP47[i.lang],
    author: i.tenantName,
    subject: r.copyTitle,
    footer: r.footer(i.referenceCode),
    producer: i.producer,
    blocks,
  };
}
