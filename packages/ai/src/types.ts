/**
 * Pluggable AI interfaces (AIG-12): one each for language models, speech to
 * text, translation and image analysis. Providers are chosen per tenant in
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
  readonly translation?: Translator;
  readonly image?: ImageAnalysis;
  readonly classifier?: DamageClassifier;
}
