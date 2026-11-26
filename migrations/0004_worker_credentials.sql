-- Per-worker credentials are stored as SHA-256 hashes only.
-- Plaintext tokens are returned once by the manager-only issuance endpoint.
CREATE TABLE IF NOT EXISTS worker_credentials (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_credentials_one_active
  ON worker_credentials(worker_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_worker_credentials_hash_status
  ON worker_credentials(token_hash, status);
