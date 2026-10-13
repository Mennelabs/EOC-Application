/**
 * Server-side validation of extraction output against the question graph
 * (AIG-03): only known questions, only valid values, bounded counts, a
 * confidence in range and non-empty evidence. Anything else is dropped and
 * reported, never shown.
 */
import { z } from 'zod';
import {
  validateAnswer,
  type AnswerValue,
  type QuestionGraph,
  type QuestionNode,
} from '@cg/intake';
import type { ExtractionCandidate, ExtractionOutput, ExtractionQuestion } from './types.ts';

const answerValueSchema = z.union([
  z.object({ kind: z.literal('unknown') }),
  z.object({ kind: z.literal('skipped') }),
  z.object({
    kind: z.literal('value'),
    value: z.union([
      z.string().max(4000),
      z.array(z.string().max(200)).max(50),
      z.number(),
      z.boolean(),
      z.record(z.string(), z.string().max(500)),
    ]),
  }),
]);

export const extractionOutputSchema = z.object({
  candidates: z
    .array(
      z.object({
        questionId: z.string().min(1).max(64),
        value: answerValueSchema,
        confidence: z.number().min(0).max(1),
        evidence: z.string().min(1).max(500),
      }),
    )
    .max(40),
  language: z.string().min(2).max(10).optional(),
  injectionSuspected: z.boolean().optional(),
});

export function extractionQuestions(graph: QuestionGraph): ExtractionQuestion[] {
  const out: ExtractionQuestion[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'question') continue;
    // Contact details and names are never extracted: they are typed by the resident (SEC-10).
    if (
      n.answerType === 'contact' ||
      n.answerType === 'address' ||
      n.classification === 'restricted'
    )
      continue;
    out.push({
      id: n.id,
      answerType: n.answerType,
      ...(n.options ? { options: n.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    });
  }
  return out;
}

export interface ValidatedExtraction {
  candidates: ExtractionCandidate[];
  dropped: { questionId: string; reason: string }[];
  language?: string;
  injectionSuspected: boolean;
}

export function validateExtraction(graph: QuestionGraph, raw: unknown): ValidatedExtraction {
  const parsed = extractionOutputSchema.safeParse(raw);
  if (!parsed.success)
    return {
      candidates: [],
      dropped: [{ questionId: '*', reason: 'schema' }],
      injectionSuspected: false,
    };
  const allowed = new Map<string, QuestionNode>();
  for (const q of extractionQuestions(graph)) {
    const node = graph.nodes.find((n): n is QuestionNode => n.kind === 'question' && n.id === q.id);
    if (node) allowed.set(q.id, node);
  }
  const candidates: ExtractionCandidate[] = [];
  const dropped: ValidatedExtraction['dropped'] = [];
  const seen = new Set<string>();
  for (const c of parsed.data.candidates) {
    const q = allowed.get(c.questionId);
    if (!q) {
      dropped.push({ questionId: c.questionId, reason: 'unknown_question' });
      continue;
    }
    if (seen.has(c.questionId)) {
      dropped.push({ questionId: c.questionId, reason: 'duplicate' });
      continue;
    }
    if (c.value.kind !== 'value') {
      dropped.push({ questionId: c.questionId, reason: 'not_a_value' });
      continue;
    }
    const errors = validateAnswer(q, c.value as AnswerValue);
    if (errors.length > 0) {
      dropped.push({ questionId: c.questionId, reason: errors[0]!.code });
      continue;
    }
    seen.add(c.questionId);
    candidates.push({
      questionId: c.questionId,
      value: c.value as AnswerValue,
      confidence: c.confidence,
      evidence: c.evidence,
    });
  }
  const out: ValidatedExtraction = {
    candidates,
    dropped,
    injectionSuspected: parsed.data.injectionSuspected === true,
  };
  if (parsed.data.language) out.language = parsed.data.language;
  return out;
}

export type { ExtractionOutput };
