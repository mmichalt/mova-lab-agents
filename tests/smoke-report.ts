import type { ContentRequest } from '../src/content/schemas.ts';
import { assessGeneration, type QualityFinding } from './properties.ts';

export const SMOKE_META_TIMEOUT_MS = 5_000;
export const SMOKE_UNLOAD_TIMEOUT_MS = 15_000;

export type SmokeDraft = {
  httpOk: boolean;
  status: number;
  code: string | null;
  requestId: string | null;
  body: Record<string, unknown> | null;
};

export type SmokeClassification = {
  httpOk: boolean;
  workflowStatus: string | null;
  readyForReview: boolean;
  checksPassed: boolean;
  revisionAssisted: boolean;
  firstAttemptReady: boolean;
  truncated: boolean | null;
  qualities: QualityFinding[] | null;
};

export function classifySmokeRun(request: ContentRequest, draft: SmokeDraft): SmokeClassification {
  const body = draft.body;
  const workflowStatus = typeof body?.status === 'string' ? body.status : null;
  const revisionCount = typeof body?.revisionCount === 'number' ? body.revisionCount : 0;
  const readyForReview = workflowStatus === 'READY_FOR_REVIEW';
  const checksPassed = requiredChecksPassed(body);
  return {
    httpOk: draft.httpOk,
    workflowStatus,
    readyForReview,
    checksPassed,
    revisionAssisted: readyForReview && revisionCount > 0,
    firstAttemptReady: readyForReview && revisionCount === 0 && checksPassed,
    truncated: truncationOf(draft),
    qualities: body ? assessGeneration(request, body) : null,
  };
}

export function smokeSettingsSufficed(runs: readonly SmokeClassification[]) {
  return runs.length > 0 && runs.every((run) => run.firstAttemptReady);
}

export function smokeTruncated(runs: readonly SmokeClassification[]) {
  if (runs.some((run) => run.truncated === true)) return true;
  if (runs.some((run) => run.truncated === null)) return null;
  return false;
}

export function timedOutError(stage: string) {
  return new Error(`${stage} timed out`);
}

export function isTimeoutErr(err: unknown) {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export async function fetchJson(
  url: string | URL,
  stage: string,
  timeoutMs: number,
  init: RequestInit = {},
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    const response = await fetch(url, { ...init, signal });
    const body = (await response.json()) as Record<string, unknown>;
    return { response, body };
  } catch (err) {
    if (isTimeoutErr(err)) throw timedOutError(stage);
    throw err;
  }
}

function requiredChecksPassed(body: Record<string, unknown> | null) {
  const checks = body?.checks;
  if (!Array.isArray(checks)) return false;
  return ['content', 'age', 'language'].every((name) =>
    checks.some(
      (check) =>
        typeof check === 'object' &&
        check !== null &&
        (check as { name?: string; status?: string }).name === name &&
        (check as { status?: string }).status === 'passed',
    ),
  );
}

function truncationOf(draft: SmokeDraft): boolean | null {
  if (draft.code === 'PROVIDER_INCOMPLETE') return true;
  if (incompleteInChecks(draft.body)) return true;
  return null;
}

function incompleteInChecks(body: Record<string, unknown> | null) {
  const checks = body?.checks;
  if (!Array.isArray(checks)) return false;
  return checks.some((check) => {
    if (typeof check !== 'object' || check === null) return false;
    const item = check as { errorCode?: unknown; issues?: unknown };
    if (item.errorCode === 'PROVIDER_INCOMPLETE') return true;
    return (
      Array.isArray(item.issues) &&
      item.issues.some(
        (issue) =>
          typeof issue === 'object' &&
          issue !== null &&
          (issue as { code?: unknown }).code === 'PROVIDER_INCOMPLETE',
      )
    );
  });
}
