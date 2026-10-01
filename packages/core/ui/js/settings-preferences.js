import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";

const PATH = "PROACTIVE.md";
const MAX_CHARS = 65_536;

function element(tag, text = "") {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
}

/** A screen-bound editor. Drafts and uncertain writes live only in this instance. */
export class ProactivePreferences {
  constructor(root, net, valid) {
    this.root = root;
    this.net = net;
    this.valid = valid;
    this.identity = { token: net.token, screen: net.screen, scope: net.currentScope };
    this.active = true;
    this.baseline = null;
    this.loaded = false;
    this.pending = null;
    this.busy = false;
    const heading = element("h2", "主动联系偏好");
    this.status = element("p", "尚未读取偏好文件。请连接本地屏幕后加载。");
    this.status.setAttribute("role", "status");
    this.loadButton = element("button", "加载偏好");
    this.loadButton.type = "button";
    this.saveButton = element("button", "保存偏好");
    this.saveButton.type = "button";
    this.editor = document.createElement("textarea");
    this.editor.id = "settingsProactiveText";
    this.editor.maxLength = MAX_CHARS;
    this.editor.disabled = true;
    this.saveButton.disabled = true;
    this.loadButton.addEventListener("click", () => { void this.load(); });
    this.saveButton.addEventListener("click", () => { void this.save(); });
    root.append(heading, this.status, this.loadButton, this.editor, this.saveButton);
  }

  current() {
    return this.active && this.valid() && this.net.localManagement === true &&
      this.net.token === this.identity.token && this.net.screen === this.identity.screen &&
      this.net.currentScope === this.identity.scope && Boolean(this.identity.token && this.identity.screen && this.identity.scope);
  }

  dispose() {
    this.active = false;
    this.pending = null;
    this.baseline = null;
    this.loaded = false;
    this.editor.value = "";
  }

  paired(accepted, word) {
    const reply = accepted?.reply;
    return typeof accepted?.id === "string" && reply?.kind === "response" && reply.reply_to === accepted.id &&
      reply.from === "service:self" && reply.to === "person:owner" && reply.word === word ? reply.body : null;
  }

  async request(word, body, client_id) {
    const response = await this.net.request("/api/send", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: this.identity.token },
      body: JSON.stringify({ to: "service:self", kind: "request", word, body, client_id, wait: true }) });
    if (!response.ok) return { http: response.status };
    const accepted = await response.json();
    return { body: this.paired(accepted, word) };
  }

  async load() {
    if (!this.current() || this.busy || this.pending) return;
    this.busy = true;
    this.loadButton.disabled = true;
    this.saveButton.disabled = true;
    this.status.textContent = "正在核对偏好文件…";
    try {
      const result = await this.request("read", { path: PATH }, crypto.randomUUID());
      if (!this.current()) return;
      if (result.body?.ok === true && typeof result.body.result?.content === "string" &&
        /^[0-9a-f]{64}$/.test(result.body.result?.hash)) {
        this.baseline = result.body.result.hash;
        this.editor.value = result.body.result.content;
        this.loaded = true;
        this.pending = null;
        this.status.textContent = "已读取当前偏好；保存时会核对版本。";
      } else if (result.body?.ok === false && result.body.error?.code === "not_found") {
        this.baseline = null;
        this.editor.value = "";
        this.loaded = true;
        this.pending = null;
        this.status.textContent = "偏好文件尚不存在；保存会创建它。";
      } else {
        this.loaded = false;
        this.status.textContent = "未能核实偏好文件；请重试加载。";
      }
    } catch {
      if (this.current()) { this.loaded = false; this.status.textContent = "连接中断，未读取偏好文件。"; }
    } finally {
      this.busy = false;
      if (this.current()) {
        this.loadButton.disabled = Boolean(this.pending);
        this.editor.disabled = !this.loaded || Boolean(this.pending);
        this.saveButton.disabled = !this.loaded;
      }
    }
  }

  async save() {
    if (!this.current() || !this.loaded || this.busy) return;
    if (!this.pending && this.editor.value.length > MAX_CHARS) {
      this.status.textContent = "内容过长，尚未发送。";
      return;
    }
    const pending = this.pending ?? { content: this.editor.value, expected_hash: this.baseline, client_id: crypto.randomUUID() };
    this.pending = pending;
    this.busy = true;
    this.editor.disabled = true;
    this.saveButton.disabled = true;
    this.loadButton.disabled = true;
    this.status.textContent = "等待文件写入和复核…";
    try {
      const result = await this.request("write", { path: PATH, content: pending.content,
        expected_hash: pending.expected_hash, why: "Owner updated proactive preferences" }, pending.client_id);
      if (!this.current()) return;
      if (result.body?.ok === false) {
        this.pending = null;
        this.status.textContent = result.body.error?.code === "bad_request"
          ? "文件版本已变化，未覆盖；请重新加载后核对。" : "写入被拒绝，未标记为已保存。";
        return;
      }
      if (result.body?.ok !== true || !/^[0-9a-f]{64}$/.test(result.body.result?.hash)) {
        this.status.textContent = "写入结果未确认；可重试同一请求。";
        return;
      }
      const verification = await this.request("read", { path: PATH }, crypto.randomUUID());
      if (!this.current()) return;
      if (verification.body?.ok === true && verification.body.result?.hash === result.body.result.hash &&
        verification.body.result?.content === pending.content) {
        this.baseline = result.body.result.hash;
        this.pending = null;
        this.status.textContent = "已保存并重新核对。";
      } else this.status.textContent = "写入回执已到，但复核未完成；请重试同一请求。";
    } catch {
      if (this.current()) this.status.textContent = "写入结果未确认；可重试同一请求。";
    } finally {
      this.busy = false;
      if (this.current()) {
        this.loadButton.disabled = Boolean(this.pending);
        this.editor.disabled = Boolean(this.pending);
        this.saveButton.disabled = false;
      }
    }
  }
}
