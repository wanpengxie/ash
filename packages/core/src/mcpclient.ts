// A small MCP client: a laptop (client role) turns its local MCP servers into ash capabilities
// named `<server>.<tool>`. stdio servers are spawned on demand (newline-delimited JSON-RPC);
// URL servers speak Streamable HTTP (JSON or SSE responses).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CallResult, CapabilitySpec, ContentBlock } from "../../sdk/src/api";

export type McpServerSpec = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; confirm?: string[] } | { url: string; headers?: Record<string, string>; confirm?: string[] };

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: any;
  error?: { code: number; message: string };
}

const CLIENT_INFO = { name: "ash", version: "1" };
const PROTOCOL = "2025-06-18";

abstract class McpConnection {
  protected nextId = 1;
  private ready: Promise<void> | null = null;
  constructor(
    readonly name: string,
    protected readonly log: (...a: unknown[]) => void,
  ) {}
  protected abstract rpc(msg: Rpc, timeoutMs: number): Promise<Rpc | null>;

  private init(): Promise<void> {
    this.ready ??= (async () => {
      const r = await this.rpc({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } }, 60_000);
      if (r?.error) throw new Error(`initialize: ${r.error.message}`);
      await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, 10_000);
    })().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  protected reset(): void {
    this.ready = null;
  }

  async request(method: string, params: unknown, timeoutMs = 120_000): Promise<any> {
    await this.init();
    const r = await this.rpc({ jsonrpc: "2.0", id: this.nextId++, method, params }, timeoutMs);
    if (!r) throw new Error(`${this.name}: no answer to ${method}`);
    if (r.error) throw new Error(`${this.name}: ${r.error.message}`);
    return r.result;
  }

  abstract close(): void;
}

class StdioConnection extends McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly waiting = new Map<number, (m: Rpc) => void>();
  private buf = "";

  constructor(
    name: string,
    private readonly spec: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string },
    log: (...a: unknown[]) => void,
  ) {
    super(name, log);
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(this.spec.command, this.spec.args ?? [], { cwd: this.spec.cwd, env: { ...process.env, ...this.spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (d) => this.log(`[mcp ${this.name}]`, String(d).trim().slice(0, 500)));
    child.stdout.on("data", (d) => {
      this.buf += String(d);
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Rpc;
          if (typeof msg.id === "number" && msg.method === undefined) {
            this.waiting.get(msg.id)?.(msg);
            this.waiting.delete(msg.id);
          }
        } catch {
          this.log(`[mcp ${this.name}] non-JSON output:`, line.slice(0, 200));
        }
      }
    });
    child.on("exit", (code) => {
      this.log(`[mcp ${this.name}] exited`, code);
      for (const [id, w] of this.waiting) w({ jsonrpc: "2.0", id, error: { code: -32000, message: "MCP server exited" } });
      this.waiting.clear();
      this.reset();
    });
    child.on("error", (e) => this.log(`[mcp ${this.name}] failed to start:`, e.message));
    this.child = child;
    return child;
  }

  protected rpc(msg: Rpc, timeoutMs: number): Promise<Rpc | null> {
    const child = this.ensure();
    child.stdin.write(JSON.stringify(msg) + "\n");
    if (msg.id === undefined) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiting.delete(msg.id!);
        resolve({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "MCP server timed out" } });
      }, timeoutMs);
      this.waiting.set(msg.id!, (m) => (clearTimeout(t), resolve(m)));
    });
  }

  close(): void {
    this.child?.kill();
  }
}

class HttpConnection extends McpConnection {
  private session: string | null = null;
  constructor(
    name: string,
    private readonly spec: { url: string; headers?: Record<string, string> },
    log: (...a: unknown[]) => void,
  ) {
    super(name, log);
  }

  protected async rpc(msg: Rpc, timeoutMs: number): Promise<Rpc | null> {
    const res = await fetch(this.spec.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(this.session ? { "mcp-session-id": this.session } : {}), ...this.spec.headers },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(timeoutMs),
    });
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    if (res.status === 202 || msg.id === undefined) return null;
    if (res.status === 404 && this.session) {
      this.session = null;
      this.reset();
    }
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (type.includes("event-stream")) {
      for (const block of text.split(/\n\n/)) {
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        const m = JSON.parse(data) as Rpc;
        if (m.id === msg.id) return m;
      }
      return null;
    }
    return JSON.parse(text) as Rpc;
  }

  close(): void {}
}

/** All local MCP servers of this device, flattened into capabilities. */
export class McpCapabilities {
  private readonly conns = new Map<string, McpConnection>();
  private cache: { at: number; caps: CapabilitySpec[] } | null = null;

  constructor(
    private readonly servers: Record<string, McpServerSpec>,
    private readonly log: (...a: unknown[]) => void,
  ) {
    for (const [name, spec] of Object.entries(servers)) this.conns.set(name, "url" in spec ? new HttpConnection(name, spec, log) : new StdioConnection(name, spec, log));
  }

  async capabilities(): Promise<CapabilitySpec[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.caps;
    const caps: CapabilitySpec[] = [];
    for (const [server, conn] of this.conns) {
      try {
        const r = await conn.request("tools/list", {}, 60_000);
        for (const t of (r?.tools ?? []) as { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } }[]) {
          const confirm = this.servers[server].confirm?.includes(t.name) === true;
          const readOnly = t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true && !confirm;
          caps.push({ name: `${server}.${t.name}`, description: t.description ?? t.name, input_schema: t.inputSchema ?? { type: "object", properties: {} },
            risk: readOnly ? "none" : "structure", ...(confirm ? { confirm: true } : {}) });
        }
      } catch (e) {
        this.log(`[mcp ${server}] tools/list failed:`, e instanceof Error ? e.message : e);
      }
    }
    this.cache = { at: Date.now(), caps };
    return caps;
  }

  async call(capability: string, args: Record<string, unknown>): Promise<CallResult> {
    const dot = capability.indexOf(".");
    const conn = dot > 0 ? this.conns.get(capability.slice(0, dot)) : undefined;
    if (!conn) return { ok: false, content: [{ type: "text", text: `unknown capability ${capability}` }], error: "unknown_capability" };
    try {
      const r = await conn.request("tools/call", { name: capability.slice(dot + 1), arguments: args });
      const content = ((r?.content ?? []) as ContentBlock[]).filter((c) => c.type === "text" || c.type === "image");
      return { ok: r?.isError !== true, content: content.length ? content : [{ type: "text", text: JSON.stringify(r?.structuredContent ?? r ?? null) }], ...(r?.structuredContent !== undefined ? { data: r.structuredContent } : {}) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: [{ type: "text", text: msg }], error: msg };
    }
  }

  close(): void {
    for (const c of this.conns.values()) c.close();
  }
}
