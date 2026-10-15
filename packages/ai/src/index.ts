export * from './types.ts';
export { redact, type Redaction } from './redact.ts';
export { filterGeneratedText, type FilterResult } from './filter.ts';
export {
  buildCommandPrompt,
  buildExtractionPrompt,
  RESIDENT_TEXT_OPEN,
  RESIDENT_TEXT_CLOSE,
  STAFF_REQUEST_OPEN,
  STAFF_REQUEST_CLOSE,
} from './prompt.ts';
export {
  extractionOutputSchema,
  extractionQuestions,
  validateExtraction,
  type ValidatedExtraction,
} from './extraction.ts';
export { fakeProvider, FakeLanguageModel } from './providers/fake.ts';
export {
  OpenAIProvider,
  openAIFromEnv,
  AiProviderError,
  OPENAI_DEFAULT_MODELS,
  OPENAI_TEMPLATES,
  OPENAI_COMPLIANCE,
  type OpenAIConfig,
  type OpenAIFunction,
  type AiProviderErrorKind,
} from './providers/openai.ts';
export {
  providers,
  providerByName,
  registerProvider,
  unregisterProvider,
  describeProvider,
  openAIDescriptor,
  DEFAULT_PROVIDER,
  type ProviderDescriptor,
  type ProviderNeed,
  isCompliant,
  canEnable,
  AI_FEATURES,
  type EvaluationSummary,
  type RegisterEntry,
} from './registry.ts';
export {
  evaluateProvider,
  THRESHOLDS,
  type EvaluationReport,
  type CaseResult,
} from './evaluation/harness.ts';
export {
  COMMAND_EVAL_CATALOG,
  commandEvaluationCases,
  evaluationCases,
  type CommandEvalCase,
  type EvalCase,
} from './evaluation/cases.ts';
export {
  callAi,
  recordAiOutput,
  recordHumanAction,
  type AiCall,
  type AiOutcome,
  type AiOutputRecord,
  type HumanAction,
} from './records.ts';
