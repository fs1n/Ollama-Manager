import { trapFocus } from "./focus";

// Closes the dialog that is currently open, if any (resolving it as
// cancelled), so a second showConfirm() never leaves the first one's promise
// and listeners dangling.
let closeOpen: ((result: boolean) => void) | null = null;

export function showConfirm(title: string, message: string, okLabel = "Confirm"): Promise<boolean> {
  closeOpen?.(false);
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-overlay") as HTMLElement;
    const okBtn = document.getElementById("confirm-ok-btn") as HTMLButtonElement;
    const cancelBtn = document.getElementById("confirm-cancel-btn") as HTMLButtonElement;
    (document.getElementById("confirm-title") as HTMLElement).textContent = title;
    (document.getElementById("confirm-message") as HTMLElement).textContent = message;
    okBtn.textContent = okLabel;
    overlay.classList.add("open");

    function cleanup(result: boolean) {
      closeOpen = null;
      overlay.classList.remove("open");
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("keydown", onTrap);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    function onBackdrop(e: MouseEvent) {
      if (e.target === overlay) cleanup(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      }
    }
    const onTrap = (e: KeyboardEvent) => trapFocus(overlay, e);

    closeOpen = cleanup;
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("keydown", onTrap);
    cancelBtn.focus();
  });
}
