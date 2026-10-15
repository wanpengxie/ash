import { fill } from "./home-dom.js";
// 应用: a grid of the apps in her container, and one app's page: what it needs,
// what it may use, and the switches. Every action is a service:apps word, the same an agent calls.
import { appBroken, appState, appTrouble } from "./home-text.js";
import { readApps } from "./home-data.js";
import { btn, card, group, h, ico, list, note, row } from "./home-ui.js";

const clean = (value, max) => typeof value === "string" ? [...value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim()].slice(0, max).join("") : "";
const NEED_KINDS = { notify: "提醒你", widgets: "放桌面小组件", card: "在对话里放入口卡片" };
/** One thing an app needs, as the owner reads it: why, never the member or the word behind it. */
const needLine = (need) => {
  if (!need || typeof need !== "object") return "";
  const why = clean(need.why, 200);
  if (why) return why;
  if (typeof need.member === "string") return "使用她的一项能力";
  const kind = Object.keys(NEED_KINDS).find((key) => need[key] === true);
  return kind ? NEED_KINDS[kind] : "";
};
const TONES = ["you", "her", "warn", "ok"];
const tone = (id) => TONES[[...id].reduce((sum, char) => sum + char.codePointAt(0), 0) % TONES.length];
const tile = (app, className = "") => h("span", { class: `hm-apptile lic-${tone(app.id)}${app.granted === true && app.enabled !== true ? " off" : ""} ${className}` }, [...(clean(app.name, 4) || app.id)][0].toUpperCase());

export function appsPage(ctx, screen) {
  const box = h("div", { class: "hm-stack" }, note("正在读取…"));
  let apps = null;
  const draw = () => {
    if (apps === undefined) { fill(box, note("读取失败，请重试。", "warn"), btn("重试", "a-btn btn-neutral btn-sm", () => void load())); return; }
    if (!apps) return;
    if (!apps.length) { fill(box, card("hm-empty", ico("grid", "i-l c-3"), h("span", { class: "tx-headline" }, "还没有应用"), h("span", { class: "tx-sub" }, "装上应用后会出现在这里。")), btn("重新查找应用", "a-btn btn-neutral btn-block", () => void load("apps.refresh"), { id: "homeAppsRefresh" })); return; }
    // A broken app (its app.json is wrong) is not one that wants in: it stays in the grid with the error mark.
    const waiting = apps.filter((app) => app.granted !== true && !appBroken(app)).length;
    const grid = h("div", { class: "hm-appgrid", id: "homeAppsList" }, apps.map((app) => h("button", { type: "button", class: "hm-appcell", dataset: { appId: app.id }, onclick: () => ctx.go("app", app.id) },
      h("span", { class: "hm-appic" }, tile(app), appTrouble(app) ? h("span", { class: "hm-appbad", "aria-label": "出错了" }) : null),
      h("span", { class: "hm-appname" }, clean(app.name, 12) || "应用", app.granted === true && app.enabled !== true ? h("span", { class: "c-3" }, " · 停用") : null))));
    fill(box, waiting ? h("div", { class: "banner hm-bannerwarn" }, ico("shield", "i-s"), `${waiting} 个应用等你批准`) : null, grid, btn("重新查找应用", "a-btn btn-ghost btn-block", () => void load("apps.refresh"), { id: "homeAppsRefresh" }));
  };
  async function load(word = "apps.list") {
    // The system apps have native screens on the phone only: the web page lists the installed apps.
    try { apps = await readApps(screen, word); if (Array.isArray(apps)) apps = apps.filter((app) => app.kind !== "system"); } catch (error) { if (error?.code === "stale") return; apps = undefined; }
    if (apps === null) apps = undefined;
    if (screen.alive()) draw();
  }
  return { title: "应用", body: box, refresh: () => load() };
}

export function appPage(ctx, screen, id) {
  const box = h("div", { class: "hm-stack" }, note("正在读取…"));
  const state = { status: "", armed: null, busy: false };
  let app = null;
  const act = async (word, label, done, { confirm = "", warn = "" } = {}) => {
    state.busy = true; state.status = "正在处理…"; draw();
    try {
      const reply = await screen.call("service:apps", word, { id });
      if (reply?.ok !== true) throw Object.assign(new Error("not done"), { code: reply?.error?.code });
      await load(); state.status = done;
    } catch (error) {
      if (error?.code === "stale") return;
      await load().catch(() => {});
      state.status = word === "apps.enable" && error?.code === "not_found" ? `「${clean(app?.name, 40)}」的文件夹已经不在了，启用不了；可以点「收回全部权限」把它卸掉。` : `「${clean(app?.name, 40) || "这个应用"}」没有确认完成；上面是现在的状态，可以再试一次。`;
    }
    state.busy = false; state.armed = null;
    if (screen.alive()) draw();
  };
  const draw = () => {
    if (!app) return;
    const name = clean(app.name, 40) || "未命名应用";
    const granted = app.granted === true;
    const needs = (Array.isArray(app.needs) ? app.needs : []).map(needLine).filter(Boolean);
    const two = (word, label, cls, done, confirm, warn) => {
      const armed = state.armed === word;
      return btn(armed ? confirm : label, `a-btn btn-block ${armed ? "btn-danger" : cls}`, () => { if (confirm && !armed) { state.armed = word; state.status = warn; draw(); } else void act(word, label, done); }, { disabled: state.busy, dataset: { appWord: word } });
    };
    const broken = appBroken(app);
    const actions = broken && !granted ? [] : !granted ? [two("apps.install", "安装", "btn-primary", `已安装「${name}」。`, "确认安装", `安装后「${name}」可以用上面列出的这些；你随时可以停用或收回。`)]
      : [app.enabled === true ? two("apps.disable", "停用", "btn-neutral", `已停用「${name}」，它的权限还留着。`) : two("apps.enable", "启用", "btn-primary", `已启用「${name}」。`),
        two("apps.revoke", "收回全部权限", "btn-neutral", `已收回「${name}」的全部权限。`, "再点一次确认收回", `收回后「${name}」会停止运行，再用要重新安装。`)];
    const trouble = appTrouble(app);
    fill(box, h("div", { class: "hm-appdetail", dataset: { appId: app.id } }, tile(app, "big"), h("span", { class: "hm-big" }, name, app.version ? h("span", { class: "tx-caption" }, ` ${clean(app.version, 20)}`) : null),
      h("span", { class: `tx-sub${granted && app.enabled === true ? " c-ok" : " c-warn"}`, "data-app-state": "" }, appState(app)), clean(app.summary, 200) ? h("span", { class: "tx-sub" }, clean(app.summary, 200)) : null),
      broken ? null : group(granted ? "已允许它用" : "它需要", list(...(needs.length ? needs.map((line) => row({ title: line })) : [row({ title: "不需要用到她的其他东西" })]))),
      trouble ? note(`出错了：${trouble}`, "err") : null, ...actions, state.status ? h("p", { class: "hm-note", role: "status", id: "homeAppStatus" }, state.status) : null);
  };
  async function load() { const apps = await readApps(screen); app = apps?.find((item) => item.id === id) ?? null; if (screen.alive()) { if (!app) fill(box, note("没有找到这个应用。", "warn")); else draw(); } }
  return { title: "应用", body: box, refresh: () => load().catch(() => { if (screen.alive()) fill(box, note("读取失败，请重试。", "warn")); }) };
}
