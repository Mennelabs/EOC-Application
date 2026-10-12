/**
 * Deterministic question engine (INT-01–06, INT-14, INT-21). Pure functions
 * over a graph, a session context and the answers so far; the same engine
 * runs the web, SMS, voice and assisted channels (CHN-01) and never depends
 * on AI (INT-16).
 */
import type {
  Channel,
  Condition,
  GraphNode,
  Hazard,
  LocalizedText,
  NeedSignalKind,
  QuestionGraph,
  QuestionNode,
  Relationship,
  SectionId,
} from './schema.ts';

export type AnswerValue =
  { kind: 'value'; value: AnswerPayload } | { kind: 'unknown' } | { kind: 'skipped' };

/** Answers keyed by node id; step nodes record `{kind:'value', value:'done'}` or skipped. */
export type Answers = Record<string, AnswerValue>;

export interface SessionContext {
  hazards: Hazard[];
  channel: Channel;
  relationship?: Relationship;
}

const CAUSE_HAZARDS: Record<string, Hazard[]> = {
  wind_tornado: ['wind', 'tornado'],
  flood: ['flood'],
  fire: ['fire'],
  winter_storm: ['winter_storm'],
};

export type AnswerPayload = string | string[] | number | boolean | Record<string, string>;

export function text(t: LocalizedText, locale: string): string {
  return t[locale] ?? t['en'] ?? '';
}

function answeredValue(a: AnswerValue | undefined): AnswerPayload | undefined {
  return a && a.kind === 'value' ? a.value : undefined;
}

export function evaluateCondition(c: Condition, answers: Answers): boolean {
  const a = answers[c.q];
  const v = answeredValue(a);
  switch (c.op) {
    case 'answered':
      return a !== undefined && a.kind === 'value';
    case 'unknown':
      return a !== undefined && a.kind === 'unknown';
    case 'eq':
      return v !== undefined && !Array.isArray(v) && v === c.value;
    case 'neq':
      return v !== undefined && !Array.isArray(v) && v !== c.value;
    case 'in':
      return v !== undefined && !Array.isArray(v) && (c.value as string[]).includes(String(v));
    case 'includes':
      return Array.isArray(v) && v.includes(String(c.value));
  }
}

/** Hazards in play: the event's plus the ones implied by the cause answer (INT-03). */
export function activeHazards(ctx: SessionContext, answers: Answers): Hazard[] {
  const set = new Set<Hazard>(ctx.hazards);
  const cause = answeredValue(answers['cause']);
  if (typeof cause === 'string') for (const h of CAUSE_HAZARDS[cause] ?? []) set.add(h);
  return [...set];
}

function relationship(ctx: SessionContext, answers: Answers): Relationship | undefined {
  const r = answeredValue(answers['relationship']);
  return (typeof r === 'string' ? (r as Relationship) : undefined) ?? ctx.relationship;
}

export function isAsked(node: GraphNode, ctx: SessionContext, answers: Answers): boolean {
  if (node.channels && !node.channels.includes(ctx.channel)) return false;
  if (node.relationships) {
    const r = relationship(ctx, answers);
    if (!r || !node.relationships.includes(r)) return false;
  }
  if (node.hazards) {
    const active = activeHazards(ctx, answers);
    if (!node.hazards.some((h) => active.includes(h))) return false;
  }
  for (const c of node.showIf ?? []) if (!evaluateCondition(c, answers)) return false;
  return true;
}

export function visibleNodes(
  graph: QuestionGraph,
  ctx: SessionContext,
  answers: Answers,
): GraphNode[] {
  return graph.nodes.filter((n) => isAsked(n, ctx, answers));
}

/** The first visible node without an answer, or null when the flow is complete. */
export function nextNode(
  graph: QuestionGraph,
  ctx: SessionContext,
  answers: Answers,
): GraphNode | null {
  for (const node of visibleNodes(graph, ctx, answers)) {
    if (node.kind === 'info') {
      if (!answers[node.id]) return node;
      continue;
    }
    if (!answers[node.id]) return node;
  }
  return null;
}

/** Questions still to come after `currentId`, for "About N questions left" (INT-06). */
export function remainingQuestions(
  graph: QuestionGraph,
  ctx: SessionContext,
  answers: Answers,
  currentId: string,
): number {
  const nodes = visibleNodes(graph, ctx, answers);
  const idx = nodes.findIndex((n) => n.id === currentId);
  return nodes.slice(idx + 1).filter((n) => n.kind === 'question' && !answers[n.id]).length;
}

export type ProgressBand = { band: 'about'; remaining: number } | { band: 'last' };

export function progress(remaining: number): ProgressBand {
  return remaining === 0 ? { band: 'last' } : { band: 'about', remaining };
}

export interface ValidationError {
  code:
    | 'required'
    | 'unknown_not_allowed'
    | 'invalid_option'
    | 'negative'
    | 'out_of_range'
    | 'type'
    | 'empty';
  message: string;
}

/** Validates one answer against its question without losing the input (BRD:FR-10.07). */
export function validateAnswer(q: QuestionNode, answer: AnswerValue): ValidationError[] {
  const errors: ValidationError[] = [];
  if (answer.kind === 'skipped') {
    if (q.required)
      errors.push({
        code: 'required',
        message: 'This question needs an answer or "I don\'t know".',
      });
    return errors;
  }
  if (answer.kind === 'unknown') {
    if (!q.allowUnknown)
      errors.push({ code: 'unknown_not_allowed', message: 'Please choose an answer.' });
    return errors;
  }
  const v = answer.value;
  const optionValues = new Set((q.options ?? []).map((o) => o.value));
  switch (q.answerType) {
    case 'single':
      if (typeof v !== 'string' || !optionValues.has(v))
        errors.push({ code: 'invalid_option', message: 'Choose one of the options.' });
      break;
    case 'multi':
      if (!Array.isArray(v) || v.length === 0 || v.some((x) => !optionValues.has(x)))
        errors.push({ code: 'invalid_option', message: 'Choose one or more of the options.' });
      break;
    case 'yesno':
      if (typeof v !== 'boolean' && v !== 'yes' && v !== 'no' && v !== 'not_sure')
        errors.push({ code: 'type', message: 'Answer yes, no or not sure.' });
      break;
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) errors.push({ code: 'type', message: 'Enter a number.' });
      else if (n < 0)
        errors.push({ code: 'negative', message: 'The number cannot be below zero.' });
      else if ((q.min !== undefined && n < q.min) || (q.max !== undefined && n > q.max))
        errors.push({ code: 'out_of_range', message: 'That number is out of range.' });
      break;
    }
    case 'text':
      if (typeof v !== 'string' || v.trim() === '')
        errors.push({ code: 'empty', message: 'Please write something or skip.' });
      break;
    case 'address':
    case 'contact':
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        errors.push({ code: 'type', message: 'Fill in the fields or skip.' });
      else if (!Object.values(v).some((x) => typeof x === 'string' && x.trim() !== ''))
        errors.push({ code: 'empty', message: 'Fill in at least one field or skip.' });
      break;
  }
  return errors;
}

export interface SummaryItem {
  id: string;
  prompt: string;
  answer: string;
  state: 'answered' | 'unknown' | 'skipped';
}
export interface SummarySection {
  section: SectionId;
  title: string;
  items: SummaryItem[];
}

const ADDRESS_FIELDS = ['line1', 'unit', 'city', 'state', 'postal', 'landmark', 'note'];
const CONTACT_FIELDS = ['phone', 'email', 'preferred'];

export function renderAnswer(
  q: QuestionNode,
  answer: AnswerValue | undefined,
  locale: string,
  unknownText: string,
  skippedText: string,
): { answer: string; state: SummaryItem['state'] } {
  if (!answer || answer.kind === 'skipped') return { answer: skippedText, state: 'skipped' };
  if (answer.kind === 'unknown') return { answer: unknownText, state: 'unknown' };
  const v = answer.value;
  const label = (value: string) => {
    const o = (q.options ?? []).find((x) => x.value === value);
    return o ? text(o.label, locale) : value;
  };
  if (Array.isArray(v)) return { answer: v.map(label).join(', '), state: 'answered' };
  if (typeof v === 'boolean') return { answer: v ? 'yes' : 'no', state: 'answered' };
  if (typeof v === 'number') return { answer: String(v), state: 'answered' };
  if (typeof v === 'object') {
    const order = q.answerType === 'address' ? ADDRESS_FIELDS : CONTACT_FIELDS;
    const parts = order
      .map((k) => v[k])
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return { answer: parts.join(', '), state: 'answered' };
  }
  return { answer: q.options ? label(v) : v, state: 'answered' };
}

/** Plain-language summary grouped by section, every item editable in the UI (INT-21). */
export function summary(
  graph: QuestionGraph,
  ctx: SessionContext,
  answers: Answers,
  locale: string,
  labels: { unknown: string; skipped: string },
): SummarySection[] {
  const out: SummarySection[] = [];
  for (const section of graph.sections) {
    const items: SummaryItem[] = [];
    for (const node of visibleNodes(graph, ctx, answers)) {
      if (node.kind !== 'question' || node.section !== section.id) continue;
      const r = relationship(ctx, answers);
      const prompt = text((r && node.promptFor?.[r]) ?? node.prompt, locale);
      const rendered = renderAnswer(node, answers[node.id], locale, labels.unknown, labels.skipped);
      items.push({ id: node.id, prompt, ...rendered });
    }
    if (items.length > 0)
      out.push({ section: section.id, title: text(section.title, locale), items });
  }
  return out;
}

export type NeedSignals = Record<NeedSignalKind, boolean>;

/** Need signals for queue ordering: people first, AI severity second (PHO-14). */
export function needSignals(
  graph: QuestionGraph,
  answers: Answers,
  needs: string[] = [],
): NeedSignals {
  const s: NeedSignals = { unsafe: false, displaced: false, no_shelter: false, medical: false };
  for (const node of [...graph.nodes, ...graph.afterSubmission]) {
    if (node.kind !== 'question' || !node.needSignal) continue;
    const v = answeredValue(answers[node.id]);
    const values = Array.isArray(v) ? v : v === undefined ? [] : [String(v)];
    if (values.some((x) => node.needSignal!.when.includes(x))) s[node.needSignal.signal] = true;
  }
  for (const c of graph.needCategories) if (c.signal && needs.includes(c.value)) s[c.signal] = true;
  return s;
}

/** FEMA/PDA field values from the answers (docs/05); unknown stays distinguishable (AC-10A). */
export function femaMapping(
  graph: QuestionGraph,
  answers: Answers,
): Record<string, string | string[] | number | 'unknown'> {
  const out: Record<string, string | string[] | number | 'unknown'> = {};
  for (const node of [...graph.nodes, ...graph.afterSubmission]) {
    if (node.kind !== 'question' || !node.fema) continue;
    const a = answers[node.id];
    if (!a || a.kind === 'skipped') continue;
    if (a.kind === 'unknown') {
      out[node.fema] = 'unknown';
      continue;
    }
    const map = (value: string) =>
      (node.options ?? []).find((o) => o.value === value)?.femaValue ?? value;
    const v = a.value;
    if (Array.isArray(v)) out[node.fema] = v.map(map);
    else if (typeof v === 'string') out[node.fema] = map(v);
    else if (typeof v === 'number') out[node.fema] = v;
    else if (typeof v === 'boolean') out[node.fema] = v ? 'yes' : 'no';
  }
  return out;
}

/**
 * The shortest path for a relationship: nodes asked when nothing has been
 * answered yet (conditions on unanswered questions do not fire). Used by the
 * INT-04 test: at most 12 required questions.
 */
export function shortestPath(
  graph: QuestionGraph,
  relationshipKind: Relationship,
  channel: Channel = 'web',
) {
  const ctx: SessionContext = { hazards: [], channel, relationship: relationshipKind };
  const nodes = visibleNodes(graph, ctx, {});
  const questions = nodes.filter((n): n is QuestionNode => n.kind === 'question');
  return {
    nodes: nodes.map((n) => n.id),
    questions: questions.length,
    required: questions.filter((q) => q.required).length,
  };
}
