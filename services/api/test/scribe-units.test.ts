/**
 * The scribe's grounding check (layer-7 task H; FL-04, AI-09, AIG-05): a line
 * is kept only when the words it rests on were said; redacted details come
 * back for the worker; a line that would read as a promise or advice in
 * public text is marked for a second look.
 */
import { describe, expect, it } from 'vitest';
import { redact } from '@cg/ai';
import { groundNote, SCRIBE_CONSENT } from '../src/routes/scribe.ts';

describe('scribe note grounding (FL-04, AI-09)', () => {
  const said = redact(
    'We need water and a tarp. Call my sister at 314-555-0188. You will receive a hotel voucher tomorrow.',
  );
  it('keeps lines whose words were said, whatever the spacing and punctuation, and restores redacted details', () => {
    const g = groundNote(
      {
        needsHeard: [{ text: 'Water and a tarp', quote: 'we need WATER, and a tarp' }],
        helpGiven: [],
        followUps: [
          { text: 'Call the sister at [PHONE_1]', quote: 'Call my sister at [PHONE_1]' },
          {
            text: 'You will receive a hotel voucher tomorrow',
            quote: 'You will receive a hotel voucher tomorrow',
          },
        ],
        referrals: [{ text: 'Sent to legal aid', quote: 'I will send you to legal aid' }],
        injectionSuspected: false,
      },
      said.text,
      said.tokens,
    );
    expect(g.needsHeard.map((l) => l.text)).toEqual(['Water and a tarp']);
    expect(g.followUps[0]).toMatchObject({
      text: 'Call the sister at 314-555-0188',
      quote: 'Call my sister at 314-555-0188',
      check: [],
    });
    // A promise in the worker's words is kept but marked for a second look.
    expect(g.followUps[1]!.check).toContain('promise');
    expect(g.referrals).toEqual([]);
    expect(g.dropped).toBe(1);
  });
  it('drops a line with an empty or one-word quote', () => {
    const g = groundNote(
      {
        needsHeard: [
          { text: 'Water', quote: '' },
          { text: 'Water', quote: 'we' },
        ],
        helpGiven: [],
        followUps: [],
        referrals: [],
        injectionSuspected: false,
      },
      said.text,
      said.tokens,
    );
    expect(g.needsHeard).toEqual([]);
    expect(g.dropped).toBe(2);
  });
  it('the consent statement says the sign, stop, deletion and that no changes nothing, in both languages (FL-18)', () => {
    expect(SCRIBE_CONSENT.en).toMatch(
      /listening sign.*say stop.*deleted.*does not change the help/s,
    );
    expect(SCRIBE_CONSENT.es).toMatch(/escuchando.*alto.*se borra.*no cambia la ayuda/s);
  });
});
