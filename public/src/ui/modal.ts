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
  if (focus) {
    const firstFocusable = overlay.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    firstFocusable?.focus();
  }
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

  overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}
