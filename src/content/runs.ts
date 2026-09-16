import type { Request } from 'express';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { type Clock, createLimits, MAX_PROVIDER_REQUESTS, systemClock } from '../llm/execution.ts';
import type { Logger } from '../logger.ts';
import {
  CONSTRAINTS_VERSION,
  PersistError,
  type PersistedRun,
  type RunPhase,
  type RunStatus,
  WORKFLOW_VERSION,
  type WorkflowStore,
} from '../persist/store.ts';
import {
  EXERCISES_PROMPT_VERSION,
  REVISION_PROMPT_VERSION,
  VOCABULARY_PROMPT_VERSION,
} from './generate.ts';
import { AGE_PROMPT_VERSION, LANGUAGE_PROMPT_VERSION } from './review.ts';
import { type ContentRequest, contentRequestSchema, type GeneratedProposal } from './schemas.ts';
import {
  type GenerationState,
  MAX_REVISIONS,
  runContentWorkflow,
  withLocalIds,
} from './workflow.ts';

export const PROMPT_VERSIONS = {
  vocabulary: VOCABULARY_PROMPT_VERSION,
  exercises: EXERCISES_PROMPT_VERSION,
  revision: REVISION_PROMPT_VERSION,
  age: AGE_PROMPT_VERSION,
  language: LANGUAGE_PROMPT_VERSION,
};

export type WorkflowResource = {
  id: string;
  status: RunStatus;
  phase: RunPhase;
  stateVersion: number;
  ownerId: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: string;
  workflowVersion: string;
  constraintsVersion: string;
  promptVersions: Record<string, string>;
  modelTag: string | null;
  modelDigest: string | null;
  limits: PersistedRun['limits'];
  consumed: PersistedRun['consumed'];
  request: unknown;
  result: {
    status: RunStatus;
    candidateVersion: number;
    revisionCount: number;
    providerRequests: number;
    requiresHumanApproval: boolean;
    checks: unknown;
    proposals: ReturnType<typeof withLocalIds>;
    vocabulary: unknown;
    error: { code: string; message: string } | null;
  };
  candidates: Array<{
    candidateVersion: number;
    proposals: unknown;
    checks: unknown;
    createdAt: number;
  }>;
};

export function actorIdFrom(req: Request) {
  return requiredHeader(req, 'x-actor-id', 'An actor id is required.');
}

export function idempotencyKeyFrom(req: Request) {
  return requiredHeader(req, 'idempotency-key', 'An idempotency key is required.');
}

export async function createContentGeneration(options: {
  store: WorkflowStore;
  config: Config;
  logger: Logger;
  requestId: string;
  ownerId: string;
  idempotencyKey: string;
  body: unknown;
  clock?: Clock;
  maxProviderRequests?: number;
  signal?: AbortSignal;
}): Promise<{ created: boolean; resource: WorkflowResource }> {
  const parsed = contentRequestSchema.safeParse(options.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid content request.');
  }
  const opened = openPersistedRun(options, parsed.data);
  if (!opened.created) {
    return { created: false, resource: presentRun(options.store, opened.run, options.ownerId) };
  }
  await executePersistedRun(options, opened.run, parsed.data);
  const latest = options.store.getRun(opened.run.id);
  if (!latest) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  return { created: true, resource: presentRun(options.store, latest, options.ownerId) };
}

export function getContentGeneration(store: WorkflowStore, id: string, actorId: string) {
  const run = store.getRun(id);
  if (!run) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  return presentRun(store, run, actorId);
}

export function presentRun(
  store: WorkflowStore,
  run: PersistedRun,
  actorId: string,
): WorkflowResource {
  if (run.ownerId !== actorId) {
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }
  const state = asState(run.state);
  const proposals = Array.isArray(state.candidate)
    ? withLocalIds(state.candidate as GeneratedProposal[])
    : [];
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    stateVersion: run.stateVersion,
    ownerId: run.ownerId,
    idempotencyKey: run.idempotencyKey,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    schemaVersion: run.schemaVersion,
    workflowVersion: run.workflowVersion,
    constraintsVersion: run.constraintsVersion,
    promptVersions: run.promptVersions,
    modelTag: run.modelTag,
    modelDigest: run.modelDigest,
    limits: run.limits,
    consumed: run.consumed,
    request: run.normalizedInput,
    result: {
      status: run.status,
      candidateVersion: asCount(state.candidateVersion),
      revisionCount: asCount(state.revisionCount),
      providerRequests: run.consumed.providerRequests,
      requiresHumanApproval: run.status === 'AWAITING_APPROVAL',
      checks: Array.isArray(state.checks) ? state.checks : [],
      proposals,
      vocabulary: state.vocabulary ?? null,
      error: errorOf(state.error),
    },
    candidates: store.listCandidates(run.id).map((row) => ({
      candidateVersion: row.candidateVersion,
      proposals: row.proposals,
      checks: row.checks,
      createdAt: row.createdAt,
    })),
  };
}

function openPersistedRun(
  options: Parameters<typeof createContentGeneration>[0],
  request: ContentRequest,
) {
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const execution = createLimits(
    options.config,
    now,
    options.maxProviderRequests ?? MAX_PROVIDER_REQUESTS,
  );
  try {
    return options.store.openRun({
      ownerId: options.ownerId,
      idempotencyKey: options.idempotencyKey,
      normalizedInput: request,
      workflowVersion: WORKFLOW_VERSION,
      constraintsVersion: CONSTRAINTS_VERSION,
      promptVersions: PROMPT_VERSIONS,
      modelTag: options.config.ollamaModel,
      limits: {
        maxProviderRequests: execution.maxProviderRequests,
        maxRevisions: MAX_REVISIONS,
        workflowTimeoutMs: options.config.workflowTimeoutMs,
        attemptTimeoutMs: options.config.llmAttemptTimeoutMs,
        deadlineAt: execution.deadlineAt,
        ollamaNumCtx: options.config.ollamaNumCtx,
        ollamaNumPredict: options.config.ollamaNumPredict,
      },
      now,
    });
  } catch (err) {
    if (err instanceof PersistError && err.code === 'CONFLICT') {
      const existing = options.store.getRunByIdempotency(options.ownerId, options.idempotencyKey);
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key was reused with a different request.',
        { workflowId: existing?.id },
      );
    }
    throw sqliteUnavailable(err);
  }
}

async function executePersistedRun(
  options: Parameters<typeof createContentGeneration>[0],
  run: PersistedRun,
  request: ContentRequest,
) {
  const clock = options.clock ?? systemClock;
  const saved = new Set<number>();
  let current = run;
  const write = (input: {
    status: PersistedRun['status'];
    phase: RunPhase;
    state: unknown;
    consumed: PersistedRun['consumed'];
    modelTag?: string | null;
    modelDigest?: string | null;
    candidate?: {
      candidateVersion: number;
      proposals: unknown;
      checks: unknown;
      createdAt: number;
    };
  }) => {
    try {
      current = options.store.saveCheckpoint({
        runId: current.id,
        expectedStateVersion: current.stateVersion,
        now: clock.now(),
        modelTag: input.modelTag ?? options.config.ollamaModel,
        modelDigest: input.modelDigest,
        status: input.status,
        phase: input.phase,
        state: input.state,
        consumed: input.consumed,
        candidate: input.candidate,
      });
      if (input.candidate) saved.add(input.candidate.candidateVersion);
    } catch (err) {
      throw sqliteUnavailable(err);
    }
  };
  write({
    status: 'RUNNING',
    phase: 'vocabulary',
    consumed: current.consumed,
    state: {},
  });
  const state = await runContentWorkflow({
    config: options.config,
    logger: options.logger,
    requestId: options.requestId,
    request,
    clock,
    maxProviderRequests: options.maxProviderRequests,
    signal: options.signal,
    onCheckpoint: (next) => {
      write({
        status: 'RUNNING',
        phase: runningPhase(next.phase),
        consumed: consumedOf(next),
        state: snapshot(next),
        modelTag: next.modelTag,
        modelDigest: next.modelDigest,
        candidate: candidateRow(next, saved, clock.now()),
      });
    },
  });
  write({
    status: state.status === 'READY_FOR_REVIEW' ? 'AWAITING_APPROVAL' : 'FAILED',
    phase: 'finished',
    consumed: consumedOf(state),
    state: snapshot(state),
    modelTag: state.modelTag,
    modelDigest: state.modelDigest,
    candidate: candidateRow(state, saved, clock.now()),
  });
}

function snapshot(state: GenerationState) {
  return {
    request: state.request,
    phase: state.phase,
    status: state.status,
    candidateVersion: state.candidateVersion,
    revisionCount: state.revisionCount,
    constraintsVersion: state.constraintsVersion ?? null,
    vocabulary: state.vocabulary ?? null,
    candidate: state.candidate ? withLocalIds(state.candidate) : null,
    checks: state.checks,
    history: state.history,
    usage: state.usage,
    error: state.error ?? null,
    providerRequests: state.providerRequests,
    modelTag: state.modelTag,
    modelDigest: state.modelDigest,
  };
}

function candidateRow(state: GenerationState, saved: Set<number>, createdAt: number) {
  if (!state.candidate || state.candidateVersion < 1 || saved.has(state.candidateVersion)) {
    return undefined;
  }
  return {
    candidateVersion: state.candidateVersion,
    proposals: withLocalIds(state.candidate),
    checks: state.checks,
    createdAt,
  };
}

function consumedOf(state: GenerationState) {
  return { providerRequests: state.providerRequests, revisionCount: state.revisionCount };
}

function runningPhase(phase: GenerationState['phase']): RunPhase {
  return phase === 'finished' ? 'checks' : phase;
}

function asState(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function errorOf(value: unknown): { code: string; message: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const error = value as { code?: unknown; message?: unknown };
  return {
    code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
    message: typeof error.message === 'string' ? error.message : 'Internal server error.',
  };
}

function requiredHeader(req: Request, name: string, message: string) {
  const value = req.get(name)?.trim() ?? '';
  if (!/^\S{1,128}$/.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', message);
  }
  return value;
}

function sqliteUnavailable(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError(503, 'SQLITE_UNAVAILABLE', 'Workflow storage is unavailable.');
}
