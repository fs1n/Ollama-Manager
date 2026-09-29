// Pure helpers for the "Ollaya through LiteLLM" card.

export type TypesafeState =
  | "litellm-not-configured"
  | "litellm-unreachable"
  | "no-passthrough"
  | "unauthorized"
  | "upstream-error"
  | "other-service"
  | "connected";

export interface TypesafeStatus {
  state: TypesafeState;
  detail: string;
  litellmModels: string[];
  ollayaModels: string[];
  managementApiExposed: boolean;
  gatewayEnabled: boolean;
  gatewayPath: string;
}

/** Badge text and tone for a probe state. */
export function typesafeStateView(s: TypesafeStatus): {
  label: string;
  tone: "ok" | "warn" | "err";
} {
  // Connected but wide open is not "ok": the setup works and is unsafe.
  if (s.state === "connected") {
    return s.managementApiExposed
      ? { label: "connected, but unrestricted", tone: "err" }
      : { label: "connected", tone: "ok" };
  }
  const labels: Record<Exclude<TypesafeState, "connected">, [string, "warn" | "err"]> = {
    "litellm-not-configured": ["LiteLLM not configured", "warn"],
    "litellm-unreachable": ["LiteLLM unreachable", "err"],
    "no-passthrough": ["no TypeSafe pass-through", "warn"],
    unauthorized: ["LITELLM_KEY rejected", "err"],
    "upstream-error": ["pass-through misconfigured", "err"],
    "other-service": ["points elsewhere", "warn"],
  };
  const [label, tone] = labels[s.state];
  return { label, tone };
}

/**
 * Environment for the LiteLLM side. `managerUrl` is how LiteLLM reaches the
 * manager — in Docker usually a service name, not the browser's origin.
 */
export function litellmEnvSnippet(managerUrl: string, gatewayPath: string): string {
  return [
    "# LiteLLM proxy environment (LiteLLM ≥ 1.103)",
    `TYPESAFE_API_BASE=${managerUrl.replace(/\/+$/, "")}${gatewayPath}`,
    "TYPESAFE_API_KEY=<the manager's OLLAYA_TYPESAFE_KEY>",
  ].join("\n");
}

/** Example call through LiteLLM, as a client would make it. */
export function litellmCurlExample(litellmUrl: string, model: string): string {
  const base = (litellmUrl || "http://<litellm>:4000").replace(/\/+$/, "");
  const body = JSON.stringify({
    model,
    state: "I was charged twice this month. Please refund it.",
    questions: {
      department: { type: "choice", criteria: { billing: "Payments", technical: "Bugs" } },
    },
  });
  return `curl ${base}/typesafe/v1/systemone \\\n  -H "Authorization: Bearer <LiteLLM virtual key>" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}
