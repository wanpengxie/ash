import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
import { ProactivePreferences } from "./settings-preferences.js";

function node(tag, label, className = "") {
  const element = document.createElement(tag);
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

const SCOPE_NAMES = { chat: "对话", mind: "内心整理", background: "后台任务", title: "起标题", compaction: "压缩历史", other: "其他" };
const money = (value) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

/** Rows for the usage table: one headline line per period, then where the last week went. */
export function renderUsage(summary) {
  const line = (label, totals, className = "") => {
    const row = node("p", "", className);
    const note = totals.unpriced_calls ? `，另有 ${totals.unpriced_calls} 次没有价格` : "";
    row.textContent = `${label}：${money(totals.cost_usd)} · ${totals.calls} 次调用 · 输入 ${tokens(totals.input_tokens + totals.cache_read_tokens)} / 输出 ${tokens(totals.output_tokens)}${note}`;
    return row;
  };
  const rows = [line("今天", summary.periods.today), line("近 7 天", summary.periods["7d"]), line("近 30 天", summary.periods["30d"])];
  if (summary.by_scope.length) {
    rows.push(node("p", "近 7 天花在哪：", "muted"));
    for (const scope of summary.by_scope) rows.push(line(`　${SCOPE_NAMES[scope.scope] ?? scope.scope}`, scope, "muted"));
  }
  return rows;
}

/** Local management controls are rendered only for this screen's current server registration. */
export class SettingsControls {
  constructor(panel, net) {
    this.panel = panel;
    this.net = net;
    this.allowed = false;
    this.connected = false;
    this.section = null;
    this.sectionContext = null;
    this.preferences = null;
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

  render() {
    const usable = this.allowed && this.connected && this.net.localManagement === true && Boolean(this.net.token);
    const context = usable ? `${this.net.currentScope ?? ""}\0${this.net.screen ?? ""}\0${this.net.token}` : null;
    if (this.section && context && context === this.sectionContext) return;
    this.preferences?.dispose();
    this.preferences = null;
    this.panel.replaceChildren(node("h2", "设置"));
    if (globalThis.location?.origin === "https://appassets.androidplatform.net") {
      const diagnostics = node("a", "手机权限与诊断");
      diagnostics.href = "ash://console";
      this.panel.append(diagnostics);
    }
    this.section = null;
    this.sectionContext = null;
    if (!usable) {
      this.panel.append(node("p", "更多设置尚未接入。", "muted"));
      return;
    }
    const section = document.createElement("section");
    section.id = "settingsAdmin";
    const heading = node("h2", "Ash 运行状态");
    const pause = node("button", "暂停 Ash", "btn gray");
    pause.id = "settingsPause";
    pause.type = "button";
    const resume = node("button", "恢复 Ash", "btn");
    resume.id = "settingsResume";
    resume.type = "button";
    const confirmation = document.createElement("div");
    confirmation.id = "settingsResumeConfirmation";
    confirmation.hidden = true;
    confirmation.append(node("p", "确定要恢复 Ash 吗？"));
    const yes = node("button", "确认恢复", "btn");
    yes.id = "settingsResumeYes";
    yes.type = "button";
    const no = node("button", "取消", "btn gray");
    no.type = "button";
    confirmation.append(yes, no);
    const feedback = node("p", "当前暂停状态未核实。", "muted");
    feedback.id = "settingsFeedback";
    feedback.setAttribute("role", "status");
    const run = async (word) => {
      if (this.section !== section || !this.connected || !this.allowed || !this.net.localManagement) return;
      pause.disabled = true;
      resume.disabled = true;
      yes.disabled = true;
      feedback.textContent = "等待管理回执…";
      const result = await this.net.sendAdmin(word);
      if (this.section !== section || !this.connected || !this.allowed) return;
      feedback.textContent = result.ok && result.paused === (word === "pause")
        ? word === "pause" ? "已暂停 Ash" : "已恢复 Ash"
        : "状态未确认；请检查连接后重试。";
      pause.disabled = false;
      resume.disabled = false;
      yes.disabled = false;
    };
    pause.addEventListener("click", () => { void run("pause"); });
    resume.addEventListener("click", () => { confirmation.hidden = false; });
    yes.addEventListener("click", () => { confirmation.hidden = true; void run("resume"); });
    no.addEventListener("click", () => { confirmation.hidden = true; });
    section.append(heading, pause, resume, confirmation, feedback);
    const quietSection = document.createElement("section");
    quietSection.id = "settingsQuiet";
    const quietHeading = node("h2", "免打扰时段");
    const start = document.createElement("input");
    start.id = "settingsQuietStart";
    start.type = "time";
    start.value = "21:30";
    const end = document.createElement("input");
    end.id = "settingsQuietEnd";
    end.type = "time";
    end.value = "09:00";
    const load = node("button", "读取时段", "btn gray");
    load.type = "button";
    const save = node("button", "保存时段", "btn");
    save.type = "button";
    save.id = "settingsQuietSave";
    const quietStatus = node("p", "尚未读取当前时段。", "muted");
    quietStatus.id = "settingsQuietStatus";
    quietStatus.setAttribute("role", "status");
    const requestSetting = async (word, body, to = "service:admin") => {
      const token = this.net.token, screen = this.net.screen, scope = this.net.currentScope;
      if (this.section !== section || !this.connected || !this.allowed || !this.net.localManagement || !token || !screen || !scope) return null;
      const response = await this.net.request("/api/send", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token },
        body: JSON.stringify({ to, kind: "request", word, body, wait: true, client_id: crypto.randomUUID() }) });
      if (this.section !== section || !this.connected || !this.allowed || token !== this.net.token ||
        screen !== this.net.screen || scope !== this.net.currentScope || !this.net.localManagement || !response.ok) return null;
      const accepted = await response.json();
      const reply = accepted?.reply;
      return reply?.kind === "response" && reply.reply_to === accepted.id && reply.from === to &&
        reply.to === "person:owner" && reply.word === word ? reply.body : null;
    };
    load.addEventListener("click", () => { void (async () => {
      quietStatus.textContent = "正在读取…";
      try {
        const reply = await requestSetting("settings.get", {});
        const quiet = reply?.ok === true ? reply.result?.delivery?.quiet : null;
        if (typeof quiet !== "string" || !/^\d\d:\d\d-\d\d:\d\d$/.test(quiet)) throw new Error("unavailable");
        [start.value, end.value] = quiet.split("-");
        quietStatus.textContent = "已读取当前时段。";
      } catch { if (this.section === section) quietStatus.textContent = "读取失败；请重试。"; }
    })(); });
    save.addEventListener("click", () => { void (async () => {
      quietStatus.textContent = "正在保存…";
      try {
        const quiet = `${start.value}-${end.value}`;
        if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(quiet)) throw new Error("invalid");
        const reply = await requestSetting("settings.set", { delivery: { quiet } });
        if (reply?.ok !== true || reply.result?.delivery?.quiet !== quiet) throw new Error("unconfirmed");
        quietStatus.textContent = "已保存免打扰时段。";
      } catch { if (this.section === section) quietStatus.textContent = "保存未确认；请重试。"; }
    })(); });
    quietSection.append(quietHeading, start, end, load, save, quietStatus);
    section.append(quietSection);
    const pluginsSection = document.createElement("section");
    pluginsSection.id = "settingsPlugins";
    pluginsSection.append(node("h2", "DSH 插件"));
    const pluginsLoad = node("button", "读取已安装插件", "btn gray");
    pluginsLoad.id = "settingsPluginsLoad";
    pluginsLoad.type = "button";
    const pluginsStatus = node("p", "尚未读取插件。", "muted");
    pluginsStatus.id = "settingsPluginsStatus";
    pluginsStatus.setAttribute("role", "status");
    const pluginsList = document.createElement("div");
    pluginsList.id = "settingsPluginsList";
    const readPlugins = async () => {
      pluginsStatus.textContent = "正在读取…";
      const reply = await requestSetting("plugins.list", {});
      const plugins = reply?.ok === true ? reply.result?.plugins : null;
      if (!Array.isArray(plugins)) throw new Error("plugins unavailable");
      pluginsList.replaceChildren();
      for (const plugin of plugins) {
        if (typeof plugin.entryId !== "string" || typeof plugin.moduleName !== "string") continue;
        const row = document.createElement("div");
        row.className = "settings-plugin";
        row.setAttribute("data-plugin-id", plugin.entryId);
        row.append(node("span", `${plugin.moduleName} · ${plugin.enabled ? "已启用" : "已停用"}`));
        if (!plugin.readOnlyReason) {
          const toggle = node("button", plugin.enabled ? "停用" : "启用", "btn gray");
          toggle.type = "button";
          toggle.addEventListener("click", () => { void (async () => {
            toggle.disabled = true;
            pluginsStatus.textContent = "正在保存…";
            try {
              const result = await requestSetting("plugins.op", { op: "plugin", id: plugin.entryId, enabled: !plugin.enabled });
              if (result?.ok !== true || !["applied", "restart-required"].includes(result.result?.application)) throw new Error("operation failed");
              await readPlugins();
              pluginsStatus.textContent = result.result.application === "restart-required" ? "已保存；重启 Ash 后生效。" : "已更新插件。";
            } catch { if (this.section === section) pluginsStatus.textContent = "插件更新未确认；请重试。"; }
            finally { toggle.disabled = false; }
          })(); });
          row.append(toggle);
        }
        pluginsList.append(row);
      }
      pluginsStatus.textContent = `已读取 ${plugins.length} 个插件。`;
    };
    pluginsLoad.addEventListener("click", () => { void readPlugins().catch(() => {
      if (this.section === section) pluginsStatus.textContent = "读取失败；请重试。";
    }); });
    pluginsSection.append(pluginsLoad, pluginsStatus, pluginsList);
    section.append(pluginsSection);
    const modelSection = document.createElement("section");
    modelSection.id = "settingsModel";
    modelSection.append(node("h2", "主模型"));
    const provider = document.createElement("input");
    provider.id = "settingsModelProvider";
    provider.placeholder = "Provider";
    const model = document.createElement("input");
    model.id = "settingsModelName";
    model.placeholder = "Model";
    const modelLoad = node("button", "读取模型", "btn gray");
    modelLoad.type = "button";
    const modelSave = node("button", "保存模型", "btn");
    modelSave.id = "settingsModelSave";
    modelSave.type = "button";
    const modelStatus = node("p", "尚未读取主模型。", "muted");
    modelStatus.id = "settingsModelStatus";
    modelStatus.setAttribute("role", "status");
    modelLoad.addEventListener("click", () => { void (async () => {
      modelStatus.textContent = "正在读取…";
      try {
        const reply = await requestSetting("settings.get", {});
        const selection = reply?.ok === true ? reply.result?.model : null;
        if (typeof selection?.provider !== "string" || typeof selection?.model !== "string") throw new Error("unavailable");
        provider.value = selection.provider;
        model.value = selection.model;
        modelStatus.textContent = "已读取当前模型。";
      } catch { if (this.section === section) modelStatus.textContent = "读取失败；请重试。"; }
    })(); });
    modelSave.addEventListener("click", () => { void (async () => {
      modelStatus.textContent = "正在保存…";
      try {
        const requested = { provider: provider.value.trim(), model: model.value.trim() };
        if (!requested.provider || !requested.model) throw new Error("invalid");
        const reply = await requestSetting("model.set", requested);
        if (reply?.ok !== true || reply.result?.provider !== requested.provider || reply.result?.model !== requested.model ||
          reply.result?.restart_required !== true) throw new Error("unconfirmed");
        modelStatus.textContent = "已保存；重启 Ash 后主模型生效。";
      } catch { if (this.section === section) modelStatus.textContent = "保存未确认；请重试。"; }
    })(); });
    modelSection.append(provider, model, modelLoad, modelSave, modelStatus);
    section.append(modelSection);
    const usageSection = document.createElement("section");
    usageSection.id = "settingsUsage";
    usageSection.append(node("h2", "用量"));
    const usageTable = document.createElement("div");
    usageTable.id = "settingsUsageTable";
    const balanceLine = node("p", "", "muted");
    balanceLine.id = "settingsUsageBalance";
    const usageStatus = node("p", "点「查看用量」读取。", "muted");
    usageStatus.id = "settingsUsageStatus";
    usageStatus.setAttribute("role", "status");
    const usageRefresh = node("button", "查看用量", "btn gray");
    usageRefresh.id = "settingsUsageRefresh";
    usageRefresh.type = "button";
    usageRefresh.addEventListener("click", () => { void refreshUsage(); });
    usageSection.append(usageTable, balanceLine, usageStatus, usageRefresh);
    section.append(usageSection);
    const refreshUsage = async () => {
      usageStatus.textContent = "正在读取…";
      usageRefresh.textContent = "刷新";
      try {
        const reply = await requestSetting("usage.get", { days: 7 }, "service:cost");
        if (reply?.ok !== true) throw new Error("unavailable");
        if (this.section !== section) return;
        usageTable.replaceChildren(...renderUsage(reply.result));
        usageStatus.textContent = reply.result.estimated ? "金额按模型目录价估算，不是账单。" : "";
      } catch { if (this.section === section) usageStatus.textContent = "用量读取失败；请重试。"; return; }
      try {
        const reply = await requestSetting("balance.get", {}, "service:cost");
        if (this.section !== section) return;
        balanceLine.textContent = reply?.ok === true
          ? `账户余额：${reply.result.balances.map((b) => `${b.total} ${b.currency}`).join("，") || "无数据"}${reply.result.available ? "" : "（账户当前不可用）"}`
          : "账户余额暂时读不到（不是零）。";
      } catch { if (this.section === section) balanceLine.textContent = "账户余额暂时读不到（不是零）。"; }
    };
    if (globalThis.location?.origin === "https://appassets.androidplatform.net" && typeof globalThis.__ashJevKey === "function") {
      const jevSection = document.createElement("section");
      jevSection.id = "settingsJev";
      jevSection.append(node("h2", "JEV Key"));
      const key = document.createElement("input");
      key.id = "settingsJevKey";
      key.type = "password";
      key.placeholder = "输入新 Key；留空并保存可移除";
      key.autocomplete = "off";
      const statusButton = node("button", "检查状态", "btn gray");
      statusButton.type = "button";
      const saveKey = node("button", "保存 Key", "btn");
      saveKey.type = "button";
      const jevStatus = node("p", "Key 仅保存在本机；保存后 Ash 自动重启。", "muted");
      jevStatus.id = "settingsJevStatus";
      jevStatus.setAttribute("role", "status");
      statusButton.addEventListener("click", () => { void (async () => {
        try {
          const result = await globalThis.__ashJevKey("status");
          if (this.section === section) jevStatus.textContent = result.ok
            ? result.configured ? "JEV Key 已设置。" : "JEV Key 未设置；目前只使用关键词判断。"
            : "状态读取失败。";
        } catch { if (this.section === section) jevStatus.textContent = "状态读取失败。"; }
      })(); });
      saveKey.addEventListener("click", () => { void (async () => {
        const value = key.value.trim();
        key.value = "";
        saveKey.disabled = true;
        jevStatus.textContent = "正在保存…";
        try {
          const result = await globalThis.__ashJevKey("save", value);
          if (this.section === section) jevStatus.textContent = result.ok
            ? result.configured ? "已保存；Ash 正在重启以启用 JEV。" : "Key 已移除；Ash 正在重启。"
            : "保存失败；请重试。";
        } catch { if (this.section === section) jevStatus.textContent = "保存失败；请重试。"; }
        finally { saveKey.disabled = false; }
      })(); });
      jevSection.append(key, statusButton, saveKey, jevStatus);
      section.append(jevSection);
    }
    if (globalThis.location?.origin === "https://appassets.androidplatform.net" && typeof globalThis.__ashBrowserLogins === "function") {
      const browserSection = document.createElement("section");
      browserSection.id = "settingsBrowser";
      browserSection.append(node("h2", "Ash 的浏览器"));
      const clear = node("button", "清除浏览器里的所有登录", "btn gray");
      clear.id = "settingsBrowserClear";
      clear.type = "button";
      const browserStatus = node("p", "浏览器里登录过的网站只保存在这台手机上；清除后她需要你重新登录。", "muted");
      browserStatus.id = "settingsBrowserStatus";
      browserStatus.setAttribute("role", "status");
      let armed = false;
      clear.addEventListener("click", () => { void (async () => {
        // One accidental tap must not wipe logins: the first tap asks, the second confirms.
        if (!armed) { armed = true; clear.textContent = "再点一次确认清除"; browserStatus.textContent = "会清掉所有网站的登录，并关闭浏览器。"; return; }
        armed = false; clear.textContent = "清除浏览器里的所有登录"; clear.disabled = true;
        browserStatus.textContent = "正在清除…";
        try {
          const result = await globalThis.__ashBrowserLogins();
          if (this.section === section) browserStatus.textContent = result.ok ? "已清除所有登录。" : "清除失败；请重试。";
        } catch { if (this.section === section) browserStatus.textContent = "清除失败；请重试。"; }
        finally { clear.disabled = false; }
      })(); });
      browserSection.append(clear, browserStatus);
      section.append(browserSection);
    }
    const gatewaySection = document.createElement("section");
    gatewaySection.id = "settingsGateway";
    gatewaySection.append(node("h2", "已连接设备"));
    if (globalThis.location?.origin === "https://appassets.androidplatform.net" && typeof globalThis.__ashGatewayConfig === "function") {
      const url = document.createElement("input");
      url.id = "settingsGatewayUrl";
      url.type = "url";
      url.placeholder = "https://你的网关域名";
      const secret = document.createElement("input");
      secret.id = "settingsGatewaySecret";
      secret.type = "password";
      secret.placeholder = "首次认领的一次性密钥；已认领可留空";
      secret.autocomplete = "off";
      const loadConfig = node("button", "读取配置", "btn gray");
      loadConfig.type = "button";
      const saveConfig = node("button", "保存网关", "btn");
      saveConfig.id = "settingsGatewaySave";
      saveConfig.type = "button";
      const configStatus = node("p", "域名与一次性密钥只在本机设置；保存后 Ash 重启。", "muted");
      configStatus.id = "settingsGatewayConfigStatus";
      configStatus.setAttribute("role", "status");
      loadConfig.addEventListener("click", () => { void (async () => {
        try {
          const result = await globalThis.__ashGatewayConfig("status");
          if (this.section !== section) return;
          if (!result.ok) throw new Error("unavailable");
          url.value = result.url;
          configStatus.textContent = result.configured ? "当前网关：" + result.url : "网关尚未配置。";
        } catch { if (this.section === section) configStatus.textContent = "配置读取失败。"; }
      })(); });
      saveConfig.addEventListener("click", () => { void (async () => {
        const enteredUrl = url.value.trim();
        const enteredSecret = secret.value.trim();
        secret.value = "";
        saveConfig.disabled = true;
        configStatus.textContent = "正在保存…";
        try {
          const result = await globalThis.__ashGatewayConfig("save", enteredUrl, enteredSecret);
          if (this.section !== section) return;
          if (!result.ok) throw new Error("unconfirmed");
          url.value = result.url;
          configStatus.textContent = result.configured ? "网关已保存；Ash 正在重启。" : "网关已移除；Ash 正在重启。";
        } catch { if (this.section === section) configStatus.textContent = "保存失败；请检查域名与密钥。"; }
        finally { saveConfig.disabled = false; }
      })(); });
      gatewaySection.append(url, secret, loadConfig, saveConfig, configStatus);
    }
    const pairCode = node("button", "生成配对码", "btn gray");
    pairCode.id = "settingsGatewayPair";
    pairCode.type = "button";
    const pairResult = node("p", "", "muted");
    pairResult.id = "settingsGatewayPairResult";
    pairResult.setAttribute("role", "status");
    pairCode.addEventListener("click", () => { void (async () => {
      pairCode.disabled = true;
      pairResult.textContent = "正在生成…";
      try {
        const reply = await requestSetting("gateway.op", { op: "ticket" });
        const ticket = reply?.ok === true ? reply.result?.ticket : null;
        if (typeof ticket !== "string" || !ticket) throw new Error("no ticket");
        const where = typeof reply.result.gateway === "string" ? reply.result.gateway : "网关地址";
        pairResult.textContent = `配对码：${ticket}（5 分钟内有效，只能用一次）。在新设备的浏览器打开 ${where}，粘贴配对码，再回到这里点“批准连接”。`;
      } catch { if (this.section === section) pairResult.textContent = "生成失败：网关可能离线，请稍后重试。"; }
      finally { pairCode.disabled = false; }
    })(); });
    const gatewayLoad = node("button", "读取设备", "btn gray");
    gatewayLoad.id = "settingsGatewayLoad";
    gatewayLoad.type = "button";
    const gatewayStatus = node("p", "尚未读取网关。", "muted");
    gatewayStatus.id = "settingsGatewayStatus";
    gatewayStatus.setAttribute("role", "status");
    const gatewayList = document.createElement("div");
    gatewayList.id = "settingsGatewayList";
    const refreshGateway = async () => {
      gatewayStatus.textContent = "正在读取…";
      const reply = await requestSetting("gateway.state", {});
      if (reply?.ok !== true) throw new Error("gateway unavailable");
      const state = reply.result;
      gatewayList.replaceChildren();
      if (state?.configured !== true) { gatewayStatus.textContent = "网关尚未配置。"; return; }
      gatewayStatus.textContent = state.connected ? "网关已连接。" : "网关暂时离线。";
      const act = async (body) => {
        const result = await requestSetting("gateway.op", body);
        if (result?.ok !== true) throw new Error("gateway operation failed");
        await refreshGateway();
      };
      for (const pending of Array.isArray(state.pending) ? state.pending : []) {
        if (typeof pending.request_id !== "string" || typeof pending.name !== "string") continue;
        const row = document.createElement("div");
        row.className = "settings-plugin";
        row.append(node("span", `${pending.name} · 待配对 · ${pending.fingerprint ?? ""}`));
        for (const [label, body] of [
          ["批准连接（聊天、网页、设备能力）", { op: "approve", request_id: pending.request_id, permissions: ["chat", "web_ui", "expose_capability"] }],
          ["拒绝", { op: "reject", request_id: pending.request_id }],
        ]) {
          const button = node("button", label, "btn gray");
          button.type = "button";
          button.addEventListener("click", () => { void act(body).catch(() => {
            if (this.section === section) gatewayStatus.textContent = "操作未确认；请重试。";
          }); });
          row.append(button);
        }
        gatewayList.append(row);
      }
      for (const device of Array.isArray(state.devices) ? state.devices : []) {
        if (typeof device.id !== "string" || typeof device.name !== "string") continue;
        const row = document.createElement("div");
        row.className = "settings-plugin";
        const lends = device.lends === true;
        const kind = lends ? `电脑 · ${Number(device.capabilities) || 0} 个能力` : "浏览器";
        row.append(node("span", `${device.name} · ${kind} · ${device.online ? "在线" : "离线"}`));
        const revoke = node("button", "撤销设备", "btn gray");
        revoke.type = "button";
        revoke.addEventListener("click", () => { void act({ op: "revoke", device: device.id }).catch(() => {
          if (this.section === section) gatewayStatus.textContent = "撤销未确认；请重试。";
        }); });
        row.append(revoke);
        gatewayList.append(row);
      }
    };
    gatewayLoad.addEventListener("click", () => { void refreshGateway().catch(() => {
      if (this.section === section) gatewayStatus.textContent = "读取失败；请重试。";
    }); });
    gatewaySection.append(pairCode, pairResult, gatewayLoad, gatewayStatus, gatewayList);
    section.append(gatewaySection);
    const preferencesRoot = document.createElement("section");
    preferencesRoot.id = "settingsProactive";
    section.append(preferencesRoot);
    this.panel.append(section);
    this.section = section;
    this.sectionContext = context;
    this.preferences = new ProactivePreferences(preferencesRoot, this.net,
      () => this.section === section && this.connected && this.allowed);
  }
}
