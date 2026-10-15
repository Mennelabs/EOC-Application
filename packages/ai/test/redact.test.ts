/**
 * Redaction before text leaves the platform (AIG-05, layer-7 reading 9):
 * contact details, addresses and identifiers as before, and now names: the
 * ones the platform knows for the record, self-introductions and titles, in
 * English and Spanish; ordinary words after "I am" or "soy" stay.
 */
import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.ts';

describe('redact (AIG-05)', () => {
  it('tokenizes names people introduce, in English and Spanish', () => {
    const en = redact('My name is Rosa Delgado and a tree fell on the roof.');
    expect(en.text).toBe('My name is [NAME_1] and a tree fell on the roof.');
    expect(en.tokens).toEqual({ '[NAME_1]': 'Rosa Delgado' });
    const es = redact('Hola, me llamo José Pérez; se cayó el techo.');
    expect(es.text).toBe('Hola, me llamo [NAME_1]; se cayó el techo.');
  });

  it('tokenizes a name after a title', () => {
    expect(redact('Mrs. Okafor next door helped; Dra. not here; Sra. Gómez too.').text).toBe(
      'Mrs. [NAME_1] next door helped; Dra. not here; Sra. [NAME_2] too.',
    );
  });

  it('tokenizes names the platform knows, whole words only, the full name as one token', () => {
    const r = redact('Ana Ruiz says Ana and her son left; Banana boxes stayed.', {
      names: ['Ana Ruiz'],
    });
    expect(r.text).toBe('[NAME_1] says [NAME_2] and her son left; Banana boxes stayed.');
  });

  it('leaves ordinary words after "I am" and "soy" alone', () => {
    for (const t of [
      'I am not sure about the roof.',
      'I am going home tomorrow.',
      'Soy dueño de la casa.',
      'soy de Guatemala',
    ])
      expect(redact(t)).toEqual({ text: t, tokens: {} });
  });

  it('still tokenizes contact details and street addresses', () => {
    expect(redact('this is Ana at 12 Willow St, call 314-555-0199 or ana@example.org').text).toBe(
      'this is [NAME_1] at [ADDRESS_1], call [PHONE_1] or [EMAIL_1]',
    );
  });
});
