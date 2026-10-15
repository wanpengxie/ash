/** Product acceptance: real hub/router/gate/ledger + human WebSocket + agent MCP + device WebSocket + Codex IPC.
 * Only Codex's owner window and the LLM are scripted; no phone or real Codex account is touched. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexApp, CODEX_CAPABILITIES } from "../../../device/src/codex-app";
import { Desktop, snapshot, turn, until } from "../../../device/test/fake-codex-desktop";
import { accepted, byOwnerText, dataOf, deferred, startScenario, textResult, type ToolResult } from "./harness";
import { eventually } from "../fixtures/wait";

test("Codex app: concurrent owner/agent sends, exact client identities, and an unknown response retried once", async (t) => {
  const s = await startScenario(t);
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-codex-product-"));
  const desktop = new Desktop(join(dir, "ipc.sock"));
  await desktop.listen(); await desktop.owner();
  desktop.state.set("t1", { revision: 1, raw: snapshot({ turns: [turn("running", "inProgress", [])], threadRuntimeStatus: { type: "active" } }) });
  const app = new CodexApp({ socketPath: desktop.path, ownerWaitMs: 1000, reconnectMs: 30, listThreads: async () => [{ id: "t1", title: "修复结算页重复扣款", cwd: "/work/shop" }] });
  app.start();
  t.after(async () => { await app.close(); await desktop.stop(); await rm(dir, { recursive: true, force: true }); });
  await until(() => app.online, "Codex IPC connected");
  const computer = await s.hand({ kind: "computer", capabilities: CODEX_CAPABILITIES });
  const release = deferred(); const lostWasDelivered = deferred();
  computer.on("x.codex.send", async (call) => {
    const args = call.args as { thread: string; text: string; client_id: string };
    const result = await app.send(args.thread, args.text, args.client_id);
    if (args.client_id === "owner-unknown" && !result.repeated) { lostWasDelivered.resolve(); await release.promise; }
    return textResult("sent", result);
  });
  computer.on("x.codex.sessions", async () => textResult("sessions", await app.sessions()));
  computer.on("x.codex.approve", async (call) => {
    const args = call.args as { thread: string; request_id: string; decision: "approve" };
    return textResult("approved", await app.approve(args.thread, args.request_id, args.decision));
  });
  computer.on("x.codex.session", async () => textResult("session", await app.session("t1")));
  const owner = await s.human({ label: "Codex application" });
  let agentReply: ToolResult | undefined;
  const agentDone = deferred();
  s.driver.script(byOwnerText({ "并发发送": async (ctx) => {
    agentReply = await ctx.call(computer.member, "x.codex.send", { thread: "t1", text: "先跑退款回归，再提交", client_id: "agent-one" });
    agentDone.resolve();
  } }));
  accepted(await owner.say("并发发送"));
  const ownReply = await owner.call(computer.member, "x.codex.send", { thread: "t1", text: "先跑退款回归，再提交", client_id: "owner-one" });
  await agentDone.promise;
  assert.equal(ownReply.ok, true); assert.equal(agentReply?.isError, false);
  await eventually(() => computer.calls.filter((c) => c.capability === "x.codex.send").length === 2, "two calls");
  assert.deepEqual(computer.calls.filter((c) => c.capability === "x.codex.send").map((c) => c.caller.member).sort(), ["agent:main", "person:owner"]);
  const traffic = (await owner.ledger()).filter((m) => m.word === "x.codex.send");
  assert.deepEqual(traffic.filter((m) => m.kind === "request").map((m) => m.from).sort(), ["agent:main", "person:owner"]);
  // The window emits two messages with equal text; a turn id or text match cannot identify the owner's pending item.
  desktop.change("t1", snapshot({ turns: [turn("running", "inProgress", [
    { type: "steeringUserMessage", id: "ui-agent", clientUserMessageId: "agent-one", text: "先跑退款回归，再提交" },
    { type: "steeringUserMessage", id: "ui-owner", clientUserMessageId: "owner-one", text: "先跑退款回归，再提交" },
  ])], threadRuntimeStatus: { type: "active" } }));
  const transcript = await eventually(async () => {
    const reply = await owner.call(computer.member, "x.codex.session", { thread: "t1" });
    const data = dataOf(reply);
    return data?.turns?.[0]?.items?.length === 2 ? data : null;
  }, "both messages in the actual session response");
  assert.deepEqual(transcript.turns[0].items.map((i: any) => i.client_id), ["agent-one", "owner-one"]);

  // Continue the concrete work: the desktop asks to run the refund regression; the owner answers via the same capability.
  const review = { id: "refund-regression", method: "item/commandExecution/requestApproval", params: { command: "npm test -- refunds", reason: "验证重复退款请求只执行一次" } };
  desktop.change("t1", snapshot({ name: "修复结算页重复扣款", turns: [turn("running", "inProgress", [
    { type: "userMessage", clientUserMessageId: "owner-one", text: "先跑退款回归，再提交" },
  ])], requests: [review], threadRuntimeStatus: { type: "active" } }));
  await eventually(async () => dataOf(await owner.call(computer.member, "x.codex.session", { thread: "t1" }))?.approvals?.length === 1, "refund approval visible");
  const approval = await owner.call(computer.member, "x.codex.approve", { thread: "t1", request_id: "refund-regression", decision: "approve" });
  assert.equal(approval.ok, true);
  assert.ok(desktop.owned.some((f) => f.method === "thread-follower-command-approval-decision" && f.params.requestId === "refund-regression"));
  desktop.change("t1", snapshot({ name: "修复结算页重复扣款", turns: [turn("running", "completed", [
    { type: "userMessage", clientUserMessageId: "owner-one", text: "先跑退款回归，再提交" },
    { type: "agentMessage", text: "退款幂等回归通过，重复扣款已修复。" },
  ])] }));
  const completed = await eventually(async () => {
    const value = dataOf(await owner.call(computer.member, "x.codex.session", { thread: "t1" }));
    return value?.turns?.[0]?.status === "completed" ? value : null;
  }, "completed refund work");
  assert.equal(completed.turns[0].items.at(-1).text, "退款幂等回归通过，重复扣款已修复。");

  // A second authenticated device has its own Codex process and IPC state. Returning reads the original work unchanged.
  const desktop2 = new Desktop(join(dir, "second.sock")); await desktop2.listen(); await desktop2.owner();
  desktop2.state.set("t2", { revision: 1, raw: snapshot({ id: "t2", name: "整理跑步计划", turns: [turn("plan", "completed", [{ type: "agentMessage", text: "明天三公里轻松跑。" }])] }) });
  const app2 = new CodexApp({ socketPath: desktop2.path, ownerWaitMs: 1000 }); app2.start();
  t.after(async () => { await app2.close(); await desktop2.stop(); });
  await until(() => app2.online, "second Codex IPC");
  const computer2 = await s.hand({ kind: "computer", capabilities: CODEX_CAPABILITIES });
  computer2.on("x.codex.session", async () => textResult("other session", await app2.session("t2")));
  const other = dataOf(await owner.call(computer2.member, "x.codex.session", { thread: "t2" }));
  assert.equal(other.title, "整理跑步计划");
  const back = dataOf(await owner.call(computer.member, "x.codex.session", { thread: "t1" }));
  assert.equal(back.title, "修复结算页重复扣款"); assert.equal(back.turns[0].items.at(-1).text, "退款幂等回归通过，重复扣款已修复。");

  // The desktop receives the action, then the owner connection disappears before the hub can return its response.
  const unknown = owner.send({ to: computer.member, kind: "request", word: "x.codex.send", wait: true,
    body: { thread: "t1", text: "只送一次", client_id: "owner-unknown" } });
  unknown.catch(() => {});
  await lostWasDelivered.promise;
  owner.client.stop(); release.resolve();
  await assert.rejects(unknown);
  const restored = await s.human({ label: "Codex application restored", identity: owner.identity });
  const retry = await restored.call(computer.member, "x.codex.send", { thread: "t1", text: "只送一次", client_id: "owner-unknown" });
  assert.equal(dataOf(retry).repeated, true);
  assert.equal(desktop.owned.filter((f) => (f.params.clientUserMessageId ?? f.params.turnStart?.request?.clientUserMessageId) === "owner-unknown").length, 1);
  const capture = { device: computer.member, thread: "t1", own: ownReply, agent: agentReply, transcript,
    requests: traffic.filter((m) => m.kind === "request"), retry };
  if (process.env.ASH_CODEX_ACCEPTANCE_CAPTURE) await writeFile(process.env.ASH_CODEX_ACCEPTANCE_CAPTURE, JSON.stringify(capture, null, 2));
});
