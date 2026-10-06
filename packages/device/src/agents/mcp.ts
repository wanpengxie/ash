import Ajv, { type ValidateFunction } from "ajv";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { checkTools, type OpenOptions } from "./types";
import type { Frame } from "./process";

export class AshTools {
  private schemas = new Map<string, ValidateFunction>();
  private running = 0;
  constructor(private options: OpenOptions, private turn: () => string | undefined) {
    checkTools(options.tools);
    const ajv = new Ajv({ strict: false });
    for (const tool of options.tools) this.schemas.set(tool.name, ajv.compile(tool.inputSchema));
  }
  async call(requestId: string, tool: string, args: unknown): Promise<unknown> {
    const turn = this.turn(), validate = this.schemas.get(tool);
    if (!turn || !validate || !args || typeof args !== "object" || Array.isArray(args) || !validate(args)) throw new Error("invalid Ash tool invocation");
    if (this.running >= 16) throw new Error("Ash tools busy");
    this.running++;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.options.onOutbound({ turn, requestId, tool, args: args as Record<string, unknown> }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Ash tool timed out")), 600_000); }),
      ]);
    } finally { this.running--; clearTimeout(timer); }
  }
  async handle(frame: Frame): Promise<Frame | undefined> {
    if (frame.id === undefined) return undefined;
    const response = (result: unknown) => ({ jsonrpc: "2.0", id: frame.id, result });
    if (frame.method === "initialize") return response({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ash", version: "0.1.0" } });
    if (frame.method === "ping") return response({});
    if (frame.method === "tools/list") return response({ tools: this.options.tools });
    if (frame.method === "tools/call") {
      try {
        const value = await this.call(String(frame.id), frame.params?.name, frame.params?.arguments ?? {});
        return response({ content: [{ type: "text", text: JSON.stringify(value ?? null) }] });
      } catch { return response({ isError: true, content: [{ type: "text", text: "Ash tool unavailable or invalid request" }] }); }
    }
    return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unknown method" } };
  }
}

/** A private, stateless MCP endpoint for runtimes that cannot host SDK tools. */
export async function serveTools(tools: AshTools): Promise<{ url: string; token: string; close(): void }> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.writeHead(403).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length; if (size > 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk);
      }
      const frame = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
      const result = await tools.handle(frame);
      if (!result) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch { if (!res.headersSent) res.writeHead(400).end(); }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, token, close() { server.close(); server.closeAllConnections(); } };
}
