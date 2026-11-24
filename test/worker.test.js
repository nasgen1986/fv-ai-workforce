import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const TOKEN = "test-token-that-is-at-least-32-characters-long";

async function call(path, { method = "GET", token, env = {}, body } = {}) {
  const headers = new Headers();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`https://example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return worker.fetch(request, env);
}

test("GET / returns service health without exposing secrets", async () => {
  const response = await call("/");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "FV AI Workforce");
  assert.equal(body.apiAuthentication, "missing-or-too-short");
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("GET /health/db reports an unbound database safely", async () => {
  const response = await call("/health/db");
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.database, "unbound");
});

test("GET /health/db detects a missing single-use approval migration column", async () => {
  const tables = [
    "approval_requests",
    "task_events",
    "task_submissions",
    "tasks",
    "workers"
  ];
  const db = {
    prepare(sql) {
      return {
        all: async () => {
          if (sql.includes("sqlite_master")) return { results: tables.map((name) => ({ name })) };
          if (sql.includes("pragma_table_info")) {
            return { results: [{ name: "id" }, { name: "task_id" }, { name: "status" }] };
          }
          throw new Error("Unexpected health-check query: " + sql);
        }
      };
    }
  };
  const response = await call("/health/db", { env: { DB: db } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.database, "connected");
  assert.equal(body.schemaReady, false);
  assert.deepEqual(body.missingTables, []);
  assert.deepEqual(body.missingColumns, ["consumed_at"]);
});

test("GET /health/db reports ready only when required tables and consumed_at exist", async () => {
  const tables = [
    "approval_requests",
    "task_events",
    "task_submissions",
    "tasks",
    "workers"
  ];
  const db = {
    prepare(sql) {
      return {
        all: async () => {
          if (sql.includes("sqlite_master")) return { results: tables.map((name) => ({ name })) };
          if (sql.includes("pragma_table_info")) {
            return { results: [{ name: "id" }, { name: "task_id" }, { name: "status" }, { name: "consumed_at" }] };
          }
          throw new Error("Unexpected health-check query: " + sql);
        }
      };
    }
  };
  const response = await call("/health/db", { env: { DB: db } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaReady, true);
  assert.deepEqual(body.missingTables, []);
  assert.deepEqual(body.missingColumns, []);
});

test("protected API returns 503 when API token is not configured", async () => {
  const response = await call("/api/tasks");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "API authentication is not configured yet."
  });
});

test("protected API rejects a missing or incorrect bearer token", async () => {
  const env = { WORKFORCE_API_TOKEN: TOKEN, DB: {} };
  const missing = await call("/api/tasks", { env });
  assert.equal(missing.status, 401);

  const incorrect = await call("/api/tasks", { token: "wrong-token", env });
  assert.equal(incorrect.status, 401);
});

test("AI task execution stays disabled unless explicitly enabled", async () => {
  const env = { WORKFORCE_API_TOKEN: TOKEN, DB: {} };
  const response = await call("/api/tasks/example-task/run", {
    method: "POST",
    token: TOKEN,
    env
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /AI execution is disabled/);
});

test("direct AI test endpoint remains disabled", async () => {
  const env = { WORKFORCE_API_TOKEN: TOKEN, DB: {} };
  const response = await call("/api/ai/test", {
    method: "POST",
    token: TOKEN,
    env
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /Direct AI tests are disabled/);
});

test("dispatcher assignment atomically rechecks that the selected worker is still active", async () => {
  const task = { id: "task-race", title: "Test", status: "pending", assigned_worker_id: null };
  const workerRow = {
    id: "worker-1", name: "Research worker", role: "research",
    status: "active", capabilities_json: '["read_only_research"]'
  };
  let batchCalled = false;
  const db = {
    prepare(sql) {
      return {
        all: async () => {
          if (sql.includes("FROM workers WHERE status = 'active'")) return { results: [workerRow] };
          throw new Error("Unexpected list query in dispatcher active-worker test: " + sql);
        },
        bind(...values) {
          return {
            sql, values,
            first: async () => {
              if (sql.includes("SELECT id, title, status, assigned_worker_id FROM tasks")) return task;
              throw new Error("Unexpected query in dispatcher active-worker test: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      batchCalled = true;
      assert.match(statements[0].sql, /EXISTS \(SELECT 1 FROM workers WHERE id = \? AND status = 'active'\)/);
      assert.deepEqual(statements[0].values, ["worker-1", "task-race", "worker-1"]);
      return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
    }
  };
  const response = await call("/api/dispatcher/assign", {
    method: "POST",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { task_id: "task-race", required_capability: "read_only_research" }
  });
  assert.equal(response.status, 409);
  assert.equal(batchCalled, true);
  assert.match((await response.json()).error, /changed by another request/i);
});

test("task PATCH cannot mark a task completed without accepting a submission", async () => {
  const currentTask = {
    id: "task-1",
    status: "in_progress",
    priority: "normal",
    assigned_worker_id: null,
    completed_at: null
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => {
              if (sql === "SELECT * FROM tasks WHERE id = ?") return currentTask;
              throw new Error("Unexpected database query in completion guard test.");
            },
            run: async () => {
              throw new Error("Task update must not run when completion bypass is rejected.");
            }
          };
        }
      };
    }
  };
  const env = { WORKFORCE_API_TOKEN: TOKEN, DB: db };
  const response = await call("/api/tasks/task-1", {
    method: "PATCH",
    token: TOKEN,
    env,
    body: { status: "completed" }
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /transition is not allowed|only be completed by accepting a submitted work item/i);
});


test("generic task PATCH rejects workflow-bypassing status transitions", async () => {
  const currentTask = {
    id: "task-pending",
    status: "pending",
    priority: "normal",
    assigned_worker_id: null,
    completed_at: null
  };
  let batchCalled = false;
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => {
              if (sql === "SELECT * FROM tasks WHERE id = ?") return currentTask;
              throw new Error("Unexpected query in transition guard test.");
            }
          };
        }
      };
    },
    async batch() {
      batchCalled = true;
      throw new Error("Batch must not run for a rejected transition.");
    }
  };
  const response = await call("/api/tasks/task-pending", {
    method: "PATCH",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { status: "in_progress" }
  });
  assert.equal(response.status, 409);
  assert.equal(batchCalled, false);
  assert.match((await response.json()).error, /transition is not allowed/i);
});

test("failed task can only be reset to assigned with an active assigned worker", async () => {
  const currentTask = {
    id: "task-failed",
    status: "failed",
    priority: "normal",
    assigned_worker_id: "worker-1",
    completed_at: null
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => {
              if (sql === "SELECT * FROM tasks WHERE id = ?") return currentTask;
              if (sql === "SELECT id, status FROM workers WHERE id = ?") {
                return { id: "worker-1", status: "active" };
              }
              if (sql === "SELECT * FROM tasks WHERE id = ?") return { ...currentTask, status: "assigned" };
              throw new Error("Unexpected query in failed-task reset test: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 2);
      assert.match(statements[0].sql, /WHERE id = \? AND status = \?/);
      assert.match(statements[1].sql, /WHERE changes\(\) = 1/);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    }
  };
  const response = await call("/api/tasks/task-failed", {
    method: "PATCH",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { status: "assigned" }
  });
  assert.equal(response.status, 200);
});

test("submission review uses one atomic D1 batch for submission, task, and audit", async () => {
  const submission = {
    id: "submission-1",
    task_id: "task-1",
    worker_id: "worker-1",
    status: "submitted",
    task_status: "in_progress"
  };
  let batchCount = 0;
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => {
              if (sql.includes("SELECT s.*, t.requires_approval")) return submission;
              if (sql === "SELECT * FROM task_submissions WHERE id = ?") {
                return { ...submission, status: "accepted" };
              }
              if (sql === "SELECT * FROM tasks WHERE id = ?") {
                return { id: "task-1", status: "completed" };
              }
              throw new Error("Unexpected query in atomic review test: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      batchCount += 1;
      assert.equal(statements.length, 3);
      assert.match(statements[0].sql, /status = 'submitted'/);
      assert.match(statements[1].sql, /changes\(\) = 1/);
      assert.match(statements[2].sql, /changes\(\) = 1/);
      return [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } }
      ];
    }
  };
  const response = await call("/api/submissions/submission-1/review", {
    method: "PATCH",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { status: "accepted", review_note: "Looks good." }
  });
  assert.equal(response.status, 200);
  assert.equal(batchCount, 1);
  const body = await response.json();
  assert.equal(body.task.status, "completed");
});


test("API rejects oversized request bodies before parsing", async () => {
  const headers = new Headers({
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json"
  });
  const request = new Request("https://example.test/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Too large", description: "x".repeat(110000) })
  });
  const response = await worker.fetch(request, {
    WORKFORCE_API_TOKEN: TOKEN,
    DB: {}
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/i);
});

test("API reports malformed JSON without leaking parser details", async () => {
  const request = new Request("https://example.test/api/tasks", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json"
    },
    body: "{not-json"
  });
  const response = await worker.fetch(request, {
    WORKFORCE_API_TOKEN: TOKEN,
    DB: {}
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Request body must be valid JSON."
  });
});


test("AI execution cannot start without an unused task-specific approval", async () => {
  const task = {
    id: "task-1",
    title: "Research",
    description: "Read-only research",
    status: "assigned",
    assigned_worker_id: "worker-1"
  };
  let aiCalled = false;
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => {
              if (sql === "SELECT * FROM tasks WHERE id = ?") return task;
              if (sql.includes("SELECT id FROM approval_requests")) return null;
              throw new Error("Unexpected query in missing-approval test: " + sql);
            }
          };
        }
      };
    }
  };
  const response = await call("/api/tasks/task-1/run", {
    method: "POST",
    token: TOKEN,
    env: {
      WORKFORCE_API_TOKEN: TOKEN,
      AI_EXECUTION_ENABLED: "true",
      DB: db,
      AI: { run: async () => { aiCalled = true; throw new Error("Must not run"); } }
    }
  });
  assert.equal(response.status, 403);
  assert.equal(aiCalled, false);
});

test("AI execution claim and approval consumption are atomic before inference", async () => {
  const task = {
    id: "task-1",
    title: "Research",
    description: "Read-only research",
    status: "assigned",
    assigned_worker_id: "worker-1"
  };
  const approval = { id: "approval-1" };
  const workerRow = {
    id: "worker-1",
    name: "Research worker",
    role: "research",
    status: "active",
    capabilities_json: '["read_only_research"]'
  };
  const batches = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql,
            values,
            first: async () => {
              if (sql === "SELECT * FROM tasks WHERE id = ?") return task;
              if (sql.includes("SELECT id FROM approval_requests")) return approval;
              if (sql.includes("SELECT id, name, role, status, capabilities_json FROM workers")) return workerRow;
              throw new Error("Unexpected query in atomic execution test: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      batches.push(statements);
      if (batches.length === 1) {
        assert.equal(statements.length, 4);
        assert.match(statements[0].sql, /EXISTS \(SELECT 1 FROM workers WHERE id = \? AND status = 'active'\)/);
        assert.match(statements[0].sql, /EXISTS \(SELECT 1 FROM approval_requests/);
        assert.deepEqual(statements[0].values, ["task-1", "worker-1", "worker-1", "approval-1"]);
        assert.match(statements[1].sql, /changes\(\) = 1/);
        assert.match(statements[2].sql, /changes\(\) = 1/);
        return [
          { meta: { changes: 1 } },
          { meta: { changes: 1 } },
          { meta: { changes: 1 } },
          { meta: { changes: 1 } }
        ];
      }
      assert.equal(statements.length, 2);
      assert.match(statements[0].sql, /status = 'failed'/);
      assert.match(statements[1].sql, /changes\(\) = 1/);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    }
  };
  let aiCalled = false;
  const response = await call("/api/tasks/task-1/run", {
    method: "POST",
    token: TOKEN,
    env: {
      WORKFORCE_API_TOKEN: TOKEN,
      AI_EXECUTION_ENABLED: "true",
      DB: db,
      AI: {
        run: async () => {
          aiCalled = true;
          throw new Error("Test stub: stop before any AI inference");
        }
      }
    }
  });
  assert.equal(response.status, 502);
  assert.equal(aiCalled, true);
  assert.equal(batches.length, 2);
});


test("manual submission is inserted with its audit event in one guarded batch", async () => {
  const task = { id: "task-1", status: "in_progress", requires_approval: 1 };
  const assigned = {
    id: "task-1",
    status: "in_progress",
    assigned_worker_id: "worker-1",
    worker_status: "active",
    requires_approval: 1
  };
  let batchCount = 0;
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => {
              if (sql.includes("SELECT id, status, requires_approval FROM tasks")) return task;
              if (sql.includes("SELECT t.*, w.status AS worker_status")) return assigned;
              if (sql.includes("SELECT id FROM approval_requests")) return { id: "approval-1" };
              if (sql.includes("SELECT * FROM task_submissions WHERE id = ?")) {
                return { id: "submission-1", task_id: "task-1", status: "submitted" };
              }
              throw new Error("Unexpected query in guarded submission test: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      batchCount += 1;
      assert.equal(statements.length, 2);
      assert.match(statements[0].sql, /NOT EXISTS \(SELECT 1 FROM task_submissions/);
      assert.match(statements[0].sql, /consumed_at IS NOT NULL/);
      assert.match(statements[1].sql, /WHERE changes\(\) = 1/);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    }
  };
  const response = await call("/api/tasks/task-1/submissions", {
    method: "POST",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { worker_id: "worker-1", summary: "Completed research", content: "Research output" }
  });
  assert.equal(response.status, 201);
  assert.equal(batchCount, 1);
});

test("manual submission rejects a duplicate pending submission without writing an audit event", async () => {
  const task = { id: "task-1", status: "in_progress", requires_approval: 0 };
  const assigned = {
    id: "task-1",
    status: "in_progress",
    assigned_worker_id: "worker-1",
    worker_status: "active",
    requires_approval: 0
  };
  let batchCalled = false;
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => {
              if (sql.includes("SELECT id, status, requires_approval FROM tasks")) return task;
              if (sql.includes("SELECT t.*, w.status AS worker_status")) return assigned;
              throw new Error("Unexpected query in duplicate submission test: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      batchCalled = true;
      assert.equal(statements.length, 2);
      return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
    }
  };
  const response = await call("/api/tasks/task-1/submissions", {
    method: "POST",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { worker_id: "worker-1", summary: "Duplicate", content: "Duplicate output" }
  });
  assert.equal(response.status, 409);
  assert.equal(batchCalled, true);
  assert.match((await response.json()).error, /another submission is already awaiting review/i);
});
