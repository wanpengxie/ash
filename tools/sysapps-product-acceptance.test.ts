// Independent product acceptance gates. These intentionally expose baseline failures.
import assert from "node:assert/strict";
import test from "node:test";
import { wordsOf } from "../packages/sdk/src/words";
import { TasksService } from "../packages/core/src/services/tasks";
import { PersonaService } from "../packages/core/src/services/semantic/persona";
import { world, fake, owner, WordError, success } from "../packages/core/test/kernel/router/world";
import { fixture } from "../packages/core/test/edges/agents/helpers";

test("a committed task must not be reported as failed when scheduling is temporarily unavailable", async (t) => {
  const w = world();
  w.registry.add(fake("service:clock", wordsOf("service:clock"), () => {
    throw new WordError("offline", "clock unavailable for acceptance probe");
  }));
  const tasks = new TasksService({ ledger: w.ledger, router: w.router });
  w.registry.add(tasks);
  t.after(() => tasks.stop());
  const reply = await w.router.send({ to: "service:tasks", kind: "request", word: "add", body: {
    title: "交材料", remind_at: Date.now() + 60_000,
  } }, owner);
  const rows = success(await w.router.send({ to: "service:tasks", kind: "request", word: "list", body: {} }, owner)).tasks;
  t.diagnostic(JSON.stringify({ reply, persistedTasks: rows.length }));
  assert.equal(rows.length, 1);
  assert.equal(reply.ok, true, "the task is saved; scheduling failure must be reported separately");
});

test("a note stays saved when Ash is unavailable, and confirming its id does not send it again", async (t) => {
  const w = world();
  w.registry.add(fake("service:agents", wordsOf("service:agents"), () => ({ data: {
    agents: [{ id: "agent:main", name: "Ash", primary: true }],
  } })));
  let reachable = false;
  let wakes = 0;
  w.main.handler = (msg) => {
    if (msg.word === "wake") {
      wakes++;
      if (!reachable) throw new WordError("offline", "Ash temporarily unavailable");
    }
    return { data: { accepted: true } };
  };
  const persona = new PersonaService({ ledger: w.ledger, router: w.router,
    templates: { "SOUL.md": "# Soul", "IDENTITY.md": "# Identity" } });
  w.registry.add(persona);
  const request = { to: "service:persona", kind: "request" as const, word: "note", body: {
    id: "correction-1", about: "memory:USER.md", text: "会议是周三，不是周二",
  } };
  const first = success(await w.router.send(request, owner));
  assert.equal(first.told, false);
  reachable = true;
  const retry = success(await w.router.send(request, owner));
  const notes = success(await w.router.send({ to: "service:persona", kind: "request", word: "notes.list", body: {} }, owner)).notes;
  t.diagnostic(JSON.stringify({ first, retry, wakes, savedNotes: notes.length }));
  assert.equal(notes.length, 1, "confirming a save must not duplicate the correction");
  assert.equal(notes[0].text, request.body.text);
  assert.equal(retry.id, first.id);
  assert.equal(wakes, 1, "a save confirmation is not a notification retry");
});

test("saving a helper's tool restrictions changes the actual running authorization, not only its profile", async (t) => {
  const f = fixture();
  t.after(() => f.agents.stopAll());
  await f.start();
  await f.service("declare", { id: "agent:audited", name: "帮手", summary: "整理", brief: "help", tools: ["read"] });
  await f.service("update", { agent: "agent:audited", tools: [] });
  const declared = (await f.service("describe", { agent: "agent:audited" }))!.data as any;
  const latest = f.driver().of("start").filter((c) => c[1] === "agent:audited").at(-1)!;
  const actual = (latest[2] as any).tools.allowed;
  t.diagnostic(JSON.stringify({ profile: declared.tools, runtime: actual }));
  assert.deepEqual(actual, [], "revoking tools must not leave the old runtime authorization in effect");
});
