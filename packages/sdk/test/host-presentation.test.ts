import assert from "node:assert/strict";
import test from "node:test";
import { hostPresentationErrors, type HostPresentationV2 } from "../src/host";

const approval: HostPresentationV2 = { id: "p1", kind: "approval", title: "Approve?", text: "Review this action",
  reply_to: "m_ask", reply_target: "service:gate", expires_at: 1_800_000_000_000,
  options: [{ id: "once", label: "Once" }, { id: "always", label: "Always" }, { id: "deny", label: "No" }] };
const reply: HostPresentationV2 = { id: "p2", kind: "reply", title: "A reply", text: "Hello" };
// @ts-expect-error Approval must carry the original ask sender.
const missingTarget: HostPresentationV2 = { ...approval, reply_target: undefined };
// @ts-expect-error A reply cannot supply an approval callback target.
const replyWithTarget: HostPresentationV2 = { ...reply, reply_target: "service:gate" };

test("approval has explicit original ask route and ordinary reply cannot route elsewhere", () => {
  assert.deepEqual(hostPresentationErrors(approval), []);
  assert.deepEqual(hostPresentationErrors({ ...approval, options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }] }), []);
  assert.deepEqual(hostPresentationErrors(reply), []);
  assert.ok(hostPresentationErrors(missingTarget).some((message) => message.includes("reply_target")));
  assert.ok(hostPresentationErrors(replyWithTarget).some((message) => message.includes("only for approval")));
});

test("missing or forged routing and invalid choices are rejected", () => {
  for (const mutation of [
    { reply_to: undefined }, { reply_target: undefined }, { options: undefined }, { expires_at: undefined },
    { reply_target: "" }, { reply_target: "https://example.invalid/redirect" }, { options: [{ id: "later", label: "Later" }] },
    { options: [{ id: "once", label: "Once" }] },
    { options: [{ id: "once", label: "Once" }, { id: "once", label: "Again" }] },
    { callback_url: "https://example.invalid/redirect" },
  ]) assert.notDeepEqual(hostPresentationErrors({ ...approval, ...mutation }), [], JSON.stringify(mutation));
});
