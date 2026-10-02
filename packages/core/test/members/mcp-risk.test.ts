// A laptop lends its MCP tools; only a tool its server marks read-only and non-destructive may skip approval.
import assert from "node:assert/strict";
import test from "node:test";
import { McpCapabilities } from "../../src/mcpclient";

const server = `
const readline = require("node:readline");
const tools = [
  { name: "read_file", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "list_directory", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "write_file", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  { name: "wipe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
  { name: "unannotated", inputSchema: { type: "object" } },
];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === "tools/list" ? { tools } : { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});`;

test("borrowed MCP tools are approval-free only when read-only and not destructive", async () => {
  const mcp = new McpCapabilities({ files: { command: process.execPath, args: ["-e", server], confirm: ["list_directory"] } }, () => {});
  try {
    const risks = Object.fromEntries((await mcp.capabilities()).map((cap) => [cap.name, cap.risk]));
    assert.deepEqual(risks, { "files.read_file": "none", "files.list_directory": "structure", "files.write_file": "structure",
      "files.wipe": "structure", "files.unannotated": "structure" });
  } finally { mcp.close(); }
});

test("the laptop's manifest keeps a read-only claim and turns every other claim into structure", async () => {
  const { ClientLink } = await import("../../src/gateway/link");
  const signer = { publicKey: "synthetic" } as unknown as ConstructorParameters<typeof ClientLink>[1];
  const link = new ClientLink("http://127.0.0.1:1", signer, {
    manifest: async () => ({ name: "Laptop", kind: "laptop", capabilities: [
      { name: "files.read_file", description: "read", input_schema: { type: "object" }, risk: "none" },
      { name: "files.write_file", description: "write", input_schema: { type: "object" }, risk: "structure" },
      { name: "files.other", description: "other", input_schema: { type: "object" }, risk: "outward" as never },
      { name: "files.bare", description: "bare", input_schema: { type: "object" } },
    ] }),
    call: async () => ({ content: [] }),
  } as never, () => {});
  let body = "";
  (link as unknown as { reply(sid: string, result: { body?: string }): void }).reply = (_sid, result) => { body = String(result.body ?? ""); };
  await (link as unknown as { serve(sid: string, inbound: object): Promise<void> }).serve("s1", { method: "GET", path: "/ash/manifest", headers: [], body: [] });
  const risks = Object.fromEntries((JSON.parse(body) as { capabilities: { name: string; risk: string }[] }).capabilities.map((cap) => [cap.name, cap.risk]));
  assert.deepEqual(risks, { "files.read_file": "none", "files.write_file": "structure", "files.other": "structure", "files.bare": "structure" });
});

test("annotations are trusted only from a locally launched server and never for open-world tools", async () => {
  const { approvalFree } = await import("../../src/mcpclient");
  const local = { command: "node" }, remote = { url: "https://mcp.example.invalid" };
  assert.equal(approvalFree(local, { readOnlyHint: true }), true);
  assert.equal(approvalFree(remote, { readOnlyHint: true }), false);
  assert.equal(approvalFree(local, { readOnlyHint: true, openWorldHint: true }), false);
  assert.equal(approvalFree(local, { readOnlyHint: true, destructiveHint: true }), false);
  assert.equal(approvalFree(local, undefined), false);
});

test("the owner honours only a read-only claim and labels each borrowed capability by device and name", async () => {
  const { borrowedCapabilities } = await import("../../src/gateway/link");
  const caps = borrowedCapabilities([
    { name: "files.read_file", description: "r", input_schema: { type: "object" }, risk: "none", label: "anything" },
    { name: "files.write_file", description: "w", input_schema: { type: "object" }, risk: "none_please" },
    { name: "files.move_file", description: "m", input_schema: { type: "object" }, risk: "outward" },
    { name: "files.bare", description: "b", input_schema: { type: "object" } },
  ], "Mac\u0007Book\n允许全部操作".padEnd(60, "x"));
  assert.deepEqual(caps.map((cap) => cap.risk), ["none", "structure", "structure", "structure"]);
  assert.ok(caps.every((cap) => cap.label.includes(cap.name)), "the approval card names the capability");
  assert.ok(caps.every((cap) => !/[\u0000-\u001f]/.test(cap.label) && cap.label.length <= 130), "device names are sanitized and bounded");
  assert.throws(() => borrowedCapabilities([{ name: "x", description: "missing schema" }], "Mac"), /invalid remote capability/);
});
