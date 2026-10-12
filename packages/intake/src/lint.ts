/**
 * String rules for the question graph, measured in CI (INT-08, INT-17, INT-18,
 * INT-09): reading level at or below grade 5 for every prompt (Flesch–Kincaid
 * on the English text), no exclamation marks or emoji, no blame, no FEMA
 * jargon. A person still reviews the wording (the lint CLI prints the table
 * for that review).
 */
import type { QuestionGraph } from './schema.ts';

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  let s = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g)?.length;
  s = s ?? 1;
  return Math.max(1, s);
}

/** Flesch–Kincaid grade level; short, plain sentences score low. */
export function readingGrade(textValue: string): number {
  const sentences = Math.max(1, (textValue.match(/[.!?]+(\s|$)/g) ?? []).length || 1);
  const words = textValue.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
  if (words.length === 0) return 0;
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const grade = 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
  return Math.round(Math.max(0, grade) * 10) / 10;
}

const BLAME = [
  /why (did|didn|don|have|haven|were|weren)/i,
  /should have/i,
  /\bfail(ed)? to\b/i,
  /your fault/i,
];
const JARGON = [
  /habitab/i,
  /\bresidence\b/i,
  /\bperil\b/i,
  /\bdwelling\b/i,
  /\bstructure\b/i,
  /\bmitigat/i,
  /\bevacuat/i,
  /\binsure\b/i,
  /\bprepared\b/i,
];
const EMOJI = /\p{Extended_Pictographic}/u;

export interface LintFinding {
  nodeId: string;
  field: string;
  locale: string;
  rule: 'grade' | 'exclamation' | 'emoji' | 'blame' | 'jargon';
  detail: string;
}

export interface LintOptions {
  /** Maximum grade for prompts (INT-08). */
  promptGrade?: number;
  /** Maximum grade for reasons, examples, bodies and descriptions (sentences only). */
  supportGrade?: number;
}

/** Readability formulas assume sentences; fragments shorter than this are tone-checked only. */
const MIN_WORDS_FOR_GRADE = 4;

export function lintText(
  nodeId: string,
  field: string,
  locale: string,
  value: string,
  maxGrade: number | null,
  out: LintFinding[],
) {
  if (/!|¡/.test(value)) out.push({ nodeId, field, locale, rule: 'exclamation', detail: value });
  if (EMOJI.test(value)) out.push({ nodeId, field, locale, rule: 'emoji', detail: value });
  if (locale === 'en') {
    for (const re of BLAME)
      if (re.test(value)) out.push({ nodeId, field, locale, rule: 'blame', detail: value });
    if (field === 'prompt')
      for (const re of JARGON)
        if (re.test(value)) out.push({ nodeId, field, locale, rule: 'jargon', detail: value });
    const words = value.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
    if (maxGrade !== null && words >= MIN_WORDS_FOR_GRADE) {
      const g = readingGrade(value);
      if (g > maxGrade)
        out.push({
          nodeId,
          field,
          locale,
          rule: 'grade',
          detail: `grade ${g} > ${maxGrade}: ${value}`,
        });
    }
  }
}

export function lintGraph(graph: QuestionGraph, opts: LintOptions = {}): LintFinding[] {
  const promptGrade = opts.promptGrade ?? 5;
  const supportGrade = opts.supportGrade ?? 8;
  const out: LintFinding[] = [];
  const nodes = [...graph.nodes, ...graph.afterSubmission];
  for (const node of nodes) {
    const texts: [string, Record<string, string>, number | null][] = [];
    if (node.kind === 'question') {
      texts.push(
        ['prompt', node.prompt, promptGrade],
        ['why', node.why, supportGrade],
        ['example', node.example, supportGrade],
      );
      for (const alt of Object.values(node.promptFor ?? {}))
        texts.push(['prompt', alt, promptGrade]);
      for (const o of node.options ?? []) {
        texts.push([`option:${o.value}`, o.label, null]);
        if (o.hint) texts.push([`hint:${o.value}`, o.hint, null]);
      }
    } else {
      texts.push(['title', node.title, supportGrade]);
      if (node.body) texts.push(['body', node.body, supportGrade]);
    }
    for (const [field, t, grade] of texts)
      for (const [locale, value] of Object.entries(t))
        lintText(node.id, field, locale, value, grade, out);
  }
  for (const s of graph.shots) {
    for (const [locale, value] of Object.entries(s.title))
      lintText(`shot:${s.id}`, 'title', locale, value, supportGrade, out);
    for (const [locale, value] of Object.entries(s.example))
      lintText(`shot:${s.id}`, 'example', locale, value, supportGrade, out);
  }
  for (const c of graph.needCategories)
    for (const [locale, value] of Object.entries(c.label))
      lintText(`need:${c.value}`, 'label', locale, value, null, out);
  for (const c of graph.consentOrgTypes) {
    for (const [locale, value] of Object.entries(c.label))
      lintText(`consent:${c.value}`, 'label', locale, value, null, out);
    for (const [locale, value] of Object.entries(c.description))
      lintText(`consent:${c.value}`, 'description', locale, value, supportGrade, out);
  }
  for (const [locale, value] of Object.entries(graph.emergencyInstructions))
    lintText('emergency', 'body', locale, value, supportGrade, out);
  for (const [locale, value] of Object.entries(graph.photoSafetyLine))
    lintText('photo_safety', 'line', locale, value, supportGrade, out);
  return out;
}

/** Grade table for the human review step of INT-08. */
export function gradeTable(graph: QuestionGraph): { id: string; prompt: string; grade: number }[] {
  return [...graph.nodes, ...graph.afterSubmission]
    .filter((n) => n.kind === 'question')
    .map((n) => ({
      id: n.id,
      prompt: n.prompt['en'] ?? '',
      grade: readingGrade(n.prompt['en'] ?? ''),
    }));
}
