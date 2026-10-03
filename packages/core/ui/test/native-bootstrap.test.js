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
  return { native, sent, request, gateway: sandbox.__ashGatewayConfig };
}

test("APK bridge keeps the gateway bootstrap secret off ordinary API requests and replies", async () => {
  const { native, sent, gateway } = page();
  const saving = gateway("save", "https://ash.example.test", "one-time-test-secret");
  const wire = sent.shift();
  assert.deepEqual(wire, { type: "gateway_config", id: "1", operation: "save", url: "https://ash.example.test", secret: "one-time-test-secret" });
  native.onmessage({ data: JSON.stringify({ type: "gateway_config_result", id: wire.id, ok: true,
    configured: true, url: "https://ash.example.test" }) });
  const saved = await saving;
  assert.equal(saved.url, "https://ash.example.test");
  assert.equal(JSON.stringify(saved).includes("one-time-test-secret"), false);
  const checking = gateway("status");
  assert.deepEqual(sent.shift(), { type: "gateway_config", id: "2", operation: "status" });
  native.onmessage({ data: JSON.stringify({ type: "gateway_config_result", id: "2", ok: true,
    configured: true, url: "https://ash.example.test" }) });
  assert.equal((await checking).configured, true);
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
