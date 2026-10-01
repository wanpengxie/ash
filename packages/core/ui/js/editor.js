// Managed Markdown editor. Every mutation is a service:self request, never a file PUT.
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
const paths = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]);
const sha = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const safeVersion = (value) => value === undefined || Number.isSafeInteger(value) && value >= 1;
const safeTs = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const errorText = (body) => body?.error?.code === "bad_request" && body.error.message === "stale"
  ? "文件已被其他操作修改。你的草稿仍在；请先查看新版本，再决定如何改。"
  : typeof body?.error?.message === "string" ? body.error.message : "操作未完成。";

/** Bind managed requests to the existing live ScreenNet registration. */
export function createSelfScreenSender(net) {
  if (!net || typeof net.request !== "function") throw new TypeError("screen network required");
  return async (request) => {
    if (request?.to !== "service:self" || request.kind !== "request" || request.wait !== true ||
      !["read", "write", "history", "rollback"].includes(request.word)) throw new TypeError("unsupported managed request");
    const token = net.token;
    const scope = net.currentScope;
    const screen = net.screen;
    if (!token || !scope || !screen) throw new Error("屏幕尚未注册，不能读取或修改用户文件。");
    const response = await net.request("/api/send", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token }, body: JSON.stringify(request) });
    if (token !== net.token || scope !== net.currentScope || screen !== net.screen) throw new Error("屏幕身份已变化，请核对操作状态。");
    if (!response.ok) throw new Error(`用户文件服务拒绝请求：HTTP ${response.status}`);
    return response.json();
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
  if (!body || typeof body.ok !== "boolean") throw new Error("服务未确认此操作，可使用同一请求重试。");
  return body;
}

/** A caller must provide a registered-screen send function; the server remains the authority. */
export class ManagedMarkdownEditor {
  constructor(root, { path, send, canEdit = true, confirmRollback = () => false, idFactory = () => crypto.randomUUID() } = {}) {
    if (!paths.has(path) || typeof send !== "function") throw new TypeError("unsupported managed editor path or transport");
    this.root = root;
    this.path = path;
    this.send = send;
    this.canEdit = canEdit;
    this.idFactory = idFactory;
    this.confirmRollback = confirmRollback;
    this.loaded = false;
    this.content = "";
    this.draft = "";
    this.hash = null;
    this.version = null;
    this.conflict = false;
    this.unverified = false;
    this.pending = null;
    this.pendingRollback = null;
    this.status = "尚未读取。";
    this.snapshots = null;
    this.render();
  }

  async request(word, body, client_id) {
    return this.send({ to: "service:self", kind: "request", word, body, wait: true, ...(client_id ? { client_id } : {}) });
  }

  /** Reload discards a local draft only when explicitly requested by the caller. */
  async load({ discardDraft = false } = {}) {
    if (this.pending || this.pendingRollback) throw new Error("上次修改结果尚未确认；只能原样重试，不能先刷新。" );
    if (this.loaded && this.draft !== this.content && !discardDraft) throw new Error("尚有未保存的草稿；请明确放弃后再刷新。" );
    const body = resultBody(await this.request("read", { path: this.path }));
    if (!body.ok && body.error?.code !== "not_found") throw new Error(errorText(body));
    const found = body.ok;
    const content = found ? body.result?.content : "";
    const hash = found ? body.result?.hash : null;
    const version = found ? body.result?.version : undefined;
    if (typeof content !== "string" || found && !sha(hash) || !safeVersion(version)) throw new Error("文件读取结果不完整。" );
    this.content = content;
    this.draft = content;
    this.hash = hash;
    this.version = version ?? null;
    this.loaded = true;
    this.conflict = false;
    this.unverified = false;
    this.pending = null;
    this.pendingRollback = null;
    this.status = found ? "已读取当前版本。" : "文件尚不存在；保存时将请求新建。";
    this.render();
    return { content, hash, version: this.version };
  }

  setDraft(content) {
    if (!this.loaded || !this.canEdit || typeof content !== "string") throw new Error("编辑器未就绪。" );
    this.draft = content;
    this.render();
  }

  async save() {
    if (!this.loaded || !this.canEdit) throw new Error("此文件当前不可编辑。" );
    if (this.pendingRollback) throw new Error("回滚结果尚未确认；只能原样重试。" );
    if (this.conflict || this.unverified) throw new Error("请先检查当前文件版本，不能直接覆盖。" );
    if (this.draft === this.content && !this.pending) return { unchanged: true };
    if (this.pending && this.draft !== this.pending.content) throw new Error("上次保存结果尚未确认；只能用原草稿重试。" );
    this.pending ??= { content: this.draft, expected_hash: this.hash, client_id: this.idFactory() };
    const pending = this.pending;
    let body;
    try {
      body = resultBody(await this.request("write", { path: this.path, content: pending.content,
        why: "Owner edited managed Markdown", expected_hash: pending.expected_hash }, pending.client_id));
    } catch (error) {
      this.status = "保存是否生效尚未确认；只能原样重试。";
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
    if (!sha(body.result?.hash) || !safeVersion(body.result?.version)) {
      this.status = "保存回执不完整；只能原样重试。";
      this.render();
      throw new Error(this.status);
    }
    this.pending = null;
    this.hash = body.result.hash;
    this.content = pending.content;
    this.version = body.result.version ?? null;
    this.status = "保存已确认；正在核对当前版本。";
    this.render();
    try {
      const current = resultBody(await this.request("read", { path: this.path }));
      if (!current.ok || !sha(current.result?.hash) || typeof current.result?.content !== "string") throw new Error("保存后无法复核文件。" );
      if (current.result.hash !== body.result.hash || current.result.content !== pending.content) {
        this.conflict = true;
        this.status = "保存后文件又发生变化；草稿已保留，请刷新查看。";
      } else this.status = "已保存并核对当前版本。";
    } catch {
      this.unverified = true;
      this.status = "保存已确认，但重新读取失败；请刷新核对。";
    }
    this.render();
    return { hash: body.result.hash, version: this.version, conflict: this.conflict };
  }

  async rollback(to_ts) {
    if (!this.loaded || !this.canEdit || !sha(this.hash) || this.conflict || this.unverified || this.pending) throw new Error("请先核对当前文件，不能回滚。" );
    if (this.draft !== this.content) throw new Error("先保存或放弃草稿，再回滚。" );
    if (!this.snapshots?.some((item) => item.ts === to_ts)) throw new Error("快照不在当前已核对的历史中。" );
    if (this.pendingRollback && this.pendingRollback.to_ts !== to_ts) throw new Error("上次回滚结果尚未确认；只能原样重试。" );
    if (!this.pendingRollback) {
      if (!await this.confirmRollback({ path: this.path, to_ts, expected_hash: this.hash })) return { cancelled: true };
      this.pendingRollback = { to_ts, expected_hash: this.hash, client_id: this.idFactory() };
    }
    const pending = this.pendingRollback;
    let body;
    try {
      body = resultBody(await this.request("rollback", { path: this.path, to_ts: pending.to_ts,
        expected_hash: pending.expected_hash }, pending.client_id));
    } catch (error) {
      this.status = "回滚是否生效尚未确认；只能原样重试。";
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
    this.status = "回滚已确认；请重新读取当前文件。";
    this.render();
    try { return await this.load({ discardDraft: true }); }
    catch (error) {
      this.unverified = true;
      this.status = "回滚已确认，但重新读取失败；请刷新核对。";
      this.render();
      throw error;
    }
  }

  async history() {
    const body = resultBody(await this.request("history", { path: this.path }));
    if (!body.ok) throw new Error(errorText(body));
    const versions = body.result?.versions;
    if (!Array.isArray(versions) || !versions.every((item) => item && safeTs(item.ts) && sha(item.hash)) ||
      new Set(versions.map((item) => item.ts)).size !== versions.length) throw new Error("历史快照结果不完整。" );
    this.snapshots = versions.map((item) => ({ ts: item.ts, hash: item.hash }));
    this.render();
    return this.snapshots;
  }

  render() {
    const fragment = document.createDocumentFragment();
    node(fragment, "h3", this.path);
    node(fragment, "p", this.path === "USER.md" && this.loaded ? this.version === null ? "旧版（无版本头）" : `版本 ${this.version}` : this.loaded ? "已读取" : "未读取", "editor-version");
    node(fragment, "p", this.status, this.conflict || this.unverified || this.pending || this.pendingRollback ? "editor-warning" : "editor-status");
    const source = node(fragment, "textarea", "", "markdown-source");
    source.value = this.draft;
    source.disabled = !this.loaded || !this.canEdit;
    source.addEventListener("input", () => { this.draft = source.value; });
    const save = node(fragment, "button", this.pending ? "重试同一保存" : "保存", "editor-save");
    save.type = "button";
    save.disabled = !this.loaded || !this.canEdit || this.conflict || this.unverified || !!this.pendingRollback;
    save.addEventListener("click", async () => { try { await this.save(); } catch { /* status is visible; draft remains */ } });
    const refresh = node(fragment, "button", "重新读取（放弃草稿）", "editor-refresh");
    refresh.type = "button";
    refresh.addEventListener("click", async () => { try { await this.load({ discardDraft: true }); } catch (error) { this.status = error instanceof Error ? error.message : "读取失败"; this.render(); } });
    const history = node(fragment, "button", "查看快照", "editor-history");
    history.type = "button";
    history.addEventListener("click", async () => { try { await this.history(); } catch (error) { this.status = error instanceof Error ? error.message : "快照不可用"; this.render(); } });
    if (this.snapshots) {
      const list = node(fragment, "ul", "", "editor-snapshots");
      for (const item of this.snapshots) {
        const row = node(list, "li", `${new Date(item.ts).toLocaleString()} · ${item.hash.slice(0, 12)}`);
        const rollback = node(row, "button", this.pendingRollback?.to_ts === item.ts ? "重试同一回滚" : "回滚到此快照", "editor-rollback");
        rollback.type = "button";
        rollback.disabled = !this.canEdit || !this.loaded || this.conflict || this.unverified || !!this.pending || this.draft !== this.content || !!this.pendingRollback && this.pendingRollback.to_ts !== item.ts;
        rollback.addEventListener("click", async () => { try { await this.rollback(item.ts); } catch (error) { this.status = error instanceof Error ? error.message : "回滚失败"; this.render(); } });
      }
    }
    this.root.replaceChildren(fragment);
  }
}
