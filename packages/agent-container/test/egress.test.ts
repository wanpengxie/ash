import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { ModelEgress, UsageMeter, type EgressUsage } from "../src/egress";
import { PLACEHOLDER_KEY, patchText } from "../src/launch";

test("the usage meter reads an Anthropic stream, even split mid-line", () => {
  const meter = new UsageMeter();
  const stream = 'event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-flash","usage":{"input_tokens":120,"cache_read_input_tokens":30,"output_tokens":1}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n';
  meter.sse(stream.slice(0, 50));
  meter.sse(stream.slice(50));
  assert.deepEqual([meter.model, meter.input, meter.output, meter.cacheRead, meter.cacheWrite], ["deepseek-v4-flash", 120, 42, 30, 0]);
});

test("the egress puts the vault key on, streams the answer back unchanged, and books usage", async () => {
  let seen: IncomingHttpHeaders | null = null;
  let path = "";
  const upstream = createServer((req, res) => {
    seen = req.headers; path = req.url ?? "";
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"type":"message_start","message":{"model":"m1","usage":{"input_tokens":5,"output_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let key: string | null = "sk-real-from-vault";
  const egress = new ModelEgress({ key: () => key, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
  const base = await egress.start();
  const usage: EgressUsage[] = [];
  egress.onUsage((record) => usage.push(record));
  egress.label("s-main", "chat");
  try {
    const response = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": PLACEHOLDER_KEY, "content-type": "application/json", "anthropic-version": "2023-06-01",
      "x-deepseek-harness-session-id": "s-main" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }) });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /message_delta/);
    assert.equal(seen!["x-api-key"], "sk-real-from-vault");
    assert.equal(seen!["anthropic-version"], "2023-06-01");
    assert.equal(path, "/anthropic/v1/messages");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(usage.length, 1);
    assert.deepEqual({ scope: usage[0]!.scope, model: usage[0]!.model, input: usage[0]!.input, output: usage[0]!.output, ok: usage[0]!.ok },
      { scope: "chat", model: "m1", input: 5, output: 9, ok: true });

    // Without the secret path segment nothing is forwarded: another app on the phone cannot spend the key.
    const wrong = await fetch(base.replace(/\/[^/]+\/anthropic$/, "/guess/anthropic/v1/messages"), { method: "POST", body: "{}" });
    assert.equal(wrong.status, 404);

    // Without a key the agent gets an authentication error and the turn learns why.
    key = null;
    const started = Date.now();
    const none = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-deepseek-harness-session-id": "s-main" }, body: "{}" });
    assert.equal(none.status, 401);
    assert.equal(egress.failuresSince(started, "s-main")[0]?.status, 401);
  } finally {
    await egress.close();
    upstream.close();
  }
});

test("a provider failure is remembered for the turn's explanation", async () => {
  const upstream = createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(402, { "content-type": "application/json" }).end('{"error":{"message":"Insufficient Balance"}}')); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const egress = new ModelEgress({ key: () => "k", upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
  const base = await egress.start();
  try {
    const started = Date.now();
    const response = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(response.status, 402);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(egress.failuresSince(started).map((failure) => [failure.status, failure.message]), [[402, "Insufficient Balance"]]);
  } finally { await egress.close(); upstream.close(); }
});

test("concurrent model calls are attributed by DSH session id, not by whichever agent is active", async () => {
  const upstream = createServer((req, res) => {
    const session = String(req.headers["x-deepseek-harness-session-id"] ?? "none");
    req.resume();
    req.on("end", () => setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: session, usage: { input_tokens: session === "s-a" ? 11 : 22, output_tokens: 1 } }));
    }, session === "s-a" ? 30 : 5));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const egress = new ModelEgress({ key: () => "k", upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
  const base = await egress.start();
  const usage: EgressUsage[] = [];
  egress.onUsage((record) => usage.push(record));
  egress.label("s-a", "agent:writer");
  egress.label("s-b", "agent:translator");
  try {
    await Promise.all(["s-a", "s-b"].map((session) => fetch(`${base}/v1/messages`, { method: "POST",
      headers: { "x-deepseek-harness-session-id": session }, body: "{}" }).then((response) => response.text())));
    assert.deepEqual(usage.sort((a, b) => a.scope.localeCompare(b.scope)).map((item) => [item.scope, item.model, item.input]),
      [["agent:translator", "s-b", 22], ["agent:writer", "s-a", 11]]);
  } finally { await egress.close(); upstream.close(); }
});

test("the launch patch swaps the official ACP row for ash's plugin and quotes paths", () => {
  const text = patchText("/opt/ash/dsh-ash-control/index.mjs", { provider: "deepseek-official", model: "deepseek-v4-flash" }, "/opt/ash/ash-skills/index.mjs");
  assert.match(text, /- id: acp\n  disabled: true/);
  assert.match(text, /name: '\/opt\/ash\/dsh-ash-control\/index.mjs'/);
  assert.match(text, /inject: \[acpAppStartup\]/);
  assert.match(text, /- id: ash-skills\n      name: '\/opt\/ash\/ash-skills\/index.mjs'/);
  assert.match(patchText("/a'b", { provider: "p", model: "m" }), /name: '\/a''b'/);
});
