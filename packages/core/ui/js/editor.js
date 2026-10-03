// Managed Markdown editor. Every mutation is a service:self request, never a file PUT.
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
const paths = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]);
const sha = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const safeVersion = (value) => value === undefined || Number.isSafeInteger(value) && value >= 1;
const safeTs = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const userHeader = /^---\nversion: ([1-9][0-9]*)\nupdated: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\n---\n/;
const userBody = (content) => content.replace(userHeader, "");
const STALE = "这段内容刚在别处改过，未覆盖。你的修改还在；请重新读取后再改。";
const errorText = (body) => body?.error?.code === "bad_request" && body.error.message === "stale" ? STALE
  : body?.error?.message === "gate unavailable" ? "现在没法确认这次恢复，什么都没改；请稍后再试。"
  : body?.error?.code === "forbidden" || body?.error?.code === "denied" ? "这次没有得到允许，什么都没改。"
  : "没有完成，什么都没改；可以再试一次。";
/** Her name inside a Chinese sentence: Latin names get spaces around them, Chinese names do not. */
export const named = (name, before = true, after = true) =>
  /[A-Za-z0-9]/.test(name) ? `${before ? " " : ""}${name}${after ? " " : ""}` : name;
/** What each managed file is, in the owner's words. */
export const FILE_LABELS = Object.freeze({ "SOUL.md": "性格", "IDENTITY.md": "名片", "USER.md": "关于你", "MEMORY.md": "她记下的事" });
const two = (value) => String(value).padStart(2, "0");
/** "今天 14:20", "昨天 09:05", "10月3日 14:20". */
export function when(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return "时间不详";
  const at = new Date(ts);
  const time = `${at.getHours()}:${two(at.getMinutes())}`;
  const day = (value) => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const diff = Math.round((day(ts) - day(now)) / 86_400_000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  const year = at.getFullYear() === new Date(now).getFullYear() ? "" : `${at.getFullYear()}年`;
  return `${year}${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

/** Bind managed requests to the existing live ScreenNet registration. */
export function createSelfScreenSender(net) {
  if (!net || typeof net.request !== "function") throw new TypeError("screen network required");
  return async (request) => {
    if (request?.to !== "service:self" || request.kind !== "request" || request.wait !== true ||
      !["read", "write", "history", "rollback"].includes(request.word)) throw new TypeError("unsupported managed request");
    const token = net.token;
    const scope = net.currentScope;
    const screen = net.screen;
    const generation = net.generation;
    if (!token || !scope || !screen) throw new Error("还没连上，暂时不能读取。");
    if (["write", "rollback"].includes(request.word) && net.localManagement !== true)
      throw new Error("只有在她所在的手机上才能修改。");
    const response = await net.request("/api/send", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token }, body: JSON.stringify(request) });
    const current = () => token === net.token && scope === net.currentScope && screen === net.screen && generation === net.generation &&
      (!["write", "rollback"].includes(request.word) || net.localManagement === true);
    if (!current()) throw new Error("连接已经换过，这次的结果没有采用。");
    if (!response.ok) throw new Error(response.status === 403 ? "这台设备不能修改这些内容。" : "没能连上，请再试一次。");
    const accepted = await response.json();
    if (!current()) throw new Error("连接已经换过，这次的结果没有采用。");
    if (typeof accepted?.id !== "string" || accepted.reply?.kind !== "response" || accepted.reply.reply_to !== accepted.id ||
      accepted.reply.from !== "service:self" || accepted.reply.to !== "person:owner" || accepted.reply.word !== request.word)
      throw new Error("没有收到确认，可以再试一次。");
    return accepted;
  };
}

function node(parent, tag, value, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(value ?? "");
  parent.append(element);
  return element;
}

function resultBody(response) {
  const body = response?.reply?.body;
  if (!body || typeof body.ok !== "boolean") throw new Error("没有收到确认，可以再试一次。");
  return body;
}

/** Plain reading view of a Markdown file: headings, bullets and paragraphs; never parsed as HTML. */
export function renderReadable(parent, text) {
  let list = null;
  let paragraph = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const plain = (value) => value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
    if (!line) { list = null; paragraph = null; continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) { list = null; paragraph = null; node(parent, "h4", plain(heading[1])); }
    else if (bullet) {
      paragraph = null;
      list ??= node(parent, "ul", "");
      node(list, "li", plain(bullet[1]));
    } else if (paragraph) {
      const before = paragraph.textContent;
      paragraph.textContent = `${before}${/[A-Za-z0-9,.;:!?)]$/.test(before) && /^[A-Za-z0-9(]/.test(line) ? " " : ""}${plain(line)}`;
    }
    else { list = null; paragraph = node(parent, "p", plain(line)); }
  }
}

const updatedAt = (content) => {
  const match = /^---\nversion: [1-9][0-9]*\nupdated: ([0-9T:.\-]+Z)\n---\n/.exec(content);
  const ts = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(ts) ? ts : null;
};

/** A caller must provide a registered-screen send function; the server remains the authority. */
export class ManagedMarkdownEditor {
  constructor(root, { path, send, canEdit = true, confirmRollback = () => false, idFactory = () => crypto.randomUUID() } = {}) {
    if (!paths.has(path) || typeof send !== "function") throw new TypeError("unsupported managed editor path or transport");
    this.root = root;
    this.path = path;
    this.label = FILE_LABELS[path];
    this.send = send;
    this.canEdit = canEdit;
    this.idFactory = idFactory;
    this.confirmRollback = confirmRollback;
    this.loaded = false;
    this.missing = false;
    this.content = "";
    this.draft = "";
    this.hash = null;
    this.version = null;
    this.conflict = false;
    this.unverified = false;
    this.pending = null;
    this.pendingRollback = null;
    this.editing = false;
    this.status = "正在读取…";
    this.snapshots = null;
    this.disposed = false;
    this.render();
  }

  dispose() {
    this.disposed = true;
    this.loaded = false;
    this.content = "";
    this.draft = "";
    this.pending = null;
    this.pendingRollback = null;
    this.snapshots = null;
    this.editing = false;
    this.root.replaceChildren();
  }

  async request(word, body, client_id) {
    if (this.disposed) throw new Error("已经关闭。");
    const result = await this.send({ to: "service:self", kind: "request", word, body, wait: true, ...(client_id ? { client_id } : {}) });
    if (this.disposed) throw new Error("已经关闭。");
    return result;
  }

  /** Reload discards a local draft only when explicitly requested by the caller. */
  async load({ discardDraft = false } = {}) {
    if (this.pending || this.pendingRollback) throw new Error("上次的改动还没确认；请先再点一次同一个按钮。" );
    if (this.loaded && this.draft !== this.content && !discardDraft) throw new Error("还有没保存的修改；先保存或取消。" );
    const body = resultBody(await this.request("read", { path: this.path }));
    if (!body.ok && body.error?.code !== "not_found") throw new Error(errorText(body));
    const found = body.ok;
    const content = found ? body.result?.content : "";
    const hash = found ? body.result?.hash : null;
    const version = found ? body.result?.version : undefined;
    if (typeof content !== "string" || found && !sha(hash) || !safeVersion(version)) throw new Error("读到的内容不完整，请再试一次。" );
    this.content = content;
    this.draft = content;
    this.hash = hash;
    this.version = version ?? null;
    this.loaded = true;
    this.missing = !found;
    this.conflict = false;
    this.unverified = false;
    this.pending = null;
    this.pendingRollback = null;
    this.status = "";
    this.render();
    return { content, hash, version: this.version };
  }

  setDraft(content) {
    if (!this.loaded || !this.canEdit || typeof content !== "string") throw new Error("还不能修改。" );
    this.draft = content;
    this.render();
  }

  /** Editing always starts from what is on disk now, so a quiet background change is not overwritten later. */
  async edit() {
    if (!this.loaded || !this.canEdit || this.editing) return;
    if (!this.pending && !this.pendingRollback && !this.conflict && !this.unverified && this.draft === this.content) {
      try { await this.load(); }
      catch (error) { this.status = error instanceof Error ? error.message : "没能读取，请再试一次。"; this.render(); return; }
    }
    this.editing = true;
    this.render();
  }

  cancelEdit() {
    if (this.pending || this.pendingRollback) return;
    this.draft = this.content;
    this.editing = false;
    this.status = "";
    this.render();
  }

  async save() {
    if (!this.loaded || !this.canEdit) throw new Error("现在不能修改。" );
    if (this.pendingRollback) throw new Error("上次的恢复还没确认；请先再点一次同一个按钮。" );
    if (this.conflict || this.unverified) throw new Error("请先重新读取，再保存，以免覆盖别处的修改。" );
    if (this.draft === this.content && !this.pending) {
      this.editing = false;
      this.render();
      return { unchanged: true };
    }
    if (this.pending && this.draft !== this.pending.content) throw new Error("上次保存还没确认；只能原样再试一次。" );
    this.pending ??= { content: this.draft, expected_hash: this.hash, client_id: this.idFactory() };
    const pending = this.pending;
    this.status = "正在保存…";
    this.render();
    let body;
    try {
      body = resultBody(await this.request("write", { path: this.path, content: pending.content,
        why: "Owner edited managed Markdown", expected_hash: pending.expected_hash }, pending.client_id));
    } catch (error) {
      this.status = "还不确定有没有保存上。再点一次「保存」会原样重试。";
      this.render();
      throw error;
    }
    if (!body.ok) {
      this.pending = null;
      this.conflict = body.error?.code === "bad_request" && body.error?.message === "stale";
      this.status = errorText(body);
      this.render();
      throw new Error(this.status);
    }
    if (!sha(body.result?.hash) || !safeVersion(body.result?.version) || this.path === "USER.md" && !Number.isSafeInteger(body.result?.version)) {
      this.status = "还不确定有没有保存上。再点一次「保存」会原样重试。";
      this.render();
      throw new Error(this.status);
    }
    this.pending = null;
    this.hash = body.result.hash;
    this.content = pending.content;
    this.version = body.result.version ?? null;
    this.unverified = true;
    this.status = "正在保存…";
    this.render();
    try {
      const current = resultBody(await this.request("read", { path: this.path }));
      if (!current.ok || !sha(current.result?.hash) || typeof current.result?.content !== "string") throw new Error("保存后没能重新读取。" );
      const canonical = current.result.content;
      const userMatches = this.path === "USER.md" && userHeader.test(canonical) &&
        Number(userHeader.exec(canonical)[1]) === body.result.version && current.result.version === body.result.version &&
        userBody(canonical) === userBody(pending.content);
      if (current.result.hash !== body.result.hash || !(this.path === "USER.md" ? userMatches : canonical === pending.content)) {
        this.conflict = true;
        this.status = "保存后这段内容又在别处被改过。你的修改还在；请重新读取后再看。";
      } else {
        this.content = canonical;
        this.draft = canonical;
        this.version = current.result.version ?? null;
        this.missing = false;
        this.editing = false;
        this.status = "已保存。";
      }
      this.unverified = false;
    } catch {
      this.unverified = true;
      this.status = "已保存，但没能重新读取；请点「重新读取」看看现在的内容。";
    }
    this.render();
    return { hash: body.result.hash, version: this.version, conflict: this.conflict };
  }

  async rollback(to_ts) {
    if (!this.loaded || !this.canEdit || !sha(this.hash) || this.conflict || this.unverified || this.pending) throw new Error("请先重新读取，再恢复。" );
    if (this.draft !== this.content) throw new Error("先保存或取消正在改的内容，再恢复。" );
    if (!this.snapshots?.some((item) => item.ts === to_ts)) throw new Error("找不到这条记录，请重新打开改动记录。" );
    if (this.pendingRollback && this.pendingRollback.to_ts !== to_ts) throw new Error("上次的恢复还没确认；只能原样再试一次。" );
    if (!this.pendingRollback) {
      if (!await this.confirmRollback({ path: this.path, label: this.label, to_ts, expected_hash: this.hash })) return { cancelled: true };
      if (this.disposed) throw new Error("已经关闭。");
      this.pendingRollback = { to_ts, expected_hash: this.hash, client_id: this.idFactory() };
    }
    const pending = this.pendingRollback;
    this.status = "正在恢复…";
    this.render();
    let body;
    try {
      body = resultBody(await this.request("rollback", { path: this.path, to_ts: pending.to_ts,
        expected_hash: pending.expected_hash }, pending.client_id));
    } catch (error) {
      this.status = "还不确定有没有恢复。再点一次同一条「恢复」会原样重试。";
      this.render();
      throw error;
    }
    if (!body.ok) {
      this.pendingRollback = null;
      this.conflict = body.error?.code === "bad_request" && body.error?.message === "stale";
      this.status = errorText(body);
      this.render();
      throw new Error(this.status);
    }
    this.pendingRollback = null;
    this.loaded = false;
    this.status = "已恢复，正在读取…";
    this.render();
    try {
      const result = await this.load({ discardDraft: true });
      this.status = `已恢复成 ${when(to_ts)} 改动之前的样子。`;
      this.render();
      return result;
    } catch (error) {
      this.unverified = true;
      this.status = "已恢复，但没能重新读取；请点「重新读取」看看现在的内容。";
      this.render();
      throw error;
    }
  }

  async history() {
    const body = resultBody(await this.request("history", { path: this.path }));
    if (!body.ok) throw new Error(errorText(body));
    const versions = body.result?.versions;
    if (!Array.isArray(versions) || !versions.every((item) => item && safeTs(item.ts) && sha(item.hash)) ||
      new Set(versions.map((item) => item.ts)).size !== versions.length) throw new Error("改动记录读不全，请再试一次。" );
    this.snapshots = versions.map((item) => ({ ts: item.ts, hash: item.hash }));
    this.render();
    return this.snapshots;
  }

  render() {
    if (this.disposed) { this.root.replaceChildren(); return; }
    const fragment = document.createDocumentFragment();
    const card = node(fragment, "div", "", "set-card doc-card");
    card.dataset.file = this.path;
    const reading = node(card, "div", "", "doc-body");
    reading.hidden = this.editing;
    if (!this.loaded) node(reading, "p", "", "doc-empty");
    else if (!userBody(this.content).trim()) node(reading, "p", this.canEdit ? "还没有写下什么。点「编辑」写几句。" : "还没有写下什么。", "doc-empty");
    else renderReadable(reading, this.path === "USER.md" ? userBody(this.content) : this.content);
    const header = this.path === "USER.md" ? userHeader.exec(this.draft)?.[0] ?? "" : "";
    const source = node(card, "textarea", "", "markdown-source");
    source.value = header ? this.draft.slice(header.length) : this.draft;
    source.hidden = !this.editing;
    source.disabled = !this.loaded || !this.canEdit || !!this.pending || this.unverified;
    source.addEventListener("input", () => { this.draft = `${header}${source.value}`; });
    const updated = this.path === "USER.md" && this.loaded ? updatedAt(this.content) : null;
    node(card, "p", this.path === "USER.md" && this.loaded && this.version !== null
      ? `${updated ? `更新于 ${when(updated)} · ` : ""}第 ${this.version} 版` : "", "editor-version");
    const warning = this.conflict || this.unverified || !!this.pending || !!this.pendingRollback;
    node(card, "p", this.status, warning ? "editor-warning" : "editor-status");
    const actions = node(card, "div", "", "set-actions");
    const action = (label, className, run) => {
      const button = node(actions, "button", label, className);
      button.type = "button";
      button.addEventListener("click", async () => {
        try { await run(); }
        catch (error) { if (!this.disposed) { this.status = error instanceof Error ? error.message : "没有完成，可以再试一次。"; this.render(); } }
      });
      return button;
    };
    const edit = action("编辑", "btn editor-edit", () => this.edit());
    edit.hidden = this.editing || !this.canEdit || !this.loaded;
    edit.disabled = !!this.pending || !!this.pendingRollback;
    const save = node(actions, "button", this.pending ? "再试一次保存" : "保存", "btn editor-save");
    save.type = "button";
    save.hidden = !this.editing;
    save.disabled = !this.loaded || !this.canEdit || this.conflict || this.unverified || !!this.pendingRollback;
    save.addEventListener("click", async () => { try { await this.save(); } catch { /* status is visible; draft remains */ } });
    const cancel = action("取消", "btn gray editor-cancel", () => this.cancelEdit());
    cancel.hidden = !this.editing || !!this.pending || this.conflict || this.unverified;
    const refresh = action(this.editing ? "重新读取（放弃修改）" : "重新读取", "btn gray editor-refresh", async () => {
      await this.load({ discardDraft: true });
    });
    refresh.hidden = !(this.conflict || this.unverified);
    const history = action("改动记录", "sheet-link editor-history", () => this.history());
    history.hidden = this.editing || !this.loaded || this.missing;
    if (!this.canEdit && this.loaded) node(card, "p", "只能在她所在的那台手机上修改。", "set-sub");
    if (this.snapshots && !this.editing) {
      node(fragment, "h3", "改动记录", "set-header");
      if (!this.snapshots.length) node(fragment, "p", "还没有改动记录。", "sheet-empty");
      else {
        const list = node(fragment, "div", "", "set-group editor-snapshots");
        for (const item of [...this.snapshots].sort((a, b) => b.ts - a.ts)) {
          const row = node(list, "div", "", "set-item");
          const text = node(row, "span", "", "set-text");
          node(text, "span", when(item.ts), "set-title");
          node(text, "span", "这次改动之前的内容", "set-sub");
          const rollback = node(row, "button", this.pendingRollback?.to_ts === item.ts ? "再试一次恢复" : "恢复", "sheet-link editor-rollback");
          rollback.type = "button";
          rollback.hidden = !this.canEdit;
          rollback.disabled = !this.canEdit || !this.loaded || this.conflict || this.unverified || !!this.pending || this.draft !== this.content || !!this.pendingRollback && this.pendingRollback.to_ts !== item.ts;
          rollback.addEventListener("click", async () => { try { await this.rollback(item.ts); } catch (error) { if (!this.disposed) { this.status = error instanceof Error ? error.message : "没能恢复，可以再试一次。"; this.render(); } } });
        }
      }
    }
    this.root.replaceChildren(fragment);
  }
}

/** One page of managed files (identity or memory): a short note, a file switcher and the active file. */
export class ManagedFilesSheet {
  constructor(root, options, { files, intro = "", extra = null } = {}) {
    this.root = root;
    this.options = options;
    this.files = files;
    this.intro = intro;
    this.extra = extra;
    this.active = null;
    this.editor = null;
    this.epoch = 0;
  }

  dispose() {
    this.epoch++;
    this.editor?.dispose();
    this.editor = null;
    this.active = null;
    this.root.replaceChildren();
  }

  busy() {
    return Boolean(this.editor && (this.editor.pending || this.editor.pendingRollback || this.editor.editing ||
      this.editor.loaded && this.editor.draft !== this.editor.content));
  }

  async open(path = this.files[0]) {
    if (!this.files.includes(path)) throw new TypeError("unknown managed file");
    if (this.editor?.pending || this.editor?.pendingRollback ||
      this.editor?.loaded && this.editor.draft !== this.editor.content) throw new Error("先保存或取消正在改的内容，再切换。");
    const epoch = ++this.epoch;
    const panel = document.createElement("section");
    const editor = new ManagedMarkdownEditor(panel, { ...this.options, path });
    await editor.load();
    if (epoch !== this.epoch) { editor.dispose(); throw new Error("页面已经换过，这次读取没有采用。"); }
    const tabs = document.createElement("nav");
    tabs.className = "sheet-switch";
    for (const name of this.files) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = FILE_LABELS[name];
      button.dataset.file = name;
      button.disabled = name === path;
      if (name === path) button.className = "on";
      button.addEventListener("click", async () => {
        try { await this.open(name); }
        catch (error) { editor.status = error instanceof Error ? error.message : "没能切换。"; editor.render(); }
      });
      tabs.append(button);
    }
    this.editor?.dispose();
    const parts = [];
    if (this.intro) {
      const note = document.createElement("p");
      note.className = "set-intro";
      note.textContent = this.intro;
      parts.push(note);
    }
    parts.push(tabs, panel);
    const extra = this.extra?.();
    if (extra) parts.push(extra);
    this.root.replaceChildren(...parts);
    this.active = path;
    this.editor = editor;
    return editor;
  }

  /** Coming back to the page shows what is on disk now, unless the owner is in the middle of something. */
  async refresh() {
    if (!this.editor || this.busy()) return;
    try { await this.editor.load(); } catch { /* the visible card keeps its last confirmed content */ }
  }
}
