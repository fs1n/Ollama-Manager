import { api, setAuthRequired } from "../api";
import { toast } from "../ui/toast";
import { connect } from "./dashboard";

// Returns true once the caller is safe to hit authenticated endpoints (either
// auth isn't required, or a valid session is already present).
export async function checkSession(): Promise<boolean> {
  try {
    const r = await api("/api/session");
    const d = await r.json();
    setAuthRequired(d.authRequired);
    const logoutBtn = document.getElementById("logout-btn") as HTMLElement;
    logoutBtn.style.display = d.authRequired ? "inline-flex" : "none";
    if (d.authRequired && !d.authenticated) {
      document.getElementById("login-overlay")?.classList.add("open");
      return false;
    }
    if (!d.authRequired) {
      document.getElementById("login-overlay")?.classList.remove("open");
    }
    return true;
  } catch {
    toast("Session check failed", "error");
    return false;
  }
}

export async function doLogin(): Promise<void> {
  const keyInput = document.getElementById("login-key") as HTMLInputElement;
  const key = keyInput.value.trim();
  const err = document.getElementById("login-error") as HTMLElement;
  err.style.display = "none";
  if (!key) return;
  try {
    // On success the server sets the httpOnly session cookie — nothing to
    // store client-side.
    const r = await api("/api/auth", { method: "POST", body: JSON.stringify({ key }) });
    if (!r.ok) throw new Error("Invalid key");
    keyInput.value = "";
    document.getElementById("login-overlay")?.classList.remove("open");
    (document.getElementById("logout-btn") as HTMLElement).style.display = "inline-flex";
    connect();
  } catch {
    err.textContent = "Invalid master key";
    err.style.display = "block";
  }
}

export async function doLogout(): Promise<void> {
  await api("/api/logout", { method: "POST" });
  location.reload();
}

export function initAuth(): void {
  document.getElementById("login-btn")?.addEventListener("click", doLogin);
  document.getElementById("logout-btn")?.addEventListener("click", doLogout);
  document.getElementById("login-key")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  window.addEventListener("pageshow", (e: PageTransitionEvent) => {
    if (e.persisted) checkSession();
  });
}
