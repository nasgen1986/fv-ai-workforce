-- Make each task-execution approval single-use.
-- Existing approvals remain unconsumed so they can be evaluated under the new gate.
ALTER TABLE approval_requests ADD COLUMN consumed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_approval_requests_task_execution
  ON approval_requests(task_id, action_type, status, consumed_at);
