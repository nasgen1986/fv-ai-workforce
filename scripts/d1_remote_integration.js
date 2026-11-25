import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const database = "fv-ai-workforce-test-db";
const config = "wrangler.test.example.jsonc";
const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
const workerId = `d1test_worker_${suffix}`;
const taskId = `d1test_task_${suffix}`;
const approvalId = `d1test_approval_${suffix}`;
const submissionId = `d1test_submission_${suffix}`;
const credentialId1 = `d1test_credential_a_${suffix}`;
const credentialId2 = `d1test_credential_b_${suffix}`;
const hash1 = randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64);
const hash2 = randomUUID().replaceAll("-", "").padEnd(64, "b").slice(0, 64);

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function execute(sql, expectedFailureText = null) {
  try {
    const stdout = execFileSync("npx", [
      "wrangler", "d1", "execute", database,
      "--remote", "--command", sql, "--json", "--config", config
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (expectedFailureText) {
      throw new Error("Expected D1 statement to fail, but it succeeded.");
    }
    const trimmed = stdout.trim();
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const start = trimmed.search(/[\[{]/);
      if (start < 0) throw new Error("Wrangler did not return JSON output.");
      parsed = JSON.parse(trimmed.slice(start));
    }
    return parsed;
  } catch (error) {
    const detail = error.stderr?.toString() || error.message;
    if (expectedFailureText && error.status !== 0 && detail.includes(expectedFailureText)) return null;
    throw new Error("Remote D1 command failed: " + detail.slice(-1200));
  }
}

function rows(result) {
  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && Array.isArray(item.results)) return item.results;
    }
  }
  if (result && Array.isArray(result.results)) return result.results;
  throw new Error("Unexpected Wrangler D1 JSON response shape.");
}

function scalar(result, key) {
  const row = rows(result)[0];
  assert.ok(row, "Expected at least one D1 result row.");
  return row[key];
}

let passed = 0;
try {
  const tableNames = rows(execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workers','tasks','task_events','approval_requests','task_submissions','worker_credentials')"
  )).map((row) => row.name);
  for (const name of ["workers", "tasks", "task_events", "approval_requests", "task_submissions", "worker_credentials"]) {
    assert.ok(tableNames.includes(name), `Missing TEST D1 table: ${name}`);
  }
  passed++;

  const credentialColumns = rows(execute("PRAGMA table_info(worker_credentials)")).map((row) => row.name);
  assert.ok(credentialColumns.includes("token_hash"));
  assert.ok(!credentialColumns.includes("token"), "Plaintext token column must not exist.");
  passed++;

  execute(
    `INSERT INTO workers (id,name,role,status,capabilities_json) VALUES (${sqlString(workerId)},'D1 Integration Test','test','active','["read_only_research"]')`
  );
  execute(
    `INSERT INTO tasks (id,title,description,status,priority,assigned_worker_id,requires_approval) VALUES (${sqlString(taskId)},'D1 integration smoke test','Temporary test record','in_progress','normal',${sqlString(workerId)},1)`
  );
  passed++;

  execute(
    `INSERT INTO worker_credentials (id,worker_id,token_hash) VALUES (${sqlString(credentialId1)},${sqlString(workerId)},${sqlString(hash1)})`
  );
  const duplicateActive = execute(
    `INSERT INTO worker_credentials (id,worker_id,token_hash) VALUES (${sqlString(credentialId2)},${sqlString(workerId)},${sqlString(hash2)})`,
    "UNIQUE constraint failed: worker_credentials.worker_id"
  );
  assert.equal(duplicateActive, null, "Only one active credential per worker must be allowed.");
  passed++;

  execute(
    `UPDATE worker_credentials SET status='revoked', revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=${sqlString(credentialId1)} AND status='active'`
  );
  execute(
    `INSERT INTO worker_credentials (id,worker_id,token_hash) VALUES (${sqlString(credentialId2)},${sqlString(workerId)},${sqlString(hash2)})`
  );
  assert.equal(scalar(execute(`SELECT COUNT(*) AS count FROM worker_credentials WHERE worker_id=${sqlString(workerId)} AND status='active'`), "count"), 1);
  passed++;

  execute(
    `INSERT INTO approval_requests (id,task_id,action_type,summary,status,decided_at) VALUES (${sqlString(approvalId)},${sqlString(taskId)},'task_execution','D1 integration test','approved',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  );
  execute(
    `UPDATE approval_requests SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=${sqlString(approvalId)} AND status='approved' AND consumed_at IS NULL`
  );
  assert.equal(scalar(execute(`SELECT COUNT(*) AS count FROM approval_requests WHERE id=${sqlString(approvalId)} AND consumed_at IS NOT NULL`), "count"), 1);
  passed++;

  execute(
    `INSERT INTO task_submissions (id,task_id,worker_id,summary,content) VALUES (${sqlString(submissionId)},${sqlString(taskId)},${sqlString(workerId)},'D1 write/read test','Temporary integration payload')`
  );
  assert.equal(scalar(execute(`SELECT COUNT(*) AS count FROM task_submissions WHERE id=${sqlString(submissionId)} AND task_id=${sqlString(taskId)} AND worker_id=${sqlString(workerId)}`), "count"), 1);
  passed++;

  console.log(`PASS: ${passed} remote TEST D1 integration checks completed.`);
} finally {
  // Remove only this run's uniquely named test records. Never truncate or reset tables.
  execute(`DELETE FROM tasks WHERE id=${sqlString(taskId)}`);
  execute(`DELETE FROM workers WHERE id=${sqlString(workerId)}`);
}
