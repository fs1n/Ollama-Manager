import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const MASTER_KEY = (process.env.MASTER_KEY || "").trim();
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_URL = new URL(OLLAMA_HOST);
const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

const VERSION = process.env.OLLAMA_MANAGER_VERSION || (() => {
  try {
    const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
    return pkg.version || "dev";
  } catch {
    return "dev";
  }
})();

const sessions = new Map<string, number>();

// Periodic cleanup of expired sessions (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 3600_000);

function jsonError(message: string, status = 502): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generateToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isSessionValid(token: string): boolean {
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

async function forwardToOllama(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `${OLLAMA_HOST}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("host", OLLAMA_URL.host);
  // Strip browser-originated headers — the manager is the HTTP client to Ollama,
  // and Ollama's OLLAMA_ORIGINS check would reject a non-localhost Origin.
  headers.delete("origin");
  headers.delete("referer");

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

interface LibraryModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
}

let libraryCache: LibraryModel[] | null = null;
let libraryCacheTime = 0;
const LIBRARY_TTL = 3600_000;

async function fetchLibrary(): Promise<LibraryModel[]> {
  if (libraryCache && Date.now() - libraryCacheTime < LIBRARY_TTL) {
    return libraryCache;
  }

  const resp = await fetch("https://ollama.com/library", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const html = await resp.text();
  const models: LibraryModel[] = [];
  const cards = html.split("<li x-test-model");

  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];
    const nameMatch = card.match(/href="\/library\/([^"]+)"/);
    const descMatch = card.match(/<p[^>]*class="[^"]*text-neutral-800[^"]*"[^>]*>([^<]+)<\/p>/);
    const caps: string[] = [];
    const sizes: string[] = [];

    for (const m of card.matchAll(/x-test-capability[^>]*>([^<]+)<\//g)) caps.push(m[1].trim());
    for (const m of card.matchAll(/x-test-size[^>]*>([^<]+)<\//g)) sizes.push(m[1].trim());

    if (nameMatch) {
      models.push({
        name: nameMatch[1],
        description: descMatch?.[1] || "",
        capabilities: caps,
        sizes,
      });
    }
  }

  libraryCache = models;
  libraryCacheTime = Date.now();
  return models;
}

async function serveLibrary(): Promise<Response> {
  try {
    const models = await fetchLibrary();
    return Response.json({ models, cached: Date.now() - libraryCacheTime < 5000 });
  } catch {
    return jsonError("Failed to fetch library catalog");
  }
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);

    // Session status (public)
    if (url.pathname === "/api/session" && req.method === "GET") {
      const token = req.headers.get("x-session-token") || "";
      return Response.json({
        authRequired: !!MASTER_KEY,
        authenticated: MASTER_KEY ? isSessionValid(token) : true,
      });
    }

    // Login (public)
    if (url.pathname === "/api/auth" && req.method === "POST") {
      return (async () => {
        try {
          const { key } = await req.json();
          if (!key || !MASTER_KEY) return jsonError("Unauthorized", 401);
          if (!timingSafeCompare(key, MASTER_KEY)) return jsonError("Unauthorized", 401);
          const token = generateToken();
          sessions.set(token, Date.now() + SESSION_TTL);
          return Response.json({ token, expires: sessions.get(token) });
        } catch {
          return jsonError("Invalid request", 400);
        }
      })();
    }

    // Logout
    if (url.pathname === "/api/logout" && req.method === "POST") {
      const token = req.headers.get("x-session-token") || "";
      if (token) sessions.delete(token);
      return Response.json({ ok: true });
    }

    // App version (public)
    if (url.pathname === "/api/app-version") {
      return Response.json({ version: VERSION });
    }

    // Health (public — needed for Docker HEALTHCHECK)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Static files (public — frontend handles login UI)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return new Response(Bun.file("./public/index.html"));
    }

    // Auth gate (API only)
    if (MASTER_KEY) {
      const token = req.headers.get("x-session-token") || "";
      if (!isSessionValid(token)) {
        return jsonError("Unauthorized", 401);
      }
    }

    // API routes
    if (url.pathname === "/api/catalog/library") {
      return serveLibrary();
    }

    return forwardToOllama(req);
  },
  error() {
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`Ollama Manager → http://0.0.0.0:${PORT}`);
if (MASTER_KEY) {
  console.log("Master key authentication enabled");
}
console.log(`Configured Ollama endpoint → ${OLLAMA_HOST}`);
