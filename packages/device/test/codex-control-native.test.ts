import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexTransport, NativeTransportError } from "../src/collaboration/codex-transport";
import { CodexControlAdapter, type CodexControlOptions } from "../src/collaboration/codex-control";
import { CodexLiveState } from "../src/collaboration/codex-live-state";
import type { NativeControlInvocation } from "../src/collaboration/control-native-types";
const work = { node_id: "node", endpoint_id: "endpoint", kind: "conversation" as const, native_id: "thread" };
class FakeSocket extends EventEmitter {
  calls: any[] = [];
  status: any = { type: "idle" };
  mode = "normal";
  history: any = { data: [], nextCursor: null };
  onCall?: (call: any) => void;
  nativeTurn?: string;
  send(data: string) {
    const call = JSON.parse(data); this.calls.push(call); this.onCall?.(call);
    if (!call.id) return;
    if (call.method.startsWith("turn/")) {
      if (call.method === "turn/steer" && this.nativeTurn && call.params.expectedTurnId !== this.nativeTurn) { this.emit("message", Buffer.from(JSON.stringify({ id: call.id, error: { code: -32000, message: "native stale turn" } }))); return; }
      if (this.mode === "disconnect") { this.emit("close"); return; }
      if (this.mode === "timeout") return;
      if (this.mode === "error") { this.emit("message", Buffer.from(JSON.stringify({ id: call.id, error: { code: -32601, message: "credential=secret" } }))); return; }
    }
    const result = call.method === "thread/turns/list" ? this.history : call.method === "initialize" ? { userAgent: "codex 0.162.0-alpha.17.2" } : call.method === "turn/steer" ? { turnId: call.params.expectedTurnId } : call.method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread", cwd: "/project", status: this.status } };
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: call.id, result }))));
  }
  close() {}
  event(method: string, params: any, id?: number) { this.emit("message", Buffer.from(JSON.stringify({ method, params, ...(id ? { id } : {}) }))); }
}
async function fixture(timeoutMs = 100, overrides: Partial<CodexControlOptions> = {}) {
  let socket = new FakeSocket(); let valid = true;
  const transport = new CodexTransport({ socket: "/fake.sock", executable: "/fake/codex", pid: 123, supportedVersions: ["0.162.0-alpha.17.2"], timeoutMs,
    verifyListener: () => ({ socket: "/fake.sock", executable: "/fake/codex", pid: 123, version: "0.162.0-alpha.17.2", identity: valid ? "one" : "two" }), connectSocket: async () => socket });
  const adapter = new CodexControlAdapter({ node_id: "node", endpoint_id: "endpoint", transport, validateMetadata: async (_inv, meta) => meta.cwd === "/project", allowSubscription: () => true, ...overrides });
  await adapter.connect(); await adapter.observe(work);
  const invocation = (action: "send_input" | "steer" = "send_input"): NativeControlInvocation => ({ principal: { principal_id: "owner" }, attempt_id: "attempt", connector_epoch: adapter.connector_epoch, native_client_message_id: "persisted-client", native_interface_version: transport.version,
    request: { request_id: "request", operation_id: "operation", work, action, input: { text: "hello" }, expires_at: Date.now() + 5000, ...(action === "steer" ? { expected_turn_id: "turn" } : {}) } });
  return { adapter, transport, invocation, get socket() { return socket; }, invalidate: () => { valid = false; }, reconnect: async () => { socket = new FakeSocket(); await adapter.connect(); } };
}
test("idle starts once with persisted client ID, receipt remains uncertain, duplicate never sends", async () => {
  const f = await fixture(); const inv = f.invocation();
  const result = await f.adapter.invoke(inv); assert.deepEqual(result, { status: "accepted", receipt: { accepted_by: "native", native_turn_id: "turn", correlation: "uncertain" } });
  await assert.rejects(f.adapter.invoke(inv), /result_unknown/);
  const calls = f.socket.calls.filter(c => c.method === "turn/start"); assert.equal(calls.length, 1); assert.equal(calls[0].params.clientUserMessageId, "persisted-client"); f.adapter.close();
});
test("active turn comes from same epoch live event; steer retains expectedTurnId", async () => {
  const f = await fixture(); f.socket.status = { type: "active", activeFlags: [] };
  assert.equal((await f.adapter.invoke(f.invocation("steer"))).status, "rejected");
  f.socket.event("turn/started", { threadId: "thread", turn: { id: "turn" } });
  f.socket.event("item/started", { threadId: "thread", turnId: "turn", item: { id: "tool", type: "commandExecution" } });
  assert.equal((await f.adapter.invoke(f.invocation("steer"))).status, "accepted");
  assert.equal(f.socket.calls.filter(c => c.method === "turn/steer")[0].params.expectedTurnId, "turn"); f.adapter.close();
});
for (const negative of ["completed", "conflicting", "approval", "wrong-turn", "wrong-endpoint", "listener-change"])
  test(`preflight ${negative} cannot send or change action`, async () => {
    const f = await fixture(); f.socket.status = { type: "active", activeFlags: [] }; f.socket.event("turn/started", { threadId: "thread", turn: { id: "turn" } });
    const inv = f.invocation("steer");
    if (negative === "completed") f.socket.event("turn/completed", { threadId: "thread", turn: { id: "turn" } });
    if (negative === "conflicting") f.socket.event("turn/started", { threadId: "thread", turn: { id: "other" } });
    if (negative === "approval") { f.socket.status.activeFlags = ["waitingOnApproval"]; f.socket.event("item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn" }, 99); }
    if (negative === "wrong-turn") inv.request.expected_turn_id = "other";
    if (negative === "wrong-endpoint") inv.request.work = { ...work, endpoint_id: "other" };
    if (negative === "listener-change") f.invalidate();
    try { assert.equal((await f.adapter.invoke(inv)).status, "rejected"); } catch (error) { assert.match(String(error), /permission_denied/); }
    assert.equal(f.socket.calls.filter(c => c.method.startsWith("turn/")).length, 0); assert.equal(f.socket.calls.filter(c => c.id === 99).length, 0); f.adapter.close();
  });
for (const fault of ["disconnect", "timeout", "error"])
  test(`after-send ${fault} stays unknown, reconnect never replays`, async () => {
    const f = await fixture(10); const inv = f.invocation(); f.socket.mode = fault;
    await assert.rejects(f.adapter.invoke(inv), /result_unknown/); assert.equal(f.socket.calls.filter(c => c.method === "turn/start").length, 1);
    const epoch = f.adapter.connector_epoch; await f.reconnect(); assert.notEqual(f.adapter.connector_epoch, epoch);
    assert.equal((await f.adapter.invoke(inv)).status, "rejected"); assert.equal(f.socket.calls.filter(c => c.method.startsWith("turn/")).length, 0); f.adapter.close();
  });
test("late and duplicate events cannot resurrect an ended turn; wrong epoch ignored", () => {
  const state = new CodexLiveState(work, "epoch"); state.metadata({ type: "idle" });
  const event = (method: string, id: string, epoch = "epoch") => state.event({ method, params: { threadId: "thread", turn: { id } } }, epoch);
  event("turn/started", "turn", "old"); assert.equal(state.snapshot().state, "idle");
  event("turn/started", "turn"); event("turn/started", "turn"); event("turn/completed", "turn"); event("turn/completed", "turn"); assert.equal(state.snapshot().state, "idle");
  event("turn/started", "turn"); state.metadata({ type: "idle" }); assert.equal(state.snapshot().state, "unknown");
});
test("malformed and oversized incoming frames close safely; late response ignored", async () => {
  for (const bytes of [Buffer.from("{oops"), Buffer.alloc(1024 * 1024 + 1)]) {
    const f = await fixture(); f.socket.emit("message", bytes); assert.equal(f.transport.epoch, "disconnected");
    f.socket.emit("message", Buffer.from(JSON.stringify({ id: 1, result: { secret: "never surfaced" } }))); assert.equal(f.transport.epoch, "disconnected");
  }
  assert.equal(new NativeTransportError("source_error").message.includes("secret"), false);
});
test("missing persistent mapping and disconnected-before-send fail closed", async () => {
  const f = await fixture(); const inv = f.invocation(); delete (inv as any).native_client_message_id;
  await assert.rejects(f.adapter.invoke(inv), /invalid/); f.socket.emit("close");
  assert.equal((await f.adapter.invoke(f.invocation())).status, "rejected"); assert.equal(f.socket.calls.filter(c => c.method.startsWith("turn/")).length, 0);
});
test("ack before started does not reuse stale idle for a second operation", async () => {
  const f = await fixture(); await f.adapter.invoke(f.invocation());
  const second = f.invocation(); second.attempt_id = "second-attempt"; second.native_client_message_id = "second-client";
  assert.equal((await f.adapter.invoke(second)).status, "rejected");
  assert.equal(f.socket.calls.filter(c => c.method === "turn/start").length, 1); f.adapter.close();
});
test("close while socket factory is pending fences a late connection", async () => {
  let release!: (socket: FakeSocket) => void; const socket = new FakeSocket();
  const transport = new CodexTransport({ socket: "/fake", executable: "/fake/codex", pid: 1, supportedVersions: ["v"], verifyListener: () => ({ socket: "/fake", executable: "/fake/codex", pid: 1, identity: "identity", version: "v" }), connectSocket: () => new Promise(resolve => { release = resolve; }) });
  const connect = transport.connect(); transport.close(); release(socket);
  await assert.rejects(connect, /offline/); assert.equal(transport.epoch, "disconnected"); assert.equal(socket.calls.length, 0);
});
test("unsupported version and methods fail before mutation; source error text is sanitized", async () => {
  const f = await fixture();
  await assert.rejects(f.transport.request("turn/interrupt" as any, {}), /unsupported/);
  assert.equal(f.socket.calls.some(call => call.method === "turn/interrupt"), false);
  f.socket.mode = "error";
  await assert.rejects(f.transport.request("turn/start", {}), error => error instanceof NativeTransportError && error.code === "unsupported" && !error.message.includes("secret"));
  f.adapter.close();
  const transport = new CodexTransport({ socket: "/fake", executable: "/fake", pid: 1, supportedVersions: [], verifyListener: () => ({ socket: "/fake", executable: "/fake", pid: 1, version: "unsupported", identity: "identity" }), connectSocket: async () => { throw new Error("must never connect"); } });
  await assert.rejects(transport.connect(), /unsupported/);
});
test("outgoing body limits and wrong thread do not emit native input", async () => {
  const f = await fixture();
  const inv = f.invocation(); inv.request.work = { ...work, native_id: "wrong-thread" };
  assert.equal((await f.adapter.invoke(inv)).status, "rejected");
  const large = f.invocation(); large.request.input.text = "x".repeat(64 * 1024 + 1);
  await assert.rejects(f.adapter.invoke(large), /too_large/);
  await assert.rejects(f.transport.request("thread/read", { body: "x".repeat(1024 * 1024) }), /too_large/);
  assert.equal(f.socket.calls.some(call => call.method.startsWith("turn/")), false); f.adapter.close();
});
test("unscoped native approval is never answered and invalidates control state", async () => {
  const f = await fixture(); f.socket.event("item/permissions/requestApproval", {}, 777);
  assert.equal((await f.adapter.invoke(f.invocation())).status, "rejected");
  assert.equal(f.socket.calls.some(call => call.id === 777 || call.method.startsWith("turn/")), false); f.adapter.close();
});
test("current scoped source error invalidates activity and cannot be revived by metadata", async () => {
  const f = await fixture(); f.socket.status = { type: "active", activeFlags: [] };
  f.socket.event("turn/started", { threadId: "thread", turn: { id: "turn" } });
  f.socket.event("error", { threadId: "thread", turnId: "turn", willRetry: false, error: { message: "credential=secret" } });
  assert.equal(f.adapter.snapshot(work).state, "unknown");
  assert.equal((await f.adapter.invoke(f.invocation("steer"))).status, "rejected");
  assert.equal(f.socket.calls.some(c => c.method === "turn/steer"), false); f.adapter.close();
});
for (const gate of [2, 3]) test(`observe gate ${gate} cannot return ready after reconnect`, async () => {
  let armed = false, count = 0, entered!: () => void, release!: (value: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(100, { allowSubscription: async () => {
    if (!armed || ++count !== gate) return true;
    entered(); return new Promise<boolean>(resolve => { release = resolve; });
  } });
  await f.reconnect(); armed = true;
  const observe = f.adapter.observe(work); await waiting; await f.reconnect(); release(true);
  await assert.rejects(observe, /offline/); assert.equal(f.adapter.snapshot(work).state, "unknown");
  assert.equal(f.socket.calls.some(c => c.method === "thread/resume"), false); f.adapter.close();
});
test("live snapshot binds full target, current epoch, native source and observation time", async () => {
  const f = await fixture(); const snapshot = f.adapter.snapshot(work);
  assert.deepEqual(snapshot.work, work); assert.equal(snapshot.connector_epoch, f.adapter.connector_epoch); assert.equal(snapshot.source, "codex.live"); assert.ok(Number.isFinite(Date.parse(snapshot.observed_at!)));
  snapshot.work.native_id = "tampered"; assert.equal(f.adapter.snapshot(work).work.native_id, "thread");
  f.socket.emit("close"); const unknown = f.adapter.snapshot(work); assert.equal(unknown.state, "unknown"); assert.equal(unknown.connector_epoch, "disconnected"); assert.equal(unknown.observed_at, null);
});
test("reconcile reader projects only native IDs, has an independent authorization gate, never resumes", async () => {
  const denied = await fixture(); await assert.rejects(denied.adapter.readHistoryPage({ work, limit: 25 }), /permission_denied/); denied.adapter.close();
  const f = await fixture(100, { validateHistoryMetadata: () => true });
  f.socket.history = { data: [{ id: "turn", itemsView: "full", items: [{ id: "item", type: "userMessage", clientId: "persisted-client", content: [{ type: "text", text: "secret body" }] }] }], nextCursor: "next" };
  const before = f.socket.calls.length;
  const page = await f.adapter.readHistoryPage({ work, limit: 25 });
  assert.deepEqual(page.items, [{ source_client_message_id: "persisted-client", native_turn_id: "turn", native_message_id: "item" }]);
  assert.equal(page.connector_epoch, f.adapter.connector_epoch); assert.equal(page.native_interface_version, f.adapter.native_interface_version); assert.equal(page.source, "codex.saved_history"); assert.equal(page.next_cursor, "next"); assert.equal(JSON.stringify(page).includes("secret body"), false);
  assert.deepEqual(f.socket.calls.slice(before).map(c => c.method), ["thread/read", "thread/turns/list"]);
  f.socket.history.data[0].items = Array.from({ length: 26 }, (_, i) => ({ id: `item${i}`, type: "userMessage", clientId: `client${i}` }));
  await assert.rejects(f.adapter.readHistoryPage({ work, limit: 25 }), /too_large/); f.adapter.close();
});
test("history read authorization return gate fences reconnect and never returns old IDs", async () => {
  let calls = 0, entered!: () => void, release!: (value: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(100, { validateHistoryMetadata: async () => { if (++calls === 1) return true; entered(); return new Promise(resolve => { release = resolve; }); } });
  const reading = f.adapter.readHistoryPage({ work, limit: 25 }); await waiting; await f.reconnect(); release(true);
  await assert.rejects(reading, /offline/); f.adapter.close();
});
test("history pagination captures validated primitives before async authorization", async () => {
  let entered!: () => void, release!: (value: boolean) => void, gates = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(100, { validateHistoryMetadata: async () => {
    if (++gates !== 1) return true;
    entered(); return new Promise(resolve => { release = resolve; });
  } });
  const input = { work: { ...work }, limit: 25, cursor: "validated-cursor" };
  const reading = f.adapter.readHistoryPage(input); await waiting;
  input.limit = 100; input.cursor = "invalid\u0000cursor"; input.work.native_id = "another-thread"; release(true);
  await reading;
  const request = f.socket.calls.find(c => c.method === "thread/turns/list");
  assert.equal(request.params.limit, 25); assert.equal(request.params.cursor, "validated-cursor"); assert.equal(request.params.threadId, "thread");
  await assert.rejects(f.adapter.readHistoryPage({ work, limit: 25, cursor: "invalid\u0000cursor" }), /invalid/);
  assert.equal(f.socket.calls.filter(c => c.method === "thread/turns/list").length, 1); f.adapter.close();
});
function setActive(socket: FakeSocket, turns = ["turn"]) {
  socket.status = { type: "active", activeFlags: [] };
  socket.history = { data: turns.map(id => ({ id, status: "inProgress", itemsView: "summary", items: [] })), nextCursor: null };
}
test("late join bootstraps an existing active turn without started or saved running tools", async () => {
  const f = await fixture(); setActive(f.socket);
  const before = f.socket.calls.length;
  f.socket.onCall = call => { if (call.method === "thread/turns/list") f.socket.event("item/started", { threadId: "thread", turnId: "turn", item: { id: "tool", command: "private tool body" } }); };
  await f.adapter.observe(work);
  const snapshot = f.adapter.snapshot(work);
  assert.equal(snapshot.state, "active"); assert.equal(snapshot.turn_id, "turn"); assert.equal(snapshot.identity_provenance, "history_candidate"); assert.equal(snapshot.source, "codex.live");
  assert.equal(JSON.stringify(snapshot).includes("private tool body"), false);
  assert.equal(f.socket.calls.slice(before).find(c => c.method === "thread/turns/list").params.itemsView, "summary");
  assert.equal((await f.adapter.invoke(f.invocation("steer"))).status, "accepted");
  assert.equal(f.socket.calls.filter(c => c.method === "turn/steer").length, 1); assert.equal(f.socket.calls.filter(c => c.method === "turn/start").length, 0); f.adapter.close();
});
for (const negative of ["missing", "multiple", "completed", "error", "approval", "second-turn", "item-conflict", "overflow", "status-changed"])
  test(`late join ${negative} cannot append or substitute start`, async () => {
    const f = await fixture(); setActive(f.socket, negative === "missing" ? [] : negative === "multiple" ? ["turn", "other"] : ["turn"]);
    f.socket.onCall = call => {
      if (call.method !== "thread/turns/list") return;
      if (negative === "completed") f.socket.event("turn/completed", { threadId: "thread", turn: { id: "turn" } });
      if (negative === "error") f.socket.event("error", { threadId: "thread", turnId: "turn", willRetry: false, error: { message: "private" } });
      if (negative === "approval") f.socket.event("item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn" }, 999);
      if (negative === "second-turn") for (const id of ["turn", "other"]) f.socket.event("turn/started", { threadId: "thread", turn: { id } });
      if (negative === "item-conflict") f.socket.event("item/started", { threadId: "thread", turnId: "other", item: { id: "tool" } });
      if (negative === "overflow") for (let i = 0; i < 65; i++) f.socket.event("item/started", { threadId: "thread", turnId: "turn", item: { id: "tool" } });
      if (negative === "status-changed") f.socket.status = { type: "idle" };
    };
    await f.adapter.observe(work);
    assert.notEqual(f.adapter.snapshot(work).state, "active");
    assert.equal((await f.adapter.invoke(f.invocation("steer"))).status, "rejected");
    assert.equal(f.socket.calls.some(c => c.method.startsWith("turn/")), false); assert.equal(f.socket.calls.some(c => c.id === 999), false); f.adapter.close();
  });
test("history never proves busy and a stale candidate is rejected by native expectedTurnId", async () => {
  const f = await fixture(); f.socket.history = { data: [{ id: "turn", status: "inProgress", items: [] }], nextCursor: null };
  await f.adapter.observe(work); assert.equal(f.adapter.snapshot(work).state, "idle");
  assert.equal((await f.adapter.invoke(f.invocation("steer"))).status, "rejected");
  setActive(f.socket); await f.adapter.observe(work); f.socket.nativeTurn = "replacement";
  await assert.rejects(f.adapter.invoke(f.invocation("steer")), /result_unknown/);
  assert.equal(f.socket.calls.filter(c => c.method === "turn/steer").length, 1); assert.equal(f.socket.calls.filter(c => c.method === "turn/start").length, 0); f.adapter.close();
});
for (const terminal of ["error", "turn/completed"]) test(`rearming after ${terminal} recovers idle/new turn without resurrecting the terminal turn`, async () => {
  const f = await fixture(); setActive(f.socket); await f.adapter.observe(work);
  f.socket.event(terminal, { threadId: "thread", turnId: "turn", turn: { id: "turn" }, willRetry: false });
  await f.adapter.observe(work); assert.equal(f.adapter.snapshot(work).state, "unknown");
  f.socket.status = { type: "idle" }; await f.adapter.observe(work); assert.equal(f.adapter.snapshot(work).state, "idle");
  setActive(f.socket, ["new-turn"]); await f.adapter.observe(work); assert.equal(f.adapter.snapshot(work).turn_id, "new-turn");
  const inv = f.invocation("steer"); inv.request.expected_turn_id = "new-turn";
  assert.equal((await f.adapter.invoke(inv)).status, "accepted"); f.adapter.close();
});
test("repeated target rearming does not consume observation slots or permanently remain busy", async () => {
  const f = await fixture(); for (let i = 0; i < 130; i++) await f.adapter.observe(work);
  assert.equal(f.adapter.snapshot(work).state, "idle"); assert.equal(f.socket.calls.filter(c => c.method === "thread/resume").length, 131); f.adapter.close();
});
test("late join gate revocation refuses bootstrap and cannot emit native input", async () => {
  let count = 0, denied = false;
  const f = await fixture(100, { allowSubscription: () => !denied || ++count !== 4 });
  setActive(f.socket); denied = true;
  await assert.rejects(f.adapter.observe(work), /permission_denied/);
  assert.equal(f.adapter.snapshot(work).state, "unknown"); assert.equal(f.socket.calls.some(c => c.method.startsWith("turn/")), false); f.adapter.close();
});
test("late join 64 projected bootstrap events are bounded and a matching started event changes only identity provenance", async () => {
  const f = await fixture(); setActive(f.socket);
  f.socket.onCall = call => {
    if (call.method !== "thread/turns/list") return;
    f.socket.event("turn/started", { threadId: "thread", turn: { id: "turn" } });
    for (let i = 0; i < 63; i++) f.socket.event("item/started", { threadId: "thread", turnId: "turn", item: { id: "tool", command: "private" } });
  };
  await f.adapter.observe(work); assert.equal(f.adapter.snapshot(work).state, "active"); assert.equal(f.adapter.snapshot(work).identity_provenance, "observed_turn_started"); f.adapter.close();
});
test("late join final metadata grant wait vetoes approval events and reconnect", async () => {
  for (const fault of ["approval", "reconnect"]) {
    let armed = false, count = 0, entered!: () => void, release!: (value: boolean) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(100, { allowSubscription: async () => {
      if (!armed || ++count !== 4) return true;
      entered(); return new Promise(resolve => { release = resolve; });
    } });
    setActive(f.socket); armed = true;
    const observing = f.adapter.observe(work); await waiting;
    if (fault === "approval") f.socket.event("item/permissions/requestApproval", { threadId: "thread", turnId: "turn" }, 555);
    else await f.reconnect();
    release(true);
    if (fault === "reconnect") await assert.rejects(observing, /offline/); else await observing;
    assert.equal(f.adapter.snapshot(work).state, "unknown");
    assert.equal(f.socket.calls.some(c => c.method.startsWith("turn/") || c.id === 555), false); f.adapter.close();
  }
});
test("terminal fences persist through connection epochs and stale item events do not poison idle", async () => {
  const f = await fixture(); f.socket.event("turn/started", { threadId: "thread", turn: { id: "turn" } });
  f.socket.event("turn/completed", { threadId: "thread", turn: { id: "turn" } });
  f.socket.event("item/completed", { threadId: "thread", turnId: "turn", item: { id: "late-tool" } });
  assert.equal(f.adapter.snapshot(work).state, "idle");
  await f.reconnect(); setActive(f.socket); await f.adapter.observe(work);
  assert.equal(f.adapter.snapshot(work).state, "unknown"); assert.equal(f.socket.calls.some(c => c.method.startsWith("turn/")), false); f.adapter.close();
});
test("safe observation signal distinguishes source error from an accepted pending start", async () => {
  const errored = await fixture(); assert.equal(errored.adapter.needsObservation(work), false);
  errored.socket.event("error", { threadId: "thread", turnId: "old-turn", willRetry: false });
  assert.equal(errored.adapter.snapshot(work).state, "unknown"); assert.equal(errored.adapter.needsObservation(work), true);
  const epoch = errored.adapter.connector_epoch; await errored.adapter.observe(work);
  assert.equal(errored.adapter.connector_epoch, epoch); assert.equal(errored.adapter.snapshot(work).state, "idle"); assert.equal(errored.adapter.needsObservation(work), false); errored.adapter.close();
  const pending = await fixture(); await pending.adapter.invoke(pending.invocation());
  assert.equal(pending.adapter.snapshot(work).state, "unknown"); assert.equal(pending.adapter.needsObservation(work), false);
  pending.socket.event("error", { threadId: "thread", turnId: "turn", willRetry: false });
  assert.equal(pending.adapter.needsObservation(work), false);
  await assert.rejects(pending.adapter.observe(work), /busy/);
  const second = pending.invocation(); second.attempt_id = "second"; second.native_client_message_id = "second-client";
  assert.equal((await pending.adapter.invoke(second)).status, "rejected");
  assert.equal(pending.socket.calls.filter(c => c.method === "thread/resume").length, 1); assert.equal(pending.socket.calls.filter(c => c.method === "turn/start").length, 1); pending.adapter.close();
});
test("safe observation signal is false while an invocation or bootstrap owns the target and after disconnect", async () => {
  let entered!: () => void, release!: (value: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(100, { validateMetadata: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const invoking = f.adapter.invoke(f.invocation()); await waiting;
  f.socket.event("error", { threadId: "thread", turnId: "turn", willRetry: false });
  assert.equal(f.adapter.needsObservation(work), false); release(true);
  assert.equal((await invoking).status, "rejected"); assert.equal(f.adapter.needsObservation(work), true);
  f.socket.emit("close"); assert.equal(f.adapter.needsObservation(work), false); f.adapter.close();
});
