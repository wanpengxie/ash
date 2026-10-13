import test from "node:test";
import assert from "node:assert/strict";
import { createSocketFixture } from "./fixtures/codex-create-socket";
const work = { node_id: "node", endpoint_id: "endpoint", kind: "conversation" as const, native_id: "thread" };
const writes = (f: Awaited<ReturnType<typeof createSocketFixture>>, method = "thread/start") => f.socket.calls.filter(c => c.method === method);
test("three stages separately invoke once, exact project and durable first client ID", async () => {
  const f = await createSocketFixture(); const inv = f.invocation();
  assert.equal((await f.adapter.createThread(inv)).status, "accepted");
  assert.deepEqual(writes(f)[0].params, { cwd: "/project", projectId: "project", ephemeral: false });
  assert.equal(writes(f, "turn/start").length, 0);
  assert.equal((await f.adapter.nameThread({ ...inv, work })).status, "accepted");
  const first = await f.adapter.startFirstInput({ ...inv, work, native_client_message_id: "persisted-client" });
  assert.equal(first.status, "accepted"); if (first.status === "accepted" && first.receipt.stage === "first_input") assert.equal(first.receipt.correlation, "uncertain");
  assert.equal(writes(f, "turn/start")[0].params.clientUserMessageId, "persisted-client");
  await assert.rejects(f.adapter.createThread({ ...inv, attempt_id: "second-attempt" }), /result_unknown/);
  await assert.rejects(f.adapter.startFirstInput({ ...inv, work, attempt_id: "new", native_client_message_id: "persisted-client" }), /result_unknown/);
  assert.deepEqual(f.socket.calls.filter(c => ["thread/start", "thread/name/set", "turn/start"].includes(c.method)).map(c => c.method), ["thread/start", "thread/name/set", "turn/start"]);
  f.adapter.close();
});
for (const mode of ["unknown-id", "wrong-root", "duplicate-id", "cursor-repeat", "incomplete", "same-name-other-path"]) test(`project ${mode} never creates or falls back`, async () => {
  const f = await createSocketFixture(), inv = f.invocation();
  if (mode === "unknown-id") inv.request.target.project_id = "missing";
  if (mode === "wrong-root" || mode === "same-name-other-path") f.socket.projects.data[0].roots[0].path = "/other/project";
  if (mode === "duplicate-id") f.socket.projects.data.push({ ...f.socket.projects.data[0] });
  if (mode === "cursor-repeat") f.socket.projects.nextCursor = "same";
  if (mode === "incomplete") { let cursor = 0; f.socket.hook = c => { if (c.method === "project/list") f.socket.projects = { data: [{ id: `id${cursor}`, roots: [{ path: "/project" }] }], nextCursor: `cursor${cursor++}` }; }; }
  await assert.rejects(f.adapter.createThread(inv), /stale_precondition|result_unknown/); assert.equal(writes(f).length, 0); f.adapter.close();
});
test("multiple cwd IDs require the exact selected ID and inventory hides foreign roots", async () => {
  const f = await createSocketFixture(), inv = f.invocation(); f.socket.projects.data.push({ id: "other", roots: [{ path: "/project" }] }, { id: "foreign", roots: [{ path: "/foreign" }] });
  assert.deepEqual(await f.adapter.projects(inv.request.target, inv), [{ project_id: "project", cwd: "/project" }, { project_id: "other", cwd: "/project" }]);
  assert.equal((await f.adapter.createThread(inv)).status, "accepted"); f.adapter.close();
});
test("asynchronous last authorization revocation blocks native write", async () => {
  const f = await createSocketFixture(), inv = f.invocation(); let gates = 0;
  inv.authorize = async () => { await Promise.resolve(); return ++gates < 5; };
  await assert.rejects(f.adapter.createThread(inv), /permission_denied/); assert.equal(writes(f).length, 0); f.adapter.close();
});
for (const fault of ["thread/start", "thread/name/set", "turn/start"]) test(`${fault} timeout and late receipt remain unknown, never replay`, async () => {
  const f = await createSocketFixture(10), inv = f.invocation(); f.socket.fault = fault;
  const invoke = () => fault === "thread/start" ? f.adapter.createThread(inv) : fault === "thread/name/set" ? f.adapter.nameThread({ ...inv, work }) : f.adapter.startFirstInput({ ...inv, work, native_client_message_id: "persisted" });
  await assert.rejects(invoke(), /result_unknown/); const call = writes(f, fault)[0];
  f.socket.emit("message", Buffer.from(JSON.stringify({ id: call.id, result: { thread: { id: "late", cwd: "/project" }, turn: { id: "late" } } })));
  await assert.rejects(invoke(), /result_unknown|stale_precondition/); assert.equal(writes(f, fault).length, 1); f.adapter.close();
});
test("close pending write yields unknown and never answers unsolicited approval", async () => {
  const f = await createSocketFixture(), inv = f.invocation(); f.socket.fault = "thread/start";
  f.socket.hook = c => { if (c.method === "thread/start") queueMicrotask(() => f.adapter.close()); };
  await assert.rejects(f.adapter.createThread(inv), /result_unknown/);
  assert.equal(writes(f).length, 1); assert.equal(f.socket.calls.some(c => c.method === "thread/resume"), false);
});
test("invalid durable client ID blocks turn; stable history projects no bodies", async () => {
  const f = await createSocketFixture(), inv = f.invocation();
  await assert.rejects(f.adapter.startFirstInput({ ...inv, work, native_client_message_id: "bad\nclient" }), /invalid/); assert.equal(writes(f, "turn/start").length, 0);
  f.socket.history = { data: [{ id: "turn", itemsView: "full", items: [{ type: "userMessage", id: "message", clientId: "persisted", content: "secret" }, { type: "commandExecution", body: "secret-tool" }] }], nextCursor: null };
  const page = await f.adapter.history(work, inv); assert.equal(page.items[0].messages[0].source_client_message_id, "persisted"); assert.equal(JSON.stringify(page).includes("secret"), false); f.adapter.close();
});
test("separate native allowlist rejects old control and arbitrary methods", async () => {
  const f = await createSocketFixture();
  for (const method of ["thread/resume", "turn/steer", "turn/interrupt", "approval/answer"]) await assert.rejects(f.transport.request(method as any, {}), /unsupported/);
  assert.equal(f.socket.calls.some(c => c.method === "thread/resume"), false); f.adapter.close();
});
test("receipt client mismatch is unknown after one write; native errors never leak", async () => {
  const f = await createSocketFixture(), inv = f.invocation(); f.socket.fault = "turn/start";
  f.socket.hook = c => { if (c.method === "turn/start") queueMicrotask(() => f.socket.emit("message", Buffer.from(JSON.stringify({ id: c.id, result: { turn: { id: "turn", clientUserMessageId: "foreign-client" } } })))); };
  await assert.rejects(f.adapter.startFirstInput({ ...inv, work, native_client_message_id: "persisted" }), /result_unknown/);
  assert.equal(writes(f, "turn/start").length, 1); f.adapter.close();
});
test("post-write authorization revoke keeps outcome unknown", async () => {
  const f = await createSocketFixture(), inv = f.invocation(); f.socket.hook = c => { if (c.method === "thread/start") f.revoke(); };
  await assert.rejects(f.adapter.createThread(inv), /result_unknown/); assert.equal(writes(f).length, 1); f.adapter.close();
});
test("listener instance change during project resolution never writes", async () => {
  const f = await createSocketFixture(), inv = f.invocation(); f.socket.hook = c => { if (c.method === "project/list") f.invalidate(); };
  await assert.rejects(f.adapter.createThread(inv), /offline|stale_precondition/); assert.equal(writes(f).length, 0); f.adapter.close();
});
for (const stage of ["create", "name", "first_input"] as const) test(`${stage} snapshots nested request/work/scope across authorization awaits`, async () => {
  const f = await createSocketFixture(), inv = f.invocation(), mutableWork = { ...work }; let gates = 0;
  inv.authorize = async () => {
    await Promise.resolve(); gates++;
    inv.request.target.cwd = "/foreign"; inv.request.target.project_id = "foreign";
    inv.request.target.node_id = "foreign"; inv.request.input.text = "foreign text"; inv.request.title = "foreign title";
    inv.principal.principal_id = "foreign"; inv.attempt_id = "foreign";
    mutableWork.native_id = "foreign";
    (inv.authorized_scope as { cwd: string }).cwd = "/foreign";
    return true;
  };
  const result = stage === "create" ? await f.adapter.createThread(inv) : stage === "name" ? await f.adapter.nameThread({ ...inv, work: mutableWork }) : await f.adapter.startFirstInput({ ...inv, work: mutableWork, native_client_message_id: "persisted" });
  assert.equal(result.status, "accepted"); assert.ok(gates > 1);
  const call = writes(f, stage === "create" ? "thread/start" : stage === "name" ? "thread/name/set" : "turn/start")[0];
  assert.equal(JSON.stringify(call.params).includes("foreign"), false);
  f.adapter.close();
});
for (const method of ["metadata", "history"] as const) test(`${method} rejects stable foreign native cwd within another lease`, async () => {
  const f = await createSocketFixture(), inv = f.invocation(); f.socket.cwd = "/foreign";
  await assert.rejects(f.adapter[method](work, inv), /permission_denied/);
  assert.equal(writes(f, "thread/turns/list").length, 0); f.adapter.close();
});
for (const method of ["metadata", "history"] as const) test(`${method} snapshots mutable WorkRef and trusted scope before await`, async () => {
  const f = await createSocketFixture(), inv = f.invocation(), mutableWork = { ...work };
  inv.authorize = async () => { await Promise.resolve(); mutableWork.native_id = "foreign"; (inv.authorized_scope as { cwd: string }).cwd = "/foreign"; return true; };
  await f.adapter[method](mutableWork, inv);
  assert.equal(f.socket.calls.some(c => c.params?.threadId === "foreign"), false); f.adapter.close();
});
for (const result of [null, 1, "accepted", []]) test(`malformed name ack ${JSON.stringify(result)} becomes unknown without retry`, async () => {
  const f = await createSocketFixture(), inv = f.invocation(); f.socket.fault = "thread/name/set";
  f.socket.hook = c => { if (c.method === "thread/name/set") queueMicrotask(() => f.socket.emit("message", Buffer.from(JSON.stringify({ id: c.id, result })))); };
  await assert.rejects(f.adapter.nameThread({ ...inv, work }), /result_unknown/);
  await assert.rejects(f.adapter.nameThread({ ...inv, work }), /result_unknown/);
  assert.equal(writes(f, "thread/name/set").length, 1); f.adapter.close();
});
test("read errors still await last authorization and disclose no native detail", async () => {
  const f = await createSocketFixture(), inv = f.invocation(); let gates = 0; f.socket.fault = "thread/read";
  inv.authorize = async () => { await Promise.resolve(); return ++gates < 2; };
  f.socket.hook = c => { if (c.method === "thread/read") queueMicrotask(() => f.socket.emit("message", Buffer.from(JSON.stringify({ id: c.id, error: { code: -32000, message: "secret" } })))); };
  await assert.rejects(f.adapter.metadata(work, inv), /permission_denied/); assert.equal(gates, 2); f.adapter.close();
});
