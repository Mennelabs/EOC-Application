import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine.ts';
import { account, eventInA, role } from './helpers.ts';

describe('G1 default deny, server-side, fresh subject (BRD:FR-00.01, AC-00A, AC-C05)', () => {
  it('denies an action that is not in the catalog, even with a wildcard grant', () => {
    const d = decide(account([role([{ action: '*' }])]), 'audit.delete', { type: 'audit_event' });
    expect(d.effect).toBe('deny');
    expect(d.guardrail).toBe('G1');
  });

  it('denies when no grant matches (default deny)', () => {
    const d = decide(account([role([{ action: 'event.read' }])]), 'event.close', eventInA);
    expect(d).toMatchObject({ effect: 'deny', reason: 'no_grant' });
  });

  it('denies a subject resolved too long ago, so a prepared action is re-checked (AC-C05)', () => {
    const stale = account([role([{ action: 'event.read' }])], {
      resolvedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const d = decide(stale, 'event.read', eventInA);
    expect(d.reason).toBe('guardrail:G1:subject_stale');
  });

  it('denies an incomplete subject', () => {
    const d = decide(account([role([{ action: '*' }])], { accountId: '' }), 'event.read', eventInA);
    expect(d.reason).toBe('guardrail:G1:subject_incomplete');
  });

  it('denies inactive accounts on their next action (AC-01A)', () => {
    for (const status of ['invited', 'suspended', 'deactivated'] as const) {
      const d = decide(account([role([{ action: '*' }])], { status }), 'event.read', eventInA);
      expect(d).toMatchObject({ effect: 'deny', reason: `account_${status}` });
    }
  });
});
