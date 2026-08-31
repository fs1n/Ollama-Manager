export function showConfirm(title: string, message: string, okLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-overlay") as HTMLElement;
    const okBtn = document.getElementById("confirm-ok-btn") as HTMLButtonElement;
    const cancelBtn = document.getElementById("confirm-cancel-btn") as HTMLButtonElement;
    (document.getElementById("confirm-title") as HTMLElement).textContent = title;
    (document.getElementById("confirm-message") as HTMLElement).textContent = message;
    okBtn.textContent = okLabel;
    overlay.classList.add("open");

    function cleanup(result: boolean) {
      overlay.classList.remove("open");
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("keydown", onTrap);
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(result);
    }
    function onBackdrop(e: MouseEvent) {
      if (e.target === overlay) cleanup(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      }
    }
    function onTrap(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        overlay.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
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
    }

    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("keydown", onTrap);
    cancelBtn.focus();
  });
}
