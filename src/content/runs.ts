import type { Request } from 'express';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { type Clock, createLimits, MAX_PROVIDER_REQUESTS, systemClock } from '../llm/execution.ts';
import { ollamaModelInfo } from '../llm/ollama.ts';
import type { Logger } from '../logger.ts';
import {
  CONSTRAINTS_VERSION,
  PersistError,
  type PersistedRun,
  type RunPhase,
  type RunStatus,
  SCHEMA_VERSION,
  WORKFLOW_VERSION,
  type WorkflowStore,
} from '../persist/store.ts';
import {
  EXERCISES_PROMPT_VERSION,
  REVISION_PROMPT_VERSION,
  VOCABULARY_PROMPT_VERSION,
} from './generate.ts';
import { AGE_PROMPT_VERSION, LANGUAGE_PROMPT_VERSION } from './review.ts';
import {
  type CheckResult,
  type ContentRequest,
  contentRequestSchema,
  type GeneratedProposal,
} from './schemas.ts';
import {
  type GenerationState,
  MAX_REVISIONS,
  runContentWorkflow,
  withLocalIds,
} from './workflow.ts';

export const RUN_LEASE_MS = 30_000;
const RUN_HEARTBEAT_MS = RUN_LEASE_MS / 3;

type ExecutionOptions = Omit<
  Parameters<typeof createContentGeneration>[0],
  'idempotencyKey' | 'body'
>;

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
  resumable: boolean;
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
    error: { code: string; message: string; retryable: boolean } | null;
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
    return {
      created: false,
      resource: presentRun(
        options.store,
        opened.run,
        options.ownerId,
        (options.clock ?? systemClock).now(),
      ),
    };
  }
  await executePersistedRun(options, opened.run, parsed.data);
  const latest = options.store.getRun(opened.run.id);
  if (!latest) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  return {
    created: true,
    resource: presentRun(
      options.store,
      latest,
      options.ownerId,
      (options.clock ?? systemClock).now(),
    ),
  };
}

export async function resumeContentGeneration(options: ExecutionOptions & { id: string }) {
  const clock = options.clock ?? systemClock;
  const run = options.store.getRun(options.id);
  if (!run || run.ownerId !== options.ownerId) {
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }
  if (!isResumable(run, clock.now())) {
    throw new AppError(409, 'RUN_NOT_RESUMABLE', 'The workflow is not interrupted or retryable.');
  }
  await assertRecoveryCompatible(options.config, options.signal, run);
  const claimToken = options.store.claimRun({
    runId: run.id,
    owner: options.requestId,
    now: clock.now(),
    leaseMs: RUN_LEASE_MS,
  });
  if (!claimToken) {
    throw new AppError(409, 'RUN_ALREADY_CLAIMED', 'The workflow is already being resumed.');
  }
  const request = contentRequestSchema.safeParse(run.normalizedInput);
  if (!request.success) {
    throw new AppError(
      409,
      'WORKFLOW_INPUT_UNSUPPORTED',
      'The recorded workflow input is invalid.',
    );
  }
  await executePersistedRun(options, run, request.data, claimToken);
  const latest = options.store.getRun(run.id);
  if (!latest) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  return presentRun(options.store, latest, options.ownerId, clock.now());
}

export function getContentGeneration(
  store: WorkflowStore,
  id: string,
  actorId: string,
  now = Date.now(),
) {
  const run = store.getRun(id);
  if (!run) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  return presentRun(store, run, actorId, now);
}

export function presentRun(
  store: WorkflowStore,
  run: PersistedRun,
  actorId: string,
  now = Date.now(),
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
    resumable: isResumable(run, now),
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
  options: ExecutionOptions,
  run: PersistedRun,
  request: ContentRequest,
  claimedToken?: string,
) {
  const clock = options.clock ?? systemClock;
  const fresh = run.status === 'PENDING';
  const claimToken =
    claimedToken ??
    options.store.claimRun({
      runId: run.id,
      owner: options.requestId,
      now: clock.now(),
      leaseMs: RUN_LEASE_MS,
    });
  if (!claimToken) {
    throw new AppError(409, 'RUN_ALREADY_CLAIMED', 'The workflow is already being executed.');
  }
  const previousCandidates = options.store.listCandidates(run.id);
  const saved = new Set(previousCandidates.map((item) => item.candidateVersion));
  const loaded = options.store.getRun(run.id);
  if (!loaded) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  let current = loaded;
  const leaseLost = new AbortController();
  let lost = false;
  const heartbeat = setInterval(() => {
    try {
      if (
        !options.store.heartbeatRun({
          runId: run.id,
          owner: options.requestId,
          claimToken,
          now: clock.now(),
          leaseMs: RUN_LEASE_MS,
        })
      ) {
        lost = true;
        leaseLost.abort(claimLostError());
      }
    } catch {
      lost = true;
      leaseLost.abort(claimLostError());
    }
  }, RUN_HEARTBEAT_MS);
  heartbeat.unref();
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
        claimToken,
        candidate: input.candidate,
      });
      if (input.candidate) saved.add(input.candidate.candidateVersion);
    } catch (err) {
      throw checkpointError(err);
    }
  };
  try {
    if (fresh) {
      write({
        status: 'RUNNING',
        phase: 'vocabulary',
        consumed: current.consumed,
        state: {},
      });
    }
    const state = await runContentWorkflow({
      config: options.config,
      logger: options.logger,
      requestId: options.requestId,
      request,
      clock,
      maxProviderRequests: current.limits.maxProviderRequests,
      maxRevisions: current.limits.maxRevisions,
      signal: AbortSignal.any(
        [options.signal, leaseLost.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        ),
      ),
      resume: fresh
        ? undefined
        : {
            checkpoint: current.state,
            deadlineAt: current.limits.deadlineAt,
            attemptTimeoutMs: current.limits.attemptTimeoutMs,
            maxProviderRequests: current.limits.maxProviderRequests,
            maxRevisions: current.limits.maxRevisions,
            ollamaNumCtx: current.limits.ollamaNumCtx,
            ollamaNumPredict: current.limits.ollamaNumPredict,
            providerRequests: current.consumed.providerRequests,
            revisionCount: current.consumed.revisionCount,
            constraintsVersion: current.constraintsVersion,
            modelTag: current.modelTag,
            modelDigest: current.modelDigest,
            invalidCandidates: previousCandidates.map((item) => ({
              proposals: item.proposals as GeneratedProposal[],
              checks: Array.isArray(item.checks) ? (item.checks as CheckResult[]) : [],
            })),
          },
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
    if (lost) throw claimLostError();
    write({
      status: state.status === 'READY_FOR_REVIEW' ? 'AWAITING_APPROVAL' : 'FAILED',
      phase: 'finished',
      consumed: consumedOf(state),
      state: snapshot(state),
      modelTag: state.modelTag,
      modelDigest: state.modelDigest,
      candidate: candidateRow(state, saved, clock.now()),
    });
  } finally {
    clearInterval(heartbeat);
  }
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

function errorOf(value: unknown): { code: string; message: string; retryable: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const error = value as { code?: unknown; message?: unknown; retryable?: unknown };
  return {
    code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
    message: typeof error.message === 'string' ? error.message : 'Internal server error.',
    retryable: error.retryable === true,
  };
}

function isResumable(run: PersistedRun, now: number) {
  if (run.status === 'PENDING') return true;
  if (run.status === 'FAILED') return retryableState(run.state);
  return (
    run.status === 'RUNNING' &&
    run.phase !== 'finished' &&
    (run.leaseExpiresAt === null || run.leaseExpiresAt <= now)
  );
}

function retryableState(value: unknown) {
  const state = asState(value);
  const error = asState(state.error);
  return error.retryable === true;
}

async function assertRecoveryCompatible(
  config: Config,
  signal: AbortSignal | undefined,
  run: PersistedRun,
) {
  if (run.schemaVersion !== SCHEMA_VERSION || run.workflowVersion !== WORKFLOW_VERSION) {
    throw new AppError(
      409,
      'WORKFLOW_VERSION_UNSUPPORTED',
      'The recorded workflow version is not supported.',
    );
  }
  if (!sameVersions(run.promptVersions, PROMPT_VERSIONS)) {
    throw new AppError(
      409,
      'PROMPT_VERSION_UNSUPPORTED',
      'The recorded prompts are not supported.',
    );
  }
  if (run.modelTag !== config.ollamaModel) {
    throw new AppError(409, 'MODEL_TAG_CHANGED', 'The configured model tag changed.');
  }
  const model = await ollamaModelInfo(config, signal);
  if (model.status !== 'ok') {
    throw new AppError(503, 'MODEL_UNAVAILABLE', 'The recorded model is not available.');
  }
  if (!run.modelDigest) {
    if (run.consumed.providerRequests > 0) {
      throw new AppError(409, 'MODEL_DIGEST_UNRECORDED', 'The run has no recorded model digest.');
    }
    return;
  }
  if (!model.digest) {
    throw new AppError(409, 'MODEL_DIGEST_UNAVAILABLE', 'The current model digest is unavailable.');
  }
  if (model.digest !== run.modelDigest) {
    throw new AppError(409, 'MODEL_DIGEST_CHANGED', 'The recorded model digest changed.');
  }
}

function sameVersions(actual: Record<string, string>, expected: Record<string, string>) {
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function requiredHeader(req: Request, name: string, message: string) {
  const value = req.get(name)?.trim() ?? '';
  if (!/^\S{1,128}$/.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', message);
  }
  return value;
}

function claimLostError() {
  return new AppError(409, 'RUN_CLAIM_LOST', 'The workflow lease was lost.');
}

function checkpointError(err: unknown): AppError {
  if (err instanceof PersistError && err.code === 'CONFLICT') return claimLostError();
  return sqliteUnavailable(err);
}

function sqliteUnavailable(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError(503, 'SQLITE_UNAVAILABLE', 'Workflow storage is unavailable.');
}
