/** The pieces the pi driver stands on: the proxy probe (against a local stand-in proxy), the route order, the error classes. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { AUTH_ERROR, NETWORK_ERROR, chooseRoute, probeProxy } from "../../../src/edges/agents/pi/route";
import { normalizeModel } from "../../../src/edges/agents/pi";

function proxy(answer: string | null): Promise<{ url: string; close(): void }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => { socket.once("data", () => { if (answer === null) socket.destroy(); else socket.write(answer); }); socket.on("error", () => {}); });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() }));
  });
}

test("the proxy probe: a CONNECT answered 200 is open; any other answer, a closed port or a dropped connection is not", async () => {
  const ok = await proxy("HTTP/1.1 200 Connection established\r\n\r\n");
  const refused = await proxy("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  const dropped = await proxy(null);
  try {
    assert.equal(await probeProxy(ok.url, 2000), true);
    assert.equal(await probeProxy(refused.url, 2000), false);
    assert.equal(await probeProxy(dropped.url, 2000), false);
  } finally { ok.close(); refused.close(); dropped.close(); }
  assert.equal(await probeProxy("http://127.0.0.1:1", 2000), false);
  assert.equal(await probeProxy("not a url", 2000), false);
});

test("the route is the proxy if it answers, else direct, else none", async () => {
  const route = (p: boolean, d: boolean) => chooseRoute(async (r) => (r === "proxy" ? p : d));
  assert.equal(await route(true, true), "proxy");
  assert.equal(await route(false, true), "direct");
  assert.equal(await route(false, false), "none");
  assert.equal(await chooseRoute(async () => { throw new Error("x"); }), "none");
});

test("errors are told apart: the network's, the login's, and neither", () => {
  for (const e of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:20171", "ETIMEDOUT", "terminated", "WebSocket closed", "other side closed"]) assert.ok(NETWORK_ERROR.test(e), e);
  for (const e of ["Could not parse your authentication token. Please try signing in again.", "No API key for provider openai-codex", "401 Unauthorized"]) assert.ok(AUTH_ERROR.test(e), e);
  for (const e of ["529 overloaded", "context length exceeded"]) assert.ok(!NETWORK_ERROR.test(e) && !AUTH_ERROR.test(e), e);
});

test("model names: provider/id as given, a bare deepseek-* is DeepSeek's, any other bare name is Codex's, none is the default", () => {
  assert.equal(normalizeModel("deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
  assert.equal(normalizeModel("deepseek-flash"), "deepseek/deepseek-flash");
  assert.equal(normalizeModel("gpt-5.5"), "openai-codex/gpt-5.5");
  assert.equal(normalizeModel(undefined), "deepseek/deepseek-flash");
});

