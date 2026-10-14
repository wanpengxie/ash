import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mayCall, type CallerKind } from "../../../../sdk/src/word";
import { WORD_CONTRACTS } from "../../../../sdk/src/words";
import { agentMay, authorize } from "../../../src/kernel/router";
import { toolWords } from "../../../src/edges/tools/tools";
import { agent, app, DEVICE, fake, flush, hand, owner, remoteOwner, service, word, world, failure } from "./world";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "auth.snapshot.txt");
const KINDS: CallerKind[] = ["owner", "agent", "app", "kernel"];

test("who may call: every distinct `callers` set of the contracts, and the kinds it lets in (snapshot)", () => {
  const sets = [...new Set(WORD_CONTRACTS.map((c) => c.callers.join(",")))].sort();
  const text = [
    "# Who passes the first layer of authorization for each distinct `callers` of the contracts (mayCall).",
    "# Update on purpose: UPDATE_SNAPSHOT=1 node --import tsx --test packages/core/test/kernel/router/auth.test.ts",
    ...sets.map((s) => `${s.padEnd(18)} ${KINDS.map((k) => `${k}:${mayCall(s.split(",") as CallerKind[], k) ? "yes" : "no"}`).join(" ")}`),
  ].join("\n") + "\n";
  if (process.env.UPDATE_SNAPSHOT === "1" || !existsSync(SNAPSHOT)) writeFileSync(SNAPSHOT, text);
  assert.equal(text, readFileSync(SNAPSHOT, "utf8"));
});

test("the router refuses by `callers` for the kind of caller, and the kernel passes everywhere", async () => {
  const w = world();
  const only = (callers: CallerKind[]) => word("service:t", "w", { callers });
  w.registry.add(fake("service:t", [only(["owner"]), word("service:t", "kernel", { callers: ["kernel"] }), word("service:t", "agents", { callers: ["agent"] })]));
  const send = (word: string, caller: any) => w.router.send({ to: "service:t", kind: "request", word, body: {} }, caller);
  assert.equal(failure(await send("w", agent())).code, "forbidden");
  assert.equal(failure(await send("w", app())).code, "forbidden");
  assert.ok((await send("w", owner)).ok);
  assert.ok((await send("w", service())).ok, "the kernel is not held to callers");
  assert.equal(failure(await send("kernel", owner)).code, "forbidden");
  assert.equal(failure(await send("kernel", agent())).code, "forbidden");
  assert.ok((await send("kernel", service())).ok);
  assert.equal(failure(await send("agents", owner)).code, "forbidden");
});

test("the router does not check local_only: the owner from a remote channel passes as from this machine", async () => {
  const w = world();
  w.registry.add(fake("service:vault", [word("service:vault", "set", { callers: ["owner"], local_only: true, effect: "write" })]));
  const send = (caller: any) => w.router.send({ to: "service:vault", kind: "request", word: "set", body: {} }, caller);
  assert.ok((await send(remoteOwner)).ok);
  assert.ok((await send(owner)).ok);
});

test("an agent's declaration: unknown agent, a words list, a tool that stands for words", async () => {
  const w = world({ policies: { "agent:ghost": null, "agent:narrow": { words: ["service:t/a", "service:x*"] }, "agent:tooled": { tools: ["clock"], words: [] } },
    toolWords: (tool) => (tool === "clock" ? ["service:t/b"] : []) });
  w.registry.add(fake("service:t", [word("service:t", "a"), word("service:t", "b"), word("service:t", "c")]));
  const send = (name: string, wd: string) => w.router.send({ to: "service:t", kind: "request", word: wd, body: {} }, agent(name));
  assert.equal(failure(await send("ghost", "a")).code, "forbidden");
  assert.ok((await send("narrow", "a")).ok);
  assert.equal(failure(await send("narrow", "b")).code, "forbidden");
  assert.ok((await send("tooled", "b")).ok);
  assert.equal(failure(await send("tooled", "a")).code, "forbidden");
  assert.ok((await send("main", "c")).ok, "no limits declared");
});

// ---- the structural rules of SPEC-01 §5.2, one test each -------------------------------------------------------------
test("rule: agents cannot say to each other", async () => {
  const w = world();
  w.registry.add(Object.assign(fake("agent:b", [word("agent:*", "say", { callers: ["agent", "owner"] })])));
  const reply = await w.router.send({ to: "agent:b", kind: "request", word: "say", body: {} }, agent("main"));
  assert.equal(failure(reply).code, "forbidden");
  assert.match(failure(reply).message, /say to each other/);
});

test("rule: a sub-agent speaks to the owner only where it was addressed", async () => {
  const w = world({ mayTalkToOwner: (caller) => caller.member !== "agent:w-1" });
  const say = () => ({ to: "person:owner", kind: "request" as const, word: "say", body: { text: "hi" } });
  assert.equal(failure(await w.router.send(say(), agent("w-1"))).code, "forbidden");
  assert.ok((await w.router.send(say(), agent("main"))).ok);
});

test("rule: service:agents/answer comes from an agent in a turn, and the one that was asked", async () => {
  const w = world({ mayAnswer: (caller, body) => (body as any).in_reply_to === `asked:${caller.member}` });
  w.registry.add(fake("service:agents", [word("service:agents", "answer", { callers: ["agent"], effect: "act" })]));
  const answer = (caller: any, in_reply_to = "asked:agent:main") => w.router.send({ to: "service:agents", kind: "request", word: "answer", body: { in_reply_to, text: "x" } }, caller);
  assert.ok((await answer(agent("main"))).ok);
  assert.equal(failure(await answer(agent("other"))).code, "forbidden");
  assert.equal(failure(await answer({ ...agent("main"), turn: undefined })).code, "forbidden", "not in a turn");
});

test("rule: an app uses only what it was granted", async () => {
  const w = world({ appGranted: (id, to, wd) => id === "app:todo" && to === "service:t" && wd === "a" });
  w.registry.add(fake("service:t", [word("service:t", "a"), word("service:t", "b")]));
  const send = (wd: string, caller: any) => w.router.send({ to: "service:t", kind: "request", word: wd, body: {} }, caller);
  assert.ok((await send("a", app("todo"))).ok);
  assert.equal(failure(await send("b", app("todo"))).code, "forbidden");
  assert.equal(failure(await send("a", app("other"))).code, "forbidden");
  const none = world();
  none.registry.add(fake("service:t", [word("service:t", "a")]));
  assert.equal(failure(await none.router.send({ to: "service:t", kind: "request", word: "a", body: {} }, app())).code, "forbidden", "no grants given: nothing");
});

test("rule: a hand sends events and nothing else", async () => {
  const w = world();
  w.registry.add(fake("service:senses", [word("service:senses", "sense.location", { kind: "event", callers: ["kernel"], direction: "in" })]));
  w.registry.add(fake(DEVICE, [word(DEVICE, "sense.location", { kind: "event", callers: ["kernel"], direction: "out" })]));
  w.registry.add(fake("service:t", [word("service:t", "a")]));
  assert.equal(failure(await w.router.send({ to: "service:t", kind: "request", word: "a", body: {} }, hand)).code, "forbidden");
  assert.ok((await w.router.send({ to: "service:senses", kind: "event", word: "sense.location", body: {} }, hand)).ok);
});

test("rule: an event is allowed when the sender's own words declare it, whoever the sender is; callers are not asked", async () => {
  const w = world({ appGranted: () => false });
  const ev = (member: string) => word(member, "thing.happened", { kind: "event", callers: ["kernel"], direction: "out" });
  const sender = (id: string, declares: boolean) => fake(id, declares ? [ev(id)] : []);
  const heard = fake("service:t", [], undefined, { listens: ["thing.happened"] });
  w.registry.add(heard);
  const cases: [string, any][] = [[DEVICE, hand], ["app:todo", app()], ["agent:w-9", agent("w-9")], ["service:clock", service("clock")]];
  for (const [id, caller] of cases) {
    const send = () => w.router.send({ to: null, kind: "event", word: "thing.happened", body: {} }, caller);
    w.registry.add(sender(id, false));
    assert.equal(failure(await send()).code, "forbidden", `${id} does not declare it`);
    w.registry.add(sender(id, true));
    assert.ok((await send()).ok, `${id} declares it`);
  }
  assert.equal(failure(await w.router.send({ to: null, kind: "event", word: "thing.happened", body: {} }, owner)).code, "forbidden", "the owner's edge is a member too, and must declare");
  await flush();
  assert.equal(heard.calls.length, 4);
});

test("agentMay: no limits, a words list, the words of a tool, and the pending words every agent has", () => {
  const tw = (t: string) => (t === "clock" ? ["service:clock/set"] : []);
  assert.ok(agentMay({}, "device:x", "any", tw));
  assert.ok(agentMay({ tools: null, words: null }, "device:x", "any", tw));
  assert.ok(agentMay({ words: ["service:t/*"] }, "service:t", "a", tw));
  assert.ok(!agentMay({ words: ["service:t/*"] }, "service:u", "a", tw));
  assert.ok(agentMay({ tools: ["clock"] }, "service:clock", "set", tw));
  assert.ok(!agentMay({ tools: ["clock"] }, "service:clock", "cancel", tw));
  assert.ok(!agentMay({ tools: [], words: [] }, "service:t", "a", tw));
  for (const w of ["pending.list", "pending.get", "pending.redeem", "pending.skip", "pending.withdraw"]) assert.ok(agentMay({ tools: [], words: [] }, "service:gate", w, tw), w);
  assert.ok(!agentMay({ tools: [], words: [] }, "service:gate", "rules.set", tw));
  assert.ok(Array.isArray(toolWords("device_*")));
});

test("rule: wake and the kernel-only words come from the kernel alone", async () => {
  const w = world();
  w.registry.add(fake("service:pulse", [word("service:pulse", "pulse.due", { callers: ["kernel"], effect: "act" })]));
  const due = (caller: any) => w.router.send({ to: "service:pulse", kind: "request", word: "pulse.due", body: {} }, caller);
  assert.equal(failure(await due(agent())).code, "forbidden");
  assert.equal(failure(await due(owner)).code, "forbidden");
  assert.ok((await due(service("clock"))).ok);
});

test("rule: an attachment follows the messages that hold it; an agent reads any attachment", async () => {
  const w = world();
  const seen: unknown[] = [];
  w.registry.add(fake("service:blobs", [word("service:blobs", "read")], (msg) => { seen.push(msg.body); }));
  const m = w.ledger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "x".repeat(20_000) } });
  const hash = (m.body as any).text.$blob as string;
  const read = (caller: any) => w.router.send({ to: "service:blobs", kind: "request", word: "read", body: { hash } }, caller);
  assert.ok((await read(owner)).ok, "the owner sees everything");
  assert.ok((await read(agent("main"))).ok, "the sender");
  assert.ok((await read(agent("other"))).ok, "any agent: nothing is hidden from agents");
  assert.equal(failure(await read(app())).code, "forbidden", "an app not on the message is not");
  assert.ok((await read(service("history"))).ok);
  assert.ok((await w.router.send({ to: "service:blobs", kind: "request", word: "read", body: { hash: "0".repeat(64) } }, agent("other"))).ok, "an unreferenced hash goes on to blobs, which says not_found");
});

test("authorize: a lookup that found nothing still gets the caller's own checks", () => {
  const deps = { agentPolicy: () => null, ledger: world().ledger };
  assert.equal(authorize({ to: "service:x", word: "w", kind: "request", body: {} }, null, agent(), deps, true)?.code, "forbidden");
  assert.equal(authorize({ to: "service:x", word: "w", kind: "request", body: {} }, null, owner, deps, true), null);
});
