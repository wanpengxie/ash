import assert from "node:assert/strict";
import test from "node:test";
import { caller, fixture, settle, waitFor } from "./helpers";

test("member state changes record their author, process state and removal", async () => {
  const f = fixture(); await f.start();
  await f.service("declare", { id: "agent:h", name: "帮手", summary: "查资料", brief: "help" });
  await f.service("update", { agent: "agent:h", summary: "新的角色" }, caller("agent:main"));
  await f.service("stop", { agent: "agent:h" });
  await f.service("start", { agent: "agent:h" });
  await f.service("remove", { agent: "agent:h" });
  await settle();
  const events = f.router.events("agent.changed").filter((e) => (e.msg.body as any).agent === "agent:h");
  for (const change of ["declared", "updated", "stopped", "started", "removed"]) {
    const e = events.find((e) => (e.msg.body as any).change === change)!;
    assert.ok(e, change); assert.equal((e.msg.body as any).by, change === "updated" ? "agent:main" : "person:owner");
    assert.equal(e.caller.member, "service:agents");
  }
  assert.equal((events.find((e) => (e.msg.body as any).change === "removed")!.msg.body as any).state, "stopped");
  await f.agents.stopAll();
});

test("doing and waiting identify real work; an owner ask stays off the front conversation", async () => {
  const f = fixture(); await f.start();
  const question = f.service("ask", { agent: "agent:main", text: "请只在团队里回答" });
  await waitFor(() => f.driver().running.has("agent:main/back"));
  const info: any = (await f.service("describe", { agent: "agent:main" }))!.data;
  assert.equal(info.doing.lane, "back"); assert.equal(info.doing.about, "请只在团队里回答"); assert.equal(info.doing.since, f.clock.t);
  f.driver().say("agent:main", "back", "团队回答"); f.driver().finish("agent:main", "back");
  assert.equal(((await question)!.data as any).answer, "团队回答");
  await settle(); assert.deepEqual(f.router.says(), []);
  await f.service("declare", { id: "agent:h", name: "h", summary: "help", brief: "help" });
  const next = f.service("ask", { agent: "agent:h", text: "等你" }, caller("agent:main"));
  await waitFor(() => f.agents.manager.waitingOn("agent:main").includes("agent:h"));
  await waitFor(() => f.driver().running.has("agent:h/back"));
  f.driver().finish("agent:h", "back"); await next;
  assert.deepEqual(f.agents.manager.waitingOn("agent:main"), []);
  await f.agents.stopAll();
});

test("answering news sends the sender a tell linked to that original question", async () => {
  const f = fixture(); await f.start();
  const result: any = (await f.service("tell", { agent: "agent:main", text: "留意这个" }, caller("agent:h")))!.data;
  await waitFor(() => f.driver().running.has("agent:main/back"));
  const turn = f.agents.currentTurn("agent:main", "back")!;
  await f.call("service:agents", "answer", { in_reply_to: result.message_id, text: "记下了" }, { ...caller("agent:main"), turn });
  assert.equal(f.router.to("agent:h", "tell").at(-1)!.msg.reply_to, result.message_id);
  f.driver().finish("agent:main", "back"); await f.agents.stopAll();
});

test("saved tool restrictions reach the running driver's next session", async () => {
  const f = fixture(); await f.start();
  await f.service("declare", { id: "agent:editor", name: "编辑", summary: "整理", brief: "help", tools: ["read"] });
  await f.service("update", { agent: "agent:editor", tools: ["write"] });
  const start = f.driver().of("start").filter((c) => c[1] === "agent:editor").at(-1)!;
  assert.deepEqual((start[2] as any).tools.allowed, ["write"]);
  await f.agents.stopAll();
});

test("renaming a member keeps its execution id and updates the capability directory name", async () => {
  const f = fixture(); await f.start();
  await f.service("declare", { id: "agent:editor", name: "旧名", summary: "整理", brief: "help" });
  await f.service("update", { agent: "agent:editor", name: "新名字" });
  assert.equal(f.registry.describe("agent:editor")!.info.name, "新名字");
  assert.equal(f.registry.describe("agent:editor")!.info.id, "agent:editor");
  await f.agents.stopAll();
});

test("changing installed tools interrupts the old turn once instead of swapping grants during execution", async () => {
  const f = fixture(); await f.start();
  await f.service("declare", { id: "agent:editor", name: "编辑", summary: "整理", brief: "read", tools: ["read"] });
  const old = f.service("ask", { agent: "agent:editor", text: "旧任务" }).then(() => "unexpected success", (e) => e.code);
  await waitFor(() => f.driver().running.has("agent:editor/back"));
  await f.service("update", { agent: "agent:editor", tools: ["write"], brief: "write only" });
  assert.equal(await old, "result_unknown");
  assert.equal(f.driver().of("send").filter((c) => c[1] === "agent:editor").flatMap((c) => c[3] as any[]).filter((m) => m.word === "ask").length, 1, "the interrupted question was not replayed");
  const starts = f.driver().of("start").filter((c) => c[1] === "agent:editor");
  assert.deepEqual((starts[0]![2] as any).tools.allowed, ["read"]);
  assert.deepEqual((starts[1]![2] as any).tools.allowed, ["write"]);
  await f.service("stop", { agent: "agent:editor" });
  await f.service("update", { agent: "agent:editor", tools: [] });
  assert.equal(f.driver().of("start").filter((c) => c[1] === "agent:editor").length, 2, "editing a stopped member does not start it");
  await f.service("start", { agent: "agent:editor" });
  assert.deepEqual((f.driver().of("start").at(-1)![2] as any).tools.allowed, []);
  await f.agents.stopAll();
});
