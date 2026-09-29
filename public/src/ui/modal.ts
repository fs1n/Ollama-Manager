import { firstFocusable, trapFocus } from "./focus";

let modalTrigger: HTMLElement | null = null;

export function openModal(
  title: string,
  content: string,
  { rich = false, focus = false }: { rich?: boolean; focus?: boolean } = {},
): void {
  modalTrigger = document.activeElement as HTMLElement | null;
  const body = document.getElementById("modal-body") as HTMLElement;
  body.classList.toggle("rich", rich);
  if (rich) body.innerHTML = content;
  else body.textContent = content;
  (document.getElementById("modal-title-text") as HTMLElement).textContent = title;
  const overlay = document.getElementById("modal-overlay") as HTMLElement;
  overlay.classList.add("open");
  if (focus) firstFocusable(overlay)?.focus();
}

function closeModalNow(): void {
  document.getElementById("modal-overlay")?.classList.remove("open");
  if (modalTrigger) {
    modalTrigger.focus();
    modalTrigger = null;
  }
}

export function initModal(): void {
  const overlay = document.getElementById("modal-overlay") as HTMLElement;

  overlay.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "modal-overlay") closeModalNow();
  });

  document.getElementById("modal-close-btn")?.addEventListener("click", closeModalNow);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeModalNow();
  });

  overlay.addEventListener("keydown", (e) => trapFocus(overlay, e));
}
