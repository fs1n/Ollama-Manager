import { escHtml } from "../utils/format";

const SAFE_LINK_SCHEME_RE = /^(https?:|mailto:|\/|#)/i;

// Chat/generate output is untrusted model text. Escape it to plain text
// *before* any markdown-to-HTML transform runs, so a response containing raw
// "<img onerror=…>" etc. can never reach innerHTML as live markup — only the
// trusted tags built below do. The one DOM-touching call site
// (`el.innerHTML = renderMarkdown(el.textContent)`) lives in the chat page;
// this function stays a pure string -> string transform so it's unit-testable
// without a DOM.
export function renderMarkdown(rawText: string): string {
  let text = escHtml(rawText);

  // Code blocks — protect from other transforms. `code` is already escaped
  // (part of `text` above), so it must NOT be passed through escHtml() again.
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_full, _lang, code) => {
    codeBlocks.push(
      `<pre style="background:var(--bg4);border:1px solid var(--border);border-radius:var(--radius);padding:10px;font-family:var(--mono);font-size:12px;color:var(--text);overflow-x:auto;margin:8px 0"><code style="background:transparent;padding:0;border-radius:0">${code.trim()}</code></pre>`,
    );
    return `\n\n<!--CB:${codeBlocks.length - 1}-->\n\n`;
  });

  // Inline code
  text = text.replace(
    /`([^`]+)`/g,
    '<code style="background:var(--bg4);padding:1px 4px;border-radius:3px;font-family:var(--mono);font-size:12px;color:var(--accent)">$1</code>',
  );

  // Headers
  text = text.replace(
    /^#{1,3} (.+)$/gm,
    '<strong style="display:block;font-size:15px;margin:8px 0 4px">$1</strong>',
  );

  // Links [text](url) — label/url are substrings of the already-escaped
  // `text`, safe to interpolate as-is; only the scheme needs validating.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label, url) => {
    if (!SAFE_LINK_SCHEME_RE.test(url.trim())) return full;
    return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--info);text-decoration:underline">${label}</a>`;
  });

  // Bullet lists
  text = text.replace(
    /^- (.+)$/gm,
    '<span style="display:block;padding-left:12px;position:relative"><span style="position:absolute;left:0;color:var(--accent)">•</span>$1</span>',
  );

  // Numbered lists
  text = text.replace(
    /^(\d+)\. (.+)$/gm,
    '<span style="display:block;padding-left:18px;position:relative"><span style="position:absolute;left:0;color:var(--accent);font-family:var(--mono);font-size:11px">$1.</span>$2</span>',
  );

  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Restore code blocks
  text = text.replace(/<!--CB:(\d+)-->/g, (_full, i) => codeBlocks[Number.parseInt(i, 10)]);

  // Line breaks — last so we don't break other replacements
  text = text.replace(/\n/g, "<br>");

  return text;
}
