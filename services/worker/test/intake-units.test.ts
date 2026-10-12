/**
 * Pure parts of filing (PHO-15, SEC-10): the duplicate keys and the split of
 * answers into clear and encrypted columns.
 */
import { describe, expect, it } from 'vitest';
import { westwindGraph, type Answers, type QuestionNode } from '@cg/intake';
import {
  addressKeyOf,
  contentHashOf,
  partitionAnswers,
  submissionPayloadSchema,
} from '../src/jobs/intake.ts';

describe('filing helpers', () => {
  it('address keys ignore case, punctuation and spacing but keep the unit and ZIP', () => {
    const a = addressKeyOf({
      line1: '12 Oak St.',
      unit: 'Apt 3B',
      postal: '63001-1234',
      city: 'Westwind',
    });
    const b = addressKeyOf({
      line1: '12 OAK ST',
      unit: 'apt 3b',
      postal: '63001',
      city: 'westwind',
    });
    expect(a).toBe(b);
    expect(a).toBe('12 oak st|apt 3b|63001');
    expect(addressKeyOf({ line1: '12 Oak St', unit: 'Apt 4', postal: '63001' })).not.toBe(a);
    expect(addressKeyOf({ line1: '12 Oak St', city: 'Westwind' })).toBe('12 oak st|westwind');
    expect(addressKeyOf({ landmark: 'the blue house by the church' })).toBeNull();
  });

  it('content hashes leave out everything that names a person', () => {
    const base: Answers = {
      home_type: { kind: 'value', value: 'house' },
      contact: { kind: 'value', value: { phone: '+13145550199' } },
      contact_name: { kind: 'value', value: 'Ana' },
    };
    const same = contentHashOf({
      ...base,
      contact: { kind: 'value', value: { phone: '+13145550100' } },
      contact_name: { kind: 'value', value: 'Luis' },
    });
    expect(contentHashOf(base).equals(same)).toBe(true);
    expect(
      contentHashOf({ ...base, home_type: { kind: 'value', value: 'apartment' } }).equals(same),
    ).toBe(false);
  });

  it('restricted answers are separated for encryption; unknown questions are dropped (SEC-10)', () => {
    const questions = new Map<string, QuestionNode>();
    for (const n of [...westwindGraph.nodes, ...westwindGraph.afterSubmission])
      if (n.kind === 'question') questions.set(n.id, n);
    const { clear, restricted } = partitionAnswers(
      {
        home_type: { kind: 'value', value: 'house' },
        access_needs: { kind: 'value', value: ['medical_power'] },
        helper_name: { kind: 'value', value: 'Sam' },
        not_a_question: { kind: 'value', value: 'x' },
      },
      questions,
      new Set(['helper_name']),
    );
    expect(Object.keys(clear)).toEqual(['home_type']);
    expect(Object.keys(restricted)).toEqual(['access_needs']);
  });

  it('accepts what the API encrypts and fills the defaults', () => {
    const p = submissionPayloadSchema.parse({
      executionId: '0190a7d2-3b4c-7d5e-8f60-123456789abc',
      graphKey: 'default-home-damage',
      graphVersion: 1,
      relationship: 'own_home',
      answers: { danger_now: { kind: 'value', value: 'no' } },
      risk: { decision: 'verify', score: 42, reasons: ['new_ip'] },
    });
    expect(p.channel).toBe('web');
    expect(p.needs).toEqual([]);
    expect(p.risk?.decision).toBe('verify');
  });
});
