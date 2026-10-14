import assert from "node:assert/strict";
import test from "node:test";
import { secret } from "../../../../sdk/src/word";
import { agent, BODY, DEVICE, failure, fake, flush, owner, service, success, word, world } from "../../kernel/router/world";

const SEND = word(DEVICE, "message.send", { effect: "act", risk: "outward", label: { doing: "在发消息" },
  input_schema: { type: "object", properties: { text: { type: "string" }, token: secret({ type: "string" }) }, additionalProperties: false } });
const BASH = word(BODY, "workspace.bash", { effect: "execute", risk: "structure", label: { doing: "在跑命令" } });

const PHONE_NAME = "手机 · Xiaomi M2006J10C";
const AGENT_NAME = "ash";

function setup(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  const phone = fake(DEVICE, [SEND], (msg) => ({ data: { sent: (msg.body as any).text } }), { name: PHONE_NAME });
  const computer = fake(BODY, [BASH], () => ({ data: { exit: 0 } }), { name: "电脑" });
  w.main.name = AGENT_NAME;
  w.registry.add(phone); w.registry.add(computer);
  const ask = (text = "hi", extra: Record<string, unknown> = {}, opts?: any) => w.router.send({ to: DEVICE, kind: "request", word: "message.send", body: { text, ...extra } }, agent(), opts);
  const gateCall = (wd: string, body: unknown, caller: any = agent()) => w.router.send({ to: "service:gate", kind: "request", word: wd, body }, caller);
  return { ...w, phone, computer, ask, gateCall };
}

test("ask: the agent gets waiting_owner at once, the owner gets a card, the answer reaches the agent, redeem runs it once", async () => {
  const s = setup();
  const first = await s.ask("hello");
  const waiting = success(first);
  assert.equal(waiting.status, "waiting_owner");
  assert.equal(waiting.expires_at, s.clock.now + 10 * 60_000);
  assert.equal(s.phone.calls.length, 0, "nothing ran");
  await flush();

  const card = s.owner.cards[0]!.msg.body as any;
  assert.deepEqual(card.options.map((o: any) => o.id), ["once", "always", "deny"]);
  assert.equal(card.human_kind, "question");
  assert.equal(card.expires_at, waiting.expires_at);
  assert.equal(s.owner.cards[0]!.msg.from, "service:gate");
  assert.equal(s.ledger.request(waiting.pending_id)?.state, "waiting_owner");

  s.owner.answer("once");
  await flush();
  assert.equal(s.store.getPending(waiting.pending_id)?.state, "approved");
  // The answer is the owner's own say to the agent (a front turn), with the pending id and the choice in it; no background tell.
  const note = s.main.inbox.at(-1)!;
  assert.equal(note.word, "say");
  assert.equal(note.from, "person:owner");
  assert.deepEqual(note.body, { text: "批准：发消息", in_reply_to: waiting.pending_id, option_id: "once" });
  assert.equal(s.main.inbox.filter((m) => m.word === "tell").length, 0);

  const listed = success(await s.gateCall("pending.list", {}));
  assert.deepEqual(listed.pending.map((p: any) => [p.id, p.state]), [[waiting.pending_id, "approved"]]);
  const got = success(await s.gateCall("pending.get", { id: waiting.pending_id }));
  assert.deepEqual([got.request.word, got.answer.choice], ["message.send", "once"]);

  const done = await s.gateCall("pending.redeem", { id: waiting.pending_id });
  assert.deepEqual(success(done).result, { sent: "hello" });
  assert.equal(s.phone.calls.length, 1);
  assert.equal(s.phone.calls[0]!.msg.id, waiting.pending_id, "the same request, now dispatched");
  assert.equal(s.ledger.request(waiting.pending_id)?.state, "done");
  assert.equal(s.ledger.page({ limit: 50 }).filter((m) => m.id === waiting.pending_id).length, 1, "it is in the ledger once");
  assert.equal(s.store.evidence(waiting.pending_id)?.decision, "once");
  assert.ok(s.store.evidence(waiting.pending_id)?.executed);

  const again = failure(await s.gateCall("pending.redeem", { id: waiting.pending_id }));
  assert.equal(again.code, "conflict");
  assert.equal(s.phone.calls.length, 1, "only once");
  assert.deepEqual(success(await s.gateCall("pending.list", {})).pending, []);
});

test("ask: a refusal tells the agent and cannot be redeemed", async () => {
  const s = setup();
  const id = success(await s.ask()).pending_id;
  await flush();
  s.owner.answer("deny");
  await flush();
  assert.equal(s.main.inbox.at(-1)!.word, "say");
  assert.deepEqual(s.main.inbox.at(-1)!.body, { text: "拒绝：发消息", in_reply_to: id, option_id: "deny" });
  assert.equal(failure(await s.gateCall("pending.redeem", { id })).code, "conflict");
  assert.equal(s.phone.calls.length, 0);
  assert.equal(s.store.evidence(id)?.decision, "deny");
  assert.equal(success(await s.gateCall("pending.skip", { id, reason: "no" })).skipped, true);
  assert.equal(s.owner.said.length, 1, "the owner is told it was skipped");
});

test("ask: a card that ended by its time was no word of the owner's: the agent is told in the background; a failed say falls back to that too", async () => {
  const none = setup({ ownerSay: "none" });
  const first = success(await none.ask()).pending_id;
  await flush();
  none.owner.answer("deny");
  await flush();
  assert.deepEqual(none.main.inbox.map((m) => m.word), ["tell"]);
  assert.match((none.main.inbox[0]!.body as any).text, new RegExp(`${first}.*超时`));

  const broken = setup({ ownerSay: "fails" });
  const id = success(await broken.ask()).pending_id;
  await flush();
  broken.owner.answer("once");
  await flush();
  assert.equal(broken.main.inbox.at(-1)!.word, "tell");
  assert.match((broken.main.inbox.at(-1)!.body as any).text, new RegExp(`批准.*${id}.*pending\\.redeem`));
  assert.equal(broken.store.getPending(id)?.state, "approved", "the approval stands");
});

test("ask: no answer by the deadline is a refusal; a late answer changes nothing", async () => {
  const s = setup();
  const id = success(await s.ask("late", {}, { approval: { ttl_minutes: 2, purpose: "test" } })).pending_id;
  await flush();
  assert.equal(s.store.getPending(id)?.expires_at, s.clock.now + 2 * 60_000);
  s.clock.now += 2 * 60_000;
  s.svc.sweep();
  await flush();
  assert.equal(s.store.getPending(id)?.state, "expired");
  assert.match((s.main.inbox.at(-1)!.body as any).text, /超时/);
  assert.equal(failure(await s.gateCall("pending.redeem", { id })).code, "conflict");
  s.owner.answer("once");
  await flush();
  assert.equal(s.store.getPending(id)?.state, "expired");
  assert.equal(s.store.evidence(id)?.decision, "timeout");
  assert.equal(s.phone.calls.length, 0);
});

test("ask: an expiry is found even without the sweep, when somebody looks", async () => {
  const s = setup();
  const id = success(await s.ask()).pending_id;
  s.clock.now += 11 * 60_000;
  assert.equal(success(await s.gateCall("pending.get", { id })).state, "expired");
  assert.equal(s.main.inbox.length, 1);
});

test("ask: the approval-ttl is clamped and defaults to ten minutes", async () => {
  const s = setup();
  assert.equal(success(await s.ask("a", {}, { approval: { ttl_minutes: 999_999 } })).expires_at, s.clock.now + 10_080 * 60_000);
  assert.equal(success(await s.ask("b", {}, { approval: { ttl_minutes: 0 } })).expires_at, s.clock.now + 10 * 60_000);
});

test("ask: pending words belong to the agent that asked", async () => {
  const s = setup({ policies: {} });
  const id = success(await s.ask()).pending_id;
  await flush();
  s.owner.answer("once"); await flush();
  const other = agent("other");
  assert.equal(failure(await s.gateCall("pending.get", { id }, other)).code, "not_found");
  assert.equal(failure(await s.gateCall("pending.redeem", { id }, other)).code, "not_found");
  assert.deepEqual(success(await s.gateCall("pending.list", {}, other)).pending, []);
  assert.equal(failure(await s.gateCall("pending.redeem", { id }, owner)).code, "forbidden", "callers: agent");
  assert.equal(s.phone.calls.length, 0);
});

test("withdraw: the agent takes its question back while it waits and the card is taken down", async () => {
  const s = setup();
  const id = success(await s.ask()).pending_id;
  await flush();
  assert.equal(success(await s.gateCall("pending.withdraw", { id })).withdrawn, true);
  await flush();
  assert.equal(s.store.getPending(id)?.state, "withdrawn");
  assert.equal(s.owner.cancelled.length, 1, "person:owner was told to cancel the card");
  assert.equal(success(await s.gateCall("pending.withdraw", { id })).withdrawn, false);
  assert.equal(failure(await s.gateCall("pending.redeem", { id })).code, "conflict");
});

test("withdraw from the hub's own code needs only that the question still waits; skip, get, list and redeem stay with the agent", async () => {
  const s = setup();
  const a = success(await s.ask("a")).pending_id;
  await flush();
  const reflex = service("reflex");
  assert.equal(success(await s.gateCall("pending.withdraw", { id: a }, reflex)).withdrawn, true);
  assert.equal(s.store.getPending(a)?.state, "withdrawn");
  assert.equal(success(await s.gateCall("pending.withdraw", { id: a }, reflex)).withdrawn, false, "no longer waiting");
  assert.equal(failure(await s.gateCall("pending.withdraw", { id: "nope" }, reflex)).code, "not_found");
  for (const wd of ["pending.get", "pending.skip"]) assert.equal(failure(await s.gateCall(wd, { id: a }, reflex)).code, "forbidden", wd);
});

test("a question that ends without being carried out closes its request with a response that says how", async () => {
  const s = setup();
  const seen: string[] = [];
  s.router.subscribe({ word: "message.send" }, (m) => seen.push(`${m.kind}:${m.seq > 0 ? "seq" : "noseq"}`));
  const responseOf = (id: string) => s.ledger.page({ limit: 100 }).find((m) => m.kind === "response" && m.reply_to === id) as any;

  const denied = success(await s.ask("1")).pending_id;
  const expired = success(await s.ask("2")).pending_id;
  const withdrawn = success(await s.ask("3")).pending_id;
  const skipped = success(await s.ask("4")).pending_id;
  assert.deepEqual(seen, ["request:seq", "request:seq", "request:seq", "request:seq"], "the parked request reaches the subscribers, recorded");
  await flush();
  s.owner.answer("deny", 0);                                      // 1: refused
  await flush();
  await s.gateCall("pending.withdraw", { id: withdrawn });          // 3: taken back
  s.owner.answer("once", 3); await flush();                         // 4: approved, then given up
  await s.gateCall("pending.skip", { id: skipped });
  s.clock.now += 11 * 60_000;                                        // 2: nobody answered
  s.svc.sweep();

  for (const [id, code] of [[denied, "denied"], [expired, "timeout"], [withdrawn, "cancelled"], [skipped, "cancelled"]] as const) {
    assert.equal(s.ledger.request(id)?.state, "done", code);
    assert.equal(responseOf(id).body.error.code, code);
  }
  assert.ok(!s.ledger.unfinished().some((r) => [denied, expired, withdrawn, skipped].includes(r.id)));
  await flush();
  assert.equal(s.ledger.page({ limit: 100 }).filter((m) => m.kind === "response" && [denied, expired, withdrawn, skipped].includes(m.reply_to!)).length, 4, "one response each, none twice");
  assert.equal(seen.filter((x) => x.startsWith("response")).length, 4, "and the subscribers see them");
});

test("redeem sends the request on without publishing it a second time; the signal reaches the request", async () => {
  const s = setup();
  const id = success(await s.ask("again")).pending_id;
  await flush();
  s.owner.answer("once"); await flush();
  const seen: string[] = [];
  s.router.subscribe({ word: "message.send" }, (m) => seen.push(`${m.kind}:${m.seq}`));
  await s.gateCall("pending.redeem", { id });
  assert.equal(seen.length, 1, "only the response");
  assert.match(seen[0]!, /^response:[1-9]/);

  const hang = setup();
  hang.phone.handler = () => new Promise(() => {});
  const id2 = success(await hang.ask("slow")).pending_id;
  await flush();
  hang.owner.answer("once"); await flush();
  const controller = new AbortController();
  const pending = hang.router.send({ to: "service:gate", kind: "request", word: "pending.redeem", body: { id: id2 } }, agent(), { signal: controller.signal });
  await flush();
  controller.abort();
  assert.equal(failure(await pending).code, "cancelled");
  await flush();
  assert.equal(hang.phone.cancelled.length, 1, "the member doing the work was told to stop");
});

test("an approval is good until the original expires_at, not longer", async () => {
  const s = setup();
  const id = success(await s.ask("late")).pending_id;
  await flush();
  s.owner.answer("once"); await flush();
  s.clock.now += 10 * 60_000;
  const reply = await s.gateCall("pending.redeem", { id });
  assert.equal(failure(reply).code, "conflict");
  assert.equal(s.phone.calls.length, 0);
  assert.equal(s.store.getPending(id)?.state, "expired");
  assert.equal(s.ledger.request(id)?.state, "done");
});

test("an approval nobody carried out expires with the sweep too, and its request is closed with a timeout", async () => {
  const s = setup();
  const id = success(await s.ask("never redeemed")).pending_id;
  await flush();
  s.owner.answer("once"); await flush();
  assert.equal(s.store.getPending(id)?.state, "approved");
  const notes = s.main.inbox.length;
  s.clock.now += 10 * 60_000;
  assert.deepEqual(s.store.expireDue().map((p) => [p.id, p.state]), [[id, "expired"]]);
  assert.equal(s.ledger.request(id)?.state, "done");
  const response = s.ledger.page({ limit: 100 }).find((m) => m.kind === "response" && m.reply_to === id) as any;
  assert.equal(response.body.error.code, "timeout");
  assert.equal(s.main.inbox.length, notes, "the agent was told of the answer already; an approval running out is not announced again");
  assert.deepEqual(s.store.expireDue(), []);
});

test("the card reads in names and labels: no ids, no word, no effect or risk codes", async () => {
  const s = setup();
  await s.ask("x", {}, { approval: { purpose: "自动化测试" } });
  await flush();
  const card = s.owner.cards[0]!.msg.body as any;
  assert.equal(card.title, "需要你确认：在发消息");
  assert.match(card.detail, /^ash 想对「手机 · Xiaomi M2006J10C」做这件事：在发消息。/);
  for (const text of [card.title, card.detail]) {
    assert.doesNotMatch(text, /agent:|device:|body:|service:|person:/, "no member ids");
    assert.doesNotMatch(text, /message\.send/, "no word");
    assert.doesNotMatch(text, /\b(act|outward|structure|execute|effect|risk)\b|效果|风险/, "no effect or risk codes");
  }
  assert.match(card.detail, /目的：自动化测试/);
  assert.equal(card.source.word, "message.send", "the details keep the raw word");
  assert.equal(card.source.to, DEVICE);
});

test("a card for a service leaves the object out; the main container is the main agent's container", async () => {
  const s = setup();
  const APPS = word("service:apps", "apps.install", { effect: "act", risk: "structure", label: { doing: "在安装应用" } });
  s.registry.add(fake("service:apps", [APPS], () => ({ data: {} }), { name: "apps" }));
  s.registry.add(fake("body:main", [word("body:main", "workspace.bash", { effect: "execute", risk: "structure", label: { doing: "在跑命令" } })], () => ({ data: {} }), { name: "main body" }));
  success(await s.router.send({ to: "service:apps", kind: "request", word: "apps.install", body: {} }, agent()));
  success(await s.router.send({ to: "body:main", kind: "request", word: "workspace.bash", body: { command: "ls" } }, agent()));
  await flush();
  const [apps, main] = s.owner.cards.map((c) => (c.msg.body as any).detail as string);
  assert.equal(apps, "ash 想做这件事：在安装应用。");
  assert.equal(main, "ash 想对「ash 的容器」做这件事：在跑命令。");
  for (const text of [apps, main]) assert.doesNotMatch(text, /service:|body:|apps|main body/);
});

test("after a restart the phone is not connected: the card uses the name it was paired with, and the id only if even that is gone", async () => {
  const hand = DEVICE.slice("device:".length);
  const s = setup({ handNames: { [hand]: "手机 · Xiaomi M2006J10C" } });
  success(await s.ask("x"));                       // parked while the phone is connected
  await flush();
  s.registry.remove(DEVICE);                       // the hub restarts: the phone has not reconnected, the registry does not have it
  s.svc.stop(); s.svc.start();                     // and the hub sends the open questions again
  await flush();
  const again = (s.owner.cards.at(-1)!.msg.body as any).detail as string;
  assert.match(again, /^ash 想对「手机 · Xiaomi M2006J10C」做这件事：在发消息。/);
  assert.doesNotMatch(again, /device:/);
  s.owner.answer("deny"); await flush();
  s.svc.stop();

  const bare = setup();
  success(await bare.ask("y"));
  await flush();
  bare.registry.remove(DEVICE);
  bare.svc.stop(); bare.svc.start();
  await flush();
  assert.match((bare.owner.cards.at(-1)!.msg.body as any).detail, new RegExp(`^ash 想对「${DEVICE}」`));
  bare.owner.answer("deny"); await flush();
  bare.svc.stop();
});

test("a member that is gone falls back to its id on the card, and nothing breaks", async () => {
  const s = setup();
  s.registry.remove(s.main.id);
  await s.ask("x");
  await flush();
  assert.match((s.owner.cards[0]!.msg.body as any).detail, /^agent:main 想对「手机 · Xiaomi M2006J10C」做这件事：在发消息。/);
});

test("ask: 「以后都可以」 writes a rule, and the same agent is then let through without a card", async () => {
  const s = setup();
  const id = success(await s.ask("one")).pending_id;
  await flush();
  s.owner.answer("always"); await flush();
  assert.equal(s.store.listRules().rules.length, 1);
  const rules = success(await s.gateCall("rules.list", {}));
  assert.equal(rules.rules[0].word, "message.send");
  assert.equal(rules.mode, "auto");
  const result = await s.ask("two");
  assert.deepEqual(success(result), { sent: "two" }, "no waiting this time");
  assert.equal(s.owner.cards.length, 1);
  await s.gateCall("pending.skip", { id });
});

test("a card is not offered 「以后都可以」 for a command, and an answer of always counts as once", async () => {
  const s = setup();
  const reply = await s.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: {} }, agent());
  const id = success(reply).pending_id;
  await flush();
  assert.deepEqual((s.owner.cards[0]!.msg.body as any).options.map((o: any) => o.id), ["once", "deny"]);
  s.owner.answer("always"); await flush();
  assert.equal(s.store.listRules().rules.length, 0);
  assert.equal(s.store.getPending(id)?.answer?.choice, "once");
});

test("a command through the tool: review model, never a rule or a carry; full tier lets it through", async () => {
  const s = setup({ review: "allow" });
  const run = () => s.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: { command: "ls" } }, agent());
  assert.deepEqual(success(await run()), { exit: 0 });
  assert.deepEqual(success(await run()), { exit: 0 });
  assert.equal(s.state.reviews, 2, "reviewed both times");
  const full = setup({ review: "ask", tiers: { [BODY]: "full" } });
  assert.deepEqual(success(await full.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: {} }, agent())), { exit: 0 });
  assert.equal(full.state.reviews, 0);
  const asks = setup({ review: "ask" });
  assert.equal(success(await asks.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: {} }, agent())).status, "waiting_owner");
});

test("the review model denies: the agent gets denied with its reason, no card, nothing parked", async () => {
  const reason = "命令太长（70000 字），审不了。请先用 workspace.write 把脚本写成文件，再执行那个文件。";
  const s = setup({ review: { verdict: "deny", reason } });
  const reply = await s.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: { command: "x" } }, agent());
  const err = failure(reply);
  assert.equal(err.code, "denied");
  assert.equal(err.message, reason);
  await flush();
  assert.equal(s.owner.cards.length, 0);
  assert.equal(s.store.waiting().length, 0);
  assert.equal(s.computer.calls.length, 0);
});

test("the review model asks with a reason: the card's detail starts with it, and the full body stays in the source", async () => {
  const s = setup({ review: { verdict: "ask", reason: "会删除 build 目录，可以重新生成" } });
  const command = `rm -r build ${"x".repeat(400)}`;
  assert.equal(success(await s.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: { command } }, agent())).status, "waiting_owner");
  await flush();
  const card = s.owner.cards[0]!.msg.body as any;
  assert.equal(card.detail.split("\n")[0], "审核：会删除 build 目录，可以重新生成");
  assert.equal(JSON.parse(card.source.body_full).command, command);
  // no reason from the model: no 审核 line
  const plain = setup({ review: "ask" });
  await plain.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: { command: "x" } }, agent());
  await flush();
  assert.doesNotMatch((plain.owner.cards[0]!.msg.body as any).detail, /审核：/);
});

test("an app is refused, not asked", async () => {
  const s = setup({ appGranted: () => true });
  const reply = await s.router.send({ to: DEVICE, kind: "request", word: "message.send", body: { text: "x" } }, { member: "app:todo", via: "app", local: false });
  assert.equal(failure(reply).code, "forbidden");
  await flush();
  assert.equal(s.owner.cards.length, 0);
  assert.equal(s.store.waiting().length, 0);
});

test("a request with a secret cannot wait for the owner: nothing is parked, nothing is written down", async () => {
  const s = setup();
  const reply = await s.ask("with secret", { token: "tok-123456" });
  assert.equal(failure(reply).code, "forbidden");
  await flush();
  assert.equal(s.owner.cards.length, 0);
  assert.equal(s.store.waiting().length, 0);
  assert.equal(s.ledger.page({ limit: 50 }).length, 0);
  assert.ok(!JSON.stringify(s.ledger.db().prepare("SELECT data FROM gate_audit").all()).includes("tok-123456"));
  assert.equal(s.phone.calls.length, 0);
});

test("restart: the open questions get their cards again, and an answer then still lets the agent redeem", async () => {
  const s = setup();
  const id = success(await s.ask("after restart")).pending_id;
  await flush();
  s.router.recover();                         // waiting_owner is left alone
  assert.equal(s.ledger.request(id)?.state, "waiting_owner");
  s.svc.stop();
  s.svc.start();                              // a new service over the same tables sends the cards again
  await flush();
  assert.equal(s.owner.cards.length, 2);
  s.owner.answer("once"); await flush();
  assert.deepEqual(success(await s.gateCall("pending.redeem", { id })).result, { sent: "after restart" });
  s.svc.stop();
});

test("rules.set / revoke / mode.set: the owner does them directly, an agent is asked every time", async () => {
  const s = setup();
  const set = await s.gateCall("rules.set", { agent: "agent:main", member: DEVICE, word: "message.send", days: 3 }, owner);
  const ruleId = success(set).id;
  assert.equal(success(set).expires_at, s.clock.now + 3 * 86_400_000);
  assert.equal(success(await s.ask("by rule")).sent, "by rule");
  assert.equal(failure(await s.gateCall("rules.set", { agent: "agent:main", member: BODY, word: "workspace.bash" }, owner)).code, "forbidden", "no rule for a command");
  assert.equal(failure(await s.gateCall("rules.set", { agent: "agent:main", member: DEVICE, word: "nope" }, owner)).code, "not_found");
  assert.equal(success(await s.gateCall("rules.revoke", { id: ruleId }, owner)).revoked, true);
  assert.equal(success(await s.ask("again")).status, "waiting_owner");

  const viaAgent = await s.gateCall("mode.set", { mode: "always" });
  assert.equal(success(viaAgent).status, "waiting_owner");
  assert.equal(s.store.mode(), "auto", "nothing changed yet");
  await flush();
  const card = s.owner.cards.at(-1)!;
  assert.deepEqual((card.msg.body as any).options.map((o: any) => o.id), ["once", "deny"], "no 「以后都可以」 for the gate's own words");
  card.answer({ data: { choice: "once" } }); await flush();
  assert.ok((await s.gateCall("pending.redeem", { id: success(viaAgent).pending_id })).ok);
  assert.equal(s.store.mode(), "always");
  assert.equal(success(await s.gateCall("mode.set", { mode: "auto" }, owner)).mode, "auto");
});

test("audit and history show what was decided", async () => {
  const s = setup({ review: "allow" });
  await s.ask("reviewed");
  const id = success(await s.router.send({ to: BODY, kind: "request", word: "workspace.bash", body: {} }, agent())).status;
  void id;
  const audit = success(await s.gateCall("audit", {}, owner));
  assert.equal(audit.entries.length, 2);
  assert.deepEqual(audit.entries.map((e: any) => e.decision), ["review", "review"]);
  assert.equal(success(await s.gateCall("audit", { word: "workspace.bash" }, owner)).entries.length, 1);
  const history = success(await s.gateCall("history", { limit: 1 }, owner));
  assert.equal(history.items.length, 1);
  assert.ok(history.next_before);
  assert.deepEqual([history.items[0].word, history.items[0].decision], ["workspace.bash", "review"]);
});

test("attachments: only the owner and the two sides of a message can read what it holds", async () => {
  const s = setup();
  const reads: string[] = [];
  s.registry.add(fake("service:blobs", [word("service:blobs", "read")], (m) => { reads.push(m.from); }));
  const m = s.ledger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "y".repeat(20_000) } });
  const hash = (m.body as any).text.$blob;
  const read = (caller: any) => s.router.send({ to: "service:blobs", kind: "request", word: "read", body: { hash } }, caller);
  assert.ok((await read(agent("main"))).ok);
  assert.equal(failure(await read(agent("other"))).code, "forbidden");
  assert.deepEqual(reads, ["agent:main"]);
});

test("a member that has a cardDetail adds that to the card, and a cardDetail that fails does not stop the question", async () => {
  const s = setup();
  s.registry.add(fake(DEVICE, [SEND], () => ({ data: {} }), { name: PHONE_NAME, cardDetail: (msg: any) => `会用到：通知权限（${msg.body.text}）` }));
  const id = success(await s.ask("安装")).pending_id;
  await flush();
  const detail = (s.owner.cards[0]!.msg.body as any).detail as string;
  assert.match(detail, /^ash 想对「手机 · Xiaomi M2006J10C」做这件事：在发消息。/);
  assert.match(detail, /\n会用到：通知权限（安装）$/);
  assert.equal(s.store.getPending(id)?.detail, "会用到：通知权限（安装）");

  s.registry.add(fake(DEVICE, [SEND], () => ({ data: {} }), { cardDetail: () => { throw new Error("boom"); } }));
  assert.equal(success(await s.ask("again")).status, "waiting_owner");
  await flush();
  assert.ok(!(s.owner.cards[1]!.msg.body as any).detail.includes("\n"));
  assert.equal(s.errors.length, 1);
});

test("fast path: answered in time, the call goes on in the same breath: it runs, its result is the call's result, nobody is spoken to, no redeem", async () => {
  const s = setup({ fastWaitMs: 5_000 });
  let seen: string | undefined;
  const call = s.ask("quick", {}, { waiting: () => { seen = "held"; } });
  await flush();
  assert.equal(seen, "held", "the tool surface is told the call is held");
  assert.equal(s.owner.cards.length, 1, "the card is the usual one");
  assert.equal(s.phone.calls.length, 0, "nothing ran before the answer");
  s.owner.answer("once");
  const reply = await call;
  assert.deepEqual(success(reply), { sent: "quick" });
  assert.equal(s.phone.calls.length, 1);
  assert.equal(s.main.inbox.length, 0, "no word to the agent, no background tell");
  const id = s.phone.calls[0]!.msg.id;
  assert.equal(s.store.getPending(id)?.state, "redeemed", "the approval is used up by the call itself");
  assert.equal(s.store.evidence(id)?.decision, "once");
  assert.ok(s.store.evidence(id)?.executed);
  assert.equal(failure(await s.gateCall("pending.redeem", { id })).code, "conflict");
  assert.equal(s.ledger.request(id)?.state, "done");
});

test("fast path: 「以后都可以」 in time still writes the rule", async () => {
  const s = setup({ fastWaitMs: 5_000 });
  const call = s.ask("again");
  await flush();
  s.owner.answer("always");
  assert.deepEqual(success(await call), { sent: "again" });
  assert.equal(s.main.inbox.length, 0);
  assert.equal(success(await s.ask("third")).sent, "third", "the rule lets the next one through without a card");
});

test("fast path: refused in time, the call is refused at once with a reason, nobody is spoken to", async () => {
  const s = setup({ fastWaitMs: 5_000 });
  const call = s.ask("no");
  await flush();
  s.owner.answer("deny");
  const error = failure(await call);
  assert.equal(error.code, "denied");
  assert.equal(s.phone.calls.length, 0);
  assert.equal(s.main.inbox.length, 0);
});

test("fast path: not answered in time, the receipt comes as before; a later answer takes the slow way (the owner's message), once", async () => {
  const s = setup({ fastWaitMs: 40 });
  const waiting = success(await s.ask("slow"));
  assert.equal(waiting.status, "waiting_owner");
  await flush();
  s.owner.answer("once");
  await flush();
  assert.equal(s.store.getPending(waiting.pending_id)?.state, "approved", "waiting to be redeemed");
  assert.deepEqual(s.main.inbox.map((m) => m.word), ["say"]);
  assert.deepEqual(success(await s.gateCall("pending.redeem", { id: waiting.pending_id })), { result: { sent: "slow" } });
  assert.equal(s.phone.calls.length, 1);
});

test("fast path: the answer and the time meet: only one way is taken", async () => {
  const s = setup({ fastWaitMs: 30 });
  const call = s.ask("edge");
  await flush();
  // The answer comes just after the time: the call has its receipt, and the answer is an ordinary one.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const waiting = success(await call);
  assert.equal(waiting.status, "waiting_owner");
  s.owner.answer("once");
  await flush();
  assert.equal(s.main.inbox.filter((m) => m.word === "say").length, 1);
  assert.equal(s.phone.calls.length, 0, "it did not run by itself");
  assert.equal(s.store.getPending(waiting.pending_id)?.state, "approved");
});

test("fast path: only an agent's call is held; a cancelled call is cancelled and its card stays an ordinary question", async () => {
  const s = setup({ fastWaitMs: 5_000 });
  const stop = new AbortController();
  const call = s.ask("cut", {}, { signal: stop.signal });
  await flush();
  stop.abort();
  assert.equal(failure(await call).code, "cancelled");
  s.owner.answer("once");
  await flush();
  assert.deepEqual(s.main.inbox.map((m) => m.word), ["say"], "the answer after it is spoken to the agent in the conversation");
});
