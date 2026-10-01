import assert from "node:assert/strict";
import test from "node:test";
import { SettingsControls } from "../js/settings.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.listeners = new Map(); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this[name] = value; }
  click() { this.listeners.get("click")?.(); }
  find(id) { return this.id === id ? this : this.children.map((child) => child.find(id)).find(Boolean); }
}

test("settings hide management on old, remote, malformed, or disconnected registration", () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const net = { token: "screen-token", localManagement: false, sendAdmin: async () => ({ ok: false }) };
    const settings = new SettingsControls(panel, net);
    settings.registration({}); settings.network("online");
    assert.equal(panel.find("settingsAdmin"), undefined);
    settings.registration({ local_management: false });
    assert.equal(panel.find("settingsAdmin"), undefined);
    settings.registration({ local_management: "true" });
    assert.equal(panel.find("settingsAdmin"), undefined);
    net.localManagement = true;
    settings.registration({ local_management: true });
    assert.ok(panel.find("settingsAdmin"));
    settings.network("offline");
    assert.equal(panel.find("settingsAdmin"), undefined);
  } finally { delete globalThis.document; }
});

test("resume requires a second explicit click and never labels an unpaired result as success", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    let calls = 0;
    let result = { ok: false, reason: "HTTP 403" };
    const net = { token: "screen-token", localManagement: true, async sendAdmin(word) { calls++; assert.equal(word, "resume"); return result; } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsResume").click();
    assert.equal(calls, 0);
    assert.equal(panel.find("settingsResumeConfirmation").hidden, false);
    panel.find("settingsResumeYes").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.match(panel.find("settingsFeedback").textContent, /未确认/);
    result = { ok: true, paused: false };
    panel.find("settingsResume").click();
    panel.find("settingsResumeYes").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsFeedback").textContent, "已恢复 Ash");
  } finally { delete globalThis.document; }
});
