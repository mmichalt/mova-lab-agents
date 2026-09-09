import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { LlmCall } from '../llm/complete.ts';
import { type Clock, createLimits, MAX_PROVIDER_REQUESTS, systemClock } from '../llm/execution.ts';
import type { Logger } from '../logger.ts';
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

export type AttemptSummary = {
  candidateVersion: number;
  revisionCount: number;
  outcome: 'passed' | 'failed' | 'malformed' | 'refused' | 'identical';
  issueCodes: string[];
};

export type WorkflowError = {
  code: string;
  message: string;
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
  vocabulary?: Vocabulary;
  candidate?: GeneratedProposal[];
  checks: CheckResult[];
  history: AttemptSummary[];
  usage: LlmUsage[];
  error?: WorkflowError;
};

type RunOptions = {
  config: Config;
  logger: Logger;
  requestId: string;
  request: ContentRequest;
  clock?: Clock;
  maxProviderRequests?: number;
};

export async function generateContentDrafts(options: {
  config: Config;
  logger: Logger;
  requestId: string;
  body: unknown;
  clock?: Clock;
  maxProviderRequests?: number;
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
    }),
  );
}

export async function runContentWorkflow(options: RunOptions): Promise<GenerationState> {
  const clock = options.clock ?? systemClock;
  const limits = createLimits(
    options.config,
    clock.now(),
    options.maxProviderRequests ?? MAX_PROVIDER_REQUESTS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.config.workflowTimeoutMs);
  const state: GenerationState = {
    request: options.request,
    phase: 'vocabulary',
    status: 'RUNNING',
    candidateVersion: 0,
    revisionCount: 0,
    deadlineAt: limits.deadlineAt,
    attemptTimeoutMs: limits.attemptTimeoutMs,
    maxProviderRequests: limits.maxProviderRequests,
    providerRequests: 0,
    checks: [],
    history: [],
    usage: [],
  };
  const llm = {
    config: options.config,
    logger: options.logger,
    requestId: options.requestId,
    limits,
    signal: controller.signal,
    clock,
  };
  try {
    const vocabulary = await selectVocabulary({ ...llm, request: options.request });
    state.vocabulary = vocabulary;

    let feedback: readonly ValidationIssue[] | undefined;
    const invalid = new Map<string, CheckResult[]>();
    while (state.status === 'RUNNING') {
      const produced = await nextCandidate(state, llm, vocabulary, feedback);
      if (produced.status === 'refused') {
        record(state, 'refused', []);
        fail(state, 'MODEL_REFUSED', 'The model refused to generate proposals.');
        break;
      }
      if (produced.status === 'malformed') {
        state.candidateVersion += 1;
        record(state, 'malformed', [schemaIssue.code]);
        if (!tryRevise(state, options, [schemaIssue])) break;
        feedback = [schemaIssue];
        continue;
      }

      state.candidate = produced.proposals;
      state.candidateVersion += 1;
      const mark = fingerprint(produced.proposals);
      const previousChecks = invalid.get(mark);
      if (previousChecks) {
        state.phase = 'checks';
        state.checks = previousChecks;
        record(state, 'identical', issueCodes(state.checks));
        fail(state, 'IDENTICAL_INVALID_CANDIDATE', 'The model repeated an invalid candidate.');
        break;
      }

      state.phase = 'checks';
      state.checks = await runChecks(state, llm, vocabulary, produced.proposals);
      const decision = decide(state.checks);
      if (decision === 'pass') {
        record(state, 'passed', []);
        state.status = 'READY_FOR_REVIEW';
        state.phase = 'finished';
        break;
      }
      if (decision === 'unavailable') {
        record(state, 'failed', issueCodes(state.checks));
        fail(state, 'REVIEW_UNAVAILABLE', 'A required review is unavailable.');
        break;
      }
      if (decision === 'refused') {
        record(state, 'failed', issueCodes(state.checks));
        fail(state, 'REVIEW_REFUSED', 'A reviewer refused to judge the candidate.');
        break;
      }

      record(state, 'failed', issueCodes(state.checks));
      invalid.set(mark, state.checks);
      const issues = blockingIssues(state.checks);
      if (!tryRevise(state, options, issues)) break;
      feedback = issues;
    }
  } finally {
    clearTimeout(timer);
    state.providerRequests = limits.providerRequests;
  }

  options.logger.info(
    {
      requestId: options.requestId,
      status: state.status,
      candidateVersion: state.candidateVersion,
      revisionCount: state.revisionCount,
      attempts: state.history.length,
      providerRequests: state.providerRequests,
      deadlineAt: state.deadlineAt,
      errorCode: state.error?.code,
      issueCodes: issueCodes(state.checks),
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
  const review = {
    ...llm,
    request: state.request,
    proposals,
  };
  const [age, language] = await settleReviews(reviewAge(review), reviewLanguage(review));
  return [content, age, language];
}

function tryRevise(
  state: GenerationState,
  options: RunOptions,
  issues: readonly ValidationIssue[],
): boolean {
  if (state.revisionCount >= MAX_REVISIONS) {
    fail(
      state,
      'CONTENT_VALIDATION_EXHAUSTED',
      'Unable to produce a valid draft within the configured limits.',
    );
    return false;
  }
  state.revisionCount += 1;
  options.logger.info(
    {
      requestId: options.requestId,
      step: 'revision',
      candidateVersion: state.candidateVersion,
      revisionCount: state.revisionCount,
      issueCodes: issues.map((item) => item.code),
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
      requiresHumanApproval: state.status === 'READY_FOR_REVIEW',
      checks: state.checks,
      proposals: (state.candidate ?? []).map((proposal, index) => ({
        ...proposal,
        localId: `proposal-${index + 1}`,
      })),
    };
  }
  const error = state.error ?? {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
  };
  throw new AppError(httpStatus(error.code), error.code, error.message);
}

function keepFailedResult(state: GenerationState) {
  return (
    state.status === 'FAILED' &&
    state.candidate !== undefined &&
    (state.error?.code === 'REVIEW_UNAVAILABLE' || state.error?.code === 'REVIEW_REFUSED')
  );
}

function fail(state: GenerationState, code: string, message: string) {
  state.status = 'FAILED';
  state.phase = 'finished';
  state.error = { code, message };
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
  return JSON.stringify(proposals);
}

function httpStatus(code: string) {
  if (code === 'MODEL_REFUSED' || code === 'CONTENT_VALIDATION_EXHAUSTED') return 422;
  if (code === 'IDENTICAL_INVALID_CANDIDATE') return 422;
  return 500;
}
