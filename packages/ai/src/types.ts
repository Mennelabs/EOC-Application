/**
 * Pluggable AI interfaces (AIG-12): one each for language models, speech to
 * text, text to speech, translation and image analysis. Providers are chosen per tenant in
 * configuration; every output records which provider and model produced it.
 * A provider may be enabled for a tenant only when it meets AIG-06 (US
 * processing, zero data retention, no training on customer data) and passes
 * the evaluation suite for that tenant's languages (AIG-08).
 */
import type { AnswerValue } from '@cg/intake';

export interface ProviderInfo {
  provider: string;
  model: string;
  version?: string;
  /** The prompt template's version behind an output (AIG-01). */
  templateVersion?: string;
}

export interface Compliance {
  usRegion: boolean;
  zeroRetention: boolean;
  noTraining: boolean;
  /** Where the attestation lives (contract, DPA, console screenshot). */
  evidence?: string;
}

export interface AiOutput<T> {
  output: T;
  provider: ProviderInfo;
  latencyMs: number;
}

/** One candidate answer extracted from free text; never saved until a person confirms it (INT-13). */
export interface ExtractionCandidate {
  questionId: string;
  value: AnswerValue;
  /** 0..1 */
  confidence: number;
  /** The resident's words that support the candidate (verbatim). */
  evidence: string;
}

export interface ExtractionOutput {
  candidates: ExtractionCandidate[];
  /** Detected language of the text, BCP-47-ish ('en', 'es'). */
  language?: string;
  /** The provider noticed text that tries to instruct the system (AIG-02). */
  injectionSuspected?: boolean;
}

export interface ExtractionQuestion {
  id: string;
  answerType: string;
  options?: { value: string; label: Record<string, string> }[];
}

export interface ExtractionRequest {
  /** Redacted resident text (AIG-05), passed as data (AIG-02). */
  text: string;
  language?: string;
  questions: ExtractionQuestion[];
}

/** A staff request in plain words for the command window (CMD-03, ADR-0044). */
export interface CommandInterpretRequest {
  /** Redacted request text (AIG-05), passed as data (AIG-02, CMD-11). */
  text: string;
  /** The shorthand lines the person may use here, from the catalog (CMD-12). */
  commands: { usage: string; title: string }[];
  /** The organization's time and zone, for relative times (CMD-10). */
  now: string;
  timeZone: string;
  /**
   * CMD-06: the kind of record open on the person's screen, if any; "this"
   * then stands for it. Never which record.
   */
  onScreen?: 'mission' | 'need' | null;
}

/**
 * At most one line of shorthand from the listed commands; the server parses
 * and checks it like typed shorthand. A question when the request is
 * ambiguous (CMD-08); neither when nothing listed fits (CMD-12).
 */
export interface CommandInterpretation {
  shorthand: string | null;
  question: string | null;
  language?: string;
  injectionSuspected?: boolean;
}

export interface LanguageModel {
  extract(request: ExtractionRequest): Promise<AiOutput<ExtractionOutput>>;
  /** Plain words to one shorthand line (layer-7 task B). Optional: without it, shorthand only. */
  interpretCommand?(request: CommandInterpretRequest): Promise<AiOutput<CommandInterpretation>>;
  /** Web search for public places that could serve residents (layer-7 task F, REC-13). Optional. */
  discoverPlaces?(request: DiscoveryRequest): Promise<AiOutput<DiscoveryOutput>>;
  /** A draft written from computed facts only, each sentence citing its facts (layer-7 task G). Optional. */
  draft?(request: DraftRequest): Promise<AiOutput<DraftOutput>>;
  /** The conversation scribe's draft note (layer-7 task H, FL-04). Optional. */
  scribeNote?(request: ScribeNoteRequest): Promise<AiOutput<ScribeNote>>;
}

/** What a draft is for (CMD-16, CON-06, DCL:DEC-14, PUB-11, PUB-12, PUB-14). */
export type DraftPurpose =
  | 'report_summary'
  | 'declaration_box8'
  | 'declaration_box9'
  | 'pio_post'
  | 'radio_script'
  | 'wea_alert'
  | 'handover';

/** One computed fact a draft may state; nothing else may be stated (AI-04, AI-09). */
export interface DraftFact {
  id: string;
  label: string;
  /** Null is unknown: the draft says so and never gives a number for it. */
  value: string | number | null;
}

export interface DraftRequest {
  purpose: DraftPurpose;
  language: 'en' | 'es';
  facts: DraftFact[];
  /** The rules' own draft, for order and tone. */
  template?: string;
  /** The whole draft fits in this many characters (a WEA message, a post). */
  maxChars?: number;
}

export interface DraftSentence {
  text: string;
  /** The ids of the facts the sentence states. */
  factIds: string[];
}

export interface DraftOutput {
  sentences: DraftSentence[];
  /** Fact text tried to instruct the model (AIG-02). */
  injectionSuspected: boolean;
}

/**
 * The conversation scribe (FL-04, layer-7 task H): what was said, already
 * redacted of names, phone numbers, emails and street addresses, in, a draft
 * note out. Each line carries the words it rests on, so the worker can check
 * it at a glance and the server can drop a line whose words were never said.
 */
export interface ScribeNoteRequest {
  transcript: string;
  language: string;
}

export interface ScribeNoteLine {
  text: string;
  /** The words from the conversation the line rests on, as said. */
  quote: string;
}

export interface ScribeNote {
  needsHeard: ScribeNoteLine[];
  helpGiven: ScribeNoteLine[];
  followUps: ScribeNoteLine[];
  referrals: ScribeNoteLine[];
  /** The conversation held words that tried to instruct the model (AIG-02). */
  injectionSuspected: boolean;
}

export type DiscoveryPlaceKind =
  | 'school'
  | 'place_of_worship'
  | 'community_center'
  | 'parking_lot'
  | 'government'
  | 'commercial'
  | 'other';

/**
 * What a discovery search may carry (REC-13, AIG-05): the county's area in
 * words, the kinds of place, and the registered public places to check for
 * changes. Never a person, a request or anything a resident wrote.
 */
export interface DiscoveryRequest {
  /** "Westwind County, Missouri". */
  area: string;
  placeTypes: string[];
  /** Registered public places (name and street address) to check for closures, moves or new hours. */
  registered: { id: string; name: string; address: string | null }[];
  /** At most this many places in the answer. */
  max: number;
}

/** A place a web page states; only what a source states is filled (REC-10). */
export interface DiscoveredPlace {
  name: string;
  kind: DiscoveryPlaceKind;
  address: {
    line1: string | null;
    city: string | null;
    state: string | null;
    postal: string | null;
  } | null;
  position: { lat: number; lon: number } | null;
  facts: {
    sqft?: number;
    ada?: boolean;
    kitchen?: boolean;
    generator?: boolean;
    parkingSpaces?: number;
    hours?: string;
    website?: string;
  };
  /** Pages that state it; only pages the search actually cited are kept. */
  sourceUrls: string[];
  change: 'new' | 'update' | 'closed';
  /** For a change: which registered place it is about. */
  registeredId: string | null;
  note: string | null;
}

export interface DiscoveryOutput {
  places: DiscoveredPlace[];
  /** A page tried to instruct the model (AIG-02, OWASP LLM01). */
  injectionSuspected: boolean;
  /** Places dropped because no page the search cited states them. */
  dropped: number;
}

export interface SpeechToText {
  transcribe(
    audio: Buffer,
    mimeType: string,
    language?: string,
  ): Promise<AiOutput<{ text: string; language: string }>>;
}

/** What the AI voice speaks (PUB-14): an approved script, never anything about a person. */
export interface SpeechRequest {
  text: string;
  language: string;
  /** How it is read: a station loop or a net read-out. Never changes the words. */
  style: 'radio_loop' | 'net_readout';
}

export interface TextToSpeech {
  speak(request: SpeechRequest): Promise<AiOutput<{ audio: Buffer; mimeType: string }>>;
}

export interface Translator {
  translate(
    text: string,
    to: string,
    from?: string,
  ): Promise<AiOutput<{ text: string; detectedLanguage?: string }>>;
}

export interface Region {
  kind: 'face' | 'license_plate' | 'document' | 'house_number' | 'other';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageAnalysis {
  /** Quality coaching and sensitive regions to blur (PHO-03, PHO-07). Never a severity rating (PHO-12). */
  analyse(
    image: Buffer,
    mimeType: string,
  ): Promise<
    AiOutput<{ qualityIssues: string[]; sensitiveRegions: Region[]; detectorAvailable: boolean }>
  >;
}

/** A suggested damage degree (PHO-09, PHO-12); a person always decides (PHO-10, DCL:DEC-02). */
export type DamageDegree = 'affected' | 'minor' | 'major' | 'destroyed' | 'cannot_tell';

export interface DamageSuggestion {
  degree: DamageDegree;
  /** 0..1 */
  confidence: number;
  /** What in the photos the suggestion rests on (Section 29.2). */
  visibleFeatures: string[];
}

/**
 * The damage classifier interface (PHO-12, ADR-0043): photos and context in, a suggestion
 * out. OpenAI's vision model fills it for now; a validated classifier replaces it through
 * configuration.
 */
export interface DamageClassifier {
  classify(
    images: { data: Buffer; mimeType: string }[],
    context: { homeType?: string; hazard?: string },
  ): Promise<AiOutput<DamageSuggestion>>;
}

export interface AiProvider {
  readonly info: ProviderInfo;
  readonly compliance: Compliance;
  /** Languages the provider is evaluated for. */
  readonly languages: readonly string[];
  readonly llm?: LanguageModel;
  readonly stt?: SpeechToText;
  readonly tts?: TextToSpeech;
  readonly translation?: Translator;
  readonly image?: ImageAnalysis;
  readonly classifier?: DamageClassifier;
}
