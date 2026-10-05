import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import { AgentMcpServer } from "../../src/agent-mcp/server";
import { OwnerMember } from "../../src/members/owner";
import { GateMember } from "../../src/members/gate";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { ReflexMember } from "../../src/members/reflex";
import { TaskStatusBridge, type TaskStatusFrame } from "../../src/task-status";

const owner: TrustedRouteContext = { member: "person:owner", transport: "web_ui", transportPrincipal: "owner", screenId: "screen:test", screenLabel: "Test", local: true, remote: false, ownerProxy: true };
async function fixture(file = join(mkdtempSync(join(tmpdir(), "ash-human-")), "ledger.db")) {
  const ledger = await Ledger.open(file), router = new WorldRouter(ledger, async () => true), members = new WorldMembers(router);
  router.enableDurableGate(); router.setApprovalMode(() => "always");
  members.register(new OwnerMember("Owner", ledger));
  members.register(new GateMember(ledger, router, members));
  const notices: Message[] = [], executions: Message[] = [];
  let holdExecution = false;
  for (const id of ["agent:main", "agent:helper", "agent:other"]) {
    const { member: _member, ...spec } = wordContract("agent:main", "say")!;
    router.register({ member: id, spec, idempotentRecovery: true, handle: (m) => { notices.push(m); return { ok: true, result: { accepted: true } }; } });
  }
  members.registerDevice({ id: "device:phone", kind: "device", name: "Phone", online: true,
    capabilities: () => [{ name: "clipboard.set", description: "Set clipboard", label: "写剪贴板", risk: "outward", effect: "act",
      input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }],
    handle: (m) => { executions.push(m); return holdExecution ? new Promise(() => {}) : { ok: true, result: { written: m.body.text } }; } });
  const server = new AgentMcpServer({ router, members, ledger, fastPathMs: 500, status: () => ({}) });
  const controller = new AbortController();
  const binding = server.bind("agent:main", "main", () => null); binding.begin("t_original", controller.signal);
  const helper = server.bind("agent:helper", "helper", () => null); helper.begin("t_helper", controller.signal);
  const other = server.bind("agent:other", "other", () => null); other.begin("t_other", controller.signal);
  const call = (name: string, args: Record<string, unknown> = {}, who = binding) => server.call(who, name, args, controller.signal) as Promise<any>;
  const request = (extra: Record<string, unknown> = {}, who = binding) => call("capability_call", { member: "device:phone", word: "clipboard.set", body: { text: "frozen\n全文" }, purpose: "保存主人指定的文本", ...extra }, who);
  const answer = async (id: string, choice = "once", text?: string, client_id?: string) => {
    const item = ledger.humanPending(id)!;
    const result = await router.send(owner, { to: "service:gate", kind: "response", word: "ask", reply_to: item.ask_id,
      body: { ok: true, result: { choice, ...(text ? { text } : {}) } }, ...(client_id ? { client_id } : {}) });
    await router.refreshHumanPending();
    return result;
  };
  return { file, ledger, router, members, server, binding, helper, other, controller, call, request, answer, notices, executions,
    holdExecution: () => { holdExecution = true; },
    close: async () => { router.dispose(); await server.close(); ledger.close(); } };
}

test("capsule restores durable approvals, sends exact phone responses, and explicitly ends unused approvals", async () => {
  const w = await fixture();
  const frames: TaskStatusFrame[] = [];
  let bridge: TaskStatusBridge | undefined;
  let active: string | null = null;
  const reflex = new ReflexMember(w.router, () => active);
  w.members.register(reflex);
  try {
    w.ledger.append({ from: "agent:main", to: null, kind: "event", word: "turn.start", turn: "t_original", body: { turn: "t_original", ids: [] } });
    const first = await w.request();
    bridge = new TaskStatusBridge(w.router, async (frame) => { frames.push(frame); });
    await bridge.settled();
    assert.equal(frames.at(-1)!.state, "waiting_you");
    assert.match(frames.at(-1)!.cards![0]!.original, /frozen/);
    const card = frames.at(-1)!.cards![0]!;
    const phone = { ...owner, member: "device:phone", transport: "phone" as const };
    const response = { to: card.to, kind: "response" as const, word: "ask", reply_to: card.id,
      body: { ok: true, result: { choice: "once" } }, client_id: `capsule-answer:${card.id}` };
    await w.router.send(phone, response); await w.router.send(phone, response);
    await w.router.refreshHumanPending(); await bridge.settled();
    assert.equal(frames.at(-1)!.cards![0]!.state, "answered"); assert.equal(w.executions.length, 0);
    const second = await w.request();
    const notYetDisplayed = await w.request();
    const helper = await w.request({}, w.helper);
    const legacy = w.router.requestInternalApproval({ member: "agent:main", sessionId: "session-00000000-0000-0000-0000-000000000001",
      turn: "t_original", callId: "capsule_legacy", toolName: "legacy_tool", contractFingerprint: "a".repeat(64),
      signal: w.controller.signal, stillValid: () => true });
    const legacyAsk = w.ledger.trackedRequests().find((p) => p.message.word === "ask" &&
      (p.message.body.source as { word?: string })?.word === "internal.approval")!.message.id;
    assert.equal(w.ledger.humanPending(legacyAsk), null);
    const end = { to: "service:reflex", kind: "request" as const, word: "task.end",
      body: { turn: "t_original", pending_ids: [first.pending_id, second.pending_id, legacyAsk] }, wait: true };
    await assert.rejects(w.router.send({ ...owner, remote: true, local: false }, end), /local owner/);
    active = "t_newer";
    assert.deepEqual((await w.router.send(phone, end)).reply?.body, { ok: true, result: { ended: false } });
    assert.equal(w.ledger.humanPending(second.pending_id)?.state, "waiting");
    active = null;
    assert.deepEqual((await w.router.send(phone, end)).reply?.body, { ok: true, result: { ended: true } });
    assert.equal(await legacy, "cancelled");
    assert.equal(w.ledger.humanPending(first.pending_id)?.state, "skipped");
    assert.equal(w.ledger.humanPending(second.pending_id)?.state, "withdrawn");
    assert.equal(w.ledger.humanPending(notYetDisplayed.pending_id)?.state, "withdrawn");
    assert.equal(w.ledger.humanPending(helper.pending_id)?.state, "waiting");
    assert.equal(w.executions.length, 0);
    assert.equal((await w.call("human_pending_redeem", { pending_id: first.pending_id })).ok, false);
  } finally { await bridge?.close(); await reflex.close(); await w.close(); }
});

test("approval is immediate; ending a turn or answering never executes; redemption is exact and one-shot", async () => {
  const w = await fixture();
  try {
    const start = Date.now(), receipt = await w.request({ approval_ttl_minutes: 3 });
    assert.equal(receipt.status, "waiting_owner"); assert.ok(Date.now() - start < 10000, "does not wait for the old 15-second fast path or an owner answer");
    const lifetime = receipt.expires_at - w.ledger.byId(receipt.pending_id)!.ts;
    assert.ok(lifetime >= 179000 && lifetime <= 180000);
    assert.equal(w.executions.length, 0);
    assert.deepEqual((await w.call("list_pending")).result.pending, []);
    w.router.cancelTurn("agent:main", "t_original");
    w.binding.end("t_original");
    await w.answer(receipt.pending_id, "once", undefined, "click-once");
    await w.answer(receipt.pending_id, "once", undefined, "click-once");
    assert.equal(w.executions.length, 0);
    assert.equal(w.ledger.humanPending(receipt.pending_id)?.state, "answered");
    assert.equal(w.notices.length, 1);
    assert.match(String(w.notices[0]!.body.text), /保存主人指定的文本/);
    assert.match(String(w.notices[0]!.body.text), /frozen/);
    w.binding.begin("t_resume", w.controller.signal);
    const results = await Promise.all([w.call("human_pending_redeem", { pending_id: receipt.pending_id }), w.call("human_pending_redeem", { pending_id: receipt.pending_id })]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.error.code === "denied").length, 1);
    assert.equal(w.executions.length, 1);
    assert.deepEqual(w.executions[0]!.body, { text: "frozen\n全文" });
    assert.equal(w.executions[0]!.turn, "t_resume");
    assert.equal(w.ledger.humanPending(receipt.pending_id)?.state, "redeemed");
    assert.ok(w.ledger.humanPending(receipt.pending_id)?.redeemed_at);
    assert.equal((await w.call("human_pending_redeem", { pending_id: receipt.pending_id })).error.code, "denied");
    assert.equal(w.executions.length, 1);
  } finally { await w.close(); }
});

test("auto-approved actions retain the capability execution timeout, not the owner-wait TTL", async () => {
  const w = await fixture();
  try {
    w.router.setApprovalMode(() => "auto");
    w.router.setReviewer(async () => ({ decision: "allow", reason: "Explicit test action" }));
    w.router.register({ member: "device:phone", spec: { word: "short.write", kind: "request", description: "Short write", effect: "write", risk: "outward", timeout_ms: 50,
      input_schema: { type: "object" } }, handle: () => new Promise(() => {}) });
    const result = await w.call("capability_call", { member: "device:phone", word: "short.write", body: {}, approval_ttl_minutes: 60 });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /timeout|timed.out/);
    assert.equal(w.ledger.activeHumanPending().length, 0);
  } finally { await w.close(); }
});

test("crash after owner reply commits but before notice creation recovers the answer exactly once", async () => {
  let w = await fixture(); const file = w.file;
  const receipt = await w.request();
  const item = w.ledger.humanPending(receipt.pending_id)!;
  assert.ok(w.ledger.settleGateAsk(item.ask_id, "once", "answer"));
  assert.equal(w.ledger.humanPending(item.pending_id)?.state, "waiting");
  await w.close(); w = await fixture(file);
  try {
    await w.router.recover();
    assert.equal(w.ledger.humanPending(item.pending_id)?.state, "answered");
    assert.equal(w.notices.length, 1); assert.equal(w.executions.length, 0);
    await w.router.refreshHumanPending(); assert.equal(w.notices.length, 1);
  } finally { await w.close(); }
});

test("a claimed execution is never replayed after restart, and same-name replacement cannot redeem an old approval", async () => {
  let w = await fixture(); const file = w.file;
  const receipt = await w.request(); await w.answer(receipt.pending_id);
  w.holdExecution();
  assert.equal((await w.call("human_pending_redeem", { pending_id: receipt.pending_id })).status, "accepted");
  assert.equal(w.executions.length, 1);
  await w.close(); w = await fixture(file);
  try {
    await w.router.recover();
    const outcome = await w.call("human_pending_redeem", { pending_id: receipt.pending_id });
    assert.equal(outcome.ok, false); assert.equal(w.executions.length, 0);
    assert.match(JSON.stringify(outcome), /unknown|not replayed/);
    const old = await w.request({}, w.helper); await w.answer(old.pending_id);
    w.server.retire(w.helper);
    const replacement = w.server.bind("agent:helper", "replacement", () => null); replacement.begin("t_replacement", w.controller.signal);
    assert.equal((await w.call("human_pending_redeem", { pending_id: old.pending_id }, replacement)).error.code, "forbidden");
    assert.equal((await w.call("human_pending", {}, replacement)).result.items.length, 0);
  } finally { await w.close(); }
});

test("redemption cannot change parameters and a running redemption belongs to its new turn for cancellation", async () => {
  const w = await fixture();
  try {
    const receipt = await w.request(); await w.answer(receipt.pending_id);
    assert.equal((await w.call("human_pending_redeem", { pending_id: receipt.pending_id, body: { text: "changed" } })).error.code, "payload_invalid");
    w.binding.end("t_original"); w.binding.begin("t_new", w.controller.signal); w.holdExecution();
    assert.equal((await w.call("human_pending_redeem", { pending_id: receipt.pending_id })).status, "accepted");
    w.router.cancelTurn("agent:main", "t_new");
    const result = await w.call("await_result", { request_id: receipt.pending_id, timeout_ms: 0 });
    assert.equal(result.ok, false); assert.equal(w.executions.length, 1);
  } finally { await w.close(); }
});

test("question answers reach the originating helper with full context; other helpers cannot inspect or act", async () => {
  const w = await fixture();
  try {
    const receipt = await w.call("human_ask", { question: "用哪个地址？", purpose: "查询配送时间", options: [{ id: "home", text: "家里" }], allow_custom: true, approval_ttl_minutes: 60 }, w.helper);
    assert.equal(receipt.status, "waiting_owner");
    assert.equal((await w.call("human_pending", {}, w.other)).result.items.length, 0);
    assert.equal((await w.call("human_pending_get", { pending_id: receipt.pending_id }, w.other)).error.code, "forbidden");
    assert.equal((await w.call("human_withdraw", { pending_id: receipt.pending_id, reason: "no" })).error.code, "forbidden");
    assert.equal((await w.call("human_pending")).result.items.length, 1);
    await w.answer(receipt.pending_id, "custom", "公司");
    assert.equal(w.notices[0]?.to, "agent:helper");
    assert.match(String(w.notices[0]?.body.text), /公司/);
    const item = (await w.call("human_pending_get", { pending_id: receipt.pending_id }, w.helper)).result;
    assert.equal(item.title, "用哪个地址？"); assert.equal(item.purpose, "查询配送时间"); assert.equal(item.answer.result.text, "公司");
    assert.equal((await w.call("human_withdraw", { pending_id: receipt.pending_id, reason: "late" }, w.helper)).result.state, "answered");
    assert.equal((await w.call("human_pending_redeem", { pending_id: receipt.pending_id }, w.helper)).error.code, "forbidden");
  } finally { await w.close(); }
});

test("skip, withdraw, rejection and expiry cannot execute and TTL is bounded", async () => {
  const w = await fixture();
  const now = Date.now;
  try {
    for (const ttl of [0, -1, 10081, 1.5]) assert.equal((await w.request({ approval_ttl_minutes: ttl })).error.code, "payload_invalid");
    const a = await w.request(); await w.answer(a.pending_id);
    assert.equal((await w.call("human_pending_skip", { pending_id: a.pending_id, reason: "主人已改为只查看" })).result.state, "skipped");
    const b = await w.request();
    assert.equal((await w.call("human_withdraw", { pending_id: b.pending_id, reason: "任务取消" })).result.state, "withdrawn");
    const c = await w.request(); await w.answer(c.pending_id, "deny");
    const d = await w.request({ approval_ttl_minutes: 1 }); await w.answer(d.pending_id);
    const question = await w.call("human_ask", { question: "过期的问题", options: [{ id: "yes", text: "是" }], approval_ttl_minutes: 1 });
    Date.now = () => now() + 61000;
    await w.router.refreshHumanPending();
    assert.equal(w.ledger.humanPending(d.pending_id)?.state, "expired");
    assert.ok(w.ledger.humanPending(d.pending_id)?.answer, "an actual earlier approval remains recorded");
    assert.equal(w.ledger.humanPending(question.pending_id)?.state, "expired");
    assert.equal(w.ledger.humanPending(question.pending_id)?.answer, undefined, "expiry is not a fabricated owner answer");
    for (const receipt of [a, b, c, d]) assert.equal((await w.call("human_pending_redeem", { pending_id: receipt.pending_id })).ok, false);
    assert.equal(w.executions.length, 0);
  } finally { Date.now = now; await w.close(); }
});

test("pending and approved requests survive restart; recovery does not auto-execute or redeliver accepted answers", async () => {
  let w = await fixture(); const file = w.file;
  const a = await w.request(); await w.answer(a.pending_id);
  const b = await w.request();
  await w.close();
  w = await fixture(file);
  try {
    await w.router.recover();
    assert.equal(w.executions.length, 0); assert.equal(w.notices.length, 0);
    assert.equal(w.ledger.humanPending(a.pending_id)?.state, "answered");
    assert.equal(w.ledger.humanPending(b.pending_id)?.state, "waiting");
    assert.equal((await w.call("human_pending_redeem", { pending_id: a.pending_id })).ok, true);
    assert.equal(w.executions.length, 1);
    await w.answer(b.pending_id); assert.equal(w.notices.length, 1);
    await w.router.refreshHumanPending(); assert.equal(w.notices.length, 1);
  } finally { await w.close(); }
});

test("a changed capability contract is rejected at redemption; helper approval audit is filtered at the member", async () => {
  const w = await fixture();
  try {
    const a = await w.request({}, w.helper); await w.answer(a.pending_id);
    const b = await w.request(); await w.answer(b.pending_id, "deny");
    const log = await w.call("approval_log", { requester: "agent:main" }, w.helper);
    assert.ok(log.result.entries.length > 0); assert.ok(log.result.entries.every((entry: any) => entry.requester === "agent:helper"));
    w.router.replaceDeviceBatch("device:phone", [{ name: "clipboard.set", description: "Changed semantics", label: "Changed", risk: "outward", input_schema: { type: "object" } }], () => { throw Error("must not execute"); });
    assert.equal((await w.call("human_pending_redeem", { pending_id: a.pending_id }, w.helper)).ok, false);
    assert.equal(w.executions.length, 0);
    assert.equal(w.ledger.humanPending(a.pending_id)?.state, "skipped");
  } finally { await w.close(); }
});
