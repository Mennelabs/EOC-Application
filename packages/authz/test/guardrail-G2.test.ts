import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine.ts';
import type { Subject } from '../src/types.ts';

const anon: Subject = { kind: 'public' };

describe('G2 public users never see private records (BRD:FR-00.02, RULE-17, AC-C03)', () => {
  it('allows only actions marked public', () => {
    expect(decide(anon, 'meta.read', { type: 'meta' }).effect).toBe('allow');
    for (const action of ['event.read', 'audit.read', 'personnel.read', 'me.read']) {
      const d = decide(anon, action, { type: 'event' });
      expect(d.reason).toBe('guardrail:G2:public_action_not_allowed');
    }
  });

  it('denies unpublished records without revealing anything', () => {
    const d = decide(anon, 'meta.read', { type: 'meta', published: false });
    expect(d).toMatchObject({
      effect: 'deny',
      fields: [],
      reason: 'guardrail:G2:public_record_not_published',
    });
  });

  it('denies when any requested field is not public', () => {
    const d = decide(anon, 'meta.read', {
      type: 'meta',
      fields: [
        { name: 'name', category: 'basic', classification: 'public' },
        { name: 'phone', category: 'contact', classification: 'restricted' },
      ],
    });
    expect(d.reason).toBe('guardrail:G2:public_private_field');
  });
});
