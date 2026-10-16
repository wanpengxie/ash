// A stand-in agent for the DSH driver tests: standard ACP over stdio, and (FAKE_EXT=1) the `_ash/*` extensions.
// Everything it is told is appended to the file FAKE_LOG as JSON lines, so a test can see what the agent saw.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const ext = process.env.FAKE_EXT === "1";
const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const sessions = new Map();
const credentials = new Map();
let counter = 0;
const out = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const options = (model) => [{ id: "model", currentValue: model, options: [{ value: '["p","m0"]' }, { value: '["p","deepseek-flash"]' }] }, { id: "effort", currentValue: "low", options: [{ value: "low" }, { value: "high" }] }];
const update = (sessionId, u) => out({ method: "session/update", params: { sessionId, update: u } });
const textOf = (blocks) => (blocks ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");

async function prompt(id, params) {
  const s = sessions.get(id);
  const text = textOf(params.prompt);
  log({ prompt: id, text, images: (params.prompt ?? []).filter((b) => b.type === "image").length });
  s.busy = true;
  s.cancelled = false;
  // kill -9: no reply, stdout just closes. Only the first time (FAKE_KILLED is the marker), so a retry gets through.
  if (text.includes("KILL9") && process.env.FAKE_KILLED && !existsSync(process.env.FAKE_KILLED)) { writeFileSync(process.env.FAKE_KILLED, "1"); process.kill(process.pid, "SIGKILL"); }
  if (text.includes("DIE") && !text.includes("上一轮中断了")) process.exit(1); // the hub's cut-off notice quotes what was cut off
  update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
  if (text.includes("TOOL")) {
    update(id, { sessionUpdate: "tool_call", toolCallId: "c1", title: "read_file", kind: "read", status: "pending" });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
  }
  if (text.includes("MANYCALLS")) { // what DSH 0.2 sends: the raw tool name as the title, kind always "other", the arguments as rawInput
    const calls = [["bash", { command: "sleep 90" }], ["mcp__ash__human_say", { text: "hi" }], ["mcp__ash__capability_call", { member: "service:history", word: "query", body: {} }], ["mcp__ash__capability_call", { member: "device:x" }], ["some_future_tool", {}]];
    calls.forEach(([title, rawInput], i) => {
      update(id, { sessionUpdate: "tool_call", toolCallId: `m${i}`, title, kind: "other", status: "in_progress", rawInput });
      update(id, { sessionUpdate: "tool_call_update", toolCallId: `m${i}`, status: i === 4 ? "failed" : "completed", content: [] });
    });
  }
  if (text.includes("CTXREAD")) {
    const rawInput = { member: "service:host", word: "ctx.read", body: { day: "2026-10-15", file: "screens" } };
    update(id, { sessionUpdate: "tool_call", toolCallId: "ctx", title: "mcp__ash__capability_call", kind: "other", status: "in_progress", rawInput });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "ctx", status: "completed", rawOutput: { text: "SYNTHETIC_CTX_PRIVATE_SENTINEL" }, content: [{ type: "text", text: "SYNTHETIC_CTX_PRIVATE_SENTINEL" }] });
  }
  if (text.includes("SLOW")) await new Promise((resolve) => { s.release = resolve; });
  if (!s.cancelled) {
    const body = text.split("\n").find((l) => l && !l.startsWith("[ash]")) ?? "";
    update(id, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: `echo: ` } });
    update(id, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: body } });
    if (text.includes("TWO")) update(id, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "second" } });
  }
  s.busy = false;
  return { stopReason: s.cancelled ? "cancelled" : "end_turn" };
}

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } }),
  "session/new": (p) => { const id = `s-${++counter}-${process.pid}`; sessions.set(id, { busy: false, model: '["p","m0"]' }); log({ new: id, cwd: p.cwd, mcp: p.mcpServers }); return { sessionId: id, configOptions: options('["p","m0"]') }; },
  "session/resume": (p) => {
    if (process.env.FAKE_NO_RESUME === "1") throw Object.assign(new Error("method not found"), { code: -32601 });
    if (!String(p.sessionId).startsWith("s-")) throw Object.assign(new Error("session not found"), { code: -32602 });
    sessions.set(p.sessionId, sessions.get(p.sessionId) ?? { busy: false, model: '["p","m0"]' });
    log({ resume: p.sessionId });
    return { configOptions: options(sessions.get(p.sessionId).model) };
  },
  "session/set_config_option": (p) => { const s = sessions.get(p.sessionId); log({ set: p.configId, value: p.value }); if (p.configId === "model") s.model = p.value; return { configOptions: options(s.model) }; },
};
const extensions = {
  "_ash/steer": (p) => { const s = sessions.get(p.sessionId); log({ steer: textOf(p.content) }); if (textOf(p.content).includes("GO")) s?.release?.(); return { steered: !!s?.busy }; },
  "_ash/inject": (p) => { log({ inject: textOf(p.content) }); return {}; },
  "_ash/compact": (p) => { const s = sessions.get(p.sessionId); if (s?.busy) throw Object.assign(new Error("busy"), { code: -32002 }); log({ compact: p.sessionId }); return { compacted: true, detail: "ok" }; },
  "_ash/plugins": (p) => { log({ plugins: p }); return { plugins: [{ id: "x" }] }; },
  "_ash/credentials.has": (p) => ({ has: credentials.has(p.ref) }),
  "_ash/credentials.set": (p) => { credentials.set(p.ref, p.value); log({ credentialSet: p.ref }); return { ok: true }; },
  "_ash/usage": (p) => { log({ usage: p.since }); return { records: [{ at: 1, done: 100, model: "m", input: 5, output: 7, ok: true }] }; },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "session/cancel") { const s = sessions.get(msg.params.sessionId); if (s) { s.cancelled = true; s.release?.(); } return; }
  if (msg.id === undefined) return;
  try {
    if (msg.method === "session/prompt") return out({ id: msg.id, result: await prompt(msg.params.sessionId, msg.params) });
    const fn = handlers[msg.method] ?? (ext ? extensions[msg.method] : undefined);
    if (!fn) return out({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    out({ id: msg.id, result: fn(msg.params) });
  } catch (error) {
    out({ id: msg.id, error: { code: error.code ?? -32603, message: String(error.message) } });
  }
});
