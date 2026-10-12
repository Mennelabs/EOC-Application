/** INT-01, INT-03, INT-04, INT-05, DCL:DEC-01, WIT-01, HLP-01, ORG-01: the default graph and its branching. */
import { describe, expect, it } from 'vitest';
import {
  femaMapping,
  isAsked,
  needSignals,
  nextNode,
  parseGraph,
  progress,
  questionGraphSchema,
  remainingQuestions,
  shortestPath,
  summary,
  validateAnswer,
  visibleNodes,
  westwindGraph,
  type AnswerPayload,
  type AnswerValue,
  type Answers,
  type QuestionNode,
  type SessionContext,
} from '../src/index.ts';

const web = (
  relationship: 'own_home' | 'helper' | 'witness' | 'organization',
  hazards: SessionContext['hazards'] = [],
): SessionContext => ({
  channel: 'web',
  hazards,
  relationship,
});
const v = (value: AnswerPayload): AnswerValue => ({ kind: 'value', value });

function question(id: string): QuestionNode {
  const n = [...westwindGraph.nodes, ...westwindGraph.afterSubmission].find((x) => x.id === id);
  if (!n || n.kind !== 'question') throw new Error(`no question ${id}`);
  return n;
}

describe('default graph (INT-01)', () => {
  it('validates against the schema and the cross-checks', () => {
    expect(questionGraphSchema.safeParse(westwindGraph).success).toBe(true);
    expect(() => parseGraph(westwindGraph)).not.toThrow();
  });

  it('rejects a condition on an unknown question and a closed question without options', () => {
    const broken = structuredClone(westwindGraph) as unknown as {
      nodes: Record<string, unknown>[];
    };
    (broken.nodes[1] as { showIf: unknown }).showIf = [{ q: 'nope', op: 'eq', value: 'x' }];
    expect(() => parseGraph(broken)).toThrow(/unknown question/);
    const broken2 = structuredClone(westwindGraph) as unknown as {
      nodes: Record<string, unknown>[];
    };
    delete (broken2.nodes[2] as { options?: unknown }).options;
    expect(() => parseGraph(broken2)).toThrow(/without options/);
  });

  it('starts with the safety question (INT-07)', () => {
    expect(westwindGraph.nodes[0]?.id).toBe('danger_now');
    expect(nextNode(westwindGraph, web('own_home'), {})?.id).toBe('danger_now');
  });

  it('shows emergency instructions after a yes, then continues (CON-10, ACC-48)', () => {
    const answers: Answers = { danger_now: v('yes') };
    expect(nextNode(westwindGraph, web('own_home'), answers)?.id).toBe('danger_info');
    answers['danger_info'] = v('seen');
    expect(nextNode(westwindGraph, web('own_home'), answers)?.id).toBe('relationship');
    expect(needSignals(westwindGraph, answers).unsafe).toBe(true);
  });

  it('carries every DCL:DEC-01 field with a FEMA mapping and an unknown option', () => {
    for (const id of [
      'home_type',
      'primary_residence',
      'insurance',
      'cause',
      'water_depth',
      'tonight',
    ]) {
      const q = question(id);
      expect(q.fema, id).toBeTruthy();
      expect(q.allowUnknown, id).toBe(true);
    }
    expect(westwindGraph.afterSubmission.map((q: QuestionNode) => q.id)).toEqual(
      expect.arrayContaining(['hurt_missing', 'lost_work']),
    );
  });

  it('gives every question one example and one reason in each language (INT-10, EQ-06)', () => {
    for (const n of [...westwindGraph.nodes, ...westwindGraph.afterSubmission]) {
      if (n.kind !== 'question') continue;
      for (const lang of westwindGraph.languages) {
        expect(n.why[lang], `${n.id} why ${lang}`).toBeTruthy();
        expect(n.example[lang], `${n.id} example ${lang}`).toBeTruthy();
      }
    }
  });
});

describe('branching (INT-03)', () => {
  it('renters never see owner-only or organization questions', () => {
    const answers: Answers = {
      danger_now: v('no'),
      relationship: v('own_home'),
      occupancy: v('rent'),
    };
    const ids = visibleNodes(westwindGraph, web('own_home'), answers).map((n) => n.id);
    expect(ids).not.toContain('units');
    expect(ids).not.toContain('org_name');
    expect(ids).not.toContain('employees_affected');
  });

  it('flood shows the waterline question, wind shows the roof question', () => {
    const base: Answers = { danger_now: v('no'), relationship: v('own_home') };
    const flood = visibleNodes(westwindGraph, web('own_home'), { ...base, cause: v('flood') }).map(
      (n) => n.id,
    );
    expect(flood).toContain('water_depth');
    expect(flood).not.toContain('roof_state');
    const wind = visibleNodes(westwindGraph, web('own_home'), {
      ...base,
      cause: v('wind_tornado'),
    }).map((n) => n.id);
    expect(wind).toContain('roof_state');
    expect(wind).not.toContain('water_depth');
    // The event's hazard also opens the branch before the cause is answered.
    const tornadoEvent = visibleNodes(westwindGraph, web('own_home', ['tornado']), base).map(
      (n) => n.id,
    );
    expect(tornadoEvent).toContain('roof_state');
  });

  it('a witness is asked only what was seen, never owner or needs questions (WIT-01)', () => {
    const answers: Answers = { danger_now: v('no'), relationship: v('witness') };
    const ids = visibleNodes(westwindGraph, web('witness'), answers).map((n) => n.id);
    expect(ids).toContain('damage_types');
    expect(ids).toContain('photos');
    for (const id of [
      'occupancy',
      'primary_residence',
      'insurance',
      'habitable',
      'tonight',
      'needs',
      'consent',
    ])
      expect(ids, id).not.toContain(id);
    const dt = question('damage_types');
    expect(dt.promptFor?.witness?.en).toMatch(/see/);
  });

  it('a helper is kept apart from the person they help (HLP-01)', () => {
    const answers: Answers = { danger_now: v('no'), relationship: v('helper') };
    const ids = visibleNodes(westwindGraph, web('helper'), answers).map((n) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining(['helper_name', 'helper_consent', 'subject_name', 'contact']),
    );
    expect(ids).not.toContain('contact_name');
  });

  it('an organization reports buildings with unit counts and business impact (ORG-01, DCL:DEC-17)', () => {
    const answers: Answers = {
      danger_now: v('no'),
      relationship: v('organization'),
      home_type: v('business'),
    };
    const ids = visibleNodes(westwindGraph, web('organization'), answers).map((n) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining(['org_name', 'units', 'employees_affected', 'time_out_of_work']),
    );
    expect(ids).not.toContain('needs');
  });

  it('respects channel limits', () => {
    const node = { ...question('contact'), channels: ['web' as const] };
    expect(isAsked(node, { channel: 'sms', hazards: [] }, {})).toBe(false);
    expect(isAsked(node, { channel: 'web', hazards: [] }, {})).toBe(true);
  });
});

describe('shortest path and progress (INT-04, INT-06)', () => {
  it('has at most 12 required questions on the shortest path for every relationship', () => {
    for (const r of ['own_home', 'helper', 'witness', 'organization'] as const) {
      const p = shortestPath(westwindGraph, r);
      expect(p.required, r).toBeLessThanOrEqual(12);
      expect(p.questions, r).toBeLessThanOrEqual(18);
    }
  });

  it('counts remaining questions in words, not percent', () => {
    const answers: Answers = { danger_now: v('no'), relationship: v('own_home') };
    const remaining = remainingQuestions(westwindGraph, web('own_home'), answers, 'relationship');
    expect(remaining).toBeGreaterThan(5);
    expect(progress(remaining)).toEqual({ band: 'about', remaining });
    expect(progress(0)).toEqual({ band: 'last' });
  });
});

describe('answers (INT-05, BRD:FR-10.07, AC-10A)', () => {
  it('"I don\'t know" is accepted on required questions; skip is refused only there', () => {
    const cause = question('cause');
    expect(validateAnswer(cause, { kind: 'unknown' })).toEqual([]);
    expect(validateAnswer(cause, { kind: 'skipped' })[0]?.code).toBe('required');
    expect(validateAnswer(question('insurance'), { kind: 'skipped' })).toEqual([]);
  });

  it('rejects invalid enumerations and negative counts without losing the input', () => {
    expect(validateAnswer(question('home_type'), v('castle'))[0]?.code).toBe('invalid_option');
    expect(validateAnswer(question('household_size'), v(-1))[0]?.code).toBe('negative');
    expect(validateAnswer(question('household_size'), v(3))).toEqual([]);
  });

  it('keeps zero and unknown distinguishable in the FEMA mapping (AC-10A)', () => {
    const zero = femaMapping(westwindGraph, { household_size: v(0) });
    const unknown = femaMapping(westwindGraph, { household_size: { kind: 'unknown' } });
    expect(zero['occupants']).toBe(0);
    expect(unknown['occupants']).toBe('unknown');
    const mapped = femaMapping(westwindGraph, {
      home_type: v('mobile_manufactured'),
      insurance: v(['flood', 'none']),
    });
    expect(mapped['structure_type']).toBe('manufactured');
    expect(mapped['insurance']).toEqual(['flood', 'none']);
  });

  it('groups the summary by section with editable items (INT-21)', () => {
    const answers: Answers = {
      danger_now: v('no'),
      relationship: v('own_home'),
      address: v({ line1: '12 Oak St', city: 'Westwind' }),
      home_type: v('house'),
      cause: v('wind_tornado'),
      damage_types: v(['roof', 'tree_on_home']),
      insurance: { kind: 'unknown' },
    };
    const s = summary(westwindGraph, web('own_home'), answers, 'es', {
      unknown: 'No sé',
      skipped: 'Sin responder',
    });
    const home = s.find((x) => x.section === 'home');
    expect(home?.items.find((i) => i.id === 'home_type')?.answer).toBe('Casa');
    expect(home?.items.find((i) => i.id === 'insurance')).toMatchObject({
      answer: 'No sé',
      state: 'unknown',
    });
    const event = s.find((x) => x.section === 'event');
    expect(event?.items.find((i) => i.id === 'damage_types')?.answer).toBe(
      'Techo, Árbol sobre la casa',
    );
  });

  it('raises need signals from answers and needs, so people come first (PHO-14)', () => {
    const s = needSignals(westwindGraph, { tonight: v('yes'), hurt_missing: v('yes') }, [
      'shelter_tonight',
    ]);
    expect(s).toEqual({ unsafe: false, displaced: true, no_shelter: true, medical: true });
  });
});
