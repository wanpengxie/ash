import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "../../../sdk/src/api";
import { createAgentMember, type AgentTurnInput, type AgentTurnResult, type AgentTurnRunner } from "../../src/members/agent";
import { OwnerMember } from "../../src/members/owner";
import { RESTART_ERROR, isRetryText, turnFailureCause, turnFailureNotice } from "../../src/members/agent-failure";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner-api", member: "person:owner", local: true, remote: false, ownerProxy: false };
const clock: TrustedRouteContext = { transport: "service", transportPrincipal: "service:clock", member: "service:clock", local: true, remote: false, ownerProxy: false };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BROKEN = "Internal error: turn failed: DeepSeek Messages stream: tool input is invalid JSON";

async function fixture(runner: AgentTurnRunner, dir = mkdtempSync(join(tmpdir(), "turn-failure-"))) {
  const ledger = await Ledger.open(join(dir, "ledger.db"));
  const router = new WorldRouter(ledger, async () => true);
  const member = createAgentMember({ ledger, router, stateDir: join(dir, "member"), runner });
  const members = new WorldMembers(router);
  members.register(member);
  members.register(new OwnerMember("Owner", ledger));
  member.prepareRecovery();
  const rows = () => ledger.list({ after: 0, limit: 1000 });
  const waitFor = async (predicate: (list: Message[]) => boolean) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) { const list = rows(); if (predicate(list)) return list; await sleep(10); }
    throw new Error("message sequence did not appear");
  };
  const ends = (list: Message[]) => list.filter((m) => m.word === "turn.end");
  const toOwner = (list: Message[]) => list.filter((m) => m.from === "agent:main" && m.to === "person:owner" && m.kind === "request");
  return { dir, ledger, router, member, rows, waitFor, ends, toOwner,
    async close(keep = false) { await member.close(); ledger.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}

/** A runner that plays a scripted result per turn, recording each input. */
function scripted(results: ((input: AgentTurnInput) => Promise<AgentTurnResult> | AgentTurnResult)[]) {
  const inputs: AgentTurnInput[] = [];
  const runner: AgentTurnRunner = { async runTurn(input) { inputs.push(input); return (results[inputs.length - 1] ?? (() => ({ reason: "completed" })))(input); } };
  return { runner, inputs };
}

test("failure causes and notices are plain and short", () => {
  assert.equal(turnFailureCause(BROKEN), "模型这次给出的操作指令格式坏了");
  assert.equal(turnFailureCause("model call failed (503)"), "模型服务那边暂时出错了");
  assert.equal(turnFailureCause("fetch failed: ECONNREFUSED"), "连不上模型");
  assert.equal(turnFailureCause("request timed out"), "等模型回应超时了");
  assert.equal(turnFailureCause("no model key"), "还没有填模型的 Key（设置 → 密钥）");
  assert.equal(turnFailureCause("turn cancelled"), "做到一半被停下了");
  assert.equal(turnFailureCause("agent runtime unavailable: ECONNRESET"), "我的运行环境没能启动");
  assert.deepEqual(turnFailureNotice(BROKEN, { steps: 0, replied: false }),
    { text: "刚才这件事没做成：模型这次给出的操作指令格式坏了。这次还什么都没做。", prompt: "要我再试一次吗？", option: "重试" });
  assert.equal(turnFailureNotice(BROKEN, { steps: 3, replied: true }).text, "刚才这件事没做成：模型这次给出的操作指令格式坏了。出错前已经做了 3 步，可以在活动里查看。");
  assert.equal(turnFailureNotice(BROKEN, { steps: 0, replied: false }, true).text, null);
  assert.deepEqual(turnFailureNotice(RESTART_ERROR, { steps: 2, replied: false }),
    { text: "刚才那件事做到一半被打断了（Ash 重启）。已经做了 2 步，可以在活动里查看。", prompt: "要我接着做吗？", option: "接着做" });
  assert.equal(turnFailureNotice(RESTART_ERROR, { steps: 0, replied: false }).text, "刚才那件事还没开始做就被打断了（Ash 重启）。");
  for (const text of ["重试", " 重试。", "再试一次", "接着做", "Retry"]) assert.ok(isRetryText(text), text);
  for (const text of ["重试一下那个卡片的颜色", "好的", "", undefined]) assert.ok(!isRetryText(text), String(text));
});

test("an owner turn that fails tells the owner once, with a retry card, before its end", async () => {
  const s = scripted([() => ({ reason: "error", error: BROKEN })]);
  const f = await fixture(s.runner);
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "给我做一张卡片" }, wait: true });
    const rows = await f.waitFor((list) => f.ends(list).length === 1);
    const told = f.toOwner(rows);
    assert.deepEqual(told.map((m) => m.word), ["say", "show"]);
    assert.equal(told[0].body.text, "刚才这件事没做成：模型这次给出的操作指令格式坏了。这次还什么都没做。");
    assert.equal(told[0].body.kind, "reply");
    assert.deepEqual(told[1].body.card, { type: "options", prompt: "要我再试一次吗？", options: [{ id: "retry", text: "重试" }] });
    const end = f.ends(rows)[0];
    assert.ok(told.every((m) => m.seq < end.seq && m.turn === end.body.turn), "the notice belongs to the failed turn and precedes its end");
    await sleep(50);
    assert.equal(f.toOwner(f.rows()).length, 2, "one notice per failed turn");
  } finally { await f.close(); }
});

test("a failure the runtime already explained only adds the retry card; background turns stay quiet", async () => {
  const s = scripted([() => ({ reason: "error", error: "model call failed (429)", told: true }), () => ({ reason: "error", error: BROKEN })]);
  const f = await fixture(s.runner);
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "hi" }, wait: true });
    await f.waitFor((list) => f.ends(list).length === 1);
    await f.router.send(clock, { to: "agent:main", kind: "request", word: "say", body: { text: "timer fired" }, wait: true });
    const rows = await f.waitFor((list) => f.ends(list).length === 2);
    assert.deepEqual(f.toOwner(rows).map((m) => m.word), ["show"]);
    assert.equal(f.ends(rows)[1].body.reason, "error", "the background failure is still recorded for the activity");
  } finally { await f.close(); }
});

test("tapping retry re-runs the failed request with what the failed attempt had done", async () => {
  let router!: WorldRouter;
  const s = scripted([(input) => {
    router.recordDshToolCall(input.turn, "call_1", "bash", "{\"command\":\"ls\"}");
    return { reason: "error", error: BROKEN };
  }]);
  const f = await fixture(s.runner);
  router = f.router;
  try {
    await f.member.start();
    const asked = await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "给我做一张卡片" }, wait: true });
    const rows = await f.waitFor((list) => f.ends(list).length === 1);
    const notice = f.toOwner(rows);
    assert.match(String(notice[0].body.text), /出错前已经做了 1 步/);
    const card = notice.find((m) => m.word === "show")!;
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "重试", in_reply_to: card.id, option_id: "retry" }, wait: true });
    await f.waitFor((list) => f.ends(list).length === 2);
    const retry = s.inputs[1];
    assert.deepEqual(retry.messages.map((m) => m.body.text), ["给我做一张卡片", "重试"]);
    assert.equal(retry.messages[0].id, asked.id);
    assert.match(retry.rendered, /^\[retry of a failed turn\]/);
    assert.match(retry.rendered, /service:dsh-tool\/bash \(outcome unknown\)/);
    assert.match(retry.rendered, /给我做一张卡片/);
    assert.equal(f.toOwner(f.rows()).length, 2, "a retry that succeeds adds no notice");
  } finally { await f.close(); }
});

test("a bare 「重试」 retries the last failed owner turn, following earlier retries back to the request", async () => {
  const s = scripted([() => ({ reason: "error", error: "fetch failed" }), () => ({ reason: "error", error: BROKEN })]);
  const f = await fixture(s.runner);
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "订明早的闹钟" }, wait: true });
    await f.waitFor((list) => f.ends(list).length === 1);
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "重试" }, wait: true });
    await f.waitFor((list) => f.ends(list).length === 2);
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "再试一次" }, wait: true });
    await f.waitFor((list) => f.ends(list).length === 3);
    assert.deepEqual(s.inputs[1].messages.map((m) => m.body.text), ["订明早的闹钟", "重试"]);
    assert.deepEqual(s.inputs[2].messages.map((m) => m.body.text), ["订明早的闹钟", "再试一次"]);
    assert.match(s.inputs[2].rendered, /\[retry of a failed turn\]/);
    // After a success, 「重试」 is just words for the agent.
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "重试" }, wait: true });
    await f.waitFor((list) => f.ends(list).length === 4);
    assert.deepEqual(s.inputs[3].messages.map((m) => m.body.text), ["重试"]);
    assert.doesNotMatch(s.inputs[3].rendered, /retry of a failed turn/);
  } finally { await f.close(); }
});

test("a turn cut off by a restart tells the owner once after the restart", async () => {
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const first = await fixture({ async runTurn(_input, _emit, signal) {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return { reason: "error", error: "turn cancelled" };
  } });
  const dir = first.dir;
  await first.member.start();
  await first.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "整理一下相册" }, wait: true });
  await running;
  await first.close(true); // Ash goes away with the turn still running
  const s = scripted([]);
  const again = await fixture(s.runner, dir);
  try {
    await again.member.start();
    const rows = await again.waitFor((list) => again.ends(list).length === 1);
    const told = again.toOwner(rows);
    assert.deepEqual(told.map((m) => m.word), ["say", "show"]);
    assert.equal(told[0].body.text, "刚才那件事还没开始做就被打断了（Ash 重启）。");
    assert.deepEqual(told[1].body.card, { type: "options", prompt: "要我接着做吗？", options: [{ id: "retry", text: "接着做" }] });
    assert.match(String(again.ends(rows)[0].body.error), /Interrupted by process restart/);
    await again.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "接着做", in_reply_to: told[1].id, option_id: "retry" }, wait: true });
    await again.waitFor((list) => again.ends(list).length === 2);
    assert.deepEqual(s.inputs[0].messages.map((m) => m.body.text), ["整理一下相册", "接着做"]);
  } finally { await again.close(); }
});
