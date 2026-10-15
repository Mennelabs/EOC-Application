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

export interface LanguageModel {
  extract(request: ExtractionRequest): Promise<AiOutput<ExtractionOutput>>;
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
