import assert from "node:assert/strict";
import test from "node:test";
import { faceForStatus, PresenceBar } from "../js/presence.js";

function fixture() {
  const nodes = Object.fromEntries(["#presence", "#state", "#face img", "#dot", "#connection", "#presenceNotice"]
    .map((selector) => [selector, { dataset: {}, textContent: "", title: "", className: "", src: "", addEventListener(_event, callback) { this.click = callback; } }]));
  return { nodes, bar: new PresenceBar({ querySelector: (selector) => nodes[selector] }) };
}

test("all seven authoritative states select the specified image and human text", () => {
  const { nodes, bar } = fixture();
  const cases = [
    ["resting", "resting", "休息中"], ["listening", "listening", "在听"],
    ["thinking", "thinking", "在想"], ["working", "focused", "在忙"],
    ["done", "success", ""], ["waiting_you", "listening", "等你一句话"],
    ["idle", "default", "在线"],
  ];
  for (const [state, face, label] of cases) {
    assert.equal(faceForStatus(state), face);
    bar.render({ state, text: "" });
    assert.equal(nodes["#presence"].dataset.state, state);
    assert.equal(nodes["#state"].textContent, label);
    assert.equal(nodes["#face img"].src, `/avatars/${face}.webp`);
  }
  bar.render({ state: "working", text: "在看文件" });
  assert.equal(nodes["#state"].textContent, "在看文件");
  bar.render({ state: "working", text: "" });
  assert.equal(nodes["#state"].textContent, "在忙");
});

test("transport failures and unavailable sheet never forge an agent state", () => {
  const { nodes, bar } = fixture();
  bar.render({ state: "thinking", text: "在想" });
  bar.network("offline");
  assert.equal(nodes["#state"].textContent, "在想");
  assert.equal(nodes["#connection"].textContent, "离线，正在重连…");
  nodes["#presence"].click();
  assert.equal(nodes["#presenceNotice"].textContent, "人物页尚未接入");
  bar.render({ state: "not-a-status", text: "unsafe" });
  assert.equal(nodes["#state"].textContent, "状态待同步");
  assert.equal(nodes["#face img"].src, "/avatars/default.webp");
});
