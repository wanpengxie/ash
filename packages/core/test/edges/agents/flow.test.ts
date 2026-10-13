import assert from "node:assert/strict";
import test from "node:test";
import { WordError } from "../../../../sdk/src/message";
import { caller, fixture, OWNER, settle, waitFor, type FakeDriver } from "./helpers";

const M = "agent:main";
const sends = (d: FakeDriver, key?: string) => d.of("send").filter((c) => !key || c[2] === key);
const texts = (call: unknown[]) => (call[3] as { text: string }[]).map((m) => m.text);

test("first start of an empty table plants the main declaration (primary), starts it, and registers its words", async () => {
  const f = fixture();
  await f.start();
  const runs = f.agents.manager.runs.list();
  assert.deepEqual(runs.map((r) => [r.id, r.spec.decl.primary]), [[M, true]]);
  const started = f.driver().of("start")[0]!;
  assert.equal(started[1], M);
  const spec = started[2] as any;
  assert.deepEqual(spec.lanes, ["front", "back"]);
  assert.deepEqual(spec.native, { on: "body:main", cwd: "/root/work" });
  assert.deepEqual(spec.tools, { mcp_url: "http://hub/mcp", tokens: { front: `tok-${M}-front`, back: `tok-${M}-back` }, allowed: ["*"] });
  assert.deepEqual(spec.modules.static.map((m: any) => m.id), ["identity", "rules"]);
  assert.match(spec.modules.static[0].content, /soul v1/);
  assert.match(spec.modules.static[1].content, /rules v1[\s\S]*You are main\./);
  assert.deepEqual(f.registry.find(M, "say")?.member.words().filter((w) => w.kind === "request").map((w) => w.word).sort(), ["ask", "say", "tell", "wake"]);
  assert.equal(f.registry.members.get(M)?.kind, "agent");
  // the handles the driver reports are kept, and a restart of the hub does not plant a second one and resumes them
  const handles = f.agents.manager.runs.get(M)!.spec.sessions;
  assert.deepEqual(Object.keys(handles), ["front", "back"]);
  const g = fixture({ from: f });
  await g.start();
  assert.equal(g.agents.manager.runs.list().length, 1);
  assert.deepEqual((g.driver().of("start")[0]![2] as any).sessions, handles);
});

test("without the main template the module refuses to start rather than plant nothing", async () => {
  const f = fixture({ templates: { main: null } });
  await assert.rejects(f.agents.startAll(), /main template/);
});

test("the owner's words go to the front lane and a wake to the back lane; the two run at once, a lane takes one batch at a time", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "hello" });
  await f.call(M, "wake", { reason: "pulse", context: { why: 1 } }, caller("service:pulse", "service"));
  await waitFor(() => sends(d).length === 2);
  assert.deepEqual(sends(d, "front").map(texts), [["hello"]]);
  assert.match(texts(sends(d, "back")[0]!)[0]!, /^Wake · pulse\n\{"why":1\}$/);
  assert.equal(sends(d, "front")[0]![3] && (sends(d, "front")[0]![3] as any)[0].from, "person:owner");
  // a second wake on the busy back lane is queued behind the turn, not a second send
  await f.call(M, "tell", { text: "news" }, caller("agent:other"));
  await settle();
  assert.equal(sends(d).length, 2);
  assert.equal(d.of("followup").length, 1);
  assert.equal((d.of("followup")[0]![3] as any)[0].text, "news");
  assert.equal(f.router.to("service:reflex", "conversation.control").length, 0); // not the owner: no judgement needed
});

test("a wake can name its lane; an unknown lane falls to back; the sender and timers pick lanes by the declaration", async () => {
  const f = fixture();
  await f.start();
  const decl = f.agents.manager.run(M).spec.decl;
  const m = f.agents.manager;
  assert.equal(m.laneFor(decl, "person:owner", "say", "request"), "front");
  assert.equal(m.laneFor(decl, "service:clock", "tell", "request"), "back");
  assert.equal(m.laneFor(decl, "app:health", "wake", "request", "front"), "front");
  assert.equal(m.laneFor(decl, "app:health", "wake", "request", "nope"), "back");
  assert.equal(m.laneFor(decl, "agent:x", "tell", "request"), "back");
});

test("the owner speaks while the lane is busy: the reflex judgement decides", async () => {
  for (const [action, steered, check] of [
    ["steer", true, (d: FakeDriver) => assert.deepEqual(d.of("steer").map((c) => c[3]), ["second"])],
    ["steer", false, (d: FakeDriver) => assert.equal(d.of("followup").length, 1)],
    ["followup", true, (d: FakeDriver) => assert.equal(d.of("followup").length, 1)],
    ["pause", true, (d: FakeDriver) => assert.equal(d.of("followup").length + d.of("steer").length, 0)], // admin is asked; see the pause test
    [undefined, true, (d: FakeDriver) => assert.equal(d.of("followup").length, 1)],
  ] as const) {
    const f = fixture();
    await f.start();
    const d = f.driver();
    d.steerResult = steered;
    if (action) f.router.on("service:reflex/conversation.control", () => ({ ok: true, result: { data: { action } } }));
    await f.call(M, "say", { text: "first" });
    await waitFor(() => sends(d).length === 1);
    const second = await f.call(M, "say", { text: "second" });
    assert.deepEqual(second, { data: { accepted: true } });
    await settle();
    check(d);
    const asked = f.router.to("service:reflex", "conversation.control");
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]!.msg.body, { message_id: f.agents.manager.inbox.pending(M, "front").concat(f.ledger.db().prepare("SELECT id FROM agent_inbox WHERE text='second'").all().map((r: any) => ({ id: r.id }) as any))[0]!.id, agent: M, lane: "front" });
    assert.equal(sends(d).length, 1);
  }
});

test("interrupt: the new words wait, the cancelled turn ends, and they open the next turn", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.router.on("service:reflex/conversation.control", () => ({ ok: true, result: { data: { action: "interrupt" } } }));
  await f.call(M, "say", { text: "first" });
  await waitFor(() => sends(d).length === 1);
  await f.call(M, "say", { text: "stop that, do this" });
  await waitFor(() => d.of("interrupt").length === 1);
  assert.equal(sends(d).length, 1);
  d.finish(M, "front", "cancelled");
  await waitFor(() => sends(d).length === 2);
  assert.deepEqual(texts(sends(d)[1]!), ["stop that, do this"]);
});

test("what an agent says: front speech goes to the owner as that agent, back speech does not; tools and turns become events; thoughts none", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "hi" });
  await waitFor(() => sends(d).length === 1);
  d.say(M, "front", "hello owner");
  d.tool(M, "front", "read_file");
  d.report({ event: "thought", agent: M, key: "front", turn: "x", text: "thinking" });
  d.finish(M, "front");
  await f.call(M, "wake", { reason: "r" }, caller("service:pulse", "service"));
  await waitFor(() => sends(d).length === 2);
  d.say(M, "back", "quiet words");
  d.finish(M, "back");
  await settle();
  assert.deepEqual(f.router.says(), [{ from: M, text: "hello owner" }]);
  assert.equal(f.router.to("person:owner", "say")[0]!.caller.via, "agent");
  assert.equal(f.router.events("agent.tool").length, 1);
  assert.deepEqual(f.router.events("agent.tool")[0]!.msg.body, { turn: f.router.events("agent.tool")[0]!.caller.turn, name: "read_file", phase: "start", summary: "s" });
  assert.equal(f.router.events("turn.started").length, 2);
  assert.deepEqual(f.router.events("turn.ended").map((e) => (e.msg.body as any).lane), ["front", "back"]);
  assert.ok(f.router.sent.every((s) => s.msg.word !== "thought"));
});

test("a lane with on: [front:turn.ended] and speak: false runs after the front turn, and its words stay private", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.service("declare", { id: "agent:r", name: "r", summary: "reflective", brief: "reflect",
    lanes: { front: { from: ["person:owner"] }, reflect: { on: ["front:turn.ended"], guide: "REFLECT.md", speak: false } } });
  await settle();
  await f.call("agent:r", "say", { text: "hi" });
  await waitFor(() => sends(d, "front").length === 1);
  d.say("agent:r", "front", "answer");
  d.finish("agent:r", "front");
  await waitFor(() => sends(d, "reflect").length === 1);
  assert.match(texts(sends(d, "reflect")[0]!)[0]!, /Lane front finished a turn \(completed\)/);
  d.say("agent:r", "reflect", "private thought");
  d.finish("agent:r", "reflect"); // ending a lane started by `on` does not start another
  await settle();
  assert.deepEqual(f.router.says(), [{ from: "agent:r", text: "answer" }]);
  assert.equal(sends(d, "reflect").length, 1);
});

test("front and back run at the same time while each lane is one turn at a time", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "a" });
  await f.call(M, "wake", { reason: "b" }, caller("service:pulse", "service"));
  await waitFor(() => sends(d).length === 2);
  assert.ok(d.running.has(`${M}/front`) && d.running.has(`${M}/back`));
  d.finish(M, "front");
  await settle();
  assert.ok(!d.running.has(`${M}/front`) && d.running.has(`${M}/back`));
  await f.call(M, "say", { text: "c" });
  await waitFor(() => sends(d, "front").length === 2);
});

test("quota: over the limit no turn opens and the owner hears once; offline cost lets it through; a later poll opens the turn", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  let allowed = false;
  f.router.on("service:cost/quota.check", () => ({ ok: true, result: { data: { allowed, reason: "今天的额度用完了", used: 5, limit: 5 } } }));
  await f.call(M, "say", { text: "one" });
  await settle();
  await f.call(M, "say", { text: "two" });
  await settle();
  assert.equal(sends(d).length, 0);
  assert.deepEqual(f.router.says().filter((s) => s.from === "service:agents").map((s) => s.text), ["今天的额度用完了"]);
  allowed = true;
  f.timers.everies[0]!.fn(); // the poll: numbers may have changed, so waiting lanes try again
  await waitFor(() => sends(d).length === 1);
  assert.deepEqual(texts(sends(d)[0]!), ["one", "two"]); // both waited; one batch
  // no cost service at all: go ahead
  const g = fixture();
  await g.start();
  await g.call(M, "say", { text: "x" });
  await waitFor(() => g.driver().of("send").length === 1);
});

test("a process that dies is started again and its sessions resumed; the second quick crash in a row waits, and the primary agent is not given up on", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const handles = f.agents.manager.runs.get(M)!.spec.sessions;
  d.die(M);
  await waitFor(() => d.of("start").length === 2);
  assert.deepEqual((d.of("start")[1]![2] as any).sessions, handles);
  assert.ok(f.registry.members.has(M));
  d.die(M);
  await settle();
  assert.equal(d.of("start").length, 2, "the second quick crash waits before the new start");
  assert.ok(f.registry.members.has(M));
  assert.ok(f.fire(2000));
  await waitFor(() => d.of("start").length === 3);
  d.die(M);
  await settle();
  assert.ok(f.fire(5000));
  await waitFor(() => d.of("start").length === 4);
  assert.ok(f.registry.members.has(M));
  assert.notEqual(f.agents.manager.stateOf(M), "error");
  // a process that ran for a good while before it died does not count against the tries
  const g = fixture();
  await g.start();
  g.clock.t += 5 * 60_000;
  g.driver().die(M);
  await waitFor(() => g.driver().of("start").length === 2);
  g.clock.t += 5 * 60_000;
  g.driver().die(M);
  await waitFor(() => g.driver().of("start").length === 3);
  g.clock.t += 5 * 60_000;
  g.driver().die(M);
  await waitFor(() => g.driver().of("start").length === 4);
});

test("a start that fails is tried again later; a failure of the first one does not stop the hub from starting", async () => {
  const f = fixture();
  f.drivers; // created on first use
  await f.agents.startAll().catch(() => {});
  await f.agents.stopAll();
  const g = fixture({ from: f });
  await g.agents.startAll();
  await settle();
  assert.equal(g.agents.manager.stateOf(M), "idle");
  const h = fixture({ from: f });
  h.agents.manager.driver("dsh");
  (h.drivers[0] as FakeDriver).startFailures = 3;
  await h.agents.startAll();
  await settle();
  assert.equal(h.drivers[0]!.of("start").length, 1, "one try, then it waits");
  assert.equal(h.agents.manager.stateOf(M), "starting");
  assert.ok(h.registry.members.has(M));
  for (const ms of [2000, 5000, 15_000]) { assert.ok(h.fire(ms)); await settle(); }
  assert.equal(h.drivers[0]!.of("start").length, 4);
  assert.equal(h.agents.manager.stateOf(M), "idle");
  const i = fixture({ from: f });
  i.agents.manager.driver("dsh");
  (i.drivers[0] as FakeDriver).startFailures = 2;
  await i.agents.startAll();
  await settle();
  assert.ok(i.fire(2000));
  await settle();
  assert.ok(i.fire(5000));
  await settle();
  assert.equal(i.agents.manager.stateOf(M), "idle");
});

test("the hub restarts in the middle of a turn: that batch is not sent again; the agent is told it was cut off; waiting messages still go", async () => {
  const f = fixture();
  await f.start();
  await f.call(M, "say", { text: "do the long thing" });
  await waitFor(() => sends(f.driver()).length === 1);
  // "queued" was handed to the driver behind the turn but never started
  const m = f.agents.manager;
  m.inbox.add({ id: "m_q", agent: M, lane: "front", from: "person:owner", word: "say", text: "queued one", attachments: [], at: 1 });
  m.inbox.mark(["m_q"], "sent");
  m.inbox.add({ id: "m_w", agent: M, lane: "front", from: "person:owner", word: "say", text: "never delivered", attachments: [], at: 2 });
  const g = fixture({ from: f });
  await g.start();
  const d = g.driver();
  await waitFor(() => sends(d).length === 2);
  const back = texts(sends(d, "back")[0]!)[0]!;
  assert.match(back, /上一轮中断了（当时在处理：do the long thing）/);
  assert.deepEqual(texts(sends(d, "front")[0]!), ["queued one", "never delivered"]);
  assert.equal(g.agents.manager.inbox.get(f.agents.manager.inbox.pending(M, "front")[0]?.id ?? "x"), null);
  const old = g.ledger.db().prepare("SELECT state FROM agent_inbox WHERE text='do the long thing'").get() as { state: string };
  assert.equal(old.state, "interrupted");
});

test("ask: the answer is what the agent said in the turn that took the question; answer can give it earlier; tell's answer goes back to the sender", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const pending = f.call(M, "ask", { text: "what time is it" }, caller("agent:other")) as Promise<any>;
  await waitFor(() => sends(d, "back").length === 1);
  d.say(M, "back", "noon");
  d.say(M, "back", "sharp");
  d.finish(M, "back");
  assert.deepEqual(await pending, { data: { answer: "noon\n\nsharp" } });
  assert.deepEqual(f.router.says(), []); // a back lane does not talk to the owner

  const early = f.call(M, "ask", { text: "again?" }, caller("agent:other")) as Promise<any>;
  await waitFor(() => sends(d, "back").length === 2);
  const msgId = (sends(d, "back")[1]![3] as any)[0].id;
  await f.service("answer", { in_reply_to: msgId, text: "yes now" }, caller(M));
  assert.deepEqual(await early, { data: { answer: "yes now" } });
  d.finish(M, "back");

  await f.call(M, "tell", { text: "fyi" }, caller("agent:other"));
  await waitFor(() => sends(d, "back").length === 3);
  const tellId = (sends(d, "back")[2]![3] as any)[0].id;
  await f.service("answer", { in_reply_to: tellId, text: "thanks" }, caller(M));
  const back = f.router.to("agent:other", "tell");
  assert.equal((back[0]!.msg.body as any).text, "thanks");
  assert.equal(back[0]!.caller.member, M);
  await assert.rejects(f.service("answer", { in_reply_to: tellId, text: "x" }, caller("agent:stranger")), (e: any) => e instanceof WordError && e.code === "not_found");
});

test("an ask whose turn is cancelled fails; asking a stopped agent is offline", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const pending = f.call(M, "ask", { text: "q" }, caller("agent:other")) as Promise<any>;
  await waitFor(() => sends(d, "back").length === 1);
  d.finish(M, "back", "cancelled");
  await assert.rejects(pending, (e: any) => e.code === "cancelled");
  await f.service("stop", { agent: M });
  assert.ok(!f.registry.members.has(M));
  await assert.rejects(f.service("ask", { agent: M, text: "q" }, caller("agent:other")), (e: any) => e.code === "offline");
});

test("a lane that takes the owner's words waits while the owner is typing; their message ends the typing, so it goes at once; other lanes never wait", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  // typing holds only the owner's lane: a wake on the back lane goes at once
  await f.call(M, "typing", {});
  await f.call(M, "wake", { reason: "pulse" }, caller("service:pulse", "service"));
  await waitFor(() => sends(d, "back").length === 1);
  // their message is the end of the typing: no wait for the rest of it
  f.clock.t += 1000;
  await f.call(M, "say", { text: "a whole thought" });
  await waitFor(() => sends(d, "front").length === 1);
  assert.deepEqual(texts(sends(d, "front")[0]!), ["a whole thought"]);
  assert.equal(f.timers.afters.filter((t) => !t.cancelled && t.ms === 5000).length, 0);
});

test("a pause (read from service:admin at start and on settings.changed) stops turns, not the inbox; resuming delivers", async () => {
  let paused = true;
  const f = fixture();
  f.router.on("service:admin/status", () => ({ ok: true, result: { data: { now: 1, paused } } }));
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "while paused" });
  await settle();
  assert.equal(sends(d).length, 0);
  assert.equal(f.agents.manager.inbox.pending(M, "front").length, 1); // kept
  assert.ok(f.registry.members.has(M)); // the agent is still there
  paused = false;
  await f.service("settings.changed", { keys: ["paused"] }, caller("service:admin", "service"));
  await waitFor(() => sends(d).length === 1);
  assert.deepEqual(texts(sends(d)[0]!), ["while paused"]);
  // pausing in the middle of a turn interrupts it, and the next message waits
  paused = true;
  const reads = f.router.to("service:admin", "status").length;
  await f.service("settings.changed", { keys: ["something else"] }, caller("service:admin", "service"));
  assert.equal(f.router.to("service:admin", "status").length, reads); // not about the switch: no read
  await f.service("settings.changed", { keys: ["paused"] }, caller("service:admin", "service"));
  await waitFor(() => d.of("interrupt").length === 1);
  d.finish(M, "front", "cancelled");
  await f.call(M, "say", { text: "still paused" });
  await settle();
  assert.equal(sends(d).length, 1);
  paused = false;
  await f.service("settings.changed", { keys: ["paused"] }, caller("service:admin", "service"));
  await waitFor(() => sends(d).length === 2);
  assert.deepEqual(texts(sends(d)[1]!), ["still paused"]);
});

test("without an admin service nothing is paused; a reflex verdict of pause asks admin to pause and leaves the message waiting", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.router.on("service:reflex/conversation.control", () => ({ ok: true, result: { data: { action: "pause" } } }));
  await f.call(M, "say", { text: "first" });
  await waitFor(() => sends(d).length === 1);
  await f.call(M, "say", { text: "stop everything" });
  await waitFor(() => f.router.to("service:admin", "pause").length === 1);
  const asked = f.router.to("service:admin", "pause")[0]!;
  assert.equal(asked.caller.member, "service:agents");
  const row = f.ledger.db().prepare("SELECT id, state FROM agent_inbox WHERE text='stop everything'").get() as { id: string; state: string };
  assert.deepEqual(asked.msg.body, { by: row.id });
  assert.equal(row.state, "pending");
  assert.equal(d.of("followup").length, 0);
  assert.equal(d.of("steer").length, 0);
});

test("the lane turns busy when the driver says the turn started, not when send returns: a turn that has ended by then leaves the lane free", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  d.instantTurns = true;
  await f.call(M, "say", { text: "one" });
  await waitFor(() => sends(d).length === 1);
  await settle();
  await f.call(M, "say", { text: "two" });
  await waitFor(() => sends(d).length === 2); // a send, not a followup behind a turn that is already over
  assert.equal(d.of("followup").length, 0);
});

test("a reflex pause that admin cannot carry out (offline or refused) falls back to interrupting the turn", async () => {
  for (const admin of [undefined, () => ({ ok: false as const, error: { code: "forbidden" as const, message: "no" } })]) {
    const f = fixture();
    await f.start();
    const d = f.driver();
    if (admin) f.router.on("service:admin/pause", admin);
    f.router.on("service:reflex/conversation.control", () => ({ ok: true, result: { data: { action: "pause" } } }));
    await f.call(M, "say", { text: "first" });
    await waitFor(() => sends(d).length === 1);
    await f.call(M, "say", { text: "halt" });
    await waitFor(() => d.of("interrupt").length === 1);
    assert.equal(f.router.to("service:admin", "pause").length, 1);
    assert.equal(d.of("followup").length, 0);
  }
});

test("the member declares what it hears and what it emits: say, tell, ask, wake, typing, turn.started, turn.ended, agent.tool", async () => {
  const f = fixture();
  await f.start();
  assert.deepEqual(f.registry.members.get(M)!.words().map((w) => w.word).sort(), ["agent.tool", "ask", "say", "tell", "turn.ended", "turn.started", "typing", "wake"]);
});

test("only the owner's say goes to the front lane: their tell and ask go to back, and the two lanes run at the same time", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const decl = f.agents.manager.run(M).spec.decl;
  for (const word of ["tell", "ask", "wake"]) assert.equal(f.agents.manager.laneFor(decl, "person:owner", word, "request"), "back", word);
  assert.equal(f.agents.manager.laneFor(decl, "person:owner", "say", "request"), "front");
  await f.call(M, "tell", { text: "note to self" }); // from the owner
  await waitFor(() => sends(d, "back").length === 1);
  assert.equal(sends(d, "front").length, 0);
  assert.deepEqual(texts(sends(d, "back")[0]!), ["note to self"]);
  await f.call(M, "say", { text: "hello" });
  await waitFor(() => sends(d, "front").length === 1);
  assert.ok(d.running.has(`${M}/front`) && d.running.has(`${M}/back`)); // both at once
  const asked = f.call(M, "ask", { text: "question" }) as Promise<any>;
  await settle();
  assert.equal(d.of("followup").length, 1); // queued behind the back lane's turn, not on the front lane
  assert.equal(d.of("followup")[0]![2], "back");
  d.finish(M, "back");
  await waitFor(() => d.running.has(`${M}/back`)); // the queued question became the next back turn
  d.say(M, "back", "answer");
  d.finish(M, "back");
  assert.deepEqual((await asked).data, { answer: "answer" });
});

test("a front turn that fails tells the owner in a sentence and offers a retry card; choosing it delivers the same batch again", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "do the thing" });
  await waitFor(() => sends(d, "front").length === 1);
  const failedTurn = d.running.get(`${M}/front`)!.turn;
  assert.equal(f.agents.manager.inbox.byTurn(failedTurn).length, 1);
  d.report({ event: "turn.ended", agent: M, key: "front", turn: failedTurn, outcome: "error", error: "401 invalid api key" });
  d.running.delete(`${M}/front`);
  await waitFor(() => f.router.to("person:owner", "show").length === 1);
  const said = f.router.says();
  assert.equal(said.length, 1);
  assert.deepEqual(said[0]!.from, M);
  assert.match(said[0]!.text, /没做成：模型那边没认我的 Key/);
  assert.ok(!said[0]!.text.includes("401"), "no raw error text");
  assert.deepEqual((f.router.to("person:owner", "show")[0]!.msg.body as any).card, { type: "options", prompt: "要我再试一次吗？", options: [{ id: `retry:${failedTurn}`, text: "重试" }] });
  assert.equal(sends(d, "front").length, 1);
  // the owner chooses 重试: the same message goes again, the click is not a message of its own
  await f.call(M, "say", { in_reply_to: "card_1", option_id: `retry:${failedTurn}`, text: "重试" });
  await waitFor(() => sends(d, "front").length === 2);
  assert.deepEqual(texts(sends(d, "front")[1]!), ["do the thing"]);
  assert.equal(f.ledger.db().prepare("SELECT count(*) AS n FROM agent_inbox WHERE text LIKE '%重试%'").get()!.n, 0);
  // it fails again: a new notice, and another retry works; once nothing is left to retry the click is an ordinary reply
  d.finish(M, "front", "error");
  await waitFor(() => f.router.to("person:owner", "show").length === 2);
  const secondTurn = d.running.get(`${M}/front`)?.turn ?? f.router.to("person:owner", "show")[1]!.caller.turn!;
  await f.call(M, "say", { in_reply_to: "card_2", option_id: `retry:${secondTurn}`, text: "重试" });
  await waitFor(() => sends(d, "front").length === 3);
  d.finish(M, "front");
  await settle();
  await f.call(M, "say", { in_reply_to: "card_2", option_id: `retry:${secondTurn}`, text: "重试" }); // already retried
  await waitFor(() => sends(d, "front").length === 4);
  assert.match(texts(sends(d, "front")[3]!)[0]!, /重试/);
});

test("no failure notice for a back lane, a lane that does not speak, a cancelled turn, or a batch the owner did not write", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "wake", { reason: "r" }, caller("service:pulse", "service"));
  await waitFor(() => sends(d, "back").length === 1);
  d.finish(M, "back", "error");
  await f.call(M, "say", { text: "x" });
  await waitFor(() => sends(d, "front").length === 1);
  d.finish(M, "front", "cancelled");
  await settle();
  assert.deepEqual(f.router.says(), []);
  assert.equal(f.router.to("person:owner", "show").length, 0);
  // and an error with no owner message in the batch (a followup of the agent's own lane trigger) says nothing
  await f.service("declare", { id: "agent:r", name: "r", summary: "reflective", brief: "reflect", lanes: { front: { from: ["person:owner"] }, reflect: { on: ["front:turn.ended"], speak: false } } });
  await f.call("agent:r", "say", { text: "hi" });
  await waitFor(() => sends(d, "front").some((c) => c[1] === "agent:r"));
  d.finish("agent:r", "front");
  await waitFor(() => sends(d, "reflect").length === 1);
  d.finish("agent:r", "reflect", "error");
  await settle();
  assert.deepEqual(f.router.says(), []);
});

test("each retry card names its own batch: two batches that failed one after the other are retried one by one", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const fail = async (text: string) => {
    await f.call(M, "say", { text });
    await waitFor(() => d.running.has(`${M}/front`));
    const turn = d.running.get(`${M}/front`)!.turn;
    d.finish(M, "front", "error");
    await waitFor(() => f.router.to("person:owner", "show").length >= 1 && (f.router.to("person:owner", "show").at(-1)!.msg.body as any).card.options[0].id === `retry:${turn}`);
    return turn;
  };
  const a = await fail("batch A");
  const b = await fail("batch B");
  assert.notEqual(a, b);
  const cards = f.router.to("person:owner", "show").map((s) => (s.msg.body as any).card.options[0].id);
  assert.deepEqual(cards, [`retry:${a}`, `retry:${b}`]);
  const before = sends(d, "front").length;
  await f.call(M, "say", { in_reply_to: "card_a", option_id: cards[0] });
  await waitFor(() => sends(d, "front").length === before + 1);
  assert.deepEqual(texts(sends(d, "front").at(-1)!), ["batch A"]); // A's card, A's batch
  d.finish(M, "front");
  await settle();
  // a card for a turn that is not failed (or never was) is only an ordinary reply
  await f.call(M, "say", { in_reply_to: "card_x", option_id: "retry:t_nothing", text: "重试" });
  await waitFor(() => sends(d, "front").length === before + 2);
  assert.deepEqual(texts(sends(d, "front").at(-1)!), ["[answers card_x, option retry:t_nothing] 重试"]);
  d.finish(M, "front");
  await settle();
  await f.call(M, "say", { in_reply_to: "card_b", option_id: cards[1] });
  await waitFor(() => sends(d, "front").length === before + 3);
  assert.deepEqual(texts(sends(d, "front").at(-1)!), ["batch B"]);
});
