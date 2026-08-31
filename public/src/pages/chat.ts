import { apiOk, readNdjsonLines } from "../api";
import { renderMarkdown } from "../render/markdown";
import { ensureModels, populateModelSelects } from "../state/models";
import { toast } from "../ui/toast";
import { escHtml } from "../utils/format";

const TYPING_INDICATOR_HTML =
  '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

let chatHistory: ChatMessage[] = [];
let chatAbort: AbortController | null = null;

function clearChat(): void {
  chatAbort?.abort();
  chatAbort = null;
  chatHistory = [];
  (document.getElementById("chat-messages") as HTMLElement).innerHTML =
    '<div class="empty" style="margin:auto"><i class="ti ti-messages" aria-hidden="true"></i>Start a conversation<br><span style="font-size:12px;color:var(--text3)">Select a model above to begin</span></div>';
}

async function sendChat(): Promise<void> {
  const sendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;

  // If already streaming, this acts as stop
  if (chatAbort) {
    chatAbort.abort();
    return;
  }

  const input = document.getElementById("chat-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  const model = (document.getElementById("chat-model") as HTMLSelectElement).value;
  if (!model) {
    toast("Select a model first", "error");
    return;
  }

  // System prompt: only set at conversation start, ignore later changes mid-chat
  const system = (document.getElementById("chat-system") as HTMLTextAreaElement).value.trim();
  if (chatHistory.length === 0 && system) {
    chatHistory.push({ role: "system", content: system });
  }

  input.value = "";
  input.style.height = "auto";
  const msgBox = document.getElementById("chat-messages") as HTMLElement;
  msgBox.querySelector(".empty")?.remove();

  const userDiv = document.createElement("div");
  userDiv.className = "msg user";
  userDiv.innerHTML = `<div class="msg-avatar"><i class="ti ti-user" aria-hidden="true"></i></div><div class="msg-content">${escHtml(text)}</div>`;
  msgBox.appendChild(userDiv);

  const aDiv = document.createElement("div");
  aDiv.className = "msg assistant";
  aDiv.innerHTML = `<div class="msg-avatar"><i class="ti ti-robot" aria-hidden="true"></i></div><div class="msg-content">${TYPING_INDICATOR_HTML}</div>`;
  msgBox.appendChild(aDiv);
  const contentEl = aDiv.querySelector(".msg-content") as HTMLElement;
  msgBox.scrollTop = msgBox.scrollHeight;

  // Push user message AFTER UI is set up but before request — we'll roll back on error
  const userMsg: ChatMessage = { role: "user", content: text };
  chatHistory.push(userMsg);

  sendBtn.innerHTML = '<i class="ti ti-player-stop" aria-hidden="true"></i> Stop';
  sendBtn.classList.add("btn-danger");
  sendBtn.classList.remove("btn-primary");

  chatAbort = new AbortController();
  let full = "";

  try {
    const r = await apiOk("/api/chat", {
      method: "POST",
      body: JSON.stringify({ model, messages: chatHistory, stream: true }),
      signal: chatAbort.signal,
    });

    let firstChunk = true;

    for await (const ev of readNdjsonLines(r)) {
      if (ev.message?.content) {
        if (firstChunk) {
          contentEl.textContent = "";
          firstChunk = false;
        }
        full += ev.message.content;
        contentEl.appendChild(document.createTextNode(ev.message.content));
      } else if (ev.message?.thinking && firstChunk) {
        // Reasoning models (e.g. Qwen3, thinking-enabled Llama variants) can
        // stream a while on message.thinking before any message.content
        // arrives — without this the typing indicator just sits there with
        // no sign the model is doing anything. Preview the thinking trace
        // instead, but don't fold it into `full`/chatHistory: it's not the
        // answer, and the model wasn't asked to see its own prior reasoning
        // replayed back to it on the next turn. Cleared the moment real
        // content starts (the `firstChunk` branch above resets textContent).
        contentEl.appendChild(document.createTextNode(ev.message.thinking));
      }
      msgBox.scrollTop = msgBox.scrollHeight;
    }

    chatHistory.push({ role: "assistant", content: full });
    contentEl.innerHTML = renderMarkdown(contentEl.textContent || "");
  } catch (e: any) {
    // Roll back user message on failure (except for partial-success aborts)
    if (e.name === "AbortError") {
      if (full) {
        contentEl.appendChild(document.createTextNode("\n\n[stopped]"));
        chatHistory.push({ role: "assistant", content: full });
      } else {
        aDiv.remove();
        chatHistory.pop();
      }
    } else {
      contentEl.textContent = `Error: ${e.message}`;
      toast("Chat request failed", "error");
      chatHistory.pop(); // remove the user msg that never got answered
    }
  } finally {
    chatAbort = null;
    sendBtn.innerHTML = '<i class="ti ti-send" aria-hidden="true"></i> Send';
    sendBtn.classList.add("btn-primary");
    sendBtn.classList.remove("btn-danger");
  }
}

let genAbort: AbortController | null = null;

async function doGenerate(): Promise<void> {
  const genBtn = document.getElementById("gen-btn") as HTMLButtonElement;

  if (genAbort) {
    genAbort.abort();
    return;
  }

  const model = (document.getElementById("gen-model") as HTMLSelectElement).value;
  const prompt = (document.getElementById("gen-prompt") as HTMLTextAreaElement).value.trim();
  if (!model || !prompt) {
    toast("Select a model and enter a prompt", "error");
    return;
  }
  const system = (document.getElementById("gen-system") as HTMLTextAreaElement).value.trim();
  const format = (document.getElementById("gen-format") as HTMLSelectElement).value;
  const out = document.getElementById("gen-output") as HTMLElement;
  out.textContent = "";

  genAbort = new AbortController();
  genBtn.innerHTML = '<i class="ti ti-player-stop" aria-hidden="true"></i> Stop';
  genBtn.classList.add("btn-danger");
  genBtn.classList.remove("btn-primary");

  try {
    const body: Record<string, unknown> = { model, prompt, stream: true };
    if (system) body.system = system;
    if (format) body.format = format;
    const r = await apiOk("/api/generate", {
      method: "POST",
      body: JSON.stringify(body),
      signal: genAbort.signal,
    });
    for await (const ev of readNdjsonLines(r)) {
      if (ev.response) out.appendChild(document.createTextNode(ev.response));
    }
  } catch (e: any) {
    if (e.name !== "AbortError") toast(`Generate failed: ${e.message}`, "error");
  } finally {
    genAbort = null;
    genBtn.innerHTML = '<i class="ti ti-wand" aria-hidden="true"></i> Generate';
    genBtn.classList.remove("btn-danger");
    genBtn.classList.add("btn-primary");
  }
}

async function doEmbed(): Promise<void> {
  const model = (document.getElementById("embed-model") as HTMLSelectElement).value;
  const raw = (document.getElementById("embed-input") as HTMLTextAreaElement).value.trim();
  if (!model || !raw) {
    toast("Select a model and enter text", "error");
    return;
  }
  const input = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const truncate =
    (document.getElementById("embed-truncate") as HTMLSelectElement).value === "true";
  try {
    const r = await apiOk("/api/embed", {
      method: "POST",
      body: JSON.stringify({ model, input, truncate }),
    });
    const d = await r.json();
    const vecs: number[][] = d.embeddings || [];
    const statsDiv = document.getElementById("embed-stats") as HTMLElement;
    statsDiv.style.display = "block";
    (document.getElementById("embed-count") as HTMLElement).textContent = String(vecs.length);
    (document.getElementById("embed-dims") as HTMLElement).textContent = String(
      vecs[0]?.length || "—",
    );
    (document.getElementById("embed-tokens") as HTMLElement).textContent = String(
      d.prompt_eval_count || "—",
    );
    const preview = vecs
      .map(
        (v, i) =>
          `[${i}] [${v
            .slice(0, 8)
            .map((n) => n.toFixed(4))
            .join(", ")}${v.length > 8 ? `, …+${v.length - 8} more` : ""}]`,
      )
      .join("\n");
    (document.getElementById("embed-result") as HTMLElement).textContent = preview;
    toast(`Generated ${vecs.length} embedding(s) — ${vecs[0]?.length} dims`, "success");
  } catch (e: any) {
    toast(`Embed failed: ${e.message}`, "error");
  }
}

async function loadChatTab(): Promise<void> {
  await ensureModels();
  populateModelSelects();
}

export function initChat(): void {
  const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  // Auto-resize chat textarea
  chatInput.addEventListener("input", function (this: HTMLTextAreaElement) {
    this.style.height = "auto";
    this.style.height = `${Math.min(this.scrollHeight, 200)}px`;
  });

  document.getElementById("chat-clear-btn")?.addEventListener("click", clearChat);
  document.getElementById("chat-send-btn")?.addEventListener("click", sendChat);
  document.getElementById("gen-btn")?.addEventListener("click", doGenerate);
  document.getElementById("gen-output-clear-btn")?.addEventListener("click", () => {
    (document.getElementById("gen-output") as HTMLElement).textContent = "";
  });
  document.getElementById("embed-btn")?.addEventListener("click", doEmbed);
}

export const loadChat = loadChatTab;
export const loadGenerate = loadChatTab;
export const loadEmbeddings = loadChatTab;
