/**
 * The resident's own copy of their report (layer-6 task I; FL:FR-32): what
 * they told the county about the home and the damage, in their own words,
 * and their photos, gathered for residentCopyPdf. Only the "home" and
 * "event" sections of the question graph are read; the rest (who they
 * are, how to reach them, their household and their needs) stays out.
 * Photos are the processed review images (EXIF and location stripped),
 * re-encoded as JPEG for the PDF; they are the resident's own, so they are
 * not blurred.
 */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Transaction } from 'kysely';
import sharp from 'sharp';
import type { FieldCrypto } from '@cg/crypto';
import type { Database } from '@cg/db';
import { renderAnswer, text, type AnswerValue, type QuestionGraph } from '@cg/intake';
import { PDF_T, type ResidentCopyInput } from './pdf.ts';
import type { Lang } from './render.ts';
import { loadGraph } from './submit.ts';

const SECTIONS = new Set(['home', 'event']);
const MAX_PHOTOS = 20;

export interface CopyDeps {
  crypto: Pick<FieldCrypto, 'decrypt'>;
  objects?: { client: S3Client; bucket: string } | undefined;
  defaultGraph: QuestionGraph;
}

const RESIDENT_STATE: Record<string, string> = {
  submitted: 'received',
  under_review: 'being_reviewed',
  needs_information: 'needs_your_answer',
  approved: 'reviewed',
  rejected: 'not_accepted',
  duplicate: 'already_reported',
  superseded: 'replaced',
};

async function jpeg(objects: NonNullable<CopyDeps['objects']>, key: string): Promise<Buffer> {
  const res = await objects.client.send(new GetObjectCommand({ Bucket: objects.bucket, Key: key }));
  const body = Buffer.from(await res.Body!.transformToByteArray());
  return sharp(body)
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

/** Everything the copy shows, or null when the report is not there. */
export async function loadResidentCopy(
  trx: Transaction<Database>,
  deps: CopyDeps,
  o: { tenantId: string; tenantName: string; reportId: string; lang: Lang; now: Date },
): Promise<Omit<ResidentCopyInput, 'producer'> | null> {
  const report = await trx
    .selectFrom('cg.report as r')
    .innerJoin('cg.tenant as t', 't.id', 'r.tenant_id')
    .select([
      'r.id',
      'r.reference_code',
      'r.submitted_at',
      'r.review_state',
      'r.withdrawn_at',
      'r.graph_key',
      'r.graph_version',
      'r.answers',
      'r.answers_enc',
      'r.original_text_enc',
      't.timezone',
    ])
    .where('r.id', '=', o.reportId)
    .where('r.tenant_id', '=', o.tenantId)
    .executeTakeFirst();
  if (!report) return null;
  const graph = await loadGraph(trx, report.graph_key, report.graph_version, deps.defaultGraph);
  const answers: Record<string, AnswerValue> = {
    ...(report.answers as Record<string, AnswerValue>),
    ...(report.answers_enc
      ? (JSON.parse(await deps.crypto.decrypt(o.tenantId, report.answers_enc)) as Record<
          string,
          AnswerValue
        >)
      : {}),
  };
  const r = PDF_T[o.lang];
  const sections = graph.sections
    .filter((s) => SECTIONS.has(s.id))
    .map((s) => ({
      title: text(s.title, o.lang),
      items: graph.nodes.flatMap((n) => {
        if (n.kind !== 'question' || n.section !== s.id) return [];
        const a = answers[n.id];
        if (!a || a.kind === 'skipped') return [];
        const out = renderAnswer(n, a, o.lang, r.unknown, r.skipped);
        return [{ prompt: text(n.prompt, o.lang), answer: out.answer }];
      }),
    }));
  const ownWords = report.original_text_enc
    ? await deps.crypto.decrypt(o.tenantId, report.original_text_enc)
    : null;

  const rows = await trx
    .selectFrom('cg.photo')
    .select(['id', 'shot', 'status', 'derivative_keys', 'uploaded_at', 'created_at'])
    .where('report_id', '=', report.id)
    .where('status', 'in', ['uploading', 'uploaded', 'processed'])
    .orderBy('created_at')
    .execute();
  const ready = rows.filter(
    (p) => p.status === 'processed' && (p.derivative_keys as Record<string, string>)['review'],
  );
  const photos: ResidentCopyInput['photos'] = [];
  if (deps.objects)
    for (const p of ready.slice(0, MAX_PHOTOS)) {
      const shot = graph.shots.find((x) => x.id === p.shot);
      photos.push({
        image: await jpeg(deps.objects, (p.derivative_keys as Record<string, string>)['review']!),
        shot: shot ? text(shot.title, o.lang) : p.shot,
        sentAt: (p.uploaded_at ?? p.created_at).toISOString(),
      });
    }
  return {
    lang: o.lang,
    tenantName: o.tenantName,
    timeZone: report.timezone,
    referenceCode: report.reference_code,
    submittedAt: report.submitted_at.toISOString(),
    state: report.withdrawn_at
      ? 'withdrawn'
      : (RESIDENT_STATE[report.review_state] ?? report.review_state),
    sections,
    ownWords: ownWords?.trim() ? ownWords.trim() : null,
    photos,
    photosPending: rows.length - ready.length,
    generatedAt: o.now.toISOString(),
  };
}
