import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
import { ProactivePreferences } from "./settings-preferences.js";
import { AppsSettings, appsSummary } from "./settings-apps.js";
import { usdToCnyText as money, balanceText, CNY_ESTIMATE_NOTE } from "./money.js";

function node(tag, label, className = "") {
  const element = document.createElement(tag);
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

function button(label, className = "btn", id = "") {
  const element = node("button", label, className);
  element.type = "button";
  if (id) element.id = id;
  return element;
}

/** A list row: icon, title, one line underneath, and a chevron. `sub` is kept on the row so callers can update it. */
function navRow(id, icon, title, subtitle, onClick, href = "") {
  const row = document.createElement(href ? "a" : "button");
  row.id = id;
  row.className = "set-row";
  if (href) row.href = href; else row.type = "button";
  const text = document.createElement("span");
  text.className = "set-text";
  const sub = node("span", subtitle, "set-sub");
  text.append(node("span", title, "set-title"), sub);
  row.append(node("span", "", `set-icon i-${icon}`), text, node("span", "", "set-chev"));
  if (onClick) row.addEventListener("click", onClick);
  row.sub = sub;
  return row;
}

function group(header, ...rows) {
  const wrap = document.createElement("div");
  wrap.className = "set-group-wrap";
  if (header) wrap.append(node("h3", header, "set-header"));
  const box = document.createElement("div");
  box.className = "set-group";
  box.append(...rows);
  wrap.append(box);
  return wrap;
}

/** Two taps for anything that takes something away: the first says what will happen, the second does it. */
function armed(control, label, confirmLabel, onWarn, run) {
  let ready = false;
  // Leaving the page takes the first tap back: coming back never finds a destructive button one tap from done.
  control.setAttribute("data-armed", "");
  control.disarm = () => { if (ready) { ready = false; control.textContent = label; } };
  control.addEventListener("click", () => {
    if (control.disabled) return;
    if (!ready) { ready = true; control.textContent = confirmLabel; onWarn?.(); return; }
    ready = false;
    control.textContent = label;
    void run();
  });
}

const SCOPE_NAMES = { chat: "对话", mind: "内心整理", background: "后台任务", title: "起标题", compaction: "压缩历史", review: "审批判断", progress: "进展摘要", other: "其他" };
const KEYS = [
  { ref: "DEEPSEEK_API_KEY", title: "DeepSeek Key", use: "用于：对话模型", hint: "没有它，Ash 无法对话。" },
  { ref: "OPENROUTER_API_KEY", title: "OpenRouter Key", use: "用于：快速判断（JEV 模型）", hint: "没有它，快速判断只能靠关键词。" },
];
/** Why the gateway is not usable, as the owner should read it; the codes come from service:devices gateway_status. */
const GATEWAY_PROBLEMS = {
  claimed_by_other: "网关已被另一台手机认领，这台手机连不上。要换成这台手机，需要先在网关上清除原来的主人，再在下面填一把新的认领密钥。",
  bad_secret: "认领密钥不对，网关没有接受。请在下面重新填写正确的密钥。",
  missing_secret: "网关还没有主人。请在下面填写一次性认领密钥。",
  unsupported: "网关的版本和 Ash 对不上，需要先更新网关。",
  unreachable: "连不上网关，Ash 会自动重试。请检查网络和网关地址。",
};
const RUNTIMES = { codex: "Codex", claude: "Claude Code", workbuddy: "WorkBuddy" };
const CALL_STATUS = { ok: "成功", pending: "进行中", denied: "被拒绝", forbidden: "不允许", offline: "设备离线", timeout: "超时", cancelled: "已取消" };
/** A device's diagnosis in plain words for the owner, not the raw record. */
export function deviceDiagnosis(result) {
  const r = result && typeof result === "object" ? result : {};
  const count = Number(r.capabilities) || (Array.isArray(r.capability_specs) ? r.capability_specs.length : 0);
  const calls = Array.isArray(r.recent_calls) ? r.recent_calls : [];
  const time = (at) => { const d = new Date(Number(at)); return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : ""; };
  return [
    `${r.online ? "在线" : "离线"}${r.version ? `，设备端版本 ${r.version}` : ""}。`,
    r.gateway_connected ? "网关已连接。" : "网关没有连上。",
    count ? `借出 ${count} 项能力。` : "",
    r.workdir ? `工作目录：${r.workdir}` : "",
    calls.length ? `最近的调用：\n${calls.map((c) => `${time(c.at)} ${c.word ?? ""} · ${CALL_STATUS[c.status] ?? "失败"}`).join("\n")}` : "最近没有调用。",
  ].filter(Boolean).join("\n");
}
const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

/** Usage as two lists: how much per period, then where the last week went. */
export function renderUsage(summary) {
  const line = (label, totals) => {
    const row = document.createElement("div");
    row.className = "set-line";
    const text = document.createElement("span");
    text.className = "set-text";
    const note = totals.unpriced_calls ? ` · 另有 ${totals.unpriced_calls} 次没有价格` : "";
    text.append(node("span", label, "set-title"),
      node("span", `${totals.calls} 次调用 · 输入 ${tokens(totals.input_tokens + totals.cache_read_tokens)} / 输出 ${tokens(totals.output_tokens)}${note}`, "set-sub"));
    row.append(text, node("span", money(totals.cost_usd), "set-value"));
    return row;
  };
  const groups = [group("", line("今天", summary.periods.today), line("近 7 天", summary.periods["7d"]), line("近 30 天", summary.periods["30d"]))];
  if (summary.by_scope.length)
    groups.push(group("近 7 天花在哪", ...summary.by_scope.map((scope) => line(SCOPE_NAMES[scope.scope] ?? scope.scope, scope))));
  return groups;
}

/** Local management controls are rendered only for this screen's current server registration. */
export class SettingsControls {
  constructor(panel, net, { onClose } = {}) {
    this.panel = panel;
    this.net = net;
    this.onClose = onClose;
    this.name = "Ash";
    this.allowed = false;
    this.connected = false;
    this.section = null;
    this.sectionContext = null;
    this.preferences = null;
    this.refreshHome = null;
    this.render();
  }

  registration(frame) {
    this.allowed = frame?.local_management === true;
    this.render();
  }

  network(status) {
    this.connected = status === "online";
    if (!this.connected) this.allowed = false;
    this.render();
  }

  reset() {
    this.allowed = false;
    this.connected = false;
    this.render();
  }

  /** The drawer was opened: always start at the settings root, showing what is true now. */
  opened() {
    this.showHome?.();
    void this.refreshHome?.();
  }

  setName(name) {
    if (typeof name !== "string" || !name.trim() || name.trim() === this.name) return;
    this.name = name.trim();
    this.sectionContext = null;
    this.render();
  }

  render() {
    const usable = this.allowed && this.connected && this.net.localManagement === true && Boolean(this.net.token);
    const context = usable ? `${this.net.currentScope ?? ""}\0${this.net.screen ?? ""}\0${this.net.token}` : null;
    if (this.section && context && context === this.sectionContext) return;
    this.preferences?.dispose();
    this.preferences = null;
    this.refreshHome = null;
    this.showHome = null;
    const name = this.name;
    const android = globalThis.location?.origin === "https://appassets.androidplatform.net";
    const titleBar = document.createElement("div");
    titleBar.className = "set-titlebar";
    titleBar.append(node("h2", "设置", "set-main-title"));
    if (this.onClose) {
      const close = button("完成", "set-close");
      close.addEventListener("click", () => this.onClose());
      titleBar.append(close);
    }
    this.panel.replaceChildren(titleBar);
    this.section = null;
    this.sectionContext = null;
    if (!usable) {
      this.panel.append(node("p", `连上 ${name} 所在的这台手机后，才能在这里调整设置。`, "set-intro"));
      if (android) this.panel.append(group("", navRow("settingsConsole", "shield", "手机权限", "通知、无障碍、后台运行，以及诊断", null, "ash://console")));
      return;
    }
    const section = document.createElement("section");
    section.id = "settingsAdmin";
    const live = () => this.section === section;
    const home = document.createElement("div");
    home.id = "settingsHome";
    section.append(home);
    const pages = [];
    const show = (target) => {
      home.hidden = target !== home;
      for (const item of pages) item.hidden = item !== target;
      titleBar.hidden = target !== home;
      for (const control of section.querySelectorAll?.("[data-armed]") ?? []) control.disarm?.();
    };
    const page = (id, title, intro, onOpen) => {
      const element = document.createElement("section");
      element.id = id;
      element.className = "set-page";
      element.hidden = true;
      const back = button("设置", "set-back", `${id}Back`);
      back.addEventListener("click", () => { show(home); void this.refreshHome?.(); });
      element.append(back, node("h2", title, "set-page-title"));
      if (intro) element.append(node("p", intro, "set-intro"));
      element.open = () => { show(element); void onOpen?.(); };
      pages.push(element);
      section.append(element);
      return element;
    };

    const requestSetting = async (word, body, to = "service:admin") => {
      const token = this.net.token, screen = this.net.screen, scope = this.net.currentScope;
      if (!live() || !this.connected || !this.allowed || !this.net.localManagement || !token || !screen || !scope) return null;
      const response = await this.net.request("/api/send", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token },
        body: JSON.stringify({ to, kind: "request", word, body, wait: true, client_id: crypto.randomUUID() }) });
      if (!live() || !this.connected || !this.allowed || token !== this.net.token ||
        screen !== this.net.screen || scope !== this.net.currentScope || !this.net.localManagement || !response.ok) return null;
      const accepted = await response.json();
      const reply = accepted?.reply;
      return reply?.kind === "response" && reply.reply_to === accepted.id && reply.from === to &&
        reply.to === "person:owner" && reply.word === word ? reply.body : null;
    };
    // Credentials live in ash's own vault. This is the only door in: the local owner's screen, a route that never touches
    // the ledger. The page learns whether a key is saved, never what it is.
    const vaultRequest = async (method, ref, body) => {
      const token = this.net.token, screen = this.net.screen, scope = this.net.currentScope;
      if (!live() || !this.connected || !this.allowed || !this.net.localManagement || !token || !screen || !scope) return null;
      const response = await this.net.request(ref ? `/api/vault/${ref}` : "/api/vault", { method, credentials: "same-origin",
        headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!live() || token !== this.net.token || screen !== this.net.screen || scope !== this.net.currentScope || !response.ok) return null;
      return await response.json();
    };

    // ---- Home: usage at a glance, then what Ash can use, how she treats your time, pause, and the rest.
    const usageCard = document.createElement("button");
    usageCard.type = "button";
    usageCard.id = "settingsUsageCard";
    usageCard.className = "set-card set-usage";
    const usageToday = node("span", "—", "set-big");
    const usageMore = node("span", "点开看花在哪里", "set-sub");
    usageCard.append(node("span", "今天花了（人民币估算）", "set-sub"), usageToday, usageMore);

    const vaultRow = navRow("settingsVaultRow", "key", "密钥", "DeepSeek、OpenRouter", () => vaultPage.open());
    const gatewayRow = navRow("settingsGatewayRow", "devices", "已连接设备", "其他电脑和浏览器", () => gatewayPage.open());
    const capability = [vaultRow, gatewayRow];
    const appsRow = navRow("settingsAppsRow", "apps", "应用", `装在 ${name} 里的应用，以及它们能用什么`, () => appsPage.open());
    capability.push(appsRow);
    if (android && typeof globalThis.__ashBrowserLogins === "function")
      capability.push(navRow("settingsBrowserRow", "globe", "浏览器登录", `${name} 的浏览器里登录过的网站`, () => browserPage.open()));
    if (android) capability.push(navRow("settingsConsole", "shield", "手机权限", "通知、无障碍、后台运行，以及诊断", null, "ash://console"));
    const quietRow = navRow("settingsQuietRow", "moon", "免打扰", "这段时间不主动找你", () => quietPage.open());
    const proactiveRow = navRow("settingsProactiveRow", "chat", "主动联系", `${name} 什么时候可以主动找你`, () => proactivePage.open());
    const approvalRow = navRow("settingsApprovalRow", "shield", "审批", `${name} 做事前什么时候先问你`, () => approvalPage.open());

    const pauseCard = document.createElement("div");
    pauseCard.id = "settingsPauseCard";
    pauseCard.className = "set-card set-pause";
    const pauseTitle = node("span", `暂停 ${name}`, "set-title");
    const pauseText = node("span", `暂停后 ${name} 会停下手头所有的事，不再主动做任何事，直到你恢复。`, "set-sub");
    const pause = button(`暂停 ${name}`, "btn red", "settingsPause");
    const resume = button(`恢复 ${name}`, "btn", "settingsResume");
    const confirmation = document.createElement("div");
    confirmation.id = "settingsResumeConfirmation";
    confirmation.className = "set-confirm";
    confirmation.hidden = true;
    confirmation.append(node("p", `确定要恢复 ${name} 吗？`));
    const yes = button("确认恢复", "btn", "settingsResumeYes");
    const no = button("取消", "btn gray");
    confirmation.append(yes, no);
    const feedback = node("p", "", "set-status");
    feedback.id = "settingsFeedback";
    feedback.setAttribute("role", "status");
    const showPaused = (paused) => {
      pauseTitle.textContent = paused === true ? `${name} 已暂停` : `暂停 ${name}`;
      pause.hidden = paused === true;
      resume.hidden = paused === false;
    };
    const run = async (word) => {
      if (!live() || !this.connected || !this.allowed || !this.net.localManagement) return;
      pause.disabled = true;
      resume.disabled = true;
      yes.disabled = true;
      feedback.textContent = "正在处理…";
      const result = await this.net.sendAdmin(word);
      if (!live() || !this.connected || !this.allowed) return;
      const done = result.ok && result.paused === (word === "pause");
      feedback.textContent = done ? word === "pause" ? `已暂停 ${name}` : `已恢复 ${name}` : "状态未确认，请检查连接后重试。";
      if (done) showPaused(result.paused);
      pause.disabled = false;
      resume.disabled = false;
      yes.disabled = false;
    };
    pause.addEventListener("click", () => { void run("pause"); });
    resume.addEventListener("click", () => { confirmation.hidden = false; });
    yes.addEventListener("click", () => { confirmation.hidden = true; void run("resume"); });
    no.addEventListener("click", () => { confirmation.hidden = true; });
    pauseCard.append(pauseTitle, pauseText, pause, resume, confirmation, feedback);

    const devRow = navRow("settingsDevRow", "code", "开发者选项", "主模型、DSH 插件", () => devPage.open());
    home.append(usageCard, group(`${name} 能用的`, ...capability), group("相处方式", quietRow, proactiveRow, approvalRow), pauseCard, group("其他", devRow));
    usageCard.addEventListener("click", () => usagePage.open());

    // ---- Usage
    const usagePage = page("settingsUsage", "用量", "", () => refreshUsage());
    const usageTable = document.createElement("div");
    usageTable.id = "settingsUsageTable";
    const balanceLine = node("p", "", "set-intro");
    balanceLine.id = "settingsUsageBalance";
    const usageStatus = node("p", "", "set-status");
    usageStatus.id = "settingsUsageStatus";
    usageStatus.setAttribute("role", "status");
    const usageRefresh = button("刷新", "btn gray", "settingsUsageRefresh");
    usageRefresh.addEventListener("click", () => { void refreshUsage(); });
    usagePage.append(usageTable, balanceLine, usageStatus, usageRefresh);
    const showUsage = (summary) => {
      usageToday.textContent = money(summary.periods.today.cost_usd);
      usageMore.textContent = `近 7 天 ${money(summary.periods["7d"].cost_usd)} · 近 30 天 ${money(summary.periods["30d"].cost_usd)}`;
    };
    const refreshUsage = async () => {
      usageStatus.textContent = "正在读取…";
      try {
        const reply = await requestSetting("usage.get", { days: 7 }, "service:cost");
        if (reply?.ok !== true) throw new Error("unavailable");
        if (!live()) return;
        usageTable.replaceChildren(...renderUsage(reply.result));
        showUsage(reply.result);
        usageStatus.textContent = `${reply.result.estimated ? "费用按模型的公开价格估算。" : ""}${CNY_ESTIMATE_NOTE}`;
      } catch { if (live()) usageStatus.textContent = "用量读取失败，请重试。"; return; }
      try {
        const reply = await requestSetting("balance.get", {}, "service:cost");
        if (!live()) return;
        balanceLine.textContent = reply?.ok === true
          ? `账户余额：${reply.result.balances.map(balanceText).join("，") || "无数据"}${reply.result.available ? "" : "（账户当前不可用）"}`
          : "账户余额暂时读不到（不是零）。";
      } catch { if (live()) balanceLine.textContent = "账户余额暂时读不到（不是零）。"; }
    };

    // ---- Keys
    const vaultPage = page("settingsVault", "密钥",
      `Key 只保存在这台手机上。${name} 知道存了哪几个，但看不到内容，Key 也不会出现在聊天里。保存后立刻生效。`, () => refreshVault());
    const vaultViews = [];
    for (const { ref, title, use, hint } of KEYS) {
      const card = document.createElement("div");
      card.id = `settingsVault_${ref}`;
      card.className = "set-card";
      const head = document.createElement("div");
      head.className = "set-text";
      head.append(node("span", title, "set-title"), node("span", use, "set-sub"));
      const status = node("p", "正在读取…", "set-status");
      status.id = `settingsVault_${ref}_status`;
      status.setAttribute("role", "status");
      const field = document.createElement("input");
      field.id = `settingsVault_${ref}_value`;
      field.type = "password";
      field.placeholder = "粘贴 Key";
      field.autocomplete = "off";
      const save = button("保存");
      const remove = button("移除", "btn gray");
      remove.hidden = true;
      const show = (saved) => {
        status.textContent = saved ? "已保存。" : `还没有保存。${hint}`;
        status.className = saved ? "set-status ok" : "set-status warn";
        field.placeholder = saved ? "粘贴新的 Key 替换" : "粘贴 Key";
        field.disabled = false;
        save.disabled = false;
        remove.disabled = false;
        remove.hidden = !saved;
      };
      const lock = () => {
        status.textContent = "手机安全存储暂时不可用。原有密钥未被读取或修改，请重启手机后再试。";
        status.className = "set-status warn";
        field.value = "";
        field.disabled = true;
        save.disabled = true;
        remove.disabled = true;
        remove.hidden = true;
      };
      vaultViews.push({ ref, show, lock, status });
      save.addEventListener("click", () => { void (async () => {
        if (save.disabled) return;
        const value = field.value.trim();
        field.value = "";
        if (!value) { status.textContent = "请先粘贴 Key。"; return; }
        save.disabled = true;
        status.textContent = "正在保存…";
        try {
          const reply = await vaultRequest("PUT", ref, { value });
          if (live()) { if (reply?.ok === true) show(true); else status.textContent = "保存失败，请重试。"; }
        } catch { if (live()) status.textContent = "保存失败，请重试。"; }
        finally { save.disabled = false; }
      })(); });
      armed(remove, "移除", "确定移除？", () => { status.textContent = `移除后，${hint.replace(/^没有它，/, "")}`; }, async () => {
        remove.disabled = true;
        try {
          const reply = await vaultRequest("DELETE", ref);
          if (live()) { if (reply?.ok === true) show(false); else status.textContent = "移除失败，请重试。"; }
        } catch { if (live()) status.textContent = "移除失败，请重试。"; }
        finally { remove.disabled = false; }
      });
      const actions = document.createElement("div");
      actions.className = "set-actions";
      actions.append(save, remove);
      card.append(head, status, field, actions);
      vaultPage.append(card);
    }
    const readVault = async () => {
      const reply = await vaultRequest("GET");
      return Array.isArray(reply?.entries) ? { entries: reply.entries, available: reply.available !== false } : null;
    };
    const refreshVault = async () => {
      try {
        const vault = await readVault();
        if (!live()) return;
        if (vault?.available === false) { for (const view of vaultViews) view.lock(); return; }
        for (const view of vaultViews) {
          const entry = vault?.entries.find((item) => item.ref === view.ref);
          if (entry) view.show(entry.configured === true); else view.status.textContent = "读取失败，请重试。";
        }
      } catch { if (live()) for (const view of vaultViews) view.status.textContent = "读取失败，请重试。"; }
    };

    // ---- Connected devices
    const gatewayPage = page("settingsGateway", "已连接设备",
      `其他电脑或浏览器可以通过网关连上这台手机上的 ${name}。每一台都要你在这里批准。`, () => openGateway());
    const gatewayStatus = node("p", "", "set-status");
    gatewayStatus.id = "settingsGatewayStatus";
    gatewayStatus.setAttribute("role", "status");
    const gatewayList = document.createElement("div");
    gatewayList.id = "settingsGatewayList";
    gatewayList.className = "set-group";
    const pairCode = button("添加设备", "btn", "settingsGatewayPair");
    const choose = (entries, value, id) => {
      const select = document.createElement("select"); select.id = id;
      for (const [key, label] of entries) { const option = node("option", label); option.value = key; select.append(option); }
      select.value = value; return select;
    };
    const kinds = [["laptop", "电脑"], ["server", "服务器"], ["browser", "浏览器（仅聊天和界面）"]];
    const pairKind = choose(kinds, "laptop", "settingsGatewayPairKind");
    const deviceRequest = (word, body = {}) => requestSetting(word, body, "service:devices");
    const permissions = (device, prefix) => {
      const box = node("div", "", "set-card");
      const access = choose([["approval", "按规则和影响审批"], ["full", "完全放开（命令也不再询问）"]], device.access || "approval", `${prefix}Access`);
      const check = (title, checked, id) => {
        const label = node("label", title); const input = document.createElement("input");
        input.type = "checkbox"; input.checked = checked; input.id = id; label.append(input); box.append(label); return input;
      };
      box.append(access);
      const local = check("允许本地 Agent（使用电脑本地完整权限）", device.local_agents === true, `${prefix}Agents`);
      const web = check("允许访问 Ash 聊天和网页界面", device.web_ui === true, `${prefix}Web`);
      return { box, read: () => ({ access: access.value, local_agents: local.checked, web_ui: web.checked }),
        browser: (yes) => { access.disabled = yes; local.disabled = yes; web.disabled = yes; if (yes) { access.value = "approval"; local.checked = false; web.checked = true; } } };
    };
    const pairResult = node("p", "", "set-status");
    pairResult.id = "settingsGatewayPairResult";
    pairResult.setAttribute("role", "status");
    // The pairing code reaches only this screen, over an owner-only route that never touches the ledger; starting
    // pairing (by the owner or by Ash) only says a code was issued. The page polls that route while it is open: a new
    // revision means a request arrived, a device was approved or came online, so the list is read again.
    const pairBox = node("div", "", "set-card");
    pairBox.id = "settingsGatewayPairCode";
    pairBox.hidden = true;
    const pairText = node("p", "", "set-status");
    pairText.id = "settingsGatewayPairCodeText";
    const pairCommand = node("pre", "");
    pairCommand.id = "settingsGatewayPairCommand";
    const pairCopy = button("复制命令", "btn gray", "settingsGatewayPairCopy");
    pairBox.append(pairText, pairCommand, pairCopy);
    let shownCode = null, codeDeadline = 0, revision = null, polling = null;
    pairCopy.addEventListener("click", () => { void (async () => {
      try { await globalThis.navigator.clipboard.writeText(pairCommand.textContent); pairCopy.textContent = "已复制"; }
      catch { pairCopy.textContent = "长按上面的命令复制"; }
    })(); });
    const countdown = (ms) => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
    let waiting = 0;
    const showCode = () => {
      const code = shownCode;
      const left = code ? codeDeadline - Date.now() : 0;
      const state = code?.state === "active" && left <= 0 ? "expired" : code?.state;
      // A spent code stays on the page only while the request it brought still waits for the owner.
      pairBox.hidden = !code || (state === "used" && waiting === 0);
      pairCommand.hidden = pairCopy.hidden = state !== "active" || !code?.install_command;
      if (!code) return;
      if (state === "used") { pairText.textContent = "配对码已使用。新设备发来的连接请求在上面，确认是你的设备再批准。"; return; }
      if (state === "expired") { pairText.textContent = "配对码已过期。需要时再点「添加设备」。"; return; }
      const where = typeof code.gateway === "string" ? code.gateway : "网关地址";
      pairText.textContent = code.kind === "browser"
        ? `配对码：${code.ticket}（还剩 ${countdown(left)}，只能用一次）。在新浏览器打开 ${where}，输入配对码，再回到这里批准。`
        : `配对码：${code.ticket}（还剩 ${countdown(left)}，只能用一次）。在要连接的电脑上打开“终端”，运行下面这一行，再回到这里批准：`;
      pairCommand.textContent = code.install_command ?? "";
    };
    const pairingRequest = async () => {
      const token = this.net.token, screen = this.net.screen, scope = this.net.currentScope;
      if (!live() || !this.connected || !this.allowed || !this.net.localManagement || !token || !screen || !scope) return null;
      const response = await this.net.request("/api/devices/pairing", { method: "GET", credentials: "same-origin", headers: { [SCREEN_TOKEN_HEADER]: token } });
      if (!live() || token !== this.net.token || screen !== this.net.screen || scope !== this.net.currentScope || !response.ok) return null;
      return await response.json();
    };
    const readPairing = async () => {
      const view = await pairingRequest().catch(() => null);
      if (!view || !live()) return;
      if (view.code?.state !== shownCode?.state || view.code?.ticket !== shownCode?.ticket) pairCopy.textContent = "复制命令";
      shownCode = view.code ?? null;
      codeDeadline = Date.now() + (Number(view.code?.expires_in_ms) || 0);
      showCode();
      if (revision !== null && view.revision !== revision) await refreshGateway().catch(() => {});
      revision = view.revision;
    };
    const watch = () => {
      if (polling) return;
      let tick = 0;
      polling = setInterval(() => {
        if (!live() || gatewayPage.hidden) { clearInterval(polling); polling = null; return; }
        if (globalThis.document?.hidden) return;
        showCode();
        if (++tick % 2 === 0) void readPairing();
      }, 1000);
      polling.unref?.();
    };
    pairCode.addEventListener("click", () => { void (async () => {
      pairCode.disabled = true;
      pairResult.textContent = "正在生成配对码…";
      try {
        const reply = await deviceRequest("pair_start", { kind: pairKind.value });
        if (reply?.ok !== true || reply.result?.issued !== true) throw new Error("not issued");
        await readPairing();
        if (!live()) return;
        if (shownCode?.state !== "active") throw new Error("code not shown");
        pairResult.textContent = "";
      } catch { if (live()) { pairResult.textContent = "生成失败：网关可能离线，请稍后重试。"; shownCode = null; showCode(); } }
      finally { pairCode.disabled = false; }
    })(); });
    const item = (title, subtitle) => {
      const row = document.createElement("div");
      row.className = "set-item settings-plugin";
      const text = document.createElement("span");
      text.className = "set-text";
      text.append(node("span", title, "set-title"), node("span", subtitle, "set-sub"));
      row.append(text);
      return row;
    };
    const refreshGateway = async () => {
      const reply = await deviceRequest("gateway_status");
      if (reply?.ok !== true) throw new Error("gateway unavailable");
      const state = reply.result;
      if (!live()) return state;
      gatewayList.replaceChildren();
      gatewayList.hidden = true;
      if (state?.configured !== true) { gatewayStatus.textContent = "还没有设置网关，其他设备暂时连不上。"; return state; }
      gatewayStatus.textContent = state.connected ? "网关已连接。" : GATEWAY_PROBLEMS[state.error] ?? "网关暂时离线。";
      waiting = Array.isArray(state.pending) ? state.pending.length : 0; showCode();
      const act = async (word, body) => {
        const result = await deviceRequest(word, body);
        if (result?.ok !== true) throw new Error("gateway operation failed");
        await refreshGateway();
      };
      const failed = (text) => () => { if (live()) gatewayStatus.textContent = text; };
      for (const pending of Array.isArray(state.pending) ? state.pending : []) {
        if (typeof pending.request_id !== "string" || typeof pending.name !== "string") continue;
        const row = item(pending.name, `等你批准 · 先选择设备类型和权限${pending.fingerprint ? ` · 指纹 ${pending.fingerprint}` : ""}`);
        const prefix = `settingsPending-${pending.request_id}`;
        const kind = choose(kinds, pairKind.value, `${prefix}Kind`);
        const grant = permissions({}, prefix);
        grant.browser(kind.value === "browser");
        kind.addEventListener("change", () => grant.browser(kind.value === "browser"));
        const approve = button("批准");
        approve.id = `${prefix}Approve`;
        approve.addEventListener("click", () => { void act("pair_approve", { request_id: pending.request_id,
          kind: kind.value, ...grant.read() }).catch(failed("批准未确认，请刷新状态后检查。")); });
        const reject = button("拒绝", "btn gray");
        reject.addEventListener("click", () => { void act("pair_reject", { request_id: pending.request_id }).catch(failed("拒绝未确认，请重试。")); });
        row.append(kind, grant.box, approve, reject);
        gatewayList.append(row);
      }
      for (const device of Array.isArray(state.devices) ? state.devices : []) {
        if (typeof device.id !== "string" || typeof device.name !== "string") continue;
        // A computer lends its capabilities once its list has been read; until then the count would wrongly read zero.
        const count = Number(device.capabilities) || (Array.isArray(device.capability_specs) ? device.capability_specs.length : 0);
        const lends = device.lends === true || count > 0 ? ` · ${count} 个能力` : device.online ? " · 正在读取能力" : "";
        const kind = device.kind === "browser" ? "浏览器" : `${device.kind === "server" ? "服务器" : "电脑"}${lends}`;
        const row = item(device.name, `${kind} · ${device.online ? "在线" : "离线"}${device.version ? ` · v${device.version}` : ""} · ${device.access === "full" ? "完全放开" : "按规则审批"}`);
        const revoke = button("移除", "btn gray");
        revoke.id = `settingsDevice-${device.id}Revoke`;
        armed(revoke, "移除", "确定移除？", () => { gatewayStatus.textContent = `移除后 ${device.name} 需要重新配对才能连上。`; },
          () => act("revoke", { device: device.id }).catch(failed("移除未确认，请重试。")));
        row.append(revoke);
        const details = node("details"); details.append(node("summary", "名称、权限与诊断"));
        if (device.workdir) details.append(node("p", `工作目录：${device.workdir}`, "set-sub"));
        if (Array.isArray(device.agents) && device.agents.length) details.append(node("p", `本地 Agent：${device.agents.map(a => `${RUNTIMES[a.kind] ?? a.kind}${a.installed ? "" : "（未安装）"}`).join("、")}`, "set-sub"));
        const nameInput = document.createElement("input"); nameInput.value = device.name; nameInput.setAttribute("aria-label", "设备名称");
        const rename = button("保存名称", "btn gray");
        rename.addEventListener("click", () => { void act("rename", { device: device.id, name: nameInput.value }).catch(failed("名称未保存。")); });
        const grant = permissions(device, `settingsDevice-${device.id}`); grant.browser(device.kind === "browser");
        const save = button("保存权限");
        save.addEventListener("click", () => { void act("access_set", { device: device.id, ...grant.read() }).catch(failed("权限未确认，请刷新状态后检查。")); });
        const diagnose = button("诊断", "btn gray"); const info = node("pre", "", "set-status");
        diagnose.addEventListener("click", () => { void deviceRequest("diagnose", { device: device.id }).then(reply => {
          info.textContent = reply?.ok ? deviceDiagnosis(reply.result) : "诊断失败，请刷新状态。";
        }).catch(() => { info.textContent = "诊断失败。"; }); });
        details.append(nameInput, rename, grant.box, save, diagnose, info); row.append(details);
        gatewayList.append(row);
      }
      gatewayList.hidden = gatewayList.children.length === 0;
      if (gatewayList.hidden) gatewayStatus.textContent += "还没有连接其他设备。";
      return state;
    };
    gatewayPage.append(gatewayStatus, gatewayList, pairKind, pairCode, pairResult, pairBox);
    let loadGatewayConfig = null;
    if (android && typeof globalThis.__ashGatewayConfig === "function") {
      const url = document.createElement("input");
      url.id = "settingsGatewayUrl";
      url.type = "url";
      url.placeholder = "https://你的网关域名";
      const secret = document.createElement("input");
      secret.id = "settingsGatewaySecret";
      secret.type = "password";
      secret.placeholder = "首次认领用的一次性密钥；已认领可留空";
      secret.autocomplete = "off";
      const saveConfig = button("保存网关", "btn", "settingsGatewaySave");
      const configStatus = node("p", `保存后 ${name} 会重启一下。`, "set-status");
      configStatus.id = "settingsGatewayConfigStatus";
      configStatus.setAttribute("role", "status");
      loadGatewayConfig = async () => {
        try {
          const result = await globalThis.__ashGatewayConfig("status");
          if (!live()) return;
          if (!result.ok) throw new Error("unavailable");
          url.value = result.url;
          configStatus.textContent = result.configured ? `当前网关：${result.url}` : "网关还没有设置。";
        } catch { if (live()) configStatus.textContent = "网关设置读取失败。"; }
      };
      saveConfig.addEventListener("click", () => { void (async () => {
        const enteredUrl = url.value.trim();
        const enteredSecret = secret.value.trim();
        secret.value = "";
        saveConfig.disabled = true;
        configStatus.textContent = "正在保存…";
        try {
          const result = await globalThis.__ashGatewayConfig("save", enteredUrl, enteredSecret);
          if (!live()) return;
          if (!result.ok) throw new Error("unconfirmed");
          url.value = result.url;
          configStatus.textContent = result.configured ? `网关已保存，${name} 正在重启。` : `网关已移除，${name} 正在重启。`;
        } catch { if (live()) configStatus.textContent = "保存失败，请检查域名和密钥。"; }
        finally { saveConfig.disabled = false; }
      })(); });
      const config = document.createElement("div");
      config.className = "set-card";
      config.append(node("span", "网关地址", "set-title"), url, secret, saveConfig, configStatus);
      gatewayPage.append(node("h3", "网关", "set-header"), config);
    }
    const openGateway = async () => {
      gatewayStatus.textContent = "正在读取…";
      void loadGatewayConfig?.();
      revision = null;
      try { await refreshGateway(); } catch { if (live()) gatewayStatus.textContent = "读取失败，请重试。"; }
      await readPairing();
      watch();
    };

    // ---- Browser logins (Android only)
    const browserPage = page("settingsBrowser", "浏览器登录",
      `${name} 用自己的浏览器帮你上网。你在里面登录过的网站只保存在这台手机上。`);
    if (android && typeof globalThis.__ashBrowserLogins === "function") {
      const clear = button("清除浏览器里的所有登录", "btn red", "settingsBrowserClear");
      const browserStatus = node("p", "", "set-status");
      browserStatus.id = "settingsBrowserStatus";
      browserStatus.setAttribute("role", "status");
      armed(clear, "清除浏览器里的所有登录", "再点一次确认清除", () => {
        browserStatus.textContent = `会清掉所有网站的登录并关闭浏览器，之后 ${name} 需要你重新登录。`;
      }, async () => {
        clear.disabled = true;
        browserStatus.textContent = "正在清除…";
        try {
          const result = await globalThis.__ashBrowserLogins();
          if (live()) browserStatus.textContent = result.ok ? "已清除所有登录。" : "清除失败，请重试。";
        } catch { if (live()) browserStatus.textContent = "清除失败，请重试。"; }
        finally { clear.disabled = false; }
      });
      browserPage.append(clear, browserStatus);
    }

    // ---- Apps: the same service:apps words an agent calls; installing here is the owner's own approval of what it needs.
    const apps = new AppsSettings((word, body) => requestSetting(word, body, "service:apps"), { live, name,
      onSummary: (list) => { appsRow.sub.textContent = appsSummary(list); } });
    const appsPage = page("settingsApps", "应用",
      `装在 ${name} 里的应用。安装时列出它要用的东西，你点了才算同意；停用后权限还留着，收回后要重新安装。`, () => apps.load());
    appsPage.append(apps.root);

    // ---- Quiet hours
    const quietPage = page("settingsQuiet", "免打扰",
      `这段时间里，${name} 想主动跟你说的事会先攒着，到点再告诉你。你找她、你定的提醒，照常送达。`, () => loadQuiet());
    const start = document.createElement("input");
    start.id = "settingsQuietStart";
    start.type = "time";
    start.value = "21:30";
    const end = document.createElement("input");
    end.id = "settingsQuietEnd";
    end.type = "time";
    end.value = "09:00";
    const save = button("保存", "btn", "settingsQuietSave");
    const quietStatus = node("p", "", "set-status");
    quietStatus.id = "settingsQuietStatus";
    quietStatus.setAttribute("role", "status");
    const range = document.createElement("div");
    range.className = "set-card set-range";
    range.append(node("span", "从", "set-sub"), start, node("span", "到", "set-sub"), end);
    const showQuiet = (quiet) => { quietRow.sub.textContent = `每天 ${quiet.replace("-", " 到 ")} 不主动找你`; };
    const loadQuiet = async () => {
      quietStatus.textContent = "正在读取…";
      try {
        const reply = await requestSetting("settings.get", {});
        const quiet = reply?.ok === true ? reply.result?.delivery?.quiet : null;
        if (typeof quiet !== "string" || !/^\d\d:\d\d-\d\d:\d\d$/.test(quiet)) throw new Error("unavailable");
        [start.value, end.value] = quiet.split("-");
        showQuiet(quiet);
        quietStatus.textContent = "";
      } catch { if (live()) quietStatus.textContent = "读取失败，请返回后重试。"; }
    };
    save.addEventListener("click", () => { void (async () => {
      quietStatus.textContent = "正在保存…";
      try {
        const quiet = `${start.value}-${end.value}`;
        if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(quiet)) throw new Error("invalid");
        const reply = await requestSetting("settings.set", { delivery: { quiet } });
        if (reply?.ok !== true || reply.result?.delivery?.quiet !== quiet) throw new Error("unconfirmed");
        showQuiet(quiet);
        quietStatus.textContent = "已保存免打扰时段。";
      } catch { if (live()) quietStatus.textContent = "保存未确认，请重试。"; }
    })(); });
    quietPage.append(range, save, quietStatus);

    // ---- Approval: one choice, how often she asks before acting.
    const APPROVAL_MODES = [
      { mode: "auto", title: "有影响时才问", sub: `替你对外发消息、删改你的数据、花钱或执行命令前先问你；看、找、打开这类可撤回的事 ${name} 直接做。` },
      { mode: "always", title: "每次都问", sub: `除了看和读，外部操作都先问你；单独设为「完全放开」的电脑除外。` },
    ];
    const approvalPage = page("settingsApproval", "审批",
      `「有影响时才问」会使用你选过的「以后都允许」规则；「每次都问」会暂停这些规则，切回后继续生效。在 ${name} 的人物页里能看到每次是怎么决定的。`, () => loadApproval());
    const approvalStatus = node("p", "", "set-status");
    approvalStatus.id = "settingsApprovalStatus";
    approvalStatus.setAttribute("role", "status");
    const approvalChoices = APPROVAL_MODES.map(({ mode, title, sub }) => {
      const row = document.createElement("button");
      row.type = "button";
      row.id = `settingsApproval_${mode}`;
      row.className = "set-row";
      row.approvalMode = mode;
      const text = document.createElement("span");
      text.className = "set-text";
      text.append(node("span", title, "set-title"), node("span", sub, "set-sub"));
      const mark = node("span", "", "set-value");
      row.append(text, mark);
      row.mark = mark;
      row.addEventListener("click", () => { void saveApproval(mode); });
      return row;
    });
    const showApproval = (mode) => {
      for (const row of approvalChoices) {
        const chosen = row.approvalMode === mode;
        row.mark.textContent = chosen ? "✓" : "";
        row.setAttribute("aria-pressed", String(chosen));
      }
      approvalRow.sub.textContent = mode === "always" ? "每次都问" : "有影响时才问";
    };
    const loadApproval = async () => {
      approvalStatus.textContent = "正在读取…";
      try {
        const reply = await requestSetting("settings.get", {});
        const mode = reply?.ok === true ? reply.result?.approval?.mode : null;
        if (mode !== "auto" && mode !== "always") throw new Error("unavailable");
        showApproval(mode);
        approvalStatus.textContent = "";
      } catch { if (live()) approvalStatus.textContent = "读取失败，请返回后重试。"; }
    };
    const saveApproval = async (mode) => {
      for (const row of approvalChoices) row.disabled = true;
      approvalStatus.textContent = "正在保存…";
      try {
        const reply = await requestSetting("settings.set", { approval: { mode } });
        if (reply?.ok !== true || reply.result?.approval?.mode !== mode) throw new Error("unconfirmed");
        showApproval(mode);
        approvalStatus.textContent = "已保存。";
      } catch { if (live()) approvalStatus.textContent = "保存未确认，请重试。"; }
      finally { for (const row of approvalChoices) row.disabled = false; }
    };
    approvalPage.append(group("", ...approvalChoices), approvalStatus);

    // ---- Proactive preferences
    const proactivePage = page("settingsProactivePage", "主动联系",
      `告诉 ${name} 什么时候可以主动找你、哪些事值得说。用平常的话写就行。`, () => this.preferences?.load());
    const preferencesRoot = document.createElement("div");
    preferencesRoot.id = "settingsProactive";
    proactivePage.append(preferencesRoot);

    // ---- Developer options
    const devPage = page("settingsDev", "开发者选项", `给开发和排查问题用。改错了可能让 ${name} 无法正常工作。`, () => {
      void loadModel();
      void readPlugins().catch(() => { if (live()) pluginsStatus.textContent = "插件读取失败，请重试。"; });
    });
    const modelSection = document.createElement("div");
    modelSection.id = "settingsModel";
    modelSection.className = "set-card";
    const provider = document.createElement("input");
    provider.id = "settingsModelProvider";
    provider.placeholder = "Provider";
    const model = document.createElement("input");
    model.id = "settingsModelName";
    model.placeholder = "Model";
    const modelSave = button("保存模型", "btn", "settingsModelSave");
    const modelStatus = node("p", "", "set-status");
    modelStatus.id = "settingsModelStatus";
    modelStatus.setAttribute("role", "status");
    const loadModel = async () => {
      modelStatus.textContent = "正在读取…";
      try {
        const reply = await requestSetting("settings.get", {});
        const selection = reply?.ok === true ? reply.result?.model : null;
        if (typeof selection?.provider !== "string" || typeof selection?.model !== "string") throw new Error("unavailable");
        provider.value = selection.provider;
        model.value = selection.model;
        modelStatus.textContent = "";
      } catch { if (live()) modelStatus.textContent = "读取失败，请返回后重试。"; }
    };
    modelSave.addEventListener("click", () => { void (async () => {
      modelStatus.textContent = "正在保存…";
      try {
        const requested = { provider: provider.value.trim(), model: model.value.trim() };
        if (!requested.provider || !requested.model) throw new Error("invalid");
        const reply = await requestSetting("model.set", requested);
        if (reply?.ok !== true || reply.result?.provider !== requested.provider || reply.result?.model !== requested.model ||
          typeof reply.result?.restart_required !== "boolean") throw new Error("unconfirmed");
        modelStatus.textContent = reply.result.restart_required ? `已保存；重启 ${name} 后主模型生效。` : "已保存，下一条消息起就用它。";
      } catch { if (live()) modelStatus.textContent = "保存未确认，请重试。"; }
    })(); });
    modelSection.append(node("span", "主模型", "set-title"), provider, model, modelSave, modelStatus);
    const pluginsSection = document.createElement("div");
    pluginsSection.id = "settingsPlugins";
    const pluginsStatus = node("p", "", "set-status");
    pluginsStatus.id = "settingsPluginsStatus";
    pluginsStatus.setAttribute("role", "status");
    const pluginsList = document.createElement("div");
    pluginsList.id = "settingsPluginsList";
    pluginsList.className = "set-group";
    const readPlugins = async () => {
      pluginsStatus.textContent = "正在读取…";
      const reply = await requestSetting("plugins.list", {});
      const plugins = reply?.ok === true ? reply.result?.plugins : null;
      if (!Array.isArray(plugins)) throw new Error("plugins unavailable");
      if (!live()) return;
      pluginsList.replaceChildren();
      for (const plugin of plugins) {
        if (typeof plugin.entryId !== "string" || typeof plugin.moduleName !== "string") continue;
        const row = item(plugin.moduleName, plugin.enabled ? "已启用" : "已停用");
        row.setAttribute("data-plugin-id", plugin.entryId);
        if (!plugin.readOnlyReason) {
          const toggle = button(plugin.enabled ? "停用" : "启用", "btn gray");
          toggle.addEventListener("click", () => { void (async () => {
            toggle.disabled = true;
            pluginsStatus.textContent = "正在保存…";
            try {
              const result = await requestSetting("plugins.op", { op: "plugin", id: plugin.entryId, enabled: !plugin.enabled });
              if (result?.ok !== true || !["applied", "restart-required"].includes(result.result?.application)) throw new Error("operation failed");
              await readPlugins();
              pluginsStatus.textContent = result.result.application === "restart-required" ? `已保存；重启 ${name} 后生效。` : "已更新插件。";
            } catch { if (live()) pluginsStatus.textContent = "插件更新未确认，请重试。"; }
            finally { toggle.disabled = false; }
          })(); });
          row.append(toggle);
        }
        pluginsList.append(row);
      }
      pluginsStatus.textContent = `已安装 ${plugins.length} 个插件。`;
    };
    pluginsSection.append(pluginsStatus, pluginsList);
    devPage.append(modelSection, node("h3", "DSH 插件", "set-header"), pluginsSection);

    // ---- What the home rows say: read when the drawer opens and whenever you come back to it.
    this.refreshHome = async () => {
      void apps.summary();
      const settled = (work) => work.catch(() => null);
      const [settings, usage, vault, gateway] = await Promise.all([
        settled(requestSetting("settings.get", {})), settled(requestSetting("usage.get", { days: 7 }, "service:cost")),
        settled(readVault()), settled(deviceRequest("gateway_status"))]);
      if (!live()) return;
      const quiet = settings?.ok === true ? settings.result?.delivery?.quiet : null;
      if (typeof quiet === "string" && /^\d\d:\d\d-\d\d:\d\d$/.test(quiet)) {
        [start.value, end.value] = quiet.split("-");
        showQuiet(quiet);
      }
      if (settings?.ok === true && typeof settings.result?.paused === "boolean") showPaused(settings.result.paused);
      const approvalMode = settings?.ok === true ? settings.result?.approval?.mode : null;
      if (approvalMode === "auto" || approvalMode === "always") showApproval(approvalMode);
      if (usage?.ok === true) showUsage(usage.result);
      else usageMore.textContent = "用量暂时读不到";
      if (vault?.available === false) {
        vaultRow.sub.textContent = "手机安全存储暂时不可用";
        vaultRow.sub.className = "set-sub warn";
      } else if (vault) {
        const parts = KEYS.map(({ ref, title }) => `${title} ${vault.entries.find((entry) => entry.ref === ref)?.configured === true ? "已保存" : "未设置"}`);
        vaultRow.sub.textContent = parts.join(" · ");
        vaultRow.sub.className = vault.entries.find((entry) => entry.ref === KEYS[0].ref)?.configured === true ? "set-sub" : "set-sub warn";
      }
      if (gateway?.ok === true) {
        const state = gateway.result ?? {};
        const devices = Array.isArray(state.devices) ? state.devices.length : 0;
        const waiting = Array.isArray(state.pending) ? state.pending.length : 0;
        const broken = state.configured === true && state.connected !== true && typeof state.error === "string";
        gatewayRow.sub.textContent = state.configured !== true ? "还没有设置网关" : broken ? "网关连不上，点开看原因"
          : `${devices ? `${devices} 台设备` : "还没有连接其他设备"}${waiting ? ` · ${waiting} 个等你批准` : ""}`;
        gatewayRow.sub.className = waiting || broken ? "set-sub warn" : "set-sub";
      }
    };

    this.showHome = () => show(home);
    this.panel.append(section);
    this.section = section;
    this.sectionContext = context;
    this.preferences = new ProactivePreferences(preferencesRoot, this.net, () => live() && this.connected && this.allowed);
  }
}
