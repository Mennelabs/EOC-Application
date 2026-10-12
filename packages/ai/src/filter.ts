/**
 * Output filter (AIG-07): generated text that states eligibility, promises
 * aid, gives medical or legal advice, or carries another person's contact
 * details is blocked before anyone sees it. Returns the reasons so the
 * register and the audit log can record what was dropped.
 */
const RULES: [string, RegExp][] = [
  [
    'eligibility',
    /\b(you (are|aren't|are not|will be|won't be) (eligible|qualified|approved|denied)|you qualify|you do not qualify|no se califica|usted califica|eres elegible|es elegible)\b/i,
  ],
  [
    'promise',
    /\b(you will (receive|get|be paid|be reimbursed)|we (will|guarantee|promise) (to )?(send|pay|replace|fix|repair)|recibirá|le pagaremos|garantizamos)\b/i,
  ],
  [
    'medical_advice',
    /\b(take \d+ ?(mg|milligrams|tablets|pills)|you should (take|stop taking)|dosage|diagnos(is|e)|debe tomar)\b/i,
  ],
  [
    'legal_advice',
    /\b(you should (sue|file a lawsuit|not sign|sign the)|legally (you|your)|liable|demandar|no firme)\b/i,
  ],
  [
    'contact_data',
    /([\w.+-]+@[\w-]+\.[\w.-]+|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\b\d{3}-\d{2}-\d{4}\b)/,
  ],
];

export interface FilterResult {
  allowed: boolean;
  reasons: string[];
}

export function filterGeneratedText(text: string): FilterResult {
  const reasons = RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { allowed: reasons.length === 0, reasons };
}
