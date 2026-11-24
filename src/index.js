const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "FV AI Workforce",
        status: "starter-online",
        version: "0.1.0",
        stage: "foundation",
        integrations: {
          fliptopVault: false,
          firebase: false,
          facebook: false,
          aiProvider: false
        },
        timestamp: new Date().toISOString()
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};
