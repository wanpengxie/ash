import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCapabilitySpec } from "../../sdk/src/link";
import { WordError } from "../../sdk/src/message";
import { isExtensionName } from "../../sdk/src/namespaces";
import { CodexApp, CODEX_CAPABILITIES, applyPatches, canonicalTurns, type Listed } from "../src/codex-app";
import { createHand } from "../src/hand";
import { Desktop, snapshot, turn, until, type F } from "./fake-codex-desktop";

async function fixture(t: { after(fn: () => unknown): void }, over: F = {}) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-cx-"));
  const desktop = new Desktop(join(dir, "ipc.sock"));
  await desktop.listen();
  await desktop.owner();
  const events: [string, F][] = [];
  const changes: boolean[] = [];
  const listed: Listed[] = over.listed ?? [{ id: "t1", title: "Fix the build", cwd: "/work/app", updated_at: 2000 }, { id: "t2", title: "Old idea", updated_at: 1000 }];
  const app = new CodexApp({ socketPath: desktop.path, reconnectMs: 30, ownerWaitMs: 200, openWaitMs: 1500, openThread: over.openThread ?? (async () => {}), startThread: over.startThread, listThreads: over.listThreads ?? (async () => listed), readThread: over.readThread ?? (async () => null), onChange: () => changes.push(app.online), onEvent: (w, b) => events.push([w, b]) });
  app.start();
  t.after(async () => { await app.close(); await desktop.stop().catch(() => {}); });
  await until(() => app.online, "joining the app");
  return { desktop, app, events, changes };
}

const code = (c: string) => (e: unknown) => e instanceof WordError && e.code === c;

// ---------------------------------------------------------------------------------------------------------------------

test("it joins the app's channel as one more client, says no to every discovery, and asks which sessions are open", async (t) => {
  const { desktop } = await fixture(t);
  const me = desktop.got.find((f) => f.method === "initialize" && f.params.clientType === "ash")!;
  assert.ok(me, "registered");
  await until(() => desktop.discovery.some((d) => d.requestId === `d${me.from}`), "the discovery answer");
  assert.deepEqual(desktop.discovery.filter((d) => d.requestId === `d${me.from}`).map((d) => d.response), [{ canHandle: false }]);
  await until(() => desktop.got.some((f) => f.method === "thread-stream-following-status-requested"), "the follow query");
  const q = desktop.got.find((f) => f.method === "thread-stream-following-status-requested")!;
  assert.deepEqual([q.type, q.targetClientIds, q.version], ["broadcast", null, 1]);
});

test("the sessions: those the app has open come with their state, running first; the others as the runtime lists them", async (t) => {
  const { desktop, app } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot({ threadRuntimeStatus: { type: "active" }, turns: [turn("u1", "inProgress", [])] }) });
  desktop.state.set("t3", { revision: 1, raw: snapshot({ id: "t3", name: "Waiting one", cwd: "/w3", requests: [{ id: 7, method: "item/commandExecution/requestApproval", params: { command: "rm -rf build", cwd: "/w3" } }] }) });
  const { sessions } = await app.sessions();
  assert.deepEqual(sessions.map((s) => [s.id, s.state, s.open]), [["t1", "running", true], ["t3", "waiting_approval", true], ["t2", "idle", false]]);
  assert.equal(sessions[0].title, "Fix the build");
  assert.equal(sessions[0].cwd, "/work/app");
  assert.equal(sessions[0].updated_at, 2000);
  assert.equal(sessions[2].title, "Old idea");
});

test("one session: the last turns with what was said and run (long texts cut), also when the history sits in turnHistory", async (t) => {
  const { desktop, app } = await fixture(t);
  const long = "x".repeat(900);
  desktop.state.set("t1", { revision: 1, raw: snapshot({
    turns: [],
    turnHistory: { history: { entitiesByKey: {
      a: turn("u1", "completed", [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }, { type: "agentMessage", text: long }]),
      b: turn("u2", "completed", [{ type: "userMessage", content: [{ type: "text", text: "and then" }] }, { type: "commandExecution", command: "npm test", status: "completed" }, { type: "agentMessage", text: "done" }]),
    }, islands: [{ entries: [{ key: "a" }, { key: "b" }] }] } },
  }) });
  const one = await app.session("t1", 1, 100);
  assert.equal(one.open, true);
  assert.equal(one.turns.length, 1);
  assert.deepEqual(one.turns[0].items.map((i) => [i.kind, i.text]), [["user", "and then"], ["command", "npm test"], ["agent", "done"]]);
  const both = await app.session("t1", 5, 100);
  assert.equal(both.turns[0].items[1].text!.length, 101, "cut at 100 and marked");
  assert.equal(canonicalTurns(desktop.state.get("t1")!.raw).length, 2);
});

test("a past session is read from the runtime; sending to it has the app open it first", async (t) => {
  const asked: string[] = [];
  let desktop!: Desktop;
  const fx = await fixture(t, {
    readThread: async (id: string) => id === "t2" ? { id, name: "Old idea", turns: [turn("u1", "completed", [{ type: "agentMessage", text: "saved" }])] } : null,
    // The app takes the session up when its link is opened.
    openThread: async (id: string) => { asked.push(id); desktop.state.set(id, { revision: 1, raw: snapshot({ id, name: "Old idea" }) }); },
  });
  desktop = fx.desktop;
  const saved = await fx.app.session("t2");
  assert.deepEqual([saved.open, saved.state, saved.turns[0].items[0].text], [false, "idle", "saved"]);
  await assert.rejects(fx.app.session("nope"), code("not_found"));
  await assert.rejects(fx.app.send("nope", "hi"), code("not_found"), "no such session: nothing is opened");
  assert.deepEqual(asked, []);
  const sent = await fx.app.send("t2", "carry on", "m-9");
  assert.deepEqual([sent.sent, sent.mode, asked], [true, "start", ["t2"]]);
  const opened = await fx.app.open("t2");
  assert.deepEqual([opened.opened, opened.already, asked.length], [true, true, 1], "already open: not asked again");
});

test("a new session: made in the project's directory, named, opened in the app, and its first message sent there", async (t) => {
  const made: [string, string][] = [];
  let desktop!: Desktop;
  const fx = await fixture(t, {
    startThread: async (cwd: string, title: string) => { made.push([cwd, title]); return "t9"; },
    openThread: async (id: string) => { desktop.state.set(id, { revision: 1, raw: snapshot({ id, name: "Plan the trip" }) }); },
  });
  desktop = fx.desktop;
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-proj-"));
  const out = await fx.app.create(dir, "Plan the trip\nwith the kids", undefined);
  assert.deepEqual([out.thread, out.title, out.cwd, out.sent], ["t9", "Plan the trip", dir, true]);
  assert.deepEqual(made, [[dir, "Plan the trip"]]);
  const start = desktop.owned.find((f) => f.method === "thread-follower-start-turn")!;
  assert.equal(start.params.conversationId, "t9");
  await assert.rejects(fx.app.create("relative/dir", "hi"), code("bad_request"));
  await assert.rejects(fx.app.create(join(dir, "missing"), "hi"), code("bad_request"));
});

test("the session list: the last good one is kept when a read fails or is slow, and read again behind it", async (t) => {
  let calls = 0, fail = false;
  let now = 1_000_000;
  const fx = await fixture(t, { listThreads: async () => { calls++; if (fail) throw new Error("runtime control timed out"); return [{ id: "t1", title: "One" }, { id: "t2", title: "Two" }]; } });
  (fx.app as any).o.now = () => now;
  assert.equal((await fx.app.sessions()).sessions.length, 2);
  fail = true; now += 10_000;
  assert.equal((await fx.app.sessions()).sessions.length, 2, "answered from the last list while it is read again");
  await until(() => calls >= 2, "the read behind it");
  now += 10_000;
  assert.equal((await fx.app.sessions()).sessions.length, 2, "a failed read does not shrink the list");
});

test("the owner's sessions only: those Ash's helper agents ran are left out unless asked for", async (t) => {
  const fx = await fixture(t, { listed: [{ id: "t1", title: "Mine" }, { id: "h1", title: "[conversation batch]", helper: true }] });
  assert.deepEqual((await fx.app.sessions()).sessions.map((s) => s.id), ["t1"]);
  assert.deepEqual((await fx.app.sessions(30, true)).sessions.map((s) => s.id), ["t1", "h1"]);
});

test("a past session the app does not take up (the computer locked) is unavailable, not lost", async (t) => {
  const { app } = await fixture(t, { readThread: async (id: string) => ({ id, turns: [] }) });
  await assert.rejects(app.open("t2"), code("unavailable"));
  await assert.rejects(app.send("t2", "hi"), code("unavailable"));
});

test("send: an idle session starts a turn, a running one takes it as an addition; the message id is passed on", async (t) => {
  const { desktop, app } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot() });
  const first = await app.send("t1", "run the tests", "m-1");
  assert.deepEqual([first.sent, first.mode], [true, "start"]);
  const start = desktop.owned.find((f) => f.method === "thread-follower-start-turn")!;
  assert.equal(start.version, 2);
  assert.deepEqual([start.params.conversationId, start.params.turnStart.request.threadId, start.params.turnStart.request.clientUserMessageId], ["t1", "t1", "m-1"]);
  assert.deepEqual(start.params.turnStart.request.input, [{ type: "text", text: "run the tests", text_elements: [] }]);
  assert.deepEqual(start.targetClientIds, [desktop.ownerId]);

  desktop.change("t1", snapshot({ threadRuntimeStatus: { type: "active" }, turns: [turn("u9", "inProgress", [])] }));
  await until(() => (app as any).convs.get("t1")?.revision === 2, "the running snapshot");
  const second = await app.send("t1", "also lint", "m-2");
  assert.deepEqual([second.sent, second.mode], [true, "steer"]);
  const steer = desktop.owned.find((f) => f.method === "thread-follower-steer-turn")!;
  assert.deepEqual([steer.params.clientUserMessageId, steer.params.input[0].text, steer.params.restoreMessage.text], ["m-2", "also lint", "also lint"]);
  assert.equal(desktop.owned.filter((f) => f.method === "thread-follower-start-turn").length, 1);
});

test("send: the turn had ended after all (the app says so) → a new turn; an unclear answer is never sent again", async (t) => {
  const { desktop, app } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot({ threadRuntimeStatus: { type: "active" }, turns: [turn("u9", "inProgress", [])] }) });
  desktop.fail.set("thread-follower-steer-turn", "SteerTurnInactiveError: active turn already ended");
  const a = await app.send("t1", "late", "m-3");
  assert.equal(a.mode, "start");
  assert.equal(desktop.owned.filter((f) => f.method === "thread-follower-start-turn").length, 1);

  desktop.fail.delete("thread-follower-steer-turn");
  desktop.owned.length = 0;
  desktop.silent.add("thread-follower-steer-turn"); // the owner drops the connection without answering
  await assert.rejects(app.send("t1", "maybe", "m-4"), code("result_unknown"));
  assert.equal(desktop.owned.filter((f) => f.method === "thread-follower-start-turn").length, 0, "no second send after a lost answer");
});

test("send with the same client_id twice reaches the app once", async (t) => {
  const { desktop, app } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot() });
  const a = await app.send("t1", "once", "same");
  const b = await app.send("t1", "once", "same");
  assert.equal(a.mode, "start");
  assert.equal(b.repeated, true);
  assert.equal(desktop.owned.filter((f) => f.method === "thread-follower-start-turn").length, 1);
});

test("stop interrupts the turn that is running; an idle session has nothing to stop", async (t) => {
  const { desktop, app } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot({ threadRuntimeStatus: { type: "active" }, turns: [turn("turn-2", "inProgress", [])] }) });
  const done = await app.stop("t1");
  assert.deepEqual([done.stopped, done.turn], [true, "turn-2"]);
  const sent = desktop.owned.find((f) => f.method === "thread-follower-interrupt-turn")!;
  assert.deepEqual([sent.version, sent.params.mode, sent.params.expectedTurnId], [4, "user", "turn-2"]);
  desktop.state.set("t4", { revision: 1, raw: snapshot({ id: "t4" }) });
  assert.deepEqual(await app.stop("t4"), { stopped: false, reason: "nothing is running" });
});

test("approvals are listed, and answered with the id and the decision the request's kind takes", async (t) => {
  const { desktop, app } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot({ requests: [
    { id: 7, method: "item/commandExecution/requestApproval", params: { command: "rm -rf build", cwd: "/w" } },
    { id: "p1", method: "item/fileChange/requestApproval", params: { reason: "write config" } },
    { id: 9, method: "execCommandApproval", params: { command: ["ls", "-la"] } },
    { id: 10, method: "item/permissions/requestApproval", params: { permissions: { network: true } } },
    { id: 11, method: "somethingElse", params: {} },
  ] }) });
  const { approvals } = await app.approvals();
  assert.deepEqual(approvals.map((a) => [a.request_id, a.kind, a.summary]), [["7", "command", "rm -rf build"], ["p1", "file", "write config"], ["9", "command", "ls -la"], ["10", "permissions", '{"network":true}']]);

  await app.approve("t1", "7", "approve");
  await app.approve("t1", "p1", "deny");
  await app.approve("t1", "9", "approve_session");
  await app.approve("t1", "10", "approve");
  const by = (m: string) => desktop.owned.find((f) => f.method === m)!;
  assert.deepEqual([by("thread-follower-command-approval-decision").params.requestId, by("thread-follower-command-approval-decision").params.decision], [7, "accept"]);
  assert.deepEqual([by("thread-follower-file-approval-decision").params.requestId, by("thread-follower-file-approval-decision").params.decision], ["p1", "decline"]);
  assert.deepEqual(desktop.owned.filter((f) => f.method === "thread-follower-command-approval-decision").map((f) => f.params.decision), ["accept", "approved_for_session"]);
  assert.deepEqual(by("thread-follower-permissions-request-approval-response").params.response, { permissions: { network: true }, scope: "turn" });
  await assert.rejects(app.approve("t1", "404", "approve"), code("not_found"));
});

test("events: a turn that ends and a new request for approval are reported, each once; what was already there is only a baseline", async (t) => {
  const { desktop, app, events } = await fixture(t);
  desktop.change("t1", snapshot({ threadRuntimeStatus: { type: "active" }, turns: [turn("u1", "inProgress", [{ type: "agentMessage", text: "working" }])] }));
  await app.sessions(); // joins t1
  await until(() => (app as any).convs.has("t1"), "t1 followed");
  assert.deepEqual(events, [], "a running turn seen first is not news");

  desktop.change("t1", desktop.state.get("t1")!.raw, [
    { op: "add", path: ["requests", 0], value: { id: 5, method: "item/commandExecution/requestApproval", params: { command: "make deploy" } } },
  ]);
  await until(() => events.length === 1, "the approval event");
  assert.deepEqual(events[0], ["codex.approval_pending", { thread: "t1", title: "Fix the build", request_id: "5", kind: "command", summary: "make deploy" }]);

  desktop.change("t1", desktop.state.get("t1")!.raw, [
    { op: "replace", path: ["threadRuntimeStatus", "type"], value: "idle" },
    { op: "replace", path: ["turns", 0, "status"], value: "completed" },
    { op: "add", path: ["turns", 0, "items", 1], value: { type: "agentMessage", text: "all done" } },
  ]);
  await until(() => events.length === 2, "the turn-ended event");
  assert.deepEqual(events[1], ["codex.turn_ended", { thread: "t1", title: "Fix the build", outcome: "completed", said: "all done" }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 2, "nothing twice");
});

test("a patch that does not follow on re-asks for the whole session instead of guessing", async (t) => {
  const { desktop, app } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot() });
  await app.session("t1");
  const before = desktop.got.filter((f) => f.method === "thread-stream-following-changed").length;
  desktop.broadcast((desktop as any).ownerSocket, "thread-stream-state-changed", { conversationId: "t1", hostId: "local", change: { type: "patches", baseRevision: 9, revision: 10, patches: [] } }, null);
  await until(() => desktop.got.filter((f) => f.method === "thread-stream-following-changed").length > before, "the new follow");
});

test("the app quits and starts again: the capabilities go away and come back, and the sessions are followed again", async (t) => {
  const { desktop, app, changes } = await fixture(t);
  desktop.state.set("t1", { revision: 1, raw: snapshot() });
  await app.session("t1");
  assert.equal(app.capabilities().length, CODEX_CAPABILITIES.length);
  const path = desktop.path;
  await desktop.stop();
  await until(() => !app.online, "going offline");
  assert.deepEqual(app.capabilities(), []);
  await assert.rejects(app.sessions(), code("unavailable"));

  const again = new Desktop(path);
  await again.listen();
  t.after(() => again.stop());
  await again.owner();
  again.state.set("t1", { revision: 5, raw: snapshot({ name: "After restart" }) });
  await until(() => app.online, "joining again", 4000);
  assert.deepEqual(changes.slice(0, 3), [true, false, true]);
  await until(() => (app as any).convs.get("t1")?.revision === 5, "t1 followed again");
  assert.equal((await app.session("t1")).title, "After restart");
});

test("patches: add, replace and remove at a path of keys and indexes; a path that is not there fails", () => {
  const base = { a: { b: [1, 2, 3] }, c: 1 };
  assert.deepEqual(applyPatches(base, [{ op: "add", path: ["a", "b", 1], value: 9 }, { op: "replace", path: ["c"], value: 2 }, { op: "remove", path: ["a", "b", 0] }]), { a: { b: [9, 2, 3] }, c: 2 });
  assert.deepEqual(base, { a: { b: [1, 2, 3] }, c: 1 }, "the original is untouched");
  assert.throws(() => applyPatches(base, [{ op: "replace", path: ["x", "y"], value: 1 }]));
  assert.throws(() => applyPatches(base, [{ op: "add", path: ["a", "b", 9], value: 1 }]));
});

test("the capabilities are valid, extensions, need no approval card, and are offered by the hand only while the app is there", async (t) => {
  for (const cap of CODEX_CAPABILITIES) {
    assert.equal(checkCapabilitySpec(cap), null, cap.name);
    assert.ok(isExtensionName(cap.name), cap.name);
    assert.equal(cap.risk, "none", `${cap.name}: remote control of the owner's own app asks nothing`);
  }
  assert.deepEqual(CODEX_CAPABILITIES.map((c) => [c.name, c.effect]), [["x.codex.sessions", "read"], ["x.codex.session", "read"], ["x.codex.approvals", "read"], ["x.codex.open", "act"], ["x.codex.new", "act"], ["x.codex.send", "act"], ["x.codex.stop", "act"], ["x.codex.approve", "act"]]);

  const { app, desktop } = await fixture(t);
  const hand = createHand({ workspace: {} as any, codex: app });
  assert.ok(hand.manifest().some((c) => c.name === "x.codex.send"));
  const frame = (capability: string, args: F) => ({ t: "call", ch: "device", id: "c1", capability, args, caller: { member: "person:owner", label: "x" }, deadline: Date.now() + 60_000 }) as any;
  desktop.state.set("t1", { revision: 1, raw: snapshot() });
  const out = await hand.handlers.call(frame("x.codex.session", { thread: "t1" }), { signal: new AbortController().signal, progress() {} });
  assert.ok(out.ok && (out.data as F).title === "Fix the build");
  const bad = await hand.handlers.call(frame("x.codex.send", { thread: "t1" }), { signal: new AbortController().signal, progress() {} });
  assert.ok(!bad.ok && bad.error.code === "bad_request");
  await app.close();
  assert.ok(!hand.manifest().some((c) => c.name.startsWith("x.codex.")));
  const gone = await hand.handlers.call(frame("x.codex.sessions", {}), { signal: new AbortController().signal, progress() {} });
  assert.ok(!gone.ok && gone.error.code === "unavailable");
});
