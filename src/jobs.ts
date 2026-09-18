import { type Job, Queue, Worker } from 'bullmq';
import type { Config } from './config.ts';
import { resumeContentGeneration } from './content/runs.ts';
import { AppError } from './errors.ts';
import { clientDisconnected } from './llm/execution.ts';
import type { Logger } from './logger.ts';
import type { PersistedRun, WorkflowStore } from './persist/store.ts';

export const WORKFLOW_QUEUE_NAME = 'mova-lab-workflows';
export const WORKFLOW_DRAIN_MS = 10_000;

export type WorkflowJobName = 'generation' | 'import';
export type WorkflowJobData = { runId: string };

export type WorkflowJobProducer = {
  enqueueGeneration: (runId: string, stateVersion: number) => Promise<void>;
  enqueueImport: (runId: string, stateVersion: number) => Promise<void>;
  close: () => Promise<void>;
};

type WorkflowJob = Job<WorkflowJobData, void, WorkflowJobName>;

export function createWorkflowQueue(redisUrl: string, logger?: Logger): WorkflowJobProducer {
  const queue = new Queue<WorkflowJobData, void, WorkflowJobName>(WORKFLOW_QUEUE_NAME, {
    connection: { url: redisUrl },
    skipWaitingForReady: true,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 1_000 },
    },
  });
  queue.on('error', (err) => logger?.error({ err }, 'queue error'));

  const enqueue = async (name: WorkflowJobName, runId: string, stateVersion: number) => {
    try {
      await queue.add(name, { runId }, { jobId: `${name}-${runId}-${stateVersion}` });
    } catch {
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'Workflow queue is unavailable.');
    }
  };

  return {
    enqueueGeneration: (runId, stateVersion) => enqueue('generation', runId, stateVersion),
    enqueueImport: (runId, stateVersion) => enqueue('import', runId, stateVersion),
    close: () => queue.close(),
  };
}

export function createWorkflowWorker(options: {
  config: Config;
  logger: Logger;
  store: WorkflowStore;
  redisUrl: string;
  workerId?: string;
}) {
  const worker = new Worker<WorkflowJobData, void, WorkflowJobName>(
    WORKFLOW_QUEUE_NAME,
    async (job, _token, signal) => {
      await processWorkflowJob(job, options, signal);
    },
    {
      connection: { url: options.redisUrl },
      concurrency: 1,
      name: options.workerId ?? 'mova-lab-worker',
    },
  );
  worker.on('completed', (job) => {
    options.logger.info(
      { jobId: job.id, jobName: job.name, runId: job.data.runId },
      'job completed',
    );
  });
  worker.on('failed', (job, err) => {
    options.logger.error(
      { err, jobId: job?.id, jobName: job?.name, runId: job?.data.runId },
      'job failed',
    );
  });
  worker.on('error', (err) => options.logger.error({ err }, 'worker error'));
  return worker;
}

export async function closeWorkflowWorker(
  worker: ReturnType<typeof createWorkflowWorker>,
  drainMs = WORKFLOW_DRAIN_MS,
) {
  worker.cancelAllJobs('worker shutdown');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = worker.close();
  try {
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          void worker.close(true).then(resolve, resolve);
        }, drainMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processWorkflowJob(
  job: WorkflowJob,
  options: Parameters<typeof createWorkflowWorker>[0],
  workerSignal?: AbortSignal,
) {
  const run = options.store.getRun(job.data.runId);
  if (!run || !isRunnable(run, job.name, Date.now(), options.store)) return;

  const signalController = new AbortController();
  const onWorkerAbort = () => signalController.abort(clientDisconnected());
  if (workerSignal?.aborted) onWorkerAbort();
  else workerSignal?.addEventListener('abort', onWorkerAbort, { once: true });
  try {
    await resumeContentGeneration({
      store: options.store,
      config: options.config,
      logger: options.logger,
      requestId: `worker:${job.id}`,
      ownerId: run.ownerId,
      id: run.id,
      signal: signalController.signal,
      canReview: job.name === 'import',
    });
  } finally {
    workerSignal?.removeEventListener('abort', onWorkerAbort);
  }
}

function isRunnable(run: PersistedRun, name: WorkflowJobName, now: number, store: WorkflowStore) {
  const approval = store.getApproval(run.id);
  if (name === 'import') {
    return (
      approval?.decision === 'approved' &&
      ((run.status === 'RUNNING' &&
        run.phase === 'import' &&
        (run.leaseExpiresAt === null || run.leaseExpiresAt <= now)) ||
        (run.status === 'FAILED' && retryable(run.state)))
    );
  }
  return (
    approval === undefined &&
    ((run.status === 'PENDING' && run.phase !== 'import') ||
      (run.status === 'RUNNING' &&
        run.phase !== 'import' &&
        (run.leaseExpiresAt === null || run.leaseExpiresAt <= now)) ||
      (run.status === 'FAILED' && retryable(run.state)))
  );
}

function retryable(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === true
  );
}
