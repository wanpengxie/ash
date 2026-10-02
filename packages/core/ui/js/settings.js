import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
import { ProactivePreferences } from "./settings-preferences.js";

function node(tag, label, className = "") {
  const element = document.createElement(tag);
  element.textContent = label;
  if (className) element.className = className;
  return element;
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
    const requestSetting = async (word, body) => {
      const token = this.net.token, screen = this.net.screen, scope = this.net.currentScope;
      if (this.section !== section || !this.connected || !this.allowed || !this.net.localManagement || !token || !screen || !scope) return null;
      const response = await this.net.request("/api/send", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token },
        body: JSON.stringify({ to: "service:admin", kind: "request", word, body, wait: true, client_id: crypto.randomUUID() }) });
      if (this.section !== section || !this.connected || !this.allowed || token !== this.net.token ||
        screen !== this.net.screen || scope !== this.net.currentScope || !this.net.localManagement || !response.ok) return null;
      const accepted = await response.json();
      const reply = accepted?.reply;
      return reply?.kind === "response" && reply.reply_to === accepted.id && reply.from === "service:admin" &&
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
