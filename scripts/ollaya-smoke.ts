// End-to-end smoke test against a real Ollaya, through a running manager:
// backend registry, pull, decide, "save as model", the TypeSafe gateway and
// its allowlist, delete. Used by .github/workflows/ollaya-smoke.yml and
// runnable by hand:
//
//   MANAGER_URL=http://localhost:3000 MASTER_KEY=… OLLAYA_TYPESAFE_KEY=… \
//     bun run scripts/ollaya-smoke.ts
//
// Exits non-zero on the first failed check.

const MANAGER = (process.env.MANAGER_URL || "http://localhost:3000").replace(/\/+$/, "");
const MASTER_KEY = process.env.MASTER_KEY || "";
const GATEWAY_KEY = process.env.OLLAYA_TYPESAFE_KEY || "";
const MODEL = process.env.SMOKE_MODEL || "laya:en";
const CREATED = `smoke-${Date.now()}`;

let session = "";
let step = 0;

function check(cond: unknown, what: string, detail?: unknown): asserts cond {
  step++;
  if (!cond) {
    console.error(`✗ ${step}. ${what}`, detail === undefined ? "" : JSON.stringify(detail));
    process.exit(1);
  }
  console.log(`✓ ${step}. ${what}`);
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (session) headers.set("x-session-token", session);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${MANAGER}${path}`, { ...init, headers });
}

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

if (MASTER_KEY) {
  const r = await call("/api/auth", { method: "POST", body: JSON.stringify({ key: MASTER_KEY }) });
  check(r.ok, "login with MASTER_KEY", r.status);
  session = (await json<{ token: string }>(r)).token;
}

// 1. Registry
const { backends } = await json<{ backends: { id: string; kind: string; status: string }[] }>(
  await call("/api/backends"),
);
const ollaya = backends.find((b) => b.kind === "ollaya");
check(ollaya?.status === "connected", "Ollaya backend is configured and connected", backends);

// 2. Pull through the manager (streams NDJSON, must end with success)
const pull = await call(`/api/backends/${ollaya.id}/pull`, {
  method: "POST",
  body: JSON.stringify({ model: MODEL }),
});
const lines = (await pull.text()).trim().split("\n");
check(
  pull.ok && lines.at(-1)?.includes('"success"'),
  `pull ${MODEL} ends with success`,
  lines.at(-1),
);

// 3. Decide through the relay
const decide = await call(`/api/backends/${ollaya.id}/decide`, {
  method: "POST",
  body: JSON.stringify({
    model: MODEL,
    state: "I was charged twice for my subscription. Please refund the second charge.",
    questions: {
      department: {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: { billing: "Payments and refunds", technical: "Bugs and outages" },
      },
      refund: { type: "noul", instructions: "The customer asks for money back." },
    },
  }),
});
const answers = (
  await json<{ answers?: Record<string, { choice?: string; noul?: number }> }>(decide)
).answers;
check(decide.ok && answers?.department?.choice === "billing", "decide picks billing", answers);
check((answers?.refund?.noul ?? 0) > 0.5, "decide sees the refund request", answers?.refund);

// 4. Validation errors come back as 422 with detail
const invalid = await call(`/api/backends/${ollaya.id}/decide`, {
  method: "POST",
  body: JSON.stringify({
    model: MODEL,
    state: "x",
    questions: { q: { type: "choice", criteria: ["one"] } },
  }),
});
check(invalid.status === 422, "an invalid question is a 422", invalid.status);

// 5. Save as model (/api/create), then answer with its built-in questions
const create = await call(`/api/backends/${ollaya.id}/create`, {
  method: "POST",
  body: JSON.stringify({
    model: CREATED,
    from: MODEL,
    questions: { spam: { type: "noul", instructions: "The message is unsolicited advertising." } },
    stream: false,
  }),
});
check(create.ok, `create ${CREATED}`, create.status);
const builtIn = await json<{ answers?: Record<string, unknown> }>(
  await call(`/api/backends/${ollaya.id}/decide`, {
    method: "POST",
    body: JSON.stringify({ model: CREATED, state: "BUY CHEAP WATCHES NOW!!!" }),
  }),
);
check(
  builtIn.answers && "spam" in builtIn.answers,
  "the created model answers its built-in question",
  builtIn,
);

// 6. TypeSafe gateway (only if configured)
if (GATEWAY_KEY) {
  const gw = (path: string, init: RequestInit = {}, key = GATEWAY_KEY) =>
    fetch(`${MANAGER}/api/typesafe${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    });
  const models = await gw("/v1/models");
  check(models.ok, "gateway lists models", models.status);
  const one = await gw("/v1/systemone", {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      state: "The app crashes on login.",
      questions: { team: { type: "choice", criteria: { billing: "Payments", technical: "Bugs" } } },
    }),
  });
  check(one.ok, "gateway answers systemone", one.status);
  check((await gw("/v1/models", {}, "wrong-key")).status === 401, "gateway refuses a wrong key");
  const mgmt = await gw("/api/tags");
  check(
    mgmt.status === 404 || mgmt.status === 401,
    "gateway refuses Ollaya's management API",
    mgmt.status,
  );
}

// 7. Clean up
const del = await call(`/api/backends/${ollaya.id}/delete`, {
  method: "DELETE",
  body: JSON.stringify({ model: CREATED }),
});
check(del.ok, `delete ${CREATED}`, del.status);

console.log(`\nAll ${step} checks passed.`);

export {};
