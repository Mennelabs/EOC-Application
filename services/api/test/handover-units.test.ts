/**
 * The shift hand-over's rules draft (layer-7 task H; FL-12): a quiet shift
 * says so in the worker's language; every figure in the draft is a fact.
 */
import { describe, expect, it } from 'vitest';
import { checkDraft } from '@cg/ai';
import { handoverFacts } from '../src/routes/handover.ts';

const shift = {
  startedAt: new Date('2026-10-15T08:00:00Z'),
  endedAt: new Date('2026-10-15T16:30:00Z'),
};

describe('shift hand-over facts (FL-12)', () => {
  it('a quiet shift says nothing was logged and nothing is open, in Spanish too', () => {
    const en = handoverFacts('en', shift, [], [], 0);
    expect(en.rules).toBe(
      'Shift 08:00–16:30 UTC. Nothing was logged this shift. No assignment is left open.',
    );
    const es = handoverFacts('es', shift, [], [], 0);
    expect(es.rules).toBe(
      'Turno 08:00–16:30 UTC. No se registró nada en este turno. No queda ninguna asignación abierta.',
    );
  });
  it('the rules draft passes the draft check against its own facts', () => {
    const g = handoverFacts(
      'en',
      shift,
      [
        {
          id: 'a',
          kind: 'service',
          summary: 'Meals served: 40',
          occurredAt: new Date('2026-10-15T12:00:00Z'),
        },
        {
          id: 'b',
          kind: 'check_in',
          summary: 'Checked in',
          occurredAt: new Date('2026-10-15T08:00:00Z'),
        },
      ],
      [{ reference: 'M-7', kind: 'delivery', state: 'en_route' }],
      3,
    );
    expect(g.rules).toContain('Service entries logged: 1');
    expect(g.rules).toContain('Still open: M-7 (delivery), en route');
    expect(g.rules).not.toContain('Checked in');
    const sentences = g.rules
      .split(/(?<=\.)\s+/)
      .map((text) => ({ text, factIds: g.facts.map((f) => f.id) }));
    expect(
      checkDraft(
        { sentences, injectionSuspected: false },
        { purpose: 'handover', language: 'en', facts: g.facts },
      ).ok,
    ).toBe(true);
  });
});
