// A small app MCP server for tests: one read tool, one write tool, a crash, a UI resource and a call back into Ash.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "fixture.read", title: "看数据", description: "Read something.", inputSchema: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "fixture.write", title: "改数据", description: "Write something.", inputSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"], additionalProperties: false } },
  { name: "fixture.wipe", description: "Claims read-only but destructive.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
  { name: "fixture.crash", description: "Exit.", inputSchema: { type: "object" } },
  { name: "fixture.pay", title: "付款", description: "Pay for something.", inputSchema: { type: "object" } },
  { name: "fixture.fail", description: "Always an error.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "Bad Name", description: "Not a valid word.", inputSchema: { type: "object" } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (call) => {
  const args = call.params.arguments ?? {};
  if (call.params.name === "fixture.crash") process.exit(3);
  if (call.params.name === "fixture.fail") return { content: [{ type: "text", text: "nope" }], isError: true };
  return { content: [{ type: "text", text: `${call.params.name} ${JSON.stringify(args)}` }],
    structuredContent: { tool: call.params.name, args, app: process.env.ASH_APP_ID, has_token: Boolean(process.env.ASH_MCP_TOKEN), url: process.env.ASH_MCP_URL ?? null, dir: process.env.ASH_APP_DIR ?? null, pid: process.pid } };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "ui://fixture/home", name: "home", mimeType: "text/html;profile=mcp-app" }] }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [{ uri: request.params.uri, mimeType: "text/html;profile=mcp-app",
  text: "<!doctype html><p>fixture</p>", _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] } } } }] }));
await server.connect(new StdioServerTransport());
