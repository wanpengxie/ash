import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_FALLBACK_LABEL, nativeDetailLabel, statusLabel } from "../src/labels";

test("status labels use declared human wording without leaking unrecognized tool names", () => {
  assert.equal(statusLabel("service:clock", "list", "在看日程"), "在看日程");
  assert.equal(statusLabel("device:phone", "calendar_read", "在查看日历"), "在查看日历");
  for (const label of [undefined, "Working", "calendar_read", "device:phone/calendar_read", "\u202esecret", "raw\nsecret"])
    assert.equal(statusLabel("device:phone", "calendar_read", label), STATUS_FALLBACK_LABEL);
  assert.equal(statusLabel("device:phone", "calendar_read", "字".repeat(90)).length, 80);
  assert.equal(statusLabel("native", "bash"), "在跑命令");
  assert.equal(statusLabel("native", "read"), "在看文件");
  assert.equal(statusLabel("native", "write"), "在写文件");
  assert.equal(statusLabel("native", "edit"), "在写文件");
  assert.equal(statusLabel("native", "web_search"), "在搜索");
  assert.equal(statusLabel("native", "web_fetch"), "在看网页");
  assert.equal(statusLabel("native", "subagent"), "在找帮手");
  assert.equal(statusLabel("native", "unlisted_tool"), STATUS_FALLBACK_LABEL);
});

test("the web tools say which site she opened or what she searched for, and nothing more", () => {
  assert.equal(nativeDetailLabel("web_fetch", '{"url":"https://www.nba.com/news/x?token=secret#y"}'), "在看网页 · nba.com");
  assert.equal(nativeDetailLabel("web_fetch", { url: "http://china.nba.cn/article/1" }), "在看网页 · china.nba.cn");
  assert.equal(nativeDetailLabel("web_search", '{"queries":["NBA季前赛 10月3日 战报","second"]}'), "在搜索 · NBA季前赛 10月3日 战报");
  assert.equal(nativeDetailLabel("web_search", { query: "很长".repeat(30) }), `在搜索 · ${"很长".repeat(15)}…`);
  assert.equal(nativeDetailLabel("web_search", { queries: ["a\u202eb\nc"] }), "在搜索 · a b c");
  for (const [word, args] of [["web_fetch", '{"url":"file:///etc/passwd"}'], ["web_fetch", "not json"], ["web_fetch", "{}"],
    ["web_search", '{"queries":[]}'], ["read", '{"file_path":"x"}']] as const)
    assert.equal(nativeDetailLabel(word, args), null);
});

test("Ash's own services and tools read as plain words, not their English contract labels", () => {
  assert.equal(statusLabel("service:gate", "mode.set", "Changing the approval mode"), "在申请改审批档位");
  assert.equal(statusLabel("service:agents", "ask", "Asking another agent"), "在问帮手");
  assert.equal(statusLabel("native", "mcp__ash__approval_log"), "在查审批记录");
  assert.equal(statusLabel("native", "mcp__ash__agent_create"), "在新建帮手");
  // A device capability keeps its own declared label.
  assert.equal(statusLabel("device:phone", "clipboard.set", "改剪贴板"), "改剪贴板");
});
