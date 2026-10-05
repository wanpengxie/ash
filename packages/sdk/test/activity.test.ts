import assert from "node:assert/strict";
import test from "node:test";
import { activityAction, activityDetail, activityResult, ActivitySteps } from "../src/activity";

const outer = (purpose = "读取书架里的书名") => activityAction("service:dsh-tool", "mcp__ash__capability_call", {
  arguments: JSON.stringify({ member: "device:phone", word: "screen.read", body: {}, purpose }),
});
test("activity keeps purpose and the real tool but not raw input in the display projection", () => {
  const a = activityAction("service:dsh-tool", "bash", { arguments: JSON.stringify({ command: "PRIVATE COMMAND", description: "检查阅读应用是否已打开" }) });
  assert.equal(a.label, "检查阅读应用是否已打开"); assert.equal(a.tool, "bash");
  assert.doesNotMatch(JSON.stringify(a), /PRIVATE/);
  const type = activityAction("device:phone", "screen.type", { text: "PRIVATE BODY" });
  assert.doesNotMatch(JSON.stringify(type), /PRIVATE/);
  assert.equal(activityAction("device:phone", "browser.open", { url: "https://example.com/private?token=secret" }).target, "example.com");
});
test("wrapper, dispatch, approval and result are one lifecycle; device failure beats transport success", () => {
  const a = new ActivitySteps(); a.request("outer", 1, outer());
  a.request("inner", 2, activityAction("device:phone", "screen.read", {}));
  a.gate("inner", "等待确认");
  assert.equal(a.visible().length, 1); assert.equal(a.current()?.label, "读取书架里的书名");
  assert.equal(a.current()?.approval, "等待确认");
  a.response("inner", 4, { ok: false, error: { code: "denied" } });
  a.response("outer", 5, { ok: true, result: { preview: "{}" } });
  assert.equal(a.steps[0].state, "failed"); assert.equal(a.steps[0].ended, 4);
});
test("accepted is pending until the receipt resolves, including a wrapped accepted response", () => {
  const a = new ActivitySteps(); a.request("outer", 1, outer());
  a.response("outer", 2, { ok: true, result: { preview: JSON.stringify({ status: "accepted", request_id: "real" }) } });
  assert.equal(a.current()?.state, "accepted"); assert.equal(a.steps[0].ended, undefined);
  a.response("real", 6, { ok: true, result: {} });
  assert.equal(a.current(), undefined); assert.equal(a.steps[0].state, "ok");
  assert.equal(activityResult({ ok: true, result: { detail: '{"ok":false,"error":{"code":"denied"}}' } }).state, "failed");
});
test("ambiguous concurrent calls are not guessed together; polling success is folded but errors remain", () => {
  const a = new ActivitySteps(); a.request("a", 1, outer()); a.request("b", 2, outer());
  a.request("c", 3, activityAction("device:phone", "screen.read", {})); assert.equal(a.visible().length, 3);
  a.request("poll", 4, activityAction("service:dsh-tool", "mcp__ash__await_result", {})); assert.equal(a.visible().length, 3);
  a.response("poll", 5, { ok: false }); assert.equal(a.visible().length, 4);
});
test("detail redacts structured and embedded credentials, keeps actual multiline command and trailing content", () => {
  const detail = activityDetail({ token: "PRIVATE_TOKEN", arguments: JSON.stringify({ password: "PRIVATE_PASSWORD", command: "echo start\necho end", headers: { Authorization: "Bearer PRIVATE" } }),
    output: "api_key=PRIVATE_VALUE https://user:pass@example.org/x?token=PRIVATE_QUERY" });
  assert.doesNotMatch(detail, /PRIVATE|user:pass/); assert.match(detail, /echo start\\necho end/);
  assert.match(detail, /已隐藏/);
});
test("truncated or malformed structured result is never labelled successful", () => {
  assert.equal(activityResult({ ok: true, result: { preview: '{"ok":', truncated: true } }).state, "unconfirmed");
  assert.equal(activityResult({ ok: true, result: { preview: '{"ok":' } }).state, "unconfirmed");
  assert.equal(activityResult({ ok: true, result: { preview: "plain command output" } }).state, "ok");
});
