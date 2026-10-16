/**
 * AC-A05, EQ-06: a Spanish speaker reads every answer error in Spanish. Each
 * error the question engine can raise, on every question of the shipped
 * graph, maps to a message that exists in both catalogs, and the Spanish one
 * is never the engine's English. A number out of range names its range.
 */
import { describe, expect, it } from 'vitest';
import { createIntl } from 'react-intl';
import { validateAnswer, westwindGraph, type AnswerValue, type QuestionNode } from '@cg/intake';
import { messages } from '../src/i18n/messages.ts';
import { validationText } from '../src/intake/validation-text.ts';

/** Answers that break each kind of question in every way the engine checks. */
function badAnswers(q: QuestionNode): AnswerValue[] {
  const out: AnswerValue[] = [{ kind: 'skipped' }, { kind: 'unknown' }];
  const v = (value: unknown): AnswerValue => ({ kind: 'value', value }) as AnswerValue;
  switch (q.answerType) {
    case 'single':
    case 'multi':
      out.push(v('not-an-option'), v([]), v(['not-an-option']));
      break;
    case 'yesno':
      out.push(v('perhaps'));
      break;
    case 'number':
      out.push(v('many'), v(-1), v(1e9), v(q.min !== undefined ? q.min - 1 : -5));
      break;
    case 'text':
      out.push(v('   '));
      break;
    case 'address':
    case 'contact':
      out.push(v('a string'), v({ line1: ' ' }));
      break;
  }
  return out;
}

const intl = {
  en: createIntl({ locale: 'en', messages: messages.en }),
  es: createIntl({ locale: 'es', messages: messages.es }),
};
const say = (
  locale: 'en' | 'es',
  id: keyof (typeof messages)['en'],
  values?: Record<string, number>,
) => intl[locale].formatMessage({ id }, values);

describe('answer errors in the resident language (AC-A05)', () => {
  it('every error on every question of the shipped graph has its message in English and Spanish', () => {
    const engineEnglish = new Set<string>();
    let checked = 0;
    for (const q of [...westwindGraph.nodes, ...westwindGraph.afterSubmission]) {
      for (const a of badAnswers(q)) {
        for (const e of validateAnswer(q, a)) {
          engineEnglish.add(e.message);
          const shown = validationText(q, e);
          const en = say('en', shown.id, shown.values);
          const es = say('es', shown.id, shown.values);
          expect(en.length, `${q.id} ${e.code}`).toBeGreaterThan(5);
          expect(es, `${q.id} ${e.code}`).not.toBe(en);
          expect(es).not.toMatch(/[{}]/);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    // The Spanish screen never shows what the engine wrote in English.
    for (const id of Object.keys(messages.es) as (keyof (typeof messages)['es'])[])
      expect(engineEnglish.has(messages.es[id])).toBe(false);
  });

  it('a number out of range says the range, in the resident language', () => {
    const q = {
      id: 'people',
      answerType: 'number',
      min: 1,
      max: 20,
      prompt: { en: 'How many?' },
    } as unknown as QuestionNode;
    const [e] = validateAnswer(q, { kind: 'value', value: 40 } as AnswerValue);
    const shown = validationText(q, e!);
    expect(say('en', shown.id, shown.values)).toBe('Enter a number from 1 to 20.');
    expect(say('es', shown.id, shown.values)).toBe('Escriba un número del 1 al 20.');
  });
});
