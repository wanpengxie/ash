import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { createHistoryService } from "../../../../src/services/history";
import { fixture, waitFor } from "../../agents/helpers";
import { Channel, startHumanHub } from "./helpers";

const dataOf = (frame: { ok: boolean; response?: unknown }): any => {
  assert.ok(frame.ok);
  const response = frame.response as { ok?: boolean; result?: { data?: unknown } } | undefined;
  assert.ok(response?.ok); return response?.result?.data;
};

/** Actual agents service + manager + inbox + ledger and two real human-channel clients. Only the model driver is scripted. */
test("owner names a helper once, gets a receipt first, and both endpoints see the answer under that delegation", async (t) => {
  const hub = await startHumanHub();
  const f = fixture({ from: { ledger: hub.ledger, clock: { t: hub.clock.now } } });
  t.after(async () => { await f.agents.stopAll(); await hub.stop(); });
  const originalSend = f.router.send.bind(f.router);
  f.router.send = (msg, caller) => msg.to === null || msg.to === "person:owner" ? hub.mini.send(msg, caller) : originalSend(msg, caller);
  await f.start();
  hub.mini.members.set("service:agents", f.agents.service);
  hub.mini.members.set("service:history", createHistoryService({ ledger: hub.ledger }));
  const phone = await Channel.open(hub); phone.follow();
  const web = await Channel.open(hub, { kind: "browser" }); web.follow();
  const declared = await phone.send({ to: "service:agents", kind: "request", word: "declare", wait: true,
    body: { id: "agent:research", name: "资料帮手", summary: "整理资料", brief: "只回答委托人", runtime: { kind: "dsh", model: "model-one" }, tools: ["read"] } });
  assert.ok(declared.ok && declared.response?.ok);
  for (let i = 1; i <= 8; i++) await f.service("declare", { id: `agent:helper${i}`, name: `帮手${i}`, summary: "整理专项资料", brief: "整理后回复委托人" });
  const question = { to: "service:agents", kind: "request" as const, word: "ask", body: { agent: "agent:research", text: "整理这次应用验收结果，先检查团队入口复用" }, wait: false, client_id: "team-durable-one" };
  const first = await phone.send(question);
  assert.ok(first.ok); assert.ok(first.message?.id); assert.equal(first.response, undefined);
  await waitFor(() => f.driver().running.has("agent:research/back"));
  const delivered = () => f.driver().of("send").filter((c) => c[1] === "agent:research");
  const retry = await phone.send(question);
  assert.ok(retry.ok); assert.equal(retry.message?.id, first.message?.id); assert.equal(retry.duplicate, true);
  assert.equal(delivered().length, 1);
  assert.equal((delivered()[0]![3] as any)[0].from, "person:owner");
  assert.equal((delivered()[0]![3] as any)[0].id, first.message?.id);
  // Normal reads and the other endpoint keep working while the actual agent's answer is outstanding.
  const read = await web.send({ to: "service:agents", kind: "request", word: "describe", body: { agent: "agent:research" }, wait: true });
  assert.ok(read.ok && read.response?.ok);
  assert.equal(dataOf(read).state, "working");
  const timeline = async (channel: Channel) => {
    const r = await channel.send({ to: "service:history", kind: "request", word: "exchanges", body: { agent: "agent:research" }, wait: true });
    assert.ok(r.ok && r.response?.ok); return dataOf(r).items;
  };
  assert.equal((await timeline(web))[0].state, "waiting");
  const snapshot = async () => ({
    members: dataOf(await web.send({ to: "service:agents", kind: "request", word: "list", body: {}, wait: true })),
    exchanges: { items: await timeline(web) },
  });
  const during = await snapshot();
  const responseText = "发现复用入口会留在上一个成员，已记录。接下来检查切换成员时的草稿与晚回执。";
  f.driver().say("agent:research", "back", responseText); f.driver().finish("agent:research", "back");
  for (const channel of [phone, web]) {
    await channel.seen((m) => m.reply_to === first.message?.id && m.kind === "response", "later answer via sync");
    const item = (await timeline(channel))[0];
    assert.equal(item.id, first.message?.id); assert.equal(item.to, "agent:research");
    assert.equal(item.state, "answered"); assert.equal(item.answer.text, responseText);
  }
  assert.equal(delivered().length, 1);
  const answered = await snapshot();
  const follow = await phone.send({ ...question, body: { agent: "agent:research", text: "这个问题会丢掉我刚输入的内容吗？" }, client_id: "team-follow-up-two" });
  assert.ok(follow.ok);
  await waitFor(() => f.driver().running.has("agent:research/back"));
  assert.equal(delivered().length, 2);
  f.driver().say("agent:research", "back", "会有串稿风险。正在补 A、B 两位帮手之间的切换及晚回执保护。"); f.driver().finish("agent:research", "back");
  await web.seen((m) => m.reply_to === follow.message?.id && m.kind === "response", "follow-up answer on the other endpoint");
  const continued = await snapshot();
  if (process.env.TEAM_CAPTURE === "1") writeFileSync(new URL("../../../fixtures/team-session.json", import.meta.url), JSON.stringify({ during, answered, continued }, null, 2) + "\n");
  assert.equal(hub.ledger.page({ limit: 200 }).filter((m) => m.to === "person:owner" && m.word === "say").length, 0);
  const interrupted = await phone.send({ ...question, body: { agent: "agent:research", text: "继续检查剩下的入口" }, client_id: "team-interrupted-three" });
  assert.ok(interrupted.ok); await waitFor(() => f.driver().running.has("agent:research/back"));
  // Saving configuration must change the next driver start and the name seen in the directory, preserving execution identity.
  const updated = await web.send({ to: "service:agents", kind: "request", word: "update", wait: true,
    body: { agent: "agent:research", name: "编辑帮手", summary: "编辑资料", brief: "编辑但不要读取", runtime: { model: "model-two" }, tools: ["write"] } });
  assert.ok(updated.ok && updated.response?.ok);
  const spec = f.driver().of("start").filter((c) => c[1] === "agent:research").at(-1)![2] as any;
  assert.equal(spec.runtime.model, "model-two"); assert.deepEqual(spec.tools.allowed, ["write"]);
  assert.ok(spec.modules.static.some((m: any) => m.content.includes("编辑但不要读取")));
  assert.equal(f.registry.describe("agent:research")!.info.name, "编辑帮手");
  assert.equal(dataOf(updated).id, "agent:research");
  await web.seen((m) => m.reply_to === interrupted.message?.id && m.kind === "response", "interrupted work reported to both endpoints");
  const unknown = (await timeline(web))[0];
  assert.equal(unknown.state, "failed"); assert.ok(unknown.answer.error.startsWith("结果未知："));
  // A stopped helper yields a concrete failed exchange, while the async transport receipt remains only a receipt.
  await web.send({ to: "service:agents", kind: "request", word: "stop", body: { agent: "agent:research" }, wait: true });
  const stopped = await phone.send({ ...question, client_id: "team-stopped-two" });
  assert.ok(stopped.ok); assert.equal(stopped.response, undefined);
  await phone.seen((m) => m.reply_to === stopped.message?.id && m.kind === "response", "stopped helper refusal");
  const failed = (await timeline(web))[0]; assert.equal(failed.state, "failed"); assert.ok(failed.answer.error.includes("not running"));
});
