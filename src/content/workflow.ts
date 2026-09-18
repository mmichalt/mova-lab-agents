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
import {
  initialRuntime,
  type Observability,
  type ProviderTiming,
  type RuntimeMetadata,
  withSpan,
} from '../observability.ts';
import { hashNormalizedInput } from '../persist/store.ts';
import { decideToolCall, runSearchTool, SEARCH_EXISTING_EXERCISES } from '../tools/dispatch.ts';
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
import {
  createSupervisorState,
  MAX_SUPERVISOR_DECISIONS,
  planSupervisorAction,
  type SupervisorAction,
  type SupervisorActionRecord,
  type SupervisorState,
  supervisorActionKey,
  supervisorStateSchema,
} from './supervisor.ts';
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
  supervisor?: SupervisorState;
  runtime: RuntimeMetadata;
  timing: ProviderTiming[];
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
  ollamaQuantization?: string | null;
  invalidCandidates: Array<{ proposals: GeneratedProposal[]; checks: CheckResult[] }>;
};

type RunOptions = {
  config: Config;
  logger: Logger;
  requestId: string;
  request: ContentRequest;
  clock?: Clock;
  maxProviderRequests?: number;
  outputTokenBudget?: { remaining: number; reserved?: number; parallel?: number };
  maxRevisions?: number;
  signal?: AbortSignal;
  resume?: WorkflowResume;
  initialState?: unknown;
  attempts?: AttemptRecorder;
  onCheckpoint?: (state: GenerationState) => void;
  supervisor?: boolean;
  observability?: Observability;
};

export async function generateContentDrafts(options: {
  config: Config;
  logger: Logger;
  requestId: string;
  body: unknown;
  clock?: Clock;
  maxProviderRequests?: number;
  signal?: AbortSignal;
  observability?: Observability;
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
      supervisor: options.config.experimentalSupervisor,
      observability: options.observability,
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
  const checkpointState = recordOf(resume ? resume.checkpoint : options.initialState);
  const storedSupervisor = checkpointState.supervisor;
  const parsedSupervisor =
    storedSupervisor == null ? undefined : supervisorStateSchema.safeParse(storedSupervisor);
  const supervisorVersionError = storedSupervisor != null && !parsedSupervisor?.success;
  const executionSpan = options.observability?.startSpan('workflow.execution', {
    attributes: {
      'workflow.request_id': options.requestId,
      'workflow.resumed': resume !== undefined,
    },
  });
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
    timing: Array.isArray(checkpointState.timing)
      ? (checkpointState.timing as ProviderTiming[])
      : [],
    modelTag: resume?.modelTag ?? config.ollamaModel,
    modelDigest: resume?.modelDigest ?? null,
    ollamaVersion:
      resume?.ollamaVersion ??
      (typeof checkpointState.ollamaVersion === 'string' ? checkpointState.ollamaVersion : null),
    supervisor: parsedSupervisor?.success
      ? parsedSupervisor.data
      : storedSupervisor == null &&
          options.initialState === undefined &&
          !resume &&
          options.supervisor
        ? createSupervisorState()
        : undefined,
    runtime:
      (checkpointState.runtime as RuntimeMetadata | undefined) ??
      initialRuntime({
        modelTag: resume?.modelTag ?? config.ollamaModel,
        contextTokens: config.ollamaNumCtx,
        outputTokens: config.ollamaNumPredict,
      }),
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
    outputTokenBudget: options.outputTokenBudget,
    attempts: options.attempts,
    observed: {
      modelTag: state.modelTag,
      modelDigest: state.modelDigest,
      ollamaVersion: state.ollamaVersion,
      quantization: state.runtime.quantization,
    },
    observability: options.observability,
    timing: state.timing,
    expectedModelTag: resume?.modelTag,
    expectedModelDigest: resume?.modelDigest,
  };
  try {
    if (expired(controller, limits, clock)) {
      failExpired(state, controller);
    } else if (supervisorVersionError) {
      fail(
        state,
        new AppError(
          409,
          'SUPERVISOR_VERSION_UNSUPPORTED',
          'The recorded supervisor version is not supported.',
        ),
      );
    } else {
      const constraints = await withSpan(
        options.observability,
        'workflow.step.constraints',
        { attributes: { 'workflow.step': 'constraints' } },
        () =>
          readGenerationConstraints({
            config,
            signal: controller.signal,
            observability: options.observability,
          }),
      );
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
    if (state.status === 'RUNNING' && state.supervisor) {
      await runSupervisorWorkflow(state, llm, options, limits);
    }
    if (state.status === 'RUNNING' && !state.supervisor) {
      const vocabulary =
        state.vocabulary ??
        (await withSpan(
          options.observability,
          'workflow.step.vocabulary',
          { attributes: { 'workflow.step': 'vocabulary' } },
          () => selectVocabulary({ ...llm, request: options.request }),
        ));
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
          state.checks = await withSpan(
            options.observability,
            'workflow.step.checks',
            { attributes: { 'workflow.step': 'checks' } },
            () =>
              runChecks(
                state,
                llm,
                vocabulary,
                state.candidate as GeneratedProposal[],
                options,
                limits,
              ),
          );
        } else {
          const produced = await withSpan(
            options.observability,
            feedback ? 'workflow.step.revision' : 'workflow.step.generation',
            { attributes: { 'workflow.step': feedback ? 'revision' : 'generation' } },
            () => nextCandidate(state, llm, vocabulary, feedback),
          );
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
          state.checks = await withSpan(
            options.observability,
            'workflow.step.checks',
            { attributes: { 'workflow.step': 'checks' } },
            () =>
              runChecks(
                state,
                llm,
                vocabulary,
                state.candidate as GeneratedProposal[],
                options,
                limits,
              ),
          );
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
    state.runtime = {
      ...state.runtime,
      modelTag: state.modelTag,
      modelDigest: state.modelDigest,
      ollamaVersion: state.ollamaVersion,
      quantization: llm.observed?.quantization ?? state.runtime.quantization,
    };
    executionSpan?.setAttribute('workflow.status', state.status);
    executionSpan?.end();
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
  const budget = options.outputTokenBudget;
  const parallelReviews = budget && !existing.has('age') && !existing.has('language');
  if (parallelReviews) budget.parallel = 2;
  try {
    const agePromise = existing.get('age') ?? reviewAge(review).then(remember);
    const languagePromise = existing.get('language') ?? reviewLanguage(review).then(remember);
    const [age, language] = await settleReviews(
      Promise.resolve(agePromise),
      Promise.resolve(languagePromise),
    );
    return [content, age, language];
  } finally {
    if (parallelReviews) delete budget.parallel;
  }
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

async function runSupervisorWorkflow(
  state: GenerationState,
  llm: LlmCall,
  options: RunOptions,
  limits: ExecutionLimits,
) {
  const supervisor = state.supervisor;
  if (!supervisor) return;
  while (state.status === 'RUNNING') {
    if (supervisor.decisions >= MAX_SUPERVISOR_DECISIONS) {
      fail(
        state,
        new AppError(
          422,
          'SUPERVISOR_DECISIONS_EXHAUSTED',
          'The supervisor decision limit was exhausted.',
        ),
      );
      checkpoint(state, limits, options, llm);
      return;
    }

    const action = await planSupervisorAction({
      ...llm,
      request: state.request,
      context: supervisorContext(state),
    });
    supervisor.decisions += 1;
    checkpoint(state, limits, options, llm);

    try {
      const result = await executeSupervisorAction(state, action, llm, options, limits);
      const repeated = supervisor.history.some(
        (record) =>
          JSON.stringify({ action: record.action, args: record.args }) ===
            supervisorActionKey(action) &&
          JSON.stringify(record.observation) === JSON.stringify(result.observation),
      );
      if (repeated) {
        appendSupervisorAction(supervisor, action, 'repeated', result.observation);
        fail(
          state,
          new AppError(
            422,
            'SUPERVISOR_NO_PROGRESS',
            'The supervisor repeated an ineffective action.',
          ),
        );
        checkpoint(state, limits, options, llm);
        return;
      }

      if (result.status === 'ready') state.status = 'READY_FOR_REVIEW';
      if (result.status === 'rejected') {
        fail(
          state,
          new AppError(
            422,
            'SUPERVISOR_PREREQUISITE_MISSING',
            'The supervisor selected an action whose prerequisites are not met.',
          ),
        );
      }
      if (result.status === 'failed' && result.error) fail(state, result.error);
      appendSupervisorAction(
        supervisor,
        action,
        result.status === 'ready' ? 'completed' : result.status,
        result.observation,
      );
      checkpoint(state, limits, options, llm);
      if (state.status !== 'RUNNING') return;
      if (supervisor.decisions >= MAX_SUPERVISOR_DECISIONS) {
        fail(
          state,
          new AppError(
            422,
            'SUPERVISOR_DECISIONS_EXHAUSTED',
            'The supervisor decision limit was exhausted.',
          ),
        );
        checkpoint(state, limits, options, llm);
        return;
      }
    } catch (err) {
      const error =
        err instanceof AppError
          ? err
          : new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
      appendSupervisorAction(supervisor, action, 'failed', { errorCode: error.code });
      fail(state, error);
      checkpoint(state, limits, options, llm);
      return;
    }
  }
}

async function executeSupervisorAction(
  state: GenerationState,
  action: SupervisorAction,
  llm: LlmCall,
  options: RunOptions,
  limits: ExecutionLimits,
): Promise<
  | { status: 'completed'; observation: unknown }
  | { status: 'ready'; observation: unknown }
  | { status: 'rejected'; observation: unknown }
  | { status: 'failed'; observation: unknown; error: AppError }
> {
  if (action.action === 'search') {
    const decision = decideToolCall({
      function: { name: SEARCH_EXISTING_EXERCISES, arguments: action.args },
    });
    if (decision.status !== 'execute') {
      throw new AppError(
        502,
        'PROVIDER_INVALID_OUTPUT',
        'The supervisor requested an invalid search.',
      );
    }
    const content = await runSearchTool(decision, { config: llm.config, signal: llm.signal });
    return { status: 'completed', observation: parseObservation(content) };
  }

  if (action.action === 'vocabulary') {
    if (state.candidate) {
      return rejectedSupervisorAction('A candidate already exists.');
    }
    const selected = await selectVocabulary({ ...llm, request: state.request });
    const next = mergeVocabulary(state.vocabulary, selected);
    state.vocabulary = next;
    state.phase = 'vocabulary';
    state.checks = [];
    return {
      status: 'completed',
      observation: { vocabularyFingerprint: hashNormalizedInput(next) },
    };
  }

  if (action.action === 'generate') {
    if (!state.vocabulary) return rejectedSupervisorAction('Vocabulary is required.');
    if (state.candidate) return rejectedSupervisorAction('A candidate already exists.');
    const proposals = await generateExercises({
      ...llm,
      candidateVersion: state.candidateVersion,
      request: state.request,
      vocabulary: state.vocabulary,
    });
    const nextFingerprint = hashNormalizedInput(proposals);
    if (nextFingerprint !== hashNormalizedInput(state.candidate ?? null)) {
      state.candidate = proposals;
      state.candidateVersion += 1;
      state.phase = 'checks';
      state.checks = [];
    }
    return { status: 'completed', observation: { candidateFingerprint: nextFingerprint } };
  }

  if (action.action === 'revise') {
    if (!state.vocabulary || !state.candidate) {
      return rejectedSupervisorAction('A candidate and vocabulary are required.');
    }
    const feedback = blockingIssues(state.checks);
    if (feedback.length === 0) {
      return rejectedSupervisorAction('Failed checks are required before revision.');
    }
    if (state.revisionCount >= (options.maxRevisions ?? MAX_REVISIONS)) {
      return {
        status: 'failed',
        observation: { errorCode: 'CONTENT_VALIDATION_EXHAUSTED' },
        error: new AppError(
          422,
          'CONTENT_VALIDATION_EXHAUSTED',
          'Unable to produce a valid draft within the configured limits.',
        ),
      };
    }
    state.revisionCount += 1;
    state.phase = 'revision';
    checkpoint(state, limits, options, llm);
    const proposals = await reviseExercises({
      ...llm,
      candidateVersion: state.candidateVersion,
      request: state.request,
      vocabulary: state.vocabulary,
      previous: state.candidate,
      feedback,
    });
    const nextFingerprint = hashNormalizedInput(proposals);
    if (nextFingerprint !== hashNormalizedInput(state.candidate)) {
      state.candidate = proposals;
      state.candidateVersion += 1;
      state.phase = 'checks';
      state.checks = [];
    }
    return { status: 'completed', observation: { candidateFingerprint: nextFingerprint } };
  }

  if (!state.vocabulary || !state.candidate) {
    return rejectedSupervisorAction('A candidate and vocabulary are required before finish.');
  }
  state.checks = await runChecks(state, llm, state.vocabulary, state.candidate, options, limits);
  const decision = decide(state.checks);
  const observation = {
    checks: state.checks.map((check) => ({ name: check.name, status: check.status })),
  };
  if (decision === 'pass') {
    state.phase = 'finished';
    return { status: 'ready', observation };
  }
  if (decision === 'unavailable') {
    return {
      status: 'failed',
      observation,
      error: new AppError(200, 'REVIEW_UNAVAILABLE', 'A required review is unavailable.'),
    };
  }
  if (decision === 'refused') {
    return {
      status: 'failed',
      observation,
      error: new AppError(200, 'REVIEW_REFUSED', 'A reviewer refused to judge the candidate.'),
    };
  }
  return { status: 'completed', observation };
}

function rejectedSupervisorAction(message: string) {
  return {
    status: 'rejected' as const,
    observation: { errorCode: 'SUPERVISOR_PREREQUISITE_MISSING', message },
  };
}

function appendSupervisorAction(
  state: SupervisorState,
  action: SupervisorAction,
  outcome: SupervisorActionRecord['outcome'],
  observation: unknown,
) {
  state.history.push({
    decision: state.decisions,
    action: action.action,
    args: action.args,
    outcome,
    observation,
  });
}

function supervisorContext(state: GenerationState) {
  return {
    phase: state.phase,
    candidateVersion: state.candidateVersion,
    revisionCount: state.revisionCount,
    vocabulary: state.vocabulary ?? null,
    candidate: state.candidate ?? null,
    checks: state.checks,
    supervisor: state.supervisor,
  };
}

function mergeVocabulary(existing: Vocabulary | undefined, selected: Vocabulary): Vocabulary {
  const items = [...(existing?.items ?? [])];
  for (const item of selected.items) {
    if (
      !items.some(
        (current) => current.word === item.word && current.targetSound === item.targetSound,
      )
    ) {
      items.push(item);
    }
  }
  return { items: items.slice(0, 24) };
}

function parseObservation(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { value: value.slice(0, 2048) };
  }
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
