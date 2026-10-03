import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreenNet } from "../js/net.js";
import { browserUiTransport, embeddedUiTransport, readWorkspaceFile, validateCoreEndpoint } from "../js/ui-transport.js";

const storage = { removeItem() {}, setItem() {}, getItem() { return null; } };
const emptyStore = Promise.resolve(null);

test("embedded transport uses the exact core endpoint and waits for native READY", async () => {
  const calls = [];
  const transport = embeddedUiTransport({ endpoint: "http://127.0.0.1:4700", request: (op, path) => { calls.push([op, path]); return Promise.resolve(new Response("")); } });
  const net = new ScreenNet({ uiTransport: transport, storage, pendingStore: emptyStore });
  assert.equal(net.endpoint, "http://127.0.0.1:4700");
  const running = net.start();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  await assert.rejects(net.enqueueSay("held"), /not ready/);
  assert.throws(() => net.request("/api/send", { method: "POST" }), /not ready/);
  net.stop();
  transport.authorizeReady();
  assert.equal(transport.allowsQueueFlush(), true);
  await running;
  assert.deepEqual(calls, []);
  net.token = "synthetic-screen";
  net.currentScope = "synthetic-scope";
  await net.flush();
  assert.deepEqual(calls, []);
  assert.throws(() => transport.authorizeReady(), /already settled/);
});

test("embedded route inventory is exact and never falls back to ambient fetch", async () => {
  const calls = [];
  const transport = embeddedUiTransport({ endpoint: "http://127.0.0.1:4700", request: (op, path, options) => {
    calls.push({ op, path, options }); return Promise.resolve(new Response("ok"));
  } });
  transport.authorizeReady();
  await transport.request("/api/stream?follow=false&summary=true", { method: "GET" });
  await transport.request("/api/send", { method: "POST", body: "{}" });
  await transport.request("/api/workspaces/home/files?path=notes%2Ftoday.txt", { method: "GET" });
  assert.deepEqual(calls.map((call) => call.op), ["stream", "send", "file"]);
  for (const path of ["/api/admin", "//other/api/send", "http://127.0.0.1:4700/api/send", "/api/workspaces/home/files?path=..%2Fsecret", "/api/stream?follow=true&follow=false", "/api/workspaces/home/files?path=notes.txt&extra=1"]) {
    assert.throws(() => transport.request(path), /unapproved/);
  }
  assert.throws(() => transport.request("/api/workspaces/home/files?path=notes.txt", { method: "POST" }), /unapproved/);
  assert.throws(() => validateCoreEndpoint("http://127.0.0.1:4700/?token=secret"), /invalid/);
  assert.throws(() => validateCoreEndpoint("http://localhost:4700"), /invalid/);
});

test("workspace bytes cross only the validated read action", async () => {
  const bytes = Uint8Array.of(0, 1, 2, 255);
  const transport = embeddedUiTransport({ endpoint: "http://127.0.0.1:4700", request: async (op, path) => {
    assert.equal(op, "file");
    assert.equal(path, "/api/workspaces/home/files?path=notes%2Ftoday.txt");
    return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
  } });
  transport.authorizeReady();
  const blob = await readWorkspaceFile(transport, { workspace: "home", path: "notes/today.txt" });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  await assert.rejects(readWorkspaceFile(transport, { workspace: "home", path: "../secret" }), /invalid/);
});

test("file read fails closed on oversized bytes and browser packets contain no native bearer", async () => {
  const nativeOnly = "SYNTHETIC_NATIVE_ONLY_OWNER";
  const packets = [];
  const transport = embeddedUiTransport({ endpoint: "http://127.0.0.1:4700", request: async (op, path, options) => {
    packets.push({ op, path, options });
    // The native-only credential is deliberately not a field of this interface.
    assert.ok(nativeOnly);
    return new Response(new Uint8Array(20 * 1024 * 1024 + 1));
  } });
  transport.authorizeReady();
  await assert.rejects(readWorkspaceFile(transport, { workspace: "home", path: "large.bin" }), /too large/);
  assert.equal(packets.length, 1);
  assert.equal(JSON.stringify(packets).includes(nativeOnly), false);
});

test("ordinary browser transport retains same-origin fetch with no native latch", async () => {
  const paths = [];
  const transport = browserUiTransport(async (path) => { paths.push(path); return new Response("ok"); });
  assert.equal(transport.isReady(), true);
  await transport.request("/api/stream?follow=false");
  assert.deepEqual(paths, ["/api/stream?follow=false"]);
});

test("embedded boot does not open its new-origin pending database before READY", async () => {
  const original = globalThis.indexedDB;
  let opens = 0;
  globalThis.indexedDB = { open() { opens++; throw new Error("synthetic unavailable"); } };
  try {
    const transport = embeddedUiTransport({ endpoint: "http://127.0.0.1:4700", request: async () => new Response("") });
    const net = new ScreenNet({ uiTransport: transport, storage });
    await Promise.resolve();
    assert.equal(opens, 0);
    net.stop();
    transport.authorizeReady();
    assert.equal(await net.pendingReady, null);
    assert.equal(opens, 1);
  } finally { globalThis.indexedDB = original; }
});

test("the native transport lets the page list, save and remove vault keys, and nothing else under /api/vault", () => {
  const calls = [];
  const transport = embeddedUiTransport({ endpoint: "http://127.0.0.1:4700", request: (op, path) => { calls.push([op, path]); return Promise.resolve(new Response("")); } });
  transport.authorizeReady();
  transport.request("/api/vault", { method: "GET" });
  transport.request("/api/vault/DEEPSEEK_API_KEY", { method: "PUT", body: "{}" });
  transport.request("/api/vault/DEEPSEEK_API_KEY", { method: "DELETE" });
  assert.deepEqual(calls, [["vault", "/api/vault"], ["vault", "/api/vault/DEEPSEEK_API_KEY"], ["vault", "/api/vault/DEEPSEEK_API_KEY"]]);
  for (const [path, method] of [["/api/vault", "PUT"], ["/api/vault/DEEPSEEK_API_KEY", "GET"], ["/api/vault/a/b", "PUT"], ["/api/vault/x?y=1", "PUT"], ["/api/vault/..%2f", "DELETE"], ["/api/vault/", "GET"]])
    assert.throws(() => transport.request(path, { method }), /unapproved/, `${method} ${path}`);
});
