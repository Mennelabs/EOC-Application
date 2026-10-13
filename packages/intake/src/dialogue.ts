/**
 * Numbered dialogue for text and voice (CHN-03, CHN-05, INT-05, INT-06): the
 * same question graph, rendered one node at a time as a short prompt with
 * numbered choices, and replies (digits, keywords or words) parsed back into
 * answers. Pure functions; the channels keep the state. Keywords follow
 * docs/06 (DAMAGE/DAÑOS start, HELP/AYUDA, STOP/ALTO and the carrier words,
 * BACK, SKIP). Fixed phrases here are short and plain; graph strings carry the
 * reading-grade rule.
 */
import type {
  Channel,
  GraphNode,
  Hazard,
  QuestionGraph,
  QuestionNode,
  StepNode,
} from './schema.ts';
import {
  isAsked,
  text,
  validateAnswer,
  type Answers,
  type AnswerValue,
  type SessionContext,
} from './engine.ts';

export type DialogueLocale = 'en' | 'es';

/** Upper case, trimmed, accents removed, inner spaces collapsed: "  Daños " → "DANOS". */
export function normaliseKeyword(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9?'* ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const START_EN = ['DAMAGE', 'START', 'REPORT'];
const START_ES = ['DANOS', 'DANO'];
const SHELTER_EN = ['SHELTER'];
const SHELTER_ES = ['REFUGIO'];
const HELP = ['HELP', 'INFO', 'AYUDA'];
const STOP = [
  'STOP',
  'END',
  'CANCEL',
  'UNSUBSCRIBE',
  'QUIT',
  'STOPALL',
  'ALTO',
  'PARAR',
  'CANCELAR',
];
const BACK = ['BACK', 'ATRAS'];
const SKIP = ['SKIP', 'OMITIR', 'SALTAR'];
const UNKNOWN = ['0', '*', '?', 'DONT KNOW', "DON'T KNOW", 'NO SE', 'UNKNOWN', 'IDK'];
const SEND = ['SEND', 'ENVIAR', 'YES', 'SI', 'Y', 'OK', '1'];
const NONE = ['0', 'NONE', 'NINGUNO', 'NINGUNA', 'NO'];
const AGENT = ['AGENT', 'AGENTE', 'PERSON', 'PERSONA', 'OPERATOR', 'OPERADOR'];
/** Sharing withdrawal by text: the keyword followed by the reference number (NED-05, docs/06). */
const NOSHARE = ['NOSHARE', 'NO SHARE', 'NOCOMPARTIR', 'NO COMPARTIR'];

export type Command =
  | { kind: 'start'; locale: DialogueLocale }
  | { kind: 'shelter'; locale: DialogueLocale }
  | { kind: 'help' }
  | { kind: 'stop' }
  | { kind: 'back' }
  | { kind: 'skip' }
  | { kind: 'agent' }
  | { kind: 'noshare'; code: string | null }
  | { kind: 'none' };

/** Keywords always work, whatever the current question (CHN-03). */
export function command(input: string): Command {
  const k = normaliseKeyword(input);
  for (const word of NOSHARE)
    if (k === word || k.startsWith(`${word} `))
      return { kind: 'noshare', code: k.slice(word.length).trim() || null };
  if (START_EN.includes(k)) return { kind: 'start', locale: 'en' };
  if (START_ES.includes(k)) return { kind: 'start', locale: 'es' };
  if (SHELTER_EN.includes(k)) return { kind: 'shelter', locale: 'en' };
  if (SHELTER_ES.includes(k)) return { kind: 'shelter', locale: 'es' };
  if (HELP.includes(k)) return { kind: 'help' };
  if (STOP.includes(k)) return { kind: 'stop' };
  if (BACK.includes(k)) return { kind: 'back' };
  if (SKIP.includes(k)) return { kind: 'skip' };
  if (AGENT.includes(k)) return { kind: 'agent' };
  return { kind: 'none' };
}

export function isUnknownReply(input: string): boolean {
  return UNKNOWN.includes(normaliseKeyword(input));
}

interface Strings {
  dontKnow: string;
  multiHint: string;
  numberHint: string;
  addressHint: string;
  textHint: string;
  skipHint: string;
  requiredHint: string;
  pickOne: string;
  pickNumbers: string;
  needANumber: string;
  aboutLeft: (n: number) => string;
  lastQuestion: string;
  freeText: string;
  photos: string;
  photosVoice: string;
  gotPhotos: (n: number) => string;
  needsHint: string;
  consentHint: string;
  review: string;
  reviewVoice: string;
  sendInvalid: string;
  nothingToGoBackTo: string;
  welcome: (county: string, event: string) => string;
  optInConfirmation: (county: string) => string;
  help: (county: string, helpPhone: string | null) => string;
  stop: (county: string) => string;
  noshare: (county: string, code: string) => string;
  noshareUnknown: (county: string) => string;
  shelter: (county: string, helpPhone: string | null, url: string | null) => string;
  confirmation: (county: string, code: string) => string;
  tooMany: string;
  noEvent: (county: string) => string;
  greeting: (county: string) => string;
  chooseLanguage: string;
  agentTransfer: string;
  noAgent: (helpPhone: string | null) => string;
  voiceCodeIntro: string;
  voiceTextOffer: string;
  goodbye: string;
  thenPound: string;
  retryLater: string;
  welcomeBack: string;
}

const EN: Strings = {
  dontKnow: "0 Don't know",
  multiHint: 'Reply with all the numbers that fit, like 1 3.',
  numberHint: 'Reply with a number.',
  addressHint: 'Reply with the street address, city and ZIP. A landmark is fine too.',
  textHint: 'Reply with your answer.',
  skipHint: 'Reply SKIP to leave it blank.',
  requiredHint: 'We need this one.',
  pickOne: 'Please reply with one of the numbers.',
  pickNumbers: 'Please reply with numbers from the list.',
  needANumber: 'Please reply with a number, like 2.',
  aboutLeft: (n) => `About ${n} left.`,
  lastQuestion: 'Last question.',
  freeText: 'Tell us what happened in your own words, or reply SKIP.',
  photos: 'Send photos of the damage as pictures now, or reply SKIP.',
  photosVoice: 'You can add photos later from the website with your reference number.',
  gotPhotos: (n) => (n === 1 ? 'Got 1 photo.' : `Got ${n} photos.`),
  needsHint: 'Reply with the numbers, or 0 for none.',
  consentHint: 'Reply with the numbers of the groups that may contact you, or 0 for none.',
  review: 'Last step. Reply SEND to send your report, or BACK to change an answer.',
  reviewVoice:
    'Last step. Press 1 to send your report and get a text with your reference number. Press 2 to send it without a text. Press 3 to change your last answer.',
  sendInvalid: 'Reply SEND to send your report, or BACK to change an answer.',
  nothingToGoBackTo: 'This is the first question.',
  welcome: (county, event) =>
    `${county} Emergency Mgmt: Let's report damage from the ${event}. Answer each question by number. Reply BACK, SKIP or HELP any time, STOP to end.`,
  optInConfirmation: (county) =>
    `${county} Emergency Mgmt: You're signed up for messages about your disaster report. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
  help: (county, phone) =>
    `${county} Emergency Mgmt disaster help line.${phone ? ` Call ${phone}.` : ''} In danger now, call 911. Reply DAMAGE to report damage, STOP to opt out.`,
  stop: (county) =>
    `${county} Emergency Mgmt: You're unsubscribed and will get no more messages. Reply START to rejoin.`,
  noshare: (county, code) =>
    `${county} Emergency Mgmt: Your report ${code} is no longer shared with partner organizations. Any that had it were told to delete it. Reply STOP to opt out.`,
  noshareUnknown: (county) =>
    `${county} Emergency Mgmt: We found no report with that reference number from this phone. Text NOSHARE then your reference number, like NOSHARE ABCD-2345. Reply STOP to opt out.`,
  shelter: (county, phone, url) =>
    `${county} Emergency Mgmt: For open shelters and help sites,${phone ? ` call ${phone}` : ''}${phone && url ? ' or' : ''}${url ? ` visit ${url}` : ''}. In danger now, call 911. Reply STOP to opt out.`,
  confirmation: (county, code) =>
    `${county} Emergency Mgmt: Thanks for reporting damage. Your reference number is ${code}. This does not send emergency help. In danger now? Call 911. Reply STOP to opt out.`,
  tooMany: 'Too many messages right now. Please wait a few minutes.',
  noEvent: (county) =>
    `${county} Emergency Mgmt: Damage reporting by text is not open right now. In danger now, call 911.`,
  greeting: (county) =>
    `${county} Emergency Management disaster help line. If anyone is in danger, hang up and call 911.`,
  chooseLanguage: 'For English, press 1. Para español, oprima el 2.',
  agentTransfer: 'One moment. We are connecting you to a person.',
  noAgent: (phone) =>
    phone
      ? `To speak with a person, call ${phone}. Goodbye.`
      : 'No one can take the call right now. Please try again later. Goodbye.',
  voiceCodeIntro: 'Your report was sent. Your reference number is',
  voiceTextOffer: 'We will also text it to this phone.',
  goodbye: 'Thank you. Goodbye.',
  thenPound: 'Then press pound.',
  retryLater: 'We could not save your report right now. Please try again in a few minutes.',
  welcomeBack: 'Welcome back. We saved your answers so far.',
};

const ES: Strings = {
  dontKnow: '0 No sé',
  multiHint: 'Responda con todos los números que apliquen, como 1 3.',
  numberHint: 'Responda con un número.',
  addressHint:
    'Responda con la dirección, ciudad y código postal. Un punto de referencia también sirve.',
  textHint: 'Responda con su respuesta.',
  skipHint: 'Responda OMITIR para dejarlo en blanco.',
  requiredHint: 'Esta la necesitamos.',
  pickOne: 'Por favor responda con uno de los números.',
  pickNumbers: 'Por favor responda con números de la lista.',
  needANumber: 'Por favor responda con un número, como 2.',
  aboutLeft: (n) => `Faltan unas ${n}.`,
  lastQuestion: 'Última pregunta.',
  freeText: 'Cuéntenos qué pasó con sus propias palabras, o responda OMITIR.',
  photos: 'Envíe fotos del daño como imágenes ahora, o responda OMITIR.',
  photosVoice: 'Puede añadir fotos después en el sitio web con su número de referencia.',
  gotPhotos: (n) => (n === 1 ? 'Recibimos 1 foto.' : `Recibimos ${n} fotos.`),
  needsHint: 'Responda con los números, o 0 si ninguno.',
  consentHint: 'Responda con los números de los grupos que pueden contactarle, o 0 si ninguno.',
  review:
    'Último paso. Responda ENVIAR para enviar su reporte, o ATRAS para cambiar una respuesta.',
  reviewVoice:
    'Último paso. Oprima 1 para enviar su reporte y recibir un texto con su número de referencia. Oprima 2 para enviarlo sin texto. Oprima 3 para cambiar su última respuesta.',
  sendInvalid: 'Responda ENVIAR para enviar su reporte, o ATRAS para cambiar una respuesta.',
  nothingToGoBackTo: 'Esta es la primera pregunta.',
  welcome: (county, event) =>
    `${county} Manejo de Emergencias: Vamos a reportar daños del ${event}. Responda cada pregunta con un número. Responda ATRAS, OMITIR o AYUDA cuando quiera, ALTO para terminar.`,
  optInConfirmation: (county) =>
    `${county} Manejo de Emergencias: Recibirá mensajes sobre su reporte. La frecuencia varía. Pueden aplicar tarifas. Responda AYUDA para ayuda, ALTO para cancelar.`,
  help: (county, phone) =>
    `Línea de ayuda de ${county}.${phone ? ` Llame al ${phone}.` : ''} En peligro, llame al 911. Responda DANOS para reportar daños, ALTO para cancelar.`,
  stop: (county) => `${county}: Ya no recibirá mensajes. Responda START para volver.`,
  noshare: (county, code) =>
    `${county}: Su reporte ${code} ya no se comparte con organizaciones asociadas. A las que lo tenían se les pidió borrarlo. Responda ALTO para cancelar.`,
  noshareUnknown: (county) =>
    `${county}: No encontramos un reporte con ese número desde este teléfono. Envíe NOSHARE y su número de referencia, como NOSHARE ABCD-2345. Responda ALTO para cancelar.`,
  shelter: (county, phone, url) =>
    `${county}: Para albergues y sitios de ayuda abiertos,${phone ? ` llame al ${phone}` : ''}${phone && url ? ' o' : ''}${url ? ` visite ${url}` : ''}. En peligro, llame al 911. Responda ALTO para cancelar.`,
  confirmation: (county, code) =>
    `${county} Manejo de Emergencias: Gracias por reportar daños. Su referencia es ${code}. No envía ayuda de emergencia. ¿En peligro ahora? Llame al 911. Responda ALTO para cancelar.`,
  tooMany: 'Demasiados mensajes ahora. Espere unos minutos.',
  noEvent: (county) =>
    `${county} Manejo de Emergencias: El reporte de daños por texto no está abierto ahora. En peligro, llame al 911.`,
  greeting: (county) =>
    `Línea de ayuda de Manejo de Emergencias de ${county}. Si alguien está en peligro, cuelgue y llame al 911.`,
  chooseLanguage: 'For English, press 1. Para español, oprima el 2.',
  agentTransfer: 'Un momento. Le comunicamos con una persona.',
  noAgent: (phone) =>
    phone
      ? `Para hablar con una persona, llame al ${phone}. Adiós.`
      : 'Nadie puede atender la llamada ahora. Intente más tarde. Adiós.',
  voiceCodeIntro: 'Su reporte fue enviado. Su número de referencia es',
  voiceTextOffer: 'También se lo enviaremos por texto a este teléfono.',
  goodbye: 'Gracias. Adiós.',
  thenPound: 'Luego oprima numeral.',
  retryLater: 'No pudimos guardar su reporte ahora. Intente de nuevo en unos minutos.',
  welcomeBack: 'Bienvenido de nuevo. Guardamos sus respuestas hasta ahora.',
};

export function strings(locale: string): Strings {
  return locale.toLowerCase().startsWith('es') ? ES : EN;
}

export function dialogueLocale(locale: string): DialogueLocale {
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export interface DialogueOptions {
  /** Consent organisation types the tenant offers (opt-in ones only when enabled). */
  consentOrgTypes: { value: string; label: Record<string, string> }[];
  channel: 'sms' | 'voice';
  /** Questions still to come, for "About N left" (INT-06). */
  remaining?: number;
}

export interface RenderedNode {
  text: string;
  /** What a voice gather should collect. */
  expects: 'digits' | 'speech_or_digits' | 'none';
  maxDigits: number;
}

function numbered(items: { label: string }[], locale: DialogueLocale, voice: boolean): string {
  const press = locale === 'es' ? 'Oprima' : 'Press';
  return items
    .map((o, i) => (voice ? `${press} ${i + 1}: ${o.label}.` : `${i + 1} ${o.label}`))
    .join(voice ? ' ' : '\n');
}

function questionPrompt(q: QuestionNode, ctx: SessionContext, answers: Answers, locale: string) {
  const r = answers['relationship'];
  const rel = r && r.kind === 'value' && typeof r.value === 'string' ? r.value : ctx.relationship;
  const alt = rel ? q.promptFor?.[rel as keyof NonNullable<typeof q.promptFor>] : undefined;
  return text(alt ?? q.prompt, locale);
}

/** One node as the channel shows it. */
export function renderNode(
  graph: QuestionGraph,
  node: GraphNode,
  ctx: SessionContext,
  answers: Answers,
  locale: string,
  opts: DialogueOptions,
): RenderedNode {
  const S = strings(locale);
  const L = dialogueLocale(locale);
  const voice = opts.channel === 'voice';
  const sep = voice ? ' ' : '\n';
  const tail: string[] = [];
  if (opts.remaining !== undefined && node.kind === 'question')
    tail.push(opts.remaining === 0 ? S.lastQuestion : S.aboutLeft(opts.remaining));

  if (node.kind === 'info') {
    return {
      text: `${text(node.title, locale)}. ${text(node.body, locale)}`,
      expects: 'none',
      maxDigits: 0,
    };
  }
  if (node.kind !== 'question') {
    return renderStep(graph, node, locale, opts);
  }
  const prompt = questionPrompt(node, ctx, answers, locale);
  switch (node.answerType) {
    case 'single':
    case 'yesno': {
      const options = (node.options ?? []).map((o) => ({ label: text(o.label, locale) }));
      const lines = [prompt, numbered(options, L, voice)];
      if (node.allowUnknown)
        lines.push(
          voice
            ? L === 'es'
              ? 'Oprima asterisco si no sabe.'
              : 'Press star if you do not know.'
            : S.dontKnow,
        );
      if (!node.required && !voice) lines.push(S.skipHint);
      return { text: [...lines, ...tail].join(sep), expects: 'speech_or_digits', maxDigits: 1 };
    }
    case 'multi': {
      const options = (node.options ?? []).map((o) => ({ label: text(o.label, locale) }));
      const lines = [prompt, numbered(options, L, voice), S.multiHint];
      if (node.allowUnknown)
        lines.push(
          voice
            ? L === 'es'
              ? 'Oprima asterisco si no sabe.'
              : 'Press star if you do not know.'
            : S.dontKnow,
        );
      return { text: [...lines, ...tail].join(sep), expects: 'speech_or_digits', maxDigits: 12 };
    }
    case 'number': {
      const lines = [prompt, S.numberHint];
      if (node.allowUnknown)
        lines.push(
          voice
            ? L === 'es'
              ? 'Diga "no sé" si no sabe.'
              : 'Say "don\'t know" if you do not know.'
            : S.dontKnow,
        );
      return { text: [...lines, ...tail].join(sep), expects: 'speech_or_digits', maxDigits: 6 };
    }
    case 'address':
      return {
        text: [prompt, S.addressHint, ...tail].join(sep),
        expects: 'speech_or_digits',
        maxDigits: 0,
      };
    case 'contact':
      return {
        text: [prompt, S.textHint, ...(node.required ? [] : [S.skipHint]), ...tail].join(sep),
        expects: 'speech_or_digits',
        maxDigits: 0,
      };
    case 'text':
    default: {
      const lines = [prompt, S.textHint];
      if (node.allowUnknown && !voice) lines.push(S.dontKnow);
      if (!node.required && !voice) lines.push(S.skipHint);
      return { text: [...lines, ...tail].join(sep), expects: 'speech_or_digits', maxDigits: 0 };
    }
  }
}

function renderStep(
  graph: QuestionGraph,
  node: StepNode,
  locale: string,
  opts: DialogueOptions,
): RenderedNode {
  const S = strings(locale);
  const L = dialogueLocale(locale);
  const voice = opts.channel === 'voice';
  const sep = voice ? ' ' : '\n';
  switch (node.kind) {
    case 'free_text':
      return { text: S.freeText, expects: 'speech_or_digits', maxDigits: 0 };
    case 'photos':
      return voice
        ? { text: S.photosVoice, expects: 'none', maxDigits: 0 }
        : { text: S.photos, expects: 'none', maxDigits: 0 };
    case 'needs': {
      const items = graph.needCategories.map((c) => ({ label: text(c.label, locale) }));
      return {
        text: [text(node.title, locale), numbered(items, L, voice), S.needsHint].join(sep),
        expects: 'speech_or_digits',
        maxDigits: 12,
      };
    }
    case 'consent': {
      const items = opts.consentOrgTypes.map((c) => ({ label: text(c.label, locale) }));
      return {
        text: [text(node.title, locale), numbered(items, L, voice), S.consentHint].join(sep),
        expects: 'speech_or_digits',
        maxDigits: 12,
      };
    }
    case 'review':
      return { text: voice ? S.reviewVoice : S.review, expects: 'digits', maxDigits: 1 };
  }
}

export type ParsedReply =
  | { kind: 'answer'; value: AnswerValue }
  | { kind: 'needs'; values: string[] }
  | { kind: 'consent'; values: Record<string, boolean> }
  | { kind: 'own_words'; text: string }
  | { kind: 'send'; smsOptIn: boolean }
  | { kind: 'back' }
  | { kind: 'ack' }
  | { kind: 'invalid'; message: string };

const NUMBER_WORDS: Record<string, string> = {
  ONE: '1',
  TWO: '2',
  THREE: '3',
  FOUR: '4',
  FIVE: '5',
  SIX: '6',
  SEVEN: '7',
  EIGHT: '8',
  NINE: '9',
  ZERO: '0',
  UNO: '1',
  DOS: '2',
  TRES: '3',
  CUATRO: '4',
  CINCO: '5',
  SEIS: '6',
  SIETE: '7',
  OCHO: '8',
  NUEVE: '9',
  CERO: '0',
};

/** Digits typed, or number words spoken ("one", "dos"); anything else is not a digit reply. */
function digitsOf(input: string): number[] | null {
  const words = normaliseKeyword(input)
    .split(' ')
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(' ');
  if (/[^0-9 ]/.test(words)) return null;
  const k = words.trim();
  if (!k) return null;
  const parts = k.split(/\s+/);
  if (parts.some((p) => !/^\d{1,2}$/.test(p))) return null;
  // "13" with up to 9 options means 1 and 3 when typed on a keypad.
  const nums = parts.flatMap((p) =>
    p.length === 2 && Number(p[0]) > 0 ? [Number(p[0]), Number(p[1])] : [Number(p)],
  );
  return nums;
}

function matchOption(
  options: { value: string; label: Record<string, string> }[],
  input: string,
  locale: string,
): string | null {
  const k = normaliseKeyword(input);
  if (!k) return null;
  const yes = ['YES', 'Y', 'SI', 'YEAH', 'YEP'];
  const no = ['NO', 'N', 'NOPE'];
  if (yes.includes(k) && options.some((o) => o.value === 'yes')) return 'yes';
  if (no.includes(k) && options.some((o) => o.value === 'no')) return 'no';
  for (const o of options) {
    const label = normaliseKeyword(text(o.label, locale));
    const labelEn = normaliseKeyword(text(o.label, 'en'));
    if (k === label || k === labelEn || k === normaliseKeyword(o.value)) return o.value;
  }
  // Spoken answers: the label's first words are usually enough ("apartment" for "Apartment or condo").
  const hits = options.filter((o) => {
    const label = normaliseKeyword(text(o.label, locale));
    return (
      label.startsWith(k) || k.startsWith(label.split(' ')[0] ?? '\u0000') || label.includes(k)
    );
  });
  return hits.length === 1 ? hits[0]!.value : null;
}

/** Street text to the address shape the graph expects; a ZIP is picked out when present. */
export function parseAddress(input: string): Record<string, string> {
  const t = input.trim().replace(/\s+/g, ' ');
  const zip = t.match(/\b(\d{5})(?:-\d{4})?\b/);
  const out: Record<string, string> = {
    line1: zip
      ? t
          .replace(zip[0], '')
          .replace(/[,\s]+$/, '')
          .trim() || t
      : t,
  };
  if (zip?.[1]) out['postal'] = zip[1];
  return out;
}

/** A reply to the node being asked. Commands (BACK, SKIP, HELP, STOP) are handled before this. */
export function parseReply(
  graph: QuestionGraph,
  node: GraphNode,
  input: string,
  locale: string,
  opts: DialogueOptions,
): ParsedReply {
  const S = strings(locale);
  const raw = input.trim();
  if (node.kind === 'info') return { kind: 'ack' };
  if (node.kind !== 'question') return parseStepReply(graph, node, raw, locale, opts);

  if (isUnknownReply(raw)) {
    if (node.allowUnknown) return { kind: 'answer', value: { kind: 'unknown' } };
    return { kind: 'invalid', message: node.options ? S.pickOne : S.textHint };
  }
  let value: AnswerValue;
  switch (node.answerType) {
    case 'single':
    case 'yesno': {
      const options = node.options ?? [];
      const digits = digitsOf(raw);
      if (digits && digits.length === 1) {
        const o = options[digits[0]! - 1];
        if (!o) return { kind: 'invalid', message: S.pickOne };
        value = { kind: 'value', value: o.value };
      } else {
        const m = matchOption(options, raw, locale);
        if (!m) return { kind: 'invalid', message: S.pickOne };
        value = { kind: 'value', value: m };
      }
      break;
    }
    case 'multi': {
      const options = node.options ?? [];
      const digits = digitsOf(raw);
      if (digits) {
        const picked = [...new Set(digits)].map((d) => options[d - 1]?.value);
        if (picked.some((p) => !p)) return { kind: 'invalid', message: S.pickNumbers };
        value = { kind: 'value', value: picked as string[] };
      } else {
        const picked = raw
          .split(/[,;]| and | y /i)
          .map((p) => matchOption(options, p, locale))
          .filter((p): p is string => Boolean(p));
        if (picked.length === 0) return { kind: 'invalid', message: S.pickNumbers };
        value = { kind: 'value', value: [...new Set(picked)] };
      }
      break;
    }
    case 'number': {
      const n = Number(normaliseKeyword(raw).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(n) || raw.replace(/[^0-9]/g, '') === '')
        return { kind: 'invalid', message: S.needANumber };
      value = { kind: 'value', value: n };
      break;
    }
    case 'address':
      value = { kind: 'value', value: parseAddress(raw) };
      break;
    case 'contact': {
      const email = raw.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0];
      value = { kind: 'value', value: email ? { email } : { phone: raw } };
      break;
    }
    default:
      value = { kind: 'value', value: raw };
  }
  const errors = validateAnswer(node, value);
  if (errors.length > 0) return { kind: 'invalid', message: errors[0]!.message };
  return { kind: 'answer', value };
}

function parseStepReply(
  graph: QuestionGraph,
  node: StepNode,
  raw: string,
  locale: string,
  opts: DialogueOptions,
): ParsedReply {
  const S = strings(locale);
  const k = normaliseKeyword(raw);
  switch (node.kind) {
    case 'free_text':
      return raw ? { kind: 'own_words', text: raw } : { kind: 'ack' };
    case 'photos':
      return { kind: 'ack' };
    case 'needs': {
      if (NONE.includes(k)) return { kind: 'needs', values: [] };
      const digits = digitsOf(raw);
      if (!digits) return { kind: 'invalid', message: S.needsHint };
      const values = [...new Set(digits)].map((d) => graph.needCategories[d - 1]?.value);
      if (values.some((v) => !v)) return { kind: 'invalid', message: S.pickNumbers };
      return { kind: 'needs', values: values as string[] };
    }
    case 'consent': {
      const all = Object.fromEntries(opts.consentOrgTypes.map((c) => [c.value, false]));
      if (NONE.includes(k)) return { kind: 'consent', values: all };
      const digits = digitsOf(raw);
      if (!digits) return { kind: 'invalid', message: S.consentHint };
      for (const d of digits) {
        const c = opts.consentOrgTypes[d - 1];
        if (!c) return { kind: 'invalid', message: S.pickNumbers };
        all[c.value] = true;
      }
      return { kind: 'consent', values: all };
    }
    case 'review': {
      if (opts.channel === 'voice') {
        if (k === '1') return { kind: 'send', smsOptIn: true };
        if (k === '2') return { kind: 'send', smsOptIn: false };
        if (k === '3') return { kind: 'back' };
        return { kind: 'invalid', message: S.reviewVoice };
      }
      if (SEND.includes(k)) return { kind: 'send', smsOptIn: true };
      return { kind: 'invalid', message: S.sendInvalid };
    }
  }
}

/** Nodes a text or voice session never asks: the channel already knows the phone number. */
export const AUTO_ANSWERED: Record<Channel, string[]> = {
  web: [],
  assisted: [],
  sms: ['contact'],
  voice: ['contact'],
};

/** Hazards for a session come from the event; this mirrors the API's table so channels agree. */
export const EVENT_HAZARDS: Record<string, Hazard[]> = {
  tornado: ['tornado', 'wind'],
  wind: ['wind'],
  severe_storm: ['wind'],
  hurricane: ['wind', 'flood'],
  flood: ['flood'],
  winter_storm: ['winter_storm'],
  wildfire: ['fire'],
  fire: ['fire'],
};

export function hazardsForEvent(hazardType: string): Hazard[] {
  return EVENT_HAZARDS[hazardType] ?? ['other'];
}

/** Is this node still asked for the session (channel, relationship, hazards, conditions)? */
export function nodeIsAsked(node: GraphNode, ctx: SessionContext, answers: Answers): boolean {
  return isAsked(node, ctx, answers);
}
