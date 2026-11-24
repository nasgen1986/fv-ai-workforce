import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const TOKEN = "test-token-that-is-at-least-32-characters-long";

async function call(path, { method = "GET", token, env = {} } = {}) {
  const headers = new Headers();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  const request = new Request(`https://example.test${path}`, { method, headers });
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
  assert.match(body.error, /only be completed by accepting a submitted work item/i);
});
