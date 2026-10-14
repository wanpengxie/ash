import { fill } from "./home-dom.js";
// The devices that connect to her: the list on 她的手和眼, one device's page (name, what it may do, diagnosis, removal), a request
// waiting for your approval, and the pairing of a new one with the relay it goes through.
import { deviceDiagnosis, handOf, KIND_NAMES, clock, relayText } from "./home-text.js";
import { readDevices } from "./home-data.js";
import { btn, card, group, h, list, localHint, note, row, skeleton, twoTap } from "./home-ui.js";
import { switchRow } from "./home-switch.js";

const KINDS = [["computer", "电脑"], ["server", "服务器"]];

/** What a device may do, as switches and a choice. [read()] is the body of `access_set` / `pair_approve`. */
function permissions(device, { browser = false, idPrefix = "dev" } = {}) {
  const tier = h("div", { class: "seg", role: "tablist" });
  let current = device.tier === "full" ? "full" : "ask";
  const drawTier = () => fill(tier, ...[["ask", "按规则和影响审批"], ["full", "完全放开"]].map(([key, label]) => btn(label, current === key ? "on" : "", () => { if (!browser) { current = key; drawTier(); } }, { role: "tab", "aria-selected": String(current === key), disabled: browser })));
  drawTier();
  const rows = [
    ["lend", "借出它的能力", "让她能用它", device.lend === true],
    ["body", "当作身体", "让她读写它的文件、执行命令", device.body === true],
    ["local_agents", "允许本地 Agent", "使用电脑本地完整权限", device.local_agents === true],
  ].map(([key, title, sub, on]) => ({ key, el: switchRow({ title, sub, checked: browser ? false : on, disabled: browser, id: `${idPrefix}_${key}` }) }));
  const root = h("div", { class: "hm-stack" }, h("span", { class: "group-ttl" }, "它能做什么"), tier, h("div", { class: "list noic" }, rows.map((r) => r.el)));
  return { root, read: () => ({ tier: browser ? "ask" : current, ...Object.fromEntries(rows.map(({ key, el }) => [key, browser ? false : el.get()])) }) };
}

const deviceLine = (device) => {
  const kind = KIND_NAMES[device.kind] ?? "设备";
  if (device.revoked_at) return { text: `${kind} · 已移除，连不上了`, tone: "" };
  const seen = !device.online && device.last_seen ? ` · 上次在线 ${clock(device.last_seen)}` : "";
  return { text: `${kind} · ${device.online ? "在线" : "离线"}${seen}${device.via === "gateway" ? " · 经中转站" : ""}`, tone: device.online ? "ok" : "" };
};

/** The device list as rows (used by 她的手和眼). */
export function deviceRows(ctx, devices, pairs) {
  const rows = [];
  for (const pair of pairs.filter((p) => p.state === "requested")) {
    const kind = KIND_NAMES[pair.kind] ?? "设备";
    rows.push(row({ icon: "laptop", tone: "warn", title: pair.name || `新${kind}想连上来`, sub: "等你批准", subTone: "warn", onClick: () => ctx.go("device", { pair: pair.pair_id }) }));
  }
  for (const device of devices) {
    const line = deviceLine(device);
    rows.push(row({ icon: device.kind === "browser" ? "globe" : "laptop", title: device.name, sub: line.text, onClick: () => ctx.go("device", { device: device.device }) }));
  }
  return rows;
}

/** One device (`arg.device`) or one request waiting to be approved (`arg.pair`). */
export function devicePage(ctx, screen, arg) {
  const box = h("div", { class: "hm-stack" }, skeleton(3));
  const state = { status: "" };
  const act = async (word, body) => { await screen.ask("service:devices", word, body); await refresh(); };
  const failed = (text) => (error) => { if (screen.alive() && error?.code !== "stale") { state.status = text; draw(); } };
  let data = null;
  const statusEl = () => state.status ? h("p", { class: "hm-note c-warn", role: "status" }, state.status) : null;
  const draw = () => {
    if (!data) return;
    if (arg?.pair) {
      const pair = data.pairs.find((p) => p.pair_id === arg.pair && p.state === "requested");
      if (!pair) { fill(box, list(row({ icon: "check", tone: "ok", title: "这个请求已经处理了" })), btn("回到她的手和眼", "a-btn btn-neutral btn-block", () => ctx.back())); return; }
      const kind = KIND_NAMES[pair.kind] ?? "设备";
      const grant = permissions({ tier: "ask", lend: true }, { idPrefix: `pending_${pair.pair_id}` });
      fill(box, card("hm-promise", h("span", { class: "hm-big" }, pair.name || `新${kind}`), h("span", { class: "tx-sub" }, `${kind} · 先确认它是你的设备，再选它能做什么`)), grant.root,
        btn("批准", "a-btn btn-primary btn-block", () => { void act("pair_approve", { pair_id: pair.pair_id, ...grant.read() }).then(() => ctx.back()).catch(failed("批准未确认，请刷新状态后检查。")); }, { id: "homePendingApprove" }),
        btn("拒绝", "a-btn btn-neutral btn-block", () => { void act("pair_reject", { pair_id: pair.pair_id }).then(() => ctx.back()).catch(failed("拒绝未确认，请重试。")); }, { id: "homePendingReject" }), statusEl());
      return;
    }
    const device = data.devices.find((d) => d.device === arg?.device);
    if (!device) { fill(box, list(row({ icon: "alert", title: "没有找到这台设备" }))); return; }
    const line = deviceLine(device);
    if (device.revoked_at) {
      fill(box, card("hm-promise", h("span", { class: "hm-big" }, device.name), h("span", { class: "tx-sub" }, line.text)),
        btn("恢复", "a-btn btn-secondary btn-block", () => { void act("restore", { device: device.device }).catch(failed("恢复未确认，请重试。")); }, { id: "homeDeviceRestore" }), statusEl());
      return;
    }
    const name = h("input", { type: "text", value: device.name, "aria-label": "设备名称", maxlength: 64 });
    const grant = permissions(device, { browser: device.kind === "browser", idPrefix: `dev_${handOf(device.device)}` });
    const info = h("pre", { class: "hm-pre", hidden: true });
    const remove = h("button", { type: "button", class: "a-btn btn-danger btn-block", id: "homeDeviceRevoke" });
    const warn = h("p", { class: "hm-note c-err", role: "status" });
    twoTap(remove, { label: "移除这台设备", confirm: "确定移除？", warn: `移除后 ${device.name} 需要重新配对才能连上。`, onWarn: (text) => { warn.textContent = text; }, run: () => act("revoke", { device: device.device }).then(() => ctx.back()).catch(failed("移除未确认，请重试。")) });
    fill(box, card("hm-promise", h("span", { class: "hm-big" }, device.name), h("span", { class: `tx-sub${line.tone ? ` c-${line.tone}` : ""}` }, line.text)),
      group("名称", h("div", { class: "hm-actions hm-inline" }, name, btn("保存名称", "a-btn btn-neutral btn-sm", () => { const next = name.value.trim(); if (!next) { state.status = "名称不能是空的。"; draw(); return; } void act("rename", { device: device.device, name: next }).catch(failed("名称未保存。")); }))),
      grant.root, btn("保存权限", "a-btn btn-primary btn-block", () => { void act("access_set", { device: device.device, ...grant.read() }).then(() => { state.status = ""; }).catch(failed("权限未确认，请刷新状态后检查。")); }, { id: "homeDeviceSave" }),
      btn("诊断", "a-btn btn-neutral btn-block", async () => {
        info.hidden = false; info.textContent = "正在诊断…";
        try {
          const hand = handOf(device.device);
          const [diagnosis, connected] = await Promise.all([screen.ask("service:link", "diagnose", { hand }), screen.ask("service:link", "list", {}).catch(() => ({ connections: [] }))]);
          if (screen.alive()) info.textContent = deviceDiagnosis({ device, diagnosis, connections: (connected.connections ?? []).filter((c) => c.hand === hand) });
        } catch (error) { if (screen.alive()) info.textContent = error?.code === "stale" ? "" : "诊断失败，请刷新状态。"; }
      }), info, remove, warn, statusEl());
  };
  async function refresh() { try { data = await readDevices(screen); } catch (error) { if (error?.code !== "stale" && screen.alive()) fill(box, note("读取失败，请返回后重试。", "warn")); return; } if (screen.alive()) draw(); }
  return { title: arg?.pair ? "新设备" : "设备", body: box, refresh };
}

/** 连一台新设备: the install command for a computer or server (it carries the one-time code and secret), and the relay it connects through. */
export function connectPage(ctx, screen) {
  const root = h("div", { class: "hm-stack" });
  const state = { kind: "computer", shown: null, pairResult: "", relay: null, copy: "复制命令", requested: 0, signature: null };
  const countdown = (ms) => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };

  const refreshRelay = async () => { state.relay = await screen.ask("service:link", "gateway.status", {}); };

  const readPairing = async () => {
    let pairs;
    try { pairs = (await screen.ask("service:devices", "pair_pending", {})).pairs ?? []; } catch { return; }
    const signature = pairs.map((p) => `${p.pair_id}:${p.state}`).join(",");
    let changed = state.signature !== null && signature !== state.signature;
    state.signature = signature;
    state.requested = pairs.filter((p) => p.state === "requested").length;
    if (state.shown) {
      let own = pairs.find((p) => p.pair_id === state.shown.pair_id);
      if (!own) own = await screen.ask("service:devices", "pair_status", { pair_id: state.shown.pair_id }).catch(() => null);
      if (own?.state && own.state !== state.shown.state) { state.shown.state = own.state; changed = true; }
    }
    if (screen.alive() && changed) draw();
  };

  const pairText = (shown, code, left) => code === "requested" ? "命令已运行。新设备发来的连接请求在「她的手和眼」里，确认是你的设备再批准。"
    : code === "expired" ? "命令已过期。需要时再点「生成安装命令」。" : `在要连接的电脑上打开终端，粘贴下面这行命令回车（还剩 ${countdown(left)}，只能用一次；里面有一次性密钥，别发给别人），再回到「她的手和眼」批准：`;
  const tickText = () => {
    const shown = state.shown;
    const text = root.querySelector("#homePairText");
    if (!shown || !text) return;
    const left = shown.deadline - Date.now();
    const code = shown.state === "waiting" && left <= 0 ? "expired" : shown.state;
    text.textContent = pairText(shown, code, left);
    if (code === "expired" && shown.state === "waiting") draw();
  };
  const draw = () => {
    const shown = state.shown && !["approved", "connected", "rejected"].includes(state.shown.state) ? state.shown : null;
    const left = shown ? shown.deadline - Date.now() : 0;
    const code = shown?.state === "waiting" && left <= 0 ? "expired" : shown?.state;
    const kinds = h("div", { class: "seg", role: "tablist" }, KINDS.map(([key, label]) => btn(label, state.kind === key ? "on" : "", () => { state.kind = key; draw(); }, { role: "tab", "aria-selected": String(state.kind === key), id: `homePairKind_${key}` })));
    const pairBox = shown ? card("hm-promise", h("p", { class: "hm-note", id: "homePairText" }, pairText(shown, code, left)),
      code === "waiting" ? h("pre", { class: "hm-pre", id: "homePairCommand" }, shown.command) : null,
      code === "waiting" ? btn(state.copy, "a-btn btn-neutral btn-sm hm-left", async () => { try { await globalThis.navigator.clipboard.writeText(shown.command); state.copy = "已复制"; } catch { state.copy = "长按上面的命令复制"; } draw(); }, { id: "homePairCopy" }) : null,
      code === "requested" ? btn("去批准", "a-btn btn-primary btn-sm hm-left", () => ctx.back()) : null) : null;
    const relay = state.relay;
    fill(root, 
      localHint(ctx), group("连一台新设备", h("div", { class: "hm-stack" }, kinds, btn("生成安装命令", "a-btn btn-primary btn-block", async () => {
        state.pairResult = "正在生成安装命令…"; draw();
        try {
          const started = await screen.ask("service:devices", "pair_start", { kind: state.kind });
          state.copy = "复制命令";
          state.shown = { pair_id: started.pair_id, kind: state.kind, command: started.command, deadline: Number(started.expires_at) || Date.now(), state: "waiting" };
          state.pairResult = "";
        } catch (error) { state.pairResult = error?.code === "stale" ? "" : "生成失败：中转站可能离线，请稍后重试。"; state.shown = null; }
        if (screen.alive()) draw();
      }, { id: "homePair" }), state.pairResult ? note(state.pairResult) : null, pairBox)),
      group("中转站", card("hm-promise", h("span", { class: "tx-sub", id: "homeRelayStatus" }, relay ? relayText(relay) : "正在读取…"),
        h("span", { class: "tx-caption" }, "中转站是你 Cloudflare 账号里的一个小程序，由她来搭、领回、换域名：你只需要授权一次，动你的东西之前她会先问你。"),
        btn(relay?.connected === true ? "让她管中转站" : "让她搭中转站", "a-btn btn-secondary btn-block", () => ctx.compose?.(relay?.configured === true ? "帮我看看中转站" : "帮我搭中转站"), { id: "homeRelayAsk" }))));
  };
  draw();
  let tick = 0;
  // Only a pairing that is on the page has anything to ask for: the countdown moves every second, the hub is asked every other
  // second (nothing pushes a device's request to the page).
  screen.every(() => {
    if (!state.shown) return;
    tickText();
    if (++tick % 2 === 0) void readPairing();
  }, 1000);
  return { title: "连一台新设备", body: root, refresh: async () => { await Promise.all([refreshRelay().catch(() => {}), readPairing()]); if (screen.alive()) draw(); } };
}
