/**
 * Question graph schema (INT-01): a versioned, tenant-configurable graph that
 * decides what is asked on every channel. The graph is data (JSON validated by
 * these schemas), never code, so a county can change questions, add a
 * language or a hazard preset without a release (SCL-07, EQ-06).
 *
 * Design rules carried by the schema:
 *  - one question per node (INT-02); grouped fields only inside the
 *    `address` and `contact` answer types;
 *  - branching by relationship, hazard and earlier answers (INT-03);
 *  - every closed question can take "I don't know"; only `required` questions
 *    refuse "skip", and even they accept "I don't know" (INT-05);
 *  - each question carries one example and one reason (INT-10);
 *  - FEMA/PDA mapping lives on the question (`fema`, docs/05);
 *  - classification per question drives encryption and audit (SEC-10/11).
 */
import { z } from 'zod';

/** English is required; other languages are added as keys (EQ-06). */
export const localizedTextSchema = z
  .record(z.string(), z.string().min(1))
  .refine((t) => typeof t['en'] === 'string' && t['en'].length > 0, 'en required');
export type LocalizedText = Record<string, string>;

export const hazardSchema = z.enum(['tornado', 'wind', 'flood', 'fire', 'winter_storm', 'other']);
export type Hazard = z.infer<typeof hazardSchema>;

export const relationshipSchema = z.enum(['own_home', 'helper', 'witness', 'organization']);
export type Relationship = z.infer<typeof relationshipSchema>;

export const channelSchema = z.enum(['web', 'sms', 'voice', 'assisted']);
export type Channel = z.infer<typeof channelSchema>;

export const sectionIdSchema = z.enum([
  'safety',
  'who',
  'home',
  'event',
  'photos',
  'needs',
  'contact',
  'after',
]);
export type SectionId = z.infer<typeof sectionIdSchema>;

export const answerTypeSchema = z.enum([
  'single',
  'multi',
  'yesno',
  'text',
  'number',
  'address',
  'contact',
]);
export type AnswerType = z.infer<typeof answerTypeSchema>;

export const classificationSchema = z.enum(['public', 'internal', 'sensitive', 'restricted']);

export const needSignalKindSchema = z.enum(['unsafe', 'displaced', 'no_shelter', 'medical']);
export type NeedSignalKind = z.infer<typeof needSignalKindSchema>;

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const conditionSchema = z.object({
  q: z.string().min(1),
  op: z.enum(['eq', 'neq', 'in', 'includes', 'answered', 'unknown']),
  value: z.union([scalar, z.array(z.string())]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

export const optionSchema = z.object({
  value: z.string().min(1),
  label: localizedTextSchema,
  hint: localizedTextSchema.optional(),
  /** Icon key for picture choices (INT-11); the apps map keys to illustrations. */
  picture: z.string().optional(),
  /** Value written into the FEMA mapping for this choice (docs/05). */
  femaValue: z.string().optional(),
});
export type Option = z.infer<typeof optionSchema>;

const askWhen = {
  /** Only these relationships see the node (WIT-01, HLP-01, ORG-01). Default: all. */
  relationships: z.array(relationshipSchema).optional(),
  /** Only these channels show the node. Default: all. */
  channels: z.array(channelSchema).optional(),
  /** Asked when the event or the cause answer carries one of these hazards. */
  hazards: z.array(hazardSchema).optional(),
  /** Every condition must hold on earlier answers. */
  showIf: z.array(conditionSchema).optional(),
};

export const questionNodeSchema = z.object({
  kind: z.literal('question'),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  section: sectionIdSchema,
  prompt: localizedTextSchema,
  /** Prompt wording for a relationship when it differs ("What did you see?"). */
  promptFor: z.partialRecord(relationshipSchema, localizedTextSchema).optional(),
  why: localizedTextSchema,
  example: localizedTextSchema,
  answerType: answerTypeSchema,
  options: z.array(optionSchema).optional(),
  /** Required means skip is refused; "I don't know" still counts as an answer (INT-05). */
  required: z.boolean().default(false),
  allowUnknown: z.boolean().default(true),
  picture: z.boolean().default(false),
  multiline: z.boolean().default(false),
  min: z.number().optional(),
  max: z.number().optional(),
  fema: z.string().optional(),
  classification: classificationSchema.default('internal'),
  /** Values of this question that raise a need signal for queue ordering (PHO-14). */
  needSignal: z.object({ when: z.array(z.string()), signal: needSignalKindSchema }).optional(),
  ...askWhen,
});
export type QuestionNode = z.infer<typeof questionNodeSchema>;

export const infoNodeSchema = z.object({
  kind: z.literal('info'),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  section: sectionIdSchema,
  title: localizedTextSchema,
  body: localizedTextSchema,
  /** Tenant configuration may replace the body (locally approved text, ACC-48). */
  tenantKey: z.string().optional(),
  ...askWhen,
});
export type InfoNode = z.infer<typeof infoNodeSchema>;

export const stepNodeSchema = z.object({
  kind: z.enum(['free_text', 'photos', 'needs', 'consent', 'review']),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  section: sectionIdSchema,
  title: localizedTextSchema,
  body: localizedTextSchema.optional(),
  ...askWhen,
});
export type StepNode = z.infer<typeof stepNodeSchema>;

export const nodeSchema = z.discriminatedUnion('kind', [
  questionNodeSchema,
  infoNodeSchema,
  stepNodeSchema,
]);
export type GraphNode = z.infer<typeof nodeSchema>;

export const shotSchema = z.object({
  id: z.string().min(1),
  title: localizedTextSchema,
  example: localizedTextSchema,
  hazards: z.array(hazardSchema).optional(),
  optional: z.boolean().default(false),
});
export type Shot = z.infer<typeof shotSchema>;

export const needCategorySchema = z.object({
  value: z.string().min(1),
  label: localizedTextSchema,
  icon: z.string().min(1),
  signal: needSignalKindSchema.optional(),
});

export const consentOrgTypeSchema = z.object({
  value: z.string().min(1),
  label: localizedTextSchema,
  description: localizedTextSchema,
  /** Faith-based partners are opt-in per tenant (EQ-05). */
  optIn: z.boolean().default(false),
});

export const questionGraphSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().positive(),
  title: localizedTextSchema,
  languages: z
    .array(z.string().min(2))
    .min(1)
    .refine((l: string[]) => l.includes('en'), 'en required'),
  hazards: z.array(hazardSchema).min(1),
  sections: z.array(z.object({ id: sectionIdSchema, title: localizedTextSchema })).min(1),
  nodes: z.array(nodeSchema).min(1),
  afterSubmission: z.array(questionNodeSchema).default([]),
  shots: z.array(shotSchema).min(1),
  needCategories: z.array(needCategorySchema).min(1),
  consentOrgTypes: z.array(consentOrgTypeSchema).min(1),
  /** Default local emergency instructions; tenants override (ACC-48, CON-10). */
  emergencyInstructions: localizedTextSchema,
  /** Safety line shown with every photo request (PHO-02). */
  photoSafetyLine: localizedTextSchema,
});
export type QuestionGraph = z.infer<typeof questionGraphSchema>;

/** Parses and cross-checks a graph: unique ids, conditions and signals point at real questions. */
export function parseGraph(input: unknown): QuestionGraph {
  const graph = questionGraphSchema.parse(input);
  const ids = new Set<string>();
  const questions = new Map<string, QuestionNode>();
  for (const node of [...graph.nodes, ...graph.afterSubmission]) {
    if (ids.has(node.id)) throw new Error(`duplicate node id ${node.id}`);
    ids.add(node.id);
    if (node.kind === 'question') questions.set(node.id, node);
  }
  const sections = new Set(graph.sections.map((s) => s.id));
  for (const node of [...graph.nodes, ...graph.afterSubmission]) {
    if (!sections.has(node.section)) throw new Error(`node ${node.id}: unknown section`);
    for (const c of node.showIf ?? []) {
      if (!questions.has(c.q))
        throw new Error(`node ${node.id}: condition on unknown question ${c.q}`);
    }
    if (node.kind === 'question') {
      const closed = node.answerType === 'single' || node.answerType === 'multi';
      if (closed && !(node.options && node.options.length > 0)) {
        throw new Error(`question ${node.id}: closed question without options`);
      }
      if (node.needSignal && !closed && node.answerType !== 'yesno') {
        throw new Error(`question ${node.id}: need signal needs a closed answer`);
      }
      for (const lang of graph.languages) {
        for (const [field, text] of Object.entries({
          prompt: node.prompt,
          why: node.why,
          example: node.example,
        })) {
          if (!text[lang]) throw new Error(`question ${node.id}: ${field} missing ${lang}`);
        }
        for (const o of node.options ?? []) {
          if (!o.label[lang])
            throw new Error(`question ${node.id}: option ${o.value} missing ${lang}`);
        }
      }
    }
  }
  return graph;
}
