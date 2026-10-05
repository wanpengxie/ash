import { createSelfScreenSender, FILE_LABELS, named, when } from "./editor.js";
import { IdentitySheet } from "./sheet-identity.js";
import { MemorySheet } from "./sheet-memory.js";
import { renderActivitySheet } from "./sheet-activity.js";
import { normalizeClockList, renderUpcomingSheet } from "./sheet-upcoming.js";
import { answerGateAsk, approvalSections, gatePageRequest, renderApprovalsSheet } from "./sheet-approvals.js";
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";

const TABS = Object.freeze([
  ["identity", "身份"], ["memory", "记忆"], ["activity", "活动"],
  ["upcoming", "计划"], ["approvals", "审批"],
]);
// Where she looked on the web reads like a domain, which the raw-route guard would otherwise drop.
const webDetail = /^(?:在看网页|在搜索) · [^\n]{1,61}$/u;
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
      // Background runs end as done / no_change / failed; say them in the same words as a conversation.
      outcome: ["completed", "cancelled", "error"].includes(turn.outcome) ? turn.outcome
        : turn.background === true ? { done: "completed", no_change: "completed", failed: "error" }[turn.outcome] : undefined,
      steps: Array.isArray(turn.steps) ? turn.steps.filter((step) => typeof step.label === "string" && step.label.length <= 180 &&
        (step.tool || step.summary || (turn.background ? Boolean(backgroundStep(step.label)) : webDetail.test(step.label) || !rawRoute.test(step.label))))
        .map((step) => ({ label: turn.background && !step.tool && !step.summary ? backgroundStep(step.label) : step.label,
          ts: step.ts, ended: step.ended, state: step.state, tool: step.tool, target: step.target, requestId: step.requestId,
          approval: step.approval, summary: step.summary })) : [],
    };
  }
  return { turns };
}

async function sendClockForScreen(net, current, word, body, clientId) {
  const token = net.token;
  const screen = net.screen;
  const scope = net.currentScope;
  const generation = net.generation;
  if (!token || !screen || !scope || !current()) throw new Error("还没连上，暂时不能读取或修改计划。");
  const stillCurrent = () => current() && token === net.token && screen === net.screen &&
    scope === net.currentScope && generation === net.generation;
  let response;
  try {
    response = await net.request("/api/send", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token },
      body: JSON.stringify({ to: "service:clock", kind: "request", word, body, wait: true,
        ...(clientId ? { client_id: clientId } : {}) }) });
  } catch {
    if (!stillCurrent()) throw new Error("连接已经换过，这次的结果没有采用。");
    throw new Error("连接断了，还没确认结果；再点一次会原样重试。");
  }
  if (!stillCurrent()) throw new Error("连接已经换过，这次的结果没有采用。");
  if (!response.ok) throw new Error(response.status === 403 ? "这台设备不能修改计划。" : "没有收到确认，可以再试一次。" );
  let accepted;
  try { accepted = await response.json(); }
  catch { throw new Error("还没确认结果；再点一次会原样重试。"); }
  if (!stillCurrent()) throw new Error("连接已经换过，这次的结果没有采用。");
  const reply = accepted?.reply;
  if (typeof accepted?.id !== "string" || !accepted.id || reply?.kind !== "response" ||
    reply.reply_to !== accepted.id || reply.from !== "service:clock" || reply.to !== "person:owner" ||
    reply.word !== word || reply.body?.ok !== true) throw new Error("还没确认结果；再点一次会原样重试。");
  return reply;
}

export async function listClockForScreen(net, current) {
  return normalizeClockList(await sendClockForScreen(net, current, "list", {}));
}

export async function cancelClockForScreen(net, current, id, clientId) {
  if (typeof id !== "string" || !id || typeof clientId !== "string" || !clientId) throw new TypeError("invalid clock cancel intent");
  const reply = await sendClockForScreen(net, current, "cancel", { id }, clientId);
  if (reply.body.result?.cancelled !== true) throw new Error("没能删除这条计划，它还在。");
}

const node = (tag, label, className = "") => {
  const item = document.createElement(tag);
  item.textContent = label;
  if (className) item.className = className;
  return item;
};

/** A plain failure line with one retry button; never a claim that the list is empty. */
const retryCard = (message, retry) => {
  const box = node("div", "", "sheet-retry");
  const button = node("button", "重试", "btn gray");
  button.type = "button";
  button.addEventListener("click", () => { button.disabled = true; void retry(); });
  box.append(node("p", message), button);
  return box;
};

/** Separate from Settings: local admin and preference drafts are never reparented. */
export class AgentSheet {
  constructor(root, net, { getView = () => null, getLedgerMessage = () => null,
    onAskAbout = () => {}, onPrefill,
    confirmDiscard = () => globalThis.confirm?.("有修改还没保存。现在关掉，这些修改会丢掉。确定关掉吗？") === true,
    confirmRollback = ({ path, to_ts }) => globalThis.confirm?.(`把「${FILE_LABELS[path] ?? "这份内容"}」恢复成 ${when(to_ts)} 改动之前的样子？现在的内容会被替换。`) === true,
    idFactory = () => crypto.randomUUID() } = {}) {
    this.root = root;
    this.net = net;
    this.getView = getView;
    this.getLedgerMessage = getLedgerMessage;
    this.onAskAbout = onAskAbout;
    this.onPrefill = onPrefill;
    this.confirmDiscard = confirmDiscard;
    this.confirmRollback = confirmRollback;
    this.idFactory = idFactory;
    this.name = "Ash";
    this.cancelIntents = new Map();
    this.answerIntents = new Map();
    this.revokeIntents = new Map();
    this.tabs = root.querySelector("#agentTabs");
    this.panel = root.querySelector("#agentPanel");
    this.session = null;
    this.activityDetails?.clear();
    this.identity = null;
    this.memory = null;
    this.panels = new Map();
    this.activeTab = null;
    this.loadEpoch = 0;
    this.backgroundOpen = false;
    this.expandedTurns = new Set();
    this.activityDetails = new Map();
    this.armedRule = null;
    this.root.querySelector("#agentClose").addEventListener("click", () => this.close());
  }

  setName(name) {
    if (typeof name === "string" && name.trim()) this.name = name.trim();
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
    this.activityDetails.clear();
    this.loadEpoch++;
    this.cancelIntents.clear();
    this.answerIntents.clear();
    this.revokeIntents.clear();
    this.approvalStatus = "";
    this.approvalHistory = null;
    this.approvalRules = null;
    this.approvalEvidence = new Map();
    this.approvalsLoaded = false;
    this.armedRule = null;
    this.backgroundOpen = false;
    this.expandedTurns.clear();
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
    if (!this.session || !this.current()) return;
    this.badge();
    if (this.activeTab === "activity") this.renderActivity();
    if (this.activeTab === "approvals") this.renderApprovals();
  }

  /** The approvals tab carries a count while something waits for the owner. */
  badge() {
    const count = approvalSections(this.getView()).pending.length;
    for (const button of this.tabs.children) if (button.dataset.tab === "approvals") button.dataset.badge = count ? String(count) : "";
  }

  renderApprovals() {
    const section = this.panels.get("approvals");
    if (!section || !this.current()) return;
    const binding = this.session;
    const epoch = this.loadEpoch;
    renderApprovalsSheet(section, this.getView(), { answerState: this.answerIntents, name: this.name,
      loading: !this.approvalsLoaded,
      onAnswer: (ask, choice) => this.answerApproval(ask, choice, binding, epoch),
      history: this.approvalHistory, rules: this.approvalRules, status: this.approvalStatus,
      onRetry: () => this.loadApprovalData(binding, epoch),
      armedRule: this.armedRule, onArm: (id) => { this.armedRule = id; this.renderApprovals(); },
      onRevoke: binding.localManagement ? (id) => this.revokeApprovalRule(id, binding, epoch) : undefined,
      evidence: this.approvalEvidence, onEvidence: (id) => this.toggleEvidence(id, binding, epoch) });
  }

  /** Opening a record reads its evidence from the gate; tapping again closes it. */
  async toggleEvidence(id, binding, epoch) {
    if (this.approvalEvidence.has(id)) { this.approvalEvidence.delete(id); this.renderApprovals(); return; }
    this.approvalEvidence.set(id, { status: "loading" });
    this.renderApprovals();
    let next;
    try {
      const result = await gatePageRequest(this.net, () => this.current(binding), "audit", { request_id: id, limit: 1 });
      const entry = Array.isArray(result?.entries) ? result.entries.find((item) => item?.request_id === id) : undefined;
      next = entry ? { status: "ready", entry } : { status: "missing" };
    } catch { next = { status: "failed" }; }
    if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch || !this.approvalEvidence.has(id)) return;
    this.approvalEvidence.set(id, next);
    this.renderApprovals();
  }

  async loadApprovalData(binding, epoch) {
    try {
      const [history, rules] = await Promise.all([
        gatePageRequest(this.net, () => this.current(binding), "history", { limit: 100 }),
        gatePageRequest(this.net, () => this.current(binding), "rules.list", { limit: 100 }),
      ]);
      if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
      if (!Array.isArray(history?.items) || !Array.isArray(rules?.rules)) throw new Error("审批列表格式无效");
      this.approvalHistory = history.items;
      this.approvalRules = rules.rules;
      this.approvalStatus = "";
    } catch {
      if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
      this.approvalHistory = null;
      this.approvalRules = null;
      this.approvalStatus = "";
    }
    this.approvalsLoaded = true;
    this.renderApprovals();
  }

  async revokeApprovalRule(id, binding, epoch) {
    if (!binding.localManagement || !this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
    const clientId = this.revokeIntents.get(id) ?? crypto.randomUUID();
    this.revokeIntents.set(id, clientId);
    try {
      const result = await gatePageRequest(this.net, () => this.current(binding), "rules.revoke", { id }, clientId);
      if (result?.revoked !== true) throw new Error("rule was not revoked");
      if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
      this.revokeIntents.delete(id);
      this.armedRule = null;
      this.approvalStatus = "";
      await this.loadApprovalData(binding, epoch);
    } catch {
      if (this.current(binding) && this.activeTab === "approvals" && epoch === this.loadEpoch) {
        this.approvalStatus = "还没确认撤销成功；再点一次「确认撤销」会原样重试。";
        this.renderApprovals();
      }
      throw new Error("rule revocation unconfirmed");
    }
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
      // The ledger has the answer; the action itself may still be running or may still fail.
      this.approvalStatus = "已收到你的回答。事情本身做没做完，看她接下来的消息。";
    } catch (error) {
      if (!this.current(binding) || this.activeTab !== "approvals" || epoch !== this.loadEpoch) return;
      intent.status = /无权|被拒绝|已失效|不可用/.test(error?.message || "") ? "rejected" : "uncertain";
      this.approvalStatus = "";
    }
    this.renderApprovals();
  }

  renderActivity() {
    const section = this.panels.get("activity");
    if (!section || !this.current()) return;
    renderActivitySheet(section, safeActivityView(this.getView()), { askAbout: this.onAskAbout,
      detailState: this.activityDetails,
      loadDetails: async (id, offset = 0) => {
        const binding = this.binding();
        const response = await this.net.request(`/api/activity/detail?id=${encodeURIComponent(id)}&offset=${offset}`, { credentials: "same-origin" });
        if (!this.current(binding) || !response.ok) throw new Error("详情暂时无法读取");
        return response.json();
      },
      backgroundOpen: this.backgroundOpen,
      onToggleBackground: (open) => { this.backgroundOpen = open; this.renderActivity(); },
      expanded: this.expandedTurns,
      onExpand: (id) => {
        if (this.expandedTurns.has(id)) this.expandedTurns.delete(id); else this.expandedTurns.add(id);
        this.renderActivity();
      } });
  }

  renderUpcoming(section, timers, binding, epoch) {
    renderUpcomingSheet(section, timers, { name: this.name, onCancel: async (id) => {
      if (epoch !== this.loadEpoch || this.activeTab !== "upcoming" || !this.current(binding))
        throw new Error("连接已经换过，没有删除。");
      let clientId = this.cancelIntents.get(id);
      if (!clientId) {
        clientId = this.idFactory();
        this.cancelIntents.set(id, clientId);
      }
      await cancelClockForScreen(this.net, () => this.current(binding), id, clientId);
      const fresh = await listClockForScreen(this.net, () => this.current(binding));
      if (epoch !== this.loadEpoch || this.activeTab !== "upcoming" || !this.current(binding)) return;
      if (fresh.some((timer) => timer.id === id)) throw new Error("删除后它还在列表里；请稍后再看。");
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
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => { void this.show(key); });
      this.tabs.append(button);
      const section = document.createElement("section");
      section.dataset.tab = key;
      section.hidden = true;
      this.panel.append(section);
      this.panels.set(key, section);
    }
    if (this.current()) this.badge();
    void this.show("identity");
    return true;
  }

  /** Muse-style: changing her name is something you ask her, not a form. */
  renameRow() {
    if (typeof this.onPrefill !== "function") return null;
    const box = node("div", "", "set-group sheet-rename");
    const row = node("button", "", "set-row");
    row.type = "button";
    const text = node("span", "", "set-text");
    text.append(node("span", `想给${named(this.name)}换个名字？`, "set-title"), node("span", "直接跟她说，她会自己改好名片。", "set-sub"));
    row.append(text, node("span", "", "set-chev"));
    row.addEventListener("click", () => this.onPrefill("我想给你换个名字，以后叫你"));
    box.append(row);
    return box;
  }

  async show(key) {
    if (!this.panels.has(key)) return;
    this.activeTab = key;
    const epoch = ++this.loadEpoch;
    if (key !== "approvals") this.armedRule = null;
    for (const [name, section] of this.panels) section.hidden = name !== key;
    for (const button of this.tabs.children) button.setAttribute("aria-selected", String(button.dataset.tab === key));
    const section = this.panels.get(key);
    if (!this.current()) {
      section.replaceChildren(node("p", "还没连上，或连接已经换过；连上后再打开看看。", "sheet-empty set-card"));
      return;
    }
    if (key === "activity") { this.renderActivity(); return; }
    if (key === "approvals") {
      this.approvalsLoaded = false;
      this.renderApprovals();
      void this.loadApprovalData(this.session, epoch);
      return;
    }
    if (key === "upcoming") {
      section.replaceChildren(node("p", "正在读取…", "sheet-loading"));
      const binding = this.session;
      try {
        const timers = await listClockForScreen(this.net, () => this.current(binding));
        if (epoch !== this.loadEpoch || this.activeTab !== key || !this.current(binding)) return;
        for (const id of this.cancelIntents.keys()) if (!timers.some((timer) => timer.id === id)) this.cancelIntents.delete(id);
        this.renderUpcoming(section, timers, binding, epoch);
      } catch {
        if (epoch !== this.loadEpoch || this.activeTab !== key || !this.current(binding)) return;
        section.replaceChildren(retryCard("暂时读不到计划（不代表没有）。", () => this.show(key)));
      }
      return;
    }
    const isIdentity = key === "identity";
    const existing = isIdentity ? this.identity : this.memory;
    if (existing) { void existing.refresh(); return; }
    section.replaceChildren(node("p", "正在读取…", "sheet-loading"));
    const binding = this.session;
    const rawSend = createSelfScreenSender(this.net);
    const send = async (request) => {
      if (!this.current(binding)) throw new Error("连接已经换过，这次的结果没有采用。");
      if (["write", "rollback"].includes(request.word) && !binding.localManagement)
        throw new Error("只有在她所在的手机上才能修改。");
      const response = await rawSend(request);
      if (!this.current(binding)) throw new Error("连接已经换过，这次的结果没有采用。");
      return response;
    };
    const options = { send, canEdit: binding.localManagement, confirmRollback: this.confirmRollback, name: this.name };
    const sheet = isIdentity
      ? new IdentitySheet(section, { ...options, extra: () => this.renameRow() })
      : new MemorySheet(section, options);
    if (isIdentity) this.identity = sheet;
    else this.memory = sheet;
    try { await sheet.open(); }
    catch {
      sheet.dispose();
      if (isIdentity && this.identity === sheet) this.identity = null;
      if (!isIdentity && this.memory === sheet) this.memory = null;
      if (!this.current(binding)) return;
      section.replaceChildren(retryCard("没能读取，请再试一次。", () => this.activeTab === key ? this.show(key) : undefined));
    }
  }
}
