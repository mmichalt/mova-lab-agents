import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  CONSTRAINTS_VERSION,
  hashNormalizedInput,
  openWorkflowStore,
  PersistError,
  restoreWorkflowStore,
  SCHEMA_VERSION,
  SQLITE_BUSY_TIMEOUT_MS,
  WORKFLOW_VERSION,
  type WorkflowStore,
} from '../src/persist/store.ts';

const promptVersions = {
  vocabulary: 'vocabulary/v1',
  exercises: 'exercises/v1',
  revision: 'revision/v1',
  age: 'age/v1',
  language: 'language/v1',
};

const normalizedInput = {
  ageYears: 7,
  targetSounds: ['р'],
  difficulty: 'easy',
  theme: 'тварини',
  exerciseCount: 6,
};

function tempStore(t: TestContext): WorkflowStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'ag-015-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openWorkflowStore(path.join(dir, 'workflows.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });
  return store;
}

function create(
  store: WorkflowStore,
  overrides: { ownerId?: string; key?: string; now?: number } = {},
) {
  return store.createRun({
    ownerId: overrides.ownerId ?? 'teacher-1',
    idempotencyKey: overrides.key ?? 'key-1',
    normalizedInput,
    workflowVersion: WORKFLOW_VERSION,
    constraintsVersion: CONSTRAINTS_VERSION,
    promptVersions,
    limits: {
      maxProviderRequests: 20,
      maxRevisions: 2,
      workflowTimeoutMs: 600000,
      attemptTimeoutMs: 120000,
      deadlineAt: (overrides.now ?? 1_000) + 600000,
      ollamaNumCtx: 4096,
      ollamaNumPredict: 2000,
    },
    now: overrides.now ?? 1_000,
  });
}

function isPersist(code: PersistError['code']) {
  return (err: unknown) => {
    assert.ok(err instanceof PersistError);
    assert.equal(err.code, code);
    return true;
  };
}

test('opens WAL files with foreign keys, busy timeout, and idempotent migrations', (t) => {
  const store = tempStore(t);
  assert.deepEqual(store.sqliteSettings(), {
    journalMode: 'wal',
    foreignKeys: 1,
    busyTimeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  store.close();
  const reopened = openWorkflowStore(store.path);
  t.after(() => reopened.close());
  const raw = new Database(store.path, { readonly: true });
  t.after(() => raw.close());
  const names = raw.prepare('SELECT name FROM schema_migrations ORDER BY id').all() as {
    name: string;
  }[];
  assert.deepEqual(names, [{ name: '001_workflow_persistence' }]);
});

test('createRun stores serializable versions and consumed limits', (t) => {
  const store = tempStore(t);
  const run = create(store);
  assert.equal(run.status, 'PENDING');
  assert.equal(run.phase, 'vocabulary');
  assert.equal(run.stateVersion, 0);
  assert.equal(run.workflowVersion, WORKFLOW_VERSION);
  assert.equal(run.schemaVersion, SCHEMA_VERSION);
  assert.equal(run.constraintsVersion, CONSTRAINTS_VERSION);
  assert.deepEqual(run.promptVersions, promptVersions);
  assert.deepEqual(run.consumed, { providerRequests: 0, revisionCount: 0 });
  assert.equal(run.inputHash, hashNormalizedInput(normalizedInput));
  assert.deepEqual(run.normalizedInput, normalizedInput);
  assert.deepEqual(run.limits.maxProviderRequests, 20);
  assert.equal(run.leaseToken, null);
});

test('duplicate owner and idempotency key conflict; another owner can reuse the key', (t) => {
  const store = tempStore(t);
  create(store);
  assert.throws(() => create(store), isPersist('CONFLICT'));
  const other = create(store, { ownerId: 'teacher-2' });
  assert.equal(other.ownerId, 'teacher-2');
  assert.equal(store.getRunByIdempotency('teacher-1', 'key-1')?.ownerId, 'teacher-1');
});

test('saveCheckpoint is synchronous and commits attempt, candidate, and status together', (t) => {
  const store = tempStore(t);
  const run = create(store);
  const result = store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'RUNNING',
    phase: 'checks',
    consumed: { providerRequests: 2, revisionCount: 0 },
    state: { vocabulary: { items: [{ word: 'рак', targetSound: 'р' }] } },
    now: 1_500,
    modelTag: 'qwen3:4b-instruct',
    modelDigest: 'digest-1',
    attempt: {
      step: 'vocabulary',
      candidateVersion: null,
      operationKey: 'vocabulary',
      executionAttempt: 1,
      outcome: 'selected',
      startedAt: 1_100,
      finishedAt: 1_400,
      usage: { inputTokens: 10, outputTokens: 4 },
      error: null,
    },
    candidate: {
      candidateVersion: 1,
      proposals: [{ phrase: 'Рак на річці' }],
      checks: [{ name: 'content', status: 'passed' }],
      createdAt: 1_500,
    },
  });
  assert.equal(typeof (result as { then?: unknown }).then, 'undefined');
  assert.equal(result.status, 'RUNNING');
  assert.equal(result.stateVersion, 1);
  assert.deepEqual(result.consumed, { providerRequests: 2, revisionCount: 0 });
  assert.equal(result.modelTag, 'qwen3:4b-instruct');
  assert.equal(store.listAttempts(run.id).length, 1);
  assert.equal(store.listCandidates(run.id)[0]?.candidateVersion, 1);
});

test('a failed candidate insert rolls back the status transition', (t) => {
  const store = tempStore(t);
  const run = create(store);
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'RUNNING',
    phase: 'generation',
    consumed: { providerRequests: 1, revisionCount: 0 },
    state: {},
    now: 1_200,
    candidate: {
      candidateVersion: 1,
      proposals: [{ phrase: 'рак' }],
      checks: [],
      createdAt: 1_200,
    },
  });
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 1,
        status: 'FAILED',
        phase: 'finished',
        consumed: { providerRequests: 2, revisionCount: 1 },
        state: { failed: true },
        now: 1_300,
        candidate: {
          candidateVersion: 1,
          proposals: [{ phrase: 'лама' }],
          checks: [],
          createdAt: 1_300,
        },
      }),
    isPersist('CONSTRAINT'),
  );
  const after = store.getRun(run.id);
  assert.equal(after?.status, 'RUNNING');
  assert.equal(after?.stateVersion, 1);
  assert.deepEqual(after?.state, {});
  assert.equal(store.listCandidates(run.id).length, 1);
});

test('stale state versions and claim tokens cannot checkpoint', (t) => {
  const store = tempStore(t);
  const run = create(store);
  const token = store.claimRun({ runId: run.id, owner: 'worker-a', now: 2_000, leaseMs: 30_000 });
  assert.ok(token);
  assert.equal(store.getRun(run.id)?.status, 'RUNNING');
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'RUNNING',
    phase: 'generation',
    consumed: { providerRequests: 1, revisionCount: 0 },
    state: {},
    now: 2_100,
    claimToken: token,
  });
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 0,
        status: 'FAILED',
        phase: 'finished',
        consumed: { providerRequests: 1, revisionCount: 0 },
        state: {},
        now: 2_200,
        claimToken: token,
      }),
    isPersist('CONFLICT'),
  );
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 1,
        status: 'FAILED',
        phase: 'finished',
        consumed: { providerRequests: 1, revisionCount: 0 },
        state: {},
        now: 2_200,
        claimToken: 'stale-token',
      }),
    isPersist('CONFLICT'),
  );
});

test('concurrent claims over two connections produce one owner', (t) => {
  const store = tempStore(t);
  const run = create(store);
  const other = openWorkflowStore(store.path);
  t.after(() => other.close());
  const first = store.claimRun({ runId: run.id, owner: 'worker-a', now: 3_000, leaseMs: 60_000 });
  const second = other.claimRun({ runId: run.id, owner: 'worker-b', now: 3_000, leaseMs: 60_000 });
  assert.ok(first);
  assert.equal(second, undefined);
  assert.equal(other.getRun(run.id)?.leaseOwner, 'worker-a');
  const expired = other.claimRun({
    runId: run.id,
    owner: 'worker-b',
    now: 3_000 + 60_001,
    leaseMs: 60_000,
  });
  assert.ok(expired);
  assert.equal(other.getRun(run.id)?.leaseOwner, 'worker-b');
});

test('recordApproval commits the decision and status together', (t) => {
  const store = tempStore(t);
  const run = create(store);
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 0,
        status: 'COMPLETED',
        phase: 'import',
        consumed: { providerRequests: 0, revisionCount: 0 },
        state: {},
        now: 3_900,
      }),
    isPersist('CONFLICT'),
  );
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'AWAITING_APPROVAL',
    phase: 'finished',
    consumed: { providerRequests: 4, revisionCount: 0 },
    state: { candidateVersion: 1 },
    now: 4_000,
  });
  assert.throws(
    () =>
      store.recordApproval({
        runId: run.id,
        actorId: 'admin-1',
        candidateVersion: 1,
        payloadHash: 'hash-a',
        decidedAt: 4_100,
        expectedStateVersion: 99,
        decision: 'approved',
        categoryId: 'cat-1',
        frozenPayload: { proposals: [] },
      }),
    isPersist('CONFLICT'),
  );
  assert.equal(store.getApproval(run.id), undefined);
  const approval = store.recordApproval({
    runId: run.id,
    actorId: 'admin-1',
    candidateVersion: 1,
    payloadHash: 'hash-a',
    decidedAt: 4_100,
    expectedStateVersion: 1,
    decision: 'approved',
    categoryId: 'cat-1',
    frozenPayload: { proposals: [{ localId: 'p1' }] },
  });
  assert.equal(approval.decision, 'approved');
  assert.equal(store.getRun(run.id)?.status, 'RUNNING');
  assert.equal(store.getRun(run.id)?.phase, 'import');
  assert.throws(
    () =>
      store.recordApproval({
        runId: run.id,
        actorId: 'admin-1',
        candidateVersion: 1,
        payloadHash: 'hash-a',
        decidedAt: 4_200,
        expectedStateVersion: 2,
        decision: 'rejected',
      }),
    isPersist('CONFLICT'),
  );
  assert.equal(store.getApproval(run.id)?.decision, 'approved');
  const completed = store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 2,
    status: 'COMPLETED',
    phase: 'import',
    consumed: { providerRequests: 4, revisionCount: 0 },
    state: { candidateVersion: 1 },
    now: 4_300,
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.phase, 'import');
});

test('import receipts reject duplicate keys and incomplete imported rows', (t) => {
  const store = tempStore(t);
  const run = create(store);
  store.saveImportReceipt({
    runId: run.id,
    proposalLocalId: 'p1',
    importKey: 'import-p1',
    payloadHash: 'ph-1',
    contentId: 'cms-1',
    status: 'imported',
    createdAt: 5_000,
  });
  assert.throws(
    () =>
      store.saveImportReceipt({
        runId: run.id,
        proposalLocalId: 'p2',
        importKey: 'import-p1',
        payloadHash: 'ph-2',
        contentId: 'cms-2',
        status: 'imported',
        createdAt: 5_100,
      }),
    isPersist('CONSTRAINT'),
  );
  assert.throws(
    () =>
      store.saveImportReceipt({
        runId: run.id,
        proposalLocalId: 'p2',
        importKey: 'import-p2',
        payloadHash: 'ph-2',
        contentId: null,
        status: 'imported',
        createdAt: 5_100,
      }),
    isPersist('CONSTRAINT'),
  );
  assert.equal(store.listImportReceipts(run.id).length, 1);
});

test('schema constraints reject unknown status and orphan attempts', (t) => {
  const store = tempStore(t);
  const raw = new Database(store.path);
  t.after(() => raw.close());
  raw.pragma('foreign_keys = ON');
  assert.throws(() =>
    raw
      .prepare(
        `INSERT INTO runs (
          id, owner_id, idempotency_key, input_hash, normalized_input, status, phase,
          state_version, schema_version, workflow_version, constraints_version, prompt_versions,
          limits, consumed, state, created_at, updated_at
        ) VALUES (
          'r1', 'o', 'k', 'h', '{}', 'PUBLISHED', 'vocabulary', 0, 's', 'v', 'c', '{}',
          '{}', '{}', '{}', 1, 1
        )`,
      )
      .run(),
  );
  assert.throws(() =>
    raw
      .prepare(
        `INSERT INTO step_attempts (
          id, run_id, step, operation_key, execution_attempt, outcome, started_at
        ) VALUES ('a1', 'missing', 'vocabulary', 'vocabulary', 1, 'ok', 1)`,
      )
      .run(),
  );
});

test('close/reopen and backup/restore keep the same run', (t) => {
  const store = tempStore(t);
  const run = create(store, { now: 9_000 });
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'RUNNING',
    phase: 'generation',
    consumed: { providerRequests: 1, revisionCount: 0 },
    state: { step: 'generation' },
    now: 9_100,
  });
  const backup = store.backupTo(path.join(path.dirname(store.path), 'backup.sqlite'));
  store.close();
  const reopened = openWorkflowStore(store.path);
  t.after(() => reopened.close());
  assert.equal(reopened.getRun(run.id)?.stateVersion, 1);
  const used = path.join(path.dirname(store.path), 'used.sqlite');
  writeFileSync(used, 'not-a-database');
  writeFileSync(`${used}-wal`, 'stale-wal');
  writeFileSync(`${used}-shm`, 'stale-shm');
  const restored = restoreWorkflowStore(backup, used);
  t.after(() => restored.close());
  const copy = restored.getRun(run.id);
  assert.equal(copy?.id, run.id);
  assert.equal(copy?.status, 'RUNNING');
  assert.deepEqual(copy?.consumed, { providerRequests: 1, revisionCount: 0 });
  assert.deepEqual(copy?.state, { step: 'generation' });
});

test('restore validates the backup before replacing the live store', (t) => {
  const store = tempStore(t);
  const run = create(store, { now: 10_000 });
  store.close();
  const live = store.path;
  const missing = path.join(path.dirname(live), 'missing.sqlite');
  const junk = path.join(path.dirname(live), 'junk.sqlite');
  writeFileSync(junk, 'not-a-database');
  assert.throws(() => restoreWorkflowStore(missing, live));
  assert.throws(() => restoreWorkflowStore(junk, live));
  const kept = openWorkflowStore(live);
  t.after(() => kept.close());
  assert.equal(kept.getRun(run.id)?.id, run.id);
  assert.equal(kept.getRun(run.id)?.status, 'PENDING');
});

test('rejects lossy JSON, shrinking counters, and checkpoints from terminal runs', (t) => {
  const store = tempStore(t);
  const limits = {
    maxProviderRequests: 20,
    maxRevisions: 2,
    workflowTimeoutMs: 600000,
    attemptTimeoutMs: 120000,
    deadlineAt: 700000,
    ollamaNumCtx: 4096,
    ollamaNumPredict: 2000,
  };
  assert.throws(
    () =>
      store.createRun({
        ownerId: 'teacher-1',
        idempotencyKey: 'lossy',
        normalizedInput: { theme: Number.NaN },
        workflowVersion: WORKFLOW_VERSION,
        constraintsVersion: CONSTRAINTS_VERSION,
        promptVersions,
        limits,
        now: 1_000,
      }),
    isPersist('CONSTRAINT'),
  );
  const run = create(store);
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'RUNNING',
    phase: 'generation',
    consumed: { providerRequests: 2, revisionCount: 0 },
    state: {},
    now: 1_100,
  });
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 1,
        status: 'RUNNING',
        phase: 'generation',
        consumed: { providerRequests: 1, revisionCount: 0 },
        state: {},
        now: 1_200,
      }),
    isPersist('CONSTRAINT'),
  );
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 1,
        status: 'RUNNING',
        phase: 'generation',
        consumed: { providerRequests: 2, revisionCount: 0 },
        state: { n: Number.POSITIVE_INFINITY },
        now: 1_200,
      }),
    isPersist('CONSTRAINT'),
  );
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 1,
        status: 'RUNNING',
        phase: 'generation',
        consumed: { providerRequests: 3, revisionCount: 0 },
        state: {},
        now: 1_200,
        attempt: {
          step: 'vocabulary',
          candidateVersion: null,
          operationKey: 'vocabulary',
          executionAttempt: 1,
          outcome: 'selected',
          startedAt: 1_150,
          finishedAt: 1_180,
          usage: null,
          error: null,
        },
      }),
    isPersist('CONSTRAINT'),
  );
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 1,
    status: 'FAILED',
    phase: 'finished',
    consumed: { providerRequests: 2, revisionCount: 0 },
    state: {},
    now: 1_300,
  });
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 2,
        status: 'RUNNING',
        phase: 'generation',
        consumed: { providerRequests: 2, revisionCount: 0 },
        state: {},
        now: 1_400,
      }),
    isPersist('CONFLICT'),
  );
});
