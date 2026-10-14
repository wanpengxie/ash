import { fill } from "./home-dom.js";
// 幕后: what runs her. Keys (and whether they work), the model, what she costs, and the developer options. The spending card
// is the same on the page and on 花了多少.
import { HELPER, KEYS, balanceSentence, keyProblems, keyStateText, pluginName, providerName, vaultLine } from "./home-text.js";
import { readAgents, readUsage, settled } from "./home-data.js";
import { pauseControl } from "./home-pause.js";
import { btn, card, group, h, list, localHint, note, row, skeleton, tag, twoTap } from "./home-ui.js";
import { switchRow } from "./home-switch.js";
import { balanceText, usdToCnyText as money, CNY_ESTIMATE_NOTE } from "./money.js";

const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
/** Who made a call, in words: an agent by its name, the quick judge, any other service as "后台服务". */
const callerName = (names, caller) => names[caller] ?? (caller === "service:reflex" ? "快速判断" : caller.startsWith("service:") ? "后台服务" : HELPER);
const KEY_COPY = { deepseek: ["DeepSeek Key", "跟你对话用", "没有它，她没法跟你说话。"], openrouter: ["OpenRouter Key", "快速判断要不要问你", "没有它，快速判断只能靠关键词。"] };

/** The spending card: the last seven days as a number and as bars, and what today and the balance are. */
function spendCard(usage, balance) {
  const week = usage?.periods?.["7d"]?.cost_usd;
  const days = (Array.isArray(usage?.by_day) ? usage.by_day : []).slice(-7).map((day) => num(day.cost_usd));
  const peak = Math.max(...days, 0.000001);
  let balanceLine = "";
  for (const entry of Array.isArray(balance?.balances) ? balance.balances : []) {
    const item = entry?.balance?.balances?.[0];
    if (item && entry.balance.available !== false) { balanceLine = ` · 余额 ${balanceText(item)}`; break; }
  }
  return card("hm-spend", h("div", { class: "hm-spend-t" }, h("span", { class: "tx-caption" }, "近 7 天花了"), h("span", { class: "tx-num hm-spend-n" }, typeof week === "number" ? money(week) : "—"),
    h("span", { class: "tx-caption" }, `今天 ${typeof usage?.periods?.today?.cost_usd === "number" ? money(usage.periods.today.cost_usd) : "—"}${balanceLine}`)),
    days.length ? h("div", { class: "hm-bars", "aria-hidden": "true" }, days.map((cost, index) => h("span", { class: `hm-bar${index === days.length - 1 ? " last" : ""}`, style: `height:${Math.max(6, Math.round(cost / peak * 100))}%` }))) : null);
}

export function backstagePage(ctx, screen) {
  const spendBox = h("div"), keysBox = h("div"), advancedBox = h("div");
  const state = { usage: null, balance: null, vault: null, health: [], agents: null };
  const pause = pauseControl(ctx, screen, "btn-danger btn-block");
  const draw = () => {
    fill(spendBox, h("button", { type: "button", class: "hm-cardbtn", onclick: () => ctx.go("usage") }, spendCard(state.usage, state.balance)));
    const saved = (ref) => state.vault?.find((entry) => entry.ref === ref)?.configured === true;
    const standing = (provider) => state.health.find((item) => item?.provider === provider);
    const rows = KEYS.map(({ ref, provider }) => {
      const [title, use] = KEY_COPY[provider];
      const health = standing(provider);
      const bad = saved(ref) && (health?.status === "rejected" || health?.status === "low_balance");
      return row({ icon: "key", title, sub: use, right: state.vault === null ? null : tag(bad ? (health.status === "rejected" ? "已失效" : "余额不足") : saved(ref) ? "已保存" : "还没保存", bad || !saved(ref) ? "warn" : "ok"), onClick: () => ctx.go("keys") });
    });
    const model = state.agents?.find((agent) => agent.primary === true)?.runtime?.model;
    fill(keysBox, group("让她能说话", list(...rows, row({ icon: "cpu", title: "模型", value: model ? providerName(model) : saved("DEEPSEEK_API_KEY") ? "DeepSeek" : "", onClick: () => ctx.go("model") }))));
    fill(advancedBox, group("高级", list(row({ icon: "slider", title: "开发者选项", sub: "主模型、插件", onClick: () => ctx.go("advanced") }))));
  };
  draw();
  const refresh = async () => {
    const [usage, balance, vault, keys, agents] = await Promise.all([settled(readUsage(screen)), settled(screen.ask("service:cost", "balance.get", {})), settled(screen.ask("service:vault", "list", {})), settled(screen.ask("service:llm", "keys.status", {})), settled(readAgents(screen))]);
    if (!screen.alive()) return;
    if (usage) state.usage = usage;
    if (balance) state.balance = balance;
    if (vault) state.vault = Array.isArray(vault.entries) ? vault.entries : null;
    if (Array.isArray(keys?.keys)) state.health = keys.keys;
    if (agents) state.agents = agents;
    draw();
    void pause.refresh();
  };
  return { title: "幕后", body: h("div", { class: "hm-stack" }, localHint(ctx), spendBox, keysBox, advancedBox, pause.root), refresh };
}

/** 花了多少: today, seven days and thirty days, and where the last week went. */
export function usagePage(ctx, screen) {
  const box = h("div", { class: "hm-stack" }, skeleton(3));
  const state = { usage: null, balance: undefined, agents: [], status: "正在读取…" };
  const draw = () => {
    const zero = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0 };
    const usage = state.usage;
    if (!usage) { fill(box, note(state.status, state.status.includes("失败") ? "warn" : ""), btn("重试", "a-btn btn-neutral btn-sm", () => void refresh())); return; }
    const period = (key) => ({ ...zero, ...(usage.periods?.[key] ?? {}) });
    const line = (title, totals) => row({ title, sub: `${num(totals.calls)} 次调用 · 输入 ${tokens(num(totals.input_tokens))} / 输出 ${tokens(num(totals.output_tokens))}${totals.unpriced_calls ? ` · 另有 ${totals.unpriced_calls} 次没有价格` : ""}`, value: money(totals.cost_usd) });
    const names = Object.fromEntries(state.agents.map((agent) => [agent.id, agent.name]));
    const callers = (Array.isArray(usage.by_caller) ? usage.by_caller : []).map((entry) => ({ ...zero, ...entry })).filter((entry) => typeof entry.caller === "string");
    fill(box, spendCard(usage, state.balance), group("", list(line("今天", period("today")), line("近 7 天", period("7d")), line("近 30 天", period("30d")))),
      callers.length ? group("近 7 天花在哪", list(...callers.map((entry) => line(callerName(names, entry.caller), entry)))) : null,
      state.balance === undefined ? null : note(state.balance === null ? "账户余额暂时读不到（不是零）。" : balanceSentence(state.balance)), note(`${usage.estimated ? "费用按模型的公开价格估算。" : ""}${CNY_ESTIMATE_NOTE}`),
      btn("刷新", "a-btn btn-neutral btn-block", () => void refresh(), { id: "homeUsageRefresh" }));
  };
  async function refresh() {
    state.status = "正在读取…";
    try { state.usage = await readUsage(screen); } catch (error) { if (error?.code === "stale") return; state.usage = null; state.status = "用量读取失败，请重试。"; draw(); return; }
    draw();
    const [balance, agents] = await Promise.all([screen.ask("service:cost", "balance.get", {}).catch(() => null), settled(readAgents(screen))]);
    if (!screen.alive()) return;
    state.balance = balance; state.agents = agents ?? []; draw();
  }
  return { title: "花了多少", body: box, refresh };
}

/** Keys: saved on this phone; the page learns whether one is saved and works, never what it is. */
export function keysPage(ctx, screen) {
  const name = ctx.name;
  const box = h("div", { class: "hm-stack" }, skeleton(2));
  const state = { vault: null, locked: false, health: [], checking: new Set(), status: {} };
  const learn = (keys) => { if (Array.isArray(keys)) state.health = keys; };
  const problems = h("pre", { class: "hm-pre c-warn", hidden: true, id: "homeKeyProblems" });
  const cards = new Map();

  const saved = (ref) => state.vault?.find((entry) => entry.ref === ref)?.configured === true;
  const verify = async (key) => {
    state.checking.add(key.ref); paint(key);
    try { learn((await screen.ask("service:llm", "keys.check", { provider: key.provider })).keys); }
    catch { if (screen.alive()) learn([...state.health.filter((item) => item?.provider !== key.provider), { provider: key.provider, ref: key.ref, configured: true, status: "unknown", reason: "没能问到服务商" }]); }
    finally { state.checking.delete(key.ref); if (screen.alive()) paintAll(); }
  };
  const failure = (key, error, text) => { if (!screen.alive() || error?.code === "stale") return; if (error?.code === "unavailable") { state.locked = true; paintAll(); } else { state.status[key.ref] = text; paint(key); } };

  const build = (key) => {
    const [title, use, hint] = KEY_COPY[key.provider];
    const field = h("input", { type: "password", autocomplete: "off", placeholder: "粘贴 Key", id: `homeKey_${key.ref}_value`, "aria-label": `${title}` });
    const status = h("p", { class: "hm-note", role: "status", id: `homeKey_${key.ref}_status` });
    const remove = h("button", { type: "button", class: "a-btn btn-neutral btn-sm", id: `homeKey_${key.ref}_remove` });
    const save = btn("保存", "a-btn btn-primary btn-sm", async () => {
      const value = field.value.trim();
      field.value = "";
      if (!value) { state.status[key.ref] = "请先粘贴 Key。"; paint(key); return; }
      save.disabled = true; state.status[key.ref] = "正在保存…"; paint(key);
      try {
        const result = await screen.ask("service:vault", "set", { ref: key.ref, value, label: key.title, kind: "key" });
        if (!screen.alive()) return;
        if (result.configured === true) {
          state.vault = [...(state.vault ?? []).filter((entry) => entry.ref !== key.ref), { ref: key.ref, configured: true }];
          state.health = state.health.filter((item) => item?.provider !== key.provider);
          state.status[key.ref] = ""; paint(key);
          await verify(key);
        } else { state.status[key.ref] = "保存失败，请重试。"; paint(key); }
      } catch (error) { failure(key, error, "保存失败，请重试。"); }
      finally { save.disabled = false; }
    }, { id: `homeKey_${key.ref}_save` });
    const check = btn("验证", "a-btn btn-neutral btn-sm", () => void verify(key), { id: `homeKey_${key.ref}_check` });
    twoTap(remove, { label: "移除", confirm: "确定移除？", warn: `移除后，${hint.replace(/^没有它，/, "")}`, onWarn: (text) => { state.status[key.ref] = text; paintStatus(key); }, run: async () => {
      remove.disabled = true;
      try {
        const removed = await screen.ask("service:vault", "delete", { ref: key.ref });
        if (!screen.alive()) return;
        if (removed.deleted === true) { state.vault = (state.vault ?? []).map((entry) => entry.ref === key.ref ? { ...entry, configured: false } : entry); state.health = state.health.filter((item) => item?.provider !== key.provider); state.status[key.ref] = ""; paintAll(); }
        else { state.status[key.ref] = "移除失败，请重试。"; paint(key); }
      } catch (error) { failure(key, error, "移除失败，请重试。"); }
      finally { remove.disabled = false; }
    } });
    const el = card("hm-promise", h("span", { class: "hm-big", id: `homeKey_${key.ref}` }, title), h("span", { class: "tx-sub" }, `用于：${use}`), status, field, h("div", { class: "hm-actions" }, save, check, remove));
    el.dataset.ref = key.ref;
    cards.set(key.ref, { el, status, field, check, remove, save });
    return el;
  };
  const paintStatus = (key) => {
    const view = cards.get(key.ref);
    if (!view) return;
    const health = state.health.find((item) => item?.provider === key.provider);
    const isSaved = saved(key.ref);
    const text = state.status[key.ref] || (state.locked ? "手机安全存储暂时不可用。原有密钥未被读取或修改，请重启手机后再试。" : !state.vault ? "正在读取…" : !isSaved ? `还没有保存。${KEY_COPY[key.provider][2]}` : state.checking.has(key.ref) ? "已保存，正在验证…" : keyStateText(health));
    view.status.textContent = text;
    const bad = state.locked || (state.vault && !isSaved) || health?.status === "rejected" || health?.status === "low_balance";
    view.status.className = `hm-note${bad ? " c-warn" : health?.status === "ok" ? " c-ok" : ""}`;
  };
  const paint = (key) => {
    const view = cards.get(key.ref);
    if (!view) return;
    const isSaved = saved(key.ref);
    view.field.disabled = view.save.disabled = state.locked;
    view.field.placeholder = isSaved ? "粘贴新的 Key 替换" : "粘贴 Key";
    view.check.hidden = view.remove.hidden = !isSaved || state.locked;
    paintStatus(key);
  };
  const paintAll = () => {
    for (const key of KEYS) paint(key);
    const found = keyProblems(state.health);
    problems.hidden = !found.length;
    problems.textContent = found.length ? ["发现这些问题：", ...found.map((line) => `· ${line}`)].join("\n") : "";
  };
  // Everything else the hub keeps: what she asked for (waiting, first), the hub's connections, keys she stored, keys of yours.
  const others = h("div", { class: "hm-stack", id: "homeKeysOthers" });
  const otherStatus = {};
  const paintOthers = () => {
    const known = new Set(KEYS.map((key) => key.ref));
    const list = (state.vault ?? []).filter((entry) => !known.has(entry.ref)).sort((a, b) => (a.status === "waiting" ? 0 : 1) - (b.status === "waiting" ? 0 : 1));
    if (!list.length) { fill(others); return; }
    fill(others, h("span", { class: "tx-sub hm-backttl" }, "连接与其他密钥"), ...list.map((entry) => {
      const fillable = (entry.kind === "key" || entry.kind === "password") && (entry.status === "waiting" || entry.status === "broken");
      const field = fillable ? h("input", { type: "password", autocomplete: "off", placeholder: entry.kind === "password" ? "输入密码" : "粘贴密钥", id: `homeKey_${entry.ref}_value`, "aria-label": entry.label }) : null;
      const status = h("p", { class: "hm-note", role: "status" }, otherStatus[entry.ref] ?? "");
      const save = fillable ? btn("保存", "a-btn btn-primary btn-sm", async () => {
        const value = field.value.trim();
        field.value = "";
        if (!value) { status.textContent = "请先填上。"; return; }
        status.textContent = "正在保存…";
        try { await screen.ask("service:vault", "set", { ref: entry.ref, value, label: entry.label || entry.ref, kind: entry.kind }); otherStatus[entry.ref] = "已保存，她会收到通知。"; }
        catch { otherStatus[entry.ref] = "保存失败，请重试。"; }
        if (screen.alive()) await refresh();
      }, { id: `homeKey_${entry.ref}_save` }) : null;
      const help = typeof entry.help_url === "string" && entry.help_url.startsWith("https://") ? h("a", { class: "a-btn btn-neutral btn-sm", href: entry.help_url, target: "_blank", rel: "noopener" }, "去哪拿") : null;
      const remove = h("button", { type: "button", class: "a-btn btn-neutral btn-sm", id: `homeKey_${entry.ref}_remove` });
      const gone = entry.kind === "oauth" ? "断开" : "删除";
      twoTap(remove, { label: gone, confirm: `确定${gone}？`, onWarn: (text) => { status.textContent = text; }, run: async () => {
        try { await screen.ask("service:vault", "delete", { ref: entry.ref }); otherStatus[entry.ref] = ""; } catch { otherStatus[entry.ref] = "没删掉，请重试。"; }
        if (screen.alive()) await refresh();
      } });
      return card("hm-promise", h("span", { class: "hm-big" }, entry.label || entry.ref), h("span", { class: "tx-sub" }, vaultLine(entry)),
        entry.why ? h("span", { class: "tx-caption" }, `她要它来：${entry.why}`) : null, status, field, h("div", { class: "hm-actions" }, save, help, remove));
    }));
  };
  fill(box, localHint(ctx), note(`Key 只保存在这台手机上。她知道存了哪几个，但看不到内容，Key 也不会出现在聊天里。保存后立刻生效。`), problems, ...KEYS.map(build), others);
  paintAll();
  const refresh = async () => {
    try {
      const [vault, keys] = await Promise.all([screen.ask("service:vault", "list", {}).then((data) => ({ available: true, entries: Array.isArray(data.entries) ? data.entries : [] }), (error) => { if (error?.code === "unavailable") return { available: false, entries: [] }; throw error; }),
        screen.ask("service:llm", "keys.status", {}).then((data) => Array.isArray(data.keys) ? data.keys : [], () => [])]);
      if (!screen.alive()) return;
      state.locked = !vault.available; state.vault = vault.entries; state.health = keys; paintAll(); paintOthers();
      for (const key of KEYS) { const health = state.health.find((item) => item?.ref === key.ref); if (saved(key.ref) && health?.configured === true && health.status === "unknown" && health.checked_at === undefined) void verify(key); }
    } catch (error) { if (screen.alive() && error?.code !== "stale") for (const key of KEYS) { state.status[key.ref] = "读取失败，请重试。"; paint(key); } }
  };
  return { title: "密钥", body: box, refresh };
}

/** The main model: what she runs now, and a place to change it. */
export function modelPage(ctx, screen) {
  const provider = h("input", { type: "text", id: "homeModelProvider", placeholder: "Provider（比如 deepseek）", "aria-label": "Provider" });
  const model = h("input", { type: "text", id: "homeModelName", placeholder: "Model", "aria-label": "Model" });
  const status = h("p", { class: "hm-note", id: "homeModelStatus", role: "status" });
  const controls = [provider, model];
  const save = btn("保存模型", "a-btn btn-primary btn-block", async () => {
    status.textContent = "正在保存…";
    try {
      const requested = { provider: provider.value.trim(), model: model.value.trim() };
      if (!requested.provider || !requested.model) { status.textContent = "Provider 和 Model 都要填。"; return; }
      const reply = await screen.ask("service:admin", "model.set", requested);
      if (reply.provider !== requested.provider || reply.model !== requested.model || typeof reply.restart_required !== "boolean") throw new Error("unconfirmed");
      if (screen.alive()) status.textContent = reply.restart_required ? "已保存；重启后主模型生效。" : "已保存，下一条消息起就用它。";
    } catch (error) { if (screen.alive() && error?.code !== "stale") status.textContent = "保存未确认，请重试。"; }
  }, { id: "homeModelSave" });
  const refresh = async () => {
    status.textContent = "正在读取…"; for (const control of [...controls, save]) control.disabled = true;
    try {
      const runtime = (await readAgents(screen)).find((agent) => agent.primary === true)?.runtime;
      if (!screen.alive()) return;
      model.value = typeof runtime?.model === "string" ? runtime.model : "";
      status.textContent = model.value ? "" : "没有读到现在用的模型，请直接填写。";
    } catch (error) { if (screen.alive() && error?.code !== "stale") status.textContent = "读取失败，请返回后重试。"; }
    finally { for (const control of [...controls, save]) control.disabled = false; }
  };
  return { title: "模型", body: h("div", { class: "hm-stack" }, note(`她现在用的主模型。改错了可能让她无法正常工作。`), card("hm-promise", provider, model), save, status), refresh };
}

/** 开发者选项: the main model and the extensions (plugins) she runs with. */
export function advancedPage(ctx, screen) {
  const status = h("p", { class: "hm-note", id: "homePluginsStatus", role: "status" });
  const listBox = h("div");
  const read = async () => {
    status.textContent = "正在读取…";
    const { plugins } = await screen.ask("service:admin", "plugins.list", {});
    if (!Array.isArray(plugins)) throw new Error("plugins unavailable");
    if (!screen.alive()) return;
    const rows = [];
    for (const plugin of plugins) {
      const entry = plugin?.entryId ?? plugin?.id;
      const title = plugin?.moduleName ?? plugin?.name;
      if (typeof entry !== "string" || typeof title !== "string") continue;
      const toggle = switchRow({ title: pluginName(title), sub: plugin.enabled ? "已启用" : "已停用", checked: plugin.enabled === true, disabled: Boolean(plugin.readOnlyReason), onChange: async (next) => {
        status.textContent = "正在保存…";
        try {
          const result = await screen.ask("service:admin", "plugins.op", { op: "plugin", id: entry, enabled: next });
          if (typeof result.application === "string" && !["applied", "restart-required"].includes(result.application)) throw new Error("operation failed");
          await read();
          if (screen.alive()) status.textContent = result.application === "restart-required" ? "已保存；重启后生效。" : "已更新插件。";
        } catch (error) { if (screen.alive() && error?.code !== "stale") { status.textContent = "插件更新未确认，请重试。"; toggle.set(!next); } }
      } });
      toggle.dataset.pluginId = entry;
      rows.push(toggle);
    }
    fill(listBox, rows.length ? h("div", { class: "list noic" }, rows) : list(row({ title: "没有安装插件" })));
    status.textContent = `已安装 ${plugins.length} 个插件。`;
  };
  return { title: "开发者选项", body: h("div", { class: "hm-stack" }, note(`给开发和排查问题用。改错了可能让她无法正常工作。`), group("", list(row({ icon: "cpu", title: "主模型", onClick: () => ctx.go("model") }))), group("她的扩展", listBox), status),
    refresh: () => read().catch((error) => { if (screen.alive() && error?.code !== "stale") status.textContent = "插件读取失败，请重试。"; }) };
}
