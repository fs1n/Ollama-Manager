// Pure formatting/escaping helpers shared across pages. No DOM access here —
// keeps these testable with plain bun:test, no browser environment needed.

export function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export function parsePulls(p: string | null | undefined): number {
  if (!p) return 0;
  const m = String(p)
    .trim()
    .match(/^([\d.]+)([KMB])?$/i);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  const mult =
    ({ K: 1e3, M: 1e6, B: 1e9 } as Record<string, number>)[(m[2] || "").toUpperCase()] || 1;
  return Math.round(n * mult);
}

// Normalizes an ollama.com size badge ("7b", "335m", "8x22b", …) into a
// billions-of-parameters number comparable against filter thresholds.
// Plain parseFloat() alone is wrong here: it ignores the b/m unit (so "335m"
// — 335 million params — would compare as 335, larger than every threshold)
// and only reads the leading number of MoE labels like "8x22b" (comparing as
// 8, which misclassifies a ~141B-class model as "small").
export function parseModelSize(s: string | null | undefined): number {
  if (!s) return Number.POSITIVE_INFINITY;
  const str = String(s).trim().toLowerCase();
  const moe = str.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*([bm])$/);
  if (moe) {
    const n = Number.parseFloat(moe[1]) * Number.parseFloat(moe[2]);
    return moe[3] === "m" ? n / 1000 : n;
  }
  const plain = str.match(/^(\d+(?:\.\d+)?)\s*([bm])$/);
  if (plain) {
    const n = Number.parseFloat(plain[1]);
    return plain[2] === "m" ? n / 1000 : n;
  }
  const n = Number.parseFloat(str);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "&quot;");
}
