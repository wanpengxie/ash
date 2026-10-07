import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { KimiBridge, KIMI_CAPABILITIES } from "../src/kimi";

test("WebBridge connects only on loopback, fixes tab scope, rejects stale refs and saves images", async t => {
  const bridge = new KimiBridge(await mkdtemp(join(tmpdir(), "ash-kimi-"))); await bridge.start([0]);
  t.after(() => bridge.close());
  const socket = new WebSocket(bridge.url, { origin: "chrome-extension://" + "a".repeat(32) });
  t.after(() => socket.terminate()); await once(socket, "open");
  const calls: any[] = []; let tab = 100;
  socket.on("message", bytes => {
    const f = JSON.parse(bytes.toString()); if (f.type !== "tool_call") return;
    calls.push(f.payload);
    const data = f.payload.name === "navigate" ? { tabId: f.payload.args._tabId ?? ++tab }
      : f.payload.name === "screenshot" ? { format: "png", data: Buffer.from("png-fixture").toString("base64") } : { tree: [], success: true };
    socket.send(JSON.stringify({ type: "tool_result", responseToRequestId: f.requestId, payload: { data } }));
  });
  socket.send(JSON.stringify({ type: "hello", payload: { extensionVersion: "fixture" } }));
  await once(socket, "message"); assert.equal(bridge.online, true);
  assert.equal((await bridge.call("browser.click", { task: "a", args: { selector: "button" } }, "agent:a")).ok, false);
  await bridge.call("browser.navigate", { task: "a", args: { url: "https://example.com", _tabId: 999, _session: "stolen" } }, "agent:a");
  assert.equal(calls[0].args._tabId, undefined); assert.notEqual(calls[0].args._session, "stolen");
  await bridge.call("browser.snapshot", { task: "a", args: {} }, "agent:a");
  assert.equal(calls[1].args._tabId, 101);
  await bridge.call("browser.navigate", { task: "a", args: { url: "https://example.com" } }, "agent:b");
  assert.equal((await bridge.call("browser.click", { task: "a", args: { selector: "@e1" } }, "agent:a")).ok, false);
  const picture = await bridge.call("browser.screenshot", { task: "a", args: {} }, "agent:a");
  assert.equal(await readFile((picture.data as any).path, "utf8"), "png-fixture");
  assert.equal(KIMI_CAPABILITIES.find(c => c.name === "browser.evaluate")?.risk, "structure");
  assert.equal(KIMI_CAPABILITIES.find(c => c.name === "browser.snapshot")?.risk, "none");
});
