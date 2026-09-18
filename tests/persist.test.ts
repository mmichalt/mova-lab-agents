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

function awaitApproval(
  store: WorkflowStore,
  run: ReturnType<WorkflowStore['createRun']>,
  now = 4_000,
) {
  return store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: run.stateVersion,
    status: 'AWAITING_APPROVAL',
    phase: 'finished',
    consumed: run.consumed,
    state: { candidateVersion: 1 },
    now,
  });
}

function approveImport(
  store: WorkflowStore,
  run: ReturnType<WorkflowStore['getRun']> & object,
  extras: { now?: number; payloadHash?: string; localId?: string } = {},
) {
  const current = store.getRun(run.id);
  assert.ok(current);
  const localId = extras.localId ?? 'p1';
  return store.recordApproval({
    runId: current.id,
    actorId: 'admin-1',
    candidateVersion: 1,
    payloadHash: extras.payloadHash ?? 'hash-a',
    decidedAt: extras.now ?? 4_100,
    expectedStateVersion: current.stateVersion,
    decision: 'approved',
    categoryId: 'cat-1',
    frozenPayload: { proposals: [{ localId }] },
  });
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
  assert.deepEqual(names, [
    { name: '001_workflow_persistence' },
    { name: '002_run_ollama_version' },
    { name: '003_run_delivery_counts' },
    { name: '004_observability_metadata' },
  ]);
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

test('openRun returns the existing run for the same hash and conflicts on a different hash', (t) => {
  const store = tempStore(t);
  const created = store.openRun({
    ownerId: 'teacher-1',
    idempotencyKey: 'key-1',
    normalizedInput,
    workflowVersion: WORKFLOW_VERSION,
    constraintsVersion: CONSTRAINTS_VERSION,
    promptVersions,
    limits: {
      maxProviderRequests: 20,
      maxRevisions: 2,
      workflowTimeoutMs: 600000,
      attemptTimeoutMs: 120000,
      deadlineAt: 601_000,
      ollamaNumCtx: 4096,
      ollamaNumPredict: 2000,
    },
    now: 1_000,
  });
  assert.equal(created.created, true);
  const again = store.openRun({
    ownerId: 'teacher-1',
    idempotencyKey: 'key-1',
    normalizedInput,
    workflowVersion: WORKFLOW_VERSION,
    constraintsVersion: CONSTRAINTS_VERSION,
    promptVersions,
    limits: created.run.limits,
    now: 1_100,
  });
  assert.equal(again.created, false);
  assert.equal(again.run.id, created.run.id);
  const other = openWorkflowStore(store.path);
  t.after(() => other.close());
  const raced = other.openRun({
    ownerId: 'teacher-1',
    idempotencyKey: 'key-1',
    normalizedInput,
    workflowVersion: WORKFLOW_VERSION,
    constraintsVersion: CONSTRAINTS_VERSION,
    promptVersions,
    limits: created.run.limits,
    now: 1_200,
  });
  assert.equal(raced.run.id, created.run.id);
  assert.throws(
    () =>
      store.openRun({
        ownerId: 'teacher-1',
        idempotencyKey: 'key-1',
        normalizedInput: { ...normalizedInput, theme: 'їжа' },
        workflowVersion: WORKFLOW_VERSION,
        constraintsVersion: CONSTRAINTS_VERSION,
        promptVersions,
        limits: created.run.limits,
        now: 1_300,
      }),
    isPersist('CONFLICT'),
  );
  assert.deepEqual(store.getRun(created.run.id)?.normalizedInput, normalizedInput);
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

test('heartbeats extend a lease and expired owners cannot checkpoint', (t) => {
  const store = tempStore(t);
  const token = store.claimRun({
    runId: create(store).id,
    owner: 'worker-a',
    now: 1_000,
    leaseMs: 100,
  });
  assert.ok(token);
  const run = store.getRunByIdempotency('teacher-1', 'key-1');
  assert.ok(run);
  assert.equal(
    store.heartbeatRun({
      runId: run.id,
      owner: 'worker-a',
      claimToken: token,
      now: 1_050,
      leaseMs: 100,
    }),
    true,
  );
  assert.equal(store.getRun(run.id)?.leaseExpiresAt, 1_150);
  assert.equal(
    store.heartbeatRun({
      runId: run.id,
      owner: 'worker-a',
      claimToken: token,
      now: 1_150,
      leaseMs: 100,
    }),
    false,
  );
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 0,
        status: 'RUNNING',
        phase: 'generation',
        consumed: { providerRequests: 0, revisionCount: 0 },
        state: {},
        now: 1_151,
        claimToken: token,
      }),
    isPersist('CONFLICT'),
  );
});

test('retryable failures can be claimed back into active execution', (t) => {
  const store = tempStore(t);
  const run = create(store);
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'FAILED',
    phase: 'finished',
    consumed: { providerRequests: 1, revisionCount: 0 },
    state: { error: { code: 'PROVIDER_UNAVAILABLE', retryable: true } },
    now: 1_100,
    modelTag: 'qwen3:4b-instruct',
  });
  const token = store.claimRun({ runId: run.id, owner: 'worker-a', now: 2_000, leaseMs: 100 });
  assert.ok(token);
  assert.equal(store.getRun(run.id)?.status, 'RUNNING');
  const resumed = store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 1,
    status: 'RUNNING',
    phase: 'generation',
    consumed: { providerRequests: 1, revisionCount: 0 },
    state: {},
    now: 2_010,
    claimToken: token,
    modelTag: 'qwen3:4b-instruct',
  });
  assert.equal(resumed.status, 'RUNNING');
});

test('queue delivery counts survive expiry and become a persisted failure at three', (t) => {
  const store = tempStore(t);
  const run = create(store);
  for (const now of [1_000, 1_100, 1_200]) {
    assert.ok(
      store.claimRun({
        runId: run.id,
        owner: `worker-${now}`,
        now,
        leaseMs: 50,
        expectedStateVersion: 0,
        deliveryPhase: 'generation',
      }),
    );
  }
  assert.deepEqual(store.getRun(run.id)?.deliveryCounts, { generation: 3, import: 0 });
  assert.equal(
    store.claimRun({
      runId: run.id,
      owner: 'worker-4',
      now: 1_300,
      leaseMs: 50,
      expectedStateVersion: 0,
      deliveryPhase: 'generation',
    }),
    undefined,
  );
  const exhausted = store.exhaustDeliveries({
    runId: run.id,
    phase: 'generation',
    expectedStateVersion: 0,
    now: 1_300,
  });
  assert.ok(exhausted);
  assert.equal(exhausted?.status, 'FAILED');
  assert.equal(exhausted?.stateVersion, 1);
  assert.deepEqual((exhausted.state as { error: unknown }).error, {
    code: 'QUEUE_DELIVERY_EXHAUSTED',
    message: 'Workflow delivery limit was exhausted.',
    retryable: false,
  });
  assert.deepEqual(store.listRunnableRuns(2_000), []);
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
  assert.throws(
    () =>
      store.saveCheckpoint({
        runId: run.id,
        expectedStateVersion: 2,
        status: 'COMPLETED',
        phase: 'import',
        consumed: { providerRequests: 4, revisionCount: 0 },
        state: { candidateVersion: 1 },
        now: 4_300,
      }),
    isPersist('CONFLICT'),
  );
  assert.equal(store.getRun(run.id)?.status, 'RUNNING');
});

test('completeImport requires a live claim and every frozen imported receipt', (t) => {
  const store = tempStore(t);
  const created = create(store);
  approveImport(store, awaitApproval(store, created));
  const importing = store.getRun(created.id);
  assert.ok(importing);
  const claimToken = store.claimRun({
    runId: importing.id,
    owner: 'importer',
    now: 4_300,
    leaseMs: 1_000,
  });
  assert.ok(claimToken);
  const complete = (runId: string, token: string, now: number, consumed = importing.consumed) =>
    store.completeImport({
      runId,
      claimToken: token,
      now,
      consumed,
      state: { status: 'COMPLETED' },
    });
  assert.throws(() => complete(importing.id, 'missing', 4_300), isPersist('CONFLICT'));
  assert.throws(() => complete(importing.id, claimToken, 4_310), isPersist('CONSTRAINT'));
  store.saveImportReceipt({
    runId: importing.id,
    proposalLocalId: 'p1',
    importKey: `${importing.id}:p1`,
    payloadHash: 'wrong-hash',
    contentId: 'cms-1',
    status: 'imported',
    createdAt: 4_320,
    claimToken,
    now: 4_320,
  });
  assert.throws(() => complete(importing.id, claimToken, 4_330), isPersist('CONSTRAINT'));

  const second = create(store, { key: 'key-2' });
  approveImport(store, awaitApproval(store, second, 5_000), { now: 5_100 });
  const other = store.getRun(second.id);
  assert.ok(other);
  const staleToken = store.claimRun({
    runId: other.id,
    owner: 'importer',
    now: 5_200,
    leaseMs: 50,
  });
  assert.ok(staleToken);
  store.saveImportReceipt({
    runId: other.id,
    proposalLocalId: 'p1',
    importKey: `${other.id}:p1`,
    payloadHash: 'hash-a',
    contentId: null,
    status: 'failed',
    createdAt: 5_210,
    claimToken: staleToken,
    now: 5_210,
  });
  assert.throws(
    () => complete(other.id, staleToken, 5_220, other.consumed),
    isPersist('CONSTRAINT'),
  );
  store.updateImportReceipt({
    runId: other.id,
    proposalLocalId: 'p1',
    payloadHash: 'hash-a',
    contentId: 'cms-1',
    status: 'imported',
    claimToken: staleToken,
    now: 5_230,
  });
  assert.throws(() => complete(other.id, staleToken, 5_300, other.consumed), isPersist('CONFLICT'));
  const liveToken = store.claimRun({
    runId: other.id,
    owner: 'importer-2',
    now: 5_301,
    leaseMs: 1_000,
  });
  assert.ok(liveToken);
  const completed = complete(other.id, liveToken, 5_310, other.consumed);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.phase, 'import');
});

test('import receipts reject duplicate keys and incomplete imported rows', (t) => {
  const store = tempStore(t);
  const run = create(store);
  const claimToken = store.claimRun({
    runId: run.id,
    owner: 'importer',
    now: 4_900,
    leaseMs: 1_000,
  });
  assert.ok(claimToken);
  store.saveImportReceipt({
    runId: run.id,
    proposalLocalId: 'p1',
    importKey: 'import-p1',
    payloadHash: 'ph-1',
    contentId: 'cms-1',
    status: 'imported',
    createdAt: 5_000,
    claimToken,
    now: 5_000,
  });
  assert.throws(
    () =>
      store.updateImportReceipt({
        runId: run.id,
        proposalLocalId: 'p1',
        payloadHash: 'ph-1',
        contentId: 'cms-1b',
        status: 'imported',
        claimToken,
        now: 5_000,
      }),
    isPersist('CONFLICT'),
  );
  assert.throws(
    () =>
      store.updateImportReceipt({
        runId: run.id,
        proposalLocalId: 'p1',
        payloadHash: 'changed',
        contentId: 'cms-1c',
        status: 'imported',
        claimToken,
        now: 5_000,
      }),
    isPersist('CONFLICT'),
  );
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
        claimToken,
        now: 5_100,
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
        claimToken,
        now: 5_100,
      }),
    isPersist('CONSTRAINT'),
  );
  assert.equal(store.listImportReceipts(run.id).length, 1);
});

test('stale import executors cannot overwrite newer receipts after lease expiry', (t) => {
  const store = tempStore(t);
  const created = create(store);
  approveImport(store, awaitApproval(store, created, 4_000), { now: 4_100 });
  const run = store.getRun(created.id);
  assert.ok(run);
  const oldToken = store.claimRun({
    runId: run.id,
    owner: 'old-importer',
    now: 5_000,
    leaseMs: 100,
  });
  assert.ok(oldToken);
  store.saveImportReceipt({
    runId: run.id,
    proposalLocalId: 'p1',
    importKey: `${run.id}:p1`,
    payloadHash: 'hash-a',
    contentId: null,
    status: 'pending',
    createdAt: 5_000,
    claimToken: oldToken,
    now: 5_000,
  });
  assert.throws(
    () =>
      store.saveImportReceipt({
        runId: run.id,
        proposalLocalId: 'p2',
        importKey: `${run.id}:p2`,
        payloadHash: 'hash-a',
        contentId: null,
        status: 'pending',
        createdAt: 5_200,
        claimToken: oldToken,
        now: 5_101,
      }),
    isPersist('CONFLICT'),
  );

  const other = openWorkflowStore(store.path);
  t.after(() => other.close());
  const newToken = other.claimRun({
    runId: run.id,
    owner: 'new-importer',
    now: 5_101,
    leaseMs: 1_000,
  });
  assert.ok(newToken);
  other.updateImportReceipt({
    runId: run.id,
    proposalLocalId: 'p1',
    payloadHash: 'hash-a',
    contentId: 'cms-1',
    status: 'imported',
    claimToken: newToken,
    now: 5_150,
  });
  other.completeImport({
    runId: run.id,
    claimToken: newToken,
    now: 5_160,
    consumed: run.consumed,
    state: { status: 'COMPLETED' },
  });

  assert.throws(
    () =>
      store.updateImportReceipt({
        runId: run.id,
        proposalLocalId: 'p1',
        payloadHash: 'hash-a',
        contentId: 'cms-stale',
        status: 'imported',
        claimToken: oldToken,
        now: 5_200,
      }),
    isPersist('CONFLICT'),
  );
  assert.throws(
    () =>
      store.updateImportReceipt({
        runId: run.id,
        proposalLocalId: 'p1',
        payloadHash: 'hash-a',
        contentId: null,
        status: 'failed',
        claimToken: oldToken,
        now: 5_200,
      }),
    isPersist('CONFLICT'),
  );
  const receipt = store.listImportReceipts(run.id)[0];
  assert.equal(receipt?.status, 'imported');
  assert.equal(receipt?.contentId, 'cms-1');
  assert.equal(store.getRun(run.id)?.status, 'COMPLETED');
});

test('reserveAttempt spends budget before I/O and unknown outcomes survive reopen', (t) => {
  const store = tempStore(t);
  const run = create(store, { now: 8_000 });
  const token = store.claimRun({
    runId: run.id,
    owner: 'worker-a',
    now: 8_000,
    leaseMs: 1_000,
  });
  assert.ok(token);
  const reserved = store.reserveAttempt({
    runId: run.id,
    claimToken: token,
    step: 'vocabulary',
    candidateVersion: null,
    operationKey: 'vocabulary:0',
    startedAt: 8_010,
  });
  assert.equal(reserved.executionAttempt, 1);
  assert.equal(store.getRun(run.id)?.consumed.providerRequests, 1);
  const unknown = store.listAttempts(run.id)[0];
  assert.equal(unknown?.outcome, 'unknown');
  assert.equal(unknown?.finishedAt, null);

  const sqlitePath = store.path;
  store.close();
  const reopened = openWorkflowStore(sqlitePath);
  t.after(() => reopened.close());
  assert.equal(reopened.getRun(run.id)?.consumed.providerRequests, 1);
  assert.equal(reopened.listAttempts(run.id)[0]?.outcome, 'unknown');

  const resume = reopened.claimRun({
    runId: run.id,
    owner: 'worker-b',
    now: 9_100,
    leaseMs: 1_000,
  });
  assert.ok(resume);
  assert.throws(
    () =>
      reopened.finishAttempt({
        runId: run.id,
        claimToken: token,
        reservation: reserved,
        finishedAt: 9_200,
        outcome: 'completed',
        usage: { inputTokens: 4 },
        error: null,
      }),
    isPersist('CONFLICT'),
  );
  assert.equal(reopened.listAttempts(run.id)[0]?.outcome, 'unknown');
  assert.equal(reopened.getRun(run.id)?.consumed.providerRequests, 1);

  const retried = reopened.reserveAttempt({
    runId: run.id,
    claimToken: resume,
    step: 'vocabulary',
    candidateVersion: null,
    operationKey: 'vocabulary:0',
    startedAt: 9_210,
  });
  reopened.finishAttempt({
    runId: run.id,
    claimToken: resume,
    reservation: retried,
    finishedAt: 9_220,
    outcome: 'completed',
    usage: {
      model: 'qwen3:4b-instruct',
      inputTokens: 10,
      modelDigest: 'digest-1',
      ollamaVersion: '0.33.3',
    },
    error: null,
    modelTag: 'qwen3:4b-instruct',
    modelDigest: 'digest-1',
  });
  const finished = reopened.listAttempts(run.id);
  assert.equal(finished[0]?.outcome, 'unknown');
  assert.equal(finished[1]?.outcome, 'completed');
  assert.deepEqual(finished[1]?.error, null);
  assert.equal(reopened.getRun(run.id)?.consumed.providerRequests, 2);
  assert.equal(reopened.getRun(run.id)?.modelDigest, 'digest-1');
  assert.equal(reopened.getRun(run.id)?.modelTag, 'qwen3:4b-instruct');
});

test('finishAttempt records sanitized errors and expired owners cannot complete a reservation', (t) => {
  const store = tempStore(t);
  const run = create(store);
  const token = store.claimRun({
    runId: run.id,
    owner: 'worker-a',
    now: 1_000,
    leaseMs: 100,
  });
  assert.ok(token);
  const reserved = store.reserveAttempt({
    runId: run.id,
    claimToken: token,
    step: 'generation',
    candidateVersion: 1,
    operationKey: 'generation:1',
    startedAt: 1_010,
  });
  store.finishAttempt({
    runId: run.id,
    claimToken: token,
    reservation: reserved,
    finishedAt: 1_020,
    outcome: 'failed',
    usage: null,
    error: { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true },
  });
  const attempt = store.listAttempts(run.id)[0];
  assert.equal(attempt?.outcome, 'failed');
  assert.deepEqual(attempt?.error, {
    code: 'PROVIDER_UNAVAILABLE',
    status: 503,
    retryable: true,
  });

  const next = store.reserveAttempt({
    runId: run.id,
    claimToken: token,
    step: 'generation',
    candidateVersion: 1,
    operationKey: 'generation:1',
    startedAt: 1_030,
  });
  assert.throws(
    () =>
      store.finishAttempt({
        runId: run.id,
        claimToken: token,
        reservation: next,
        finishedAt: 1_101,
        outcome: 'completed',
        usage: { inputTokens: 2 },
        error: null,
        modelDigest: 'digest-late',
      }),
    isPersist('CONFLICT'),
  );
  assert.equal(store.listAttempts(run.id)[1]?.outcome, 'unknown');
  assert.equal(store.getRun(run.id)?.consumed.providerRequests, 2);
  assert.equal(store.getRun(run.id)?.modelDigest, null);
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
