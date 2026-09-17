import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
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
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'CONSTRAINT' | 'BUDGET';

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

export type AttemptReservation = {
  id: string;
  executionAttempt: number;
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

export type ClaimInput = {
  runId: string;
  owner: string;
  now: number;
  leaseMs: number;
};

export type OpenedRun = {
  run: PersistedRun;
  created: boolean;
};

export type WorkflowStore = {
  path: string;
  createRun: (input: CreateRunInput) => PersistedRun;
  openRun: (input: CreateRunInput) => OpenedRun;
  getRun: (id: string) => PersistedRun | undefined;
  getRunByIdempotency: (ownerId: string, idempotencyKey: string) => PersistedRun | undefined;
  ping: () => void;
  listAttempts: (runId: string) => StepAttemptRecord[];
  listCandidates: (runId: string) => CandidateRevisionRecord[];
  getApproval: (runId: string) => ApprovalRecord | undefined;
  listImportReceipts: (runId: string) => ImportReceiptRecord[];
  saveCheckpoint: (input: CheckpointInput) => PersistedRun;
  claimRun: (input: ClaimInput) => string | undefined;
  heartbeatRun: (input: ClaimInput & { claimToken: string }) => boolean;
  reserveAttempt: (input: {
    runId: string;
    claimToken: string;
    step: string;
    candidateVersion: number | null;
    operationKey: string;
    startedAt: number;
  }) => AttemptReservation;
  finishAttempt: (input: {
    runId: string;
    claimToken: string;
    reservation: AttemptReservation;
    finishedAt: number;
    outcome: string;
    usage: unknown;
    error: unknown;
    modelTag?: string | null;
    modelDigest?: string | null;
  }) => void;
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
    input: Omit<ImportReceiptRecord, 'id'> & {
      id?: string;
      claimToken: string;
      now: number;
    },
  ) => ImportReceiptRecord;
  updateImportReceipt: (input: {
    runId: string;
    proposalLocalId: string;
    payloadHash: string;
    contentId: string | null;
    status: ImportReceiptRecord['status'];
    claimToken: string;
    now: number;
  }) => ImportReceiptRecord;
  completeImport: (input: {
    runId: string;
    claimToken: string;
    now: number;
    consumed: PersistedConsumed;
    state: unknown;
  }) => PersistedRun;
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
      lease_owner = CASE
        WHEN @status IN ('AWAITING_APPROVAL', 'FAILED', 'COMPLETED') THEN NULL
        ELSE lease_owner
      END,
      lease_token = CASE
        WHEN @status IN ('AWAITING_APPROVAL', 'FAILED', 'COMPLETED') THEN NULL
        ELSE lease_token
      END,
      lease_expires_at = CASE
        WHEN @status IN ('AWAITING_APPROVAL', 'FAILED', 'COMPLETED') THEN NULL
        ELSE lease_expires_at
      END,
      updated_at = @now
    WHERE id = @id
      AND state_version = @expectedStateVersion
      AND (
        (@claimToken IS NULL AND lease_token IS NULL)
        OR (
          @claimToken IS NOT NULL
          AND lease_token = @claimToken
          AND lease_expires_at > @now
        )
      )
  `);
  const claimStmt = db.prepare(`
    UPDATE runs SET
      lease_owner = @owner,
      lease_token = @token,
      lease_expires_at = @expiresAt,
      status = CASE WHEN status IN ('PENDING', 'FAILED') THEN 'RUNNING' ELSE status END,
      phase = CASE WHEN status = 'FAILED' THEN 'checks' ELSE phase END,
      updated_at = @now
    WHERE id = @id
      AND (
        status IN ('PENDING', 'RUNNING')
        OR (status = 'FAILED' AND json_extract(state, '$.error.retryable') = 1)
      )
      AND (lease_token IS NULL OR lease_expires_at <= @now)
  `);
  const heartbeatStmt = db.prepare(`
    UPDATE runs SET
      lease_expires_at = @expiresAt,
      updated_at = @now
    WHERE id = @id
      AND status = 'RUNNING'
      AND lease_token = @token
      AND lease_expires_at > @now
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
  const nextAttemptStmt = db.prepare(
    'SELECT COALESCE(MAX(execution_attempt), 0) + 1 AS next_attempt FROM step_attempts WHERE run_id = ? AND operation_key = ?',
  );
  const reserveAttemptRunStmt = db.prepare(`
    UPDATE runs SET
      consumed = json_set(consumed, '$.providerRequests', json_extract(consumed, '$.providerRequests') + 1),
      updated_at = @startedAt
    WHERE id = @runId
      AND lease_token = @claimToken
      AND lease_expires_at > @startedAt
      AND status = 'RUNNING'
      AND json_extract(consumed, '$.providerRequests') < json_extract(limits, '$.maxProviderRequests')
  `);
  const finishAttemptStmt = db.prepare(`
    UPDATE step_attempts SET
      outcome = @outcome,
      finished_at = @finishedAt,
      usage = @usage,
      error = @error
    WHERE id = @id
      AND run_id = @runId
      AND outcome = 'unknown'
      AND EXISTS (
        SELECT 1 FROM runs
        WHERE runs.id = @runId
          AND runs.lease_token = @claimToken
          AND runs.lease_expires_at > @finishedAt
      )
  `);
  const finishAttemptRunStmt = db.prepare(`
    UPDATE runs SET
      model_tag = COALESCE(@modelTag, model_tag),
      model_digest = COALESCE(@modelDigest, model_digest),
      updated_at = @finishedAt
    WHERE id = @runId
      AND lease_token = @claimToken
      AND lease_expires_at > @finishedAt
  `);
  const insertCandidateStmt = db.prepare(`
    INSERT INTO candidate_revisions (
      id, run_id, candidate_version, proposals, checks, created_at
    ) VALUES (@id, @runId, @candidateVersion, @proposals, @checks, @createdAt)
    ON CONFLICT (run_id, candidate_version) DO UPDATE SET
      checks = excluded.checks
    WHERE candidate_revisions.proposals = excluded.proposals
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

  const reused = (existing: PersistedRun, inputHash: string) => {
    if (existing.inputHash !== inputHash) {
      throw new PersistError('CONFLICT', 'Idempotency key was reused with a different request.');
    }
    return { run: existing, created: false };
  };

  const openRun = (input: CreateRunInput): OpenedRun => {
    const inputHash = hashNormalizedInput(input.normalizedInput);
    const existing = getByKeyStmt.get(input.ownerId, input.idempotencyKey) as RunRow | undefined;
    if (existing) return reused(mapRun(existing), inputHash);
    try {
      return { run: createRun(input), created: true };
    } catch (err) {
      if (err instanceof PersistError && err.code === 'CONFLICT') {
        const raced = getByKeyStmt.get(input.ownerId, input.idempotencyKey) as RunRow | undefined;
        if (raced) return reused(mapRun(raced), inputHash);
      }
      throw err;
    }
  };

  const saveCheckpoint = (input: CheckpointInput) =>
    wrap(() => {
      const run = readRun(input.runId);
      if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
      if (run.stateVersion !== input.expectedStateVersion) {
        throw new PersistError('CONFLICT', 'Run state version does not match.');
      }
      if (
        run.leaseToken &&
        (run.leaseToken !== input.claimToken || (run.leaseExpiresAt ?? 0) <= input.now)
      ) {
        throw new PersistError('CONFLICT', 'Run claim token does not match.');
      }
      if (!checkpointAllowed(run.status, input.status, input.phase)) {
        throw new PersistError('CONFLICT', 'Run cannot take this checkpoint.');
      }
      if (run.modelTag && input.modelTag && run.modelTag !== input.modelTag) {
        throw new PersistError('CONSTRAINT', 'Run model tag changed.');
      }
      if (run.modelDigest && input.modelDigest && run.modelDigest !== input.modelDigest) {
        throw new PersistError('CONSTRAINT', 'Run model digest changed.');
      }
      assertConsumed(run.consumed, input.consumed, run.limits);
      if (input.attempt && !(input.modelTag ?? run.modelTag)) {
        throw new PersistError('CONSTRAINT', 'A model-derived checkpoint needs a model tag.');
      }
      if (input.attempt && !(input.modelDigest ?? run.modelDigest)) {
        throw new PersistError('CONSTRAINT', 'A model-derived checkpoint needs a model digest.');
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
        const candidate = insertCandidateStmt.run({
          id: randomUUID(),
          runId: input.runId,
          candidateVersion: input.candidate.candidateVersion,
          proposals: jsonText(input.candidate.proposals),
          checks: jsonText(input.candidate.checks),
          createdAt: input.candidate.createdAt,
        });
        if (candidate.changes !== 1) {
          throw new PersistError('CONSTRAINT', 'Candidate revision could not be saved.');
        }
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
        claimToken: input.claimToken ?? null,
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

  const heartbeatRun: WorkflowStore['heartbeatRun'] = (input) =>
    wrap(
      () =>
        heartbeatStmt.run({
          id: input.runId,
          token: input.claimToken,
          expiresAt: input.now + input.leaseMs,
          now: input.now,
        }).changes === 1,
    );

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

  const saveImportReceipt: WorkflowStore['saveImportReceipt'] = (input) =>
    wrap(() => {
      const run = readRun(input.runId);
      if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
      assertClaim(run, input.claimToken, input.now);
      const existing = db
        .prepare('SELECT * FROM import_receipts WHERE run_id = ? AND proposal_local_id = ?')
        .get(input.runId, input.proposalLocalId) as ReceiptRow | undefined;
      if (existing) {
        if (
          existing.import_key === input.importKey &&
          existing.payload_hash === input.payloadHash
        ) {
          return mapReceipt(existing);
        }
        throw new PersistError('CONFLICT', 'Import receipt does not match the approved payload.');
      }
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
    });

  const updateImportReceipt: WorkflowStore['updateImportReceipt'] = (input) =>
    wrap(() => {
      const run = readRun(input.runId);
      if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
      assertClaim(run, input.claimToken, input.now);
      const existing = db
        .prepare('SELECT * FROM import_receipts WHERE run_id = ? AND proposal_local_id = ?')
        .get(input.runId, input.proposalLocalId) as ReceiptRow | undefined;
      if (!existing || existing.payload_hash !== input.payloadHash) {
        throw new PersistError('CONFLICT', 'Import receipt does not match the approved payload.');
      }
      if (existing.status === 'imported') {
        if (input.status === 'imported' && input.contentId === existing.content_id) {
          return mapReceipt(existing);
        }
        throw new PersistError('CONFLICT', 'An imported receipt cannot regress or change.');
      }
      const updated = db
        .prepare(
          `UPDATE import_receipts
           SET content_id = @contentId, status = @status
           WHERE run_id = @runId
             AND proposal_local_id = @proposalLocalId
             AND payload_hash = @payloadHash
             AND status != 'imported'`,
        )
        .run({
          runId: input.runId,
          proposalLocalId: input.proposalLocalId,
          payloadHash: input.payloadHash,
          contentId: input.contentId,
          status: input.status,
        });
      if (updated.changes !== 1) {
        throw new PersistError('CONFLICT', 'Import receipt is no longer mutable.');
      }
      const row = db
        .prepare('SELECT * FROM import_receipts WHERE run_id = ? AND proposal_local_id = ?')
        .get(input.runId, input.proposalLocalId) as ReceiptRow;
      return mapReceipt(row);
    });

  const reserveAttempt: WorkflowStore['reserveAttempt'] = (input) =>
    wrap(() => {
      const result = reserveAttemptRunStmt.run({
        runId: input.runId,
        claimToken: input.claimToken,
        startedAt: input.startedAt,
      });
      if (result.changes !== 1) {
        const run = readRun(input.runId);
        if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
        assertClaim(run, input.claimToken, input.startedAt);
        throw new PersistError('BUDGET', 'Provider request budget exhausted.');
      }
      const executionAttempt = Number(
        (nextAttemptStmt.get(input.runId, input.operationKey) as { next_attempt: number })
          .next_attempt,
      );
      const id = randomUUID();
      insertAttemptStmt.run({
        id,
        runId: input.runId,
        step: input.step,
        candidateVersion: input.candidateVersion,
        operationKey: input.operationKey,
        executionAttempt,
        outcome: 'unknown',
        startedAt: input.startedAt,
        finishedAt: null,
        usage: null,
        error: null,
      });
      return { id, executionAttempt };
    });

  const completeImport: WorkflowStore['completeImport'] = (input) =>
    wrap(() => {
      const run = readRun(input.runId);
      if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
      assertClaim(run, input.claimToken, input.now);
      if (run.status !== 'RUNNING' || run.phase !== 'import') {
        throw new PersistError('CONFLICT', 'Run cannot complete this import.');
      }
      const approval = getApprovalStmt.get(input.runId) as ApprovalRow | undefined;
      if (approval?.decision !== 'approved' || approval.frozen_payload == null) {
        throw new PersistError('CONFLICT', 'Run has no approved import payload.');
      }
      assertConsumed(run.consumed, input.consumed, run.limits);
      const receipts = new Map(
        (listReceiptsStmt.all(input.runId) as ReceiptRow[]).map((row) => [
          row.proposal_local_id,
          row,
        ]),
      );
      for (const localId of frozenProposalIds(unpack(approval.frozen_payload))) {
        const receipt = receipts.get(localId);
        if (
          receipt?.status !== 'imported' ||
          receipt.content_id == null ||
          receipt.payload_hash !== approval.payload_hash ||
          receipt.import_key !== `${input.runId}:${localId}`
        ) {
          throw new PersistError('CONSTRAINT', 'Approved import is not fully confirmed.');
        }
      }
      const updated = updateCheckpointStmt.run({
        id: input.runId,
        expectedStateVersion: run.stateVersion,
        status: 'COMPLETED',
        phase: 'import',
        consumed: jsonText(input.consumed),
        state: jsonText(input.state),
        modelTag: null,
        modelDigest: null,
        claimToken: input.claimToken,
        now: input.now,
      });
      if (updated.changes !== 1) {
        throw new PersistError('CONFLICT', 'Run state version does not match.');
      }
      const next = readRun(input.runId);
      if (!next) throw new PersistError('NOT_FOUND', 'Run not found.');
      return next;
    });

  const finishAttempt: WorkflowStore['finishAttempt'] = (input) =>
    wrap(() => {
      const updated = finishAttemptStmt.run({
        id: input.reservation.id,
        runId: input.runId,
        claimToken: input.claimToken,
        finishedAt: input.finishedAt,
        outcome: input.outcome,
        usage: jsonTextNullable(input.usage),
        error: jsonTextNullable(input.error),
      });
      if (updated.changes !== 1) {
        throw new PersistError('CONFLICT', 'Attempt is no longer owned by this run executor.');
      }
      if (!input.modelTag && !input.modelDigest) return;
      const run = readRun(input.runId);
      if (!run) throw new PersistError('NOT_FOUND', 'Run not found.');
      if (run.modelTag && input.modelTag && run.modelTag !== input.modelTag) {
        throw new PersistError('CONSTRAINT', 'Run model tag changed.');
      }
      if (run.modelDigest && input.modelDigest && run.modelDigest !== input.modelDigest) {
        throw new PersistError('CONSTRAINT', 'Run model digest changed.');
      }
      const identity = finishAttemptRunStmt.run({
        runId: input.runId,
        claimToken: input.claimToken,
        finishedAt: input.finishedAt,
        modelTag: input.modelTag ?? null,
        modelDigest: input.modelDigest ?? null,
      });
      if (identity.changes !== 1) {
        throw new PersistError('CONFLICT', 'Attempt is no longer owned by this run executor.');
      }
    });

  const checkpointTx = db.transaction(saveCheckpoint);
  const claimTx = db.transaction(claimRun);
  const heartbeatTx = db.transaction(heartbeatRun);
  const approvalTx = db.transaction(recordApproval);
  const receiptSaveTx = db.transaction(saveImportReceipt);
  const receiptUpdateTx = db.transaction(updateImportReceipt);
  const attemptReserveTx = db.transaction(reserveAttempt);
  const attemptFinishTx = db.transaction(finishAttempt);
  const importCompleteTx = db.transaction(completeImport);

  return {
    path,
    createRun,
    openRun,
    getRun: readRun,
    ping: () => {
      db.prepare('SELECT 1').get();
    },
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
    heartbeatRun: (input) => heartbeatTx(input),
    reserveAttempt: (input) => attemptReserveTx(input),
    finishAttempt: (input) => attemptFinishTx(input),
    recordApproval: (input) => approvalTx(input),
    saveImportReceipt: (input) => receiptSaveTx(input),
    updateImportReceipt: (input) => receiptUpdateTx(input),
    completeImport: (input) => importCompleteTx(input),
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
  const backup = resolve(backupPath);
  const dest = resolve(destinationPath);
  mkdirSync(dirname(dest), { recursive: true });
  const staging = `${dest}.${randomUUID()}.restore`;
  try {
    copyFileSync(backup, staging);
    assertReadableSqlite(staging);
    removeSqliteSidecars(dest);
    renameSync(staging, dest);
  } catch (err) {
    removeSqliteFiles(staging);
    throw err;
  }
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

function frozenProposalIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new PersistError('CONSTRAINT', 'Approved payload is invalid.');
  }
  const proposals = (payload as { proposals?: unknown }).proposals;
  if (!Array.isArray(proposals) || proposals.length < 1) {
    throw new PersistError('CONSTRAINT', 'Approved payload is invalid.');
  }
  const ids = proposals.map((item) => {
    const localId =
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? (item as { localId?: unknown }).localId
        : undefined;
    if (typeof localId !== 'string' || localId.length === 0) {
      throw new PersistError('CONSTRAINT', 'Approved payload is invalid.');
    }
    return localId;
  });
  if (new Set(ids).size !== ids.length) {
    throw new PersistError('CONSTRAINT', 'Approved payload is invalid.');
  }
  return ids;
}

function assertClaim(run: PersistedRun, claimToken: string, now: number) {
  if (run.leaseToken !== claimToken || (run.leaseExpiresAt ?? 0) <= now) {
    throw new PersistError('CONFLICT', 'Run claim token does not match.');
  }
}

function assertReadableSqlite(sqlitePath: string) {
  let db: Database.Database | undefined;
  try {
    db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    const check = String(db.pragma('quick_check', { simple: true }));
    if (check !== 'ok') {
      throw new Error('Backup is not a valid SQLite database.');
    }
  } finally {
    db?.close();
  }
}

function removeSqliteSidecars(dest: string) {
  removeSqliteFiles(dest, ['-wal', '-shm', '-journal']);
}

function removeSqliteFiles(
  dest: string,
  extras: readonly string[] = ['', '-wal', '-shm', '-journal'],
) {
  for (const extra of extras) {
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
