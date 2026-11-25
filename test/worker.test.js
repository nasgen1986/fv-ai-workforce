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
    "worker_credentials",
    "workers"
  ];
  const db = {
    prepare(sql) {
      return {
        all: async () => {
          if (sql.includes("sqlite_master")) return { results: tables.map((name) => ({ name })) };
          if (sql.includes("pragma_table_info('approval_requests')")) {
            return { results: [{ name: "id" }, { name: "task_id" }, { name: "status" }] };
          }
          if (sql.includes("pragma_table_info('worker_credentials')")) {
            return { results: ["id", "worker_id", "token_hash", "status", "created_at", "revoked_at"].map((name) => ({ name })) };
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
  assert.deepEqual(body.missingColumns, [
    "approval_requests.consumed_at"
  ]);
});

test("GET /health/db reports ready only when required tables and security columns exist", async () => {
  const tables = [
    "approval_requests",
    "task_events",
    "task_submissions",
    "tasks",
    "worker_credentials",
    "workers"
  ];
  const db = {
    prepare(sql) {
      return {
        all: async () => {
          if (sql.includes("sqlite_master")) return { results: tables.map((name) => ({ name })) };
          if (sql.includes("pragma_table_info('approval_requests')")) {
            return { results: [{ name: "id" }, { name: "task_id" }, { name: "status" }, { name: "consumed_at" }] };
          }
          if (sql.includes("pragma_table_info('worker_credentials')")) {
            return { results: ["id", "worker_id", "token_hash", "status", "created_at", "revoked_at"].map((name) => ({ name })) };
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

test("all worker, task, approval, dispatcher, and review API routes require manager authentication", async () => {
  const env = { WORKFORCE_API_TOKEN: TOKEN, DB: {} };
  const protectedRoutes = [
    ["/api/workers", "GET"],
    ["/api/workers/worker-1", "PATCH"],
    ["/api/workers/worker-1/tasks", "GET"],
    ["/api/tasks", "GET"],
    ["/api/tasks/task-1", "GET"],
    ["/api/tasks/task-1", "PATCH"],
    ["/api/tasks/task-1/run", "POST"],
    ["/api/tasks/task-1/submissions", "POST"],
    ["/api/approvals", "GET"],
    ["/api/approvals/approval-1", "PATCH"],
    ["/api/submissions/submission-1/review", "PATCH"],
    ["/api/dispatcher/assign", "POST"]
  ];

  for (const [path, method] of protectedRoutes) {
    const response = await call(path, { method, env });
    assert.equal(response.status, 401, `${method} ${path} must reject requests without manager authentication`);
  }
});

async function sha256HexForTest(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("worker credentials are hashed, scoped to one worker, and cannot access manager routes", async () => {
  const workerToken = "worker-token-test-which-is-43-characters-long";
  const expectedHash = await sha256HexForTest(workerToken);
  const db = {
    prepare(sql) {
      return {
        bind(value) {
          return {
            first: async () => {
              assert.match(sql, /worker_credentials/);
              assert.equal(value, expectedHash);
              return { worker_id: "worker-1" };
            }
          };
        }
      };
    }
  };
  const env = { WORKFORCE_API_TOKEN: TOKEN, DB: db };
  const managerRoute = await call("/api/tasks", { token: workerToken, env });
  assert.equal(managerRoute.status, 403);

  const otherWorker = await call("/api/workers/worker-2/tasks", {
    token: workerToken,
    env
  });
  assert.equal(otherWorker.status, 403);

  const managerOnlyRoutes = [
    ["/api/workers", "GET"],
    ["/api/workers/worker-1/credentials", "POST"],
    ["/api/workers/worker-1/credentials", "DELETE"],
    ["/api/tasks", "POST"],
    ["/api/tasks/task-1/run", "POST"],
    ["/api/tasks/task-1/submissions", "GET"],
    ["/api/approvals", "POST"],
    ["/api/approvals/approval-1", "PATCH"],
    ["/api/submissions/submission-1/review", "PATCH"],
    ["/api/dispatcher/assign", "POST"]
  ];
  for (const [path, method] of managerOnlyRoutes) {
    const response = await call(path, { method, token: workerToken, env });
    assert.equal(response.status, 403, `${method} ${path} must remain manager-only`);
  }
});

test("revoked worker credentials are rejected before any worker route runs", async () => {
  const workerToken = "worker-token-test-which-is-43-characters-long";
  const expectedHash = await sha256HexForTest(workerToken);
  let lookupSql = "";
  const db = {
    prepare(sql) {
      return {
        bind(value) {
          return {
            first: async () => {
              lookupSql = sql;
              assert.equal(value, expectedHash);
              return null;
            }
          };
        }
      };
    }
  };
  const response = await call("/api/workers/worker-1/tasks", {
    token: workerToken,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db }
  });
  assert.equal(response.status, 401);
  assert.match(lookupSql, /wc.status = 'active'/);
  assert.match(lookupSql, /w.status = 'active'/);
});

test("worker credentials can read only their own assigned task summaries", async () => {
  const workerToken = "worker-token-test-which-is-43-characters-long";
  const expectedHash = await sha256HexForTest(workerToken);
  const db = {
    prepare(sql) {
      return {
        bind(value) {
          return {
            first: async () => {
              if (sql.includes("worker_credentials")) {
                assert.equal(value, expectedHash);
                return { worker_id: "worker-1" };
              }
              if (sql === "SELECT id FROM workers WHERE id = ?") return { id: value };
              throw new Error("Unexpected query: " + sql);
            },
            all: async () => {
              assert.match(sql, /SELECT id, title, description, status, priority/);
              assert.equal(value, "worker-1");
              return { results: [{ id: "task-1", title: "Research", status: "assigned" }] };
            }
          };
        }
      };
    }
  };
  const response = await call("/api/workers/worker-1/tasks", {
    token: workerToken,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tasks[0].id, "task-1");
});

test("worker can start only their assigned task with an active credential and consumes required approval atomically", async () => {
  const workerToken = "worker-token-test-which-is-43-characters-long";
  const tokenHash = await sha256HexForTest(workerToken);
  const statementsSeen = [];
  const task = {
    id: "task-start",
    status: "assigned",
    assigned_worker_id: "worker-1",
    requires_approval: 1
  };
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql, values,
            first: async () => {
              if (sql.includes("worker_credentials")) return { worker_id: "worker-1" };
              if (sql.includes("SELECT id, status, assigned_worker_id, requires_approval FROM tasks")) return task;
              if (sql.includes("SELECT id FROM approval_requests")) return { id: "approval-1" };
              if (sql.includes("SELECT id, status, assigned_worker_id, requires_approval, updated_at FROM tasks")) {
                return { ...task, status: "in_progress" };
              }
              throw new Error("Unexpected query in worker task start test: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      statementsSeen.push(...statements);
      assert.equal(statements.length, 5);
      assert.match(statements[0].sql, /worker_credentials WHERE worker_id = \? AND token_hash = \? AND status = 'active'/);
      assert.match(statements[0].sql, /status = 'assigned'/);
      assert.match(statements[0].sql, /EXISTS \(SELECT 1 FROM workers WHERE id = \? AND status = 'active'\)/);
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
      assert.match(statements[2].sql, /consumed_at IS NULL AND changes\(\) = 1/);
      assert.match(statements[3].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
      assert.match(statements[4].sql, /worker_task_started/);
      assert.equal(statements[0].values[4], tokenHash);
      return [{ meta: { changes: 1 } }, { results: [{ ok: 1 }] }, { meta: { changes: 1 } }, { results: [{ ok: 1 }] }, { meta: { changes: 1 } }];
    }
  };
  const response = await call("/api/tasks/task-start/start", {
    method: "POST",
    token: workerToken,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.task.status, "in_progress");
  assert.match(body.message, /No AI inference/);
  assert.equal(statementsSeen.length, 5);
});

test("worker cannot start another worker's task or bypass missing manager approval", async () => {
  const workerToken = "worker-token-test-which-is-43-characters-long";
  const dbFor = (task, approval = null) => ({
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes("worker_credentials")) return { worker_id: "worker-1" };
              if (sql.includes("SELECT id, status, assigned_worker_id, requires_approval FROM tasks")) return task;
              if (sql.includes("SELECT id FROM approval_requests")) return approval;
              throw new Error("Unexpected query in worker task start denial test: " + sql);
            }
          };
        }
      };
    },
    async batch() { throw new Error("No write should occur for a rejected start."); }
  });
  const wrongWorker = await call("/api/tasks/task-start/start", {
    method: "POST",
    token: workerToken,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: dbFor({
      id: "task-start", status: "assigned", assigned_worker_id: "worker-2", requires_approval: 1
    }) }
  });
  assert.equal(wrongWorker.status, 403);

  const noApproval = await call("/api/tasks/task-start/start", {
    method: "POST",
    token: workerToken,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: dbFor({
      id: "task-start", status: "assigned", assigned_worker_id: "worker-1", requires_approval: 1
    }) }
  });
  assert.equal(noApproval.status, 403);
  assert.match((await noApproval.json()).error, /manager approval is required/i);
});

test("manager credential cannot use the worker task-start route", async () => {
  const response = await call("/api/tasks/task-start/start", {
    method: "POST",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: {} }
  });
  assert.equal(response.status, 403);
});

test("worker submissions derive identity from the credential, not request body", async () => {
  const workerToken = "worker-token-test-which-is-43-characters-long";
  const expectedHash = await sha256HexForTest(workerToken);
  let batchStatements;
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql,
            values,
            first: async () => {
              if (sql.includes("worker_credentials")) {
                assert.equal(values[0], expectedHash);
                return { worker_id: "worker-1" };
              }
              if (sql.includes("SELECT id, status, requires_approval FROM tasks")) {
                return { id: "task-1", status: "in_progress", requires_approval: 0 };
              }
              if (sql.includes("SELECT t.*, w.status AS worker_status")) {
                return { id: "task-1", status: "in_progress", assigned_worker_id: "worker-1", worker_status: "active", requires_approval: 0 };
              }
              if (sql.includes("SELECT * FROM task_submissions WHERE id = ?")) {
                return { id: "submission-1", worker_id: "worker-1" };
              }
              throw new Error("Unexpected query: " + sql);
            }
          };
        }
      };
    },
    async batch(statements) {
      batchStatements = statements;
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    }
  };
  const response = await call("/api/tasks/task-1/submissions", {
    method: "POST",
    token: workerToken,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { summary: "Finished", content: "Worker output" }
  });
  assert.equal(response.status, 201);
  assert.equal(batchStatements[0].values[2], "worker-1");
  assert.equal(batchStatements[1].values[1], "worker-1");
});

test("worker credentials cannot impersonate another worker in a submission", async () => {
  const workerToken = "worker-token-test-which-is-43-characters-long";
  const expectedHash = await sha256HexForTest(workerToken);
  const db = {
    prepare(sql) {
      return {
        bind(value) {
          return {
            first: async () => {
              if (sql.includes("worker_credentials")) {
                assert.equal(value, expectedHash);
                return { worker_id: "worker-1" };
              }
              if (sql.includes("SELECT id, status, requires_approval FROM tasks")) {
                return { id: "task-1", status: "in_progress", requires_approval: 0 };
              }
              throw new Error("Unexpected query in impersonation test: " + sql);
            }
          };
        }
      };
    }
  };
  const response = await call("/api/tasks/task-1/submissions", {
    method: "POST",
    token: workerToken,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db },
    body: { worker_id: "worker-2", summary: "Impersonation", content: "Must be rejected" }
  });
  assert.equal(response.status, 403);
});

test("manager can revoke active worker credentials", async () => {
  let revokeSql = "";
  let revokeWorkerId = "";
  const db = {
    prepare(sql) {
      return {
        bind(workerId) {
          return {
            run: async () => {
              revokeSql = sql;
              revokeWorkerId = workerId;
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  const response = await call("/api/workers/worker-1/credentials", {
    method: "DELETE",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, 1);
  assert.match(revokeSql, /status = 'revoked'/);
  assert.equal(revokeWorkerId, "worker-1");
});

test("manager can issue one-time worker tokens without storing plaintext", async () => {
  let insertedValues;
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => ({ id: "worker-1", status: "active" }),
            sql,
            values,
            run: async () => ({ meta: { changes: 1 } })
          };
        }
      };
    },
    async batch(statements) {
      insertedValues = statements[1].values;
      assert.match(statements[0].sql, /UPDATE worker_credentials/);
      assert.match(statements[0].sql, /EXISTS \(SELECT 1 FROM workers WHERE id = \? AND status = 'active'\)/);
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    }
  };
  const response = await call("/api/workers/worker-1/credentials", {
    method: "POST",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db }
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.token.length, 43);
  assert.equal(insertedValues[1], "worker-1");
  assert.match(insertedValues[2], /^[a-f0-9]{64}$/);
  assert.notEqual(insertedValues[2], body.token);
  assert.equal(insertedValues.includes(body.token), false);
});

test("worker credential issuance fails closed if the worker becomes inactive before the atomic insert", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return { sql, values, first: async () => ({ id: "worker-1", status: "active" }) };
        }
      };
    },
    async batch(statements) {
      assert.match(statements[0].sql, /EXISTS \(SELECT 1 FROM workers WHERE id = \? AND status = 'active'\)/);
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
      return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
    }
  };
  const response = await call("/api/workers/worker-1/credentials", {
    method: "POST",
    token: TOKEN,
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db }
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /became inactive/i);
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
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
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
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
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
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
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
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
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
      assert.match(statements[1].sql, /changes\(\) = 1 THEN 1 ELSE json\(/);
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


test("worker credential lookup failure returns a generic 503", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            first: async () => { throw new Error("sensitive database internals"); }
          };
        }
      };
    }
  };
  const response = await call("/api/workers/worker-1/tasks", {
    token: "w".repeat(43),
    env: { WORKFORCE_API_TOKEN: TOKEN, DB: db }
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: false,
    error: "Authentication service unavailable."
  });
  assert.equal(JSON.stringify(body).includes("sensitive database internals"), false);
});


test("GET /health/db detects incomplete worker credential schema", async () => {
  const tables = [
    "approval_requests", "task_events", "task_submissions",
    "tasks", "worker_credentials", "workers"
  ];
  const db = {
    prepare(sql) {
      return {
        all: async () => {
          if (sql.includes("sqlite_master")) return { results: tables.map((name) => ({ name })) };
          if (sql.includes("pragma_table_info('approval_requests')")) {
            return { results: [{ name: "consumed_at" }] };
          }
          if (sql.includes("pragma_table_info('worker_credentials')")) {
            return { results: [{ name: "id" }, { name: "status" }] };
          }
          throw new Error("Unexpected health-check query: " + sql);
        }
      };
    }
  };
  const response = await call("/health/db", { env: { DB: db } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaReady, false);
  assert.deepEqual(body.missingTables, []);
  assert.deepEqual(body.missingColumns, [
    "worker_credentials.worker_id",
    "worker_credentials.token_hash",
    "worker_credentials.revoked_at"
  ]);
});
