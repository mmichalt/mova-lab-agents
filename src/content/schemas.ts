import { z } from 'zod';

export const limits = {
  title: 160,
  phrase: 500,
  childHint: 500,
  teacherNote: 1000,
  theme: 120,
  teacherInstructions: 1000,
  vocabWord: 80,
  vocabItemsMax: 24,
  ageMin: 1,
  ageMax: 18,
  exerciseCountDefault: 6,
  exerciseCountMax: 12,
  refusalReason: 1000,
  findingCode: 64,
  findingPath: 160,
  findingMessage: 500,
  findingsMax: 24,
} as const;

export const targetSounds = ['р', 'л'] as const;

const targetSoundSchema = z.enum(targetSounds);
const requestSoundSchema = z.string().trim().toLowerCase().pipe(targetSoundSchema);
const nonempty = (max: number) => z.string().trim().min(1).max(max);
const tokenCount = z.int().nonnegative().nullable();

export const contentRequestSchema = z
  .strictObject({
    ageYears: z.int().min(limits.ageMin).max(limits.ageMax),
    targetSounds: z
      .array(requestSoundSchema)
      .min(1)
      .transform((sounds) => [...new Set(sounds)]),
    difficulty: z.literal('easy'),
    theme: z.string().trim().min(1).max(limits.theme),
    exerciseCount: z.int().min(1).max(limits.exerciseCountMax).default(limits.exerciseCountDefault),
    teacherInstructions: z.string().trim().min(1).max(limits.teacherInstructions).optional(),
  })
  .refine((req) => req.exerciseCount >= req.targetSounds.length, {
    path: ['exerciseCount'],
    error: 'Must be at least the number of requested sounds',
  });

const proposalFields = {
  type: z.literal('recording'),
  title: nonempty(limits.title),
  phrase: nonempty(limits.phrase),
  childHint: nonempty(limits.childHint),
  teacherNote: nonempty(limits.teacherNote),
  targetSound: targetSoundSchema,
  difficulty: z.literal('easy'),
};

const vocabularyItemSchema = z.strictObject({
  word: nonempty(limits.vocabWord),
  targetSound: targetSoundSchema,
});

export const vocabularySchema = z.strictObject({
  items: z.array(vocabularyItemSchema).min(1).max(limits.vocabItemsMax),
});

export const vocabularyOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('selected'),
    items: vocabularySchema.shape.items,
  }),
  z.strictObject({
    status: z.literal('refused'),
    reason: nonempty(limits.refusalReason),
  }),
]);

export const generatedProposalSchema = z.strictObject(proposalFields);

export const recordingProposalSchema = z.strictObject({
  localId: z.string().min(1),
  ...proposalFields,
});

export const modelOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('generated'),
    proposals: z.array(generatedProposalSchema).min(1).max(limits.exerciseCountMax),
  }),
  z.strictObject({
    status: z.literal('refused'),
    reason: nonempty(limits.refusalReason),
  }),
]);

const reviewFinding = <T extends 'error' | 'warning'>(severity: z.ZodType<T>) =>
  z.strictObject({
    code: nonempty(limits.findingCode),
    path: nonempty(limits.findingPath).optional(),
    severity,
    message: nonempty(limits.findingMessage),
  });

export const reviewOutputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('passed'),
    issues: z.array(reviewFinding(z.literal('warning'))).max(limits.findingsMax),
  }),
  z.strictObject({
    status: z.literal('failed'),
    issues: z
      .array(reviewFinding(z.enum(['error', 'warning'])))
      .min(1)
      .max(limits.findingsMax),
  }),
  z.strictObject({
    status: z.literal('refused'),
    reason: nonempty(limits.refusalReason),
  }),
]);

export const validationIssueSchema = z.strictObject({
  source: z.enum(['schema', 'content', 'age', 'language', 'application']),
  code: z.string().min(1),
  path: z.string().min(1).optional(),
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1),
});

const checkNameSchema = z.enum(['content', 'age', 'language']);

export const checkResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('passed'),
    name: checkNameSchema,
    issues: z.array(validationIssueSchema),
  }),
  z.strictObject({
    status: z.literal('failed'),
    name: checkNameSchema,
    issues: z.array(validationIssueSchema).min(1),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    name: checkNameSchema,
    errorCode: z.string().min(1),
  }),
]);

export const llmUsageSchema = z.strictObject({
  model: z.string().min(1),
  inputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  outputTokens: tokenCount,
  estimatedCostUsd: z.number().nonnegative().nullable(),
});

export const generationResultSchema = z
  .strictObject({
    requestId: z.string().min(1),
    status: z.enum(['READY_FOR_REVIEW', 'FAILED']),
    candidateVersion: z.int().positive(),
    revisionCount: z.int().nonnegative().max(2),
    providerRequests: z.int().nonnegative(),
    proposals: z.array(recordingProposalSchema).min(1).max(limits.exerciseCountMax),
    checks: z.array(checkResultSchema).min(1),
    requiresHumanApproval: z.boolean(),
  })
  .refine((result) => result.requiresHumanApproval === (result.status === 'READY_FOR_REVIEW'), {
    path: ['requiresHumanApproval'],
    error: 'Must match READY_FOR_REVIEW',
  });

export type ContentRequest = z.infer<typeof contentRequestSchema>;
export type VocabularyItem = z.infer<typeof vocabularyItemSchema>;
export type Vocabulary = z.infer<typeof vocabularySchema>;
export type VocabularyOutput = z.infer<typeof vocabularyOutputSchema>;
export type GeneratedProposal = z.infer<typeof generatedProposalSchema>;
export type RecordingProposal = z.infer<typeof recordingProposalSchema>;
export type ModelOutput = z.infer<typeof modelOutputSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type LlmUsage = z.infer<typeof llmUsageSchema>;
export type GenerationResult = z.infer<typeof generationResultSchema>;
