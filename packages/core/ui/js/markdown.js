import { marked } from "marked";
import { decodeHTML } from "entities";

// Parse Markdown, never HTML: only these code-owned DOM elements are created.
// Raw HTML remains visible text; images are opt-in links, not network requests.
export function markdownUrl(value) {
  const href = decodeHTML(String(value ?? "")).trim();
  if (!/^(https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return null;
  try { const url = new URL(href); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function element(parent, tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent.append(node);
  return node;
}
function literal(parent, value) { parent.append(document.createTextNode(String(value ?? ""))); }

async function copyCode(value) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  } catch { /* Android WebView can deny the browser Clipboard API; use its user-gesture fallback. */ }
  const focused = document.activeElement;
  const selection = document.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.className = "md-copy-buffer";
  field.value = value;
  field.readOnly = true;
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand?.("copy")) throw new Error("copy unavailable");
  } finally {
    field.remove();
    focused?.focus?.({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

function renderTokens(parent, tokens, depth = 0, options = {}) {
  if (depth > 64) { for (const token of tokens) literal(parent, token.raw ?? token.text); return; }
  const children = (node, token) => token.tokens ? renderTokens(node, token.tokens, depth + 1, options) : literal(node, decodeHTML(token.text ?? ""));
  for (const token of tokens) {
    switch (token.type) {
      case "space": case "def": break;
      case "text": case "escape": children(parent, token); break;
      case "html": literal(parent, token.raw ?? token.text); break;
      case "paragraph": children(element(parent, "p"), token); break;
      case "heading": children(element(parent, `h${Math.max(1, Math.min(6, token.depth))}`), token); break;
      case "strong": case "em": case "del": children(element(parent, token.type), token); break;
      case "codespan": literal(element(parent, "code"), token.text); break;
      case "br": element(parent, "br"); break;
      case "hr": element(parent, "hr"); break;
      case "blockquote": children(element(parent, "blockquote"), token); break;
      case "list": {
        const list = element(parent, token.ordered ? "ol" : "ul");
        if (token.ordered && Number.isSafeInteger(token.start)) list.start = token.start;
        for (const item of token.items) children(element(list, "li", item.task ? "md-task" : undefined), item);
        break;
      }
      case "checkbox": {
        const check = element(parent, "input"); check.type = "checkbox"; check.disabled = true; check.checked = token.checked;
        check.setAttribute("aria-label", token.checked ? "已完成" : "未完成");
        literal(parent, " "); break;
      }
      case "link": case "image": {
        const href = markdownUrl(token.href);
        const fileLink = !href && options.onFileLink && typeof token.href === "string" && token.href && !/^[a-z][a-z0-9+.-]*:|^\/\/|^#|[\\\x00-\x1f\x7f]/i.test(decodeHTML(token.href));
        const node = href || fileLink ? element(parent, "a", token.type === "image" ? "md-image-link" : undefined) : parent;
        if (href) { node.href = href; node.target = "_blank"; node.rel = "noopener noreferrer"; node.referrerPolicy = "no-referrer"; }
        if (fileLink) { node.href = "#"; node.className = "md-file-link"; node.addEventListener("click", (event) => { event.preventDefault(); options.onFileLink(decodeHTML(token.href)); }); }
        if (token.type === "image") literal(node, `图片：${decodeHTML(token.text || "查看图片")}`);
        else children(node, token);
        break;
      }
      case "code": {
        const block = element(parent, "div", "md-code-block");
        const bar = element(block, "div", "md-code-bar");
        literal(element(bar, "span"), String(token.lang || "代码").split(/\s/)[0]);
        const button = element(bar, "button", "md-copy"); button.type = "button"; button.textContent = "复制代码";
        button.setAttribute("aria-label", "复制代码");
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await copyCode(token.text); button.textContent = "已复制"; }
          catch { button.textContent = "复制失败，请长按选择"; }
          finally { button.disabled = false; }
        });
        const pre = element(block, "pre"); literal(element(pre, "code"), token.text);
        break;
      }
      case "table": {
        const wrap = element(parent, "div", "md-table-wrap");
        wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "表格，可横向滚动");
        const table = element(wrap, "table");
        const row = (section, cells, tag) => {
          const tr = element(section, "tr");
          for (let i = 0; i < cells.length; i++) {
            const cell = element(tr, tag);
            if (tag === "th") cell.scope = "col";
            if (["left", "center", "right"].includes(token.align[i])) cell.style.textAlign = token.align[i];
            children(cell, cells[i]);
          }
        };
        row(element(table, "thead"), token.header, "th");
        const body = element(table, "tbody"); for (const cells of token.rows) row(body, cells, "td");
        break;
      }
      default: literal(parent, token.raw ?? token.text);
    }
  }
}

export function appendMarkdown(parent, source, options = {}) {
  const raw = String(source ?? "");
  const content = element(parent, "div", "markdown");
  try {
    // Bound parser work on unexpectedly large messages; preserve the whole source in the fallback.
    if (raw.length > 200_000) throw new Error("large message");
    renderTokens(content, marked.lexer(raw, { gfm: true, breaks: true }), 0, options);
  } catch { content.className = "markdown md-plain"; content.textContent = raw; }
  return content;
}
