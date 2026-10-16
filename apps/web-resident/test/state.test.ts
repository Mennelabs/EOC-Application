/** INT-02–06, INT-13/14, INT-21, AC-11B: the flow walks the graph and sends question answers only. */
import { describe, expect, it } from 'vitest';
import { westwindGraph } from '@cg/intake';
import {
  advance,
  answer,
  currentNode,
  goBack,
  jumpTo,
  markStep,
  newFlow,
  nextPlace,
  remaining,
  spellCode,
  toSubmission,
} from '../src/intake/state.ts';
import { parseRoute } from '../src/App.tsx';

const start = () =>
  newFlow({
    tenant: 'county',
    event: 'westwind',
    language: 'en',
    channel: 'web',
    graph: westwindGraph,
    hazards: ['tornado', 'wind'],
    relationship: 'own_home',
  });

describe('flow state', () => {
  it('starts at the safety question, moves on when answered, and comes back on Back', () => {
    let s = start();
    expect(currentNode(westwindGraph, s)?.id).toBe('danger_now');
    s = advance(answer(s, 'danger_now', { kind: 'value', value: 'no' }), 'danger_now');
    const next = currentNode(westwindGraph, s)!;
    expect(next.id).not.toBe('danger_now');
    expect(next.id).not.toBe('relationship'); // chosen on the welcome screen
    s = goBack(s);
    expect(currentNode(westwindGraph, s)?.id).toBe('danger_now');
    expect(goBack(start()).history).toEqual([]);
  });

  it('danger yes shows the emergency instructions next (INT-07, CON-10)', () => {
    const s = advance(answer(start(), 'danger_now', { kind: 'value', value: 'yes' }), 'danger_now');
    expect(currentNode(westwindGraph, s)?.id).toBe('danger_info');
  });

  it('counts remaining questions in words-ready numbers and lets review jump to any node', () => {
    let s = start();
    expect(remaining(westwindGraph, s, 'danger_now')).toBeGreaterThan(5);
    s = jumpTo(s, 'home_type', 'review');
    expect(currentNode(westwindGraph, s)?.id).toBe('home_type');
    expect(s.history).toEqual(['review']);
  });

  it('step markers steer the engine but never reach the submission; confirmed extraction answers are flagged', () => {
    let s = start();
    s = answer(s, 'danger_now', { kind: 'value', value: 'no' });
    s = markStep(s, 'own_words', 'done');
    s = {
      ...s,
      ownWords: 'tree on the roof',
      aiAssisted: true,
      extractionId: '0190a7d2-3b4c-7d5e-8f60-123456789abc',
      fromWords: ['damage_types'],
    };
    s = answer(s, 'damage_types', { kind: 'value', value: ['roof'] });
    expect(s.fromWords).toEqual([]); // a hand-entered answer replaces the extracted one
    s = { ...s, fromWords: ['damage_types'] };
    const body = toSubmission(s, westwindGraph);
    expect(Object.keys(body.answers).sort()).toEqual([
      'damage_types',
      'danger_now',
      'relationship',
    ]);
    expect(body).not.toHaveProperty('steps');
    expect(body.ownWords).toBe('tree on the roof');
    expect(body.aiAssisted).toBe(true);
    expect(body.extractionId).toBeDefined();
    expect(body.relationship).toBe('own_home');
    expect(body.executionId).toBe(s.executionId);
  });

  it('spells the reference code for screen readers (ACC-50)', () => {
    expect(spellCode('KXMR-4827')).toBe('K X M R, 4 8 2 7');
  });

  it('routes deep links to the tenant and event (CHN-08)', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/county/westwind')).toEqual({
      name: 'welcome',
      tenant: 'county',
      event: 'westwind',
    });
    expect(parseRoute('/county/westwind/report')).toEqual({
      name: 'report',
      tenant: 'county',
      event: 'westwind',
    });
    expect(parseRoute('/county/westwind/kiosk/')).toEqual({
      name: 'kiosk',
      tenant: 'county',
      event: 'westwind',
    });
    expect(parseRoute('/county/my-report')).toEqual({ name: 'my-report', tenant: 'county' });
    expect(parseRoute('/county/help')).toEqual({ name: 'help', tenant: 'county' });
    expect(parseRoute('/a/b/c/d')).toEqual({ name: 'unknown' });
  });

  it('ORG-01: the next place is a report of its own; who is reporting carries over, the place and its safety question start again', () => {
    let s = newFlow({
      tenant: 'county',
      event: 'westwind',
      language: 'es',
      channel: 'web',
      graph: westwindGraph,
      hazards: ['tornado'],
      relationship: 'organization',
    });
    s = answer(s, 'danger_now', { kind: 'value', value: 'no' });
    s = answer(s, 'org_name', { kind: 'value', value: 'Oak Street Apartments' });
    s = answer(s, 'address', { kind: 'value', value: { line1: '1 Oak St' } });
    s = answer(s, 'units', { kind: 'value', value: 12 });
    s = answer(s, 'contact_name', { kind: 'value', value: 'Ana Ruiz' });
    s = answer(s, 'contact', { kind: 'value', value: { email: 'ana@example.org' } });
    s = markStep(s, 'review', 'done');
    s = { ...s, needs: ['cleanup_tarp'], consent: { cleanup_tarp: true }, smsOptIn: true };
    const next = nextPlace(s, westwindGraph, 'KXMR-4827', true);
    expect(next.executionId).not.toBe(s.executionId);
    expect(Object.keys(next.answers).sort()).toEqual([
      'contact',
      'contact_name',
      'org_name',
      'relationship',
    ]);
    expect(next).toMatchObject({
      language: 'es',
      relationship: 'organization',
      needs: [],
      consent: {},
      photos: [],
      steps: {},
      smsOptIn: true,
      earlierPlaces: ['KXMR-4827'],
    });
    expect(currentNode(westwindGraph, next)?.id).toBe('danger_now');
    // A cleared device keeps only who is reporting; the contact is asked again.
    const cleared = nextPlace(next, westwindGraph, 'PQRS-1234', false);
    expect(Object.keys(cleared.answers).sort()).toEqual(['org_name', 'relationship']);
    expect(cleared.smsOptIn).toBe(false);
    expect(cleared.earlierPlaces).toEqual(['KXMR-4827', 'PQRS-1234']);
  });
});
