import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_VERSION, SQLITE_BUSY_TIMEOUT_MS } from './schema.ts';

export {
  CONSTRAINTS_VERSION,
  SCHEMA_VERSION,
  SQLITE_BUSY_TIMEOUT_MS,
  WORKFLOW_VERSION,
} from './schema.ts';

export class PersistError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'CONSTRAINT';

  constructor(code: PersistError['code'], message: string) {
    super(message);
    this.name = 'PersistError';
    this.code = code;
  }
}

export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'REJECTED'
  | 'COMPLETED'
  | 'FAILED';

export type RunPhase = 'vocabulary' | 'generation' | 'checks' | 'revision' | 'finished' | 'import';

export type PersistedLimits = {
  maxProviderRequests: number;
  maxRevisions: number;
  workflowTimeoutMs: number;
  attemptTimeoutMs: number;
  deadlineAt: number;
  ollamaNumCtx: number;
  ollamaNumPredict: number;
};

export type PersistedConsumed = {
  providerRequests: number;
  revisionCount: number;
};

export type PersistedRun = {
  id: string;
  ownerId: string;
  idempotencyKey: string;
  inputHash: string;
  normalizedInput: unknown;
  status: RunStatus;
  phase: RunPhase;
  stateVersion: number;
  schemaVersion: string;
  workflowVersion: string;
  constraintsVersion: string;
  promptVersions: Record<string, string>;
  modelTag: string | null;
  modelDigest: string | null;
  limits: PersistedLimits;
  consumed: PersistedConsumed;
  state: unknown;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type StepAttemptRecord = {
  id: string;
  runId: string;
  step: string;
  candidateVersion: number | null;
  operationKey: string;
  executionAttempt: number;
  outcome: string;
  startedAt: number;
  finishedAt: number | null;
  usage: unknown;
  error: unknown;
};

export type CandidateRevisionRecord = {
  id: string;
  runId: string;
  candidateVersion: number;
  proposals: unknown;
  checks: unknown;
  createdAt: number;
};

export type ApprovalRecord = {
  runId: string;
  actorId: string;
  candidateVersion: number;
  categoryId: string | null;
  payloadHash: string;
  decision: 'approved' | 'rejected';
  frozenPayload: unknown;
  decidedAt: number;
};

export type ImportReceiptRecord = {
  id: string;
  runId: string;
  proposalLocalId: string;
  importKey: string;
  payloadHash: string;
  contentId: string | null;
  status: 'pending' | 'imported' | 'failed';
  createdAt: number;
};

export type CreateRunInput = {
  ownerId: string;
  idempotencyKey: string;
  normalizedInput: unknown;
  workflowVersion: string;
  constraintsVersion: string;
  promptVersions: Record<string, string>;
  modelTag?: string | null;
  modelDigest?: string | null;
  limits: PersistedLimits;
  now: number;
};

export type CheckpointInput = {
  runId: string;
  expectedStateVersion: number;
  status: RunStatus;
  phase: RunPhase;
  consumed: PersistedConsumed;
  state: unknown;
  now: number;
  claimToken?: string;
  modelTag?: string | null;
  modelDigest?: string | null;
  attempt?: Omit<StepAttemptRecord, 'id' | 'runId'>;
  candidate?: Omit<CandidateRevisionRecord, 'id' | 'runId'>;
};

export type WorkflowStore = {
  path: string;
  createRun: (input: CreateRunInput) => PersistedRun;
  getRun: (id: string) => PersistedRun | undefined;
  getRunByIdempotency: (ownerId: string, idempotencyKey: string) => PersistedRun | undefined;
  listAttempts: (runId: string) => StepAttemptRecord[];
  listCandidates: (runId: string) => CandidateRevisionRecord[];
  getApproval: (runId: string) => ApprovalRecord | undefined;
  listImportReceipts: (runId: string) => ImportReceiptRecord[];
  saveCheckpoint: (input: CheckpointInput) => PersistedRun;
  claimRun: (input: {
    runId: string;
    owner: string;
    now: number;
    leaseMs: number;
  }) => string | undefined;
  recordApproval: (
    input: {
      runId: string;
      actorId: string;
      candidateVersion: number;
      payloadHash: string;
      decidedAt: number;
      expectedStateVersion: number;
    } & (
      | { decision: 'approved'; categoryId: string; frozenPayload: unknown }
      | { decision: 'rejected' }
    ),
  ) => ApprovalRecord;
  saveImportReceipt: (
    input: Omit<ImportReceiptRecord, 'id'> & { id?: string },
  ) => ImportReceiptRecord;
  backupTo: (destinationPath: string) => string;
  sqliteSettings: () => { journalMode: string; foreignKeys: number; busyTimeout: number };
  close: () => void;
};

type RunRow = {
  id: string;
  owner_id: string;
  idempotency_key: string;
  input_hash: string;
  normalized_input: string;
  status: RunStatus;
  phase: RunPhase;
  state_version: number;
  schema_version: string;
  workflow_version: string;
  constraints_version: string;
  prompt_versions: string;
  model_tag: string | null;
  model_digest: string | null;
  limits: string;
  consumed: string;
  state: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export function hashNormalizedInput(value: unknown): string {
  return createHash('sha256').update(jsonText(value)).digest('hex');
}

export function openWorkflowStore(sqlitePath: string): WorkflowStore {
  const path = resolve(sqlitePath);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const getRunStmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const getByKeyStmt = db.prepare('SELECT * FROM runs WHERE owner_id = ? AND idempotency_key = ?');
  const insertRunStmt = db.prepare(`
    INSERT INTO runs (
      id, owner_id, idempotency_key, input_hash, normalized_input, status, phase,
      state_version, schema_version, workflow_version, constraints_version, prompt_versions,
      model_tag, model_digest, limits, consumed, state, created_at, updated_at
    ) VALUES (
      @id, @ownerId, @idempotencyKey, @inputHash, @normalizedInput, 'PENDING', 'vocabulary',
      0, @schemaVersion, @workflowVersion, @constraintsVersion, @promptVersions,
      @modelTag, @modelDigest, @limits, @consumed, @state, @now, @now
    )
  `);
  const updateCheckpointStmt = db.prepare(`
    UPDATE runs SET
      status = @status,
      phase = @phase,
      state_version = state_version + 1,
      consumed = @consumed,
      state = @state,
      model_tag = COALESCE(@modelTag, model_tag),
      model_digest = COALESCE(@modelDigest, model_digest),
      updated_at = @now
    WHERE id = @id AND state_version = @expectedStateVersion
  `);
  const claimStmt = db.prepare(`
    UPDATE runs SET
      lease_owner = @owner,
      lease_token = @token,
      lease_expires_at = @expiresAt,
      status = CASE WHEN status = 'PENDING' THEN 'RUNNING' ELSE status END,
      updated_at = @now
    WHERE id = @id
      AND status IN ('PENDING', 'RUNNING')
      AND (lease_token IS NULL OR lease_expires_at <= @now)
  `);
  const updateApprovalRunStmt = db.prepare(`
    UPDATE runs SET
      status = @status,
      phase = @phase,
      state_version = state_version + 1,
      updated_at = @now
    WHERE id = @id AND status = 'AWAITING_APPROVAL' AND state_version = @expectedStateVersion
  `);
  const insertAttemptStmt = db.prepare(`
    INSERT INTO step_attempts (
      id, run_id, step, candidate_version, operation_key, execution_attempt,
      outcome, started_at, finished_at, usage, error
    ) VALUES (
      @id, @runId, @step, @candidateVersion, @operationKey, @executionAttempt,
      @outcome, @startedAt, @finishedAt, @usage, @error
    )
  `);
  const insertCandidateStmt = db.prepare(`
    INSERT INTO candidate_revisions (
      id, run_id, candidate_version, proposals, checks, created_at
    ) VALUES (@id, @runId, @candidateVersion, @proposals, @checks, @createdAt)
  `);
  const insertApprovalStmt = db.prepare(`
    INSERT INTO approvals (
      run_id, actor_id, candidate_version, category_id, payload_hash,
      decision, frozen_payload, decided_at
    ) VALUES (
      @runId, @actorId, @candidateVersion, @categoryId, @payloadHash,
      @decision, @frozenPayload, @decidedAt
    )
  `);
  const insertReceiptStmt = db.prepare(`
    INSERT INTO import_receipts (
      id, run_id, proposal_local_id, import_key, payload_hash, content_id, status, created_at
    ) VALUES (
      @id, @runId, @proposalLocalId, @importKey, @payloadHash, @contentId, @status, @createdAt
    )
  `);
  const listAttemptsStmt = db.prepare(
    'SELECT * FROM step_attempts WHERE run_id = ? ORDER BY started_at, id',
  );
  const listCandidatesStmt = db.prepare(
    'SELECT * FROM candidate_revisions WHERE run_id = ? ORDER BY candidate_version',
  );
  const getApprovalStmt = db.prepare('SELECT * FROM approvals WHERE run_id = ?');
  const listReceiptsStmt = db.prepare(
    'SELECT * FROM import_receipts WHERE run_id = ? ORDER BY created_at, id',
  );

  const readRun = (id: string) => {
    const row = getRunStmt.get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  };

  const createRun = (input: CreateRunInput) => {
    const id = randomUUID();
    try {
      assertLimits(input.limits);
      insertRunStmt.run({
        id,
        ownerId: input.ownerId,
        idempotencyKey: input.idempotencyKey,
        inputHash: hashNormalizedInput(input.normalizedInput),
        normalizedInput: jsonText(input.normalizedInput),
        schemaVersion: SCHEMA_VERSION,
        workflowVersion: input.workflowVersion,
        constraintsVersion: input.constraintsVersion,
        promptVersions: jsonText(input.promptVersions),
        modelTag: input.modelTag ?? null,
        modelDigest: input.modelDigest ?? null,
        limits: jsonText(input.limits),
        consumed: jsonText({ providerRequests: 0, revisionCount: 0 }),
        state: jsonText({}),
        now: input.now,
      });
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new PersistError('CONFLICT', 'A run with this idempotency key already exists.');
      }
      mapped(err);
    }
    const run = readRun(id);
    if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
    return run;
  };

  const saveCheckpoint = (input: CheckpointInput) =>
    wrap(() => {
      const run = readRun(input.runId);
      if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
      if (run.stateVersion !== input.expectedStateVersion) {
        throw new PersistError('CONFLICT', 'Run state version does not match.');
      }
      if (run.leaseToken && run.leaseToken !== input.claimToken) {
        throw new PersistError('CONFLICT', 'Run claim token does not match.');
      }
      if (!checkpointAllowed(run.status, input.status, input.phase)) {
        throw new PersistError('CONFLICT', 'Run cannot take this checkpoint.');
      }
      assertConsumed(run.consumed, input.consumed, run.limits);
      if (input.attempt && !(input.modelTag ?? run.modelTag)) {
        throw new PersistError('CONSTRAINT', 'A model-derived checkpoint needs a model tag.');
      }
      if (input.attempt) {
        insertAttemptStmt.run({
          id: randomUUID(),
          runId: input.runId,
          step: input.attempt.step,
          candidateVersion: input.attempt.candidateVersion,
          operationKey: input.attempt.operationKey,
          executionAttempt: input.attempt.executionAttempt,
          outcome: input.attempt.outcome,
          startedAt: input.attempt.startedAt,
          finishedAt: input.attempt.finishedAt,
          usage: jsonTextNullable(input.attempt.usage),
          error: jsonTextNullable(input.attempt.error),
        });
      }
      if (input.candidate) {
        insertCandidateStmt.run({
          id: randomUUID(),
          runId: input.runId,
          candidateVersion: input.candidate.candidateVersion,
          proposals: jsonText(input.candidate.proposals),
          checks: jsonText(input.candidate.checks),
          createdAt: input.candidate.createdAt,
        });
      }
      const updated = updateCheckpointStmt.run({
        id: input.runId,
        expectedStateVersion: input.expectedStateVersion,
        status: input.status,
        phase: input.phase,
        consumed: jsonText(input.consumed),
        state: jsonText(input.state),
        modelTag: input.modelTag ?? null,
        modelDigest: input.modelDigest ?? null,
        now: input.now,
      });
      if (updated.changes !== 1) {
        throw new PersistError('CONFLICT', 'Run state version does not match.');
      }
      const next = readRun(input.runId);
      if (!next) throw new PersistError('NOT_FOUND', 'Run not found.');
      return next;
    });

  const claimRun: WorkflowStore['claimRun'] = (input) =>
    wrap(() => {
      const token = randomUUID();
      const result = claimStmt.run({
        id: input.runId,
        owner: input.owner,
        token,
        expiresAt: input.now + input.leaseMs,
        now: input.now,
      });
      return result.changes === 1 ? token : undefined;
    });

  const recordApproval: WorkflowStore['recordApproval'] = (input) =>
    wrap(() => {
      const run = readRun(input.runId);
      if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
      if (run.status !== 'AWAITING_APPROVAL' || run.stateVersion !== input.expectedStateVersion) {
        throw new PersistError('CONFLICT', 'Run is not awaiting this approval.');
      }
      const approved = input.decision === 'approved';
      insertApprovalStmt.run({
        runId: input.runId,
        actorId: input.actorId,
        candidateVersion: input.candidateVersion,
        categoryId: approved ? input.categoryId : null,
        payloadHash: input.payloadHash,
        decision: input.decision,
        frozenPayload: approved ? jsonText(input.frozenPayload) : null,
        decidedAt: input.decidedAt,
      });
      const updated = updateApprovalRunStmt.run({
        id: input.runId,
        expectedStateVersion: input.expectedStateVersion,
        status: approved ? 'RUNNING' : 'REJECTED',
        phase: approved ? 'import' : 'finished',
        now: input.decidedAt,
      });
      if (updated.changes !== 1) {
        throw new PersistError('CONFLICT', 'Run is not awaiting this approval.');
      }
      const approval = mapApproval(getApprovalStmt.get(input.runId) as ApprovalRow);
      return approval;
    });

  const saveImportReceipt: WorkflowStore['saveImportReceipt'] = (input) => {
    const id = input.id ?? randomUUID();
    try {
      insertReceiptStmt.run({
        id,
        runId: input.runId,
        proposalLocalId: input.proposalLocalId,
        importKey: input.importKey,
        payloadHash: input.payloadHash,
        contentId: input.contentId,
        status: input.status,
        createdAt: input.createdAt,
      });
    } catch (err) {
      mapped(err);
    }
    const row = db.prepare('SELECT * FROM import_receipts WHERE id = ?').get(id) as ReceiptRow;
    return mapReceipt(row);
  };

  const checkpointTx = db.transaction(saveCheckpoint);
  const claimTx = db.transaction(claimRun);
  const approvalTx = db.transaction(recordApproval);

  return {
    path,
    createRun,
    getRun: readRun,
    getRunByIdempotency: (ownerId, idempotencyKey) => {
      const row = getByKeyStmt.get(ownerId, idempotencyKey) as RunRow | undefined;
      return row ? mapRun(row) : undefined;
    },
    listAttempts: (runId) => (listAttemptsStmt.all(runId) as AttemptRow[]).map(mapAttempt),
    listCandidates: (runId) => (listCandidatesStmt.all(runId) as CandidateRow[]).map(mapCandidate),
    getApproval: (runId) => {
      const row = getApprovalStmt.get(runId) as ApprovalRow | undefined;
      return row ? mapApproval(row) : undefined;
    },
    listImportReceipts: (runId) => (listReceiptsStmt.all(runId) as ReceiptRow[]).map(mapReceipt),
    saveCheckpoint: (input) => checkpointTx(input),
    claimRun: (input) => claimTx(input),
    recordApproval: (input) => approvalTx(input),
    saveImportReceipt,
    backupTo: (destinationPath) => {
      const dest = resolve(destinationPath);
      mkdirSync(dirname(dest), { recursive: true });
      db.prepare('VACUUM INTO ?').run(dest);
      return dest;
    },
    sqliteSettings: () => ({
      journalMode: String(db.pragma('journal_mode', { simple: true })),
      foreignKeys: Number(db.pragma('foreign_keys', { simple: true })),
      busyTimeout: Number(db.pragma('busy_timeout', { simple: true })),
    }),
    close: () => {
      db.close();
    },
  };
}

export function restoreWorkflowStore(backupPath: string, destinationPath: string): WorkflowStore {
  const dest = resolve(destinationPath);
  mkdirSync(dirname(dest), { recursive: true });
  removeSqliteFiles(dest);
  copyFileSync(resolve(backupPath), dest);
  return openWorkflowStore(dest);
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        Date.now(),
      );
    })();
  }
}

function jsonText(value: unknown): string {
  assertJson(value);
  return JSON.stringify(value);
}

function jsonTextNullable(value: unknown): string | null {
  return value == null ? null : jsonText(value);
}

function assertJson(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PersistError('CONSTRAINT', 'Value is not JSON-serializable.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) {
      if (item === undefined) {
        throw new PersistError('CONSTRAINT', 'Value is not JSON-serializable.');
      }
      assertJson(item);
    }
    return;
  }
  throw new PersistError('CONSTRAINT', 'Value is not JSON-serializable.');
}

function intAtLeast(value: number, min: number) {
  return Number.isInteger(value) && value >= min;
}

function assertLimits(limits: PersistedLimits) {
  if (
    !intAtLeast(limits.maxProviderRequests, 1) ||
    !intAtLeast(limits.maxRevisions, 0) ||
    !intAtLeast(limits.workflowTimeoutMs, 1) ||
    !intAtLeast(limits.attemptTimeoutMs, 1) ||
    !intAtLeast(limits.deadlineAt, 0) ||
    !intAtLeast(limits.ollamaNumCtx, 1) ||
    !intAtLeast(limits.ollamaNumPredict, 1)
  ) {
    throw new PersistError('CONSTRAINT', 'Run limits are invalid.');
  }
}

function assertConsumed(
  previous: PersistedConsumed,
  next: PersistedConsumed,
  limits: PersistedLimits,
) {
  if (
    !intAtLeast(next.providerRequests, previous.providerRequests) ||
    !intAtLeast(next.revisionCount, previous.revisionCount) ||
    next.providerRequests > limits.maxProviderRequests ||
    next.revisionCount > limits.maxRevisions
  ) {
    throw new PersistError('CONSTRAINT', 'Consumed limits are invalid.');
  }
}

function checkpointAllowed(from: RunStatus, to: RunStatus, phase: RunPhase) {
  if (from !== 'PENDING' && from !== 'RUNNING') return false;
  if (to === 'RUNNING') return phase !== 'finished';
  if (to === 'AWAITING_APPROVAL' || to === 'FAILED') return phase === 'finished';
  return false;
}

function removeSqliteFiles(dest: string) {
  for (const extra of ['', '-wal', '-shm', '-journal']) {
    try {
      unlinkSync(`${dest}${extra}`);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
    }
  }
}

function unpack(value: string): unknown {
  return JSON.parse(value);
}

function mapped(err: unknown): never {
  if (err instanceof PersistError) throw err;
  if (err instanceof Database.SqliteError && err.code.startsWith('SQLITE_CONSTRAINT')) {
    throw new PersistError('CONSTRAINT', 'A database constraint was violated.');
  }
  throw err;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    mapped(err);
  }
}

function mapRun(row: RunRow): PersistedRun {
  return {
    id: row.id,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    normalizedInput: unpack(row.normalized_input),
    status: row.status,
    phase: row.phase,
    stateVersion: row.state_version,
    schemaVersion: row.schema_version,
    workflowVersion: row.workflow_version,
    constraintsVersion: row.constraints_version,
    promptVersions: unpack(row.prompt_versions) as Record<string, string>,
    modelTag: row.model_tag,
    modelDigest: row.model_digest,
    limits: unpack(row.limits) as PersistedLimits,
    consumed: unpack(row.consumed) as PersistedConsumed,
    state: unpack(row.state),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type AttemptRow = {
  id: string;
  run_id: string;
  step: string;
  candidate_version: number | null;
  operation_key: string;
  execution_attempt: number;
  outcome: string;
  started_at: number;
  finished_at: number | null;
  usage: string | null;
  error: string | null;
};

function mapAttempt(row: AttemptRow): StepAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    step: row.step,
    candidateVersion: row.candidate_version,
    operationKey: row.operation_key,
    executionAttempt: row.execution_attempt,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usage: row.usage == null ? null : unpack(row.usage),
    error: row.error == null ? null : unpack(row.error),
  };
}

type CandidateRow = {
  id: string;
  run_id: string;
  candidate_version: number;
  proposals: string;
  checks: string;
  created_at: number;
};

function mapCandidate(row: CandidateRow): CandidateRevisionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    candidateVersion: row.candidate_version,
    proposals: unpack(row.proposals),
    checks: unpack(row.checks),
    createdAt: row.created_at,
  };
}

type ApprovalRow = {
  run_id: string;
  actor_id: string;
  candidate_version: number;
  category_id: string | null;
  payload_hash: string;
  decision: 'approved' | 'rejected';
  frozen_payload: string | null;
  decided_at: number;
};

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    runId: row.run_id,
    actorId: row.actor_id,
    candidateVersion: row.candidate_version,
    categoryId: row.category_id,
    payloadHash: row.payload_hash,
    decision: row.decision,
    frozenPayload: row.frozen_payload == null ? null : unpack(row.frozen_payload),
    decidedAt: row.decided_at,
  };
}

type ReceiptRow = {
  id: string;
  run_id: string;
  proposal_local_id: string;
  import_key: string;
  payload_hash: string;
  content_id: string | null;
  status: 'pending' | 'imported' | 'failed';
  created_at: number;
};

function mapReceipt(row: ReceiptRow): ImportReceiptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    proposalLocalId: row.proposal_local_id,
    importKey: row.import_key,
    payloadHash: row.payload_hash,
    contentId: row.content_id,
    status: row.status,
    createdAt: row.created_at,
  };
}
