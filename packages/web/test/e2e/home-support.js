// A hub for the home pages' browser tests: every word they call remembers what it was told, so a page that reads back sees its
// own change; and a way to open a page of 她的主页 the way the conversation does (`ash:open`).
export function homeHub(kernel) {
  const now = Date.now();
  const state = { paused: false, settings: {}, mode: "auto", model: "deepseek-chat", plugins: [{ entryId: "p1", moduleName: "web-tools", enabled: true }],
    vault: new Set(), revoked: [],
    apps: [{ id: "weather", name: "天气", version: "1.0", granted: false, enabled: false, running: false, needs: [{ why: "查天气", member: "service:senses", words: ["now"] }] }],
    files: new Map(), devices: [], pairs: [], relay: { configured: false, connected: false }, timers: [],
    history: [{ id: "h1", request_id: "q1", at: now - 3_600_000, word: "browser.type", label: "在网页上输入", decision: "once" }],
    rules: [{ id: "r1", word: "calendar.create", object_pattern: "个人", expires_at: now + 30 * 86_400_000 }] };
  const on = (member, word, answer) => kernel.on(member, word, answer);
  on("service:admin", "status", () => ({ now: Date.now(), paused: state.paused }));
  on("service:admin", "pause", () => { state.paused = true; return { paused: true }; });
  on("service:admin", "resume", () => { state.paused = false; return { paused: false }; });
  on("service:admin", "settings.get", ({ keys }) => ({ settings: Object.fromEntries(Object.entries(state.settings).filter(([k]) => !keys || keys.includes(k))) }));
  on("service:admin", "settings.set", (body) => { Object.assign(state.settings, body); return body; });
  on("service:admin", "model.set", ({ provider, model }) => { state.model = model; return { provider, model, restart_required: false }; });
  on("service:admin", "plugins.list", () => ({ plugins: state.plugins }));
  on("service:admin", "plugins.op", ({ id, enabled }) => { state.plugins.find((p) => p.entryId === id).enabled = enabled; return { application: "applied" }; });
  on("service:agents", "list", () => ({ agents: [{ id: "agent:main", name: "Ash", summary: "", state: "idle", primary: true, runtime: { kind: "dsh", model: state.model } }, { id: "agent:xiaoyan", name: "小研", summary: "", state: "idle" }] }));
  on("service:gate", "rules.list", () => ({ rules: state.rules.filter((rule) => !state.revoked.includes(rule.id)), mode: state.mode }));
  on("service:gate", "history", () => ({ items: state.history }));
  on("service:gate", "mode.set", ({ mode }) => { state.mode = mode; return { mode }; });
  on("service:gate", "rules.revoke", ({ id }) => { state.revoked.push(id); return { revoked: true }; });
  on("service:gate", "audit", ({ request_id }) => ({ entries: [{ request_id, requester: "agent:main", word: "browser.type", effect: "act", decision: "once", decided_by: "owner", answered_at: now - 3_000_000, executed: { ok: true } }] }));
  const totals = (calls, cost_usd) => ({ calls, input_tokens: 10, output_tokens: 5, cost_usd, unpriced_calls: 0 });
  on("service:cost", "usage.get", () => ({ as_of: Date.now(), currency: "USD", estimated: true, periods: { today: totals(2, 0.5), "7d": totals(3, 1), "30d": totals(4, 2) },
    by_caller: [{ caller: "agent:main", ...totals(3, 1) }, { caller: "service:reflex", ...totals(1, 0.1) }], by_day: [{ date: "2026-10-10", ...totals(1, 0.2) }, { date: "2026-10-11", ...totals(2, 0.5) }], recent: [], balances: [] }));
  on("service:cost", "balance.get", () => ({ balances: [{ provider: "deepseek", at: Date.now(), balance: { available: true, balances: [{ currency: "CNY", total: "12.50" }] } }], errors: {} }));
  on("service:vault", "list", () => ({ entries: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"].map((ref) => ({ ref, label: ref, kind: "model", configured: state.vault.has(ref) })) }));
  on("service:vault", "set", ({ ref }) => { state.vault.add(ref); return { ref, configured: true }; });
  on("service:vault", "delete", ({ ref }) => { state.vault.delete(ref); return { ref, configured: false }; });
  const refOf = { deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY" };
  const standing = (provider) => ({ provider, ref: refOf[provider], configured: state.vault.has(refOf[provider]), status: state.vault.has(refOf[provider]) ? "ok" : "unknown", checked_at: 1 });
  on("service:llm", "keys.status", () => ({ keys: ["deepseek", "openrouter"].map(standing) }));
  on("service:llm", "keys.check", ({ provider }) => ({ keys: [standing(provider)] }));
  on("service:apps", "apps.list", () => ({ apps: state.apps }));
  on("service:apps", "apps.install", ({ id }) => { Object.assign(state.apps.find((a) => a.id === id), { granted: true, enabled: true, running: true }); return {}; });
  on("service:apps", "apps.disable", ({ id }) => { state.apps.find((a) => a.id === id).enabled = false; return {}; });
  on("service:devices", "list", () => ({ devices: state.devices }));
  on("service:devices", "pair_pending", () => ({ pairs: state.pairs }));
  on("service:devices", "pair_start", ({ kind }) => { state.pairs.push({ pair_id: "pair1", state: "waiting", kind }); return { pair_id: "pair1", expires_at: Date.now() + 600_000, command: "curl -fsSL https://github.com/wanpengxie/ash/releases/download/device-v0.2.3/install.sh | sh -s -- https://relay.example ABCD-1234 SECRET-5678" }; });
  on("service:devices", "pair_code", () => ({ command: "curl -fsSL https://github.com/wanpengxie/ash/releases/download/device-v0.2.3/install.sh | sh -s -- https://relay.example ABCD-1234 SECRET-5678", expires_at: Date.now() + 600_000 }));
  on("service:devices", "pair_status", ({ pair_id }) => state.pairs.find((p) => p.pair_id === pair_id) ?? { pair_id, state: "expired" });
  on("service:devices", "pair_approve", ({ pair_id }) => { state.pairs = []; state.devices.push({ device: `device:${"N".repeat(22)}`, name: "我的电脑", kind: "computer", online: true, tier: "ask", lend: true, body: false, local_agents: false, via: "gateway" }); return { pair_id, state: "approved" }; });
  on("service:devices", "revoke", ({ device }) => { state.devices.find((d) => d.device === device).revoked_at = Date.now(); return { revoked: true }; });
  on("service:devices", "restore", ({ device }) => { delete state.devices.find((d) => d.device === device).revoked_at; return {}; });
  on("service:link", "gateway.status", () => state.relay);
  on("service:link", "gateway.use", ({ url }) => { state.relay = { configured: true, url, claimed: true, connected: true }; return { url }; });
  on("service:clock", "list", () => ({ timers: state.timers }));
  on("service:clock", "cancel", ({ id }) => { state.timers = state.timers.filter((t) => t.id !== id); return { cancelled: true }; });
  on("service:bodies", "list", () => ({ bodies: [{ body: "body:main", ownership: "own", online: true }] }));
  on("body:main", "workspace.ls", () => ({ path: "/root/work", entries: [...state.files].map(([name, data]) => ({ name, type: "file", size: data.length })) }));
  on("body:main", "workspace.read", ({ path }) => state.files.has(path) ? { path, text: state.files.get(path), offset: 1, next_offset: 2, truncated: false } : { ok: false, error: { code: "not_found", message: "no such file" } });
  on("body:main", "workspace.write", ({ path, content }) => { state.files.set(path, content); return { path, bytes: content.length }; });
  state.persona = new Map([["IDENTITY.md", "- 名字：小岛\n- 称呼主人：阿然\n"], ["SOUL.md", "# 灵魂\n我叫小岛。\n"]]);
  on("service:persona", "get", ({ file }) => ({ files: [{ file, content: state.persona.get(file) ?? "", version: "v1" }] }));
  on("service:persona", "propose", ({ file, content }) => { state.persona.set(file, content); return { proposed: true, applied: true }; });
  return state;
}

/** Opens a page of 她的主页 as the conversation does, and waits for it. */
export async function openHome(page, detail = { page: "home" }, ready = "#home .hm-screen:last-child") {
  await page.evaluate((d) => window.dispatchEvent(new CustomEvent("ash:open", { cancelable: true, detail: d })), detail);
  await page.locator(ready).waitFor();
}
export const sent = (kernel, to, word) => kernel.requests.filter((r) => r.to === to && r.word === word);
