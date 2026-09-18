import { type Job, Queue, Worker } from 'bullmq';
import type { Config } from './config.ts';
import { resumeContentGeneration } from './content/runs.ts';
import { AppError } from './errors.ts';
import { clientDisconnected } from './llm/execution.ts';
import type { Logger } from './logger.ts';
import { linksFor, type Observability, rootContext, withSpan } from './observability.ts';
import type { PersistedRun, WorkflowStore } from './persist/store.ts';

export const WORKFLOW_QUEUE_NAME = 'mova-lab-workflows';
export const WORKFLOW_DRAIN_MS = 10_000;
export const MAX_WORKFLOW_DELIVERIES = 3;
export const WORKFLOW_RECONCILE_MS = 5_000;
export const WORKFLOW_RETENTION_MS = 6 * 60 * 60 * 1000;
const WORKFLOW_QUEUE_READY_TIMEOUT_MS = 1_000;

export type WorkflowJobName = 'generation' | 'import';
export type WorkflowJobData = { runId: string; enqueuedAt?: number };

export type WorkflowJobProducer = {
  enqueueGeneration: (runId: string, stateVersion: number) => Promise<void>;
  enqueueImport: (runId: string, stateVersion: number) => Promise<void>;
  reconcile?: (store: WorkflowStore, now?: number) => Promise<number>;
  close: () => Promise<void>;
};

type WorkflowJob = Job<WorkflowJobData, void, WorkflowJobName>;

export function createWorkflowQueue(
  redisUrl: string,
  logger?: Logger,
  queueName = WORKFLOW_QUEUE_NAME,
): WorkflowJobProducer {
  const queue = new Queue<WorkflowJobData, void, WorkflowJobName>(queueName, {
    connection: {
      url: redisUrl,
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    },
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 604_800, count: 1_000 },
    },
  });
  queue.on('error', (err) => logger?.error({ err }, 'queue error'));

  const enqueue = async (name: WorkflowJobName, runId: string, stateVersion: number) => {
    try {
      await waitForQueueReady(queue);
      const jobId = workflowJobId(name, runId, stateVersion);
      const existing = await queue.getJob(jobId);
      if (!existing) {
        await queue.add(name, { runId, enqueuedAt: Date.now() }, { jobId });
      } else {
        const state = await existing.getState();
        if (state === 'failed') await existing.retry('failed');
        if (state === 'completed') {
          await existing.remove();
          await queue.add(name, { runId }, { jobId });
        }
      }
    } catch {
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'Workflow queue is unavailable.');
    }
  };

  return {
    enqueueGeneration: (runId, stateVersion) => enqueue('generation', runId, stateVersion),
    enqueueImport: (runId, stateVersion) => enqueue('import', runId, stateVersion),
    reconcile: async (store, now = Date.now()) => {
      let scheduled = 0;
      for (const run of store.listRunnableRuns(now)) {
        const name = jobNameFor(run, store);
        if (run.deliveryCounts[name] >= MAX_WORKFLOW_DELIVERIES) {
          store.exhaustDeliveries({
            runId: run.id,
            phase: name,
            expectedStateVersion: run.stateVersion,
            now,
          });
          continue;
        }
        await enqueue(name, run.id, run.stateVersion);
        scheduled += 1;
      }
      return scheduled;
    },
    close: () => queue.close(),
  };
}

async function waitForQueueReady(queue: Queue<WorkflowJobData, void, WorkflowJobName>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Workflow queue readiness timed out.')),
          WORKFLOW_QUEUE_READY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createWorkflowWorker(options: {
  config: Config;
  logger: Logger;
  store: WorkflowStore;
  redisUrl: string;
  workerId?: string;
  queueName?: string;
  queue?: WorkflowJobProducer;
  reconcileIntervalMs?: number;
  observability?: Observability;
}) {
  const worker = new Worker<WorkflowJobData, void, WorkflowJobName>(
    options.queueName ?? WORKFLOW_QUEUE_NAME,
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
  const queue = options.queue;
  if (queue?.reconcile) {
    let reconciling = false;
    const reconcile = () => {
      if (reconciling) return;
      reconciling = true;
      void queue
        .reconcile?.(options.store)
        .catch((err) => options.logger.error({ err }, 'workflow reconciliation failed'))
        .finally(() => {
          reconciling = false;
        });
    };
    const reconcileTimer = setInterval(
      reconcile,
      options.reconcileIntervalMs ?? WORKFLOW_RECONCILE_MS,
    );
    reconcileTimer.unref();
    workerTimers.set(worker, reconcileTimer);
    void reconcile();
  }
  const purgeRetention = () => {
    try {
      options.store.purgeRetention({ now: Date.now() });
    } catch (err) {
      options.logger.error({ err }, 'workflow retention purge failed');
    }
  };
  const retentionTimer = setInterval(purgeRetention, WORKFLOW_RETENTION_MS);
  retentionTimer.unref();
  retentionTimers.set(worker, retentionTimer);
  purgeRetention();
  return worker;
}

export async function closeWorkflowWorker(
  worker: ReturnType<typeof createWorkflowWorker>,
  drainMs = WORKFLOW_DRAIN_MS,
) {
  const reconcileTimer = workerTimers.get(worker);
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    workerTimers.delete(worker);
  }
  const retentionTimer = retentionTimers.get(worker);
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimers.delete(worker);
  }
  worker.cancelAllJobs('worker shutdown');
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const closing = worker.close();
  try {
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
          void worker.close(true).then(resolve, resolve);
        }, drainMs);
      }),
    ]);
  } finally {
    if (drainTimer) clearTimeout(drainTimer);
  }
}

async function processWorkflowJob(
  job: WorkflowJob,
  options: Parameters<typeof createWorkflowWorker>[0],
  workerSignal?: AbortSignal,
) {
  const run = options.store.getRun(job.data.runId);
  if (
    !run ||
    run.stateVersion !== jobStateVersion(job) ||
    !isRunnable(run, job.name, Date.now(), options.store)
  ) {
    return;
  }

  const signalController = new AbortController();
  const onWorkerAbort = () => signalController.abort(clientDisconnected());
  if (workerSignal?.aborted) onWorkerAbort();
  else workerSignal?.addEventListener('abort', onWorkerAbort, { once: true });
  try {
    await withSpan(
      options.observability,
      'workflow.job',
      {
        links: linksFor(run.traceContexts),
        attributes: {
          'queue.job_name': job.name,
          'queue.job_id': String(job.id),
          'workflow.id': run.id,
          'queue.wait.ms': Math.max(0, Date.now() - (job.data.enqueuedAt ?? run.updatedAt)),
        },
      },
      async () => {
        await resumeContentGeneration({
          store: options.store,
          config: options.config,
          logger: options.logger,
          requestId: `worker:${job.id}`,
          ownerId: run.ownerId,
          id: run.id,
          signal: signalController.signal,
          canReview: job.name === 'import',
          queueDelivery: { stateVersion: run.stateVersion, phase: job.name },
          observability: options.observability,
        });
        await redeliverIfNeeded(run, job.name, options);
      },
      rootContext(),
    );
  } finally {
    workerSignal?.removeEventListener('abort', onWorkerAbort);
  }
}

async function redeliverIfNeeded(
  previous: PersistedRun,
  name: WorkflowJobName,
  options: Parameters<typeof createWorkflowWorker>[0],
) {
  const latest = options.store.getRun(previous.id);
  if (latest?.status !== 'FAILED' || !retryable(latest.state)) return;
  if (!options.queue) return;
  if (latest.deliveryCounts[name] >= MAX_WORKFLOW_DELIVERIES) {
    options.store.exhaustDeliveries({
      runId: latest.id,
      phase: name,
      expectedStateVersion: latest.stateVersion,
      now: Date.now(),
    });
    return;
  }
  await (name === 'import'
    ? options.queue.enqueueImport(latest.id, latest.stateVersion)
    : options.queue.enqueueGeneration(latest.id, latest.stateVersion));
}

const workerTimers = new WeakMap<object, ReturnType<typeof setInterval>>();
const retentionTimers = new WeakMap<object, ReturnType<typeof setInterval>>();

function workflowJobId(name: WorkflowJobName, runId: string, stateVersion: number) {
  return `${name}-${runId}-${stateVersion}`;
}

function jobStateVersion(job: WorkflowJob) {
  const match = /-(\d+)$/.exec(String(job.id));
  return match ? Number(match[1]) : -1;
}

function jobNameFor(run: PersistedRun, store: WorkflowStore): WorkflowJobName {
  return store.getApproval(run.id)?.decision === 'approved' ? 'import' : 'generation';
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
