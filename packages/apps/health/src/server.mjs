// 健康 — an Ash app (contract ash-app/1): an MCP server over stdio with five tools and three MCP Apps screens.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ashClient } from "./ash.mjs";
import { Health, Store } from "./logic.mjs";
import { PAGES } from "./pages.mjs";
import { TOOLS, callTool, RESOURCES, readResource } from "./tools.mjs";

const dir = process.env.ASH_APP_DIR || "/root/apps/health";
// The owner's data lives in data/ (app.json data_dir: what apps.reset empties); 1.0.x kept it next to app.json.
const data = join(dir, "data", "data.json");
mkdirSync(dirname(data), { recursive: true });
if (!existsSync(data) && existsSync(join(dir, "data.json"))) renameSync(join(dir, "data.json"), data);
const health = new Health({ ash: ashClient(process.env.ASH_MCP_URL, process.env.ASH_MCP_TOKEN), store: new Store(data) });
const server = new Server({ name: "health", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(health, request.params.name, request.params.arguments ?? {}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResource(request.params.uri, PAGES));
await server.connect(new StdioServerTransport());

// Alerts and the Monday card: soon after start, then every three hours.
const check = () => health.check().catch((error) => process.stderr.write(`check failed: ${error instanceof Error ? error.message : error}\n`));
setTimeout(check, 30_000);
setInterval(check, 3 * 60 * 60 * 1000);
