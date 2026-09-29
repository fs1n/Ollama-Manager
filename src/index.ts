// Entry point: reads the configuration, builds the app and starts listening.
// Importing this module has no side effects — the server only starts when it
// is run directly (`bun run src/index.ts`), so tests can import everything
// else (see src/app.ts) without binding a port.
import { createApp } from "./app";
import { type Config, loadConfig } from "./config";
import { log } from "./http";

function main(): void {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    log("error", "Invalid configuration", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const app = createApp(config);

  Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    // Bun's default is 10 s. The catalog scrape retries up to 3× with backoff
    // before it has anything to send back, which can legitimately take longer
    // than that when ollama.com is slow. Routes that may wait even longer
    // before their first byte (backend relay, LiteLLM sync) lift the limit for
    // their own request via server.timeout(req, 0), see `slow` in src/app.ts.
    idleTimeout: 60,
    fetch: (req, server) => app.fetch(req, server),
    error(err) {
      log("error", "Unhandled server error", { error: String(err) });
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    },
  });
  app.start();

  const { backends, masterKey, litellm } = config;
  log("info", "Ollama Manager started", {
    port: config.port,
    backends: backends.map((b) => ({ id: b.id, url: b.baseUrl, apiKey: !!b.apiKey })),
    auth: !!masterKey,
    litellm: litellm.enabled,
  });
  if (!masterKey) {
    log(
      "warn",
      `MASTER_KEY is not set — the manager is an open, unauthenticated proxy to the full API of ${backends.map((b) => b.label).join(" and ")} ` +
        "(pull/delete/create/inference) for anyone who can reach this port. Set MASTER_KEY unless this " +
        "instance is on a fully trusted, non-internet-facing network.",
    );
  }
  if (litellm.enabled) {
    log("info", "LiteLLM sync enabled", { url: litellm.url, intervalMin: litellm.intervalMin });
  }
}

if (import.meta.main) main();
