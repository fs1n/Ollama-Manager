// DOM-level tests with happy-dom. The globals are registered for this file
// only and removed afterwards, so server tests keep Bun's own fetch/Response.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register({ url: "http://manager.test/" }));
afterAll(() => GlobalRegistrator.unregister());

const NAV = `<nav>
  <div class="nav-item" data-page="dashboard"></div>
  <div class="nav-item" data-page="models"></div>
</nav>
<div class="page" id="page-dashboard"></div>
<div class="page" id="page-models"></div>`;

describe("hash router", () => {
  test("a backslash in the hash falls back to the dashboard instead of throwing", async () => {
    document.body.innerHTML = NAV;
    // A trailing backslash escapes the closing quote of a selector built as
    // [data-page="${hash}"], which makes querySelector throw in browsers.
    location.hash = "#a\\";
    const { registerPageLoader, startInitialPage } = await import("./nav");
    const loaded: string[] = [];
    registerPageLoader("dashboard", () => {
      loaded.push("dashboard");
    });
    expect(() => startInitialPage()).not.toThrow();
    expect(loaded).toEqual(["dashboard"]);
    expect(document.getElementById("page-dashboard")?.classList.contains("active")).toBe(true);
  });

  test("a valid hash opens its page", async () => {
    document.body.innerHTML = NAV;
    location.hash = "#models";
    const { startInitialPage } = await import("./nav");
    startInitialPage();
    expect(document.getElementById("page-models")?.classList.contains("active")).toBe(true);
  });
});

const CONFIRM = `<div id="confirm-overlay">
  <span id="confirm-title"></span><p id="confirm-message"></p>
  <button id="confirm-cancel-btn">Cancel</button><button id="confirm-ok-btn">OK</button>
</div>`;

describe("confirm dialog", () => {
  test("OK and Cancel resolve the promise", async () => {
    document.body.innerHTML = CONFIRM;
    const { showConfirm } = await import("./ui/confirm");
    const ok = showConfirm("Delete", "Sure?", "Delete");
    document.getElementById("confirm-ok-btn")?.click();
    expect(await ok).toBe(true);
    const cancel = showConfirm("Delete", "Sure?");
    document.getElementById("confirm-cancel-btn")?.click();
    expect(await cancel).toBe(false);
  });

  test("a second dialog settles the first instead of leaving it pending", async () => {
    document.body.innerHTML = CONFIRM;
    const { showConfirm } = await import("./ui/confirm");
    const first = showConfirm("One", "?");
    const second = showConfirm("Two", "?");
    expect(await first).toBe(false);
    document.getElementById("confirm-ok-btn")?.click();
    expect(await second).toBe(true);
    // Nothing left listening: another click must not resolve anything twice.
    document.getElementById("confirm-ok-btn")?.click();
    expect(document.getElementById("confirm-overlay")?.classList.contains("open")).toBe(false);
  });
});

describe("navigation by click, keyboard and hash", () => {
  test("clicks, Enter and hash changes activate the page and run its loader", async () => {
    document.body.innerHTML = NAV;
    location.hash = "";
    const { initNav, navigateTo, registerPageLoader } = await import("./nav");
    const loaded: string[] = [];
    registerPageLoader("models", () => {
      loaded.push("models");
    });
    registerPageLoader("dashboard", () => {
      loaded.push("dashboard");
    });
    initNav();
    const models = document.querySelector<HTMLElement>('[data-page="models"]');
    models?.click();
    expect(location.hash).toBe("#models");
    expect(models?.classList.contains("active")).toBe(true);

    document
      .querySelector<HTMLElement>('[data-page="dashboard"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.getElementById("page-dashboard")?.classList.contains("active")).toBe(true);

    navigateTo("models");
    location.hash = "#dashboard";
    window.dispatchEvent(new Event("hashchange"));
    // Unknown hashes are ignored rather than activating nothing.
    location.hash = "#nope";
    window.dispatchEvent(new Event("hashchange"));
    expect(document.getElementById("page-dashboard")?.classList.contains("active")).toBe(true);
    expect(loaded).toEqual(["models", "dashboard", "models", "dashboard"]);
  });
});

describe("focus trap", () => {
  test("Tab wraps from last to first and Shift+Tab from first to last", async () => {
    document.body.innerHTML =
      '<div id="d"><button id="a">a</button><button disabled>x</button><input id="b"><button id="c">c</button></div>';
    const { firstFocusable, trapFocus } = await import("./ui/focus");
    const d = document.getElementById("d") as HTMLElement;
    expect(firstFocusable(d)?.id).toBe("a");

    (document.getElementById("c") as HTMLElement).focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    trapFocus(d, tab);
    expect(document.activeElement?.id).toBe("a");
    expect(tab.defaultPrevented).toBe(true);

    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    trapFocus(d, back);
    expect(document.activeElement?.id).toBe("c");

    // Other keys and middle elements are left alone.
    (document.getElementById("b") as HTMLElement).focus();
    const mid = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    trapFocus(d, mid);
    trapFocus(d, new KeyboardEvent("keydown", { key: "a" }));
    expect(mid.defaultPrevented).toBe(false);
  });
});

describe("api()", () => {
  test("a 401 opens the login overlay when auth is required", async () => {
    document.body.innerHTML = '<div id="login-overlay"></div>';
    const realFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }) as typeof fetch;
    try {
      const { api, apiOk, setAuthRequired } = await import("./api");
      setAuthRequired(false);
      await api("/api/x");
      expect(document.getElementById("login-overlay")?.classList.contains("open")).toBe(false);
      setAuthRequired(true);
      await expect(apiOk("/api/x", { headers: { "X-Test": "1" } })).rejects.toThrow(
        "HTTP 401 — Unauthorized",
      );
      expect(document.getElementById("login-overlay")?.classList.contains("open")).toBe(true);
      expect(calls.at(-1)?.headers).toEqual({ "Content-Type": "application/json", "X-Test": "1" });
      setAuthRequired(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
