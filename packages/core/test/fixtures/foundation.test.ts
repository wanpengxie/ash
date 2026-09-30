import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FakeHost } from "./fake-host";
import { FakeModel } from "./fake-model";

const host = new FakeHost();
const model = new FakeModel();
after(async () => { await host.close(); await model.close(); });

test("host records manifest, scripted call and presentation lifecycle", async () => {
  const url = await host.start();
  host.manifest.capabilities = [{ name: "calendar.search", description: "find events", input_schema: { type: "object" }, risk: "none", label: "Checking calendar" }];
  host.queueCall("calendar.search", { ok: true, content: [] });
  const auth = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
  const get = await fetch(`${url}/manifest`, { headers: auth });
  assert.equal((await get.json() as { capabilities: unknown[] }).capabilities.length, 1);
  const body = { capability: "calendar.search", args: { day: "today" }, caller: "agent:main" };
  assert.deepEqual(await (await fetch(`${url}/call`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json(), { ok: true, content: [] });
  for (const [path, input] of [["/present", { id: "p1", kind: "approval", title: "Approve", text: "?", reply_to: "m_ask", reply_target: "service:gate", options: [{ id: "once", label: "Once" }, { id: "always", label: "Always" }, { id: "deny", label: "No" }], expires_at: Date.now() + 10000 }], ["/present/hide", { id: "p1" }], ["/alarm", { id: "a1" }]] as const) {
    assert.equal((await fetch(`${url}${path}`, { method: "POST", headers: auth, body: JSON.stringify(input) })).status, 200);
    host.assertCall(path, input);
  }
  host.assertCall("/call", body);
  assert.deepEqual(await (await fetch(`${url}/key`, { headers: auth })).json(), { id: "test-device", publicKey: "test-public-key" });
  assert.deepEqual(await (await fetch(`${url}/sign`, { method: "POST", headers: auth, body: "{}" })).json(), { sig: "test-signature" });
  assert.equal((await fetch(`${url}/restart`, { method: "POST", headers: auth, body: "{}" })).status, 200);
  host.assertDrained();
  assert.equal((await fetch(`${url}/manifest`)).status, 401);
});

test("model scripts tool and worker JSON, captures both requests", async () => {
  const url = await model.start();
  model.tool("ash_send", { to: "device:phone", word: "calendar.search", body: {} });
  model.json({ claims: [{ text: "sample", evidence: ["m1"] }] });
  const send = (body: object) => fetch(`${url}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const first = await (await send({ model: "fixture", stream: false, tools: [{ name: "ash_send" }], messages: [{ role: "user", content: "call phone" }] })).json() as { content: { type: string; name: string }[] };
  assert.deepEqual(first.content.map(x => [x.type, x.name]), [["tool_use", "ash_send"]]);
  const response = await send({ model: "fixture", stream: true, tools: [], messages: [{ role: "user", content: "extract" }] });
  const sse = await response.text();
  assert.match(sse, /claims/);
  assert.equal(model.requests.length, 2);
  model.assertDrained();
  assert.equal((await send({ model: "fixture" })).status, 409);
});
