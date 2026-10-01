import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_FALLBACK_LABEL, statusLabel } from "../src/labels";

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
