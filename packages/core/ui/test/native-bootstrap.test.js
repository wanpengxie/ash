import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../js/native-bootstrap.js", import.meta.url), "utf8");
function page() {
  const sent = [];
  const native = { postMessage(wire) { sent.push(JSON.parse(wire)); } };
  let request;
  const sandbox = { AshNative: native, location: { origin: "https://appassets.androidplatform.net" },
    URL, Headers, Response, ReadableStream, DOMException, Uint8Array, atob,
    __ashNativeBoot(fn, endpoint) { assert.equal(endpoint, "http://127.0.0.1:4700"); request = fn; } };
  runInNewContext(source, sandbox);
  assert.deepEqual(sent.shift(), { type: "hello" });
  native.onmessage({ data: JSON.stringify({ type: "ready", endpoint: "http://127.0.0.1:4700" }) });
  return { native, sent, request, jev: sandbox.__ashJevKey };
}

test("APK bridge stores JEV Key privately and returns only configured status", async () => {
  const { native, sent, jev } = page();
  const pending = jev("save", "secret-test-key");
  const wire = sent.shift();
  assert.deepEqual(wire, { type: "jev", id: "1", operation: "save", key: "secret-test-key" });
  native.onmessage({ data: JSON.stringify({ type: "jev_result", id: wire.id, ok: true, configured: true }) });
  assert.equal(JSON.stringify(await pending), '{"ok":true,"configured":true}');
  const status = jev("status");
  const statusWire = sent.shift();
  assert.equal(Object.hasOwn(statusWire, "key"), false);
  native.onmessage({ data: JSON.stringify({ type: "jev_result", id: statusWire.id, ok: true, configured: true }) });
  assert.equal(JSON.stringify(await status), '{"ok":true,"configured":true}');
});

test("APK bridge returns finite response bytes without an owner credential", async () => {
  const { native, sent, request } = page();
  const promise = request("send", "/api/send", { method: "POST", headers: { "Ash-Screen": "screen" }, body: "{}" });
  const wire = sent.shift();
  assert.equal(wire.type, "request");
  assert.equal(wire.operation, "send");
  assert.equal(wire.headers["ash-screen"], "screen");
  assert.equal(wire.body, "{}");
  assert.equal(JSON.stringify(wire).includes("Bearer"), false);
  native.onmessage({ data: JSON.stringify({ id: wire.id, type: "done", status: 200,
    content_type: "application/json", body: btoa('{"ok":true}') }) });
  assert.equal(await (await promise).text(), '{"ok":true}');
});

test("APK bridge streams SSE chunks and aborts the native request", async () => {
  const { native, sent, request } = page();
  const abort = new AbortController();
  const pending = request("stream", "/api/stream?follow=true", { signal: abort.signal });
  const wire = sent.shift();
  native.onmessage({ data: JSON.stringify({ id: wire.id, type: "started" }) });
  const stream = await pending;
  const reader = stream.body.getReader();
  native.onmessage({ data: JSON.stringify({ id: wire.id, type: "chunk", body: btoa("data: ready\n\n") }) });
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: ready\n\n");
  abort.abort();
  assert.deepEqual(sent.shift(), { type: "cancel", id: wire.id });
  await assert.rejects(reader.read(), /Aborted/);
});
