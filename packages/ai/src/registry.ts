/**
 * Provider registry and the AI use register (AIG-01, AIG-06, AIG-08, AIG-12).
 * The register lists every AI feature with its provider, the data sent, the
 * decision it informs, its human checkpoint and an owner; a tenant enables a
 * feature only through the register, and only for a compliant, evaluated
 * provider. Layer 2 ships the fake provider; real providers are added here
 * when Adam approves them (paid services).
 */
import type { AiProvider, Compliance } from './types.ts';
import { fakeProvider } from './providers/fake.ts';

export const providers: Record<string, AiProvider> = { fake: fakeProvider };

export function providerByName(name: string): AiProvider | undefined {
  return providers[name];
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
  provider: AiProvider,
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
  needs: 'llm' | 'stt' | 'translation' | 'image';
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
