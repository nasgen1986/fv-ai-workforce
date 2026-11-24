const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "FV AI Workforce",
        status: "starter-online",
        version: "0.2.0",
        stage: "database-connected",
        integrations: {
          fliptopVault: false,
          firebase: false,
          facebook: false,
          aiProvider: false
        },
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
