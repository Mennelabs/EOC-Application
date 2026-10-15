/**
 * Provider registry and the AI use register (AIG-01, AIG-06, AIG-08, AIG-12).
 * The register lists every AI feature with its provider, the data sent, the
 * decision it informs, its human checkpoint and an owner; a tenant enables a
 * feature only through the register, and only for a compliant, evaluated
 * provider. OpenAI is the provider for every function (ADR-0043, decided
 * 2026-10-15); the fake provider is a test double only.
 */
import type { AiProvider, Compliance, ProviderInfo } from './types.ts';
import { OPENAI_COMPLIANCE, OPENAI_DEFAULT_MODELS } from './providers/openai.ts';

/**
 * The providers this process can call. Empty until the service registers one: OpenAI when
 * `OPENAI_API_KEY` is set (ADR-0043). Running systems never register the fake provider; tests
 * register it as their test double.
 */
export const providers: Record<string, AiProvider> = {};

export function registerProvider(provider: AiProvider): void {
  providers[provider.info.provider] = provider;
}

export function unregisterProvider(name: string): void {
  delete providers[name];
}

export function providerByName(name: string): AiProvider | undefined {
  return providers[name];
}

/** The provider a tenant is configured for (`ai.provider`, OpenAI by default), or null: AI off. */
export const DEFAULT_PROVIDER = 'openai';

export type ProviderNeed = 'llm' | 'stt' | 'translation' | 'image' | 'classifier';

/** What the register records about a provider, whether or not this process can call it. */
export interface ProviderDescriptor {
  info: ProviderInfo;
  compliance: Compliance;
  languages: readonly string[];
  supports: readonly ProviderNeed[];
}

export function describeProvider(p: AiProvider): ProviderDescriptor {
  const all: ProviderNeed[] = ['llm', 'stt', 'translation', 'image', 'classifier'];
  return {
    info: p.info,
    compliance: p.compliance,
    languages: p.languages,
    supports: all.filter((n) => Boolean(p[n])),
  };
}

/** OpenAI as the register lists it, even before a key is set (it then stays off). */
export function openAIDescriptor(
  models: Partial<typeof OPENAI_DEFAULT_MODELS> = {},
): ProviderDescriptor {
  return {
    info: { provider: 'openai', model: models.text ?? OPENAI_DEFAULT_MODELS.text },
    compliance: OPENAI_COMPLIANCE,
    languages: ['en', 'es'],
    supports: ['llm', 'stt', 'translation', 'image', 'classifier'],
  };
}

export function isCompliant(c: Compliance): boolean {
  return c.usRegion && c.zeroRetention && c.noTraining;
}

export interface EvaluationSummary {
  /** Per language: candidate accuracy on the labelled set. */
  accuracy: Record<string, number>;
  /** Share of injection cases that produced no candidates and were flagged. */
  injectionResistance: number;
  passed: boolean;
}

/** AIG-06 and AIG-08 together: the only way a feature turns on for a tenant. */
export function canEnable(
  provider: Pick<ProviderDescriptor, 'compliance' | 'languages'>,
  tenantLanguages: readonly string[],
  evaluation: EvaluationSummary | null,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!isCompliant(provider.compliance)) reasons.push('provider_not_compliant');
  for (const lang of tenantLanguages) {
    if (!provider.languages.includes(lang)) reasons.push(`language_not_supported:${lang}`);
    else if (!evaluation || evaluation.accuracy[lang] === undefined)
      reasons.push(`not_evaluated:${lang}`);
  }
  if (evaluation && !evaluation.passed) reasons.push('evaluation_failed');
  return { ok: reasons.length === 0, reasons };
}

export interface RegisterEntry {
  feature: string;
  dataSent: string;
  decisionInformed: string;
  humanCheckpoint: string;
  owner: string;
  /** Interface the feature needs on the provider. */
  needs: ProviderNeed;
  /** Shipped switched off regardless of provider (PHO-12, Q-01). */
  lockedOff?: boolean;
}

/** The product's AI features (AIG-01). The severity suggestion stays off until a validated classifier exists (PHO-12). */
export const AI_FEATURES: readonly RegisterEntry[] = [
  {
    feature: 'intake.extraction',
    needs: 'llm',
    dataSent:
      'Resident free text, redacted of phone numbers, emails, street addresses and identifiers; the question list',
    decisionInformed:
      'Pre-fills candidate answers that the resident confirms or edits; nothing is saved unconfirmed',
    humanCheckpoint: 'Resident one-tap confirm (INT-13); reviewer sees the original words',
    owner: 'Product owner (intake)',
  },
  {
    feature: 'intake.transcription',
    needs: 'stt',
    dataSent: 'Dictated audio from the resident, in the original language',
    decisionInformed: 'Text shown back for the resident to edit before anything is extracted',
    humanCheckpoint: 'Resident edits the transcript',
    owner: 'Product owner (intake)',
  },
  {
    feature: 'review.translation',
    needs: 'translation',
    dataSent: 'Resident free text in the original language',
    decisionInformed:
      'A labelled machine translation beside the original for reviewers; eligibility is never decided on it (EQ-08)',
    humanCheckpoint: 'Reviewer reads the original; certified translation on request',
    owner: 'Equity lead',
  },
  {
    feature: 'field.voice_draft',
    needs: 'llm',
    dataSent:
      'What a field volunteer said or typed about a property, redacted of phone numbers, emails, street addresses and identifiers',
    decisionInformed:
      'Drafts the home type and the damage seen on a field assessment (FLD-09); never the degree of damage, which the volunteer picks from pictures (FLD-08)',
    humanCheckpoint: 'The volunteer confirms or rejects each drafted field one by one (INT-13)',
    owner: 'Damage assessment lead',
  },
  {
    feature: 'photo.quality',
    needs: 'image',
    dataSent: 'A resident photo',
    decisionInformed: 'One plain retake suggestion (PHO-03)',
    humanCheckpoint: 'Resident decides whether to retake',
    owner: 'Product owner (intake)',
  },
  {
    feature: 'photo.sensitive_regions',
    needs: 'image',
    dataSent: 'A resident photo',
    decisionInformed:
      'Which regions to blur in derivatives shown outside the reviewer role (PHO-07)',
    humanCheckpoint: 'Reviewer can open the restricted original',
    owner: 'Security lead',
  },
  {
    feature: 'photo.severity',
    needs: 'image',
    dataSent: 'A resident photo and its hazard',
    decisionInformed:
      'A suggested FEMA degree of damage shown only to reviewers, labelled as a suggestion (PHO-09/10)',
    humanCheckpoint: 'A credentialed reviewer sets the degree (PHO-11)',
    owner: 'Damage assessment lead',
    lockedOff: true,
  },
];
