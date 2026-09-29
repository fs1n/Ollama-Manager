import { api, apiOk, httpErrorDetail, readNdjsonLines } from "../api";
import { backendsWith, ensureBackends, hasMultipleBackends } from "../state/backends";
import { type BackendModel, ensureModels, fetchModels, modelCache } from "../state/models";
import { toast } from "../ui/toast";
import { backendPath, describeApiError, parseModelKey } from "../utils/backends";
import {
  type ApiQuestions,
  type DraftIssue,
  draftsToQuestions,
  emptyDraft,
  groupIssues,
  nsToMs,
  PRESETS,
  parseState,
  pct,
  probabilityRows,
  type QuestionDraft,
  type QuestionType,
  questionsToDrafts,
} from "../utils/decide";
import { errorMessage, escHtml, isAbortError } from "../utils/format";

// ---------------------------------------------------------------------------
// State

let drafts: QuestionDraft[] = [];
let mode: "form" | "json" = "form";
let useBuiltin = false;
let decideAbort: AbortController | null = null;
let imageDataUrl: string | null = null;

interface ShowInfo {
  questions?: ApiQuestions | null;
  capabilities?: string[];
  router?: { routes?: Record<string, string> } | null;
  details?: { family?: string; parameter_size?: string; format?: string };
}
// /api/show per model key; model details don't change while the page is open.
const showCache = new Map<string, ShowInfo>();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function decideModels(): BackendModel[] {
  const allowed = new Set(backendsWith("decide").map((b) => b.id));
  return modelCache.filter((m) => allowed.has(m.backend));
}

// ---------------------------------------------------------------------------
// Question editor

const TYPE_OPTIONS: [QuestionType, string][] = [
  ["choice", "Choice"],
  ["score", "Score"],
  ["noul", "Yes / no"],
];

function questionCard(d: QuestionDraft, i: number): string {
  const attr = (field: string, extra = "") => `data-i="${i}" data-field="${field}"${extra}`;
  let criteria = "";
  if (d.type === "choice") {
    criteria =
      d.options
        .map(
          (o, j) => `<div class="q-row">
          <input type="text" ${attr("opt-label", ` data-j="${j}"`)} value="${escHtml(o.label)}" placeholder="label" aria-label="Option ${j + 1} label">
          <input type="text" ${attr("opt-desc", ` data-j="${j}"`)} value="${escHtml(o.description)}" placeholder="description (optional)" aria-label="Option ${j + 1} description">
          <button type="button" class="btn btn-sm" data-action="remove-opt" data-i="${i}" data-j="${j}" aria-label="Remove option"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>`,
        )
        .join("") +
      `<button type="button" class="btn btn-sm" data-action="add-opt" data-i="${i}"><i class="ti ti-plus" aria-hidden="true"></i> Option</button>`;
  } else if (d.type === "score") {
    criteria =
      d.levels
        .map(
          (l, j) => `<div class="q-row level">
          <span class="q-level-no">${j}</span>
          <input type="text" ${attr("level", ` data-j="${j}"`)} value="${escHtml(l)}" placeholder="what level ${j} means" aria-label="Level ${j}">
          <button type="button" class="btn btn-sm" data-action="remove-opt" data-i="${i}" data-j="${j}" aria-label="Remove level"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>`,
        )
        .join("") +
      `<button type="button" class="btn btn-sm" data-action="add-opt" data-i="${i}"><i class="ti ti-plus" aria-hidden="true"></i> Level</button>`;
  } else {
    criteria = `<div class="q-row">
        <span class="q-level-no">yes</span>
        <input type="text" ${attr("noul-true")} value="${escHtml(d.noulTrue)}" placeholder="what “yes” means (optional)" aria-label="Meaning of yes">
      </div>
      <div class="q-row">
        <span class="q-level-no">no</span>
        <input type="text" ${attr("noul-false")} value="${escHtml(d.noulFalse)}" placeholder="what “no” means (optional)" aria-label="Meaning of no">
      </div>`;
  }
  return `<div class="q-card" data-card="${i}">
    <div class="q-head">
      <input type="text" ${attr("id")} value="${escHtml(d.id)}" placeholder="question id, e.g. department" aria-label="Question id">
      <select ${attr("type")} aria-label="Question type">${TYPE_OPTIONS.map(
        ([v, label]) => `<option value="${v}"${v === d.type ? " selected" : ""}>${label}</option>`,
      ).join("")}</select>
      <button type="button" class="btn btn-sm btn-danger" data-action="remove-q" data-i="${i}" aria-label="Remove question"><i class="ti ti-trash" aria-hidden="true"></i></button>
    </div>
    <textarea rows="1" ${attr("instructions")} placeholder="Instructions (optional — without them the model reads the id)" aria-label="Instructions">${escHtml(d.instructions)}</textarea>
    ${criteria}
    <div class="q-issues" id="q-issues-${i}"></div>
  </div>`;
}

function renderEditor(): void {
  const box = byId("decide-questions");
  box.innerHTML = drafts.length
    ? drafts.map(questionCard).join("")
    : '<div class="empty" style="padding:16px"><i class="ti ti-list-check" aria-hidden="true"></i>No questions yet — add one below or load an example</div>';
  box.classList.toggle("disabled", useBuiltin);
}

function showIssues(
  issues: DraftIssue[],
  byQuestionId = new Map<string, string[]>(),
  extraGeneral: string[] = [],
): void {
  document.querySelectorAll<HTMLElement>(".q-card").forEach((c) => {
    c.classList.remove("invalid");
  });
  document.querySelectorAll<HTMLElement>(".q-issues").forEach((el) => {
    el.textContent = "";
  });
  const add = (index: number, message: string) => {
    const el = document.getElementById(`q-issues-${index}`);
    if (!el) return false;
    el.textContent = el.textContent ? `${el.textContent} · ${message}` : message;
    document.querySelector(`[data-card="${index}"]`)?.classList.add("invalid");
    return true;
  };
  const general: string[] = [...extraGeneral];
  for (const issue of issues) {
    if (issue.index < 0 || !add(issue.index, issue.message)) general.push(issue.message);
  }
  for (const [id, messages] of byQuestionId) {
    const index = drafts.findIndex((d) => d.id.trim() === id);
    for (const m of messages) if (index < 0 || !add(index, m)) general.push(`${id}: ${m}`);
  }
  showErrors(general);
}

function showErrors(messages: string[]): void {
  byId("decide-errors").innerHTML = messages
    .map((m) => `<div class="decide-error">${escHtml(m)}</div>`)
    .join("");
}

function onEditorInput(e: Event): void {
  const el = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const i = Number(el.dataset.i);
  const j = Number(el.dataset.j);
  const d = drafts[i];
  if (!d || !el.dataset.field) return;
  switch (el.dataset.field) {
    case "id":
      d.id = el.value;
      break;
    case "instructions":
      d.instructions = el.value;
      break;
    case "type": {
      d.type = el.value as QuestionType;
      renderEditor(); // criteria inputs differ per type
      return;
    }
    case "opt-label":
      if (d.options[j]) d.options[j].label = el.value;
      break;
    case "opt-desc":
      if (d.options[j]) d.options[j].description = el.value;
      break;
    case "level":
      d.levels[j] = el.value;
      break;
    case "noul-true":
      d.noulTrue = el.value;
      break;
    case "noul-false":
      d.noulFalse = el.value;
      break;
  }
}

function onEditorClick(e: Event): void {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!btn) return;
  const d = drafts[Number(btn.dataset.i)];
  const j = Number(btn.dataset.j);
  switch (btn.dataset.action) {
    case "remove-q":
      drafts.splice(Number(btn.dataset.i), 1);
      break;
    case "add-opt":
      if (d?.type === "choice") d.options.push({ label: "", description: "" });
      else if (d?.type === "score") d.levels.push("");
      break;
    case "remove-opt":
      if (d?.type === "choice") d.options.splice(j, 1);
      else if (d?.type === "score") d.levels.splice(j, 1);
      break;
    default:
      return;
  }
  renderEditor();
}

function setMode(next: "form" | "json"): void {
  if (next === mode) return;
  const json = byId<HTMLTextAreaElement>("decide-questions-json");
  if (next === "json") {
    json.value = JSON.stringify(draftsToQuestions(drafts).questions, null, 2);
  } else {
    try {
      drafts = questionsToDrafts(JSON.parse(json.value || "{}"));
    } catch (e) {
      showErrors([`Can't switch to the editor: ${errorMessage(e)}`]);
      return;
    }
    renderEditor();
  }
  mode = next;
  showErrors([]);
  json.style.display = next === "json" ? "" : "none";
  byId("decide-questions").style.display = next === "json" ? "none" : "";
  byId("decide-add").style.display = next === "json" ? "none" : "";
  document.querySelectorAll<HTMLElement>(".decide-mode").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === next);
  });
}

function loadQuestions(questions: ApiQuestions): void {
  drafts = questionsToDrafts(questions);
  if (mode === "json") {
    byId<HTMLTextAreaElement>("decide-questions-json").value = JSON.stringify(questions, null, 2);
  }
  renderEditor();
  showIssues([]);
}

/** The questions to send, or null (with the issues shown) when invalid. */
function currentQuestions(): ApiQuestions | null {
  if (mode === "json") {
    try {
      const parsed = JSON.parse(byId<HTMLTextAreaElement>("decide-questions-json").value || "{}");
      // Round-trip through the drafts so both modes validate the same way.
      drafts = questionsToDrafts(parsed);
    } catch (e) {
      showErrors([`Questions JSON: ${errorMessage(e)}`]);
      return null;
    }
  }
  const { questions, issues } = draftsToQuestions(drafts);
  if (mode === "form") showIssues(issues);
  else
    showErrors(
      issues.map((i) =>
        i.index >= 0 ? `${drafts[i.index]?.id || `#${i.index + 1}`}: ${i.message}` : i.message,
      ),
    );
  return issues.length ? null : questions;
}

// ---------------------------------------------------------------------------
// Model selection and built-in questions

function populateModelSelect(): void {
  const sel = byId<HTMLSelectElement>("decide-model");
  const models = decideModels();
  const cur = sel.value;
  const suffix = (m: BackendModel) => (hasMultipleBackends() ? ` · ${m.backend}` : "");
  sel.innerHTML = models.length
    ? models
        .map((m) => `<option value="${escHtml(m.key)}">${escHtml(m.name + suffix(m))}</option>`)
        .join("")
    : '<option value="">— no decision models installed —</option>';
  if (cur && models.some((m) => m.key === cur)) sel.value = cur;
}

async function showInfo(key: string): Promise<ShowInfo | null> {
  const cached = showCache.get(key);
  if (cached) return cached;
  const parsed = parseModelKey(key);
  if (!parsed) return null;
  try {
    const r = await apiOk(backendPath(parsed.backend, "/show"), {
      method: "POST",
      body: JSON.stringify({ model: parsed.name }),
    });
    const info = (await r.json()) as ShowInfo;
    showCache.set(key, info);
    return info;
  } catch {
    return null;
  }
}

async function onModelChange(): Promise<void> {
  const key = byId<HTMLSelectElement>("decide-model").value;
  const infoEl = byId("decide-model-info");
  const builtinEl = byId("decide-builtin");
  useBuiltin = false;
  builtinEl.style.display = "none";
  infoEl.textContent = "";
  renderEditor();
  if (!key) return;
  const info = await showInfo(key);
  if (byId<HTMLSelectElement>("decide-model").value !== key) return; // changed meanwhile
  if (!info) return;

  const bits: string[] = [];
  if (info.details?.family) bits.push(info.details.family);
  if (info.details?.parameter_size) bits.push(info.details.parameter_size);
  if (info.router?.routes) {
    bits.push(`router → ${Object.values(info.router.routes).join(" / ")}`);
  }
  if (info.capabilities?.length) bits.push(`answers: ${info.capabilities.join(", ")}`);
  infoEl.textContent = bits.join(" · ");

  const builtIn = info.questions ? Object.keys(info.questions).length : 0;
  if (builtIn > 0) {
    builtinEl.style.display = "";
    builtinEl.innerHTML = `<span><i class="ti ti-info-circle" aria-hidden="true"></i> This model has ${builtIn} built-in question${builtIn === 1 ? "" : "s"}.</span>
      <label class="decide-check"><input type="checkbox" id="decide-use-builtin"> Use them (send no questions)</label>
      <button type="button" class="btn btn-sm" data-action="load-builtin">Copy into the editor</button>`;
  }
}

// ---------------------------------------------------------------------------
// Running a decision

interface Answer {
  type?: string;
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  laya?: { confidence?: number; act_probability?: number | null } | null;
}

interface DecideResponse {
  model?: string;
  answers?: Record<string, Answer>;
  usage?: { input_tokens?: number };
  routing?: Record<string, unknown> | null;
  state_truncated?: boolean;
  total_duration?: number;
  load_duration?: number;
  eval_duration?: number;
}

function bars(rows: [string, number][], top: string | undefined, label = (l: string) => l): string {
  return rows
    .map(
      ([l, p]) => `<div class="prob-row${l === top ? " top" : ""}">
        <span class="prob-label" title="${escHtml(label(l))}">${escHtml(label(l))}</span>
        <span class="prob-track"><span class="prob-fill" style="width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%"></span></span>
        <span class="prob-value">${pct(p)}</span>
      </div>`,
    )
    .join("");
}

function renderAnswer(id: string, a: Answer): string {
  const rows = probabilityRows(a.probabilities);
  const top = rows.reduce<[string, number] | undefined>(
    (best, r) => (!best || r[1] > best[1] ? r : best),
    undefined,
  )?.[0];
  let main = "";
  let body = "";
  if (a.type === "choice" || typeof a.choice === "string") {
    main = a.choice ?? "";
    body = bars(rows, a.choice);
  } else if (a.type === "score" || typeof a.score === "number") {
    const levels = rows.length;
    const nearest = typeof a.score === "number" ? String(Math.round(a.score)) : undefined;
    const legend = a.legend ?? {};
    main = `${typeof a.score === "number" ? a.score.toFixed(2) : "—"} / ${Math.max(levels - 1, 0)}${nearest && legend[nearest] ? ` · ${legend[nearest]}` : ""}`;
    body = bars(rows, top, (l) => (legend[l] ? `${l} · ${legend[l]}` : l));
  } else {
    const p = typeof a.noul === "number" ? a.noul : undefined;
    main = p === undefined ? "—" : p >= 0.5 ? "yes" : "no";
    body = bars(
      p === undefined ? [] : [["yes", p]],
      p !== undefined && p >= 0.5 ? "yes" : undefined,
    );
  }
  const badges = [
    `<span class="badge">${escHtml(a.type ?? "")}</span>`,
    typeof a.confidence === "number"
      ? `<span class="badge">confidence ${pct(a.confidence)}</span>`
      : "",
    typeof a.laya?.confidence === "number"
      ? `<span class="badge" title="laya: 1 − normalized entropy">laya confidence ${pct(a.laya.confidence)}</span>`
      : "",
    typeof a.laya?.act_probability === "number"
      ? `<span class="badge" title="Probability that acting on this answer is appropriate">act ${pct(a.laya.act_probability)}</span>`
      : "",
  ].join("");
  return `<div class="answer">
    <div class="answer-head"><span class="answer-id">${escHtml(id)}</span>${badges}<span class="answer-main">${escHtml(main)}</span></div>
    ${body}
  </div>`;
}

function renderResult(d: DecideResponse): void {
  const answers = Object.entries(d.answers ?? {});
  const routing = d.routing
    ? Object.entries(d.routing)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ")
    : "";
  const meta = [
    d.model ? `<span class="badge">answered by ${escHtml(d.model)}</span>` : "",
    routing ? `<span class="badge">routing ${escHtml(routing)}</span>` : "",
    typeof d.usage?.input_tokens === "number"
      ? `<span class="badge">${d.usage.input_tokens} tokens</span>`
      : "",
    `<span class="badge">total ${nsToMs(d.total_duration)}</span>`,
    d.load_duration ? `<span class="badge">load ${nsToMs(d.load_duration)}</span>` : "",
    `<span class="badge">model ${nsToMs(d.eval_duration)}</span>`,
  ].join("");
  byId("decide-result").innerHTML =
    (d.state_truncated
      ? '<div class="backend-warning"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Part of the state was cut to fit the model\'s context — answers are based on what remained.</div>'
      : "") +
    (answers.length
      ? answers.map(([id, a]) => renderAnswer(id, a)).join("")
      : '<div class="empty" style="padding:12px">No answers</div>') +
    `<div class="decide-meta">${meta}</div>`;
  byId("decide-result-card").style.display = "";
}

function setBusy(busy: boolean, label?: string): void {
  const btn = byId<HTMLButtonElement>("decide-btn");
  btn.innerHTML = busy
    ? `<i class="ti ti-player-stop" aria-hidden="true"></i> ${label ?? "Stop"}`
    : '<i class="ti ti-arrows-split" aria-hidden="true"></i> Decide';
  btn.classList.toggle("btn-danger", busy);
  btn.classList.toggle("btn-primary", !busy);
}

async function runDecide(): Promise<void> {
  if (decideAbort) {
    decideAbort.abort();
    return;
  }
  const target = parseModelKey(byId<HTMLSelectElement>("decide-model").value);
  if (!target) {
    toast("Select a decision model first", "error");
    return;
  }
  const stateText = byId<HTMLTextAreaElement>("decide-state").value;
  if (!stateText.trim() && !imageDataUrl) {
    showErrors(["Enter a state to decide about"]);
    return;
  }

  const body: Record<string, unknown> = { model: target.name, state: parseState(stateText) };
  if (!useBuiltin) {
    const questions = currentQuestions();
    if (!questions) return;
    body.questions = questions;
  } else {
    showIssues([]);
  }
  const keepAlive = byId<HTMLSelectElement>("decide-keep-alive").value;
  if (keepAlive) body.keep_alive = /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive;
  if (byId<HTMLInputElement>("decide-extras").checked) body.extras = ["laya"];
  if (imageDataUrl) body.images = [imageDataUrl];

  decideAbort = new AbortController();
  setBusy(true);
  // A cold model can take a while to load before the first answer.
  const slowHint = setTimeout(() => setBusy(true, "Loading model… (stop)"), 1500);
  try {
    const r = await api(backendPath(target.backend, "/decide"), {
      method: "POST",
      body: JSON.stringify(body),
      signal: decideAbort.signal,
    });
    if (!r.ok) {
      const err = (await r.json().catch(() => null)) as { detail?: unknown } | null;
      const { byQuestion, general } = groupIssues(err?.detail);
      if (byQuestion.size || general.length) {
        // Each message next to its question in the editor; in JSON mode, and
        // for everything that isn't about one question, in the error list.
        if (mode === "form") showIssues([], byQuestion, general);
        else {
          showErrors([
            ...[...byQuestion].flatMap(([id, ms]) => ms.map((m) => `${id}: ${m}`)),
            ...general,
          ]);
        }
      } else {
        showErrors([describeApiError(r.status, err)]);
      }
      return;
    }
    renderResult((await r.json()) as DecideResponse);
  } catch (e) {
    if (!isAbortError(e)) showErrors([`Request failed: ${errorMessage(e)}`]);
  } finally {
    clearTimeout(slowHint);
    decideAbort = null;
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Save as model (/api/create)

interface CreateLine {
  status?: string;
  error?: string;
  code?: string;
}

let saving = false;

async function saveAsModel(): Promise<void> {
  if (saving) return;
  const source = parseModelKey(byId<HTMLSelectElement>("decide-model").value);
  const name = byId<HTMLInputElement>("decide-save-name").value.trim();
  const description = byId<HTMLInputElement>("decide-save-desc").value.trim();
  if (!source || !name) {
    toast("Select a model and enter a name for the new one", "error");
    return;
  }
  const questions = currentQuestions();
  if (!questions) return;
  const log = byId("decide-save-log");
  log.style.display = "";
  log.innerHTML = "";
  saving = true;
  try {
    const r = await api(backendPath(source.backend, "/create"), {
      method: "POST",
      body: JSON.stringify({
        model: name,
        from: source.name,
        questions,
        ...(description ? { description } : {}),
      }),
    });
    if (!r.ok) throw new Error(await httpErrorDetail(r));
    let done = false;
    for await (const ev of readNdjsonLines<CreateLine>(r)) {
      if (ev.error) throw new Error(ev.code ? `${ev.error} (${ev.code})` : ev.error);
      if (ev.status) {
        log.insertAdjacentHTML("beforeend", `<span class="log-line">${escHtml(ev.status)}</span>`);
        if (ev.status === "success") done = true;
      }
    }
    if (!done) throw new Error("the stream ended before the model was written");
    toast(`Created ${name}`, "success");
    await fetchModels();
    populateModelSelect();
  } catch (e) {
    log.insertAdjacentHTML(
      "beforeend",
      `<span class="log-line err">${escHtml(errorMessage(e))}</span>`,
    );
    toast(`Create failed: ${errorMessage(e)}`, "error");
  } finally {
    saving = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring

export async function loadDecide(): Promise<void> {
  await ensureBackends();
  await ensureModels();
  populateModelSelect();
  if (!drafts.length && !byId<HTMLTextAreaElement>("decide-state").value) {
    const [first] = PRESETS;
    if (first) {
      byId<HTMLTextAreaElement>("decide-state").value = first.state;
      loadQuestions(first.questions);
    }
  } else {
    renderEditor();
  }
  await onModelChange();
}

export function initDecide(): void {
  const presetSel = byId<HTMLSelectElement>("decide-preset");
  presetSel.insertAdjacentHTML(
    "beforeend",
    PRESETS.map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.label)}</option>`).join(""),
  );
  presetSel.addEventListener("change", () => {
    const preset = PRESETS.find((p) => p.id === presetSel.value);
    presetSel.value = "";
    if (!preset) return;
    byId<HTMLTextAreaElement>("decide-state").value = preset.state;
    loadQuestions(preset.questions);
  });

  byId("decide-model").addEventListener("change", onModelChange);
  const editor = byId("decide-questions");
  editor.addEventListener("input", onEditorInput);
  editor.addEventListener("change", (e) => {
    if ((e.target as HTMLElement).dataset.field === "type") onEditorInput(e);
  });
  editor.addEventListener("click", onEditorClick);

  byId("decide-add").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-add]");
    if (!btn?.dataset.add) return;
    drafts.push(emptyDraft(btn.dataset.add as QuestionType));
    renderEditor();
    const inputs = document.querySelectorAll<HTMLInputElement>(
      '#decide-questions [data-field="id"]',
    );
    inputs[inputs.length - 1]?.focus();
  });

  byId("decide-modes").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]");
    if (btn?.dataset.mode === "form" || btn?.dataset.mode === "json") setMode(btn.dataset.mode);
  });

  byId("decide-builtin").addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (box.id !== "decide-use-builtin") return;
    useBuiltin = box.checked;
    byId("decide-questions").classList.toggle("disabled", useBuiltin);
  });
  byId("decide-builtin").addEventListener("click", async (e) => {
    if (!(e.target as HTMLElement).closest('[data-action="load-builtin"]')) return;
    const info = showCache.get(byId<HTMLSelectElement>("decide-model").value);
    if (info?.questions) loadQuestions(info.questions);
  });

  byId("decide-image").addEventListener("change", () => {
    const file = byId<HTMLInputElement>("decide-image").files?.[0];
    imageDataUrl = null;
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      imageDataUrl = typeof reader.result === "string" ? reader.result : null;
    };
    reader.readAsDataURL(file);
  });

  byId("decide-btn").addEventListener("click", runDecide);
  byId("decide-state").addEventListener("keydown", (e) => {
    if (
      (e as KeyboardEvent).key === "Enter" &&
      ((e as KeyboardEvent).ctrlKey || (e as KeyboardEvent).metaKey)
    ) {
      runDecide();
    }
  });
  byId("decide-save-btn").addEventListener("click", saveAsModel);
}
