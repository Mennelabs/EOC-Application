/**
 * Redaction before text leaves the platform (AIG-05): phone numbers, email
 * addresses, street addresses and identifiers become tokens. Extraction does
 * not need them; names are left in place because a name cannot be told from
 * an ordinary word without a model, and the fake provider never leaves the
 * process. Real providers receive only the redacted text.
 */
export interface Redaction {
  text: string;
  tokens: Record<string, string>;
}

const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, 'ID'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'EMAIL'],
  [/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, 'PHONE'],
  [
    /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){1,4}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|boulevard|blvd|way|place|pl|trail|trl|highway|hwy|calle|avenida|camino)\b\.?(?:\s*(?:apt|unit|#|lot)\s*\w+)?/gi,
    'ADDRESS',
  ],
];

export function redact(input: string): Redaction {
  const tokens: Record<string, string> = {};
  let text = input;
  for (const [re, kind] of PATTERNS) {
    let i = Object.keys(tokens).filter((k) => k.startsWith(`[${kind}`)).length;
    text = text.replace(re, (match) => {
      i += 1;
      const token = `[${kind}_${i}]`;
      tokens[token] = match;
      return token;
    });
  }
  return { text, tokens };
}
