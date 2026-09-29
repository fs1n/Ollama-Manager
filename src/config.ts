// All configuration the server reads from the environment, validated in one
// place. Invalid values fail at startup with a message naming the variable,
// instead of surfacing later as a confusing relay or URL error.
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Backend, loadBackends } from "./backends";

export interface Config {
  masterKey: string;
  port: number;
  trustProxy: boolean;
  version: string;
  publicDir: string;
  backends: Backend[];
  litellm: { url: string; key: string; intervalMin: number; enabled: boolean };
}

function readVersion(env: Record<string, string | undefined>): string {
  if (env.OLLAMA_MANAGER_VERSION) return env.OLLAMA_MANAGER_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8"));
    return pkg.version || "dev";
  } catch {
    return "dev";
  }
}

function intFrom(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = (env[name] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not a non-negative integer`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const litellmUrl = (env.LITELLM_URL || "").trim().replace(/\/+$/, "");
  const litellmKey = (env.LITELLM_KEY || "").trim();
  return {
    masterKey: (env.MASTER_KEY || "").trim(),
    port: intFrom(env, "PORT", 3000),
    // Only trust X-Forwarded-For/-Proto when the manager genuinely sits behind
    // a reverse proxy that overwrites them. Without this, any directly-connected
    // client can spoof a fresh IP per request and bypass the login rate limit.
    trustProxy: ["1", "true", "yes"].includes((env.TRUST_PROXY || "").trim().toLowerCase()),
    version: readVersion(env),
    // Built by `bun run build:web`: the authored public/index.html references
    // TS/CSS module sources directly, which browsers can't run — the build step
    // bundles them and rewrites the HTML to point at hashed output files.
    publicDir: path.join(import.meta.dir, "..", "dist", "public"),
    backends: loadBackends(env),
    litellm: {
      url: litellmUrl,
      key: litellmKey,
      intervalMin: intFrom(env, "LITELLM_SYNC_INTERVAL", 30),
      enabled: !!(litellmUrl && litellmKey),
    },
  };
}
