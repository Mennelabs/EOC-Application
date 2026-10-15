/**
 * The check every AI draft passes before anyone sees it (layer-7 task G;
 * AI-04, AI-09, AI-12, CMD-16, AIG-03). A draft is a list of sentences, each
 * citing the facts it states. It is refused when a sentence cites no fact or
 * a fact that was not given, when a sentence states a figure that is not in
 * the facts it cites, when it is longer than allowed, or when the model saw
 * an attempt to instruct it. A refused draft is never shown: the rules' own
 * draft stays. A draft that passes is still labelled as drafted until a
 * person reads and saves it.
 */
import type { DraftOutput, DraftRequest } from './types.ts';

export interface DraftCheck {
  ok: boolean;
  /** Why it was refused, in words. */
  problems: string[];
  /** The sentences joined, as the person will read it. */
  text: string;
}

/** Figures in a text: digits with thousands separators or decimals, as numbers. */
export function figuresIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

export function checkDraft(out: DraftOutput, req: DraftRequest): DraftCheck {
  const problems: string[] = [];
  const byId = new Map(req.facts.map((f) => [f.id, f]));
  const sentences = out.sentences.filter((s) => s.text.trim());
  if (out.injectionSuspected) problems.push('the facts held text that tried to instruct the model');
  if (!sentences.length) problems.push('the draft is empty');
  for (const [i, s] of sentences.entries()) {
    const n = i + 1;
    if (!s.factIds.length) {
      problems.push(`sentence ${n} cites no fact`);
      continue;
    }
    const unknownIds = s.factIds.filter((id) => !byId.has(id));
    if (unknownIds.length)
      problems.push(`sentence ${n} cites facts that were not given: ${unknownIds.join(', ')}`);
    const allowed = new Set<number>();
    for (const id of s.factIds) {
      const f = byId.get(id);
      if (!f) continue;
      for (const x of figuresIn(`${f.label} ${f.value ?? ''}`)) allowed.add(x);
    }
    const stray = figuresIn(s.text).filter((x) => !allowed.has(x));
    if (stray.length)
      problems.push(
        `sentence ${n} states ${stray.join(', ')}, which the facts it cites do not hold`,
      );
  }
  const text = sentences.map((s) => s.text.trim()).join(' ');
  if (req.maxChars !== undefined && text.length > req.maxChars)
    problems.push(`the draft has ${text.length} characters; at most ${req.maxChars} fit`);
  return { ok: problems.length === 0, problems, text };
}
