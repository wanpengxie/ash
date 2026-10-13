/**
 * The remote drivers: a computer's `agent` channel, played by a real `packages/link` client that answers the frame table of
 * the computer program (op / op_result / event / outbound / outbound_result), against the real link server.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type Outgoing, type Reply } from "../../../../sdk/src/message";
import type { AgentDriver, AgentEvent, AgentStartSpec } from "../../../../sdk/src/driver";
import type { HandClient } from "../../../../link/src/hand";
import { createRemoteDrivers, type RemoteDrivers, type RemoteOptions } from "../../../src/edges/agents/remote";
import { eventually } from "../../fixtures/wait";
import { connectViaRelay, newIdentity, startHub, type Hub, type Identity } from "../link-server/harness";
import { fixture, MAIN_TEMPLATE, OWNER, waitFor } from "./helpers";

type Frame = Record<string, any>;
const MAIN = "agent:main";

const RUNTIMES = [
  { kind: "codex", version: "1.2", models: [{ id: "gpt-x", efforts: ["low", "high"] }], abilities: { resume: true, steer: true, inject_live: false, images: false, compact: "unknown", configure: ["model", "effort"], plugins: false, mcp: true, system_prompt: "append", credentials: false, usage: false } },
  { kind: "claude", models: [], abilities: {} },
];

/** The computer program: agents that outlive a connection, the frame table, and what it kept while the hub was away. */
class Computer {
  agents = new Map<string, { kind: string; handles: Record<string, string>; turns: Map<string, string> }>();
  ops: Frame[] = [];
  results: Frame[] = [];
  backlog: Frame[] = [];
  client!: HandClient;
  failStart: { code: string; message: string } | null = null;
  /** Operations the computer receives and never answers. */
  mute = new Set<string>();
  n = 0;
  private open = false;

  constructor(readonly hub: Hub, readonly identity: Identity, readonly runtimes: unknown[] = RUNTIMES) {
    hub.hands.register({ id: identity.handId, name: "书房电脑", kind: "computer", public_key: identity.publicKey, paired_by: "gateway", local_agents: true });
  }
  get id() { return this.identity.handId; }

  async connect(): Promise<void> {
    this.client = connectViaRelay(this.hub, this.id, this.identity, { kind: "computer", name: "书房电脑", channels: { agent: { runtimes: this.runtimes } }, handlers: { agent: (f) => this.onFrame(f as Frame) } }).client;
    await this.client.ready();
    this.open = true;
    const owed = this.backlog.splice(0);
    for (const f of owed) this.out(f);
  }
  /** The connection drops; the agents keep running. */
  drop(): void { this.open = false; this.client.stop(); }

  out(frame: Frame): void {
    if (!this.open) { this.backlog.push(frame); return; }
    this.client.sendAgent({ t: "agent", ...frame } as never);
  }
  emit(event: string, fields: Frame): void { this.out({ event, ...fields }); }

  // -- the test plays the agent --
  say(agent: string, key: string, text: string) { this.emit("output", { agent, key, turn: this.agents.get(agent)!.turns.get(key)!, text }); }
  finish(agent: string, key: string, outcome = "completed") {
    const a = this.agents.get(agent)!;
    this.emit("turn.ended", { agent, key, turn: a.turns.get(key)!, outcome });
    a.turns.delete(key);
  }
  die(agent: string) { this.agents.delete(agent); this.emit("ended", { agent, reason: "killed" }); this.emit("agent.status", { agent, state: "failed", detail: "killed" }); }
  /** The agent calls an Ash tool; resolves with the hub's `outbound_result`. */
  async tool(frame: Frame): Promise<Frame> {
    const id = `o_${++this.n}`;
    const key = frame.key ?? "front";
    this.out({ id, outbound: frame.tool, agent: frame.agent, key, turn: frame.turn ?? this.agents.get(frame.agent)?.turns.get(key) ?? "t0", args: frame.args ?? {} });
    return eventually(() => this.results.find((r) => r.id === id), `outbound_result of ${frame.tool}`, 5000);
  }

  // -- the hub's frames --
  private onFrame(f: Frame): void {
    if (typeof f.outbound_result === "string") { this.results.push(f); return; }
    if (typeof f.op !== "string") return;
    this.ops.push(f);
    if (this.mute.has(f.op)) return;
    const reply = (body: Frame) => this.out({ id: f.id, op_result: f.op, ...body });
    try { reply({ ok: true, result: this.run(f) }); } catch (error) {
      const e = error as WordError;
      reply({ ok: false, error: { code: e.code ?? "failed", message: e.message, ...(e.recovery_hint ? { recovery_hint: e.recovery_hint } : {}) } });
    }
  }
  private run(f: Frame): Frame {
    const a = this.agents.get(f.agent);
    switch (f.op) {
      case "agent.start": {
        if (this.failStart) throw new WordError(this.failStart.code as never, this.failStart.message);
        const spec = f.spec as AgentStartSpec;
        if (a) { // still running: attach and say where every lane is
          for (const [key, handle] of Object.entries(a.handles)) this.emit("handle.updated", { agent: f.agent, key, handle });
          for (const [key, turn] of a.turns) this.emit("turn.started", { agent: f.agent, key, turn });
          return { sessions: a.handles, attached: true };
        }
        const handles = Object.fromEntries(spec.lanes.map((key) => [key, spec.sessions[key] ?? `h-${f.agent}-${key}`]));
        this.agents.set(f.agent, { kind: spec.runtime.kind, handles, turns: new Map() });
        for (const [key, handle] of Object.entries(handles)) this.emit("handle.updated", { agent: f.agent, key, handle });
        return { sessions: handles, attached: false };
      }
      case "agent.stop": this.agents.delete(f.agent); this.emit("agent.status", { agent: f.agent, state: "exited", detail: f.reason }); return {};
      case "send":
      case "followup": {
        if (!a) throw new WordError("not_found", "not running here");
        if (a.turns.has(f.key) && f.op === "send") throw new WordError("conflict", "busy: the session is in a turn");
        const turn = `t${++this.n}`;
        a.turns.set(f.key, turn);
        this.emit("turn.started", { agent: f.agent, key: f.key, turn, ids: f.messages.map((m: Frame) => m.id) });
        return {};
      }
      case "steer": return { accepted: !!a?.turns.has(f.key) };
      case "interrupt": this.finish(f.agent, f.key, "interrupted"); return {};
      case "session.new": case "session.reload": a!.handles[f.key] = `new-${++this.n}`; this.emit("handle.updated", { agent: f.agent, key: f.key, handle: a!.handles[f.key] }); return { handle: a!.handles[f.key] };
      case "session.set": a!.handles[f.key] = f.handle; return {};
      case "session.compact": return { compacted: true, detail: "ok" };
      case "inject": case "restart": return {};
      case "configure": return { model: f.config.model ?? "gpt-x" };
      case "config.get": return { model: "gpt-x", effort: "low" };
      case "plugins": throw new WordError("unavailable", "this runtime has no plugins");
      default: throw new WordError("bad_request", `unknown operation ${f.op}`);
    }
  }
}

const spec = (on: string | undefined, over: Partial<AgentStartSpec> = {}, kind = "codex"): AgentStartSpec => ({
  runtime: { kind }, ...(on ? { native: { on, cwd: "/work" } } : {}), tools: { mcp_url: "http://hub/mcp", tokens: { front: "tok" }, allowed: ["*"] },
  modules: { static: [] }, lanes: ["front", "back"], sessions: {}, ...over,
});

/** A hub with the remote drivers mounted on its link server, and one driver per kind with its events collected. */
async function world(t: test.TestContext, options: Partial<RemoteOptions> = {}) {
  const hub = await startHub();
  t.after(() => hub.stop());
  const replies = new Map<string, (msg: Outgoing) => Reply>();
  const sent: { msg: Outgoing; caller: any; opts: any }[] = [];
  const router = { send: async (msg: Outgoing, caller: any, opts?: any): Promise<Reply> => { sent.push({ msg, caller, opts }); return replies.get(`${msg.to}/${msg.word}`)?.(msg) ?? { ok: true, result: { data: {} } }; } };
  const remote: RemoteDrivers = createRemoteDrivers({ router, reconnectWaitMs: 0, opMs: 3000, startMs: 3000, ...options });
  hub.server.onChannel("agent", remote.attach);
  const events: AgentEvent[] = [];
  const drivers: Record<string, AgentDriver> = {};
  for (const [kind, make] of Object.entries(remote.factories)) drivers[kind] = make((e) => events.push(e));
  const computer = async (runtimes?: unknown[]) => {
    const c = new Computer(hub, await newIdentity(), runtimes);
    await c.connect();
    return c;
  };
  return { hub, remote, router, replies, sent, events, drivers, codex: drivers.codex!, computer, of: (name: AgentEvent["event"]) => events.filter((e) => e.event === name) };
}

/** The agent's lane takes a message and is in a turn; the turn's id. */
async function turnOn(w: Awaited<ReturnType<typeof world>>, agent: string, key: string): Promise<string> {
  const before = w.of("turn.started").length;
  await w.codex.send(agent, key, [{ id: `m-${key}-${before}`, from: "person:owner", word: "say", text: "go", lane: key, at: 1 }]);
  await eventually(() => w.of("turn.started").length === before + 1, "turn.started");
  return (w.of("turn.started")[before] as any).turn;
}

test("start: the computer named by native.on is asked, its sessions are kept for session.get, info is what its hello said", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  assert.deepEqual(w.drivers.codex!.info.models, [{ id: "gpt-x", efforts: ["low", "high"] }]);
  assert.equal(w.drivers.codex!.info.abilities.inject_live, false);
  assert.deepEqual(Object.keys(w.drivers).sort(), ["claude", "codex", "workbuddy"]);
  assert.equal(w.drivers.workbuddy!.info.kind, "workbuddy", "a kind nobody offers still answers with a bare info");

  assert.deepEqual(w.codex.status("agent:x"), { state: "exited" });
  await w.codex.start("agent:x", spec(`device:${c.id}`, { sessions: { front: "resume-me" } }));
  const start = c.ops.find((o) => o.op === "agent.start")!;
  assert.equal(start.agent, "agent:x");
  assert.equal("runtime" in start, false, "the runtime is in the spec only");
  assert.equal(start.spec.runtime.kind, "codex");
  assert.deepEqual(start.spec.lanes, ["front", "back"]);
  assert.equal("tools" in start.spec, false, "the hub's tool address and token do not leave the hub");
  assert.deepEqual(w.codex.status("agent:x"), { state: "running" });
  assert.equal(w.codex.session.get("agent:x", "front"), "resume-me");
  assert.equal(w.codex.session.get("agent:x", "back"), "h-agent:x-back");
  assert.equal(w.codex.session.get("agent:x", "nope"), null);
  assert.deepEqual(w.of("handle.updated").map((e: any) => [e.key, e.handle]).sort(), [["back", "h-agent:x-back"], ["front", "resume-me"]]);
  // the bare hand id, the device: form and the body: form all name the same computer
  await w.codex.stop("agent:x", "test");
  await w.codex.start("agent:x", spec(c.id));
  await w.codex.stop("agent:x", "test");
  await w.codex.start("agent:x", spec(`body:${c.id}`));
});

test("send, followup, steer, interrupt: carried over and the computer's events become report()", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  const batch = [{ id: "m1", from: "person:owner", word: "say", text: "hi", lane: "front", at: 1_700_000_000_000, attachments: [{ name: "a.png", mime_type: "image/png", ref: "blob1" }] }];
  await w.codex.send("agent:x", "front", batch);
  const send = c.ops.find((o) => o.op === "send")!;
  assert.equal(send.key, "front");
  assert.deepEqual(send.messages, batch);
  await eventually(() => w.of("turn.started").length === 1, "turn.started");
  const started = w.of("turn.started")[0] as any;
  assert.deepEqual([started.agent, started.key, started.ids], ["agent:x", "front", ["m1"]]);

  // busy: the computer's conflict is the driver's conflict
  await assert.rejects(w.codex.send("agent:x", "front", batch), (e: WordError) => e.code === "conflict" && /busy/.test(e.message));
  assert.equal(await w.codex.steer("agent:x", "front", "also this"), true);
  assert.equal(await w.codex.steer("agent:x", "back", "nothing runs"), false);
  assert.equal(c.ops.find((o) => o.op === "steer")!.text, "also this");
  await w.codex.followup("agent:x", "back", batch);
  assert.equal(c.ops.filter((o) => o.op === "followup").length, 1);

  c.say("agent:x", "front", "hello");
  c.emit("thought", { agent: "agent:x", key: "front", turn: started.turn, text: "hm" });
  c.emit("tool", { agent: "agent:x", key: "front", turn: started.turn, phase: "start", name: "shell", summary: "ls" });
  await w.codex.interrupt("agent:x", "front");
  assert.ok(c.ops.some((o) => o.op === "interrupt" && o.key === "front"));
  await eventually(() => w.of("turn.ended").length === 1, "turn.ended");
  assert.deepEqual(w.events.filter((e) => e.agent === "agent:x" && e.event !== "handle.updated").map((e) => e.event), ["turn.started", "turn.started", "output", "thought", "tool", "turn.ended"]);
  assert.equal((w.of("output")[0] as any).text, "hello");
  assert.equal((w.of("turn.ended")[0] as any).outcome, "interrupted");
});

test("the other operations: session.*, inject, configure, plugins, restart and the computer's errors", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  const handle = await w.codex.session.new("agent:x", "front");
  assert.equal(handle.handle, "new-1");
  assert.equal(w.codex.session.get("agent:x", "front"), "new-1");
  assert.equal((await w.codex.session.reload("agent:x", "back", { static: [{ id: "rules", version: "v", content: "c" }] })).handle, "new-2");
  assert.deepEqual(c.ops.find((o) => o.op === "session.reload")!.modules, { static: [{ id: "rules", version: "v", content: "c" }] });
  await w.codex.session.set("agent:x", "front", "other");
  assert.equal(w.codex.session.get("agent:x", "front"), "other");
  assert.deepEqual(await w.codex.session.compact("agent:x", "front"), { compacted: true, detail: "ok" });
  await w.codex.inject("agent:x", "front", { text: "note" });
  assert.deepEqual([c.ops.find((o) => o.op === "inject")!.text, "modules" in c.ops.find((o) => o.op === "inject")!], ["note", false]);
  assert.deepEqual(await w.codex.configure("agent:x", undefined, { model: "gpt-y" }), { model: "gpt-y" });
  assert.deepEqual(await w.codex.configure("agent:x", "front"), { model: "gpt-x", effort: "low" });
  assert.equal(c.ops.filter((o) => o.op === "config.get")[0]!.key, "front");
  await assert.rejects(w.codex.plugins("agent:x", "list"), (e: WordError) => e.code === "unavailable");
  await w.codex.restart("agent:x");
  assert.ok(c.ops.some((o) => o.op === "restart"));
  // an agent the hub did not start is not running
  await assert.rejects(w.codex.interrupt("agent:never", "front"), (e: WordError) => e.code === "offline");
});

test("stop is asked of the computer and is not reported as ended; the computer's own exit status is not an end either", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  await w.codex.stop("agent:x", "owner asked");
  assert.equal(c.ops.find((o) => o.op === "agent.stop")!.reason, "owner asked");
  assert.equal(c.agents.size, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.of("ended").length, 0);
  assert.deepEqual(w.codex.status("agent:x"), { state: "exited" });
  await w.codex.stop("agent:x", "again"); // nothing to stop is fine
});

test("a process that dies on the computer is reported as ended once", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  c.die("agent:x");
  await eventually(() => w.of("ended").length === 1, "ended");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.of("ended").length, 1, "the status frame after the event does not repeat it");
  assert.equal((w.of("ended")[0] as any).reason, "killed");
  assert.equal(w.codex.status("agent:x").state, "failed");
});

test("outbound: the agent's tool call goes through the router as that agent and the answer goes back", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  w.replies.set("service:agents/list", () => ({ ok: true, result: { data: { agents: [{ id: "agent:main" }] } } }));
  w.replies.set("service:agents/ask", (m) => ({ ok: true, result: { data: { answer: `re: ${(m.body as any).text}` } } }));
  w.replies.set("service:agents/tell", () => ({ ok: false, error: { code: "forbidden", message: "not yours to tell" } }));

  const t9 = await turnOn(w, "agent:x", "front");
  const list = await c.tool({ tool: "agent_list", agent: "agent:x", turn: t9 });
  assert.deepEqual([list.outbound_result, list.ok, list.result], ["agent_list", true, { agents: [{ id: "agent:main" }] }]);
  assert.deepEqual(w.sent[0]!.msg, { to: "service:agents", kind: "request", word: "list", body: {} });
  assert.equal(w.sent[0]!.caller.member, "agent:x");
  assert.equal(w.sent[0]!.caller.via, "agent");
  assert.equal(w.sent[0]!.caller.turn, t9);

  const ask = await c.tool({ tool: "agent_ask", agent: "agent:x", args: { agent: "agent:main", text: "q?", extra: "dropped" } });
  assert.deepEqual([ask.ok, ask.result], [true, { answer: "re: q?" }]);
  assert.deepEqual(w.sent[1]!.msg.body, { agent: "agent:main", text: "q?" });

  const tell = await c.tool({ tool: "agent_tell", agent: "agent:x", args: { agent: "agent:main", text: "fyi" } });
  assert.deepEqual([tell.ok, tell.error], [false, { code: "forbidden", message: "not yours to tell" }]);

  const bad = await c.tool({ tool: "agent_tell", agent: "agent:x", args: { agent: "agent:main" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "bad_request");
  const other = await c.tool({ tool: "capability_call", agent: "agent:x", args: {} });
  assert.equal(other.error.code, "not_found");
  assert.equal(w.sent.length, 3, "refused calls never reach the router");
});

test("outbound: a computer cannot speak for an agent that is not its own, and a call in flight is cancelled with the connection", async (t) => {
  const w = await world(t);
  const a = await w.computer();
  const b = await w.computer();
  await w.codex.start("agent:x", spec(a.id));
  await turnOn(w, "agent:x", "front");
  const forged = await b.tool({ tool: "agent_tell", agent: "agent:x", args: { agent: "agent:main", text: "forged" } });
  assert.deepEqual([forged.ok, forged.error.code], [false, "forbidden"]);
  const unknown = await b.tool({ tool: "agent_list", agent: "agent:main" });
  assert.equal(unknown.error.code, "forbidden");
  // events likewise: b says things about a's agent, and they go nowhere
  b.emit("output", { agent: "agent:x", key: "front", turn: "t1", text: "forged" });
  b.emit("ended", { agent: "agent:x", reason: "forged" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.of("output").length + w.of("ended").length, 0);
  assert.equal(w.sent.length, 0);

  let aborted = false;
  w.router.send = async (_m, _c, opts) => new Promise((resolve) => { opts?.signal?.addEventListener("abort", () => { aborted = true; resolve({ ok: false, error: { code: "cancelled", message: "x" } }); }); });
  void a.tool({ tool: "agent_ask", agent: "agent:x", args: { agent: "agent:main", text: "slow" } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  a.drop();
  await eventually(() => aborted, "the in-flight tool call aborted");
});

test("outbound: the lane's turn is the hub's own record; a call cannot name another lane's turn or a turn that is over", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id, { tools: { mcp_url: "u", tokens: { front: "a", back: "b" }, allowed: ["*"] } }, "codex"));
  const idle = await c.tool({ tool: "agent_list", agent: "agent:x", key: "back", turn: "t-made-up" });
  assert.deepEqual([idle.ok, idle.error.code], [false, "forbidden"]);

  const front = await turnOn(w, "agent:x", "front");
  const back = await turnOn(w, "agent:x", "back");
  assert.notEqual(front, back);
  const own = await c.tool({ tool: "agent_list", agent: "agent:x", key: "back" });
  assert.equal(own.ok, true);
  assert.equal(w.sent.at(-1)!.caller.turn, back, "the back lane's call is in the back lane's turn");
  const borrowed = await c.tool({ tool: "agent_list", agent: "agent:x", key: "back", turn: front });
  assert.deepEqual([borrowed.ok, borrowed.error.code], [false, "forbidden"], "the back lane cannot name the front lane's turn");
  const unknown = await c.tool({ tool: "agent_list", agent: "agent:x", key: "nope", turn: front });
  assert.equal(unknown.ok, false);
  assert.equal(w.sent.length, 1, "refused calls never reach the router");

  c.finish("agent:x", "back");
  await eventually(() => w.of("turn.ended").length === 1, "turn.ended");
  const over = await c.tool({ tool: "agent_list", agent: "agent:x", key: "back", turn: back });
  assert.deepEqual([over.ok, over.error.code], [false, "forbidden"], "a turn that is over is not one");
  assert.equal((await c.tool({ tool: "agent_list", agent: "agent:x", key: "front" })).ok, true);
  assert.equal(w.sent.at(-1)!.caller.turn, front);
});

test("disconnect: the agents on that computer are reported ended; the computer comes back and start attaches", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  await w.codex.send("agent:x", "front", [{ id: "m1", from: "person:owner", word: "say", text: "go", lane: "front", at: 1 }]);
  await eventually(() => w.of("turn.started").length === 1, "turn.started");
  const turn = (w.of("turn.started")[0] as any).turn;

  c.drop();
  await eventually(() => w.of("ended").length === 1, "ended on disconnect");
  assert.match((w.of("ended")[0] as any).reason, /书房电脑 disconnected/);
  assert.equal(w.codex.status("agent:x").state, "exited");
  await assert.rejects(w.codex.send("agent:x", "front", []), (e: WordError) => e.code === "offline");
  // while it is away the agent finishes the turn and says something; the computer keeps both
  c.say("agent:x", "front", "done while away");
  c.finish("agent:x", "front");
  c.agents.get("agent:x")!.turns.set("back", "t-bg"); // and a turn started on the other lane, which the computer also kept
  c.emit("turn.started", { agent: "agent:x", key: "back", turn: "t-bg" });
  assert.equal(w.codex.session.get("agent:x", "front"), "h-agent:x-front", "what the hub knew is kept while the computer is away");

  w.events.length = 0;
  await c.connect();
  await w.codex.start("agent:x", spec(c.id, { sessions: { front: "h-agent:x-front" } }));
  const start = c.ops.filter((o) => o.op === "agent.start").at(-1)!;
  assert.equal(start.agent, "agent:x");
  // what the computer kept comes first, in order, then where every lane is now
  assert.deepEqual(w.events.map((e: any) => `${e.event}${e.key ? `/${e.key}` : ""}`), ["output/front", "turn.ended/front", "turn.started/back", "handle.updated/front", "handle.updated/back"]);
  assert.equal((w.events[0] as any).turn, turn);
  assert.equal(w.codex.status("agent:x").state, "running");
  assert.equal(w.codex.session.get("agent:x", "front"), "h-agent:x-front");
  // a computer that has no such agent any more starts it over
  c.agents.clear();
  await w.codex.stop("agent:x", "t");
  await w.codex.start("agent:x", spec(c.id));
});

test("agent.status is a state, not an end: only the ended event restarts; a failed status alone changes nothing the module sees", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  c.emit("agent.status", { agent: "agent:x", state: "failed", detail: "reported by the computer" });
  c.emit("agent.status", { agent: "agent:x", state: "exited", detail: "stopped" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.of("ended").length, 0);
  assert.equal(w.codex.status("agent:x").state, "running");
});

test("outbound: the declaration's tool list is enforced, and a call still open when its turn ends fails", async (t) => {
  const w = await world(t);
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id, { tools: { mcp_url: "u", tokens: { front: "t" }, allowed: ["agent_list", "agent_ask"] } }));
  const denied = await c.tool({ tool: "agent_tell", agent: "agent:x", args: { agent: "agent:main", text: "x" } });
  assert.deepEqual([denied.ok, denied.error.code], [false, "forbidden"]);
  assert.equal(w.sent.length, 0);

  let aborted = false;
  w.router.send = async (_m, _c, opts) => new Promise((resolve) => { opts?.signal?.addEventListener("abort", () => { aborted = true; resolve({ ok: false, error: { code: "cancelled", message: "x" } }); }); });
  await w.codex.send("agent:x", "front", [{ id: "m1", from: "person:owner", word: "say", text: "go", lane: "front", at: 1 }]);
  await eventually(() => w.of("turn.started").length === 1, "turn.started");
  const turn = (w.of("turn.started")[0] as any).turn;
  const waiting = c.tool({ tool: "agent_ask", agent: "agent:x", key: "front", turn, args: { agent: "agent:main", text: "slow" } });
  await new Promise((r) => setTimeout(r, 30));
  c.finish("agent:x", "front");
  const result = await waiting;
  assert.deepEqual([result.ok, result.error.code], [false, "cancelled"]);
  await eventually(() => aborted, "the router call aborted");
});

test("start fails when the computer is not there, was not allowed, or does not offer the runtime; nothing moves to another body", async (t) => {
  const w = await world(t);
  const other = await w.computer();
  const wanted = new Computer(w.hub, await newIdentity()); // paired but never connected
  await assert.rejects(w.codex.start("agent:x", spec(wanted.id)), (e: WordError) => e.code === "unavailable" && /not connected/.test(e.message));
  assert.equal(other.ops.length, 0, "the other computer was not tried");
  await assert.rejects(w.codex.start("agent:x", spec(undefined)), (e: WordError) => e.code === "bad_request" && /native\.on/.test(e.message));
  await assert.rejects(w.codex.start("agent:x", spec("body:main")), (e: WordError) => e.code === "bad_request");
  await assert.rejects(w.drivers.workbuddy!.start("agent:x", spec(other.id, {}, "workbuddy")), (e: WordError) => e.code === "unavailable" && /does not offer workbuddy/.test(e.message));
  await assert.rejects(w.codex.start("agent:x", spec(other.id, {}, "claude")), (e: WordError) => e.code === "bad_request");
  assert.deepEqual(w.codex.status("agent:x"), { state: "exited" });
  // the computer refuses: its error comes through with its code, and nothing is left behind
  other.failStart = { code: "unavailable", message: "codex is not signed in" };
  await assert.rejects(w.codex.start("agent:x", spec(other.id)), (e: WordError) => e.code === "unavailable" && /not signed in/.test(e.message));
  assert.deepEqual(w.codex.status("agent:x"), { state: "exited" });
  // a computer the owner has not allowed to run agents never gets the channel at all
  const plain = new Computer(w.hub, await newIdentity());
  w.hub.hands.setAccess(plain.id, { local_agents: false });
  await plain.connect();
  await assert.rejects(w.codex.start("agent:y", spec(plain.id)), (e: WordError) => e.code === "unavailable");
});

test("a computer that is not connected is waited for, so a blink or a hub restart does not use up the manager's tries", async (t) => {
  const w = await world(t, { reconnectWaitMs: 5000 });
  const c = await w.computer();
  c.drop();
  await new Promise((r) => setTimeout(r, 50));
  const starting = w.codex.start("agent:x", spec(c.id));
  await new Promise((r) => setTimeout(r, 50));
  await c.connect();
  await starting;
  assert.equal(w.codex.status("agent:x").state, "running");
  // a computer that never comes is waited for, then start fails
  const never = new Computer(w.hub, await newIdentity());
  const quick = await world(t, { reconnectWaitMs: 100 });
  await assert.rejects(quick.codex.start("agent:y", spec(never.id)), (e: WordError) => e.code === "unavailable" && /not connected/.test(e.message));
});

test("an operation the computer never answers times out; one cut by a disconnect is result_unknown", async (t) => {
  const w = await world(t, { opMs: 80 });
  const c = await w.computer();
  await w.codex.start("agent:x", spec(c.id));
  c.mute.add("interrupt").add("steer");
  await assert.rejects(w.codex.interrupt("agent:x", "front"), (e: WordError) => e.code === "timeout");
  const cut = w.codex.steer("agent:x", "front", "x");
  await eventually(() => c.ops.some((o) => o.op === "steer"), "steer reached the computer");
  c.drop();
  await assert.rejects(cut, (e: WordError) => e.code === "result_unknown");
});

test("through the agents module: declared on a computer, a message becomes a turn there, its speech reaches the owner, and a blink restarts it attached", async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());
  let routed: ((msg: Outgoing, caller: any, opts?: any) => Promise<Reply>) | null = null;
  const remote = createRemoteDrivers({ router: { send: (m, c, o) => routed!(m, c, o) }, reconnectWaitMs: 5000, opMs: 3000, startMs: 3000 });
  hub.server.onChannel("agent", remote.attach);
  const c = new Computer(hub, await newIdentity());
  await c.connect();
  const f = fixture({ templates: { main: { ...MAIN_TEMPLATE, runtime: { kind: "codex" }, native: { on: c.id, cwd: "/work" } } }, drivers: remote.factories });
  routed = (m, who) => f.router.send(m, who);
  await f.start();

  const start = c.ops.find((o) => o.op === "agent.start")!;
  assert.equal(start.agent, MAIN);
  assert.deepEqual(start.spec.lanes, ["front", "back"]);
  assert.equal("tools" in start.spec, false);
  assert.deepEqual(Object.keys(f.agents.manager.runs.get(MAIN)!.spec.sessions), ["front", "back"]);
  assert.equal(f.agents.manager.stateOf(MAIN), "idle");

  await f.call(MAIN, "say", { text: "hello there" }, OWNER);
  await eventually(() => c.ops.some((o) => o.op === "send"), "send on the computer");
  const send = c.ops.find((o) => o.op === "send")!;
  assert.equal(send.key, "front");
  assert.equal(send.messages[0].text, "hello there");
  await waitFor(() => f.agents.manager.stateOf(MAIN) === "working");
  c.say(MAIN, "front", "hi owner");
  // its tool call is the agent's own words, under its declaration, in the turn it is in
  f.router.on("service:agents/list", () => ({ ok: true, result: { data: { agents: [] } } }));
  const list = await c.tool({ tool: "agent_list", agent: MAIN, key: "front" });
  assert.equal(list.ok, true);
  c.finish(MAIN, "front");
  await waitFor(() => f.router.says().some((s) => s.text === "hi owner"));
  assert.deepEqual(f.router.says().find((s) => s.text === "hi owner")!.from, MAIN);
  await waitFor(() => f.agents.manager.stateOf(MAIN) === "idle");

  // the wire drops: the module sees the agent end, starts it again, and the computer says it attached
  c.drop();
  await c.connect();
  await eventually(() => c.ops.filter((o) => o.op === "agent.start").length === 2 && f.agents.manager.stateOf(MAIN) === "idle", "restarted and attached");
  assert.equal(c.agents.size, 1, "the agent was never started over on the computer");
  assert.ok(f.logs.every((l) => !/did not start/.test(String(l[0]))));
});

// -- the app attached to a computer (the Codex App, through `ash-device mcp`) ---------------------------------------------------

/** What the hub gives the attached callers: a stub that records. */
function attachedPort() {
  const calls: { agent: string; turn: string; tool: string; args: unknown; signal: AbortSignal }[] = [];
  const dropped: string[] = [];
  let hold: ((value: unknown) => void) | null = null;
  const port = {
    declare: (computer: string, name: string) => ({ id: `agent:codex-${name.length}`, name: `${name} 上的 Codex`, computer }),
    drop: (computer: string) => { dropped.push(computer); },
    tools: (agent: string) => [{ name: "agent_list", description: `for ${agent}`, inputSchema: { type: "object" } }],
    call: (agent: string, turn: string, tool: string, args: unknown, signal: AbortSignal): Promise<unknown> => {
      calls.push({ agent, turn, tool, args, signal });
      if (tool === "slow") return new Promise((resolve, reject) => { hold = resolve; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
      if (tool === "boom") return Promise.reject(new Error("the hub could not do it"));
      return Promise.resolve({ content: [{ type: "text", text: "ok" }], structuredContent: { tool } });
    },
  };
  return { port, calls, dropped, release: () => hold?.({ content: [] }) };
}

/** The computer sends an attached frame (no agent, no turn) and waits for the answer. */
async function attachedCall(c: Computer, tool: string, args: Frame = {}, session?: string): Promise<Frame> {
  const id = `a_${++c.n}`;
  c.out({ id, outbound: tool, attached: session ? { session } : {}, args });
  return eventually(() => c.results.find((r) => r.id === id), `outbound_result of ${tool}`, 5000);
}

test("attached: a call with no agent and no turn goes to the hub's port as the computer's own caller, and the answer goes back", async (t) => {
  const stub = attachedPort();
  const w = await world(t, { attached: stub.port });
  const c = await w.computer();
  const list = await attachedCall(c, "tools/list");
  assert.deepEqual([list.ok, list.outbound_result], [true, "tools/list"]);
  assert.deepEqual(list.result.tools.map((x: any) => x.name), ["agent_list"]);
  assert.equal(list.result.caller.name, "书房电脑 上的 Codex");
  assert.equal(stub.calls.length, 0, "the list is not a call");

  const done = await attachedCall(c, "agent_list", { x: 1 }, "sess-1");
  assert.deepEqual([done.ok, done.result.structuredContent], [true, { tool: "agent_list" }]);
  assert.deepEqual([stub.calls[0]!.agent, stub.calls[0]!.turn, stub.calls[0]!.tool, stub.calls[0]!.args], ["agent:codex-4", "codex-sess-1", "agent_list", { x: 1 }]);
  const noSession = await attachedCall(c, "agent_list");
  assert.equal(noSession.ok, true);
  assert.equal(stub.calls[1]!.turn, "codex-session");
  assert.equal(w.sent.length, 0, "the directory itself sent nothing to the router: the port does");
  assert.equal(w.codex.status("agent:codex-4").state, "exited", "nothing was started: Ash does not run it");
});

test("attached: an error of the hub comes back as the call's error; a hub without the port refuses; a frame with no `attached` is still an agent's", async (t) => {
  const stub = attachedPort();
  const w = await world(t, { attached: stub.port });
  const c = await w.computer();
  const boom = await attachedCall(c, "boom");
  assert.deepEqual([boom.ok, boom.error.code, boom.error.message], [false, "failed", "the hub could not do it"]);
  const agentStyle = await c.tool({ tool: "agent_list", agent: "agent:nobody", args: {} });
  assert.equal(agentStyle.error.code, "forbidden", "the agent's own path is as before");

  const bare = await world(t);
  const d = await bare.computer();
  const refused = await attachedCall(d, "agent_list");
  assert.deepEqual([refused.ok, refused.error.code], [false, "unavailable"]);
});

test("attached: a call in flight is cancelled with the connection, and the caller is dropped", async (t) => {
  const stub = attachedPort();
  const w = await world(t, { attached: stub.port });
  const c = await w.computer();
  const id = `a_${++c.n}`;
  c.out({ id, outbound: "slow", attached: {}, args: {} });
  await eventually(() => stub.calls.length === 1, "the call reached the port");
  c.drop();
  await eventually(() => stub.calls[0]!.signal.aborted, "the call was cancelled");
  await eventually(() => stub.dropped.length === 1, "the caller was dropped");
  assert.equal(stub.dropped[0], c.id);
});
