// The only production HTTP edge.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Message, MessageSummaryV2, ResponseBody, ScreenRegistration, SendRequestV2, StreamPageEndV2, WordSpec } from "../../sdk/src/api";
import { AUTH_SCOPE_EVENT, MESSAGE_SUMMARY_EVENT, POST_DELIVERY_SNAPSHOT_EVENT, SCREEN_REGISTRATION_EVENT, SCREEN_REGISTRATION_TTL_MS, SCREEN_TOKEN_HEADER, STREAM_ERROR_EVENT, STREAM_PAGE_END_EVENT, STREAM_RAW_PAGE_BYTES, STREAM_SUMMARY_PAGE_BYTES } from "../../sdk/src/api";
import { wordContract } from "../../sdk/src/words";
import { WorldMembers } from "./world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "./world/router";
import { Ledger } from "./world/ledger";
import type { PostJournal } from "./world/post-journal";
import { AVATARS, ICON_SVG, UI_HTML, WEB_MANIFEST } from "./ui";
import { authScope } from "./auth-scope";
import { activityDetail, activityAction } from "../../sdk/src/activity";
import { appsRoute } from "./apps/http";
import type { AppRuntime } from "./apps/runtime";

export interface EdgeTokens { api: Record<string, string>; mcp: Record<string, string> }
export interface EdgeCaller {
  member: string;
  transportPrincipal: string;
  local: boolean;
  remote: boolean;
  ownerProxy: boolean;
  transport: "api" | "web_ui" | "phone" | "agent" | "device" | "service" | "app";
  pairedDeviceId?: string;
  nativeUi?: boolean;
}
export interface EdgeRequest { method: string; url: URL; headers: Record<string, string>; body: Buffer | null }
export type EdgeResponse = { status: number; headers?: Record<string, string>; body?: string | Buffer } |
  { status: number; headers?: Record<string, string>; stream: (write: (chunk: string) => void, onClose: (fn: () => void) => void, end: () => void) => void };
export interface EdgeOptions { authScopeKey: Buffer; /** The devices page's view of the pairing code; the code reaches the local owner's screen only through this route. */ pairing?: () => { revision: string; code: unknown }; /** Where the owner saves and removes credentials; values never take the message route. */ vault?: { save(ref: string, value: string): Promise<void>; remove(ref: string): Promise<boolean>; store: { list(): unknown[]; availability?(): { available: boolean } } }; workspaces?: Record<string, string>; /** Bounded test wait; production defaults to 60 seconds. */ waitMs?: number; /** Test-only clock for presence. */ clock?: () => number; /** Test-only screen ACK deadline. */ screenAckMs?: number; /** Test-only live stream sweep interval. */ streamBeatMs?: number }

// Native proof is injected by Android's fixed transport, not supplied by a web page.
export interface EdgeOptions { nativeUiToken?: string }
export interface EdgeOptions { fileWorkspaces?: () => Record<string, { root: string; directory: string }> }

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

interface Registration { screen: string; principal: string; label: string; expiresAt: number; connections: number; visibleAt: number | null }
const OPEN_ACK_WAIT_MS = 30_000;
const VISIBLE_WINDOW_MS = 60_000;
const screenRegistries = new WeakMap<WorldRouter, { registry: ScreenRegistry; word: WordSpec }>();

/** The token is ephemeral proof of one authenticated screen, never a ledger identity. */
export class ScreenRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly pending = new Map<string, Set<() => void>>();
  constructor(private readonly world: WorldRouter, private readonly now: () => number = Date.now, private readonly ackMs = OPEN_ACK_WAIT_MS) {}
  private sweep(): void {
    const at = this.now();
    for (const [token, entry] of this.registrations) {
      if (at >= entry.expiresAt && entry.connections === 0 && !this.pending.get(entry.screen)?.size) this.registrations.delete(token);
    }
  }
  register(caller: EdgeCaller, auth_scope: string, labelHint?: string): ScreenRegistration {
    if (!caller.ownerProxy || caller.member !== "person:owner") fail(403, "forbidden", "owner screen permission required");
    this.sweep();
    const token = randomBytes(24).toString("base64url");
    const screen = `screen:${randomBytes(9).toString("base64url")}`;
    const label = typeof labelHint === "string" && labelHint.trim() ? labelHint.trim().slice(0, 80) : "Screen";
    this.registrations.set(token, { screen, principal: caller.transportPrincipal, label, expiresAt: this.now() + SCREEN_REGISTRATION_TTL_MS, connections: 0, visibleAt: null });
    return { screen, token, label, auth_scope,
      local_management: caller.member === "person:owner" && caller.ownerProxy && caller.local && !caller.remote };
  }
  verify(caller: EdgeCaller, token: string): Registration {
    this.sweep();
    const found = this.registrations.get(token);
    if (!found || !caller.ownerProxy || caller.member !== "person:owner" || found.principal !== caller.transportPrincipal || this.now() >= found.expiresAt) fail(403, "forbidden", "valid screen registration required");
    return found!;
  }
  valid(token: string): boolean { return Boolean(this.registrations.get(token) && this.now() < this.registrations.get(token)!.expiresAt); }
  renew(token: string): void { const entry = this.registrations.get(token); if (entry) { entry.expiresAt = this.now() + SCREEN_REGISTRATION_TTL_MS; entry.visibleAt = this.now(); } }
  markVisible(screen: string): void { const entry = this.find(screen); if (entry && entry.connections > 0) entry.visibleAt = this.now(); }
  markHidden(screen: string): void { const entry = this.find(screen); if (entry) entry.visibleAt = null; }
  connect(token: string): void { const entry = this.registrations.get(token); if (entry) entry.connections++; }
  disconnect(token: string): void {
    const entry = this.registrations.get(token);
    if (!entry) return;
    entry.connections = Math.max(0, entry.connections - 1);
    if (entry.connections === 0) for (const settle of [...(this.pending.get(entry.screen) ?? [])]) settle();
    this.sweep();
  }
  private find(screen: string): Registration | undefined { this.sweep(); return [...this.registrations.values()].find((entry) => entry.screen === screen && this.now() < entry.expiresAt); }
  /** A durable request's screen ID is not proof after acceptance; recheck the live binding at effect time. */
  currentBinding(screen: string, principal: string): boolean { return Boolean(principal && this.find(screen)?.principal === principal); }
  online(screen: string): boolean { return (this.find(screen)?.connections ?? 0) > 0; }
  visible(screen: string): boolean { const entry = this.find(screen); return Boolean(entry && entry.connections > 0 && entry.visibleAt !== null && this.now() - entry.visibleAt <= VISIBLE_WINDOW_MS); }
  list(): { id: string; name: string; online: boolean }[] {
    this.sweep();
    return [...this.registrations.values()].filter((entry) => this.now() < entry.expiresAt)
      .map((entry) => ({ id: entry.screen, name: entry.label, online: entry.connections > 0 }));
  }
  readonly directory = () => this.list();
  async open(message: Message, signal: AbortSignal): Promise<ResponseBody> {
    if (!this.online(message.to ?? "")) return { ok: true, result: { opened: false } };
    // The stream only delivers the command. A matching authenticated tab must ACK it;
    // a missing ACK resolves false before the router's general timeout.
    return new Promise((resolve) => {
      const screen = message.to!;
      const falseBody: ResponseBody = { ok: true, result: { opened: false } };
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let stop = () => {};
      const finish = (body: ResponseBody) => {
        if (done) return;
        done = true; clearTimeout(timer); stop(); signal.removeEventListener("abort", cancelled);
        const bucket = this.pending.get(screen); bucket?.delete(disconnected); if (bucket?.size === 0) this.pending.delete(screen);
        this.sweep();
        resolve(body);
      };
      const disconnected = () => finish(falseBody);
      const cancelled = () => finish({ ok: false, error: { code: "cancelled", message: "screen request cancelled" } });
      let bucket = this.pending.get(screen);
      if (!bucket) { bucket = new Set(); this.pending.set(screen, bucket); }
      bucket.add(disconnected);
      stop = this.world.subscribe((reply) => { if (reply.kind === "response" && reply.reply_to === message.id) finish(reply.body as ResponseBody); });
      timer = setTimeout(disconnected, this.ackMs);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else if (!this.online(screen)) disconnected();
    });
  }
}

export class EdgeRouter {
  readonly screens: ScreenRegistry;
  private postJournal: PostJournal | null = null;
  private apps: AppRuntime | null = null;
  constructor(readonly ledger: Ledger, readonly world: WorldRouter, readonly members: WorldMembers, readonly tokens: EdgeTokens, readonly options: EdgeOptions) {
    if (options.authScopeKey.length !== 32) throw new Error("screen auth scope key required");
    let installed = screenRegistries.get(world);
    if (!installed) {
      const screens = new ScreenRegistry(world, options.clock ?? Date.now, options.screenAckMs ?? OPEN_ACK_WAIT_MS);
      const spec = wordContract("screen:registered", "ui.open");
      if (!spec) throw new Error("screen ui.open contract unavailable");
      const [validated] = world.registerBatch([{ member: "screen:*", spec, handle: (message, context) => screens!.open(message, context.signal) }]);
      installed = { registry: screens, word: validated as WordSpec };
      screenRegistries.set(world, installed);
    }
    this.screens = installed.registry;
    members.setScreenDirectory(installed.registry.directory, installed.word);
  }

  /** The app runtime behind the shell app's owner routes (/api/apps…). */
  attachApps(runtime: AppRuntime): void { this.apps = runtime; }

  /** Attached once during owner assembly, before the HTTP edge becomes visible. */
  attachPostJournal(journal: PostJournal): void {
    if (this.postJournal) throw new Error("post journal already attached");
    this.postJournal = journal;
  }

  localCaller(headers: Record<string, string>): EdgeCaller | null {
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "");
    const cookie = /(?:^|;\s*)ash_ui=([A-Za-z0-9_-]+)/.exec(headers.cookie ?? "");
    const token = bearer?.[1]?.trim() ?? cookie?.[1];
    if (!token) return null;
    const matched = Object.entries(this.tokens.api).find(([candidate]) => same(candidate, token));
    if (!matched) return null;
    const member = matched[1];
    const transport: EdgeCaller["transport"] = member === "device:phone" ? "phone" : member.startsWith("agent:") ? "agent" : member.startsWith("service:") ? "service" : member.startsWith("device:") ? "device" : cookie && !bearer ? "web_ui" : "api";
    const nativeUi = member === "person:owner" && this.options.nativeUiToken !== undefined && same(headers["x-ash-native-ui"] ?? "", this.options.nativeUiToken);
    return { member, transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}`, local: true, remote: false, ownerProxy: member === "person:owner" || member === "device:phone", transport, ...(nativeUi ? { nativeUi: true } : {}) };
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
        return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; form-action 'self'" }, body: UI_HTML };
      }
      if (path.startsWith("/mcp/")) return await this.mcp(req, caller);
      if (!caller) fail(401, "unauthorized", "missing or invalid token");
      // The shell app's routes, owner only; see apps/http.ts for the fixed list.
      if (path === "/api/apps" || path.startsWith("/api/apps/")) {
        if (caller!.member !== "person:owner" || !caller!.ownerProxy) fail(403, "forbidden", "apps are the owner's");
        if (!this.apps) fail(404, "not_found", "apps unavailable");
        const routed = await appsRoute({ runtime: this.apps!, send: (ctx, request) => this.world.send(ctx, request), waitFor: (id, ms) => this.waitFor(id, ms),
          waitMs: Math.min(60_000, this.options.waitMs ?? 60_000) }, req.method, path, req.body, () => this.context(caller!, req));
        if (routed) return routed;
      }
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
      case "GET /api/activity/detail": {
        if (caller!.member !== "person:owner" || !caller!.ownerProxy) fail(403, "forbidden", "owner only");
        const id = req.url.searchParams.get("id") ?? "";
        const offset = Number(req.url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) fail(400, "bad_request", "invalid offset");
        const request = this.world.ledger.byId(id);
        if (!request || request.kind !== "request" || !request.from.startsWith("agent:") || !request.turn || request.to === "person:owner") fail(404, "not_found", "activity not found");
        const reply = this.world.ledger.responseTo(id);
        const action = activityAction(request!.to ?? "", request!.word, request!.body);
        let input: unknown = request!.body, result: unknown = reply?.body ?? { status: "pending", note: "尚无返回记录" };
        if (request!.to === "service:dsh-tool") {
          input = request!.body.arguments;
          try { input = JSON.parse(String(input)); if (action.wrapper) input = (input as { body?: unknown }).body ?? {}; } catch {}
          const stored = reply?.body.result as { preview?: unknown; detail?: unknown; truncated?: boolean } | undefined;
          if (reply?.body.ok === true && stored) {
            const raw = stored.detail ?? stored.preview;
            try { result = JSON.parse(String(raw)); } catch { result = raw; }
            if (stored.truncated) result = { preview: result, truncated: true, note: "保存的结果超过64,000字符，后续内容请查看工具返回的文件。" };
          }
        }
        const full = activityDetail({ tool: action.tool, member: action.member, input, result });
        const next = Math.min(full.length, offset + 16000);
        return { ...encode(200, { text: full.slice(offset, next), next_offset: next < full.length ? next : null,
          total: full.length, note: "敏感字段已隐藏；内容是已保存的执行记录，可能包含工具返回的预览或文件路径。" }), headers: { "content-type": "application/json", "cache-control": "no-store" } };
      }
      }
      if (path === "/api/workspaces" && req.method === "GET") {
        if (!caller!.ownerProxy) fail(403, "forbidden", "workspace read requires owner authority");
        return encode(200, Object.entries(this.fileRoots()).map(([id, value]) => ({ id, directory: value.directory })));
      }
      // A directory-shaped URL preserves normal relative HTML/CSS/image references. It is read-only,
      // sandboxed and has no script/bridge authority; the ordinary files route remains the byte API.
      const content = /^\/api\/workspaces\/([a-z0-9_-]+)\/content\/(.+)$/.exec(path);
      if (content && req.method === "GET") {
        let rel: string;
        try { rel = decodeURIComponent(content[2]!); } catch { return encode(400, { error: "bad_path" }); }
        const url = new URL(req.url); url.search = ""; url.searchParams.set("path", rel);
        const result = this.file(content[1]!, { ...req, url }, caller!);
        return { ...result, headers: { ...result.headers,
          "content-type": FILE_MIME[extname(rel).toLowerCase()] ?? "application/octet-stream",
          "content-security-policy": FILE_VIEW_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } };
      }
      if (path === "/api/devices/pairing" && req.method === "GET") {
        // Like a credential, the pairing code never takes the message route: only the local owner's own screen reads it.
        if (!caller!.ownerProxy || !caller!.local || caller!.remote || caller!.member !== "person:owner") fail(403, "forbidden", "the pairing code is shown on the local owner screen only");
        if (!this.options.pairing) fail(404, "not_found", "device pairing unavailable");
        return encode(200, this.options.pairing!());
      }
      const secret = /^\/api\/vault(?:\/([A-Za-z_][A-Za-z0-9_]{0,63}))?$/.exec(path);
      if (secret && this.options.vault) return await this.vault(secret[1], req, caller!);
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
    const summaryRaw = params.get("summary");
    if (summaryRaw !== null && summaryRaw !== "true" && summaryRaw !== "false") fail(400, "bad_request", "invalid summary flag");
    const summary = summaryRaw === "true";
    if (afterQuery !== undefined && afterHeader !== undefined && afterQuery !== afterHeader) fail(400, "bad_request", "cursor conflict");
    if (before !== undefined && (afterQuery !== undefined || afterHeader !== undefined || follow)) fail(400, "bad_request", "before requires finite standalone pagination");
    const after = afterQuery ?? afterHeader;
    const scope = authScope(this.options.authScopeKey, caller.transportPrincipal);
    const query = before !== undefined ? { before, limit } : after !== undefined ? { after, limit } : { before: Number.MAX_SAFE_INTEGER, limit };
    // Page preparation is synchronous and bounded, so a raw overflow is HTTP 413
    // before headers rather than a partial successful event stream.
    let initial: { page: (Message | MessageSummaryV2)[]; snapshot?: ReturnType<PostJournal["pageSnapshot"]>["snapshot"]; end?: StreamPageEndV2 };
    try {
      initial = summary
        ? this.postJournal?.pageSnapshotBounded(query, () => this.ledger.summaryPage(query)) ?? this.ledger.summaryPage(query)
        : this.postJournal?.pageSnapshotBounded(query, () => this.ledger.rawPageWithEnd(query)) ?? this.ledger.rawPageWithEnd(query);
    } catch (error) {
      if (error instanceof RangeError) fail(413, "too_large", "stream page exceeds byte budget");
      throw error;
    }
    const scopeFrame = `event: ${AUTH_SCOPE_EVENT}\ndata: ${JSON.stringify({ auth_scope: scope })}\n\n`;
    const snapshotFrame = initial.snapshot ? `event: ${POST_DELIVERY_SNAPSHOT_EVENT}\ndata: ${JSON.stringify(initial.snapshot)}\n\n` : "";
    const endFrame = initial.end ? `event: ${STREAM_PAGE_END_EVENT}\ndata: ${JSON.stringify(initial.end)}\n\n` : "";
    const frame = (message: Message | MessageSummaryV2) => `id: ${message.seq}\n${"summary" in message ? `event: ${MESSAGE_SUMMARY_EVENT}\n` : ""}data: ${JSON.stringify(message)}\n\n`;
    const rowFrames = initial.page.map(frame);
    const pageBytes = Buffer.byteLength(scopeFrame) + Buffer.byteLength(snapshotFrame) + Buffer.byteLength(endFrame) + rowFrames.reduce((bytes, row) => bytes + Buffer.byteLength(row), 0);
    if (pageBytes > (summary ? STREAM_SUMMARY_PAGE_BYTES : STREAM_RAW_PAGE_BYTES)) fail(413, "too_large", "stream page control budget exceeded");
    // A finite history page is an audit read, not a live tab. It has no screen identity.
    const registered = follow ? this.screens.register(caller, scope, params.get("label") ?? undefined) : null;
    return { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" }, stream: (write, onClose, end) => {
      if (registered) {
        write(`event: ${SCREEN_REGISTRATION_EVENT}\ndata: ${JSON.stringify(registered)}\n\n`);
        this.screens.connect(registered.token);
      } else write(scopeFrame);
      const send = (message: Message | MessageSummaryV2) => {
        // Live delivery is a command only for the addressed tab. Finite history
        // pagination remains the owner's complete audit view.
        if (follow && message.word === "ui.open" && message.kind === "request" &&
          (message.to !== registered!.screen || !this.screens.online(registered!.screen))) return;
        write(frame(message));
      };
      const writeSnapshot = (snapshot: NonNullable<typeof initial.snapshot>) => {
        write(`event: ${POST_DELIVERY_SNAPSHOT_EVENT}\ndata: ${JSON.stringify(snapshot)}\n\n`);
      };
      if (!follow) {
        if (snapshotFrame) write(snapshotFrame);
        for (const row of rowFrames) write(row);
        if (endFrame) write(endFrame);
        end();
        return;
      }
      if (initial.snapshot) writeSnapshot(initial.snapshot);
      const start = after ?? (initial.page.at(0)?.seq ?? 1) - 1;
      const initialIds = new Set(initial.snapshot?.items.map((item) => item.message_id) ?? []);
      const liveSend = (message: Message) => {
        if (this.postJournal && message.kind === "request" && message.word === "say" && message.to === "person:owner" &&
          (message.body.kind === "offer" || message.body.kind === "heads_up") && !Object.hasOwn(message.body, "legacy") && !initialIds.has(message.id)) {
          const { snapshot } = this.postJournal.pageSnapshot({ after: message.seq - 1, limit: 1 });
          writeSnapshot(snapshot);
        }
        send(message);
      };
      const liveSummary = (seq: number) => {
        const one = { after: seq - 1, limit: 1 };
        const result = this.postJournal?.pageSnapshotBounded(one, () => this.ledger.summaryPage(one)) ?? this.ledger.summaryPage(one);
        const status = "snapshot" in result ? result.snapshot : undefined;
        const message = result.page[0];
        if (!message || message.seq !== seq) return;
        if (message.kind === "request" && message.word === "say" && message.to === "person:owner" &&
          (message.body_summary.kind === "offer" || message.body_summary.kind === "heads_up") && !Object.hasOwn(message.body_summary, "legacy") && !initialIds.has(message.id) && status)
          writeSnapshot(status);
        send(message);
      };
      let closed = false;
      let stop = () => {};
      let beat: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        if (closed) return;
        closed = true; if (beat) clearInterval(beat); stop(); this.screens.disconnect(registered!.token);
      };
      const streamFailure = (error: unknown) => {
        if (closed) return;
        write(`event: ${STREAM_ERROR_EVENT}\ndata: ${JSON.stringify({ code: error instanceof RangeError ? "too_large" : "failed" })}\n\n`);
        cleanup(); end();
      };
      let replaying = true;
      const guardedSummary = (seq: number) => { try { liveSummary(seq); } catch (error) { streamFailure(error); if (replaying) throw error; } };
      const guardedRaw = (message: Message) => { try { liveSend(message); } catch (error) { streamFailure(error); if (replaying) throw error; } };
      try { stop = summary ? this.world.subscribeSeqFrom(start, guardedSummary) : this.world.subscribeFrom(start, guardedRaw); }
      catch (error) { streamFailure(error); return; }
      replaying = false;
      if (closed) { stop(); return; }
      beat = setInterval(() => {
        if (!this.screens.valid(registered!.token)) { cleanup(); end(); return; }
        write(": keepalive\n\n");
      }, this.options.streamBeatMs ?? 25_000);
      onClose(cleanup);
    } };
  }

  /** The one way a credential enters ash: the local owner's own screen, over a route that never writes to the ledger. */
  private async vault(ref: string | undefined, req: EdgeRequest, caller: EdgeCaller): Promise<EdgeResponse> {
    if (!caller.ownerProxy || !caller.local || caller.remote || caller.member !== "person:owner") fail(403, "forbidden", "credentials are managed from the local owner screen only");
    const vault = this.options.vault!;
    const available = vault.store.availability?.().available !== false;
    if (!ref) {
      if (req.method !== "GET") fail(405, "method_not_allowed", "use GET to list");
      return encode(200, { entries: vault.store.list(), available });
    }
    if (!available) fail(503, "vault_unavailable", "secure credential storage is unavailable; credentials were not changed");
    if (req.method === "PUT") {
      const body = jsonBody(req.body) as { value?: unknown } | null;
      if (!body || typeof body !== "object" || typeof body.value !== "string") fail(400, "bad_request", "body must be {value}");
      try { await vault.save(ref, (body as { value: string }).value); }
      catch (error) { if (error instanceof TypeError) fail(400, "bad_request", error.message); throw error; }
      return encode(200, { ok: true });
    }
    if (req.method === "DELETE") return encode(200, { ok: true, removed: await vault.remove(ref) });
    return fail(405, "method_not_allowed", "use PUT or DELETE");
  }

  private fileRoots(): Record<string, { root: string; directory: string }> {
    return { ...Object.fromEntries(Object.entries(this.options.workspaces ?? {}).map(([id, root]) => [id, { root, directory: root }])),
      ...this.options.fileWorkspaces?.() };
  }

  private file(workspace: string, req: EdgeRequest, caller: EdgeCaller): EdgeResponse {
    if (!caller.ownerProxy) fail(403, "forbidden", "workspace read requires owner authority");
    if (req.method === "PUT" && (!caller.local || caller.remote || caller.member !== "person:owner")) fail(403, "forbidden", "file write requires local owner");
    const root = req.method === "GET" ? this.fileRoots()[workspace]?.root : this.options.workspaces?.[workspace];
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
      if (!stat.isFile() || stat.nlink !== 1) fail(403, "forbidden", "not a regular single-link file");
      if (stat.size > MAX_BODY) fail(413, "too_large", "file too large");
      return { status: 200, headers: { "content-type": MIME[extname(real).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "content-security-policy": FILE_VIEW_CSP,
        ...(req.url.searchParams.get("download") === "1" ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(parts.at(-1) ?? "file")}` } : {}) }, body: readFileSync(real) };
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
const FILE_MIME: Record<string, string> = { ...MIME, ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" };
const FILE_VIEW_CSP = "sandbox allow-same-origin; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://appassets.androidplatform.net";

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
