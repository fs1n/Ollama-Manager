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
