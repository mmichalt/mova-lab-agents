import { z } from 'zod';
import { completeStructured, GENERATION_TEMPERATURE, type LlmCall } from '../llm/complete.ts';
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_RESULT_LIMIT_DEFAULT,
  SEARCH_RESULT_LIMIT_MAX,
} from '../tools/mova-lab.ts';
import type { ContentRequest } from './schemas.ts';

export const SUPERVISOR_VERSION = 'constrained-supervisor/v1';
export const SUPERVISOR_PROMPT_VERSION = 'supervisor/v1';
export const MAX_SUPERVISOR_DECISIONS = 8;

const noArgs = z.strictObject({});

export const supervisorActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('search'),
    args: z.strictObject({
      q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
      limit: z.int().min(1).max(SEARCH_RESULT_LIMIT_MAX).default(SEARCH_RESULT_LIMIT_DEFAULT),
    }),
  }),
  z.strictObject({ action: z.literal('vocabulary'), args: noArgs }),
  z.strictObject({ action: z.literal('generate'), args: noArgs }),
  z.strictObject({ action: z.literal('revise'), args: noArgs }),
  z.strictObject({ action: z.literal('finish'), args: noArgs }),
]);

export type SupervisorAction = z.infer<typeof supervisorActionSchema>;

export const supervisorStateSchema = z.strictObject({
  mode: z.literal('experimental'),
  version: z.literal(SUPERVISOR_VERSION),
  decisions: z.int().nonnegative().max(MAX_SUPERVISOR_DECISIONS),
  history: z
    .array(
      z.strictObject({
        decision: z.int().positive().max(MAX_SUPERVISOR_DECISIONS),
        action: z.enum(['search', 'vocabulary', 'generate', 'revise', 'finish']),
        args: z.unknown(),
        outcome: z.enum(['completed', 'rejected', 'failed', 'repeated']),
        observation: z.unknown(),
      }),
    )
    .max(MAX_SUPERVISOR_DECISIONS),
});

export type SupervisorState = z.infer<typeof supervisorStateSchema>;
export type SupervisorActionRecord = SupervisorState['history'][number];

export function createSupervisorState(): SupervisorState {
  return { mode: 'experimental', version: SUPERVISOR_VERSION, decisions: 0, history: [] };
}

const supervisorFormat = z.toJSONSchema(supervisorActionSchema);

const SUPERVISOR_SYSTEM = [
  'Choose the next action for a constrained content-generation experiment.',
  'The application, not you, owns validation, authorization, approval, and publication.',
  'You may choose only search, vocabulary, generate, revise, or finish.',
  'Never request approval, publication, reset, bypass, shell, HTTP, or executable code.',
  'Choose finish only when a candidate is ready for the mandatory application checks.',
  'Return exactly the requested structured action.',
].join('\n');

export async function planSupervisorAction(
  options: LlmCall & { request: ContentRequest; context: unknown },
): Promise<SupervisorAction> {
  return completeStructured(supervisorActionSchema, {
    ...options,
    step: 'supervisor',
    promptVersion: SUPERVISOR_PROMPT_VERSION,
    system: SUPERVISOR_SYSTEM,
    user: { request: options.request, ...asRecord(options.context) },
    format: supervisorFormat,
    temperature: GENERATION_TEMPERATURE,
  });
}

export function supervisorActionKey(action: SupervisorAction) {
  return JSON.stringify(action);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
