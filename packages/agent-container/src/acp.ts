import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** One ACP `session/update` payload as the agent sends it. Only the fields ash reads are typed. */
export interface AcpUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: { type?: string; text?: string } | { type: "content"; content?: { type?: string; text?: string } }[];
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  used?: number;
  size?: number;
  [key: string]: unknown;
}

export class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = "AcpError"; }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };
const MAX_LINE = 64 * 1024 * 1024;

/**
 * A JSON-RPC client over one agent process's stdio (ndjson, the ACP stdio transport). It speaks standard ACP plus the
 * `_ash/*` extension methods. Permission prompts for the agent's own tools are answered "allow once": everything the
 * agent does inside its container is allowed; what reaches the owner's world goes through ash's own tools instead.
 */
export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly updates = new Set<(sessionId: string, update: AcpUpdate) => void>();
  private readonly exits = new Set<(reason: string) => void>();
  private buffer = "";
  private exited: string | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly log: (...args: unknown[]) => void = () => {}) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { for (const line of chunk.split("\n")) if (line.trim()) this.log("[agent]", line.slice(0, 500)); });
    child.stdin.on("error", () => { /* a dead process is reported by exit */ });
    child.on("exit", (code, signal) => this.fail(`agent process exited (${signal ?? code})`));
    child.on("error", (error) => this.fail(`agent process failed: ${error.message}`));
  }

  get alive(): boolean { return this.exited === null; }
  get exitReason(): string | null { return this.exited; }

  onUpdate(listener: (sessionId: string, update: AcpUpdate) => void): () => void { this.updates.add(listener); return () => this.updates.delete(listener); }
  onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }

  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.exited) return Promise.reject(new AcpError(-32000, this.exited));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { this.write({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } }); };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { method, resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); } });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void { if (!this.exited) this.write({ jsonrpc: "2.0", method, params }); }

  close(): void {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { try { this.child.kill("SIGKILL"); } catch { /* gone */ } }, 3_000);
    timer.unref();
    try { this.child.kill("SIGTERM"); } catch { /* gone */ }
  }

  private write(message: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { this.fail(`agent stdin failed: ${(error as Error).message}`); }
  }

  private fail(reason: string): void {
    if (this.exited) return;
    this.exited = reason;
    for (const [, pending] of this.pending) pending.reject(new AcpError(-32000, reason));
    this.pending.clear();
    for (const listener of this.exits) { try { listener(reason); } catch { /* one listener cannot block another */ } }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) { this.fail("agent sent an oversized line"); this.close(); return; }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { this.log("[agent] non-JSON stdout", line.slice(0, 200)); continue; }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof message.method !== "string") {
      const pending = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!pending) return;
      this.pending.delete(id as number);
      const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (error) {
        const detail = error.data === undefined ? "" : `: ${(typeof error.data === "string" ? error.data : JSON.stringify(error.data)).slice(0, 300)}`;
        pending.reject(new AcpError(Number(error.code ?? -32603), `${String(error.message ?? `${pending.method} failed`)}${detail}`, error.data));
      }
      else pending.resolve(message.result);
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "session/update") {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const update = params.update as AcpUpdate | undefined;
      if (!update || typeof update.sessionUpdate !== "string") return;
      for (const listener of this.updates) { try { listener(sessionId, update); } catch { /* a broken listener cannot stop the stream */ } }
      return;
    }
    if (id === undefined) return; // other notifications are not used
    if (message.method === "session/request_permission") {
      const options = Array.isArray(params.options) ? params.options as { optionId?: string; kind?: string }[] : [];
      const allow = options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always");
      this.write(allow?.optionId ? { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } }
        : { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `${message.method} is not offered by ash` } });
  }
}
