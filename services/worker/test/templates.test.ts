/**
 * Resident message templates (docs/06, CHN-03, ADM-03, CON-10): the county's
 * name, never the product's; no alert-style wording; the reference code and
 * "call 911" in every confirmation; short enough for two text segments.
 */
import { describe, expect, it } from 'vitest';
import { smsSegments } from '@cg/adapters';
import { renderTemplate, TEMPLATE_NAMES } from '../src/jobs/templates.ts';

const vars = {
  county: 'Westwind County',
  helpPhone: '(314) 555-0142',
  referenceCode: 'KXMR-4827',
  code: '482913',
  url: 'https://localhost/county/my-report',
  note: 'Which floor is the water damage on?',
};

describe('resident message templates', () => {
  it.each(TEMPLATE_NAMES)('%s names the county and never reads like an alert', (name) => {
    for (const language of ['en', 'es']) {
      for (const channel of ['sms', 'email'] as const) {
        const r = renderTemplate(name, language, channel, vars);
        expect(r.body).toContain('Westwind County');
        expect(r.body).not.toMatch(/emergency alert|alerta de emergencia/i);
        if (channel === 'email') expect(r.subject).toContain('Westwind County');
        else expect(r.subject).toBeUndefined();
      }
    }
  });

  it('the confirmation carries the reference code and the 911 line (CON-10)', () => {
    const en = renderTemplate('confirmation', 'en', 'sms', vars).body;
    const es = renderTemplate('confirmation', 'es', 'sms', vars).body;
    expect(en).toContain('KXMR-4827');
    expect(en).toContain('911');
    expect(en).toContain('STOP');
    expect(es).toContain('KXMR-4827');
    expect(es).toContain('911');
    expect(es).toContain('ALTO');
  });

  it('texts stay short with a long county name: two GSM-7 segments in English, three UCS-2 segments in Spanish (docs/06)', () => {
    const long = { ...vars, county: 'Saint Francois de Sales County' };
    for (const name of TEMPLATE_NAMES) {
      const en = renderTemplate(name, 'en', 'sms', long).body;
      expect(smsSegments(en), `${name}/en: ${en.length} chars`).toBeLessThanOrEqual(2);
      const es = renderTemplate(name, 'es', 'sms', long).body;
      expect(smsSegments(es), `${name}/es: ${es.length} chars`).toBeLessThanOrEqual(3);
    }
  });

  it('counts segments by alphabet: GSM-7 at 160, accented text at 70', () => {
    expect(smsSegments('')).toBe(0);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('á'.repeat(70))).toBe(1);
    expect(smsSegments('á'.repeat(71))).toBe(2);
    expect(smsSegments('a{b}')).toBe(1); // extended characters count double but still fit
  });

  it('falls back to English for a language without strings (EQ-06)', () => {
    expect(renderTemplate('otp', 'vi', 'sms', vars).body).toContain('one-time code');
    expect(renderTemplate('otp', 'es-MX', 'sms', vars).body).toContain('código');
  });

  it('leaves out the help line when the county has none', () => {
    const r = renderTemplate('withdrawn', 'en', 'sms', { ...vars, helpPhone: null }).body;
    expect(r).not.toContain('call');
    expect(r.endsWith('as you asked.')).toBe(true);
  });
});
