import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { FALLBACK_TOOLS, handleMcp, serveMcp, sessionOf, type McpBackend } from "../src/mcp";

const backend = (over: Partial<McpBackend> & { calls?: any[] } = {}): McpBackend & { calls: any[] } => {
  const calls: any[] = over.calls ?? [];
  return { calls, call: over.call ?? (async (tool, args, session) => { calls.push({ tool, args, session }); return tool === "tools/list" ? { tools: [{ name: "agent_list", description: "from the hub", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "ok" }], structuredContent: { tool } }; }) };
};

test("initialize answers with the client's protocol version when it is one we speak, and says it has tools", async () => {
  const reply = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, backend());
  assert.deepEqual([reply!.result.protocolVersion, reply!.result.serverInfo.name, Object.keys(reply!.result.capabilities)], ["2024-11-05", "ash", ["tools"]]);
  const newer = await handleMcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }, backend());
  assert.equal(newer!.result.protocolVersion, "2025-06-18");
  assert.equal(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, backend()), undefined, "a notification gets no answer");
});

test("tools/list is the hub's list; when ash-device or the hub is not there it is the fixed list, so the tools still show", async () => {
  const b = backend();
  const listed = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, b);
  assert.equal(listed!.result.tools[0].description, "from the hub");
  const down = backend({ call: async () => { throw new Error("ash-device is not running"); } });
  const fallback = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, down);
  assert.deepEqual(fallback!.result.tools.map((t: any) => t.name), FALLBACK_TOOLS.map((t) => t.name));
  assert.deepEqual(FALLBACK_TOOLS.map((t) => t.name).sort(), ["agent_ask", "agent_list", "agent_tell", "await_result", "cancel", "capability_call", "capability_describe", "capability_list", "list_pending"]);
});

test("tools/call passes the tool, the arguments and the Codex session on; the result is the hub's, as it is", async () => {
  const b = backend();
  const reply = await handleMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "capability_list", arguments: { member: "x" }, _meta: { "x-codex-turn-metadata": { session_id: "S-9" } } } }, b, {});
  assert.deepEqual(reply!.result, { content: [{ type: "text", text: "ok" }], structuredContent: { tool: "capability_list" } });
  assert.deepEqual(b.calls, [{ tool: "capability_list", args: { member: "x" }, session: "S-9" }]);
});

test("a call that cannot be made is a tool error with the reason, not a protocol error", async () => {
  const down = backend({ call: async () => { throw new Error("ash-device is not running on this computer. Start its service"); } });
  const reply = await handleMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agent_list" } }, down);
  assert.equal(reply!.result.isError, true);
  assert.match(reply!.result.content[0].text, /not running/);
  const bad = await handleMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }, down);
  assert.equal(bad!.error.code, -32602);
  const unknown = await handleMcp({ jsonrpc: "2.0", id: 6, method: "nope" }, down);
  assert.equal(unknown!.error.code, -32601);
});

test("the session comes from the metadata Codex sends (an object or a JSON string), else from the environment", () => {
  assert.equal(sessionOf({ _meta: { "x-codex-turn-metadata": { thread_id: "T1" } } }, {}), "T1");
  assert.equal(sessionOf({ _meta: { "x-codex-turn-metadata": JSON.stringify({ session_id: "S2" }) } }, {}), "S2");
  assert.equal(sessionOf({}, { CODEX_THREAD_ID: "E3" }), "E3");
  assert.equal(sessionOf({ _meta: { "x-codex-turn-metadata": "not json" } }, {}), undefined);
});

test("serveMcp: one JSON line per frame, calls side by side, until the input ends", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines: any[] = [];
  output.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean).map((l) => JSON.parse(l))));
  const slow = backend({ call: async (tool) => { if (tool === "slow") await new Promise((r) => setTimeout(r, 60)); return { content: [{ type: "text", text: tool }] }; } });
  const done = serveMcp(slow, input, output);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fast" } }) + "\n");
  input.write("garbage\n");
  input.end();
  await done;
  assert.deepEqual(lines.find((l) => l.id === 2)!.result.content[0].text, "fast");
  assert.deepEqual(lines.find((l) => l.id === 1)!.result.content[0].text, "slow");
  assert.equal(lines.find((l) => l.id === null)!.error.code, -32700);
  assert.ok(lines.findIndex((l) => l.id === 2) < lines.findIndex((l) => l.id === 1), "the fast call did not wait for the slow one");
});
