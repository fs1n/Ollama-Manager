import { escHtml } from "../utils/format";

type ToastType = "success" | "error" | "info" | "warning";

const ICONS: Record<ToastType, string> = {
  success: "ti-check",
  error: "ti-alert-circle",
  info: "ti-info-circle",
  warning: "ti-alert-triangle",
};

export function toast(msg: string, type: ToastType = "info"): void {
  const container = document.getElementById("toast-container");
  if (!container) return;
  // Remove oldest if already at 4
  while (container.children.length >= 4) container.firstChild?.remove();

  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="ti ${ICONS[type] || "ti-info-circle"}" aria-hidden="true"></i> ${escHtml(msg)}<button class="toast-close" aria-label="Dismiss">&times;</button>`;
  el.querySelector(".toast-close")?.addEventListener("click", () => el.remove());
  container.appendChild(el);

  const timeout = type === "error" ? 7000 : 3500;
  setTimeout(() => el.remove(), timeout);
}
