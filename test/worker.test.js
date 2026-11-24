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
