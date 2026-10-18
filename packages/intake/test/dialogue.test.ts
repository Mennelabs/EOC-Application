/** CHN-03, CHN-05, INT-05, INT-06, docs/06: numbered prompts and replies for text and voice. */
import { describe, expect, it } from 'vitest';
import {
  command,
  normaliseKeyword,
  parseAddress,
  parseReply,
  renderNode,
  strings,
  westwindGraph,
  type DialogueOptions,
  type GraphNode,
  type QuestionNode,
  type SessionContext,
} from '../src/index.ts';

const node = (id: string): GraphNode => westwindGraph.nodes.find((n) => n.id === id)!;
const q = (id: string): QuestionNode => node(id) as QuestionNode;
const ctx: SessionContext = { hazards: ['tornado', 'wind'], channel: 'sms' };
const sms: DialogueOptions = {
  channel: 'sms',
  consentOrgTypes: westwindGraph.consentOrgTypes.filter((c) => !c.optIn),
};
const voice: DialogueOptions = { ...sms, channel: 'voice' };

describe('keywords (docs/06, CHN-03)', () => {
  it('SHELTER or REFUGIO with a ZIP carries the place (PUB-08)', () => {
    expect(command('shelter 63001')).toEqual({ kind: 'shelter', locale: 'en', query: '63001' });
    expect(command('Refugio 63002')).toEqual({ kind: 'shelter', locale: 'es', query: '63002' });
    expect(command('shelters')).toEqual({ kind: 'none' });
  });

  it('start, shelter, help, stop, back and skip work in both languages, any case, with or without accents', () => {
    expect(command('damage')).toEqual({ kind: 'start', locale: 'en' });
    expect(command(' DAÑOS ')).toEqual({ kind: 'start', locale: 'es' });
    expect(command('Danos')).toEqual({ kind: 'start', locale: 'es' });
    expect(command('refugio')).toEqual({ kind: 'shelter', locale: 'es', query: null });
    expect(command('AYUDA')).toEqual({ kind: 'help' });
    expect(command('Alto')).toEqual({ kind: 'stop' });
    expect(command('unsubscribe')).toEqual({ kind: 'stop' });
    expect(command('atrás')).toEqual({ kind: 'back' });
    expect(command('omitir')).toEqual({ kind: 'skip' });
    expect(command('2')).toEqual({ kind: 'none' });
    expect(normaliseKeyword('  Daños!! ')).toBe('DANOS');
  });
});

describe('rendering', () => {
  it('numbers the options and offers 0 for unknown only when allowed', () => {
    const danger = renderNode(westwindGraph, q('danger_now'), ctx, {}, 'en', {
      ...sms,
      remaining: 9,
    });
    expect(danger.text).toContain('Is anyone in danger right now?');
    expect(danger.text).toContain('1 Yes, someone is in danger');
    expect(danger.text).toContain('3 I am not sure');
    expect(danger.text).not.toContain("0 Don't know");
    expect(danger.text).toContain('About 9 left.');
    const home = renderNode(westwindGraph, q('home_type'), ctx, {}, 'es', sms);
    expect(home.text).toContain('0 No sé');
    expect(home.text).toContain('OMITIR');
  });

  it('speaks the same choices for voice', () => {
    const r = renderNode(westwindGraph, q('danger_now'), ctx, {}, 'en', voice);
    expect(r.text).toContain('Press 1: Yes, someone is in danger.');
    expect(r.expects).toBe('speech_or_digits');
    expect(r.maxDigits).toBe(1);
  });

  it('renders the steps: needs and consent as numbered lists, review with SEND', () => {
    const needs = renderNode(westwindGraph, node('needs'), ctx, {}, 'en', sms);
    expect(needs.text).toContain('1 A place to stay tonight');
    expect(needs.text).toContain('or 0 for none');
    const consent = renderNode(westwindGraph, node('consent'), ctx, {}, 'en', sms);
    expect(consent.text).toContain('1 Volunteer cleanup groups');
    expect(consent.text).not.toContain('Faith-based');
    expect(renderNode(westwindGraph, node('review'), ctx, {}, 'en', sms).text).toContain('SEND');
    expect(renderNode(westwindGraph, node('review'), ctx, {}, 'es', voice).text).toContain(
      'Oprima 1',
    );
  });
});

describe('parsing replies', () => {
  it('digits pick options; words and yes/no work too; the wrong number keeps the question', () => {
    expect(parseReply(westwindGraph, q('danger_now'), '2', 'en', sms)).toEqual({
      kind: 'answer',
      value: { kind: 'value', value: 'no' },
    });
    expect(parseReply(westwindGraph, q('danger_now'), 'no', 'es', sms)).toEqual({
      kind: 'answer',
      value: { kind: 'value', value: 'no' },
    });
    expect(parseReply(westwindGraph, q('home_type'), 'apartment', 'en', sms)).toEqual({
      kind: 'answer',
      value: { kind: 'value', value: 'apartment_condo' },
    });
    expect(parseReply(westwindGraph, q('danger_now'), '7', 'en', sms)).toMatchObject({
      kind: 'invalid',
    });
    expect(parseReply(westwindGraph, q('danger_now'), '0', 'en', sms)).toMatchObject({
      kind: 'invalid',
    }); // unknown not allowed
    expect(parseReply(westwindGraph, q('home_type'), '0', 'en', sms)).toEqual({
      kind: 'answer',
      value: { kind: 'unknown' },
    });
    expect(parseReply(westwindGraph, q('insurance'), "don't know", 'en', sms)).toEqual({
      kind: 'answer',
      value: { kind: 'unknown' },
    });
  });

  it('multi answers take several numbers, with or without spaces', () => {
    const a = parseReply(westwindGraph, q('damage_types'), '1 3', 'en', sms);
    const b = parseReply(westwindGraph, q('damage_types'), '13', 'en', sms);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'answer', value: { kind: 'value' } });
    expect((a as { value: { value: string[] } }).value.value).toHaveLength(2);
    expect(parseReply(westwindGraph, q('damage_types'), '1 99', 'en', sms)).toMatchObject({
      kind: 'invalid',
    });
  });

  it('numbers, addresses and free text', () => {
    expect(parseReply(westwindGraph, q('units'), '12', 'en', sms)).toEqual({
      kind: 'answer',
      value: { kind: 'value', value: 12 },
    });
    expect(parseReply(westwindGraph, q('units'), 'many', 'en', sms)).toMatchObject({
      kind: 'invalid',
    });
    expect(parseAddress('12 Oak St, Westwind MO 63001')).toEqual({
      line1: '12 Oak St, Westwind MO',
      postal: '63001',
    });
    expect(parseAddress('the blue house by the church')).toEqual({
      line1: 'the blue house by the church',
    });
    expect(
      parseReply(westwindGraph, q('address'), 'Lot 14 Pine Ridge park 63001', 'en', sms),
    ).toEqual({
      kind: 'answer',
      value: { kind: 'value', value: { line1: 'Lot 14 Pine Ridge park', postal: '63001' } },
    });
    expect(
      parseReply(westwindGraph, node('own_words'), 'A tree fell on the roof', 'en', sms),
    ).toEqual({ kind: 'own_words', text: 'A tree fell on the roof' });
  });

  it('needs, consent and the send step', () => {
    expect(parseReply(westwindGraph, node('needs'), '1 3', 'en', sms)).toEqual({
      kind: 'needs',
      values: ['shelter_tonight', 'cleanup_tarp'],
    });
    expect(parseReply(westwindGraph, node('needs'), '0', 'en', sms)).toEqual({
      kind: 'needs',
      values: [],
    });
    expect(parseReply(westwindGraph, node('consent'), '1', 'en', sms)).toEqual({
      kind: 'consent',
      values: {
        volunteer_cleanup: true,
        relief_agencies: false,
        community_groups: false,
        case_management: false,
        long_term_recovery: false,
        sba: false,
      },
    });
    expect(parseReply(westwindGraph, node('consent'), 'none', 'en', sms)).toMatchObject({
      kind: 'consent',
    });
    expect(parseReply(westwindGraph, node('review'), 'send', 'en', sms)).toEqual({
      kind: 'send',
      smsOptIn: true,
    });
    expect(parseReply(westwindGraph, node('review'), 'enviar', 'es', sms)).toEqual({
      kind: 'send',
      smsOptIn: true,
    });
    expect(parseReply(westwindGraph, node('review'), 'hmm', 'en', sms)).toMatchObject({
      kind: 'invalid',
    });
    expect(parseReply(westwindGraph, node('review'), '2', 'en', voice)).toEqual({
      kind: 'send',
      smsOptIn: false,
    });
    expect(parseReply(westwindGraph, node('review'), '3', 'en', voice)).toEqual({ kind: 'back' });
  });

  it('fixed phrases name the county and keep the 911 line (CON-10, ADM-03)', () => {
    for (const locale of ['en', 'es']) {
      const S = strings(locale);
      expect(S.confirmation('Westwind County', 'KXMR-4827')).toContain('911');
      expect(S.confirmation('Westwind County', 'KXMR-4827')).toContain('KXMR-4827');
      expect(S.help('Westwind County', '(314) 555-0142')).toContain('(314) 555-0142');
      expect(S.greeting('Westwind County')).toContain('911');
    }
  });
});
