// 应用: the apps in Ash's container, what each may use, and the owner's switches. Every action here is a service:apps
// word (apps.list, apps.install, apps.enable, apps.disable, apps.revoke, apps.refresh) — the same words an agent calls.
const NEED_KINDS = { notify: "提醒你", widgets: "桌面小组件", card: "在对话里放入口卡片" };

function node(tag, text = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, className = "btn gray") {
  const element = node("button", label, className);
  element.type = "button";
  return element;
}

const clean = (value, max) => typeof value === "string" ? [...value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim()].slice(0, max).join("") : "";

/** One thing an app needs from Ash, as the owner reads it: why, and what it reaches. */
export function needText(need) {
  if (!need || typeof need !== "object") return "";
  const why = clean(need.why, 200);
  if (typeof need.member === "string") {
    const words = Array.isArray(need.words) ? need.words.filter((word) => typeof word === "string").map((word) => clean(word, 64)).join("、") : "";
    return `· ${why || "使用"}（${clean(need.member, 64)}${words ? `：${words}` : ""}）`;
  }
  const kind = Object.keys(NEED_KINDS).find((key) => need[key] === true);
  return kind ? `· ${why || NEED_KINDS[kind]}（${NEED_KINDS[kind]}）` : "";
}

/** 启用 / 停用 / 未授权, and whether it is actually running. */
export function appState(app) {
  if (app.granted !== true) return "未授权";
  if (app.enabled !== true) return "已停用";
  return app.running === true ? "已启用 · 运行中" : "已启用 · 还没运行起来";
}

/** The apps page body. `request(word, body)` sends one service:apps word as the owner and returns its response body. */
export class AppsSettings {
  constructor(request, { live = () => true, onSummary = () => {}, name = "Ash" } = {}) {
    this.request = request;
    this.live = live;
    this.onSummary = onSummary;
    this.name = name;
    this.root = document.createElement("div");
    this.root.id = "settingsAppsBody";
    this.status = node("p", "", "set-status");
    this.status.id = "settingsAppsStatus";
    this.status.setAttribute("role", "status");
    this.list = document.createElement("div");
    this.list.id = "settingsAppsList";
    this.refreshButton = button("重新查找应用");
    this.refreshButton.id = "settingsAppsRefresh";
    this.refreshButton.addEventListener("click", () => { void this.load("apps.refresh"); });
    this.root.append(this.status, this.list, this.refreshButton);
  }

  /** Read the apps (apps.list, or apps.refresh to look in the apps folder again) and draw them. */
  async load(word = "apps.list") {
    this.status.textContent = word === "apps.refresh" ? "正在查找…" : "正在读取…";
    this.refreshButton.disabled = true;
    try {
      const apps = await this.read(word);
      if (!this.live()) return;
      if (!apps) { this.status.textContent = "读取失败，请重试。"; return; }
      this.draw(apps);
      this.status.textContent = apps.length ? "" : "还没有找到应用。";
    } catch { if (this.live()) this.status.textContent = "读取失败，请重试。"; }
    finally { this.refreshButton.disabled = false; }
  }

  /** Only the home row's one line. */
  async summary() {
    try { await this.read("apps.list"); } catch { /* the row keeps its default text */ }
  }

  async read(word) {
    const reply = await this.request(word, {});
    const apps = reply?.ok === true && Array.isArray(reply.result?.apps) ? reply.result.apps.filter((app) => app && typeof app.id === "string") : null;
    if (apps && this.live()) this.onSummary(apps);
    return apps;
  }

  draw(apps) {
    this.list.replaceChildren(...apps.map((app) => this.card(app)));
  }

  card(app) {
    const appName = clean(app.name, 40) || app.id;
    const card = node("div", "", "set-card set-app");
    card.setAttribute("data-app-id", app.id);
    card.append(node("span", `${appName}${app.version ? ` ${clean(app.version, 20)}` : ""}`, "set-title"));
    const state = node("span", appState(app), app.granted === true && app.enabled === true ? "set-sub" : "set-sub warn");
    state.setAttribute("data-app-state", "");
    card.append(state);
    if (clean(app.summary, 200)) card.append(node("span", clean(app.summary, 200), "set-sub"));
    const needs = (Array.isArray(app.needs) ? app.needs : []).map(needText).filter(Boolean);
    card.append(node("span", app.granted === true ? "已允许它用：" : "它需要：", "set-sub"));
    const list = node("span", needs.length ? needs.join("\n") : `· 不需要用 ${this.name} 的其他东西`, "set-sub set-app-needs");
    card.append(list);
    if (clean(app.error, 300)) card.append(node("span", `出错了：${clean(app.error, 300)}`, "set-sub warn"));
    const status = node("p", "", "set-status");
    status.setAttribute("role", "status");
    const actions = node("div", "", "set-actions");
    const buttons = [];
    const act = (word, label, done, { confirm = "", warn = "" } = {}) => {
      const control = button(label, word === "apps.revoke" ? "btn red" : word === "apps.install" ? "btn" : "btn gray");
      control.setAttribute("data-app-word", word);
      let ready = !confirm;
      control.addEventListener("click", () => { void (async () => {
        if (control.disabled) return;
        // Taking something away, or giving an app new reach, takes a second tap that says exactly what will happen.
        if (!ready) { ready = true; control.textContent = confirm; status.textContent = warn; return; }
        ready = !confirm;
        control.textContent = label;
        for (const item of buttons) item.disabled = true;
        status.textContent = "正在处理…";
        try {
          const reply = await this.request(word, { id: app.id });
          if (!this.live()) return;
          if (reply?.ok !== true) throw new Error("not done");
          await this.load();
          this.status.textContent = done;
        } catch {
          if (!this.live()) return;
          // The word may still have run (a slow start, a lost answer): show what is true now rather than guess.
          for (const item of buttons) item.disabled = false;
          await this.load().catch(() => {});
          if (this.live()) this.status.textContent = `「${appName}」没有确认完成；上面是现在的状态，可以再试一次。`;
        }
      })(); });
      buttons.push(control);
      actions.append(control);
    };
    if (app.granted !== true) {
      act("apps.install", "安装", `已安装「${appName}」。`, { confirm: "确认安装",
        warn: `安装后「${appName}」可以用上面列出的这些；你随时可以停用或收回。` });
    } else {
      if (app.enabled === true) act("apps.disable", "停用", `已停用「${appName}」，它的权限还留着。`);
      else act("apps.enable", "启用", `已启用「${appName}」。`);
      act("apps.revoke", "收回全部权限", `已收回「${appName}」的全部权限。`, { confirm: "再点一次确认收回",
        warn: `收回后「${appName}」会停止运行，再用要重新安装。` });
    }
    card.append(actions, status);
    return card;
  }
}

/** The home row's line: how many apps, how many on. */
export function appsSummary(apps) {
  if (!apps.length) return "还没有应用";
  const on = apps.filter((app) => app.granted === true && app.enabled === true).length;
  return `${apps.length} 个应用 · ${on ? `${on} 个已启用` : "都没启用"}`;
}
