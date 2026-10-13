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
  ExtractionOutput,
  ExtractionRequest,
  ImageAnalysis,
  LanguageModel,
  ProviderInfo,
  SpeechToText,
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
  translation: new FakeTranslator(),
  image: new FakeImageAnalysis(),
};
