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
