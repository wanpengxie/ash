import assert from "node:assert/strict";
import test from "node:test";
import { caller, fixture, OWNER, settle, waitFor, type FakeDriver } from "./helpers";

const M = "agent:main";
const sends = (d: FakeDriver, key?: string) => d.of("send").filter((c) => !key || c[2] === key);
const code = (c: string) => (e: any) => e?.code === c;
const decl = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.slice(6), summary: "a helper agent", brief: "help", ...extra });

test("primary: exactly one; it cannot be removed or declared twice; primary.set hands it over and the old one is not primary any more", async () => {
  const f = fixture();
  await f.start();
  await assert.rejects(f.service("declare", decl("agent:b", { primary: true })), code("conflict"));
  await assert.rejects(f.service("declare", decl("agent:b", { primary: true }), caller("agent:x")), code("conflict")); // an agent may declare the primary, but there is one already
  await f.service("declare", decl("agent:b"));
  await assert.rejects(f.service("remove", { agent: M }), code("conflict"));
  await assert.rejects(f.service("update", { agent: "agent:b", primary: true }), code("bad_request"));
  assert.equal(f.agents.primary(), M);
  const swapped: any = (await f.service("primary.set", { agent: "agent:b" }))!.data;
  assert.equal(swapped.primary, true);
  assert.equal(f.agents.primary(), "agent:b");
  const list: any = (await f.service("list", {}))!.data;
  assert.deepEqual(list.agents.map((a: any) => [a.id, a.primary]).sort(), [["agent:b", true], [M, false]]);
  await f.service("remove", { agent: M }); // no longer primary
  assert.equal(f.agents.manager.runs.get(M), null);
  assert.ok(!f.registry.members.has(M));
  // the table itself refuses a second primary
  const db = f.ledger.db();
  assert.throws(() => db.prepare("INSERT INTO agent_runs(agent,spec,is_primary,updated_at) VALUES('agent:z','{}',1,0)").run());
});

test("declare and update: a caller who is not the owner can give only tools and words it has itself", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:a", { tools: ["read", "write*"], words: ["service:agents/*", "body:main/workspace.read"] }));
  const a = caller("agent:a");
  // inside what a has
  await f.service("declare", decl("agent:c1", { tools: ["read"], words: ["body:main/workspace.read"] }), a);
  await f.service("declare", decl("agent:c2", { tools: ["write_file"], words: ["service:agents/ask"] }), a);
  // beyond it: another tool, another word, or no restriction at all
  await assert.rejects(f.service("declare", decl("agent:c3", { tools: ["read", "exec"], words: ["body:main/workspace.read"] }), a), code("forbidden"));
  await assert.rejects(f.service("declare", decl("agent:c4", { tools: ["read"], words: ["body:main/workspace.write"] }), a), code("forbidden"));
  await assert.rejects(f.service("declare", decl("agent:c5", { tools: ["read"] }), a), code("forbidden"));
  await assert.rejects(f.service("declare", decl("agent:c6"), a), code("forbidden"));
  // update checks the declaration that results
  await assert.rejects(f.service("update", { agent: "agent:c1", words: ["device:*/screen.tap"] }, a), code("forbidden"));
  await f.service("update", { agent: "agent:c1", brief: "new brief" }, a);
  assert.equal(f.agents.manager.run("agent:c1").spec.decl.brief, "new brief");
  // an agent that cannot be named narrower than an unrestricted one may not touch it
  await assert.rejects(f.service("update", { agent: M, brief: "x" }, a), code("forbidden"));
  // the owner and the hub's own code give anything; an app gives nothing
  await f.service("declare", decl("agent:wide", { tools: ["everything"] }), OWNER);
  await f.service("declare", decl("agent:svc"), caller("service:pulse", "service"));
  await f.service("declare", decl("agent:app1", { tools: [], words: [] }), caller("app:x", "app")); // nothing is a subset of nothing
  await assert.rejects(f.service("declare", decl("agent:app2"), caller("app:x", "app")), code("forbidden"));
  // an id already taken
  await assert.rejects(f.service("declare", decl("agent:c1")), code("conflict"));
  await assert.rejects(f.service("declare", { ...decl("agent:Bad") }), code("bad_request"));
});

test("delegation goes three deep: what an agent declares is one level further, the fourth is refused", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:l0"));
  await f.service("declare", decl("agent:l1"), caller("agent:l0"));
  await f.service("declare", decl("agent:l2"), caller("agent:l1"));
  await f.service("declare", decl("agent:l3"), caller("agent:l2"));
  assert.deepEqual(["l0", "l1", "l2", "l3"].map((n) => f.agents.manager.run(`agent:${n}`).spec.decl.depth), [0, 1, 2, 3]);
  await assert.rejects(f.service("declare", decl("agent:l4"), caller("agent:l3")), code("forbidden"));
  await assert.rejects(f.service("spawn", { task: "x" }, caller("agent:l3")), code("forbidden"));
});

test("a declared agent starts at once, is registered while it runs, and goes with stop; stop is remembered across a hub restart", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:b"));
  assert.ok(f.registry.members.has("agent:b"));
  assert.deepEqual(f.agents.manager.run("agent:b").spec.decl.runtime, { kind: "dsh" });
  assert.equal(((await f.service("describe", { agent: "agent:b" }))!.data as any).state, "idle");
  await f.service("stop", { agent: "agent:b" });
  assert.ok(!f.registry.members.has("agent:b"));
  assert.equal(((await f.service("describe", { agent: "agent:b" }))!.data as any).state, "stopped");
  const g = fixture({ from: f });
  await g.start();
  assert.ok(g.registry.members.has(M) && !g.registry.members.has("agent:b"));
  await g.service("start", { agent: "agent:b" });
  assert.ok(g.registry.members.has("agent:b"));
  await g.service("restart", { agent: "agent:b" });
  assert.deepEqual(g.driver().of("stop").map((c) => c[1]), ["agent:b"]);
  assert.equal(g.driver().of("start").filter((c) => c[1] === "agent:b").length, 2);
  await assert.rejects(g.service("describe", { agent: "agent:nope" }), code("not_found"));
});

test("update: changing the runtime, where it lives or its lanes restarts the agent; other changes apply from the next turn", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:b"));
  const d = f.driver();
  await f.service("update", { agent: "agent:b", brief: "other" });
  assert.equal(d.of("start").filter((c) => c[1] === "agent:b").length, 1);
  await f.service("update", { agent: "agent:b", lanes: { front: { from: ["person:owner"] }, reflect: { on: ["front:turn.ended"], speak: false } } });
  assert.equal(d.of("start").filter((c) => c[1] === "agent:b").length, 2);
  assert.deepEqual((d.of("start")[2]![2] as any).lanes, ["front", "reflect"]);
  const info: any = (await f.service("describe", { agent: "agent:b" }))!.data;
  assert.deepEqual(Object.keys(info.lanes), ["front", "reflect"]);
  assert.deepEqual(Object.keys(((await f.service("describe", { agent: M }))!.data as any).lanes), ["front", "back"]);
});

test("spawn: a temporary agent with one lane is declared, given the task by ask, and removed when it has answered; the owner never hears it", async () => {
  const f = fixture({ templates: { researcher: { brief: "You research.", tools: ["web"] } } });
  await f.start();
  const d = f.driver();
  const pending = f.service("spawn", { task: "find the capital of France", template: "researcher" }, caller(M));
  await waitFor(() => sends(d, "work").length === 1);
  const id = sends(d, "work")[0]![1] as string;
  assert.match(id, /^agent:w-[0-9a-f]{6}$/);
  const worker = f.agents.manager.run(id).spec.decl;
  assert.deepEqual([worker.ephemeral, worker.depth, worker.brief, worker.tools, Object.keys(worker.lanes!)], [true, 1, "You research.", ["web"], ["work"]]);
  assert.ok(f.registry.members.has(id));
  assert.match(((sends(d, "work")[0]![3]) as any)[0].text, /find the capital of France/);
  d.say(id, "work", "Paris");
  d.finish(id, "work");
  assert.deepEqual((await pending)!.data, { answer: "Paris", agent: id });
  assert.equal(f.agents.manager.runs.get(id), null);
  assert.ok(!f.registry.members.has(id));
  assert.deepEqual(d.of("stop").map((c) => c[1]), [id]);
  assert.deepEqual(f.router.says(), []);
  assert.equal(f.ledger.db().prepare("SELECT count(*) AS n FROM agent_inbox WHERE agent=?").get(id)!.n, 0);
});

test("spawn: too slow is a timeout and the worker is gone anyway; an unknown template is not_found; the worker never has more than the caller", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const slow = f.service("spawn", { task: "never ends", timeout: 30 }, OWNER);
  await waitFor(() => sends(d, "work").length === 1);
  const id = sends(d, "work")[0]![1] as string;
  assert.equal(f.timers.afters.at(-1)!.ms, 30_000);
  f.timers.afters.at(-1)!.fn();
  await assert.rejects(slow, code("timeout"));
  assert.equal(f.agents.manager.runs.get(id), null);
  assert.ok(!f.registry.members.has(id));
  await assert.rejects(f.service("spawn", { task: "x", template: "nope" }), code("not_found"));

  await f.service("declare", decl("agent:a", { tools: ["read"], words: ["body:main/workspace.read"] }));
  await assert.rejects(f.service("spawn", { task: "x", tools: ["read", "exec"] }, caller("agent:a")), code("forbidden"));
  await assert.rejects(f.service("spawn", { task: "x", template: "wide" }, caller("agent:a")), code("not_found"));
  f.addTemplate("wide", { tools: ["read", "exec"] });
  await assert.rejects(f.service("spawn", { task: "x", template: "wide" }, caller("agent:a")), code("forbidden"));
  // no tools named: the worker gets what its parent has, no more
  const inherit = f.service("spawn", { task: "inherit" }, caller("agent:a"));
  await waitFor(() => sends(d, "work").length === 2);
  const w = f.agents.manager.run(sends(d, "work")[1]![1] as string).spec.decl;
  assert.deepEqual([w.tools, w.words, w.depth], [["read"], ["body:main/workspace.read"], 1]);
  d.finish(w.id, "work");
  await inherit;
});

test("sessions: get, new, reload, compact, send, followup, steer, inject, interrupt, restart and set reach the driver for the right lane", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const handle = (await f.service("session.get", { agent: M, key: "front" }))!.data as any;
  assert.deepEqual(handle, { key: "front", handle: f.agents.manager.run(M).spec.sessions.front });
  await assert.rejects(f.service("session.get", { agent: M, key: "nope" }), code("not_found"));
  const fresh: any = (await f.service("session.new", { agent: M, key: "front" }))!.data;
  assert.equal(fresh.handle, d.session.get(M, "front"));
  assert.equal(f.agents.manager.run(M).spec.sessions.front, fresh.handle); // stored
  await f.service("session.set", { agent: M, key: "back", handle: "h-old" });
  assert.equal(f.agents.manager.run(M).spec.sessions.back, "h-old");
  assert.equal(((await f.service("session.compact", { agent: M, key: "front" }))!.data as any).compacted, true);
  await f.service("session.send", { agent: M, key: "front", messages: [{ text: "from a tool" }] });
  assert.equal(sends(d, "front").length, 1);
  await assert.rejects(f.service("session.send", { agent: M, key: "front", messages: [{ text: "again" }] }), code("conflict"));
  await assert.rejects(f.service("session.new", { agent: M, key: "front" }), code("conflict"));
  await f.service("session.followup", { agent: M, key: "front", messages: [{ text: "later" }] });
  assert.equal(((await f.service("session.steer", { agent: M, key: "front", text: "psst" }))!.data as any).accepted, true);
  assert.deepEqual(d.of("steer").map((c) => c[3]), ["psst"]);
  await f.service("session.inject", { agent: M, key: "front", text: "note" });
  assert.deepEqual(d.of("inject").at(-1)![3], { text: "note" });
  assert.equal(((await f.service("session.interrupt", { agent: M, key: "front" }))!.data as any).interrupted, true);
  assert.equal(((await f.service("session.interrupt", { agent: M, key: "back" }))!.data as any).interrupted, false);
  d.finish(M, "front", "cancelled");
  await f.service("session.restart", { agent: M });
  assert.equal(d.of("start").length, 2);
  assert.deepEqual((await f.service("configure", { agent: M, key: "front", config: { effort: "high" } }))!.data, { config: { model: "m", effort: "high" } });
  await f.service("plugins", { agent: M, op: "list" });
  assert.deepEqual(d.of("plugins")[0]!.slice(1), [M, "list", undefined]);
  assert.equal(((await f.service("runtimes", {}))!.data as any).runtimes[0].kind, "dsh");
  await f.service("stop", { agent: M });
  await assert.rejects(f.service("session.get", { agent: M, key: "front" }), code("offline"));
});

test("session.reload: a new session with the new static modules when they changed; skipped when not; waits for the turn when busy", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const before = d.session.get(M, "front");
  await f.service("session.reload", { agent: M, key: "front" });
  assert.equal(d.of("session.reload").length, 0); // nothing changed
  assert.equal(d.session.get(M, "front"), before);
  f.persona.files[0]!.content = "soul v2";
  const out: any = (await f.service("session.reload", { agent: M, key: "front" }))!.data;
  assert.equal(d.of("session.reload").length, 1);
  const statics = (d.of("session.reload")[0]![3] as any).static;
  assert.deepEqual(statics.map((m: any) => m.id), ["identity", "rules"]);
  assert.match(statics[0].content, /soul v2/);
  assert.notEqual(out.handle, before);
  assert.equal(f.agents.manager.run(M).spec.sessions.front, out.handle);
  await f.service("session.reload", { agent: M, key: "front" }); // now unchanged again
  assert.equal(d.of("session.reload").length, 1);
  // busy: it waits, and the turn ending does it
  await f.service("session.send", { agent: M, key: "back", messages: [{ text: "work" }] });
  f.persona.files[0]!.content = "soul v3";
  await f.service("session.reload", { agent: M, key: "back" });
  assert.equal(d.of("session.reload").length, 1);
  d.finish(M, "back");
  await waitFor(() => d.of("session.reload").length === 2);
  assert.equal(d.of("session.reload")[1]![2], "back");
});

test("session.compact: busy waits for the turn; a runtime that cannot compact opens a new session instead", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.service("session.send", { agent: M, key: "front", messages: [{ text: "work" }] });
  const waiting: any = (await f.service("session.compact", { agent: M, key: "front" }))!.data;
  assert.equal(waiting.compacted, false);
  assert.equal(d.of("session.compact").length, 0);
  d.finish(M, "front");
  await waitFor(() => d.of("session.compact").length === 1);
  const { WordError } = await import("../../../../sdk/src/message");
  d.compactError = new WordError("unavailable", "no");
  const out: any = (await f.service("session.compact", { agent: M, key: "back" }))!.data;
  assert.equal(out.compacted, false);
  assert.match(out.detail, /new session/);
  assert.equal(d.of("session.new").length, 1);
});

test("keys: a missing key is configured once at start; a key the runtime has is left alone at start; a saved key is written over it; other refs never go in", async () => {
  const f = fixture({ secrets: { DEEPSEEK_API_KEY: "sk-fake-deepseek-0001", CLOUDFLARE_TOKEN: "cf-fake-0002" } });
  await f.start();
  const d = f.driver();
  assert.deepEqual(d.of("credentialsHas").map((c) => c[2]), ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(d.of("credentialsSet").map((c) => c[2]), ["DEEPSEEK_API_KEY"]);
  assert.equal(d.credentials.get("DEEPSEEK_API_KEY"), "sk-fake-deepseek-0001");
  // a restart finds the key there: no second set
  await f.service("restart", { agent: M });
  assert.equal(d.of("credentialsHas").length, 2);
  assert.equal(d.of("credentialsSet").length, 1);
  // the owner saves the key again (it may be a corrected one): written over what the runtime holds, whether it holds one or not
  await f.service("vault.changed", { ref: "DEEPSEEK_API_KEY", action: "saved" }, caller("service:vault", "service"));
  assert.equal(d.of("credentialsSet").length, 2);
  d.credentials.clear();
  await f.service("vault.changed", { ref: "DEEPSEEK_API_KEY", action: "saved" }, caller("service:vault", "service"));
  assert.equal(d.of("credentialsSet").length, 3);
  await f.service("vault.changed", { ref: "CLOUDFLARE_TOKEN", action: "saved" }, caller("service:vault", "service"));
  await f.service("vault.changed", { ref: "DEEPSEEK_API_KEY", action: "removed" }, caller("service:vault", "service"));
  assert.equal(d.of("credentialsSet").length, 3);
  assert.ok(!d.of("credentialsHas").some((c) => c[2] === "CLOUDFLARE_TOKEN"));
  // the value is in no message, no log
  const everything = JSON.stringify([f.router.sent, f.logs, f.ledger.db().prepare("SELECT spec FROM agent_runs").all(), f.ledger.db().prepare("SELECT text FROM agent_inbox").all()]);
  assert.ok(!everything.includes("sk-fake-deepseek-0001") && !everything.includes("cf-fake-0002"));
  // no key in the vault: nothing to give
  const g = fixture();
  await g.start();
  assert.equal(g.driver().of("credentialsHas").length, 0);
});

test("usage: every ten minutes the runtime's records go to service:cost; the cursor moves; with no cost service they are dropped", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  assert.equal(f.timers.everies[0]!.ms, 600_000);
  d.usageRecords = [{ at: 5, done: 100, provider: "deepseek-official", model: "deepseek-flash", input: 10, output: 20, cacheRead: 300, ok: true }, { at: 6, done: 250, provider: "openrouter", model: "x/y", input: 1, output: 2, ok: false, cost: 0.002 }];
  f.router.on("service:cost/usage.recorded", () => ({ ok: true }));
  await f.agents.manager.pollUsage();
  const got = f.router.to("service:cost", "usage.recorded");
  assert.deepEqual(got.map((g) => g.msg.body), [
    { caller: M, provider: "deepseek-official", model: "deepseek-flash", input_tokens: 10, output_tokens: 20, cache_read_tokens: 300, ok: true, at: 5 },
    { caller: M, provider: "openrouter", model: "x/y", input_tokens: 1, output_tokens: 2, ok: false, at: 6, cost: 0.002 },
  ]);
  assert.equal(got[0]!.msg.kind, "event");
  assert.equal(f.agents.manager.run(M).spec.usage_since, 250);
  d.usageRecords = [];
  await f.agents.manager.pollUsage();
  assert.deepEqual(d.of("usage").map((c) => c[2]), [0, 250]);
  // cost is not there: dropped, and the next pull starts after them
  const g = fixture();
  await g.start();
  g.driver().usageRecords = [{ at: 1, done: 100, model: "m", input: 1, output: 1, ok: true }, { at: 2, done: 200, model: "m", input: 1, output: 1, ok: true }];
  await g.agents.manager.pollUsage();
  assert.equal(g.router.to("service:cost", "usage.recorded").length, 1); // stopped at the first "offline"
  assert.equal(g.agents.manager.run(M).spec.usage_since, 100);
});

test("usage: a turn that ends gets its agent's usage pulled a few seconds later; turns inside the wait share one pull", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  f.router.on("service:cost/usage.recorded", () => ({ ok: true }));
  d.usageRecords = [{ at: 5, done: 100, provider: "deepseek-official", model: "deepseek-flash", input: 10, output: 20, ok: true }];
  const fired = new Set<unknown>();
  const usageTimers = () => f.timers.afters.filter((a) => a.ms === 5000 && !a.cancelled && !fired.has(a));
  const fire = () => { const a = usageTimers()[0]!; fired.add(a); a.fn(); };
  await f.call(M, "say", { text: "one" });
  await waitFor(() => d.of("send").length === 1);
  d.finish(M, "front");
  await settle();
  assert.equal(usageTimers().length, 1);
  assert.equal(d.of("usage").length, 0); // not at once: it waits for the debounce
  // more turns end before the timer fires: still the one pull
  await f.call(M, "say", { text: "two" });
  await waitFor(() => d.of("send").length === 2);
  d.finish(M, "front");
  await settle();
  assert.equal(usageTimers().length, 1);
  fire();
  await waitFor(() => f.router.to("service:cost", "usage.recorded").length === 1);
  assert.deepEqual(d.of("usage").map((c) => c[2]), [0]);
  assert.equal(f.agents.manager.run(M).spec.usage_since, 100);
  // the next turn arms a new wait
  d.usageRecords = [];
  await f.call(M, "say", { text: "three" });
  await waitFor(() => d.of("send").length === 3);
  d.finish(M, "front");
  await settle();
  assert.equal(usageTimers().length, 1);
  fire();
  await waitFor(() => d.of("usage").length === 2);
  assert.deepEqual(d.of("usage").map((c) => c[2]), [0, 100]);
  assert.equal(f.timers.everies[0]!.ms, 600_000); // the ten-minute timer stays as the fallback
});

test("removing an agent stops it, takes it out of the registry and clears its inbox", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:b"));
  await f.call("agent:b", "say", { text: "hi" });
  await settle();
  await f.service("remove", { agent: "agent:b" });
  assert.ok(!f.registry.members.has("agent:b"));
  assert.equal(f.ledger.db().prepare("SELECT count(*) AS n FROM agent_inbox WHERE agent='agent:b'").get()!.n, 0);
  assert.deepEqual(((await f.service("list", {}))!.data as any).agents.map((a: any) => a.id), [M]);
});

test("removing an agent has the clock take back the timers it set (as the agents module); a failing clock does not stop the removal", async () => {
  const f = fixture();
  f.router.on("service:clock/cancel.owner", () => ({ ok: true, result: { data: { cancelled: 1 } } }));
  await f.start();
  await f.service("declare", decl("agent:b"));
  await f.service("declare", decl("agent:c"));
  await f.service("remove", { agent: "agent:b" });
  const calls = f.router.to("service:clock", "cancel.owner");
  assert.deepEqual(calls.map((c) => c.msg.body), [{ member: "agent:b" }], "only the removed agent's timers; stopping alone does not do it");
  assert.equal(calls[0]!.caller.member, "service:agents");

  f.router.on("service:clock/cancel.owner", () => { throw new Error("clock down"); });
  await f.service("remove", { agent: "agent:c" });
  assert.ok(!f.registry.members.has("agent:c"));
  assert.ok(f.logs.some((l) => /clearing the timers of agent:c/.test(String(l))));
});

test("stopping an agent keeps its timers (it is still declared)", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:b"));
  await f.service("stop", { agent: "agent:b" });
  assert.equal(f.router.to("service:clock", "cancel.owner").length, 0);
});

test("threads: a question waiting for an answer can be listed and stopped", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const ask = f.service("ask", { agent: M, text: "slow question" }, caller("agent:other"));
  await waitFor(() => sends(d, "back").length === 1);
  const threads: any = (await f.service("threads", {}))!.data;
  assert.equal(threads.threads.length, 1);
  assert.deepEqual([threads.threads[0].from, threads.threads[0].to], ["agent:other", M]);
  assert.deepEqual((await f.service("thread.stop", { thread: threads.threads[0].thread }))!.data, { cancelled: true });
  await assert.rejects(ask, code("cancelled"));
  assert.equal(d.of("interrupt").length, 1);
  assert.deepEqual((await f.service("thread.stop", { thread: "gone" }))!.data, { cancelled: false });
});

test("an agent stops an agent the way the owner does, the primary one included", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:b"));
  await f.service("declare", decl("agent:c"));
  await f.service("stop", { agent: "agent:c" }, OWNER);
  assert.ok(!f.registry.members.has("agent:c"));
  await f.service("stop", { agent: "agent:b" }, caller("agent:b"));
  assert.ok(!f.registry.members.has("agent:b"));
  await f.service("stop", { agent: M }, caller("agent:b"));
  assert.ok(!f.registry.members.has(M));
});

test("SPEC-08 §5.4: an agent calls the same session word the owner does, and the driver sees the same thing", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.service("session.new", { agent: M, key: "front" }, OWNER);
  await f.service("session.new", { agent: M, key: "front" }, caller("agent:other"));
  await f.service("session.new", { agent: M, key: "front" }, caller("service:clock", "service"));
  assert.deepEqual(d.of("session.new"), [["session.new", M, "front"], ["session.new", M, "front"], ["session.new", M, "front"]]);
});

test("an event for a lane the declaration does not have is ignored", async () => {
  const f = fixture();
  await f.start();
  f.driver().report({ event: "turn.started", agent: M, key: "ghost", turn: "t", ids: [] });
  f.driver().report({ event: "output", agent: M, key: "ghost", turn: "t", text: "boo" });
  await settle();
  assert.deepEqual(f.router.says(), []);
});

test("policyOf and currentTurn: the declaration's limits for the router and the tool surface, and the turn an agent is in", async () => {
  const f = fixture();
  await f.start();
  await f.service("declare", decl("agent:b", { tools: ["human_say"], words: ["service:clock/*"] }));
  assert.deepEqual(f.agents.policyOf(M), { tools: null, words: null });
  assert.deepEqual(f.agents.policyOf("agent:b"), { tools: ["human_say"], words: ["service:clock/*"] });
  assert.equal(f.agents.policyOf("agent:nobody"), null);

  assert.equal(f.agents.currentTurn(M, "back"), null);
  f.driver().report({ event: "turn.started", agent: M, key: "back", turn: "t7", ids: [] });
  assert.equal(f.agents.currentTurn(M, "back"), "t7");
  assert.equal(f.agents.currentTurn(M, "front"), null, "a turn on the back lane is not the front lane's");
  assert.equal(f.agents.currentTurn(M, "nope"), null);
  assert.equal(f.agents.currentTurn("agent:b", "back"), null);
  f.driver().report({ event: "turn.started", agent: M, key: "front", turn: "t8", ids: [] });
  assert.equal(f.agents.currentTurn(M, "front"), "t8");
  assert.equal(f.agents.currentTurn(M, "back"), "t7", "both lanes in a turn at once: each has its own");
  f.driver().report({ event: "turn.ended", agent: M, key: "back", turn: "t7", outcome: "completed" });
  assert.equal(f.agents.currentTurn(M, "back"), null);
  assert.equal(f.agents.currentTurn(M, "front"), "t8");
});
