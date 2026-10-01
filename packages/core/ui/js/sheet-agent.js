import { createSelfScreenSender } from "./editor.js";
import { IdentitySheet } from "./sheet-identity.js";
import { MemorySheet } from "./sheet-memory.js";
import { renderActivitySheet } from "./sheet-activity.js";
import { normalizeClockList, renderUpcomingSheet } from "./sheet-upcoming.js";
import { answerGateAsk, approvalSections, renderApprovalsSheet } from "./sheet-approvals.js";
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";

const TABS = Object.freeze([
  ["activity", "活动"], ["upcoming", "计划"], ["approvals", "审批"],
  ["identity", "身份"], ["memory", "记忆"],
]);
const rawRoute = /\b(?:agent|worker|device|service|person):[A-Za-z0-9_-]+\b|\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/i;
const flowLabels = Object.freeze({ memory: "整理记忆", proactive: "寻找值得提醒的事", heartbeat: "查看托付事项", opener: "见面问候", tour: "使用提示" });
const stepLabels = Object.freeze({ evidence: "查看对话", extract: "提取记忆", verify_claims: "核对记忆", append_log: "记下新发现",
  sources: "查看线索", candidate: "判断是否提醒", handoff: "交给 Ash", read_heartbeat: "查看托付清单", wake: "通知 Ash", judge: "判断是否问候" });
const backgroundStep = (step) => stepLabels[step] || (/^(?:read|reconcile|verify_plan|apply)_(?:memory|user)$/.test(step) ? "整理记忆" : null);

/** Only ledger-derived, human-facing status steps enter the activity page. */
export function safeActivityView(view) {
  const turns = {};
  for (const [id, turn] of Object.entries(view?.turns ?? {})) {
    if (!/^[tr]_[A-Za-z0-9_-]+$/.test(id) || !turn || !Number.isFinite(turn.started)) continue;
    turns[id] = {
      title: turn.background ? flowLabels[turn.title] || "后台任务" : typeof turn.title === "string" ? turn.title : "对话",
      background: turn.background === true, started: turn.started,
      ended: Number.isFinite(turn.ended) ? turn.ended : undefined,
      outcome: ["completed", "cancelled", "error"].includes(turn.outcome) ? turn.outcome : undefined,
      steps: Array.isArray(turn.steps) ? turn.steps.filter((step) => !step.requestId &&
        typeof step.label === "string" && step.label.length <= 160 && (turn.background ? Boolean(backgroundStep(step.label)) : !rawRoute.test(step.label)))
        .map((step) => ({ label: turn.background ? backgroundStep(step.label) : step.label, ts: step.ts, state: step.state })) : [],
    };
  }
  return { turns };
}

async function sendClockForScreen(net, current, word, body, clientId) {
  const token = net.token;
  const screen = net.screen;
  const scope = net.currentScope;
  const generation = net.generation;
  if (!token || !screen || !scope || !current()) throw new Error("屏幕未连接，计划操作暂不可用。");
  const stillCurrent = () => current() && token === net.token && screen === net.screen &&
    scope === net.currentScope && generation === net.generation;
  let response;
  try {
    response = await net.request("/api/send", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token },
      body: JSON.stringify({ to: "service:clock", kind: "request", word, body, wait: true,
        ...(clientId ? { client_id: clientId } : {}) }) });
  } catch {
    if (!stillCurrent()) throw new Error("屏幕身份已变化，计划结果已丢弃。");
    throw new Error("计划服务连接中断，结果未确认；可原样重试。");
  }
  if (!stillCurrent()) throw new Error("屏幕身份已变化，计划结果已丢弃。");
  if (!response.ok) throw new Error(response.status === 403 ? "当前屏幕无权修改计划。" : "计划服务未确认操作，可重试。" );
  let accepted;
  try { accepted = await response.json(); }
  catch { throw new Error("计划服务回执无法读取，可原样重试。"); }
  if (!stillCurrent()) throw new Error("屏幕身份已变化，计划结果已丢弃。");
  const reply = accepted?.reply;
  if (typeof accepted?.id !== "string" || !accepted.id || reply?.kind !== "response" ||
    reply.reply_to !== accepted.id || reply.from !== "service:clock" || reply.to !== "person:owner" ||
    reply.word !== word || reply.body?.ok !== true) throw new Error("计划服务回执未配对或未成功，可原样重试。");
  return reply;
}

export async function listClockForScreen(net, current) {
  return normalizeClockList(await sendClockForScreen(net, current, "list", {}));
}

export async function cancelClockForScreen(net, current, id, clientId) {
  if (typeof id !== "string" || !id || typeof clientId !== "string" || !clientId) throw new TypeError("invalid clock cancel intent");
  const reply = await sendClockForScreen(net, current, "cancel", { id }, clientId);
  if (reply.body.result?.cancelled !== true) throw new Error("计划未确认删除；请刷新计划后核对。");
}

const node = (tag, label) => {
  const item = document.createElement(tag);
  item.textContent = label;
  return item;
};

/** Separate from Settings: local admin and preference drafts are never reparented. */
export class AgentSheet {
  constructor(root, net, { getView = () => null, getLedgerMessage = () => null,
    confirmDiscard = () => globalThis.confirm?.("放弃未保存或未确认的修改并关闭人物页？") === true,
    confirmRollback = ({ path, to_ts }) => globalThis.confirm?.(`确认将 ${path} 回滚到 ${new Date(to_ts).toLocaleString()} 的快照？`) === true,
    idFactory = () => crypto.randomUUID() } = {}) {
    this.root = root;
    this.net = net;
    this.getView = getView;
    this.getLedgerMessage = getLedgerMessage;
    this.confirmDiscard = confirmDiscard;
    this.confirmRollback = confirmRollback;
    this.idFactory = idFactory;
    this.cancelIntents = new Map();
    this.answerIntents = new Map();
    this.tabs = root.querySelector("#agentTabs");
    this.panel = root.querySelector("#agentPanel");
    this.session = null;
    this.identity = null;
    this.memory = null;
    this.panels = new Map();
    this.activeTab = null;
    this.loadEpoch = 0;
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
    this.loadEpoch++;
    this.cancelIntents.clear();
    this.answerIntents.clear();
    this.approvalStatus = "";
    this.activeTab = null;
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

  update() {
    if (this.activeTab === "activity" && this.current()) this.renderActivity();
    if (this.activeTab === "approvals" && this.current()) this.renderApprovals();
  }

  renderApprovals() {
    const section = this.panels.get("approvals");
    if (!section || !this.current()) return;
    const binding = this.session;
    const epoch = this.loadEpoch;
    renderApprovalsSheet(section, this.getView(), { answerState: this.answerIntents,
      onAnswer: (ask, choice) => this.answerApproval(ask, choice, binding, epoch) });
    if (this.approvalStatus) section.prepend(node("p", this.approvalStatus));
  }

  async answerApproval(ask, choice, binding, epoch) {
    if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
    const fresh = approvalSections(this.getView()).pending.find((item) => item.id === ask.id);
    if (!fresh || fresh.seq !== ask.seq || !fresh.options.some((option) => option.id === choice)) return;
    let intent = this.answerIntents.get(ask.id);
    if (intent && (intent.choice !== choice || intent.status === "pending" || intent.status === "confirmed" || intent.status === "rejected")) return;
    if (!intent) {
      intent = { choice, clientId: this.idFactory(), status: "pending" };
      this.answerIntents.set(ask.id, intent);
    } else intent.status = "pending";
    this.approvalStatus = "";
    this.renderApprovals();
    try {
      await answerGateAsk(this.net, () => this.current(binding) && this.activeTab === "approvals" && epoch === this.loadEpoch,
        fresh, choice, intent.clientId, (id) => this.getLedgerMessage(id));
      if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
      intent.status = "confirmed";
      this.approvalStatus = "回答已在记录中确认；这不代表外部操作已经完成。";
    } catch (error) {
      if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
      intent.status = /无权|被拒绝|已失效|不可用/.test(error?.message || "") ? "rejected" : "uncertain";
      this.approvalStatus = error instanceof Error ? error.message : "回答结果未知；只能原样重试。";
    }
    this.renderApprovals();
  }

  renderActivity() {
    const section = this.panels.get("activity");
    if (!section || !this.current()) return;
    renderActivitySheet(section, safeActivityView(this.getView()));
  }

  renderUpcoming(section, timers, binding, epoch) {
    renderUpcomingSheet(section, timers, { onCancel: async (id) => {
      if (epoch !== this.loadEpoch || this.activeTab !== "upcoming" || !this.current(binding))
        throw new Error("屏幕身份已变化，不能删除计划。");
      let clientId = this.cancelIntents.get(id);
      if (!clientId) {
        clientId = this.idFactory();
        this.cancelIntents.set(id, clientId);
      }
      await cancelClockForScreen(this.net, () => this.current(binding), id, clientId);
      const fresh = await listClockForScreen(this.net, () => this.current(binding));
      if (epoch !== this.loadEpoch || this.activeTab !== "upcoming" || !this.current(binding)) return;
      if (fresh.some((timer) => timer.id === id)) throw new Error("计划删除后仍在列表中，请稍后重试核对。");
      this.cancelIntents.delete(id);
      this.renderUpcoming(section, fresh, binding, epoch);
    } });
  }

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
    this.activeTab = key;
    const epoch = ++this.loadEpoch;
    for (const [name, section] of this.panels) section.hidden = name !== key;
    for (const button of this.tabs.children) button.setAttribute("aria-selected", String(button.dataset.tab === key));
    const section = this.panels.get(key);
    if (!this.current()) {
      section.replaceChildren(node("p", "屏幕未连接或身份已变化；请重新连接后查看。"));
      return;
    }
    if (key === "activity") { this.renderActivity(); return; }
    if (key === "approvals") { this.renderApprovals(); return; }
    if (key === "upcoming") {
      section.replaceChildren(node("p", "正在读取时钟计划…"));
      const binding = this.session;
      try {
        const timers = await listClockForScreen(this.net, () => this.current(binding));
        if (epoch !== this.loadEpoch || this.activeTab !== key || !this.current(binding)) return;
        for (const id of this.cancelIntents.keys()) if (!timers.some((timer) => timer.id === id)) this.cancelIntents.delete(id);
        this.renderUpcoming(section, timers, binding, epoch);
      } catch {
        if (epoch !== this.loadEpoch || this.activeTab !== key || !this.current(binding)) return;
        section.replaceChildren(node("p", "计划列表暂不可用；不能据此判断待办为空。"));
      }
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
