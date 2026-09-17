import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { LlmCall } from '../llm/complete.ts';
import {
  type AttemptRecorder,
  abortError,
  type Clock,
  createLimits,
  type ExecutionLimits,
  MAX_PROVIDER_REQUESTS,
  remainingMs,
  systemClock,
  workflowTimeout,
} from '../llm/execution.ts';
import type { Logger } from '../logger.ts';
import { readGenerationConstraints } from '../tools/mova-lab.ts';
import { generateExercises, reviseExercises, selectVocabulary } from './generate.ts';
import { reviewAge, reviewLanguage, settleReviews } from './review.ts';
import {
  type CheckResult,
  type ContentRequest,
  contentRequestSchema,
  type GeneratedProposal,
  type GenerationResult,
  type LlmUsage,
  type ValidationIssue,
  type Vocabulary,
} from './schemas.ts';
import { validateCandidate } from './validation.ts';

export const MAX_REVISIONS = 2;

const malformedCodes = new Set([
  'PROVIDER_INVALID_OUTPUT',
  'PROVIDER_INCOMPLETE',
  'PROVIDER_UNEXPECTED_TOOL_CALL',
]);

const schemaIssue: ValidationIssue = {
  source: 'schema',
  code: 'INVALID_OUTPUT',
  severity: 'error',
  message: 'The model returned invalid output.',
};

const loggedIssueCode = new Set([
  'INVALID_OUTPUT',
  'WRONG_COUNT',
  'UNREQUESTED_SOUND',
  'DUPLICATE_PHRASE',
  'MISSING_TARGET_LETTER',
  'MISSING_VOCABULARY',
  'SOUND_DISTRIBUTION',
  'REVIEW_REFUSED',
]);

export type AttemptSummary = {
  candidateVersion: number;
  revisionCount: number;
  outcome: 'passed' | 'failed' | 'malformed' | 'refused' | 'identical';
  issueCodes: string[];
};

export type WorkflowError = {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
};

export type GenerationState = {
  request: ContentRequest;
  phase: 'vocabulary' | 'generation' | 'checks' | 'revision' | 'finished';
  status: 'RUNNING' | 'READY_FOR_REVIEW' | 'FAILED';
  candidateVersion: number;
  revisionCount: number;
  deadlineAt: number;
  attemptTimeoutMs: number;
  maxProviderRequests: number;
  providerRequests: number;
  constraintsVersion?: string;
  vocabulary?: Vocabulary;
  candidate?: GeneratedProposal[];
  checks: CheckResult[];
  history: AttemptSummary[];
  usage: LlmUsage[];
  modelTag: string | null;
  modelDigest: string | null;
  ollamaVersion: string | null;
  error?: WorkflowError;
};

export type WorkflowResume = {
  checkpoint: unknown;
  deadlineAt: number;
  attemptTimeoutMs: number;
  maxProviderRequests: number;
  maxRevisions: number;
  ollamaNumCtx: number;
  ollamaNumPredict: number;
  providerRequests: number;
  revisionCount: number;
  constraintsVersion: string;
  modelTag: string | null;
  modelDigest: string | null;
  ollamaVersion: string | null;
  invalidCandidates: Array<{ proposals: GeneratedProposal[]; checks: CheckResult[] }>;
};

type RunOptions = {
  config: Config;
  logger: Logger;
  requestId: string;
  request: ContentRequest;
  clock?: Clock;
  maxProviderRequests?: number;
  maxRevisions?: number;
  signal?: AbortSignal;
  resume?: WorkflowResume;
  attempts?: AttemptRecorder;
  onCheckpoint?: (state: GenerationState) => void;
};

export async function generateContentDrafts(options: {
  config: Config;
  logger: Logger;
  requestId: string;
  body: unknown;
  clock?: Clock;
  maxProviderRequests?: number;
  signal?: AbortSignal;
}): Promise<GenerationResult> {
  const parsed = contentRequestSchema.safeParse(options.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid content request.');
  }
  return present(
    options.requestId,
    await runContentWorkflow({
      config: options.config,
      logger: options.logger,
      requestId: options.requestId,
      request: parsed.data,
      clock: options.clock,
      maxProviderRequests: options.maxProviderRequests,
      signal: options.signal,
    }),
  );
}

export async function runContentWorkflow(options: RunOptions): Promise<GenerationState> {
  const clock = options.clock ?? systemClock;
  const resume = options.resume;
  const config = resume
    ? {
        ...options.config,
        llmAttemptTimeoutMs: resume.attemptTimeoutMs,
        ollamaNumCtx: resume.ollamaNumCtx,
        ollamaNumPredict: resume.ollamaNumPredict,
      }
    : options.config;
  const limits: ExecutionLimits = resume
    ? {
        deadlineAt: resume.deadlineAt,
        attemptTimeoutMs: config.llmAttemptTimeoutMs,
        maxProviderRequests: resume.maxProviderRequests,
        providerRequests: resume.providerRequests,
      }
    : createLimits(
        options.config,
        clock.now(),
        options.maxProviderRequests ?? MAX_PROVIDER_REQUESTS,
      );
  const checkpointState = recordOf(resume?.checkpoint);
  const controller = new AbortController();
  const onExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(options.signal ? abortError(options.signal) : workflowTimeout());
    }
  };
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(
    () => {
      if (!controller.signal.aborted) controller.abort(workflowTimeout());
    },
    Math.max(0, limits.deadlineAt - clock.now()),
  );
  const state: GenerationState = {
    request: options.request,
    phase: phaseOf(checkpointState.phase),
    status: 'RUNNING',
    candidateVersion: countOf(checkpointState.candidateVersion),
    revisionCount: resume?.revisionCount ?? 0,
    deadlineAt: limits.deadlineAt,
    attemptTimeoutMs: limits.attemptTimeoutMs,
    maxProviderRequests: limits.maxProviderRequests,
    providerRequests: limits.providerRequests,
    checks: Array.isArray(checkpointState.checks) ? (checkpointState.checks as CheckResult[]) : [],
    history: Array.isArray(checkpointState.history)
      ? (checkpointState.history as AttemptSummary[])
      : [],
    usage: Array.isArray(checkpointState.usage) ? (checkpointState.usage as LlmUsage[]) : [],
    modelTag: resume?.modelTag ?? config.ollamaModel,
    modelDigest: resume?.modelDigest ?? null,
    ollamaVersion:
      resume?.ollamaVersion ??
      (typeof checkpointState.ollamaVersion === 'string' ? checkpointState.ollamaVersion : null),
    vocabulary: checkpointState.vocabulary as Vocabulary | undefined,
    candidate: Array.isArray(checkpointState.candidate)
      ? (checkpointState.candidate as GeneratedProposal[])
      : undefined,
  };
  const llm: LlmCall = {
    config,
    logger: options.logger,
    requestId: options.requestId,
    limits,
    signal: controller.signal,
    clock,
    usage: state.usage,
    attempts: options.attempts,
    observed: {
      modelTag: state.modelTag,
      modelDigest: state.modelDigest,
      ollamaVersion: state.ollamaVersion,
    },
    expectedModelTag: resume?.modelTag,
    expectedModelDigest: resume?.modelDigest,
  };
  try {
    if (expired(controller, limits, clock)) {
      failExpired(state, controller);
    } else {
      const constraints = await readGenerationConstraints({
        config,
        signal: controller.signal,
      });
      if (resume && constraints.version !== resume.constraintsVersion) {
        throw new AppError(
          409,
          'CONSTRAINTS_VERSION_CHANGED',
          'The recorded generation constraints are no longer available.',
        );
      }
      state.constraintsVersion = constraints.version;
    }
    if (state.status === 'RUNNING' && expired(controller, limits, clock)) {
      failExpired(state, controller);
    }
    if (state.status === 'RUNNING') {
      const vocabulary =
        state.vocabulary ?? (await selectVocabulary({ ...llm, request: options.request }));
      if (!state.vocabulary) {
        state.vocabulary = vocabulary;
        checkpoint(state, limits, options, llm);
      }

      let feedback: readonly ValidationIssue[] | undefined =
        resume && state.phase === 'revision' ? blockingIssues(state.checks) : undefined;
      const invalid = new Map<string, CheckResult[]>(
        resume?.invalidCandidates.map((item) => [fingerprint(item.proposals), item.checks]),
      );
      while (state.status === 'RUNNING') {
        let mark: string | undefined;
        if (state.phase === 'checks' && state.candidate) {
          mark = fingerprint(state.candidate);
          state.checks = await runChecks(state, llm, vocabulary, state.candidate, options, limits);
        } else {
          const produced = await nextCandidate(state, llm, vocabulary, feedback);
          if (expired(controller, limits, clock)) {
            failExpired(state, controller);
            break;
          }
          if (produced.status === 'refused') {
            record(state, 'refused', []);
            fail(state, refusedError());
            break;
          }
          if (produced.status === 'malformed') {
            record(state, 'malformed', [schemaIssue.code]);
            if (!state.candidate) {
              state.checks = [{ status: 'failed', name: 'content', issues: [schemaIssue] }];
            }
            if (!tryRevise(state, options, [schemaIssue])) break;
            checkpoint(state, limits, options, llm);
            feedback = [schemaIssue];
            continue;
          }

          state.candidate = produced.proposals;
          state.candidateVersion += 1;
          state.phase = 'checks';
          state.checks = [];
          checkpoint(state, limits, options, llm);
          mark = fingerprint(produced.proposals);
          const previousChecks = invalid.get(mark);
          if (previousChecks) {
            state.checks = previousChecks;
            record(state, 'identical', issueCodes(state.checks));
            fail(
              state,
              new AppError(
                422,
                'IDENTICAL_INVALID_CANDIDATE',
                'The model repeated an invalid candidate.',
              ),
            );
            break;
          }
          state.checks = await runChecks(state, llm, vocabulary, state.candidate, options, limits);
        }
        if (expired(controller, limits, clock)) {
          failExpired(state, controller);
          break;
        }
        const decision = decide(state.checks);
        if (decision === 'pass') {
          record(state, 'passed', []);
          state.status = 'READY_FOR_REVIEW';
          state.phase = 'finished';
          break;
        }
        if (decision === 'unavailable') {
          record(state, 'failed', issueCodes(state.checks));
          fail(state, new AppError(200, 'REVIEW_UNAVAILABLE', 'A required review is unavailable.'));
          break;
        }
        if (decision === 'refused') {
          record(state, 'failed', issueCodes(state.checks));
          fail(
            state,
            new AppError(200, 'REVIEW_REFUSED', 'A reviewer refused to judge the candidate.'),
          );
          break;
        }

        record(state, 'failed', issueCodes(state.checks));
        if (mark) invalid.set(mark, state.checks);
        const issues = blockingIssues(state.checks);
        if (!tryRevise(state, options, issues)) break;
        checkpoint(state, limits, options, llm);
        feedback = issues;
      }
    }
  } catch (err) {
    if (state.status === 'RUNNING') {
      fail(
        state,
        err instanceof AppError
          ? err
          : new AppError(500, 'INTERNAL_ERROR', 'Internal server error.'),
      );
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
    state.providerRequests = limits.providerRequests;
    state.modelTag = llm.observed?.modelTag ?? state.modelTag;
    state.modelDigest = llm.observed?.modelDigest ?? state.modelDigest;
    state.ollamaVersion = llm.observed?.ollamaVersion ?? state.ollamaVersion;
  }

  options.logger.info(
    {
      requestId: options.requestId,
      status: state.status,
      candidateVersion: state.candidateVersion,
      revisionCount: state.revisionCount,
      attempts: state.history.length,
      providerRequests: state.providerRequests,
      usageCount: state.usage.length,
      constraintsVersion: state.constraintsVersion,
      deadlineAt: state.deadlineAt,
      errorCode: state.error?.code,
      issueCodes: loggedCodes(issueCodes(state.checks)),
      issueCount: issueCodes(state.checks).length,
    },
    'workflow finished',
  );
  return state;
}

async function nextCandidate(
  state: GenerationState,
  llm: LlmCall,
  vocabulary: Vocabulary,
  feedback: readonly ValidationIssue[] | undefined,
): Promise<
  | { status: 'generated'; proposals: GeneratedProposal[] }
  | { status: 'malformed' }
  | { status: 'refused' }
> {
  const call = {
    ...llm,
    candidateVersion: state.candidateVersion,
    request: state.request,
    vocabulary,
  };
  try {
    if (feedback) {
      state.phase = 'revision';
      return {
        status: 'generated',
        proposals: await reviseExercises({
          ...call,
          previous: state.candidate,
          feedback,
        }),
      };
    }
    state.phase = 'generation';
    return { status: 'generated', proposals: await generateExercises(call) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'MODEL_REFUSED') return { status: 'refused' };
    if (err instanceof AppError && malformedCodes.has(err.code)) return { status: 'malformed' };
    throw err;
  }
}

async function runChecks(
  state: GenerationState,
  llm: LlmCall,
  vocabulary: Vocabulary,
  proposals: GeneratedProposal[],
  options: RunOptions,
  limits: ExecutionLimits,
): Promise<CheckResult[]> {
  const content = validateCandidate(state.request, vocabulary, proposals);
  if (content.status === 'failed') {
    llm.logger.warn(
      {
        requestId: llm.requestId,
        step: 'validation',
        candidateVersion: state.candidateVersion,
        issues: content.issues
          .filter((item) => item.severity === 'error')
          .map((item) => ({ code: item.code, path: item.path })),
      },
      'content validation failed',
    );
    return [content];
  }
  const existing = new Map(
    state.checks
      .filter((check) => check.name === 'age' || check.name === 'language')
      .map((check) => [check.name, check]),
  );
  const remember = (check: CheckResult) => {
    existing.set(check.name, check);
    state.checks = [content, ...existing.values()];
    checkpoint(state, limits, options, llm);
    return check;
  };
  const review = {
    ...llm,
    candidateVersion: state.candidateVersion,
    request: state.request,
    proposals,
  };
  const agePromise = existing.get('age') ?? reviewAge(review).then(remember);
  const languagePromise = existing.get('language') ?? reviewLanguage(review).then(remember);
  const [age, language] = await settleReviews(
    Promise.resolve(agePromise),
    Promise.resolve(languagePromise),
  );
  return [content, age, language];
}

function tryRevise(
  state: GenerationState,
  options: RunOptions,
  issues: readonly ValidationIssue[],
): boolean {
  if (state.revisionCount >= (options.maxRevisions ?? MAX_REVISIONS)) {
    fail(
      state,
      new AppError(
        422,
        'CONTENT_VALIDATION_EXHAUSTED',
        'Unable to produce a valid draft within the configured limits.',
      ),
    );
    return false;
  }
  state.revisionCount += 1;
  state.phase = 'revision';
  options.logger.info(
    {
      requestId: options.requestId,
      step: 'revision',
      candidateVersion: state.candidateVersion,
      revisionCount: state.revisionCount,
      issueCodes: loggedCodes(issues.map((item) => item.code)),
    },
    'content revision started',
  );
  return true;
}

function decide(checks: readonly CheckResult[]) {
  if (checks.every((check) => check.status === 'passed')) return 'pass';
  if (checks.some((check) => check.status === 'unavailable')) return 'unavailable';
  if (
    checks.some(
      (check) =>
        check.status === 'failed' &&
        check.issues.some(
          (item) => item.source === 'application' && item.code === 'REVIEW_REFUSED',
        ),
    )
  ) {
    return 'refused';
  }
  return 'revise';
}

function present(requestId: string, state: GenerationState): GenerationResult {
  if (state.status === 'READY_FOR_REVIEW' || keepFailedResult(state)) {
    return {
      requestId,
      status: state.status === 'READY_FOR_REVIEW' ? 'READY_FOR_REVIEW' : 'FAILED',
      candidateVersion: state.candidateVersion,
      revisionCount: state.revisionCount,
      providerRequests: state.providerRequests,
      requiresHumanApproval: state.status === 'READY_FOR_REVIEW',
      checks: state.checks,
      proposals: withLocalIds(state.candidate ?? []),
    };
  }
  const error = state.error ?? {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
    status: 500,
    retryable: false,
  };
  throw new AppError(error.status, error.code, error.message);
}

function keepFailedResult(state: GenerationState) {
  return (
    state.status === 'FAILED' &&
    state.candidate !== undefined &&
    (state.error?.code === 'REVIEW_UNAVAILABLE' || state.error?.code === 'REVIEW_REFUSED')
  );
}

export function withLocalIds(proposals: readonly GeneratedProposal[]) {
  return proposals.map((proposal, index) => ({
    ...proposal,
    localId: `proposal-${index + 1}`,
  }));
}

function checkpoint(
  state: GenerationState,
  limits: ExecutionLimits,
  options: RunOptions,
  llm: LlmCall,
) {
  state.providerRequests = limits.providerRequests;
  state.modelTag = llm.observed?.modelTag ?? state.modelTag;
  state.modelDigest = llm.observed?.modelDigest ?? state.modelDigest;
  state.ollamaVersion = llm.observed?.ollamaVersion ?? state.ollamaVersion;
  options.onCheckpoint?.(state);
}

function fail(state: GenerationState, err: AppError) {
  state.status = 'FAILED';
  if (!err.retryable) state.phase = 'finished';
  state.error = {
    code: err.code,
    message: err.message,
    status: err.status,
    retryable: err.retryable,
  };
}

function phaseOf(value: unknown): GenerationState['phase'] {
  return value === 'vocabulary' ||
    value === 'generation' ||
    value === 'checks' ||
    value === 'revision' ||
    value === 'finished'
    ? value
    : 'vocabulary';
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function countOf(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function expired(controller: AbortController, limits: ExecutionLimits, clock: Clock) {
  return controller.signal.aborted || remainingMs(limits, clock.now()) <= 0;
}

function failExpired(state: GenerationState, controller: AbortController) {
  fail(state, controller.signal.aborted ? abortError(controller.signal) : workflowTimeout());
}

function refusedError() {
  return new AppError(422, 'MODEL_REFUSED', 'The model refused to generate proposals.');
}

function loggedCodes(codes: readonly string[]) {
  return codes.filter((code) => loggedIssueCode.has(code));
}

function record(state: GenerationState, outcome: AttemptSummary['outcome'], issueCodes: string[]) {
  state.history.push({
    candidateVersion: state.candidateVersion,
    revisionCount: state.revisionCount,
    outcome,
    issueCodes,
  });
}

function blockingIssues(checks: readonly CheckResult[]): ValidationIssue[] {
  return checks.flatMap((check) => (check.status === 'failed' ? check.issues : []));
}

function issueCodes(checks: readonly CheckResult[]): string[] {
  return blockingIssues(checks)
    .filter((item) => item.severity === 'error')
    .map((item) => item.code);
}

function fingerprint(proposals: readonly GeneratedProposal[]) {
  return JSON.stringify(
    proposals.map((proposal) => {
      const copy = { ...proposal } as GeneratedProposal & { localId?: string };
      delete copy.localId;
      return copy;
    }),
  );
}
