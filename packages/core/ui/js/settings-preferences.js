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
    this.status = element("p", "");
    this.status.className = "set-status";
    this.status.setAttribute("role", "status");
    this.loadButton = element("button", "重新读取");
    this.loadButton.className = "btn gray";
    this.loadButton.id = "settingsProactiveLoad";
    this.loadButton.type = "button";
    this.saveButton = element("button", "保存");
    this.saveButton.className = "btn";
    this.saveButton.id = "settingsProactiveSave";
    this.saveButton.type = "button";
    this.editor = document.createElement("textarea");
    this.editor.id = "settingsProactiveText";
    this.editor.className = "set-editor";
    this.editor.placeholder = "比如：早上 9 点前别找我；快递和日程变化可以直接说；别的事攒到晚上一起说。";
    this.editor.maxLength = MAX_CHARS;
    this.editor.disabled = true;
    this.saveButton.disabled = true;
    this.loadButton.addEventListener("click", () => { void this.load(); });
    this.saveButton.addEventListener("click", () => { void this.save(); });
    root.append(this.editor, this.saveButton, this.loadButton, this.status);
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
    this.status.textContent = "正在读取…";
    try {
      const result = await this.request("read", { path: PATH }, crypto.randomUUID());
      if (!this.current()) return;
      if (result.body?.ok === true && typeof result.body.result?.content === "string" &&
        /^[0-9a-f]{64}$/.test(result.body.result?.hash)) {
        this.baseline = result.body.result.hash;
        this.editor.value = result.body.result.content;
        this.loaded = true;
        this.pending = null;
        this.status.textContent = "已读取当前偏好。";
      } else if (result.body?.ok === false && result.body.error?.code === "not_found") {
        this.baseline = null;
        this.editor.value = "";
        this.loaded = true;
        this.pending = null;
        this.status.textContent = "还没有写过，写下来保存就行。";
      } else {
        this.loaded = false;
        this.status.textContent = "没读到偏好，请点「重新读取」。";
      }
    } catch {
      if (this.current()) { this.loaded = false; this.status.textContent = "连接断了，没读到偏好。"; }
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
      this.status.textContent = "内容太长了，没有保存。";
      return;
    }
    const pending = this.pending ?? { content: this.editor.value, expected_hash: this.baseline, client_id: crypto.randomUUID() };
    this.pending = pending;
    this.busy = true;
    this.editor.disabled = true;
    this.saveButton.disabled = true;
    this.loadButton.disabled = true;
    this.status.textContent = "正在保存…";
    try {
      const result = await this.request("write", { path: PATH, content: pending.content,
        expected_hash: pending.expected_hash, why: "Owner updated proactive preferences" }, pending.client_id);
      if (!this.current()) return;
      if (result.body?.ok === false) {
        this.pending = null;
        this.status.textContent = result.body.error?.code === "bad_request"
          ? "这段偏好刚在别处改过，未覆盖；请点「重新读取」后再改。" : "保存被拒绝了。";
        return;
      }
      if (result.body?.ok !== true || !/^[0-9a-f]{64}$/.test(result.body.result?.hash)) {
        this.status.textContent = "保存结果未确认，请再点一次保存。";
        return;
      }
      const verification = await this.request("read", { path: PATH }, crypto.randomUUID());
      if (!this.current()) return;
      if (verification.body?.ok === true && verification.body.result?.hash === result.body.result.hash &&
        verification.body.result?.content === pending.content) {
        this.baseline = result.body.result.hash;
        this.pending = null;
        this.status.textContent = "已保存。";
      } else this.status.textContent = "保存结果未确认，请再点一次保存。";
    } catch {
      if (this.current()) this.status.textContent = "保存结果未确认，请再点一次保存。";
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
