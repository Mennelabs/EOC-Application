/**
 * The report in progress (INT-02–06, INT-13–15, INT-21, AC-11B): one
 * execution id from the first answer to the confirmation, the graph's answer
 * shape, step markers kept apart from question answers, and what the
 * submission path receives. Pure functions; screens hold the object.
 */
import {
  nextNode,
  remainingQuestions,
  visibleNodes,
  type Answers,
  type AnswerValue,
  type GraphNode,
  type QuestionGraph,
  type Relationship,
  type SessionContext,
} from '@cg/intake';
import type { SubmissionBody } from '../api/public.ts';

export type StepMark = 'done' | 'skipped';

export interface PhotoRecord {
  photoId: string;
  shot: string;
  status: 'uploading' | 'uploaded' | 'failed';
  takenAt?: string;
}

export interface FlowState {
  executionId: string;
  tenant: string;
  event: string;
  language: string;
  channel: 'web' | 'assisted';
  graphKey: string;
  graphVersion: number;
  hazards: string[];
  relationship?: Relationship | undefined;
  answers: Answers;
  steps: Record<string, StepMark>;
  ownWords?: string | undefined;
  needs: string[];
  consent: Record<string, boolean>;
  photos: PhotoRecord[];
  afterSubmission: Answers;
  aiOff: boolean;
  aiAssisted: boolean;
  extractionId?: string | undefined;
  /** Question ids whose answer came from the resident's words (INT-13; marked on review). */
  fromWords: string[];
  smsOptIn: boolean;
  /** Visited node ids, for Back. */
  history: string[];
  /** The node being shown; null means "the next unanswered one". */
  current: string | null;
  startedAt: number;
  /** ORG-01: reference numbers of the places this organization already reported in this visit. */
  earlierPlaces?: string[];
}

/** Where the report in progress is kept on the device, encrypted (storage.ts). */
export const FLOW_KEY = 'flow';

export function newFlow(input: {
  tenant: string;
  event: string;
  language: string;
  channel: 'web' | 'assisted';
  graph: QuestionGraph;
  hazards: string[];
  relationship?: Relationship;
}): FlowState {
  return {
    executionId: crypto.randomUUID(),
    tenant: input.tenant,
    event: input.event,
    language: input.language,
    channel: input.channel,
    graphKey: input.graph.key,
    graphVersion: input.graph.version,
    hazards: input.hazards,
    ...(input.relationship ? { relationship: input.relationship } : {}),
    answers: input.relationship
      ? { relationship: { kind: 'value', value: input.relationship } }
      : {},
    steps: {},
    needs: [],
    consent: {},
    photos: [],
    afterSubmission: {},
    aiOff: false,
    aiAssisted: false,
    fromWords: [],
    smsOptIn: false,
    history: [],
    current: null,
    startedAt: Date.now(),
  };
}

export function contextOf(state: FlowState): SessionContext {
  const rel = state.answers['relationship'];
  const relationship =
    rel && rel.kind === 'value' && typeof rel.value === 'string'
      ? (rel.value as Relationship)
      : state.relationship;
  return {
    hazards: state.hazards as SessionContext['hazards'],
    channel: state.channel,
    ...(relationship ? { relationship } : {}),
  };
}

/** Question answers plus step markers, the shape the engine walks. */
export function engineAnswers(state: FlowState): Answers {
  const all: Answers = { ...state.answers };
  for (const [id, mark] of Object.entries(state.steps))
    all[id] = mark === 'done' ? { kind: 'value', value: 'done' } : { kind: 'skipped' };
  return all;
}

export function currentNode(graph: QuestionGraph, state: FlowState): GraphNode | null {
  const ctx = contextOf(state);
  const answers = engineAnswers(state);
  if (state.current) {
    const node = graph.nodes.find((n) => n.id === state.current);
    if (node && visibleNodes(graph, ctx, answers).includes(node)) return node;
  }
  return nextNode(graph, ctx, answers);
}

export function remaining(graph: QuestionGraph, state: FlowState, nodeId: string): number {
  return remainingQuestions(graph, contextOf(state), engineAnswers(state), nodeId);
}

/** After an answer: remember where we were, move to the next unanswered node. */
export function advance(state: FlowState, fromId: string): FlowState {
  return { ...state, history: [...state.history, fromId], current: null };
}

export function goBack(state: FlowState): FlowState {
  const history = [...state.history];
  const last = history.pop();
  return last ? { ...state, history, current: last } : state;
}

export function jumpTo(state: FlowState, nodeId: string, fromId: string | null): FlowState {
  return {
    ...state,
    history: fromId ? [...state.history, fromId] : state.history,
    current: nodeId,
  };
}

export function answer(state: FlowState, id: string, value: AnswerValue): FlowState {
  const fromWords = state.fromWords.filter((q) => q !== id);
  return { ...state, answers: { ...state.answers, [id]: value }, fromWords };
}

export function markStep(state: FlowState, id: string, mark: StepMark): FlowState {
  return { ...state, steps: { ...state.steps, [id]: mark } };
}

/** The submission body (public/submit.ts): question answers only, never step markers. */
export function toSubmission(state: FlowState, graph: QuestionGraph): SubmissionBody {
  const questionIds = new Set(graph.nodes.filter((n) => n.kind === 'question').map((n) => n.id));
  const answers: Answers = {};
  for (const [id, v] of Object.entries(state.answers)) if (questionIds.has(id)) answers[id] = v;
  const rel = answers['relationship'];
  const relationship =
    rel && rel.kind === 'value' && typeof rel.value === 'string'
      ? (rel.value as Relationship)
      : (state.relationship ?? 'own_home');
  const helperConsent = answers['helper_consent'];
  return {
    executionId: state.executionId,
    channel: state.channel,
    language: state.language,
    graphKey: state.graphKey,
    graphVersion: state.graphVersion,
    relationship,
    answers,
    ...(state.ownWords ? { ownWords: state.ownWords } : {}),
    needs: state.needs,
    consent: state.consent,
    photoIds: state.photos.filter((p) => p.status === 'uploaded').map((p) => p.photoId),
    afterSubmission: {},
    smsOptIn: state.smsOptIn,
    aiAssisted: state.aiAssisted && state.fromWords.length > 0,
    ...(state.extractionId && state.fromWords.length > 0
      ? { extractionId: state.extractionId }
      : {}),
    ...(state.channel === 'assisted'
      ? {
          // CHN-06, AC-A09: the person reporting their own home or organization agrees by
          // reporting; for someone else's home, only the helper's "yes, they agreed" records it.
          assisted: {
            consentRecorded:
              relationship === 'own_home' || relationship === 'organization'
                ? true
                : relationship === 'helper' &&
                  helperConsent?.kind === 'value' &&
                  helperConsent.value === 'yes',
          },
        }
      : {}),
  };
}

/**
 * ORG-01: the next place an organization reports in the same visit. It is a report of its own
 * (a new execution id, so its own reference number); the answers about who is reporting carry
 * over, and how to reach them too unless the device was cleared. Everything about the place
 * starts again, the safety question first.
 */
export function nextPlace(
  state: FlowState,
  graph: QuestionGraph,
  referenceCode: string,
  keepContact: boolean,
): FlowState {
  const sections = keepContact ? ['who', 'contact'] : ['who'];
  const carried = new Set(
    graph.nodes
      .filter((n) => n.kind === 'question' && sections.includes(n.section))
      .map((n) => n.id),
  );
  const answers: Answers = {};
  for (const [id, v] of Object.entries(state.answers)) if (carried.has(id)) answers[id] = v;
  return {
    ...newFlow({
      tenant: state.tenant,
      event: state.event,
      language: state.language,
      channel: state.channel,
      graph,
      hazards: state.hazards,
      ...(state.relationship ? { relationship: state.relationship } : {}),
    }),
    answers,
    smsOptIn: keepContact && state.smsOptIn,
    earlierPlaces: [...(state.earlierPlaces ?? []), referenceCode],
  };
}

/** Letters and digits read one by one, for screen readers (ACC-50). */
export function spellCode(code: string): string {
  return code
    .replace('-', ' ')
    .split('')
    .join(' ')
    .replace(/\s{2,}/g, ', ');
}
