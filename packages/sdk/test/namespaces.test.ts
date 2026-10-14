import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import { ERROR_CODES } from "../src/message";
import {
  BROWSER_ACTIONS, BROWSER_EXTENSIONS, BROWSER_SPACE_PATTERN, STANDARD_ACTIONS, STANDARD_NAMESPACES, namespaceOf, standardAction, standardContract, standardContracts, standardMember,
} from "../src/namespaces";
import { EFFECTS, RISKS, effectRiskProblem, lintWords } from "../src/word";

const ajv = new Ajv2020({ strict: true });

test("every browser action has a unique browser.* name and compiled schemas", () => {
  const names = BROWSER_ACTIONS.map((action) => action.name);
  assert.equal(new Set(names).size, names.length);
  for (const action of BROWSER_ACTIONS) {
    assert.match(action.name, /^browser\.[a-z_]+$/);
    assert.ok(action.description.length > 0 && action.label.length > 0, action.name);
    assert.doesNotThrow(() => ajv.compile(action.input_schema), `${action.name} input`);
    assert.doesNotThrow(() => ajv.compile(action.result_schema), `${action.name} result`);
    assert.equal(action.input_schema.type, "object", action.name);
  }
});

test("effect and risk values are valid and read actions are risk none", () => {
  for (const action of BROWSER_ACTIONS) {
    assert.ok(EFFECTS.includes(action.effect), `${action.name} effect`);
    assert.ok(RISKS.includes(action.risk), `${action.name} risk`);
    if (action.effect === "read") assert.equal(action.risk, "none", action.name);
    assert.equal(typeof action.foreground, "boolean");
    for (const code of action.errors) assert.ok((ERROR_CODES as readonly string[]).includes(code), `${action.name} error ${code}`);
  }
});

test("browser actions share one optional space field and reject unknown input", () => {
  const space = new RegExp(BROWSER_SPACE_PATTERN);
  for (const action of BROWSER_ACTIONS) {
    const validate = ajv.compile(action.input_schema);
    if (action.name !== "browser.spaces") {
      assert.ok(action.input_schema.properties?.space, `${action.name} takes space`);
      assert.ok(!(action.input_schema.required ?? []).includes("space"), `${action.name} space is optional`);
    }
    assert.equal(validate({ no_such_field: 1 }), false, action.name);
  }
  assert.ok(space.test("main") && space.test("price-check") && !space.test("Main") && !space.test("a".repeat(25)));
});

test("sample calls validate against the standard input and result schemas", () => {
  const by = Object.fromEntries(BROWSER_ACTIONS.map((action) => [action.name, action]));
  const input = (name: string, value: unknown) => ajv.compile(by[name].input_schema)(value);
  const result = (name: string, value: unknown) => ajv.compile(by[name].result_schema)(value);
  assert.ok(input("browser.open", { url: "https://example.com", space: "trains" }));
  assert.ok(!input("browser.open", { url: "file:///etc/passwd" }));
  assert.ok(!input("browser.open", {}));
  assert.ok(input("browser.click", { ref: 3, site: "example.com", label: "登录" }));
  assert.ok(!input("browser.click", { ref: 3 }));
  assert.ok(input("browser.type", { ref: 1, site: "example.com", label: "搜索", text: "x", submit: true }));
  assert.ok(input("browser.scroll", { direction: "up" }) && !input("browser.scroll", { direction: "left" }));
  assert.ok(input("browser.close", { space: "*" }) && !input("browser.close", { space: "A B" }));
  assert.ok(input("browser.evaluate", { code: "document.title" }));
  assert.ok(input("browser.spaces", {}));
  const page = { space: "main", url: "https://example.com/", title: "Example", text: "hi", elements: [{ ref: 0, tag: "a", text: "More", href: "https://x.test/" }], extra: 1 };
  for (const name of ["browser.open", "browser.read", "browser.click", "browser.type", "browser.scroll", "browser.back"]) assert.ok(result(name, page), name);
  assert.ok(!result("browser.read", { space: "main", url: "u", title: "t", text: "x" }));
  assert.ok(result("browser.screenshot", { space: "main", url: "u", title: "t", mime: "image/jpeg" }));
  assert.ok(result("browser.evaluate", { space: "main", value: { a: [1] } }));
  assert.ok(result("browser.close", { closed: [] }));
  assert.ok(result("browser.spaces", { spaces: [{ space: "main", url: "u", title: "t", last_used: 1 }] }));
});

test("one-sided browser capabilities are x.* and not in the standard", () => {
  assert.deepEqual([...BROWSER_EXTENSIONS], ["x.android.browser.show", "x.android.browser.run", "x.android.browser.clear_logins", "x.kimi.browser.upload", "x.kimi.browser.network", "x.ego.browser.script"]);
  const standard = new Set(BROWSER_ACTIONS.map((action) => action.name));
  for (const name of BROWSER_EXTENSIONS) {
    assert.match(name, /^x\.[a-z0-9_-]+\.browser\.[a-z_]+$/);
    assert.ok(!standard.has(name));
  }
});

// ---- all the standard namespaces ---------------------------------------------------------------------------------------

test("the namespaces of SPEC-02 §4.3 are all there with the actions the phone and the computer have today", () => {
  const expected: Record<string, string[]> = {
    screen: ["read", "see", "screenshot", "touch_status", "tap", "type", "scroll", "swipe", "hold", "touch", "gesture", "global_action"],
    input: ["key"],
    vscreen: ["create", "close", "status", "see", "record.start", "record.stop", "launch", "tap", "swipe", "key", "type"],
    apps: ["list", "info", "usage", "open", "open_direct", "open_url"],
    settings: ["get", "put", "open"],
    clipboard: ["get", "set"],
    device: ["status"],
    workspace: ["ls", "read", "find", "grep", "write", "edit", "bash", "poll", "signal"],
    body: ["info"],
    browser: ["open", "read", "click", "type", "scroll", "back", "screenshot", "evaluate", "close", "spaces"],
    calendar: ["search", "list", "create"],
    media: ["list", "albums", "read", "save"],
    camera: ["capture"],
    location: ["get", "history", "track"],
    activity: ["current", "history"],
    health: ["sources", "read", "summary", "sync"],
    sensors: ["steps"],
    sense: ["status", "configure", "delete"],
    config: ["status", "permission.request", "keepalive.status", "permission.revoke", "owner_said", "switch.set"],
    decision: ["surface", "screen", "return"],
  };
  assert.deepEqual(Object.keys(STANDARD_NAMESPACES), Object.keys(expected));
  for (const [namespace, actions] of Object.entries(expected)) {
    assert.deepEqual(STANDARD_NAMESPACES[namespace]!.map((item) => item.name), actions.map((action) => `${namespace}.${action}`), namespace);
  }
  const names = STANDARD_ACTIONS.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(standardAction("screen.tap")?.name, "screen.tap");
  assert.equal(standardAction("screen.capture"), undefined, "the hidden capture is an internal function, not a capability");
  assert.equal(standardAction("intent.view"), undefined, "intent.view became apps.open_url");
  assert.equal(namespaceOf("config.permission.request"), "config");
  assert.equal(namespaceOf("nodots"), null);
});

test("every standard action compiles, passes the word lint, and keeps effect and risk legal", () => {
  assert.deepEqual(lintWords(standardContracts()), []);
  for (const item of STANDARD_ACTIONS) {
    assert.equal(effectRiskProblem(item.effect, item.risk), null, item.name);
    assert.equal(item.input_schema.type, "object", item.name);
    assert.match(item.label, /^在/, item.name);
    assert.doesNotThrow(() => ajv.compile(item.input_schema), `${item.name} input`);
    assert.doesNotThrow(() => ajv.compile(item.result_schema), `${item.name} result`);
    for (const code of item.errors) assert.ok((ERROR_CODES as readonly string[]).includes(code), `${item.name} error ${code}`);
  }
  assert.equal(standardMember("workspace.bash"), "body:*");
  assert.equal(standardMember("body.info"), "body:*");
  assert.equal(standardMember("screen.tap"), "device:*");
  assert.equal(standardContract(standardAction("screen.tap")!).label.doing, "在点屏幕");
});

test("effect and risk follow the phone's CapabilityPolicy and the computer's workspace.ts", () => {
  // name -> effect / risk. Old effect "send" is act and old "structure" is write; sense.configure is risk none (HUB-MODULES §7).
  const table: Record<string, [string, string]> = {
    "clipboard.get": ["read", "none"], "clipboard.set": ["act", "structure"], "device.status": ["read", "none"],
    "apps.list": ["read", "none"], "apps.open": ["act", "outward"], "apps.open_direct": ["act", "outward"], "apps.info": ["read", "none"], "apps.usage": ["read", "none"], "apps.open_url": ["act", "outward"],
    "settings.open": ["act", "outward"], "settings.get": ["read", "none"], "settings.put": ["write", "structure"], "input.key": ["act", "outward"],
    "screen.read": ["read", "none"], "screen.see": ["read", "none"], "screen.screenshot": ["read", "none"], "screen.touch_status": ["read", "none"],
    "screen.tap": ["act", "outward"], "screen.type": ["act", "outward"], "screen.scroll": ["act", "outward"], "screen.swipe": ["act", "outward"],
    "screen.hold": ["act", "outward"], "screen.touch": ["act", "outward"], "screen.gesture": ["act", "outward"], "screen.global_action": ["act", "outward"],
    "vscreen.create": ["act", "structure"], "vscreen.status": ["read", "none"], "vscreen.launch": ["act", "outward"], "vscreen.see": ["read", "none"],
    "vscreen.tap": ["act", "outward"], "vscreen.swipe": ["act", "outward"], "vscreen.key": ["act", "outward"], "vscreen.type": ["act", "outward"], "vscreen.close": ["act", "structure"],
    "vscreen.record.start": ["act", "structure"], "vscreen.record.stop": ["act", "structure"],
    "calendar.search": ["read", "none"], "calendar.list": ["read", "none"], "calendar.create": ["write", "outward"],
    "media.list": ["read", "none"], "media.albums": ["read", "none"], "media.read": ["read", "none"], "media.save": ["write", "none"], "camera.capture": ["act", "none"],
    "location.get": ["read", "none"], "location.history": ["read", "none"], "location.track": ["write", "none"],
    "activity.current": ["read", "none"], "activity.history": ["read", "none"], "sensors.steps": ["read", "none"],
    "health.sources": ["read", "none"], "health.read": ["read", "none"], "health.summary": ["read", "none"], "health.sync": ["act", "none"],
    "sense.status": ["read", "none"], "sense.configure": ["write", "none"], "sense.delete": ["write", "structure"],
    "workspace.ls": ["read", "none"], "workspace.read": ["read", "none"], "workspace.find": ["read", "none"], "workspace.grep": ["read", "none"],
    "workspace.write": ["write", "structure"], "workspace.edit": ["write", "structure"], "workspace.bash": ["execute", "structure"],
    "workspace.poll": ["read", "none"], "workspace.signal": ["act", "structure"], "body.info": ["read", "none"],
    "config.status": ["read", "none"], "config.permission.request": ["act", "none"], "config.keepalive.status": ["read", "none"],
    "config.permission.revoke": ["act", "none"], "config.owner_said": ["write", "none"], "config.switch.set": ["write", "none"],
  };
  for (const [name, [effect, risk]] of Object.entries(table)) {
    const item = standardAction(name);
    assert.ok(item, name);
    assert.deepEqual([item.effect, item.risk], [effect, risk], name);
  }
  const unlisted = STANDARD_ACTIONS.map((item) => item.name).filter((name) => !(name in table) && !name.startsWith("browser.") && !name.startsWith("decision."));
  assert.deepEqual(unlisted, []);
});

test("foreground, per-call risk and kernel-only marks", () => {
  const foreground = STANDARD_ACTIONS.filter((item) => item.foreground).map((item) => item.name).sort();
  assert.deepEqual(foreground, [
    "apps.open", "apps.open_direct", "apps.open_url", "config.permission.request", "config.permission.revoke", "input.key",
    "screen.gesture", "screen.global_action", "screen.hold", "screen.scroll", "screen.swipe", "screen.tap", "screen.touch", "screen.type", "settings.open",
  ]);
  assert.deepEqual(STANDARD_ACTIONS.filter((item) => item.per_call_risk).map((item) => item.name), ["workspace.write", "workspace.edit"]);
  // decision.* is for the reflex, apps.open_direct for service:host (which an agent calls as apps.open when the host cannot open apps).
  const kernelOnly = (name: string) => name.startsWith("decision.") || name === "apps.open_direct";
  for (const item of STANDARD_ACTIONS.filter((candidate) => kernelOnly(candidate.name))) assert.deepEqual(item.callers, ["kernel"], item.name);
  for (const item of STANDARD_ACTIONS.filter((candidate) => !kernelOnly(candidate.name))) assert.equal(item.callers, undefined, item.name);
});

test("sample calls of the new namespaces validate", () => {
  const input = (name: string, value: unknown) => ajv.compile(standardAction(name)!.input_schema)(value);
  assert.ok(input("screen.tap", { text: "OK" }) && input("screen.tap", { fx: 0.5, fy: 0.5, long: true }) && !input("screen.tap", { bogus: 1 }));
  assert.ok(input("screen.type", { text: "" }) && !input("screen.type", {}) && !input("screen.type", { text: "a", mode: "other" }));
  assert.ok(input("screen.gesture", { strokes: [{ kind: "down", finger: 0, fx: 0.2, fy: 0.8 }, { kind: "tap", fx: 0.5, fy: 0.5 }] }) && !input("screen.gesture", { strokes: [] }));
  assert.ok(input("screen.swipe", { fx1: 0.5, fy1: 0.8, fx2: 0.5, fy2: 0.2, durationMs: 400 }));
  assert.ok(input("screen.global_action", { action: "home" }) && !input("screen.global_action", { action: "reboot" }));
  assert.ok(input("settings.put", { namespace: "system", key: "screen_brightness", value: "120" }) && !input("settings.put", { namespace: "other", key: "k", value: "v" }));
  assert.ok(input("workspace.bash", { command: "ls", yield_ms: 100 }) && !input("workspace.bash", {}) && input("workspace.poll", { process: "p1" }));
  assert.ok(input("workspace.edit", { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] }) && !input("workspace.edit", { path: "a.txt", edits: [] }));
  assert.ok(input("calendar.create", { calendar_id: 1, title: "x", start_ms: 1, end_ms: 2 }) && !input("calendar.create", { title: "x" }));
  assert.ok(input("health.read", { metrics: ["steps"], sources: ["gadgetbridge"], max_rows: 10 }) && !input("health.read", { metrics: ["mood"] }));
  assert.ok(input("sense.configure", { recording: true, geofences: [{ name: "home", lat: 1, lon: 2, radius_m: 100 }], stale_hours: { gadgetbridge: 12 } }) && !input("sense.configure", { geofences: [{ name: "x", lat: 1, lon: 2, radius_m: 5 }] }));
  assert.ok(input("sense.delete", { kind: "all" }) && !input("sense.delete", {}));
  assert.ok(input("config.permission.request", { name: "accessibility" }) && !input("config.permission.request", { name: "nope" }));
  assert.ok(input("config.permission.revoke", { name: "accessibility" }) && !input("config.permission.revoke", {}));
  assert.ok(input("config.owner_said", { item: "autostart" }) && input("config.owner_said", { item: "autostart", on: false }) && !input("config.owner_said", { on: true }));
  assert.ok(input("config.switch.set", { name: "island_resident", on: true }) && !input("config.switch.set", { name: "other", on: true }) && !input("config.switch.set", { name: "notifications_read" }));
  assert.ok(input("vscreen.tap", { x: 1, y: 2 }) && !input("vscreen.tap", { x: 1 }));
  assert.ok(input("decision.return", { expected_package: "p", expected_state_epoch: 1, decision_id: "d" }));
  const result = (name: string, value: unknown) => ajv.compile(standardAction(name)!.result_schema)(value);
  assert.ok(result("body.info", { system: "linux", arch: "arm64", workdir: "/root/work", ownership: "own", full_linux: true }) && !result("body.info", { system: "linux" }));
  assert.ok(result("workspace.ls", { path: "/", entries: [{ name: "a", type: "file", size: 1 }] }));
  assert.ok(result("screen.read", { package: "p", nodes: [{ text: "a", x: 1 }], extra: 1 }));
  assert.ok(result("location.get", { lat: 1, lon: 2, accuracy_m: 5, age_s: 3 }) && !result("location.get", { lat: 1 }));
});
