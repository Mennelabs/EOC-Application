/**
 * Deterministic fake provider for development and tests (CLAUDE.md: ship a
 * fake; AIG-12). Keyword rules over the question graph's options in English
 * and Spanish, so the resident flow, the evaluation harness and the worker
 * can run end to end without any external service. It never leaves the
 * process, so the AIG-06 attributes hold trivially. It supplies no severity
 * rating (PHO-12) and no sensitive-region detector (PHO-07): it says so.
 */
import type { AnswerValue } from '@cg/intake';
import type {
  AiOutput,
  AiProvider,
  CommandInterpretation,
  CommandInterpretRequest,
  DiscoveryOutput,
  DiscoveryRequest,
  DraftOutput,
  DraftRequest,
  ExtractionOutput,
  ExtractionRequest,
  ImageAnalysis,
  LanguageModel,
  ProviderInfo,
  ScribeNote,
  ScribeNoteLine,
  ScribeNoteRequest,
  SpeechRequest,
  SpeechToText,
  TextToSpeech,
  Translator,
} from '../types.ts';

const INFO: ProviderInfo = { provider: 'fake', model: 'keyword-rules', version: '1' };

/** Text that tries to instruct the system rather than describe damage (AIG-02 test cases). */
const INJECTION =
  /\b(ignore (all |the )?(previous|above|prior) instructions|system prompt|you are now|approve (this|my) report|mark (this|it) as (approved|destroyed)|developer mode|<\/?(system|instruction)>)\b/i;

type Rule = { re: RegExp; questionId: string; value: string | string[]; confidence: number };

/** Keyword → option rules for the shipped graph; a tenant graph with other option values simply gets fewer candidates. */
const RULES: Rule[] = [
  {
    re: /\b(tornado|wind|viento|gust)/i,
    questionId: 'cause',
    value: 'wind_tornado',
    confidence: 0.9,
  },
  {
    re: /\b(flood|inundaci[oó]n|water (came|got|rose) in|agua (entr[oó]|subi[oó]))/i,
    questionId: 'cause',
    value: 'flood',
    confidence: 0.85,
  },
  { re: /\b(fire|fuego|incendio|burn)/i, questionId: 'cause', value: 'fire', confidence: 0.85 },
  {
    re: /\b(ice|snow|hielo|nieve|freez)/i,
    questionId: 'cause',
    value: 'winter_storm',
    confidence: 0.8,
  },
  {
    re: /(?:^|[^\p{L}])(tree|[aá]rbol(es)?)(?![\p{L}])/iu,
    questionId: 'damage_types',
    value: 'tree_on_home',
    confidence: 0.9,
  },
  {
    re: /\b(roof|techo|shingle|teja)/i,
    questionId: 'damage_types',
    value: 'roof',
    confidence: 0.85,
  },
  {
    re: /\b(window|ventana|door|puerta)/i,
    questionId: 'damage_types',
    value: 'windows_doors',
    confidence: 0.8,
  },
  {
    re: /(water (came|got|is|was) (in|inside)|flooded|agua (adentro|entr[oó]|inside)|entr[oó] agua|se inund[oó]|inundad)/iu,
    questionId: 'damage_types',
    value: 'water_inside',
    confidence: 0.85,
  },
  { re: /\b(wall|pared)/i, questionId: 'damage_types', value: 'walls', confidence: 0.7 },
  {
    re: /\b(off (the|its) foundation|moved|tilt|se movi[oó]|inclin)/i,
    questionId: 'damage_types',
    value: 'moved_off_foundation',
    confidence: 0.75,
  },
  {
    re: /\b(fence|shed|yard|cerca|cobertizo|patio)\b/i,
    questionId: 'damage_types',
    value: 'outside_only',
    confidence: 0.5,
  },
  {
    re: /\b(apartment|apartamento|condo)/i,
    questionId: 'home_type',
    value: 'apartment_condo',
    confidence: 0.8,
  },
  {
    re: /\b(mobile home|manufactured|trailer|casa m[oó]vil|tr[aá]iler)/i,
    questionId: 'home_type',
    value: 'mobile_manufactured',
    confidence: 0.85,
  },
  {
    re: /\b(my house|our house|the house|mi casa|nuestra casa)\b/i,
    questionId: 'home_type',
    value: 'house',
    confidence: 0.6,
  },
  {
    re: /\b(i rent|we rent|renting|landlord|rento|rentamos|alquil)/i,
    questionId: 'occupancy',
    value: 'rent',
    confidence: 0.85,
  },
  {
    re: /\b(i own|we own|our mortgage|soy due[nñ]|somos due[nñ])/i,
    questionId: 'occupancy',
    value: 'own',
    confidence: 0.85,
  },
  {
    re: /\b(no power|no electricity|no lights?|power (is|went) out|lights? (are|went) out|sin luz|sin electricidad)/i,
    questionId: 'utilities_out',
    value: 'electricity',
    confidence: 0.85,
  },
  { re: /\b(no water|sin agua)\b/i, questionId: 'utilities_out', value: 'water', confidence: 0.8 },
  {
    re: /\b(smell(s|ing)? gas|gas leak|olor a gas|fuga de gas)/i,
    questionId: 'utilities_out',
    value: 'gas',
    confidence: 0.7,
  },
  {
    re: /\b(can'?t (stay|live) (here|there)|staying (with|at)|sleeping (at|in) (my|a|the)|hotel|shelter|no podemos quedarnos|nos quedamos con|albergue|refugio)/i,
    questionId: 'tonight',
    value: 'yes',
    confidence: 0.75,
  },
  {
    re: /\b(can'?t (stay|live) (here|there)|not safe to (stay|live)|unsafe to (stay|live)|no es seguro (vivir|quedarse))/i,
    questionId: 'habitable',
    value: 'no',
    confidence: 0.75,
  },
  {
    re: /\b(waterline|water ?line|water (was|got) (up to|above))/i,
    questionId: 'water_depth',
    value: 'over_18in',
    confidence: 0.4,
  },
  {
    re: /\b(road|bridge|camino|puente) (is )?(out|blocked|washed|gone|cerrad|bloquead)/i,
    questionId: 'access',
    value: 'no_public_road',
    confidence: 0.6,
  },
];

function detectLanguage(text: string): string {
  const es = (
    text.match(/\b(el|la|los|las|y|de|que|casa|agua|techo|no|con|mi|se|por|para)\b/gi) ?? []
  ).length;
  const en = (text.match(/\b(the|and|of|is|my|our|house|water|roof|no|with|in|on|for)\b/gi) ?? [])
    .length;
  if (/[áéíóúñ¿¡]/i.test(text) && es >= en) return 'es';
  return es > en ? 'es' : 'en';
}

function evidenceFor(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return text.slice(0, 80);
  const start = Math.max(0, m.index - 30);
  return text.slice(start, Math.min(text.length, m.index + m[0].length + 30)).trim();
}

export class FakeLanguageModel implements LanguageModel {
  async extract(request: ExtractionRequest): Promise<AiOutput<ExtractionOutput>> {
    const started = performance.now();
    const text = request.text;
    const allowed = new Map(request.questions.map((q) => [q.id, q]));
    const injectionSuspected = INJECTION.test(text);
    const byQuestion = new Map<
      string,
      { values: Set<string>; confidence: number; evidence: string; multi: boolean }
    >();
    if (!injectionSuspected) {
      for (const rule of RULES) {
        if (!rule.re.test(text)) continue;
        const q = allowed.get(rule.questionId);
        if (!q) continue;
        const values = Array.isArray(rule.value) ? rule.value : [rule.value];
        const valid = values.filter((v) => !q.options || q.options.some((o) => o.value === v));
        if (valid.length === 0) continue;
        const entry = byQuestion.get(rule.questionId) ?? {
          values: new Set<string>(),
          confidence: 0,
          evidence: '',
          multi: q.answerType === 'multi',
        };
        if (!entry.multi && entry.values.size > 0 && rule.confidence <= entry.confidence) continue;
        if (!entry.multi) entry.values.clear();
        for (const v of valid) entry.values.add(v);
        entry.confidence = Math.max(entry.confidence, rule.confidence);
        entry.evidence = entry.evidence
          ? `${entry.evidence} … ${evidenceFor(text, rule.re)}`
          : evidenceFor(text, rule.re);
        byQuestion.set(rule.questionId, entry);
      }
    }
    const candidates = [...byQuestion.entries()].map(([questionId, e]) => {
      const value: AnswerValue = e.multi
        ? { kind: 'value', value: [...e.values] }
        : { kind: 'value', value: [...e.values][0]! };
      return { questionId, value, confidence: e.confidence, evidence: e.evidence.slice(0, 500) };
    });
    const output: ExtractionOutput = { candidates, language: detectLanguage(text) };
    if (injectionSuspected) output.injectionSuspected = true;
    return { output, provider: INFO, latencyMs: performance.now() - started };
  }

  async interpretCommand(
    request: CommandInterpretRequest,
  ): Promise<AiOutput<CommandInterpretation>> {
    const started = performance.now();
    const output = {
      ...interpret(request.text, request.onScreen ?? null),
      language: detectLanguage(request.text),
    };
    return { output, provider: INFO, latencyMs: performance.now() - started };
  }

  /**
   * Tests only: each sentence of the conversation sorted by its words into
   * needs, help given, follow-ups and referrals, quoted as said. Never more
   * than was said; a sentence that tries to instruct the model sets the flag.
   */
  async scribeNote(request: ScribeNoteRequest): Promise<AiOutput<ScribeNote>> {
    const started = performance.now();
    const note: ScribeNote = {
      needsHeard: [],
      helpGiven: [],
      followUps: [],
      referrals: [],
      injectionSuspected: INJECTION.test(request.transcript),
    };
    const rules: [keyof Omit<ScribeNote, 'injectionSuspected'>, RegExp][] = [
      [
        'referrals',
        /\b(refer|referred|red cross|salvation army|case manag|cruz roja|ej[eé]rcito de salvaci[oó]n|refer[ií])/i,
      ],
      [
        'followUps',
        /\b(tomorrow|next week|come back|follow up|call you|ma[ñn]ana|la pr[oó]xima semana|volver[eé]|le llamo)/i,
      ],
      [
        'helpGiven',
        /\b(i gave|we gave|here is|here are|brought|le di|le dimos|aqu[ií] tiene|traje)/i,
      ],
      ['needsHeard', /\b(need|needs|we have no|out of|necesit|no tenemos|nos falta)/i],
    ];
    for (const sentence of request.transcript.split(/(?<=[.!?])\s+/)) {
      const said = sentence.trim();
      if (!said || INJECTION.test(said)) continue;
      const hit = rules.find(([, re]) => re.test(said));
      if (!hit) continue;
      const line: ScribeNoteLine = { text: said.replace(/[.!?]+$/, ''), quote: said };
      note[hit[0]].push(line);
    }
    return { output: note, provider: INFO, latencyMs: performance.now() - started };
  }

  /**
   * Tests only: the rules' own draft, sentence by sentence, each citing the
   * facts whose figures it holds; without a template, one sentence per fact.
   */
  async draft(request: DraftRequest): Promise<AiOutput<DraftOutput>> {
    const started = performance.now();
    const figures = (t: string) => new Set(figuresOf(t));
    const sentences = request.template
      ? request.template
          .split(/(?<=[.!?])\s+/)
          .filter((t) => t.trim())
          .map((text) => {
            const want = figures(text);
            const cites = request.facts
              .filter((f) => [...figures(`${f.label} ${f.value ?? ''}`)].some((x) => want.has(x)))
              .map((f) => f.id);
            return {
              text,
              factIds: cites.length ? cites : request.facts.slice(0, 1).map((f) => f.id),
            };
          })
      : request.facts.map((f) => ({
          text: `${f.label}: ${f.value ?? (request.language === 'es' ? 'aún no se sabe' : 'not known yet')}.`,
          factIds: [f.id],
        }));
    return {
      output: { sentences, injectionSuspected: false },
      provider: INFO,
      latencyMs: performance.now() - started,
    };
  }

  /**
   * Tests only: one fictional hall in the area with a fictional page, and a
   * closure for any listed place whose name says it closed. Never a real place.
   */
  async discoverPlaces(request: DiscoveryRequest): Promise<AiOutput<DiscoveryOutput>> {
    const started = performance.now();
    const town = request.area.split(',')[0]!.trim();
    const places: DiscoveryOutput['places'] = [
      {
        name: `Exercise ${town} Community Hall`,
        kind: 'community_center' as const,
        address: { line1: '1 Exercise Way', city: town, state: null, postal: null },
        position: null,
        facts: { kitchen: true },
        sourceUrls: ['https://example.org/exercise-community-hall'],
        change: 'new' as const,
        registeredId: null,
        note: null,
      },
      ...request.registered
        .filter((r) => /\bclosed\b/i.test(r.name))
        .map((r) => ({
          name: r.name,
          kind: 'other' as const,
          address: null,
          position: null,
          facts: {},
          sourceUrls: ['https://example.org/exercise-closure-notice'],
          change: 'closed' as const,
          registeredId: r.id,
          note: 'The page says the building closed.',
        })),
    ].slice(0, request.max);
    return {
      output: { places, injectionSuspected: false, dropped: 0 },
      provider: INFO,
      latencyMs: performance.now() - started,
    };
  }
}

/** Requests that try to change the command window's rules (AIG-02, CMD-11), in English and Spanish. */
const COMMAND_INJECTION =
  /\b(ignore (all |the )?(previous|above|prior) instructions|ignora (las |todas las )?instrucciones|you are now|ahora eres|grant me|developer mode|system prompt)\b/i;

const MISSION_REF = /\bM-\d{3,6}\b/i;
/** A need reference code: letters and digits together, not a mission number. */
const NEED_REF = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{6,12}\b/;

const STATUS_WORDS: [RegExp, string][] = [
  [/\b(on scene|on-scene|en (el )?sitio|en el lugar|lleg)/i, 'on_scene'],
  [/\b(en route|on (the|their) way|en camino)/i, 'en_route'],
  [/\b(cleared|done there|despejad)/i, 'cleared'],
];

/**
 * Keyword rules standing in for the language model in development and tests:
 * one line of shorthand, a question, or nothing. The server parses the line
 * like typed shorthand, so these rules decide nothing.
 */
function interpret(text: string, onScreen: 'mission' | 'need' | null): CommandInterpretation {
  if (COMMAND_INJECTION.test(text))
    return { shorthand: null, question: null, injectionSuspected: true };
  const t = text.toLowerCase();
  // CMD-06: "this" or "it" with a record open and no number given means that record.
  const here = /\b(this|it|esta|este|esto)\b/i.test(t) ? onScreen : null;
  const mission = MISSION_REF.exec(text)?.[0] ?? (here === 'mission' ? 'this' : undefined);
  const need = mission
    ? undefined
    : (NEED_REF.exec(text.toUpperCase())?.[0] ?? (here === 'need' ? 'this' : undefined));
  if (need && /\b(claim|reclam|toma)/i.test(t))
    return { shorthand: `/need ${need} claim`, question: null };
  if (need && /\b(release|liber|suelta)/i.test(t))
    return { shorthand: `/need ${need} release`, question: null };
  if (mission) {
    // DSP-04: "send the nearest chainsaw team" / "el equipo de motosierra más cercano".
    const nearest =
      /\b(?:nearest|closest)\s+(?:(\p{L}+)\s+)?(?:team|crew)\b/iu.exec(text) ??
      /\bequipo\s+(?:de\s+)?(\p{L}+)?\s*m[aá]s\s+cercano\b/iu.exec(text);
    if (nearest)
      return {
        shorthand: `/mission ${mission} send nearest ${nearest[1] ? `${nearest[1].toLowerCase()} ` : ''}team`,
        question: null,
      };
    for (const [re, to] of STATUS_WORDS)
      if (re.test(t)) return { shorthand: `/mission ${mission} status ${to}`, question: null };
    const note = /\b(?:note|nota)\b[:\s]+(.+)$/i.exec(text)?.[1];
    if (note) return { shorthand: `/mission ${mission} note ${note}`, question: null };
    if (/\b(show|open|muestra|abre|ver)\b/i.test(t))
      return { shorthand: `/mission ${mission}`, question: null };
    return { shorthand: null, question: `What should happen to mission ${mission}?` };
  }
  if (/\b(missions?|misiones)\b/i.test(t)) {
    if (/\b(unassigned|sin asignar)\b/i.test(t))
      return { shorthand: '/missions unassigned', question: null };
    if (/\b(open|abiertas)\b/i.test(t)) return { shorthand: '/missions open', question: null };
  }
  const remind =
    /\b(?:remind me|recu[eé]rdame)\s+(?:in|en)\s+(\d+)\s*(minutes?|mins?|minutos?|hours?|horas?)\s+(?:to\s+|que\s+|de\s+)?(.+)$/i.exec(
      text,
    );
  if (remind) {
    const unit = /^h/i.test(remind[2]!) ? 'h' : 'm';
    return {
      shorthand: `/remind in ${remind[1]}${unit} "${remind[3]!.replace(/"/g, '')}"`,
      question: null,
    };
  }
  // FL-07: "log two meals", "registra tres comidas", "I'm done here".
  const NUM: Record<string, string> = {
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
    uno: '1',
    una: '1',
    dos: '2',
    tres: '3',
    cuatro: '4',
    cinco: '5',
  };
  const logged =
    /\b(?:log|registra|anota)\s+(\d+|one|two|three|four|five|uno|una|dos|tres|cuatro|cinco)\s+(meals?|comidas?|tarps?|lonas?|cots?|catres?|rides?|viajes?)\b/i.exec(
      text,
    );
  if (logged)
    return {
      shorthand: `/log ${NUM[logged[1]!.toLowerCase()] ?? logged[1]} ${logged[2]!.toLowerCase()}`,
      question: null,
    };
  if (
    /\b(i'?m done here|i am done here|check me out|ya terminé aquí|ya termine aqui|terminé mi turno)\b/i.test(
      t,
    )
  )
    return { shorthand: '/checkout', question: null };
  // CMD-14: who is free, by a recorded skill; nothing inferred.
  if (/\b(who|quién|quien|people|personas)\b/i.test(t) && /\b(available|disponibles?)\b/i.test(t)) {
    const skill = /\b(?:with|con)\s+(?:a\s+|an\s+)?([a-záéíóúñ]+)\b/i.exec(text)?.[1];
    return {
      shorthand: `/people available${skill ? ` skill:${skill.toLowerCase()}` : ''}`,
      question: null,
    };
  }
  if (/\b(sitrep|situation report|informe de situaci[oó]n)\b/i.test(t)) {
    const hours = /(\d{1,3})\s*(hours?|horas?)/i.exec(t)?.[1];
    return { shorthand: `/sitrep${hours ? ` ${hours}` : ''}`, question: null };
  }
  return { shorthand: null, question: null };
}

export class FakeSpeechToText implements SpeechToText {
  /** Development stand-in: a text/plain "audio" buffer is returned as its own transcript. */
  async transcribe(audio: Buffer, mimeType: string, language?: string) {
    const text = mimeType.startsWith('text/') ? audio.toString('utf8') : '';
    return {
      output: { text, language: language ?? detectLanguage(text) },
      provider: INFO,
      latencyMs: 0,
    };
  }
}

/**
 * Tests only: a silent 8 kHz WAV whose length follows the number of words
 * (a tenth of a second each, at most ten seconds), so a test can tell a file
 * was made for the script it sent. Never a voice.
 */
export class FakeTextToSpeech implements TextToSpeech {
  async speak(request: SpeechRequest) {
    const rate = 8000;
    const words = request.text.split(/\s+/).filter(Boolean).length;
    const samples = Math.min(rate * 10, Math.max(rate / 10, words * (rate / 10)));
    const audio = Buffer.alloc(44 + samples, 128);
    audio.write('RIFF', 0, 'ascii');
    audio.writeUInt32LE(36 + samples, 4);
    audio.write('WAVE', 8, 'ascii');
    audio.write('fmt ', 12, 'ascii');
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(rate, 24);
    audio.writeUInt32LE(rate, 28);
    audio.writeUInt16LE(1, 32);
    audio.writeUInt16LE(8, 34);
    audio.write('data', 36, 'ascii');
    audio.writeUInt32LE(samples, 40);
    return { output: { audio, mimeType: 'audio/wav' }, provider: INFO, latencyMs: 0 };
  }
}

export class FakeTranslator implements Translator {
  /** Returns the text unchanged so reviewers see an honest label, never a wrong translation (EQ-08). */
  async translate(text: string, _to: string, from?: string) {
    return {
      output: { text, detectedLanguage: from ?? detectLanguage(text) },
      provider: INFO,
      latencyMs: 0,
    };
  }
}

export class FakeImageAnalysis implements ImageAnalysis {
  async analyse(image: Buffer) {
    const issues: string[] = [];
    if (image.length < 2048) issues.push('too_small');
    return {
      output: { qualityIssues: issues, sensitiveRegions: [], detectorAvailable: false },
      provider: INFO,
      latencyMs: 0,
    };
  }
}

export const fakeProvider: AiProvider = {
  info: INFO,
  compliance: {
    usRegion: true,
    zeroRetention: true,
    noTraining: true,
    evidence: 'in-process; nothing leaves the service',
  },
  languages: ['en', 'es'],
  llm: new FakeLanguageModel(),
  stt: new FakeSpeechToText(),
  tts: new FakeTextToSpeech(),
  translation: new FakeTranslator(),
  image: new FakeImageAnalysis(),
};

/** Figures in a text, as the draft check reads them. */
function figuresOf(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));
}
