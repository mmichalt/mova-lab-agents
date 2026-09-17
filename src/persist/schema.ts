export const WORKFLOW_VERSION = 'content-drafts/v1';
export const CONSTRAINTS_VERSION = 'recording-generation/v1';
export const SCHEMA_VERSION = 'recording-proposal/v1';
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export const MIGRATIONS = [
  {
    id: 1,
    name: '001_workflow_persistence',
    sql: `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  normalized_input TEXT NOT NULL CHECK (json_valid(normalized_input)),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'REJECTED', 'COMPLETED', 'FAILED'
  )),
  phase TEXT NOT NULL CHECK (phase IN (
    'vocabulary', 'generation', 'checks', 'revision', 'finished', 'import'
  )),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  schema_version TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  constraints_version TEXT NOT NULL,
  prompt_versions TEXT NOT NULL CHECK (json_valid(prompt_versions)),
  model_tag TEXT,
  model_digest TEXT,
  limits TEXT NOT NULL CHECK (json_valid(limits)),
  consumed TEXT NOT NULL CHECK (json_valid(consumed)),
  state TEXT NOT NULL CHECK (json_valid(state)),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, idempotency_key),
  CHECK (
    (status = 'PENDING' AND phase = 'vocabulary')
    OR (status = 'RUNNING' AND phase != 'finished')
    OR (status IN ('AWAITING_APPROVAL', 'REJECTED', 'FAILED') AND phase = 'finished')
    OR (status = 'COMPLETED' AND phase IN ('finished', 'import'))
  )
);

CREATE TABLE step_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  candidate_version INTEGER,
  operation_key TEXT NOT NULL,
  execution_attempt INTEGER NOT NULL CHECK (execution_attempt >= 1),
  outcome TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  UNIQUE (run_id, operation_key, execution_attempt)
);

CREATE TABLE candidate_revisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  candidate_version INTEGER NOT NULL CHECK (candidate_version >= 1),
  proposals TEXT NOT NULL CHECK (json_valid(proposals)),
  checks TEXT NOT NULL CHECK (json_valid(checks)),
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, candidate_version)
);

CREATE TABLE approvals (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  category_id TEXT,
  payload_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  frozen_payload TEXT CHECK (frozen_payload IS NULL OR json_valid(frozen_payload)),
  decided_at INTEGER NOT NULL,
  CHECK (
    (decision = 'approved' AND category_id IS NOT NULL AND frozen_payload IS NOT NULL)
    OR (decision = 'rejected' AND category_id IS NULL AND frozen_payload IS NULL)
  )
);

CREATE TABLE import_receipts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  proposal_local_id TEXT NOT NULL,
  import_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  content_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'imported', 'failed')),
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, proposal_local_id),
  UNIQUE (import_key),
  CHECK (
    (status = 'imported' AND content_id IS NOT NULL)
    OR (status != 'imported' AND content_id IS NULL)
  )
);
`,
  },
  {
    id: 2,
    name: '002_run_ollama_version',
    sql: `
ALTER TABLE runs ADD COLUMN ollama_version TEXT;
`,
  },
] as const;
