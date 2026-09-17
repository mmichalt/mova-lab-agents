import type { Request } from 'express';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import {
  type AttemptRecorder,
  type Clock,
  createLimits,
  MAX_PROVIDER_REQUESTS,
  systemClock,
} from '../llm/execution.ts';
import { ollamaModelInfo } from '../llm/ollama.ts';
import type { Logger } from '../logger.ts';
import {
  type ApprovalRecord,
  CONSTRAINTS_VERSION,
  hashNormalizedInput,
  type ImportReceiptRecord,
  PersistError,
  type PersistedRun,
  type RunPhase,
  type RunStatus,
  SCHEMA_VERSION,
  WORKFLOW_VERSION,
  type WorkflowStore,
} from '../persist/store.ts';
import { importRecordingDraft, listGenerationCategories } from '../tools/mova-lab.ts';
import {
  EXERCISES_PROMPT_VERSION,
  REVISION_PROMPT_VERSION,
  VOCABULARY_PROMPT_VERSION,
} from './generate.ts';
import { AGE_PROMPT_VERSION, LANGUAGE_PROMPT_VERSION } from './review.ts';
import {
  type CheckResult,
  type ContentRequest,
  checkResultSchema,
  contentRequestSchema,
  type GeneratedProposal,
  recordingProposalSchema,
} from './schemas.ts';
import {
  type GenerationState,
  MAX_REVISIONS,
  runContentWorkflow,
  withLocalIds,
} from './workflow.ts';

export const RUN_LEASE_MS = 30_000;
const RUN_HEARTBEAT_MS = RUN_LEASE_MS / 3;

export type WorkflowAdmission = {
  tryAcquire: () => (() => void) | undefined;
};

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
    checks: CheckResult[];
    proposals: ReturnType<typeof withLocalIds>;
    vocabulary: unknown;
    error: { code: string; message: string; retryable: boolean } | null;
  };
  approval: {
    actorId: string;
    candidateVersion: number;
    categoryId: string | null;
    payloadHash: string;
    decision: 'approved' | 'rejected';
    frozenPayload: unknown;
    decidedAt: number;
  } | null;
  candidates: Array<{
    candidateVersion: number;
    proposals: unknown;
    checks: unknown;
    createdAt: number;
  }>;
  importProgress: {
    status: 'not_started' | 'running' | 'failed' | 'completed';
    total: number;
    imported: number;
    receipts: Array<{
      proposalLocalId: string;
      importKey: string;
      payloadHash: string;
      contentId: string | null;
      status: ImportReceiptRecord['status'];
      createdAt: number;
    }>;
  };
  imports: WorkflowResource['importProgress']['receipts'];
};

const approveRequestSchema = z.strictObject({
  candidateVersion: z.int().positive(),
  categoryId: z.string().trim().min(1).max(128),
});

const rejectRequestSchema = z.strictObject({
  candidateVersion: z.int().positive(),
});

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
  canReview?: boolean;
  admission?: WorkflowAdmission;
}): Promise<{ created: boolean; resource: WorkflowResource }> {
  const parsed = contentRequestSchema.safeParse(options.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid content request.');
  }
  const existing = options.store.getRunByIdempotency(options.ownerId, options.idempotencyKey);
  const release = existing ? undefined : options.admission?.tryAcquire();
  if (options.admission && !existing && !release) {
    const raced = options.store.getRunByIdempotency(options.ownerId, options.idempotencyKey);
    if (raced) {
      return {
        created: false,
        resource: presentRun(
          options.store,
          raced,
          options.ownerId,
          (options.clock ?? systemClock).now(),
        ),
      };
    }
    throw new AppError(429, 'WORKFLOW_CAPACITY_EXCEEDED', 'Workflow capacity is currently full.');
  }
  try {
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
  } finally {
    release?.();
  }
}

export async function resumeContentGeneration(options: ExecutionOptions & { id: string }) {
  const clock = options.clock ?? systemClock;
  const run = options.store.getRun(options.id);
  if (!run || !canAccess(run, options.ownerId, options.canReview)) {
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }
  if (!isResumable(run, clock.now())) {
    throw new AppError(409, 'RUN_NOT_RESUMABLE', 'The workflow is not interrupted or retryable.');
  }
  const importing = isApprovedImport(options.store, run);
  if (importing) {
    if (!options.canReview) {
      throw new AppError(403, 'FORBIDDEN', 'Content Admin authority is required.');
    }
    assertImportRecoveryCompatible(options.store, run);
    await executeApprovedImport(options, run);
  } else {
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
  }
  const latest = options.store.getRun(run.id);
  if (!latest) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  return presentRun(options.store, latest, options.ownerId, clock.now(), options.canReview);
}

export async function approveContentGeneration(
  options: ExecutionOptions & { id: string; body: unknown; signal?: AbortSignal },
) {
  const parsed = approveRequestSchema.safeParse(options.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid approval request.');
  }
  return decideContentGeneration(options, {
    decision: 'approved',
    candidateVersion: parsed.data.candidateVersion,
    categoryId: parsed.data.categoryId,
  });
}

export async function rejectContentGeneration(
  options: ExecutionOptions & { id: string; body: unknown; signal?: AbortSignal },
) {
  const parsed = rejectRequestSchema.safeParse(options.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid rejection request.');
  }
  return decideContentGeneration(options, {
    decision: 'rejected',
    candidateVersion: parsed.data.candidateVersion,
  });
}

export function getContentGeneration(
  store: WorkflowStore,
  id: string,
  actorId: string,
  now = Date.now(),
  canReview = false,
) {
  const run = store.getRun(id);
  if (!run) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  return presentRun(store, run, actorId, now, canReview);
}

export function presentRun(
  store: WorkflowStore,
  run: PersistedRun,
  actorId: string,
  now = Date.now(),
  canReview = false,
): WorkflowResource {
  if (!canAccess(run, actorId, canReview)) {
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }
  const state = asState(run.state);
  const approval = store.getApproval(run.id);
  const receipts = store.listImportReceipts(run.id);
  const proposals = Array.isArray(state.candidate)
    ? withLocalIds(state.candidate as GeneratedProposal[])
    : [];
  const checks = z.array(checkResultSchema).safeParse(state.checks).data ?? [];
  const importProgress = importProgressOf(run, approval, receipts);
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
      checks,
      proposals,
      vocabulary: state.vocabulary ?? null,
      error: errorOf(state.error),
    },
    approval: approvalOf(store.getApproval(run.id)),
    candidates: store.listCandidates(run.id).map((row) => ({
      candidateVersion: row.candidateVersion,
      proposals: row.proposals,
      checks: row.checks,
      createdAt: row.createdAt,
    })),
    importProgress,
    imports: importProgress.receipts,
  };
}

async function decideContentGeneration(
  options: ExecutionOptions & { id: string; body: unknown; signal?: AbortSignal },
  decision:
    | { decision: 'approved'; candidateVersion: number; categoryId: string }
    | { decision: 'rejected'; candidateVersion: number },
) {
  const clock = options.clock ?? systemClock;
  const run = options.store.getRun(options.id);
  if (!run || !canAccess(run, options.ownerId, options.canReview)) {
    throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }
  if (!options.canReview) {
    throw new AppError(403, 'FORBIDDEN', 'Content Admin authority is required.');
  }

  const candidate = approvalCandidate(options.store, run, decision.candidateVersion);
  const frozenPayload = {
    candidateVersion: decision.candidateVersion,
    categoryId: decision.decision === 'approved' ? decision.categoryId : null,
    proposals: candidate,
  };
  const payloadHash = hashNormalizedInput(frozenPayload);
  const existing = options.store.getApproval(run.id);
  if (existing) {
    if (sameDecision(existing, decision, payloadHash)) {
      const latest = options.store.getRun(run.id);
      if (!latest) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
      return presentRun(options.store, latest, options.ownerId, clock.now(), options.canReview);
    }
    throw approvalConflict();
  }
  if (run.status !== 'AWAITING_APPROVAL') {
    throw approvalConflict();
  }

  if (decision.decision === 'approved') {
    const categories = await listGenerationCategories({
      config: options.config,
      signal: options.signal ?? new AbortController().signal,
    });
    if (!categories.items.some((category) => category.id === decision.categoryId)) {
      throw new AppError(409, 'CATEGORY_NOT_FOUND', 'The selected category is not available.');
    }
  }

  try {
    options.store.recordApproval({
      runId: run.id,
      actorId: options.ownerId,
      candidateVersion: decision.candidateVersion,
      payloadHash,
      decidedAt: clock.now(),
      expectedStateVersion: run.stateVersion,
      ...(decision.decision === 'approved'
        ? { decision: 'approved' as const, categoryId: decision.categoryId, frozenPayload }
        : { decision: 'rejected' as const }),
    });
  } catch (err) {
    const raced = options.store.getApproval(run.id);
    if (raced && sameDecision(raced, decision, payloadHash)) {
      const latest = options.store.getRun(run.id);
      if (!latest) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
      return presentRun(options.store, latest, options.ownerId, clock.now(), options.canReview);
    }
    if (err instanceof PersistError && err.code === 'CONFLICT') throw approvalConflict();
    throw sqliteUnavailable(err);
  }
  const latest = options.store.getRun(run.id);
  if (!latest) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  if (decision.decision === 'approved') {
    await executeApprovedImport(options, latest);
  }
  const imported = options.store.getRun(run.id);
  if (!imported) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  return presentRun(options.store, imported, options.ownerId, clock.now(), options.canReview);
}

const frozenApprovalSchema = z.strictObject({
  candidateVersion: z.int().positive(),
  categoryId: z.string().trim().min(1).max(128),
  proposals: z.array(recordingProposalSchema).min(1).max(12),
});

type FrozenApproval = z.infer<typeof frozenApprovalSchema>;

async function executeApprovedImport(options: ExecutionOptions, run: PersistedRun) {
  const approval = options.store.getApproval(run.id);
  if (!approval)
    throw new AppError(409, 'APPROVAL_REQUIRED', 'The workflow has no approved payload.');
  const approved = approvedPayload(approval);
  const clock = options.clock ?? systemClock;
  const claimToken = options.store.claimRun({
    runId: run.id,
    owner: options.requestId,
    now: clock.now(),
    leaseMs: RUN_LEASE_MS,
  });
  if (!claimToken) {
    throw new AppError(409, 'RUN_ALREADY_CLAIMED', 'The workflow is already being imported.');
  }
  const current = options.store.getRun(run.id);
  if (!current) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');

  let latest = current;
  let activeReceipt: ImportReceiptRecord | undefined;
  let lost = false;
  const leaseLost = new AbortController();
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
  const signal = AbortSignal.any(
    [options.signal, leaseLost.signal].filter((item): item is AbortSignal => item !== undefined),
  );

  try {
    latest = saveImportCheckpoint(options.store, latest, claimToken, 'RUNNING', null, clock.now());
    for (const proposal of approved.proposals) {
      const importKey = `${run.id}:${proposal.localId}`;
      const existing = options.store
        .listImportReceipts(run.id)
        .find((receipt) => receipt.proposalLocalId === proposal.localId);
      if (
        existing &&
        (existing.importKey !== importKey || existing.payloadHash !== approval.payloadHash)
      ) {
        throw new AppError(409, 'APPROVED_PAYLOAD_CHANGED', 'The approved import payload changed.');
      }
      if (existing?.status === 'imported') {
        if (!existing.contentId)
          throw new AppError(409, 'IMPORT_RECEIPT_INVALID', 'The import receipt is invalid.');
        continue;
      }

      activeReceipt = existing
        ? options.store.updateImportReceipt({
            runId: run.id,
            proposalLocalId: proposal.localId,
            payloadHash: approval.payloadHash,
            contentId: null,
            status: 'pending',
            claimToken,
            now: clock.now(),
          })
        : options.store.saveImportReceipt({
            runId: run.id,
            proposalLocalId: proposal.localId,
            importKey,
            payloadHash: approval.payloadHash,
            contentId: null,
            status: 'pending',
            createdAt: clock.now(),
            claimToken,
            now: clock.now(),
          });
      const imported = await importRecordingDraft({
        config: options.config,
        signal,
        actorId: approval.actorId,
        sourceImportKey: importKey,
        payloadHash: approval.payloadHash,
        categoryId: approved.categoryId,
        proposal,
      });
      if (lost) throw claimLostError();
      options.store.updateImportReceipt({
        runId: run.id,
        proposalLocalId: proposal.localId,
        payloadHash: approval.payloadHash,
        contentId: imported.id,
        status: 'imported',
        claimToken,
        now: clock.now(),
      });
      activeReceipt = undefined;
      latest = saveImportCheckpoint(
        options.store,
        latest,
        claimToken,
        'RUNNING',
        null,
        clock.now(),
      );
    }
    if (lost) throw claimLostError();
    if (
      approved.proposals.some((proposal) => {
        const receipt = options.store
          .listImportReceipts(run.id)
          .find((item) => item.proposalLocalId === proposal.localId);
        return (
          receipt?.status !== 'imported' ||
          receipt.contentId === null ||
          receipt.importKey !== `${run.id}:${proposal.localId}` ||
          receipt.payloadHash !== approval.payloadHash
        );
      })
    ) {
      throw new AppError(409, 'IMPORT_INCOMPLETE', 'The approved import is not fully confirmed.');
    }
    latest = options.store.completeImport({
      runId: latest.id,
      claimToken,
      now: clock.now(),
      consumed: latest.consumed,
      state: {
        ...asState(latest.state),
        status: 'COMPLETED',
        phase: 'finished',
        error: null,
      },
    });
    return latest;
  } catch (err) {
    if (!lost && activeReceipt?.status === 'pending') {
      try {
        options.store.updateImportReceipt({
          runId: run.id,
          proposalLocalId: activeReceipt.proposalLocalId,
          payloadHash: activeReceipt.payloadHash,
          contentId: null,
          status: 'failed',
          claimToken,
          now: clock.now(),
        });
      } catch {
        // The run checkpoint remains the recovery source if this receipt update races a crash.
      }
    }
    if (!(err instanceof AppError) || err.code === 'RUN_CLAIM_LOST') throw err;
    const error = importError(err);
    latest = saveImportCheckpoint(options.store, latest, claimToken, 'FAILED', error, clock.now());
    return latest;
  } finally {
    clearInterval(heartbeat);
  }
}

function saveImportCheckpoint(
  store: WorkflowStore,
  run: PersistedRun,
  claimToken: string,
  status: 'RUNNING' | 'FAILED',
  error: { code: string; message: string; retryable: boolean } | null,
  now: number,
) {
  return store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: run.stateVersion,
    status,
    phase: status === 'FAILED' ? 'finished' : 'import',
    consumed: run.consumed,
    state: {
      ...asState(run.state),
      status,
      phase: status === 'RUNNING' ? 'import' : 'finished',
      error,
    },
    now,
    claimToken,
  });
}

function approvedPayload(approval: ApprovalRecord | undefined): FrozenApproval {
  if (approval?.decision !== 'approved') {
    throw new AppError(409, 'APPROVAL_REQUIRED', 'The workflow has no approved payload.');
  }
  const parsed = frozenApprovalSchema.safeParse(approval.frozenPayload);
  if (
    !parsed.success ||
    parsed.data.candidateVersion !== approval.candidateVersion ||
    parsed.data.categoryId !== approval.categoryId ||
    frozenPayloadHash(parsed.data) !== approval.payloadHash
  ) {
    throw new AppError(409, 'APPROVED_PAYLOAD_CHANGED', 'The approved import payload changed.');
  }
  return parsed.data;
}

function frozenPayloadHash(payload: FrozenApproval) {
  return hashNormalizedInput({
    candidateVersion: payload.candidateVersion,
    categoryId: payload.categoryId,
    proposals: payload.proposals.map(({ localId, ...proposal }) => ({ ...proposal, localId })),
  });
}

function importError(err: AppError) {
  const permanent = new Set(['MOVA_LAB_IMPORT_CONFLICT', 'MOVA_LAB_IMPORT_REJECTED']);
  return {
    code: err.code,
    message: err.message,
    retryable:
      !permanent.has(err.code) &&
      (err.retryable ||
        err.code === 'CLIENT_DISCONNECTED' ||
        err.code === 'MOVA_LAB_FORBIDDEN' ||
        err.status >= 500),
  };
}

function isApprovedImport(store: WorkflowStore, run: PersistedRun) {
  return store.getApproval(run.id)?.decision === 'approved';
}

function canAccess(run: PersistedRun, actorId: string, canReview = false) {
  return run.ownerId === actorId || canReview;
}

function assertImportRecoveryCompatible(store: WorkflowStore, run: PersistedRun) {
  if (run.schemaVersion !== SCHEMA_VERSION || run.workflowVersion !== WORKFLOW_VERSION) {
    throw new AppError(
      409,
      'WORKFLOW_VERSION_UNSUPPORTED',
      'The recorded workflow version is not supported.',
    );
  }
  if (run.constraintsVersion !== CONSTRAINTS_VERSION) {
    throw new AppError(
      409,
      'CONSTRAINTS_VERSION_CHANGED',
      'The recorded generation constraints are no longer available.',
    );
  }
  approvedPayload(store.getApproval(run.id));
}

function importProgressOf(
  run: PersistedRun,
  approval: ApprovalRecord | undefined,
  receipts: ImportReceiptRecord[],
): WorkflowResource['importProgress'] {
  const frozen =
    approval?.decision === 'approved'
      ? frozenApprovalSchema.safeParse(approval.frozenPayload).data
      : undefined;
  const total = frozen?.proposals.length ?? 0;
  return {
    status:
      approval?.decision !== 'approved'
        ? 'not_started'
        : run.status === 'COMPLETED'
          ? 'completed'
          : run.status === 'FAILED'
            ? 'failed'
            : 'running',
    total,
    imported: receipts.filter((receipt) => receipt.status === 'imported').length,
    receipts: receipts.map(
      ({ proposalLocalId, importKey, payloadHash, contentId, status, createdAt }) => ({
        proposalLocalId,
        importKey,
        payloadHash,
        contentId,
        status,
        createdAt,
      }),
    ),
  };
}

function approvalCandidate(store: WorkflowStore, run: PersistedRun, candidateVersion: number) {
  const state = asState(run.state);
  if (asCount(state.candidateVersion) !== candidateVersion) {
    throw new AppError(409, 'STALE_CANDIDATE', 'The candidate revision is no longer current.');
  }
  const row = store
    .listCandidates(run.id)
    .find((item) => item.candidateVersion === candidateVersion);
  const parsed = row ? z.array(recordingProposalSchema).safeParse(row.proposals) : null;
  if (!parsed?.success) {
    throw new AppError(409, 'CANDIDATE_UNAVAILABLE', 'The candidate revision is unavailable.');
  }
  return parsed.data.map(({ localId, ...proposal }) => ({ ...proposal, localId }));
}

function sameDecision(
  existing: NonNullable<ReturnType<WorkflowStore['getApproval']>>,
  decision:
    | { decision: 'approved'; candidateVersion: number; categoryId: string }
    | { decision: 'rejected'; candidateVersion: number },
  payloadHash: string,
) {
  return (
    existing.decision === decision.decision &&
    existing.candidateVersion === decision.candidateVersion &&
    existing.payloadHash === payloadHash
  );
}

function approvalConflict() {
  return new AppError(409, 'APPROVAL_CONFLICT', 'The workflow approval has already been decided.');
}

function approvalOf(approval: ReturnType<WorkflowStore['getApproval']>) {
  if (!approval) return null;
  return {
    actorId: approval.actorId,
    candidateVersion: approval.candidateVersion,
    categoryId: approval.categoryId,
    payloadHash: approval.payloadHash,
    decision: approval.decision,
    frozenPayload: approval.frozenPayload,
    decidedAt: approval.decidedAt,
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
  const fresh = claimedToken === undefined;
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
  const attempts: AttemptRecorder = {
    reserve: (input) => {
      try {
        return options.store.reserveAttempt({
          runId: run.id,
          claimToken,
          ...input,
        });
      } catch (err) {
        if (err instanceof PersistError && err.code === 'BUDGET') {
          throw new AppError(
            503,
            'PROVIDER_BUDGET_EXHAUSTED',
            'The provider request budget was exhausted.',
          );
        }
        throw checkpointError(err);
      }
    },
    finish: (reservation, result) => {
      try {
        options.store.finishAttempt({
          runId: run.id,
          claimToken,
          reservation,
          ...result,
        });
      } catch (err) {
        throw checkpointError(err);
      }
    },
  };
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
      attempts,
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
            invalidCandidates: previousCandidates
              .filter((item) => hasBlockingCheck(item.checks))
              .map((item) => ({
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
          candidate: candidateRow(next, clock.now()),
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
      candidate: candidateRow(state, clock.now()),
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
    ollamaVersion: state.ollamaVersion,
  };
}

function candidateRow(state: GenerationState, createdAt: number) {
  if (!state.candidate || state.candidateVersion < 1) {
    return undefined;
  }
  return {
    candidateVersion: state.candidateVersion,
    proposals: withLocalIds(state.candidate),
    checks: state.checks,
    createdAt,
  };
}

function hasBlockingCheck(value: unknown) {
  return Array.isArray(value) && value.some((check) => check?.status === 'failed');
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
  if (!model.digest) {
    throw new AppError(409, 'MODEL_DIGEST_UNAVAILABLE', 'The current model digest is unavailable.');
  }
  if (run.consumed.providerRequests > 0 && !run.modelDigest) {
    throw new AppError(
      409,
      'MODEL_DIGEST_UNAVAILABLE',
      'The recorded model digest is unavailable.',
    );
  }
  if (run.modelDigest && model.digest !== run.modelDigest) {
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
