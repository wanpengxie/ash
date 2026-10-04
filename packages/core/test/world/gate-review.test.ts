import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WordEffect } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { ReviewFacts, Reviewer, ReviewVerdict } from "../../src/review/reviewer";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const agent: TrustedRouteContext = { transport: "agent", member: "agent:main", transportPrincipal: "agent:main",
  local: true, remote: false, ownerProxy: false, turn: "t_review" };
const owner: TrustedRouteContext = { transport: "api", member: "person:owner", transportPrincipal: "owner-principal",
  local: true, remote: false, ownerProxy: true };
const screen: TrustedRouteContext = { transport: "web_ui", member: "person:owner", transportPrincipal: "owner-principal",
  local: true, remote: false, ownerProxy: true, screenId: "screen:approved", screenLabel: "Test screen" };
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

const caps: { name: string; label: string; risk: "none" | "outward" | "structure"; effect?: WordEffect }[] = [
  { name: "browser.read", label: "读网页", risk: "none" },
  { name: "browser.click", label: "在网页上点击", risk: "outward", effect: "act" },
  { name: "browser.type", label: "在网页上输入", risk: "outward", effect: "act" },
  { name: "browser.run", label: "连续操作网页", risk: "outward", effect: "act" },
  { name: "post.publish", label: "发帖", risk: "outward", effect: "send" },
  { name: "shell.run", label: "执行命令", risk: "structure", effect: "execute" },
  { name: "pay.send", label: "付款", risk: "outward", effect: "send" },
];

/** A fake reviewer: answers from a queue (or one fixed answer) and records every call. */
function fakeReviewer(answer: ReviewVerdict | Error | ((facts: ReviewFacts, signal: AbortSignal) => Promise<ReviewVerdict>)) {
  const calls: { facts: ReviewFacts; signal: AbortSignal }[] = [];
  const reviewer: Reviewer = async (facts, signal) => {
    calls.push({ facts, signal });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(facts, signal) : answer;
  };
  return { reviewer, calls };
}

async function setup(reviewer: Reviewer | null, options: { timeoutMs?: number; mode?: () => "auto" | "always" } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-review-")), "ash.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
  router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => {} });
  const effects: string[] = [];
  const executed: Record<string, unknown>[] = [];
  const schema = { type: "object", properties: { site: { type: "string" }, label: { type: "string" }, ref: { type: "integer" },
    text: { type: "string" }, command: { type: "string" }, amount: { type: "number" }, submit: { type: "boolean" },
    steps: { type: "array", items: { type: "object" } } }, additionalProperties: false };
  router.registerDeviceBatch("device:phone", caps.map((cap) => ({ ...cap, description: cap.label, input_schema: schema })),
    (message) => { effects.push(message.word); executed.push(structuredClone(message.body)); return { ok: true, result: {} }; });
  router.enableDurableGate();
  router.setReviewer(reviewer, options.timeoutMs ? { timeoutMs: options.timeoutMs } : {});
  if (options.mode) router.setApprovalMode(options.mode);
  const send = async (word: string, body: Record<string, unknown>, ctx = agent) => {
    const sent = await router.send(ctx, { to: "device:phone", kind: "request", word, body });
    await tick();
    return sent.id;
  };
  const card = (id: string) => {
    const gate = ledger.gateCase(id);
    return gate ? { gate, ask: ledger.byId(gate.askId)!, options: (ledger.byId(gate.askId)!.body.options as { id: string; label: string }[]).map((item) => item.id) } : null;
  };
  const answer = async (id: string, choice: "once" | "always" | "deny") => {
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: card(id)!.gate.askId,
      body: { ok: true, result: { choice } } });
    await tick();
  };
  const passes = () => ledger.list({ limit: 1000 }).filter((item) => item.word === "gate.passed");
  const close = () => { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); };
  return { ledger, router, effects, executed, send, card, answer, passes, close };
}

test("approval originals preserve long commands and submitted text and authorize that exact request", async () => {
  const world = await setup(null);
  try {
    const command = "echo " + "x".repeat(800) + "\nHIDDEN_COMMAND_TAIL";
    const commandBody = { command };
    const commandId = await world.send("shell.run", commandBody);
    commandBody.command = "different command after acceptance";
    const commandCard = world.card(commandId)!.ask;
    assert.ok(!String(commandCard.body.detail).includes("HIDDEN_COMMAND_TAIL"));
    assert.equal((commandCard.body.source as { body_full: string }).body_full, command);
    assert.equal(world.effects.length, 0);
    await world.answer(commandId, "once");
    assert.deepEqual(world.executed.at(-1), { command });

    const text = "x".repeat(2000) + "\nHIDDEN_SUBMITTED_TEXT\n<script>not HTML</script>\tspaces  stay";
    const body = { site: "example.com", ref: 2, label: "正文", text, submit: true };
    const id = await world.send("browser.type", body);
    const card = world.card(id)!.ask;
    assert.ok(!String(card.body.detail).includes("HIDDEN_SUBMITTED_TEXT"));
    const full = (card.body.source as { body_full: string }).body_full;
    assert.ok(full.includes(text), "the full unescaped text retains line breaks and markup");
    assert.ok(full.includes('"submit": true'));
    await world.answer(id, "once");
    assert.deepEqual(world.executed.at(-1), body);

    const steps = [{ op: "type", ...body }, { op: "type", ...body, text: "second\nfull text" }];
    const run = await world.send("browser.run", { steps });
    const scriptFull = (world.card(run)!.ask.body.source as { body_full: string }).body_full;
    assert.ok(scriptFull.includes(text));
    assert.ok(scriptFull.includes("第 2 步原文：\nsecond\nfull text"));
    await world.answer(run, "once");
    assert.deepEqual(world.executed.at(-1), { steps });
  } finally { world.close(); }
});

test("decision order: the owner and reads bypass review; a reviewer allow passes with an audited reason", async () => {
  const fake = fakeReviewer({ decision: "allow", reason: "点开网页上的登录是可撤回的操作" });
  const world = await setup(fake.reviewer);
  try {
    await world.send("post.publish", { text: "owner's own post" }, owner);
    assert.deepEqual(world.effects, ["post.publish"]);
    await world.send("browser.read", { site: "x.com" });
    assert.deepEqual(world.effects, ["post.publish", "browser.read"]);
    assert.equal(fake.calls.length, 0, "neither the owner nor a read is reviewed");
    const id = await world.send("browser.click", { site: "x.com", label: "登录", ref: 1 });
    assert.equal(fake.calls.length, 1);
    assert.equal(world.card(id), null, "no owner card");
    assert.deepEqual(world.effects.at(-1), "browser.click");
    assert.equal(world.ledger.responseTo(id)?.body.ok, true);
    const passed = world.passes().at(-1)!;
    assert.deepEqual(passed.body, { request_id: id, by: "review", reason: "点开网页上的登录是可撤回的操作" });
    assert.ok(passed.seq < world.ledger.responseTo(id)!.seq, "the pass is recorded before the effect");
    const history = world.ledger.gateHistoryPage().items[0]!;
    assert.equal(history.decision, "review");
    assert.equal(history.source === "current" ? history.reason : null, "点开网页上的登录是可撤回的操作");
  } finally { world.close(); }
});

test("a reviewer ask puts its own card text up, with the exact action still on the card", async () => {
  const fake = fakeReviewer({ decision: "ask", reason: "她自己写的帖子，你还没看过", title: "替你发帖", detail: "她想替你发一条她写的帖子：「今晚的比赛真精彩」" });
  const world = await setup(fake.reviewer);
  try {
    const id = await world.send("post.publish", { text: "今晚的比赛真精彩" });
    const shown = world.card(id)!;
    assert.equal(shown.ask.body.title, "替你发帖");
    assert.match(String(shown.ask.body.detail), /^她想替你发一条她写的帖子/);
    assert.match(String(shown.ask.body.detail), /发帖：\{"text":"今晚的比赛真精彩"\}/);
    assert.deepEqual(shown.options, ["once", "always", "deny"]);
    assert.deepEqual(world.effects, []);
    await world.answer(id, "deny");
    assert.deepEqual(world.effects, []);
    assert.equal(world.ledger.responseTo(id)?.body.ok, false);
  } finally { world.close(); }
});

test("the reviewer sees the owner's words of this turn, the action, its content and the earlier steps", async () => {
  const fake = fakeReviewer({ decision: "allow", reason: "你让她打开推特，你来登录" });
  const world = await setup(fake.reviewer);
  try {
    const said = world.ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "帮我打开推特我来登录" } }).message;
    world.ledger.append({ from: "agent:main", to: null, kind: "event", word: "turn.start", body: { turn: "t_review", ids: [said.id] }, turn: "t_review" });
    await world.send("browser.read", { site: "x.com" });
    await world.send("browser.click", { site: "www.X.com", label: "登录", ref: 4 });
    const facts = fake.calls[0]!.facts;
    assert.deepEqual(facts.owner_said, ["帮我打开推特我来登录"]);
    assert.equal(facts.requester, "agent:main");
    assert.deepEqual(facts.action, { member: "device:phone", word: "browser.click", label: "在网页上点击", effect: "act", target: "site:x.com" });
    assert.equal(facts.content, JSON.stringify({ site: "www.X.com", label: "登录", ref: 4 }));
    assert.equal(facts.context.length, 1);
    assert.match(facts.context[0]!, /^device:phone\/browser\.read /);
    // Another turn's words are not this turn's consent.
    const other = await world.send("browser.click", { site: "y.com", label: "登录", ref: 1 }, { ...agent, turn: "t_other" });
    assert.ok(other);
    assert.deepEqual(fake.calls[1]!.facts.owner_said, []);
  } finally { world.close(); }
});

for (const [name, reviewer, timeoutMs] of [
  ["throws", fakeReviewer(new Error("provider down")).reviewer, undefined],
  ["returns a malformed verdict", fakeReviewer({ decision: "yes", reason: "ok" } as unknown as ReviewVerdict).reviewer, undefined],
  ["is missing", null, undefined],
  ["is too slow", fakeReviewer((_facts, signal) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ decision: "allow", reason: "too late" }), 2_000);
    signal.addEventListener("abort", () => clearTimeout(timer));
  })).reviewer, 40],
] as const) test(`when the reviewer ${name}, the owner gets the plain card and nothing runs`, async () => {
  const world = await setup(reviewer, timeoutMs ? { timeoutMs } : {});
  try {
    const id = await world.send("browser.click", { site: "x.com", label: "下一页", ref: 2 });
    if (timeoutMs) for (let i = 0; i < 40 && !world.card(id); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const shown = world.card(id)!;
    assert.ok(shown, "the owner is asked");
    assert.equal(shown.ask.body.title, "需要你确认");
    assert.equal(shown.ask.body.detail, "在 x.com 点击「下一页」");
    assert.deepEqual(world.effects, []);
    assert.equal(world.passes().length, 0, "never a silent pass");
  } finally { world.close(); }
});

test("a reviewer allow for operating the phone carries over for five minutes per target; other effects do not", async (t) => {
  const fake = fakeReviewer({ decision: "allow", reason: "浏览操作可撤回" });
  const world = await setup(fake.reviewer);
  try {
    await world.send("browser.click", { site: "x.com", label: "下一页", ref: 1 });
    await world.send("browser.click", { site: "x.com", label: "第 3 页", ref: 7 });
    assert.equal(fake.calls.length, 1, "one review covers the next tap on the same site");
    assert.equal(world.passes().at(-1)!.body.by, "carry");
    assert.equal(world.ledger.gateHistoryPage().items[0]!.decision, "carry");
    await world.send("browser.click", { site: "y.com", label: "下一页", ref: 1 });
    assert.equal(fake.calls.length, 2, "another site is reviewed again");
    await world.send("post.publish", { text: "hello" });
    await world.send("post.publish", { text: "hello" });
    assert.equal(fake.calls.length, 4, "a reviewer allow never carries over for sending");
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 5 * 60_000 + 1);
    await world.send("browser.click", { site: "x.com", label: "下一页", ref: 1 });
    assert.equal(fake.calls.length, 5, "after five minutes it is reviewed again");
    assert.equal(world.effects.length, 6);
  } finally { world.close(); }
});

test("an owner allow carries over for five minutes for the same exact action only", async (t) => {
  const fake = fakeReviewer({ decision: "ask", reason: "她自己写的内容", title: "替你发帖", detail: "她想发帖" });
  const world = await setup(fake.reviewer);
  try {
    const first = await world.send("post.publish", { text: "same text" });
    await world.answer(first, "once");
    assert.deepEqual(world.effects, ["post.publish"]);
    const again = await world.send("post.publish", { text: "same text" });
    assert.equal(world.card(again), null);
    assert.equal(world.passes().at(-1)!.body.by, "carry");
    assert.equal(fake.calls.length, 1, "a carried action is not reviewed again");
    const changed = await world.send("post.publish", { text: "different text" });
    assert.ok(world.card(changed), "different content is a different action");
    world.router.cancel([changed]);
    const otherAgent = await world.send("post.publish", { text: "same text" }, { ...agent, member: "agent:other", transportPrincipal: "agent:other" });
    assert.ok(world.card(otherAgent), "another agent does not inherit the allow");
    world.router.cancel([otherAgent]);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 5 * 60_000 + 1);
    const later = await world.send("post.publish", { text: "same text" });
    assert.ok(world.card(later), "after five minutes it asks again");
    // A deny never carries over.
    t.mock.restoreAll();
    const denied = await world.send("post.publish", { text: "deny me" });
    await world.answer(denied, "deny");
    assert.ok(world.card(await world.send("post.publish", { text: "deny me" })));
  } finally { world.close(); }
});

test("mode always asks for every non-read agent action; reads and owner rules still apply", async () => {
  let mode: "auto" | "always" = "always";
  const fake = fakeReviewer({ decision: "allow", reason: "可撤回" });
  const world = await setup(fake.reviewer, { mode: () => mode });
  try {
    await world.send("browser.read", { site: "x.com" });
    assert.deepEqual(world.effects, ["browser.read"]);
    const click = await world.send("browser.click", { site: "x.com", label: "下一页", ref: 1 });
    assert.ok(world.card(click));
    assert.equal(fake.calls.length, 0, "the reviewer is not consulted");
    await world.answer(click, "once");
    const again = await world.send("browser.click", { site: "x.com", label: "下一页", ref: 1 });
    assert.ok(world.card(again), "no carry-over in this mode");
    await world.answer(again, "always");
    const ruled = await world.send("browser.click", { site: "x.com", label: "第 2 页", ref: 3 });
    assert.equal(world.card(ruled), null, "an owner rule still applies");
    assert.equal(world.passes().at(-1)!.body.by, "rule");
    mode = "auto";
    await world.send("browser.click", { site: "z.com", label: "下一页", ref: 1 });
    assert.equal(fake.calls.length, 1, "the mode is read on every decision");
  } finally { world.close(); }
});

test("running a command and paying never reach the reviewer, never offer always and never carry over", async () => {
  const fake = fakeReviewer({ decision: "allow", reason: "你让她做的" });
  const world = await setup(fake.reviewer);
  try {
    const command = await world.send("shell.run", { command: "ls" });
    assert.deepEqual(world.card(command)!.options, ["once", "deny"]);
    assert.equal(world.card(command)!.ask.body.detail, "执行命令：ls");
    await world.answer(command, "once");
    assert.deepEqual(world.effects, ["shell.run"]);
    const repeated = await world.send("shell.run", { command: "ls" });
    assert.deepEqual(world.card(repeated)!.options, ["once", "deny"], "every command asks");
    const pay = await world.send("pay.send", { amount: 5 });
    assert.deepEqual(world.card(pay)!.options, ["once", "deny"]);
    const payButton = await world.send("browser.click", { site: "shop.example", label: "立即支付", ref: 9 });
    assert.deepEqual(world.card(payButton)!.options, ["once", "deny"]);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(world.effects, ["shell.run"]);
  } finally { world.close(); }
});

test("cancelling during review aborts the reviewer and nothing runs", async () => {
  const seen: AbortSignal[] = [];
  const fake = fakeReviewer((_facts, signal) => { seen.push(signal); return new Promise(() => {}); });
  const world = await setup(fake.reviewer, { timeoutMs: 10_000 });
  try {
    const id = await world.send("browser.click", { site: "x.com", label: "下一页", ref: 1 });
    assert.equal(seen.length, 1);
    assert.equal(world.router.cancel([id]).length, 1);
    await tick();
    assert.equal(seen[0]!.aborted, true);
    assert.equal(world.card(id), null);
    assert.deepEqual(world.effects, []);
    assert.equal((world.ledger.responseTo(id)?.body.error as { code?: string }).code, "cancelled");
  } finally { world.close(); }
});
