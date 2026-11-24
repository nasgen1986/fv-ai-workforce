const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const TASK_STATUSES = new Set([
  "pending",
  "assigned",
  "in_progress",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
]);

const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorized(request, env) {
  const expected = env.WORKFORCE_API_TOKEN;
  if (typeof expected !== "string" || expected.length < 32) return "not-configured";
  const supplied = request.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!supplied.startsWith(prefix)) return false;
  return safeEqual(supplied.slice(prefix.length), expected);
}

async function recordEvent(db, taskId, actorType, actorId, eventType, payload = {}) {
  await db.prepare(
    "INSERT INTO task_events (task_id, actor_type, actor_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?)"
  ).bind(taskId, actorType, actorId, eventType, JSON.stringify(payload)).run();
}

async function handleApi(request, env, url) {
  const auth = authorized(request, env);
  if (auth === "not-configured") {
    return json({ ok: false, error: "API authentication is not configured yet." }, 503);
  }
  if (!auth) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "Database unavailable" }, 503);

  const method = request.method;
  const path = url.pathname.replace(/\/$/, "");
  const parts = path.split("/").filter(Boolean);

  try {
    if (parts[1] === "workers" && parts.length === 2) {
      if (method === "GET") {
        const result = await env.DB.prepare(
          "SELECT id, name, role, status, capabilities_json, created_at, updated_at FROM workers ORDER BY created_at"
        ).all();
        return json({ ok: true, workers: result.results || [] });
      }

      if (method === "POST") {
        const body = await request.json();
        const { id, name, role } = body || {};
        const capabilities = body?.capabilities ?? [];
        if (
          typeof id !== "string" || !/^[a-zA-Z0-9_-]{2,64}$/.test(id) ||
          typeof name !== "string" || !name.trim() ||
          typeof role !== "string" || !role.trim() ||
          !Array.isArray(capabilities) ||
          capabilities.some((item) => typeof item !== "string")
        ) {
          return json({ ok: false, error: "Provide a valid id, name, role, and string-array capabilities." }, 400);
        }

        await env.DB.prepare(
          "INSERT INTO workers (id, name, role, capabilities_json) VALUES (?, ?, ?, ?)"
        ).bind(id, name.trim(), role.trim(), JSON.stringify(capabilities)).run();

        return json({ ok: true, worker: { id, name: name.trim(), role: role.trim(), status: "inactive", capabilities } }, 201);
      }
    }

    if (parts[1] === "workers" && parts.length === 3 && method === "PATCH") {
      const workerId = parts[2];
      const body = await request.json();
      const status = body?.status;
      if (!["active", "inactive", "paused"].includes(status)) {
        return json({ ok: false, error: "Worker status must be active, inactive, or paused." }, 400);
      }
      const current = await env.DB.prepare("SELECT id FROM workers WHERE id = ?").bind(workerId).first();
      if (!current) return json({ ok: false, error: "Worker not found." }, 404);
      await env.DB.prepare(
        "UPDATE workers SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
      ).bind(status, workerId).run();
      const worker = await env.DB.prepare(
        "SELECT id, name, role, status, capabilities_json, created_at, updated_at FROM workers WHERE id = ?"
      ).bind(workerId).first();
      return json({ ok: true, worker });
    }

    if (parts[1] === "tasks" && parts.length === 2) {
      if (method === "GET") {
        const status = url.searchParams.get("status");
        if (status && !TASK_STATUSES.has(status)) {
          return json({ ok: false, error: "Invalid task status." }, 400);
        }
        const result = status
          ? await env.DB.prepare(
              "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 100"
            ).bind(status).all()
          : await env.DB.prepare(
              "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100"
            ).all();
        return json({ ok: true, tasks: result.results || [] });
      }

      if (method === "POST") {
        const body = await request.json();
        const { title } = body || {};
        const description = typeof body?.description === "string" ? body.description : "";
        const priority = body?.priority ?? "normal";
        const requiresApproval = body?.requires_approval === true ? 1 : 0;

        if (typeof title !== "string" || !title.trim() || title.length > 200) {
          return json({ ok: false, error: "A task title (1–200 characters) is required." }, 400);
        }
        if (typeof description !== "string" || description.length > 10000) {
          return json({ ok: false, error: "Description must be 10,000 characters or fewer." }, 400);
        }
        if (!PRIORITIES.has(priority)) {
          return json({ ok: false, error: "Invalid task priority." }, 400);
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO tasks (id, title, description, priority, created_by, requires_approval) VALUES (?, ?, ?, ?, 'manager', ?)"
        ).bind(id, title.trim(), description, priority, requiresApproval).run();
        await recordEvent(env.DB, id, "manager", "manager", "task_created", {
          title: title.trim(),
          priority,
          requires_approval: requiresApproval === 1
        });

        return json({
          ok: true,
          task: {
            id,
            title: title.trim(),
            description,
            status: "pending",
            priority,
            requires_approval: requiresApproval
          }
        }, 201);
      }
    }

    if (parts[1] === "tasks" && parts.length === 3) {
      const taskId = parts[2];
      if (method === "GET") {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        if (!task) return json({ ok: false, error: "Task not found." }, 404);
        const events = await env.DB.prepare(
          "SELECT id, actor_type, actor_id, event_type, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY created_at"
        ).bind(taskId).all();
        return json({ ok: true, task, events: events.results || [] });
      }

      if (method === "PATCH") {
        const body = await request.json();
        const current = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        if (!current) return json({ ok: false, error: "Task not found." }, 404);

        const nextStatus = body?.status ?? current.status;
        const nextPriority = body?.priority ?? current.priority;
        const nextWorker = body?.assigned_worker_id === undefined
          ? current.assigned_worker_id
          : body.assigned_worker_id;

        if (!TASK_STATUSES.has(nextStatus)) return json({ ok: false, error: "Invalid task status." }, 400);
        if (!PRIORITIES.has(nextPriority)) return json({ ok: false, error: "Invalid task priority." }, 400);

        if (nextWorker !== null) {
          if (typeof nextWorker !== "string") return json({ ok: false, error: "Invalid worker id." }, 400);
          const worker = await env.DB.prepare("SELECT id, status FROM workers WHERE id = ?").bind(nextWorker).first();
          if (!worker) return json({ ok: false, error: "Assigned worker not found." }, 404);
          if (worker.status !== "active") return json({ ok: false, error: "Worker must be active before assignment." }, 409);
        }

        const completedAt = ["completed", "failed", "cancelled"].includes(nextStatus)
          ? (current.completed_at || new Date().toISOString())
          : null;

        await env.DB.prepare(
          "UPDATE tasks SET status = ?, priority = ?, assigned_worker_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), completed_at = ? WHERE id = ?"
        ).bind(nextStatus, nextPriority, nextWorker, completedAt, taskId).run();

        if (nextStatus !== current.status) {
          await recordEvent(env.DB, taskId, "manager", "manager", "status_changed", {
            from: current.status,
            to: nextStatus
          });
        }
        if (nextWorker !== current.assigned_worker_id) {
          await recordEvent(env.DB, taskId, "manager", "manager", "worker_assigned", {
            from: current.assigned_worker_id,
            to: nextWorker
          });
        }
        if (nextPriority !== current.priority) {
          await recordEvent(env.DB, taskId, "manager", "manager", "priority_changed", {
            from: current.priority,
            to: nextPriority
          });
        }

        const updated = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
        return json({ ok: true, task: updated });
      }
    }


    if (parts[1] === "approvals" && parts.length === 2) {
      if (method === "GET") {
        const status = url.searchParams.get("status");
        if (status && !["pending", "approved", "rejected"].includes(status)) {
          return json({ ok: false, error: "Invalid approval status." }, 400);
        }
        const query = status
          ? "SELECT a.*, t.title AS task_title FROM approval_requests a JOIN tasks t ON t.id = a.task_id WHERE a.status = ? ORDER BY a.requested_at DESC LIMIT 100"
          : "SELECT a.*, t.title AS task_title FROM approval_requests a JOIN tasks t ON t.id = a.task_id ORDER BY a.requested_at DESC LIMIT 100";
        const result = status
          ? await env.DB.prepare(query).bind(status).all()
          : await env.DB.prepare(query).all();
        return json({ ok: true, approvals: result.results || [] });
      }

      if (method === "POST") {
        const body = await request.json();
        const taskId = body?.task_id;
        const actionType = body?.action_type;
        const summary = body?.summary;
        if (typeof taskId !== "string" || !taskId.trim()) {
          return json({ ok: false, error: "A task_id is required." }, 400);
        }
        if (typeof actionType !== "string" || !actionType.trim() || actionType.length > 100) {
          return json({ ok: false, error: "action_type must be 1–100 characters." }, 400);
        }
        if (typeof summary !== "string" || !summary.trim() || summary.length > 2000) {
          return json({ ok: false, error: "summary must be 1–2,000 characters." }, 400);
        }
        const task = await env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(taskId.trim()).first();
        if (!task) return json({ ok: false, error: "Task not found." }, 404);

        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO approval_requests (id, task_id, action_type, summary) VALUES (?, ?, ?, ?)"
        ).bind(id, taskId.trim(), actionType.trim(), summary.trim()).run();
        await recordEvent(env.DB, taskId.trim(), "manager", "manager", "approval_requested", {
          approval_id: id,
          action_type: actionType.trim()
        });
        const approval = await env.DB.prepare(
          "SELECT * FROM approval_requests WHERE id = ?"
        ).bind(id).first();
        return json({ ok: true, approval }, 201);
      }
    }

    if (parts[1] === "approvals" && parts.length === 3 && method === "PATCH") {
      const approvalId = parts[2];
      const body = await request.json();
      const status = body?.status;
      const decisionNote = body?.decision_note ?? "";
      if (!["approved", "rejected"].includes(status)) {
        return json({ ok: false, error: "Approval status must be approved or rejected." }, 400);
      }
      if (typeof decisionNote !== "string" || decisionNote.length > 2000) {
        return json({ ok: false, error: "decision_note must be 2,000 characters or fewer." }, 400);
      }
      const current = await env.DB.prepare(
        "SELECT * FROM approval_requests WHERE id = ?"
      ).bind(approvalId).first();
      if (!current) return json({ ok: false, error: "Approval request not found." }, 404);
      if (current.status !== "pending") {
        return json({ ok: false, error: "This approval request has already been decided." }, 409);
      }

      const update = await env.DB.prepare(
        "UPDATE approval_requests SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), decision_note = ? WHERE id = ? AND status = 'pending'"
      ).bind(status, decisionNote.trim(), approvalId).run();
      if (update.meta?.changes === 0) {
        return json({ ok: false, error: "This approval request has already been decided." }, 409);
      }
      await recordEvent(env.DB, current.task_id, "manager", "manager", "approval_decided", {
        approval_id: approvalId,
        status,
        decision_note: decisionNote.trim()
      });
      const approval = await env.DB.prepare(
        "SELECT * FROM approval_requests WHERE id = ?"
      ).bind(approvalId).first();
      return json({ ok: true, approval, action_executed: false });
    }

    return json({ ok: false, error: "API route not found or method not allowed." }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json({ ok: false, error: "Request body must be valid JSON." }, 400);
    }
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      return json({ ok: false, error: "That ID already exists." }, 409);
    }
    return json({ ok: false, error: "Request could not be completed." }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "FV AI Workforce",
        status: "starter-online",
        version: "0.4.0",
        stage: "approval-api-foundation",
        integrations: {
          fliptopVault: false,
          firebase: false,
          facebook: false,
          aiProvider: false
        },
        apiAuthentication: env.WORKFORCE_API_TOKEN ? "configured" : "not-configured",
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname === "/health/db") {
      if (!env.DB) {
        return json({
          ok: false,
          database: "unbound",
          message: "The D1 binding is not available."
        }, 503);
      }

      try {
        const result = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workers', 'tasks', 'task_events', 'approval_requests') ORDER BY name"
        ).all();

        const tables = (result.results || []).map((row) => row.name);
        const expected = ["approval_requests", "task_events", "tasks", "workers"];
        const schemaReady = expected.every((name) => tables.includes(name));

        return json({
          ok: true,
          database: "connected",
          schemaReady,
          tables,
          expectedTables: expected,
          message: schemaReady
            ? "D1 is connected and the initial schema is ready."
            : "D1 is connected. Apply the initial database migration to create the tables.",
          timestamp: new Date().toISOString()
        });
      } catch {
        return json({
          ok: false,
          database: "query-failed",
          message: "D1 is bound, but the health query failed."
        }, 503);
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};
