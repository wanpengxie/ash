import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../../sdk/src/api";
import { TaskStatusBridge, type TaskStatusFrame } from "../../src/task-status";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { WorldMembers } from "../../src/world/member";
import { createAgentMember } from "../../src/members/agent";
import { ReflexMember } from "../../src/members/reflex";

function fixture(deliver?: (f: TaskStatusFrame) => Promise<void>) {
  let observe!: (m: Message) => void;
  let seq = 0; const frames: TaskStatusFrame[] = [];
  const bridge = new TaskStatusBridge({ subscribe(fn) { observe = fn; return () => {}; } },
    deliver ?? (async (frame) => { frames.push(frame); }));
  const emit = (word: string, body: Record<string, unknown>, extra: Partial<Message> = {}) => observe({
    id: `m_${++seq}`, seq, ts: Date.now(), from: "agent:main", to: null, kind: "event", word, body, ...extra,
  } as Message);
  return { bridge, emit, frames };
}
test("capsule follows facts, strips query details, bounds history and marks completion", async () => {
  const f = fixture();
  try {
    f.emit("turn.start", { turn: "t_a" });
    f.emit("status", { state: "working", text: "在搜索 · PRIVATE QUERY" });
    await f.bridge.settled();
    assert.equal(f.frames.at(-1)!.turn, "t_a");
    assert.equal(f.frames.at(-1)!.text, "在搜索");
    assert.equal(JSON.stringify(f.frames).includes("PRIVATE"), false);
    for (let i = 0; i < 9; i++) f.emit("status", { state: "working", text: `阶段${i}` });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.steps.length, 0, "status pulses are not steps");
    for (let i = 0; i < 9; i++) f.emit("screen.read", {}, { kind: "request", id: `step_${i}`, to: "device:phone", turn: "t_a" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.steps.length, 5);
    f.emit("turn.end", { turn: "t_a", reason: "completed" });
    f.emit("status", { state: "done", text: "" });
    await f.bridge.settled();
    assert.equal(f.frames.at(-1)!.text, "已完成"); assert.equal(f.frames.at(-1)!.can_stop, false);
    assert.equal(f.frames.at(-1)!.outcome, "completed", "native completion color uses the actual outcome");
    f.emit("status", { state: "idle", text: "在线" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.turn, "t_a"); assert.equal(f.frames.at(-1)!.text, "已完成");
  } finally { await f.bridge.close(); }
});
test("task remains visible through transient idle and shows step purpose, not raw command or input", async () => {
  const f = fixture();
  try {
    f.emit("turn.start", { turn: "t_a" });
    f.emit("status", { state: "idle", text: "在线" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.turn, "t_a"); assert.equal(f.frames.at(-1)!.can_stop, true);
    f.emit("bash", { arguments: JSON.stringify({ command: "SECRET COMMAND", description: "正在整理订单列表" }) },
      { id: "bash_1", kind: "request", to: "service:dsh-tool", turn: "t_a" });
    f.emit("status", { state: "working", text: "在跑命令" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "正在整理订单列表");
    f.emit("bash", {}, { kind: "response", reply_to: "bash_1" });
    f.emit("status", { state: "thinking", text: "在想" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "等待模型响应");
    f.emit("mcp__ash__capability_call", { arguments: JSON.stringify({ member: "device:phone", word: "screen.type", body: { text: "SECRET BODY" }, purpose: "正在填写搜索条件" }) },
      { id: "cap_1", kind: "request", to: "service:dsh-tool", turn: "t_a" });
    f.emit("screen.type", { text: "SECRET BODY" }, { id: "screen_1", kind: "request", to: "device:phone", turn: "t_a" });
    f.emit("status", { state: "working", text: "输入文字" });
    // The inner capability's generic label must not override the outer step purpose.
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "正在填写搜索条件");
    assert.equal(JSON.stringify(f.frames).includes("SECRET"), false);
    f.emit("turn.end", { turn: "t_a", reason: "completed" });
    f.emit("status", { state: "idle", text: "在线" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "已完成"); assert.equal(f.frames.at(-1)!.can_stop, false);
  } finally { await f.bridge.close(); }
});
test("gate approval beats a held tool's working status; helpers cannot overwrite main state", async () => {
  const f = fixture();
  try {
    f.emit("turn.start", { turn: "t_a" });
    f.emit("status", { state: "working", text: "在动手" });
    f.emit("ask", {}, { id: "m_other_ask", from: "service:gate", to: "person:owner", kind: "request", turn: "t_helper" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "在动手");
    f.emit("ask", {}, { id: "m_ask", from: "service:gate", to: "person:owner", kind: "request", turn: "t_a" });
    f.emit("status", { state: "working", text: "在跑命令" }, { from: "agent:helper" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "等待你确认");
    f.emit("ask", {}, { from: "person:owner", kind: "response", reply_to: "m_ask" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "在动手");
    f.emit("turn.end", { turn: "t_a", reason: "cancelled" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "已停止");
    assert.equal(f.frames.at(-1)!.outcome, "cancelled", "cancelled is not green success");
  } finally { await f.bridge.close(); }
});
test("delivery coalesces slow updates, tolerates failure, clears on shutdown", async () => {
  const frames: TaskStatusFrame[] = []; let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const f = fixture(async (frame) => { frames.push(frame); if (frames.length === 1) { await hold; throw new Error("offline"); } });
  f.emit("turn.start", { turn: "t_a" });
  for (let i = 0; i < 100; i++) f.emit("status", { state: "working", text: `阶段${i}` });
  release(); await f.bridge.settled();
  assert.equal(frames.length, 2); assert.equal(frames.at(-1)!.text, "阶段99");
  await f.bridge.close(); assert.equal(frames.at(-1)!.can_stop, false); assert.equal(frames.at(-1)!.turn, null);
  f.emit("turn.start", { turn: "t_new" }); assert.equal(frames.length, 3);
});

test("caption and real tool share one step; late summaries and another agent's results cannot replace it", async () => {
  const f = fixture();
  try {
    f.emit("turn.start", { turn: "t_a" });
    f.emit("mcp__ash__capability_call", { arguments: JSON.stringify({ member: "device:phone", word: "screen.read", body: {}, purpose: "读取书架里的书名" }) },
      { id: "outer", kind: "request", to: "service:dsh-tool", turn: "t_a" });
    f.emit("screen.read", {}, { id: "inner", kind: "request", to: "device:phone", turn: "t_a" });
    f.emit("activity.summary", { text: "旧的思路摘要", current: false }, { turn: "t_a" });
    f.emit("bash", { ok: true }, { kind: "response", reply_to: "helper_call", from: "service:dsh-tool", to: "agent:helper" });
    await f.bridge.settled();
    const frame = f.frames.at(-1)!;
    assert.equal(frame.text, "读取书架里的书名"); assert.equal(frame.tool, "screen.read"); assert.equal(frame.steps.length, 1);
    f.emit("screen.read", { ok: true }, { kind: "response", reply_to: "inner", from: "device:phone" });
    await f.bridge.settled(); assert.equal(f.frames.at(-1)!.text, "等待模型响应");
  } finally { await f.bridge.close(); }
});

test("task stop is owner-only, turn-bound and actually cancels a running task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-task-stop-"));
  const ledger = await Ledger.open(join(dir, "ledger.db"));
  const router = new WorldRouter(ledger, () => true);
  let entered!: () => void; const running = new Promise<void>((r) => { entered = r; });
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), runner: { async runTurn(_i, _e, signal) {
    entered(); await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    return { reason: "error", error: "aborted" };
  } } });
  const reflex = new ReflexMember(router, () => agent.inbox.activeTurn()?.id ?? null);
  const members = new WorldMembers(router); members.register(agent); members.register(reflex);
  const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "token:test", local: true, remote: false, ownerProxy: true };
  const stop = { to: "service:reflex", kind: "request" as const, word: "task.stop", body: { turn: "t_stale" }, wait: true };
  try {
    agent.prepareRecovery(); await router.recover(); await agent.start();
    await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "start" }, wait: true });
    await running; const turn = agent.inbox.activeTurn()!.id;
    const stale = await router.send(owner, stop); assert.deepEqual(stale.reply?.body, { ok: true, result: { cancelled: false } });
    await assert.rejects(router.send({ ...owner, local: false, remote: true }, stop), /local owner/);
    await assert.rejects(router.send({ ...owner, member: "agent:main", transport: "agent", ownerProxy: false }, stop), /local owner/);
    const stopped = await router.send({ ...owner, member: "device:phone", transport: "phone" }, { ...stop, body: { turn } });
    assert.deepEqual(stopped.reply?.body, { ok: true, result: { cancelled: true } });
    assert.equal(agent.inbox.activeTurn(), null);
  } finally { await reflex.close(); await agent.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
