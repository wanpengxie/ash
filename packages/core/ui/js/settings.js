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
import { ProactivePreferences } from "./settings-preferences.js";
