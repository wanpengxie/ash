import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../../sdk/src/message";
import { createGate, GateStore } from "../../../src/kernel/gate";
import { ALWAYS_ASK } from "../../../src/kernel/gate/decide";
import type { GateDeps } from "../../../src/kernel/types";
import { openLedger } from "../ledger/helpers";
import { agent, app, BODY, DEVICE, hand, owner, remoteOwner, service, word } from "../router/world";

let n = 0;
const req = (from: string, to: string, w: string, body: unknown = {}): Message => ({ seq: 0, id: `r${++n}`, ts: 1, from, to, kind: "request", word: w, body });
const send = word(DEVICE, "message.send", { effect: "act", risk: "outward", label: { doing: "在发消息" } });
const bash = word(BODY, "workspace.bash", { effect: "execute", risk: "structure", label: { doing: "在跑命令" } });
const write = word(BODY, "workspace.write", { effect: "write", risk: "structure", per_call_risk: true, label: { doing: "在写文件" } });
const look = word(DEVICE, "screen.read", { effect: "read", risk: "none" });
const quiet = word(DEVICE, "badge.set", { effect: "write", risk: "none" });

function make(over: Partial<GateDeps> & { reviews?: { n: number } } = {}) {
  const { ledger } = openLedger();
  const clock = { now: 1_000_000 };
  const store = new GateStore(ledger, () => clock.now);
  const counter = over.reviews ?? { n: 0 };
  const deps: GateDeps = { tier: () => "ask", mode: () => store.mode(), review: async () => { counter.n++; return { verdict: "ask" }; }, ...over };
  const gate = createGate(deps, store, { now: () => clock.now, reviewMs: 30, assessMs: 30 });
  return { gate, store, clock, counter };
}
const verdict = async (g: ReturnType<typeof make>, msg: Message, c: any, caller = agent()) => (await g.gate.decide(msg, c, caller));

test("the owner from a human channel is let through; so is any service; a hand is not a caller of requests", async () => {
  const g = make();
  assert.equal((await verdict(g, req("person:owner", DEVICE, "message.send"), send, owner)).by, "human");
  assert.equal((await verdict(g, req("person:owner", DEVICE, "message.send"), send, remoteOwner)).verdict, "allow");
  assert.equal((await verdict(g, req("service:clock", DEVICE, "message.send"), send, service())).verdict, "allow");
  assert.equal((await verdict(g, req(DEVICE, "service:x", "w"), send, hand)).verdict, "deny");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "w"), send, { member: "agent:main", via: "human", local: true })).verdict, "deny", "only the owner comes in as a human");
});

test("a service acting leaves evidence; a service reading leaves none", async () => {
  const g = make();
  const act = req("service:clock", DEVICE, "message.send");
  await verdict(g, act, send, service());
  assert.equal(g.store.evidence(act.id)?.decided_by, "service");
  const read = req("service:clock", DEVICE, "screen.read");
  await verdict(g, read, look, service());
  assert.equal(g.store.evidence(read.id), null);
});

test("an app: a read or a risk-none word goes; anything with a risk is refused, never asked", async () => {
  const g = make();
  assert.equal((await verdict(g, req("app:todo", DEVICE, "screen.read"), look, app())).verdict, "allow");
  assert.equal((await verdict(g, req("app:todo", DEVICE, "badge.set"), quiet, app())).verdict, "allow");
  const outward = await verdict(g, req("app:todo", DEVICE, "message.send"), send, app());
  assert.deepEqual([outward.verdict, outward.by], ["deny", "app"]);
  assert.equal((await verdict(g, req("app:todo", BODY, "workspace.bash"), bash, app())).verdict, "deny");
  assert.equal(g.counter.n, 0, "no review for an app");
});

test("an app calling a per-call word is judged by the assessed risk", async () => {
  const g = make({ assess: async (m) => ((m.body as any).path === "/root/work/a" ? "none" : "structure") });
  assert.equal((await verdict(g, req("app:todo", BODY, "workspace.write", { path: "/root/work/a" }), write, app())).verdict, "allow");
  assert.equal((await verdict(g, req("app:todo", BODY, "workspace.write", { path: "/etc/x" }), write, app())).verdict, "deny");
});

test("agent step 2: a read is let through without evidence", async () => {
  const g = make();
  const r = req("agent:main", DEVICE, "screen.read");
  assert.deepEqual([(await verdict(g, r, look)).verdict, (await verdict(g, r, look)).by], ["allow", "read"]);
  assert.equal(g.store.evidence(r.id), null);
});

test("agent step 3: a payment always asks, with no 「以后都可以」", async () => {
  const g = make({ review: async () => ({ verdict: "allow" }) });
  const pay = word(DEVICE, "wallet.pay", { effect: "act", risk: "outward", label: { doing: "在付款" } });
  const d = await verdict(g, req("agent:main", DEVICE, "wallet.pay"), pay);
  assert.deepEqual([d.verdict, d.by, d.offer_always], ["ask", "payment", false]);
  const click = word(DEVICE, "browser.click", { effect: "act", risk: "outward", label: { doing: "在点击" } });
  assert.equal((await verdict(g, req("agent:main", DEVICE, "browser.click", { label: "立即支付" }), click)).by, "payment", "the button's text decides");
  assert.notEqual((await verdict(g, req("agent:main", DEVICE, "browser.click", { label: "展开" }), click)).by, "payment");
  const byLabel = word(DEVICE, "order.place", { effect: "act", risk: "outward", label: { doing: "在下单" } });
  assert.equal((await verdict(g, req("agent:main", DEVICE, "order.place"), byLabel)).by, "payment");
});

test("agent step 4: one word always asks (keeping a card running is the owner's); rules, devices, persona and installs are decided by the owner's mode and review like any other", async () => {
  assert.deepEqual([...ALWAYS_ASK], ["service:cards/pin", "app:cards/cards.pin"]);
  const pin = await verdict(make({ review: async () => ({ verdict: "allow" }), tier: () => "full" }), req("agent:main", "service:cards", "pin"), word("service:cards", "pin", { effect: "write", risk: "none" }));
  assert.deepEqual([pin.verdict, pin.by, pin.offer_always], ["ask", "always_ask", false], "an agent's pin is a card the owner taps, every time");
  const g = make({ review: async () => ({ verdict: "allow" }), tier: () => "full" });
  for (const [member, w] of [["service:gate", "rules.set"], ["service:gate", "rules.revoke"], ["service:gate", "mode.set"], ["service:devices", "access_set"],
    ["service:devices", "revoke"], ["service:devices", "pair_approve"], ["service:devices", "update"], ["service:persona", "propose"], ["service:apps", "apps.install"]] as const) {
    const c = word(member, w, { effect: "write", risk: "structure" });
    const d = await verdict(g, req("agent:main", member, w), c);
    assert.equal(d.verdict, "allow", `${member}/${w}`);
    assert.notEqual(d.by, "always_ask", `${member}/${w}`);
  }
});

test("agent step 5: no risk, declared or assessed", async () => {
  const g = make({ assess: async (m) => ((m.body as any).path?.startsWith("/root/work") ? "none" : null) });
  assert.equal((await verdict(g, req("agent:main", DEVICE, "badge.set"), quiet)).by, "declared_none");
  const inside = req("agent:main", BODY, "workspace.write", { path: "/root/work/a.txt" });
  assert.equal((await verdict(g, inside, write)).by, "assessed_none");
  assert.equal(g.store.evidence(inside.id)?.decision, "assessed_none");
  const outside = await verdict(g, req("agent:main", BODY, "workspace.write", { path: "/etc/passwd" }), write);
  assert.equal(outside.verdict, "ask", "an assessment that has no answer leaves the declared risk");
});

test("agent step 5: an assessment that hangs is the declared risk", async () => {
  const g = make({ assess: () => new Promise(() => {}) });
  assert.equal((await verdict(g, req("agent:main", BODY, "workspace.write", { path: "/root/work/a" }), write)).verdict, "ask");
});

test("agent step 6: a hand or a lent computer at tier full lets everything through, a command too; body:main never", async () => {
  const g = make({ tier: (t) => (t === "body:main" ? "ask" : "full") });
  assert.equal((await verdict(g, req("agent:main", BODY, "workspace.bash"), bash)).by, "hand_full");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send"), send)).by, "hand_full");
  const main = word("body:main", "workspace.bash", { effect: "execute", risk: "structure" });
  assert.notEqual((await verdict(g, req("agent:main", "body:main", "workspace.bash"), main)).by, "hand_full");
  const svc = word("service:x", "do", { effect: "act", risk: "outward" });
  assert.notEqual((await verdict(g, req("agent:main", "service:x", "do"), svc)).by, "hand_full", "the tier is for hands and bodies");
});

test("agent step 7: mode always asks about everything with an effect", async () => {
  const g = make({ review: async () => ({ verdict: "allow" }) });
  g.store.setMode("always");
  const r = req("agent:main", DEVICE, "message.send");
  const d = await verdict(g, r, send);
  assert.deepEqual([d.verdict, d.by, d.offer_always], ["ask", "mode_always", true], "only payments, the always-ask words and commands go without 「以后都可以」");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "badge.set"), quiet)).verdict, "allow", "no risk comes before the mode");
  assert.equal((await verdict(g, req("agent:main", BODY, "workspace.bash"), bash)).offer_always, false);
});

test("agent step 8: a rule lets the same agent, word and contract through; not a command; not after the contract changes", async () => {
  const g = make();
  const r = req("agent:main", DEVICE, "message.send", { recipient_id: "ABC" });
  assert.equal((await verdict(g, r, send)).verdict, "ask");
  g.gate.answered(r, "always");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", { recipient_id: "abc" }), send)).by, "rule");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", { recipient_id: "other" }), send)).by, "ask", "the rule covers that recipient only");
  assert.equal((await verdict(g, req("agent:other", DEVICE, "message.send", { recipient_id: "abc" }), send, agent("other"))).by, "ask");
  const changed = { ...send, risk: "structure" as const };
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", { recipient_id: "abc" }), changed)).by, "ask", "a changed contract voids the rule");
  g.clock.now += 31 * 86_400_000;
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", { recipient_id: "abc" }), send)).by, "ask", "a rule runs out");
});

test("agent step 8: a rule never covers a command", async () => {
  const g = make();
  g.store.addRule({ subject: "agent:main", to: BODY, word: "workspace.bash", object_pattern: "*", risk: "structure", contract_fingerprint: (await import("../../../src/kernel/gate")).contractFingerprint(bash), expires_at: 2_000_000 });
  assert.notEqual((await verdict(g, req("agent:main", BODY, "workspace.bash", { command: "ls" }), bash)).by, "rule");
});

test("agent step 9: 「这次可以」 carries over for five minutes, for the same request only", async () => {
  const g = make();
  const body = { text: "hi", recipient: "x" };
  const first = req("agent:main", DEVICE, "message.send", body);
  assert.equal((await verdict(g, first, send)).verdict, "ask");
  g.gate.answered(first, "once");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", body), send)).by, "carry");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", { ...body, text: "other" }), send)).by, "ask");
  g.clock.now += 5 * 60_000 + 1;
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", body), send)).by, "ask", "five minutes");
});

test("agent step 10: the review model lets it through and the allowance is carried; a command is reviewed every time and nothing is kept", async () => {
  const reviews = { n: 0 };
  const g = make({ reviews, review: async () => { reviews.n++; return { verdict: "allow" }; } });
  const r1 = req("agent:main", DEVICE, "message.send", { text: "a" });
  assert.equal((await verdict(g, r1, send)).by, "review");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", { text: "a" }), send)).by, "carry");
  assert.equal(reviews.n, 1);

  const c1 = await verdict(g, req("agent:main", BODY, "workspace.bash", { command: "ls" }), bash);
  const c2 = await verdict(g, req("agent:main", BODY, "workspace.bash", { command: "ls" }), bash);
  assert.deepEqual([c1.by, c2.by, reviews.n], ["review", "review", 3], "the command went to the review model both times");
  assert.equal(g.gate.carry.has("anything"), false);
});

test("agent step 11: a command the review model will not pass asks the owner, without 「以后都可以」; once is not remembered", async () => {
  const g = make();
  const c = req("agent:main", BODY, "workspace.bash", { command: "rm x" });
  const d = await verdict(g, c, bash);
  assert.deepEqual([d.verdict, d.by, d.offer_always], ["ask", "ask", false]);
  g.gate.answered(c, "once");
  assert.equal((await verdict(g, req("agent:main", BODY, "workspace.bash", { command: "rm x" }), bash)).verdict, "ask", "no carry for a command");
  g.gate.answered(c, "always");
  assert.equal((await verdict(g, req("agent:main", BODY, "workspace.bash", { command: "rm x" }), bash)).verdict, "ask", "and no rule");
  assert.equal(g.store.listRules().rules.length, 0);
});

test("agent step 10: the review model's deny is a deny with its reason; its ask carries the reason for the card", async () => {
  const denied = make({ review: async () => ({ verdict: "deny", reason: "命令太长，请先写成文件再执行" }) });
  const d = await verdict(denied, req("agent:main", BODY, "workspace.bash", { command: "x" }), bash);
  assert.deepEqual([d.verdict, d.by, d.reason, d.offer_always], ["deny", "review", "命令太长，请先写成文件再执行", false]);
  const asking = make({ review: async () => ({ verdict: "ask", reason: "会删除 build 目录，可恢复" }) });
  const a = await verdict(asking, req("agent:main", BODY, "workspace.bash", { command: "rm -r build" }), bash);
  assert.deepEqual([a.verdict, a.review_reason], ["ask", "会删除 build 目录，可恢复"]);
  const none = await verdict(make(), req("agent:main", BODY, "workspace.bash", { command: "x" }), bash);
  assert.equal(none.review_reason, undefined);
});

test("agent step 11: a review model that is slow, or fails, is an ask", async () => {
  const slow = make({ review: () => new Promise(() => {}) });
  assert.equal((await verdict(slow, req("agent:main", DEVICE, "message.send"), send)).verdict, "ask");
  const broken = make({ review: async () => { throw new Error("down"); } });
  assert.equal((await verdict(broken, req("agent:main", DEVICE, "message.send"), send)).verdict, "ask");
});

test("answered: deny is written to the audit and teaches the gate nothing", async () => {
  const g = make();
  const r = req("agent:main", DEVICE, "message.send", { text: "z" });
  await verdict(g, r, send);
  g.gate.answered(r, "deny");
  assert.equal(g.store.evidence(r.id)?.decision, "deny");
  assert.equal((await verdict(g, req("agent:main", DEVICE, "message.send", { text: "z" }), send)).verdict, "ask");
  assert.equal(g.store.listRules().rules.length, 0);
});
