import { createSelfScreenSender } from "./editor.js";
import { IdentitySheet } from "./sheet-identity.js";
import { MemorySheet } from "./sheet-memory.js";

const TABS = Object.freeze([
  ["activity", "活动"], ["upcoming", "计划"], ["approvals", "审批"],
  ["identity", "身份"], ["memory", "记忆"],
]);
const UNAVAILABLE = Object.freeze({
  activity: "活动详情尚未接入；不会展示未经整理的工具记录。",
  upcoming: "计划页尚未接入；这里不能代表真实待办为空。",
  approvals: "审批服务尚未接入；此页不能确认操作或管理规则。",
});

const node = (tag, label) => {
  const item = document.createElement(tag);
  item.textContent = label;
  return item;
};

/** Separate from Settings: local admin and preference drafts are never reparented. */
export class AgentSheet {
  constructor(root, net, { confirmDiscard = () => globalThis.confirm?.("放弃未保存或未确认的修改并关闭人物页？") === true,
    confirmRollback = ({ path, to_ts }) => globalThis.confirm?.(`确认将 ${path} 回滚到 ${new Date(to_ts).toLocaleString()} 的快照？`) === true } = {}) {
    this.root = root;
    this.net = net;
    this.confirmDiscard = confirmDiscard;
    this.confirmRollback = confirmRollback;
    this.tabs = root.querySelector("#agentTabs");
    this.panel = root.querySelector("#agentPanel");
    this.session = null;
    this.identity = null;
    this.memory = null;
    this.panels = new Map();
    this.root.querySelector("#agentClose").addEventListener("click", () => this.close());
  }

  binding() {
    return { token: this.net.token, screen: this.net.screen, scope: this.net.currentScope,
      localManagement: this.net.localManagement === true, generation: this.net.generation };
  }

  current(binding = this.session) {
    if (!binding || !binding.token || !binding.screen || !binding.scope) return false;
    const now = this.binding();
    return binding.token === now.token && binding.screen === now.screen && binding.scope === now.scope &&
      binding.localManagement === now.localManagement && binding.generation === now.generation;
  }

  dirty() {
    return [this.identity?.editor, this.memory?.editor].some((editor) => editor &&
      (editor.pending || editor.pendingRollback || editor.loaded && editor.draft !== editor.content));
  }

  close() {
    if (this.dirty() && !this.confirmDiscard()) return false;
    this.reset();
    return true;
  }

  reset() {
    this.identity?.dispose();
    this.memory?.dispose();
    this.identity = null;
    this.memory = null;
    this.session = null;
    this.panels.clear();
    this.tabs.replaceChildren();
    this.panel.replaceChildren();
    this.root.classList.remove("open");
    this.root.setAttribute("aria-hidden", "true");
  }

  network(status) { if (status !== "online") this.reset(); }

  registration() { if (this.session && !this.current()) this.reset(); }

  open() {
    if (this.session && this.current()) { this.root.classList.add("open"); this.root.setAttribute("aria-hidden", "false"); return true; }
    this.reset();
    this.session = this.binding();
    this.root.classList.add("open");
    this.root.setAttribute("aria-hidden", "false");
    for (const [key, label] of TABS) {
      const button = node("button", label);
      button.type = "button";
      button.dataset.tab = key;
      button.addEventListener("click", () => { void this.show(key); });
      this.tabs.append(button);
      const section = document.createElement("section");
      section.dataset.tab = key;
      section.hidden = true;
      this.panel.append(section);
      this.panels.set(key, section);
    }
    void this.show("identity");
    return true;
  }

  async show(key) {
    if (!this.panels.has(key)) return;
    for (const [name, section] of this.panels) section.hidden = name !== key;
    for (const button of this.tabs.children) button.setAttribute("aria-selected", String(button.dataset.tab === key));
    const section = this.panels.get(key);
    if (Object.hasOwn(UNAVAILABLE, key)) {
      section.replaceChildren(node("p", UNAVAILABLE[key]));
      return;
    }
    if (!this.current()) {
      section.replaceChildren(node("p", "屏幕未连接或身份已变化；请重新连接后查看。"));
      return;
    }
    const isIdentity = key === "identity";
    if (isIdentity ? this.identity : this.memory) return;
    section.replaceChildren(node("p", "正在读取当前文件…"));
    const binding = this.session;
    const rawSend = createSelfScreenSender(this.net);
    const send = async (request) => {
      if (!this.current(binding)) throw new Error("屏幕身份已变化，不能继续操作文件。");
      if (["write", "rollback"].includes(request.word) && !binding.localManagement)
        throw new Error("远程屏幕不能修改用户文件。");
      const response = await rawSend(request);
      if (!this.current(binding)) throw new Error("屏幕身份已变化，不能继续操作文件。");
      return response;
    };
    const sheet = isIdentity
      ? new IdentitySheet(section, { send, canEdit: binding.localManagement, confirmRollback: this.confirmRollback })
      : new MemorySheet(section, { send, canEdit: binding.localManagement, confirmRollback: this.confirmRollback });
    if (isIdentity) this.identity = sheet;
    else this.memory = sheet;
    try { await sheet.open(); }
    catch (error) {
      sheet.dispose();
      if (isIdentity && this.identity === sheet) this.identity = null;
      if (!isIdentity && this.memory === sheet) this.memory = null;
      if (!this.current(binding)) return;
      section.replaceChildren(node("p", error instanceof Error ? error.message : "文件暂不可用。"));
    }
  }
}
