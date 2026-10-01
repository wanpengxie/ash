// The only production HTTP edge. The ash-api/1 test harness lives under test/legacy.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Message, SendRequestV2 } from "../../sdk/src/api";
import { SCREEN_REGISTRATION_EVENT, SCREEN_REGISTRATION_TTL_MS, SCREEN_TOKEN_HEADER } from "../../sdk/src/api";
import { WorldMembers } from "./world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "./world/router";
import { Ledger } from "./world/ledger";
import { AVATARS, ICON_SVG, UI_HTML, WEB_MANIFEST } from "./ui";

export interface EdgeTokens { api: Record<string, string>; mcp: Record<string, string> }
export interface EdgeCaller {
  member: string;
  transportPrincipal: string;
  local: boolean;
  remote: boolean;
  ownerProxy: boolean;
  transport: "api" | "web_ui" | "phone" | "agent" | "device" | "service";
  pairedDeviceId?: string;
}
export interface EdgeRequest { method: string; url: URL; headers: Record<string, string>; body: Buffer | null }
export type EdgeResponse = { status: number; headers?: Record<string, string>; body?: string | Buffer } |
  { status: number; headers?: Record<string, string>; stream: (write: (chunk: string) => void, onClose: (fn: () => void) => void, end: () => void) => void };
export interface EdgeOptions { workspaces?: Record<string, string>; /** Bounded test clock; production defaults to 60 seconds. */ waitMs?: number }

const MAX_BODY = 28 * 1024 * 1024;
const FACES = new Map(Object.entries(AVATARS).map(([key, value]) => [`/avatars/${key}.webp`, Buffer.from(value, "base64")]));
const SCREEN_HEADER = SCREEN_TOKEN_HEADER.toLowerCase();
const managed = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "PROACTIVE.md"]);
const encode = (status: number, body: unknown): EdgeResponse => ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) });
const fail = (status: number, code: string, message: string): never => { throw new EdgeError(status, code, message); };
const whole = (text: string | null | undefined, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined => {
  if (text === undefined || text === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) fail(400, "bad_request", "invalid stream cursor or limit");
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, "bad_request", "invalid stream cursor or limit");
  return n;
};
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const jsonBody = (body: Buffer | null): unknown => {
  try { return body?.length ? JSON.parse(body.toString("utf8")) : {}; }
  catch { return fail(400, "bad_json", "body must be JSON"); }
};

export class EdgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "EdgeError"; }
}

interface Registration { screen: string; principal: string; label: string; expiresAt: number }

/** The token is ephemeral proof of one authenticated screen, never a ledger identity. */
export class ScreenRegistry {
  private readonly registrations = new Map<string, Registration>();
  register(caller: EdgeCaller, labelHint?: string): { screen: string; token: string; label: string } {
    if (!caller.ownerProxy) fail(403, "forbidden", "owner screen permission required");
    const token = randomBytes(24).toString("base64url");
    const screen = `screen:${randomBytes(9).toString("base64url")}`;
    const label = typeof labelHint === "string" && labelHint.trim() ? labelHint.trim().slice(0, 80) : "Screen";
    this.registrations.set(token, { screen, principal: caller.transportPrincipal, label, expiresAt: Date.now() + SCREEN_REGISTRATION_TTL_MS });
    return { screen, token, label };
  }
  verify(caller: EdgeCaller, token: string): Registration {
    const found = this.registrations.get(token);
    if (!found || !caller.ownerProxy || found.principal !== caller.transportPrincipal || Date.now() >= found.expiresAt) fail(403, "forbidden", "valid screen registration required");
    return found!;
  }
  renew(token: string): void { const entry = this.registrations.get(token); if (entry) entry.expiresAt = Date.now() + SCREEN_REGISTRATION_TTL_MS; }
}

export class EdgeRouter {
  readonly screens = new ScreenRegistry();
  constructor(readonly ledger: Ledger, readonly world: WorldRouter, readonly members: WorldMembers, readonly tokens: EdgeTokens, readonly options: EdgeOptions = {}) {}

  localCaller(headers: Record<string, string>): EdgeCaller | null {
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "");
    const cookie = /(?:^|;\s*)ash_ui=([A-Za-z0-9_-]+)/.exec(headers.cookie ?? "");
    const token = bearer?.[1]?.trim() ?? cookie?.[1];
    if (!token) return null;
    const matched = Object.entries(this.tokens.api).find(([candidate]) => same(candidate, token));
    if (!matched) return null;
    const member = matched[1];
    const transport: EdgeCaller["transport"] = member === "device:phone" ? "phone" : member.startsWith("agent:") ? "agent" : member.startsWith("service:") ? "service" : member.startsWith("device:") ? "device" : cookie && !bearer ? "web_ui" : "api";
    return { member, transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}`, local: true, remote: false, ownerProxy: member === "person:owner" || member === "device:phone", transport };
  }

  private context(caller: EdgeCaller, req: EdgeRequest): TrustedRouteContext {
    const proof = req.headers[SCREEN_HEADER];
    if (proof) {
      const screen = this.screens.verify(caller, proof);
      if (caller.member !== "person:owner") fail(403, "forbidden", "screen can only proxy owner");
      return { ...caller, member: "person:owner", transport: "web_ui", screenId: screen.screen, screenLabel: screen.label };
    }
    if (caller.transport === "web_ui") fail(403, "forbidden", "screen registration required");
    return caller;
  }

  async handle(req: EdgeRequest, caller: EdgeCaller | null): Promise<EdgeResponse> {
    try {
      const path = req.url.pathname;
      if (req.method === "GET" && path === "/manifest.webmanifest") return { status: 200, headers: { "content-type": "application/manifest+json" }, body: WEB_MANIFEST };
      if (req.method === "GET" && path === "/icon.svg") return { status: 200, headers: { "content-type": "image/svg+xml" }, body: ICON_SVG };
      if (req.method === "GET" && FACES.has(path)) return { status: 200, headers: { "content-type": "image/webp" }, body: FACES.get(path) };
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        const token = req.url.searchParams.get("token");
        if (token) {
          if (caller?.remote || !Object.entries(this.tokens.api).some(([key, member]) => member === "person:owner" && same(key, token))) fail(401, "unauthorized", "invalid local UI token");
          return { status: 303, headers: { location: "./", "set-cookie": `ash_ui=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, "cache-control": "no-store" } };
        }
        if (!caller?.ownerProxy) fail(401, "unauthorized", "owner authentication required");
        return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:" }, body: UI_HTML };
      }
      if (path.startsWith("/mcp/")) return await this.mcp(req, caller);
      if (!caller) fail(401, "unauthorized", "missing or invalid token");
      switch (`${req.method} ${path}`) {
      case "POST /api/send": {
        const parsed = jsonBody(req.body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(400, "bad_request", "send body must be an object");
        const body = parsed as SendRequestV2;
        if (body.kind === "request" && body.wait !== undefined && typeof body.wait !== "boolean") fail(400, "bad_request", "wait must be boolean");
        const context = this.context(caller!, req);
        const sent = await this.world.send(context, { ...body, ...(body.kind === "request" ? { wait: false } : {}) });
        if (body.kind === "request" && body.wait === true) {
          const reply = await this.waitFor(sent.id, Math.min(60_000, this.options.waitMs ?? 60_000));
          return encode(200, { ...sent, ...(reply ? { reply } : {}) });
        }
        if (body.word === "visible" && req.headers[SCREEN_HEADER]) this.screens.renew(req.headers[SCREEN_HEADER]);
        return encode(200, sent);
      }
      case "GET /api/describe": {
        const audience = caller!.member.startsWith("agent:") ? "agent" : caller!.ownerProxy ? "owner" : fail(403, "forbidden", "describe not allowed");
        const member = req.url.searchParams.get("member");
        return encode(200, member === null ? this.members.describe(audience) : this.members.describe(audience, member));
      }
      case "GET /api/stream": return this.stream(req, caller!);
      }
      const file = /^\/api\/workspaces\/([a-z0-9_-]+)\/files$/.exec(path);
      if (file && (req.method === "GET" || req.method === "PUT")) return this.file(file[1], req, caller!);
      return encode(404, { error: "not_found", message: "route not found" });
    } catch (error) {
      if (error instanceof EdgeError) return encode(error.status, { error: error.code, message: error.message });
      if (error instanceof RouterError) return encode(error.code === "not_found" ? 404 : error.code === "forbidden" || error.code === "denied" ? 403 : 400, { error: error.code, message: error.message });
      return encode(500, { error: "internal", message: "request failed" });
    }
  }

  private waitFor(id: string, ms: number): Promise<Message | null> {
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (message: Message | null) => { if (done) return; done = true; clearTimeout(timer); stop(); resolve(message); };
      const stop = this.world.subscribe((message) => { if (message.kind === "response" && message.reply_to === id) finish(message); });
      timer = setTimeout(() => finish(null), ms);
      const existing = this.ledger.responseTo(id);
      if (existing) finish(existing);
    });
  }

  private stream(req: EdgeRequest, caller: EdgeCaller): EdgeResponse {
    if (!caller.ownerProxy) fail(403, "forbidden", "ledger stream requires owner authority");
    const params = req.url.searchParams;
    const afterQuery = whole(params.get("after"), 0);
    const afterHeader = whole(req.headers["last-event-id"], 0);
    const before = whole(params.get("before"), 1);
    const limit = whole(params.get("limit"), 1, 1000) ?? 200;
    const followRaw = params.get("follow");
    if (followRaw !== null && followRaw !== "true" && followRaw !== "false") fail(400, "bad_request", "invalid follow flag");
    const follow = followRaw !== "false";
    if (afterQuery !== undefined && afterHeader !== undefined && afterQuery !== afterHeader) fail(400, "bad_request", "cursor conflict");
    if (before !== undefined && (afterQuery !== undefined || afterHeader !== undefined || follow)) fail(400, "bad_request", "before requires finite standalone pagination");
    const after = afterQuery ?? afterHeader;
    const registered = this.screens.register(caller, params.get("label") ?? undefined);
    return { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" }, stream: (write, onClose, end) => {
      write(`event: ${SCREEN_REGISTRATION_EVENT}\ndata: ${JSON.stringify(registered)}\n\n`);
      const send = (message: Message) => write(`id: ${message.seq}\ndata: ${JSON.stringify(message)}\n\n`);
      if (!follow) {
        const page = before !== undefined ? this.ledger.list({ before, limit }) : after !== undefined ? this.ledger.list({ after, limit }) : this.ledger.list({ before: this.ledger.lastSeq() + 1, limit });
        for (const message of page) send(message);
        end();
        return;
      }
      const start = after ?? (this.ledger.list({ before: this.ledger.lastSeq() + 1, limit }).at(0)?.seq ?? 1) - 1;
      const stop = this.world.subscribeFrom(start, send);
      const beat = setInterval(() => write(": keepalive\n\n"), 25_000);
      onClose(() => { clearInterval(beat); stop(); });
    } };
  }

  private file(workspace: string, req: EdgeRequest, caller: EdgeCaller): EdgeResponse {
    if (!caller.ownerProxy) fail(403, "forbidden", "workspace read requires owner authority");
    if (req.method === "PUT" && (!caller.local || caller.remote || caller.member !== "person:owner")) fail(403, "forbidden", "file write requires local owner");
    const root = this.options.workspaces?.[workspace];
    if (!root) fail(404, "not_found", "workspace not found");
    const realRoot = realpathSync(root!) as string;
    const rel = req.url.searchParams.get("path") ?? "";
    if (rel.startsWith("/") || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((part) => part === "." || part === "..") || rel.includes("//")) fail(400, "bad_path", "invalid workspace path");
    const parts = rel.split("/").filter(Boolean);
    const homeRoot = this.options.workspaces?.home && existsSync(this.options.workspaces.home) ? realpathSync(this.options.workspaces.home) : null;
    const dated = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$/;
    let current = realRoot;
    for (const part of parts) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(403, "forbidden", "symlink path forbidden");
    }
    const full = resolve(realRoot, ...parts);
    if (full !== realRoot && !full.startsWith(realRoot + sep)) fail(400, "bad_path", "path escapes workspace");
    const homeRelative = homeRoot ? relative(homeRoot, full) : null;
    const withinHome = homeRelative !== null && homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) && !homeRelative.startsWith(sep);
    const homeParts = withinHome ? homeRelative!.split(sep) : [];
    if (req.method === "PUT" && (!parts.length || managed.has(rel) || parts.includes(".ash") || parts.includes("versions") || parts.includes("staging") ||
      (withinHome && (managed.has(homeRelative!) || homeParts.includes(".ash") || homeParts.includes("versions") || homeParts.includes("staging") ||
        (homeParts.length === 2 && homeParts[0] === "memory" && dated.test(homeParts[1])))))) fail(403, "forbidden", "managed path requires its member");
    if (req.method === "GET") {
      if (!existsSync(full)) fail(404, "not_found", "file not found");
      const real = realpathSync(full);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) fail(403, "forbidden", "path escapes workspace");
      const stat = statSync(real);
      if (stat.isDirectory()) return encode(200, readdirSync(real, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink()).map((entry) => {
        const path = join(real, entry.name); const s = lstatSync(path); return { path: join(rel, entry.name), size: s.size, mtime: s.mtimeMs, dir: entry.isDirectory() };
      }));
      if (stat.size > MAX_BODY) fail(413, "too_large", "file too large");
      return { status: 200, headers: { "content-type": MIME[extname(real).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" }, body: readFileSync(real) };
    }
    if (req.body && req.body.length > MAX_BODY) fail(413, "too_large", "file too large");
    const parent = resolve(full, "..");
    if (parts.length > 1) mkdirSync(parent, { recursive: true });
    if (realpathSync(parent) !== parent) fail(403, "forbidden", "directory alias forbidden");
    // Hard links have no pathname provenance; reject existing multi-link inodes.
    // Atomic replacement also prevents a late alias swap from truncating its target.
    if (existsSync(full) && statSync(full).nlink > 1) fail(403, "forbidden", "hard-linked file cannot be replaced");
    const temporary = join(parent, `.ash-put-${randomBytes(12).toString("hex")}`);
    try {
      const fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try {
        for (let offset = 0; req.body && offset < req.body.length;) offset += writeSync(fd, req.body, offset);
      } finally { closeSync(fd); }
      renameSync(temporary, full);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return encode(200, { ok: true, size: req.body?.length ?? 0 });
  }

  private async mcp(req: EdgeRequest, caller: EdgeCaller | null): Promise<EdgeResponse> {
    const match = /^\/mcp\/(agent:[A-Za-z0-9_-]+)$/.exec(req.url.pathname);
    if (!match || req.method !== "POST") return encode(404, { error: "not_found", message: "route not found" });
    const agent = match[1];
    const token = req.headers["x-ash-token"] ?? "";
    if (!caller?.local || !this.tokens.mcp[agent] || !same(token, this.tokens.mcp[agent])) fail(401, "unauthorized", "invalid MCP token");
    const value = jsonBody(req.body);
    const one = async (raw: unknown): Promise<unknown | null> => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
      const msg = raw as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      if (msg.id === undefined || msg.id === null) return null;
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
      const error = (message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message } });
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ash", version: "2" } });
      if (msg.method === "ping") return reply({});
      if (msg.method === "tools/list") return reply({ tools: [
        { name: "ash_describe", description: "Discover members and their available words.", inputSchema: { type: "object", properties: { member: { type: "string" } }, additionalProperties: false } },
        { name: "ash_send", description: "Send one message through the validated world router.", inputSchema: { type: "object", properties: { to: { type: ["string", "null"] }, kind: { type: "string" }, word: { type: "string" }, body: { type: "object" }, reply_to: { type: "string" }, wait: { type: "boolean" }, client_id: { type: "string" } }, required: ["to", "kind", "word", "body"], additionalProperties: false } },
      ] });
      if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const args = msg.params?.arguments as Record<string, unknown> | undefined;
        try {
          const result = name === "ash_describe" ? (typeof args?.member === "string" ? this.members.describe("agent", args.member) : this.members.describe("agent"))
            : name === "ash_send" ? await this.world.send({ transport: "agent", transportPrincipal: `mcp:${agent}`, member: agent, local: true, remote: false, ownerProxy: false }, args as unknown as SendRequestV2)
              : fail(404, "not_found", "unknown MCP tool");
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        } catch (e) { return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : "tool failed" }], isError: true }); }
      }
      return error("unknown method");
    };
    const result = Array.isArray(value) ? (await Promise.all(value.map(one))).filter((item) => item !== null) : await one(value);
    return result === null || Array.isArray(result) && !result.length ? { status: 202 } : encode(200, result);
  }
}

const MIME: Record<string, string> = { ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".html": "text/plain; charset=utf-8" };

export function startEdgeServer(router: EdgeRouter, host: string, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    let body: Buffer | null = null;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new EdgeError(413, "too_large", "body too large"); chunks.push(chunk); }
      body = chunks.length ? Buffer.concat(chunks) : null;
    } catch { res.writeHead(413).end(); return; }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key.toLowerCase()] = value;
    const local = router.localCaller(headers);
    const mcpLocal: EdgeCaller | null = !local && req.url?.startsWith("/mcp/")
      ? { member: "agent:transport", transportPrincipal: "local-mcp-transport", local: true, remote: false, ownerProxy: false, transport: "agent" } : null;
    const result = await router.handle({ method: req.method ?? "GET", url: new URL(req.url ?? "/", "http://ash"), headers, body }, local ?? mcpLocal);
    res.writeHead(result.status, result.headers ?? {});
    if ("stream" in result) result.stream((chunk) => res.write(chunk), (close) => { if (res.destroyed || res.writableEnded) close(); else res.once("close", close); }, () => res.end());
    else res.end(result.body);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
