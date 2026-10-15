/**
 * Redaction before text leaves the platform (AIG-05): phone numbers, email
 * addresses, street addresses, identifiers and names become tokens. Extraction
 * does not need them.
 *
 * Names (layer-7 reading 9) are caught three ways, without a model:
 * - names the platform already knows for the record (the resident's, the
 *   household's, the worker's), passed by the caller, matched as whole words,
 *   each part of three letters or more on its own as well;
 * - a person introducing themselves or someone else ("my name is", "this is",
 *   "me llamo", "mi nombre es", "soy" followed by a capitalised word);
 * - a title before a capitalised name (Mr, Mrs, Ms, Dr, Sr, Sra, Srta, Don,
 *   Doña).
 * A name typed in some other way can still pass; the rest of the pipeline treats
 * the text as data and keeps it in its own encrypted column.
 */
export interface Redaction {
  text: string;
  tokens: Record<string, string>;
}

export interface RedactOptions {
  /** Names the platform knows for this record (resident, household, worker). */
  names?: readonly string[];
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

/** A capitalised word, accents included: the shape of a name after an introduction or title. */
const CAP = "\\p{Lu}[\\p{L}'’-]+";
const NAME = `${CAP}(?:\\s+${CAP}){0,2}`;

/** A lead-in in any letter case; the name after it must still start with a capital. */
const anyCase = (phrase: string) =>
  [...phrase]
    .map((c) =>
      /\p{L}/u.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c === ' ' ? '\\s+' : c,
    )
    .join('');
const leads = (words: string[]) => words.map(anyCase).join('|');

/** Introductions and titles; group 1 is the lead-in that stays, group 2 the name. */
const NAME_PATTERNS: RegExp[] = [
  new RegExp(
    `((?:^|[^\\p{L}])(?:${leads(['my name is', "my name's", 'this is', 'i am', "i'm", 'me llamo', 'mi nombre es', 'soy'])})\\s+)(${NAME})`,
    'gu',
  ),
  new RegExp(
    `((?:^|[^\\p{L}])(?:${leads(['mr', 'mrs', 'ms', 'miss', 'dr', 'sr', 'sra', 'srta', 'don', 'doña'])})\\.?\\s+)(${NAME})`,
    'gu',
  ),
];

/** Words that follow "I am" or "soy" without being names. */
const NOT_NAMES = new Set(
  [
    'not',
    'sure',
    'okay',
    'ok',
    'fine',
    'safe',
    'home',
    'renting',
    'the',
    'a',
    'an',
    'el',
    'la',
    'un',
    'una',
    'dueño',
    'dueña',
    'inquilino',
    'inquilina',
  ].map((w) => w.toLowerCase()),
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(input: string, options: RedactOptions = {}): Redaction {
  const tokens: Record<string, string> = {};
  let text = input;
  const next = (kind: string) =>
    `[${kind}_${Object.keys(tokens).filter((k) => k.startsWith(`[${kind}_`)).length + 1}]`;
  for (const [re, kind] of PATTERNS) {
    text = text.replace(re, (match) => {
      const token = next(kind);
      tokens[token] = match;
      return token;
    });
  }
  // Known names first, longest first, so a full name is one token rather than two.
  const known = new Set<string>();
  for (const n of options.names ?? []) {
    const name = n.trim().replace(/\s+/g, ' ');
    if (name.length < 2) continue;
    known.add(name);
    for (const part of name.split(' ')) if (part.length >= 3) known.add(part);
  }
  for (const name of [...known].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'giu');
    text = text.replace(re, (match) => {
      const token = next('NAME');
      tokens[token] = match;
      return token;
    });
  }
  for (const re of NAME_PATTERNS) {
    text = text.replace(re, (whole, lead: string, name: string) => {
      const first = name.split(/\s+/)[0]!.toLowerCase();
      if (NOT_NAMES.has(first)) return whole;
      const token = next('NAME');
      tokens[token] = name;
      return `${lead}${token}`;
    });
  }
  return { text, tokens };
}
