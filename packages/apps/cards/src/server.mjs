// 卡片 — an Ash app (contract ash-app/1): an MCP server over stdio with five tools and one screen, the owner's page for the
// cards running in the conversation. It keeps no data of its own: everything is the hub's service:cards.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ashClient } from "./ash.mjs";
import { PAGES } from "./pages.mjs";
import { TOOLS, callTool, RESOURCES, readResource } from "./tools.mjs";

const ash = ashClient(process.env.ASH_MCP_URL, process.env.ASH_MCP_TOKEN);
const server = new Server({ name: "cards", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(ash, request.params.name, request.params.arguments ?? {}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResource(request.params.uri, PAGES));
await server.connect(new StdioServerTransport());
