import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One measured model call, in the shape ash's cost member records. */
export interface EgressUsage {
  at: number; ms: number; scope: string; provider: string; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number; ok: boolean;
}
export interface EgressFailure { at: number; status: number; message: string; scope: string; sessionId?: string }

export interface EgressOptions {
  /** The real key, read from the vault on every call so saving a new key needs no restart. */
  key: () => string | null;
  upstream?: string;
  log?: (...args: unknown[]) => void;
}

// A model request may carry its images inline (the runtime's fallback when file upload fails: up to 20 MiB of images,
// a third more as base64) on top of a long conversation; file uploads are multipart and smaller than that.
const MAX_BODY = 64 * 1024 * 1024;
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "x-api-key", "authorization", "accept-encoding", "proxy-authorization"]);
const RESPONSE_DROP = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Read usage from an Anthropic-style response, streamed (SSE) or whole. */
export class UsageMeter {
  input = 0; output = 0; cacheRead = 0; cacheWrite = 0; model = ""; error = "";
  private pending = "";
  private take(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    if (usage.input_tokens !== undefined) this.input = count(usage.input_tokens);
    if (usage.output_tokens !== undefined) this.output = count(usage.output_tokens);
    if (usage.cache_read_input_tokens !== undefined) this.cacheRead = count(usage.cache_read_input_tokens);
    if (usage.cache_creation_input_tokens !== undefined) this.cacheWrite = count(usage.cache_creation_input_tokens);
  }
  json(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const data = value as Record<string, unknown>;
    if (data.type === "message_start" && data.message && typeof data.message === "object") {
      const message = data.message as Record<string, unknown>;
      if (typeof message.model === "string") this.model = message.model;
      this.take(message.usage as Record<string, unknown> | undefined);
    } else if (data.type === "message_delta") this.take(data.usage as Record<string, unknown> | undefined);
    else if (data.type === "error" && data.error && typeof data.error === "object") this.error = String((data.error as { message?: unknown }).message ?? "error").slice(0, 200);
    else if (data.type === "message") { if (typeof data.model === "string") this.model = data.model; this.take(data.usage as Record<string, unknown> | undefined); }
  }
  sse(chunk: string): void {
    this.pending += chunk;
    let index: number;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, index).trim();
      this.pending = this.pending.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      try { this.json(JSON.parse(line.slice(5).trim())); } catch { /* not JSON: [DONE] or a comment */ }
    }
    if (this.pending.length > 1_000_000) this.pending = "";
  }
}

/**
 * The model egress. The container only holds a placeholder key and an unguessable local address; ash puts the vault
 * key on each request here, forwards it to the provider, streams the answer back unchanged, and reads the usage.
 */
export class ModelEgress {
  private server: Server | null = null;
  private readonly secret = randomBytes(18).toString("base64url");
  private readonly usageListeners = new Set<(record: EgressUsage) => void>();
  private readonly failures: EgressFailure[] = [];
  private readonly sessionScopes = new Map<string, string>();
  private readonly upstream: string;
  base = "";

  constructor(private readonly options: EgressOptions) { this.upstream = (options.upstream ?? "https://api.deepseek.com").replace(/\/+$/, ""); }

  async start(): Promise<string> {
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    this.server = server;
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${this.secret}/anthropic`;
    return this.base;
  }

  onUsage(listener: (record: EgressUsage) => void): () => void { this.usageListeners.add(listener); return () => this.usageListeners.delete(listener); }

  /** DSH puts this server-issued session id on every model request; bind it to the exact Ash actor before prompting. */
  label(sessionId: string, scope: string): void {
    if (/^[^\x00-\x1f\x7f]{1,256}$/.test(sessionId) && /^[A-Za-z0-9:_-]{1,128}$/.test(scope)) this.sessionScopes.set(sessionId, scope);
  }

  /** Provider failures since a moment, newest last; a turn uses this to tell the owner why it went quiet. */
  failuresSince(at: number, sessionId?: string): EgressFailure[] {
    return this.failures.filter((failure) => failure.at >= at && (sessionId === undefined || failure.sessionId === sessionId));
  }

  /** The provider's account balance for the vault key. The key never leaves this process. */
  async balance(): Promise<unknown> {
    const key = this.options.key();
    if (!key) throw new Error("no API key is configured");
    const response = await fetch(`${new URL(this.upstream).origin}/user/balance`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`the provider answered HTTP ${response.status}`);
    const body = await response.json() as { is_available?: unknown; balance_infos?: Record<string, unknown>[] };
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    return { available: body?.is_available === true, balances: infos.map((info) => ({ currency: String(info.currency ?? ""), total: String(info.total_balance ?? ""),
      granted: String(info.granted_balance ?? ""), topped_up: String(info.topped_up_balance ?? "") })) };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private fail(at: number, status: number, message: string, sessionId?: string): void {
    this.failures.push({ at, status, message: message.slice(0, 200), scope: sessionId ? this.sessionScopes.get(sessionId) ?? `session:${sessionId}` : "background",
      ...(sessionId ? { sessionId } : {}) });
    if (this.failures.length > 50) this.failures.splice(0, this.failures.length - 50);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const at = Date.now();
    const prefix = `/${this.secret}/anthropic/`;
    const url = request.url ?? "";
    if (!url.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const rawSession = request.headers["x-deepseek-harness-session-id"];
    const sessionId = typeof rawSession === "string" && /^[^\x00-\x1f\x7f]{1,256}$/.test(rawSession) ? rawSession : undefined;
    const scope = sessionId ? this.sessionScopes.get(sessionId) ?? `session:${sessionId}` : "background";
    const key = this.options.key();
    if (!key) {
      this.fail(at, 401, "no model key in the vault", sessionId);
      response.writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "no API key: the owner has not saved a DeepSeek key yet" } }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) { response.writeHead(413).end(); return; }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    let requestedModel = "";
    if (/json/i.test(String(request.headers["content-type"] ?? "")))
      try { const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown }; if (typeof parsed.model === "string") requestedModel = parsed.model; } catch { /* not JSON */ }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP.has(name.toLowerCase()) || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("x-api-key", key);
    const meter = new UsageMeter();
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    let upstream: Response;
    try {
      upstream = await fetch(`${this.upstream}/anthropic/${url.slice(prefix.length)}`, { method: request.method, headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : body, signal: controller.signal });
    } catch (error) {
      this.fail(at, 0, `network: ${(error as Error).message}`, sessionId);
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "api_error", message: "network: the provider could not be reached" } }));
      return;
    }
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => { if (!RESPONSE_DROP.has(name)) out[name] = value; });
    response.writeHead(upstream.status, out);
    const streaming = (upstream.headers.get("content-type") ?? "").includes("event-stream");
    const decoder = new TextDecoder();
    let whole = "";
    try {
      if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        response.write(chunk);
        const text = decoder.decode(chunk, { stream: true });
        if (streaming) meter.sse(text); else if (whole.length < 4_000_000) whole += text;
      }
      response.end();
    } catch (error) {
      if (!controller.signal.aborted) this.fail(at, 0, `network: ${(error as Error).message}`, sessionId);
      response.destroy();
    }
    if (!streaming && whole) { try { meter.json({ type: "message", ...JSON.parse(whole) }); } catch { /* error text */ } }
    const ok = upstream.ok && !meter.error;
    if (!upstream.ok) {
      let message = whole;
      try { message = String((JSON.parse(whole) as { error?: { message?: unknown } }).error?.message ?? whole); } catch { /* raw */ }
      this.fail(at, upstream.status, message || `HTTP ${upstream.status}`, sessionId);
    } else if (meter.error) this.fail(at, 200, meter.error, sessionId);
    if (request.method === "POST" && /messages/.test(url)) {
      const record: EgressUsage = { at, ms: Date.now() - at, scope, provider: "deepseek-official", model: meter.model || requestedModel || "unknown",
        input: meter.input, output: meter.output, cacheRead: meter.cacheRead, cacheWrite: meter.cacheWrite, ok };
      for (const listener of this.usageListeners) { try { listener(record); } catch { /* one listener cannot block another */ } }
    }
  }
}
