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
