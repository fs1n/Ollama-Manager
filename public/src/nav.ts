type PageLoader = () => void | Promise<void>;

const loaders = new Map<string, PageLoader>();

// Called by app.ts once per page module, after import — keeps the dependency
// direction one-way (pages know about nav, nav doesn't need to know about
// pages) instead of nav.ts importing every page module itself.
export function registerPageLoader(page: string, loader: PageLoader): void {
  loaders.set(page, loader);
}

export function activatePage(name: string): void {
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.page === name);
  });
  document.querySelectorAll<HTMLElement>(".page").forEach((p) => {
    p.classList.toggle("active", p.id === `page-${name}`);
  });
}

export function navigateTo(page: string): void {
  activatePage(page);
  location.hash = page;
  loaders.get(page)?.();
}

function nav(el: HTMLElement): void {
  const page = el.dataset.page;
  if (page) navigateTo(page);
}

export function initNav(): void {
  const navEl = document.querySelector("nav");
  navEl?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-page]");
    if (item) nav(item);
  });
  navEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-page]");
      if (item) {
        e.preventDefault();
        nav(item);
      }
    }
  });

  window.addEventListener("hashchange", () => {
    const page = location.hash.slice(1) || "dashboard";
    const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (!navItem) return;
    if (navItem.classList.contains("active")) return;
    activatePage(page);
    loaders.get(page)?.();
  });
}

// Runs the initial page load on startup: whatever the URL hash names (if it's
// a real nav item), else the dashboard.
export function startInitialPage(): void {
  const startPage = document.querySelector(`.nav-item[data-page="${location.hash.slice(1)}"]`)
    ? location.hash.slice(1)
    : "dashboard";
  activatePage(startPage);
  loaders.get(startPage)?.();
}
