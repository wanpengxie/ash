import assert from "node:assert/strict";
import test from "node:test";
import { FakeHost } from "./fake-host";
import type { HostPresentationV2 } from "../../../sdk/src/host";

test("fake host records a routed approval and rejects missing reply target", async () => {
  const host = new FakeHost();
  try {
    const url = await host.start();
    const send = (body: unknown) => fetch(`${url}/present`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const approval: HostPresentationV2 = { id: "p1", kind: "approval", title: "Approve", text: "One action",
      reply_to: "m_ask", reply_target: "service:gate", expires_at: Date.now() + 10000,
      options: [{ id: "once", label: "Once" }, { id: "always", label: "Always" }, { id: "deny", label: "No" }] };
    assert.equal((await send(approval)).status, 200);
    host.assertCall("/present", approval);
    const absent = { ...approval, reply_target: undefined };
    assert.equal((await send(absent)).status, 400);
    const injected = { ...approval, callback_url: "https://example.invalid/redirect" };
    assert.equal((await send(injected)).status, 400);
    const ordinary = { id: "p2", kind: "reply", title: "Hello", text: "Reply text" };
    assert.equal((await send(ordinary)).status, 200);
    assert.equal((await send({ ...ordinary, reply_target: "service:gate" })).status, 400);
  } finally { await host.close(); }
});
