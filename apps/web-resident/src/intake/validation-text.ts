/**
 * The resident's own language for every answer error (AC-A05, EQ-06, NFR-09,
 * WCAG 3.3.1 and 3.3.3). The question engine checks an answer and names what
 * is wrong with a code; this turns the code into a message from the resident
 * catalog, so a Spanish speaker never reads the engine's English. A number
 * out of range says the range it must be in.
 */
import type { QuestionNode, ValidationError } from '@cg/intake';
import type { MessageId } from '../i18n/messages.ts';

export interface ValidationText {
  id: MessageId;
  values?: Record<string, number>;
}

export function validationText(node: QuestionNode, error: ValidationError): ValidationText {
  switch (error.code) {
    case 'required':
      return { id: 'validation.required' };
    case 'unknown_not_allowed':
      return { id: 'validation.pick' };
    case 'invalid_option':
      return { id: node.answerType === 'multi' ? 'validation.optionMany' : 'validation.optionOne' };
    case 'negative':
      return { id: 'validation.negative' };
    case 'out_of_range':
      if (node.min !== undefined && node.max !== undefined)
        return { id: 'validation.rangeBoth', values: { min: node.min, max: node.max } };
      if (node.min !== undefined) return { id: 'validation.rangeMin', values: { min: node.min } };
      if (node.max !== undefined) return { id: 'validation.rangeMax', values: { max: node.max } };
      return { id: 'number.hint' };
    case 'type':
      if (node.answerType === 'yesno') return { id: 'validation.yesNo' };
      if (node.answerType === 'number') return { id: 'number.hint' };
      return { id: 'validation.fields' };
    case 'empty':
      return { id: node.answerType === 'text' ? 'validation.text' : 'validation.fields' };
  }
}
