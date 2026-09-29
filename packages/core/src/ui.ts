// ash's own personal-agent UI (v1): one conversation with the main agent, cards for
// reminders and notifications, a drawer for agents and timers. No framework, no build step;
// it talks to ash only through the public SDK (HTTP + the SSE event stream).

export const UI_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Ash</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1e;--mute:#8a8a8e;--line:#e6e6e3;--me:#2f6bff;--me-fg:#fff;--card:#fff;--chip:#efefec;--err:#d33}
@media (prefers-color-scheme:dark){:root{--bg:#141415;--fg:#ececee;--mute:#8d8d93;--line:#2a2a2d;--me:#3b74ff;--card:#1e1e20;--chip:#242427;--err:#ff6b6b}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,"PingFang SC","Noto Sans SC",sans-serif;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:.6rem;padding:.7rem 1rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
header h1{font-size:1.05rem;margin:0;font-weight:650;letter-spacing:.02em}
#dot{width:8px;height:8px;border-radius:50%;background:var(--mute)}#dot.idle{background:#2bb673}#dot.running{background:#f5a623;animation:p 1s infinite}#dot.error{background:var(--err)}
@keyframes p{50%{opacity:.35}}
#state{color:var(--mute);font-size:.8rem;flex:1}
header button{background:none;border:0;color:var(--fg);font-size:1.25rem;cursor:pointer;padding:.2rem .4rem}
main{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.55rem;max-width:760px;width:100%;margin:0 auto}
.msg{max-width:86%;padding:.55rem .8rem;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}
.me{align-self:flex-end;background:var(--me);color:var(--me-fg);border-bottom-right-radius:5px}
.ai{align-self:flex-start;background:var(--card);border:1px solid var(--line);border-bottom-left-radius:5px}
.ai pre{background:var(--chip);padding:.5rem;border-radius:8px;overflow-x:auto;white-space:pre}
.ai code{background:var(--chip);padding:0 .25rem;border-radius:4px;font-size:.9em}
.from{align-self:flex-start;font-size:.75rem;color:var(--mute);margin:-.2rem 0 -.35rem .3rem}
.chip{align-self:center;background:var(--chip);color:var(--mute);font-size:.78rem;padding:.2rem .7rem;border-radius:999px;max-width:92%;text-align:center}
.tool{align-self:flex-start;font-size:.78rem;color:var(--mute);padding:0 .4rem;cursor:pointer;max-width:92%}
.tool pre{white-space:pre-wrap;margin:.3rem 0 0;font-size:.75rem;background:var(--chip);padding:.4rem;border-radius:6px;display:none}
.tool.open pre{display:block}
.card{align-self:stretch;background:var(--card);border:1px solid var(--line);border-left:3px solid #f5a623;border-radius:10px;padding:.55rem .8rem}
.card b{display:block}.card small{color:var(--mute)}
.err{color:var(--err);font-size:.8rem;align-self:flex-start}
.typing{align-self:flex-start;color:var(--mute);font-size:.85rem}
footer{border-top:1px solid var(--line);padding:.6rem;background:var(--bg);padding-bottom:max(.6rem,env(safe-area-inset-bottom))}
footer form{display:flex;gap:.5rem;max-width:760px;margin:0 auto}
textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:12px;padding:.55rem .75rem;font:inherit;max-height:40vh}
footer button{border:0;background:var(--me);color:#fff;border-radius:12px;padding:0 1rem;font-size:1rem;cursor:pointer}
#drawer{position:fixed;inset:0 0 0 auto;width:min(360px,92vw);background:var(--bg);border-left:1px solid var(--line);transform:translateX(100%);transition:transform .2s;z-index:5;overflow-y:auto;padding:1rem}
#drawer.open{transform:none}#drawer h2{font-size:.9rem;color:var(--mute);margin:1.2rem 0 .4rem;font-weight:600}
.row{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.5rem .7rem;margin:.35rem 0;font-size:.85rem}
.caps span{display:inline-block;font-size:.7rem;padding:0 .35rem;margin:.1rem;border-radius:4px;background:var(--chip);color:var(--mute)}.caps span.on{color:#2bb673}
.row button{float:right;border:0;background:none;color:var(--err);cursor:pointer}
</style></head>
<body>
<header><span id="dot"></span><h1>Ash</h1><span id="state">连接中…</span><button id="menu" title="状态">☰</button></header>
<main id="log"></main>
<footer><form id="f"><textarea id="t" rows="1" placeholder="跟 Ash 说点什么…"></textarea><button>发送</button></form></footer>
<aside id="drawer"></aside>
<script>
const $ = (s) => document.querySelector(s);
const log = $("#log");
let AGENT = null, typing = null, lastSeq = 0;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (s) => esc(s)
  .replace(/\\\`\\\`\\\`[a-z]*\\n?([\\s\\S]*?)\\\`\\\`\\\`/g, (_, c) => "<pre>" + c + "</pre>")
  .replace(/\\\`([^\\\`\\n]+)\\\`/g, "<code>$1</code>")
  .replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const api = async (m, p, b) => {
  const r = await fetch(p, { method: m, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined, credentials: "same-origin" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || r.status);
  return r.json();
};
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 120;
function add(cls, html, pin) {
  const stick = pin || nearBottom();
  const el = document.createElement("div");
  el.className = cls;
  el.innerHTML = html;
  if (typing && typing.parentNode) log.insertBefore(el, typing); else log.appendChild(el);
  if (stick) log.scrollTop = log.scrollHeight;
  return el;
}
const label = (from) => from.startsWith("timer:") ? "⏰ 定时提醒" : from.startsWith("agent:") ? "🤖 " + from.slice(6) : from.startsWith("device:") ? "📱 " + from.slice(7) : from;
const tools = [];
function render(e) {
  lastSeq = Math.max(lastSeq, e.seq);
  const d = e.data;
  switch (e.type) {
    case "message.delivered":
      if (d.to !== AGENT) return;
      if (d.from === "person:owner") add("msg me", esc(d.text));
      else { add("from", esc(label(d.from))); add("msg ai", md(d.text)); }
      return;
    case "agent.turn.started":
      if (e.member !== AGENT) return;
      if (!typing) { typing = document.createElement("div"); typing.className = "typing"; typing.textContent = "Ash 正在处理…"; log.appendChild(typing); log.scrollTop = log.scrollHeight; }
      return;
    case "agent.text":
      if (e.member === AGENT) add("msg ai", md(d.text)); else { add("from", esc(label(e.member))); add("msg ai", md(d.text)); }
      return;
    case "agent.tool.call": {
      const el = add("tool", "🔧 " + esc(d.name) + " <span></span><pre>" + esc(JSON.stringify(d.args, null, 1)) + "</pre>");
      el.onclick = () => el.classList.toggle("open");
      tools.push({ name: d.name, el });
      return;
    }
    case "agent.tool.result": {
      const i = tools.findIndex((t) => t.name === d.name);
      const t = i >= 0 ? tools.splice(i, 1)[0] : null;
      if (t) { t.el.querySelector("span").textContent = d.ok ? "✓" : "✗"; t.el.querySelector("pre").textContent += "\\n→ " + d.preview; }
      return;
    }
    case "agent.turn.ended":
      if (e.member === AGENT && typing) { typing.remove(); typing = null; }
      if (d.reason === "error") add("err", "这一轮出错了：" + esc(d.error || ""));
      if (d.reason === "cancelled") add("chip", "已取消");
      return;
    case "timer.set": add("chip", "⏰ 已设提醒 · " + esc(d.timer.text) + " · " + time(d.timer.fire_at)); return;
    case "timer.fired": add("chip", "⏰ 提醒到点 · " + esc(d.timer.text)); return;
    case "notify": add("card", "<b>🔔 " + esc(d.title) + "</b>" + esc(d.text) + "<br><small>" + esc(label(e.member)) + " · " + time(e.ts) + "</small>"); return;
    case "agent.status":
      if (e.member === AGENT) setState(d.status, d.error);
      return;
  }
}
function setState(s, err) {
  $("#dot").className = s;
  $("#state").textContent = { idle: "在线", running: "处理中", starting: "启动中", error: "出错", stopped: "已停止" }[s] || s;
  if (err && s === "error") $("#state").title = err;
}
async function drawer() {
  const [agents, timers] = await Promise.all([api("GET", "/v1/agents"), api("GET", "/v1/timers")]);
  const cap = (c) => Object.entries(c).map(([k, v]) => '<span class="' + (v ? "on" : "") + '">' + k + "</span>").join("");
  $("#drawer").innerHTML = "<h2>AGENT</h2>" + agents.map((a) => '<div class="row"><b>' + esc(a.id) + "</b> · " + esc(a.runtime) + " · " + esc(a.status) + (a.queued ? " · 排队 " + a.queued : "") + '<div class="caps">' + cap(a.capabilities) + "</div></div>").join("")
    + "<h2>定时提醒</h2>" + (timers.length ? timers.map((t) => '<div class="row"><button data-id="' + esc(t.id) + '">取消</button>' + esc(t.text) + "<br><small>" + esc(t.owner) + " · " + new Date(t.fire_at).toLocaleString() + (t.repeat_seconds ? " · 每 " + t.repeat_seconds + " 秒" : "") + "</small></div>").join("") : '<div class="row">没有</div>');
  $("#drawer").querySelectorAll("button[data-id]").forEach((b) => (b.onclick = async () => { await api("DELETE", "/v1/timers/" + encodeURIComponent(b.dataset.id)); drawer(); }));
}
$("#menu").onclick = () => { const d = $("#drawer"); d.classList.toggle("open"); if (d.classList.contains("open")) drawer(); };
log.onclick = () => $("#drawer").classList.remove("open");
const ta = $("#t");
ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; });
ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer:fine)").matches) { e.preventDefault(); $("#f").requestSubmit(); } });
$("#f").onsubmit = async (e) => {
  e.preventDefault();
  const text = ta.value.trim();
  if (!text || !AGENT) return;
  ta.value = ""; ta.style.height = "auto";
  try { await api("POST", "/v1/agents/" + encodeURIComponent(AGENT) + "/deliver", { text }); }
  catch (err) { add("err", "发送失败：" + esc(err.message)); ta.value = text; }
};
(async () => {
  const m = await api("GET", "/v1/manifest");
  AGENT = (m.agents.find((a) => a.id === "agent:main") || m.agents[0] || {}).id;
  const a = m.agents.find((x) => x.id === AGENT);
  if (a) setState(a.status);
  for (let after = 0; ;) {
    const page = await api("GET", "/v1/events?after=" + after + "&limit=1000");
    page.events.forEach(render);
    if (page.events.length < 1000) break;
    after = page.next;
  }
  if (typing && a && a.status !== "running") { typing.remove(); typing = null; }
  log.scrollTop = log.scrollHeight;
  const es = new EventSource("/v1/events/stream?after=" + lastSeq);
  es.onmessage = (ev) => { const e = JSON.parse(ev.data); if (e.seq > lastSeq) render(e); };
  es.onerror = () => $("#state").textContent = "重连中…";
  es.onopen = () => { if (a) setState(a.status); };
})();
</script></body></html>`;
