const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_URL = new URL(OLLAMA_HOST);
const PORT = parseInt(process.env.PORT || "3000");

function jsonError(message: string, status = 502): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function forwardToOllama(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `${OLLAMA_HOST}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("host", OLLAMA_URL.host);

  try {
    const resp = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      signal: req.signal,
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    return jsonError("Ollama unreachable");
  }
}

async function fetchCatalog(): Promise<Response> {
  try {
    const resp = await fetch("https://ollama.com/api/tags");
    const data = await resp.json();
    return Response.json(data);
  } catch {
    return jsonError("Failed to fetch catalog");
  }
}

Bun.serve({
  port: PORT,
  routes: {
    "/health": new Response(
      JSON.stringify({ status: "ok" }),
      { headers: { "Content-Type": "application/json" } }
    ),
    "/api/proxy/catalog": {
      GET: fetchCatalog,
    },
  },
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return new Response(Bun.file("./public/index.html"));
    }

    return forwardToOllama(req);
  },
  error() {
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`Ollama Manager → http://localhost:${PORT}`);
console.log(`Configured Ollama endpoint → ${OLLAMA_HOST}`);
