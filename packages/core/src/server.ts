// `ash-api/1` at the edges: one router for local HTTP (UI, Android host, plugins) and for
// requests tunneled in through the gateway (the owner's paired browsers). The caller decides
// what is allowed:
//   local owner   person:owner (UI cookie / bearer) and device:phone (the Android host)  — everything
//   remote owner  a paired device holding web_ui, via the tunnel                         — chat, log, timers,
//                 confirmations, devices; not pairing, grants or credentials
//   others        members with their own token (plugins …)                               — speak as themselves
//   agents        their MCP token, /mcp/<agent> only

import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { AshApiError, type AshEvent } from "../../sdk/src/api";
import { type Core, OWNER, PHONE } from "./core";
import { handleMcp } from "./mcp";
import { AVATARS, ICON_SVG, UI_HTML, WEB_MANIFEST } from "./ui";

export interface Tokens {
  /** API token → member id it speaks for. */
  api: Record<string, string>;
  /** agent id → its MCP token. */
  mcp: Record<string, string>;
}

export interface Caller {
  member: string;
  /** On this device (loopback token) rather than through the gateway. */
  local: boolean;
}

export interface Req {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer | null;
}

export type Res =
  | { status: number; headers?: Record<string, string>; body?: string | Buffer }
  | { status: number; headers?: Record<string, string>; stream: (write: (chunk: string) => void, onClose: (fn: () => void) => void) => void };

/** Optional surfaces other modules plug into the router. */
export interface Extensions {
  settings?: { get(): Promise<unknown>; set(body: Record<string, unknown>): Promise<unknown> };
  gateway?: { state(): Promise<unknown>; op(op: string, body: Record<string, unknown>): Promise<unknown> };
  plugins?: { list(): Promise<unknown>; op(body: Record<string, unknown>): Promise<unknown> };
  workspaces: Record<string, string>;
}

const MAX_BODY = 28 * 1024 * 1024; // 20 MB of attachments, base64

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const FACES = new Map(Object.entries(AVATARS).map(([k, v]) => [`/avatars/${k}.webp`, Buffer.from(v, "base64")]));
const json = (status: number, body: unknown): Res => ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) });

export class Router {
  constructor(
    private readonly core: Core,
    private readonly tokens: Tokens,
    private readonly ext: Extensions,
  ) {}

  memberFor(token: string): string | null {
    for (const [t, member] of Object.entries(this.tokens.api)) if (same(token, t)) return member;
    return null;
  }

  /** Caller from a loopback request: bearer token or the UI cookie. */
  localCaller(headers: Record<string, string>): Caller | null {
    const auth = headers.authorization ?? "";
    if (auth.startsWith("Bearer ")) {
      const m = this.memberFor(auth.slice(7).trim());
      return m ? { member: m, local: true } : null;
    }
    const c = /(?:^|;\s*)ash_ui=([A-Za-z0-9_-]+)/.exec(headers.cookie ?? "");
    const m = c ? this.memberFor(c[1]) : null;
    return m ? { member: m, local: true } : null;
  }

  async handle(req: Req, caller: Caller | null): Promise<Res> {
    const path = req.url.pathname;
    try {
      // ---- MCP projection for one agent (out-of-process runtimes)
      const mcp = /^\/mcp\/(agent:[A-Za-z0-9_.-]+)$/.exec(decodeURIComponent(path));
      if (mcp) {
        const agent = mcp[1];
        const t = req.headers["x-ash-token"] ?? "";
        if (!this.tokens.mcp[agent] || !same(t, this.tokens.mcp[agent]) || !caller?.local) return json(401, { error: "unauthorized" });
        if (req.method === "GET") return { status: 405, headers: { allow: "POST" } };
        if (req.method === "DELETE") return json(200, {});
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
        const [status, body] = await handleMcp(this.core, agent, parseJson(req.body));
        return status === 202 ? { status: 202 } : json(status, body);
      }

      // ---- static (anonymous: the PWA manifest and icon are fetched without cookies)
      if (req.method === "GET" && path === "/manifest.webmanifest") return { status: 200, headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" }, body: WEB_MANIFEST };
      if (req.method === "GET" && path === "/icon.svg") return { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }, body: ICON_SVG };
      if (req.method === "GET" && FACES.has(path)) return { status: 200, headers: { "content-type": "image/webp", "cache-control": "public, max-age=86400" }, body: FACES.get(path) };

      // ---- UI: /?token=… trades the token for an HttpOnly cookie (local only)
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        const t = req.url.searchParams.get("token");
        if (t && caller?.local !== false) {
          if (!this.memberFor(t)) return json(401, { error: "unauthorized" });
          return { status: 303, headers: { location: "./", "set-cookie": `ash_ui=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, "cache-control": "no-store" } };
        }
        if (!caller) return { status: 401, headers: { "content-type": "text/plain; charset=utf-8" }, body: "ash: open the URL in <stateDir>/ui-url (… /?token=…)" };
        return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:" }, body: UI_HTML };
      }

      // ---- SDK
      if (!caller) return json(401, { error: "unauthorized", message: "missing or unknown bearer token" });
      return await this.sdk(req, caller);
    } catch (e) {
      if (e instanceof AshApiError) return json(e.status, { error: e.code, message: e.message });
      this.core.log("request failed", e);
      return json(500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async sdk(req: Req, caller: Caller): Promise<Res> {
    const core = this.core;
    const me = caller.member;
    const ownerLocal = caller.local && (me === OWNER || me === PHONE);
    const owner = ownerLocal || (!caller.local && core.originOf(me).trusted);
    const need = (ok: boolean, what: string) => {
      if (!ok) throw new AshApiError(403, "forbidden", `${me} may not ${what}${caller.local ? "" : " through the gateway"}`);
    };
    const path = req.url.pathname;
    const q = (k: string) => req.url.searchParams.get(k) ?? undefined;
    const n = (k: string) => (req.url.searchParams.has(k) ? Number(req.url.searchParams.get(k)) : undefined);
    const body = () => (parseJson(req.body) ?? {}) as Record<string, unknown>;
    const route = `${req.method} ${path}`;

    switch (route) {
      case "GET /api/manifest":
        return json(200, { ...core.manifest(me), caller: { member: me, local: caller.local, owner, manage: ownerLocal } });
      case "GET /api/me":
        return json(200, core.identity(me));
      case "GET /api/members":
        return json(200, core.listMembers());
      case "GET /api/agents":
        return json(200, core.listAgents());
      case "GET /api/events":
        need(owner, "read the log");
        return json(200, core.events({ after: n("after"), before: n("before"), limit: n("limit"), workspace: q("workspace"), type: q("type"), member: q("member") }));
      case "GET /api/events/stream":
        need(owner, "follow the log");
        // EventSource reconnects with Last-Event-ID; nothing is missed across a dropped tunnel.
        return stream(core, Number(req.headers["last-event-id"] ?? q("after") ?? "0") || 0);
      case "GET /api/devices":
        return json(200, core.devicesFor(me));
      case "POST /api/call": {
        need(owner, "call devices");
        const b = body();
        return json(200, await core.call(me === PHONE ? OWNER : me, String(b.device ?? ""), String(b.capability ?? ""), (b.args as Record<string, unknown>) ?? {}));
      }
      case "GET /api/timers":
        return json(200, core.listTimers(owner ? undefined : me));
      case "POST /api/timers":
        return json(200, core.setTimer(body() as never, owner ? OWNER : me));
      case "POST /api/notify":
        return json(200, await core.notify(body() as never, me));
      case "GET /api/confirms":
        need(owner, "see confirmations");
        return json(200, core.pendingConfirms());
      case "GET /api/grants":
        need(owner, "list grants");
        return json(200, core.listGrants(q("member")));
      case "POST /api/grants": {
        need(ownerLocal, "grant permissions");
        const b = body();
        return json(200, core.addGrant(String(b.member ?? ""), String(b.scope ?? ""), OWNER));
      }
      case "GET /api/settings":
        need(ownerLocal, "read settings");
        return json(200, (await this.ext.settings?.get()) ?? {});
      case "POST /api/settings":
        need(ownerLocal, "change settings");
        return json(200, (await this.ext.settings?.set(body())) ?? {});
      case "GET /api/plugins":
        need(ownerLocal, "manage plugins");
        if (!this.ext.plugins) throw new AshApiError(409, "no_plugins", "this ash core hosts no DSH world");
        return json(200, await this.ext.plugins.list());
      case "POST /api/plugins":
        need(ownerLocal, "manage plugins");
        if (!this.ext.plugins) throw new AshApiError(409, "no_plugins", "this ash core hosts no DSH world");
        return json(200, await this.ext.plugins.op(body()));
      case "GET /api/gateway":
        need(ownerLocal, "manage the gateway");
        return json(200, (await this.ext.gateway?.state()) ?? { configured: false });
    }

    let m = /^\/api\/agents\/([^/]+)\/(deliver|cancel|inbox)$/.exec(path);
    if (m) {
      const agent = decodeURIComponent(m[1]);
      if (m[2] === "inbox" && req.method === "GET") return json(200, core.inbox(agent));
      if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (m[2] === "deliver") {
        // Everyone with a token speaks as themselves; the local owner may relay for someone else.
        const b = body();
        return json(200, core.deliver(agent, { text: String(b.text ?? ""), attachments: b.attachments as never, mode: b.mode as never, message_id: b.message_id as never, from: ownerLocal ? (b.from as string | undefined) : undefined }, ownerLocal && me === PHONE ? OWNER : me));
      }
      need(owner, "cancel turns");
      return json(200, await core.cancel(agent));
    }
    if ((m = /^\/api\/timers\/([^/]+)$/.exec(path)) && req.method === "DELETE") return json(200, core.cancelTimer(decodeURIComponent(m[1]), me, owner ? undefined : me));
    if ((m = /^\/api\/confirms\/([^/]+)$/.exec(path)) && req.method === "POST") {
      need(owner, "answer confirmations");
      return json(200, core.answerConfirm(decodeURIComponent(m[1]), body().approve === true, me));
    }
    if ((m = /^\/api\/grants\/([^/]+)$/.exec(path)) && req.method === "DELETE") {
      need(ownerLocal, "revoke grants");
      return json(200, core.revokeGrant(decodeURIComponent(m[1]), OWNER));
    }
    if ((m = /^\/api\/gateway\/([a-z_.]+)$/.exec(path)) && req.method === "POST") {
      need(ownerLocal, "manage the gateway");
      if (!this.ext.gateway) throw new AshApiError(409, "no_gateway", "this ash core has no gateway link");
      return json(200, await this.ext.gateway.op(m[1], body()));
    }
    if ((m = /^\/api\/workspaces\/([a-z0-9_-]+)\/files$/.exec(path))) {
      need(owner, "read workspaces");
      return this.files(m[1], q("path") ?? "", req, ownerLocal);
    }
    return json(404, { error: "not_found" });
  }

  private files(ws: string, rel: string, req: Req, mayWrite: boolean): Res {
    const root = this.ext.workspaces[ws];
    if (!root) throw new AshApiError(404, "unknown_workspace", `no workspace ${ws}`);
    const full = resolve(root, normalize(rel || "."));
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw new AshApiError(400, "bad_path", "path escapes the workspace");
    if (req.method === "PUT") {
      if (!mayWrite) throw new AshApiError(403, "forbidden", "only the local owner writes files");
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, req.body ?? Buffer.alloc(0));
      return json(200, { ok: true, size: req.body?.length ?? 0 });
    }
    if (!existsSync(full)) throw new AshApiError(404, "not_found", rel);
    const st = statSync(full);
    if (st.isDirectory()) {
      return json(
        200,
        readdirSync(full, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("."))
          .map((e) => {
            const s = statSync(join(full, e.name));
            return { path: join(rel, e.name), size: s.size, mtime: s.mtimeMs, dir: e.isDirectory() };
          }),
      );
    }
    if (st.size > MAX_BODY) throw new AshApiError(413, "too_large", "file is larger than 8 MB");
    return { status: 200, headers: { "content-type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" }, body: readFileSync(full) };
  }
}

const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".html": "text/plain; charset=utf-8",
};

function parseJson(b: Buffer | null): unknown {
  if (!b || !b.length) return {};
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    throw new AshApiError(400, "bad_json", "body must be JSON");
  }
}

/** Server-Sent Events: replay everything after `after`, then follow live. */
function stream(core: Core, after: number): Res {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
    stream: (write, onClose) => {
      let last = after;
      const send = (e: AshEvent) => {
        if (e.seq <= last) return;
        last = e.seq;
        write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      const pending: AshEvent[] = [];
      let replaying = true;
      const unsubscribe = core.subscribe((e) => (replaying ? pending.push(e) : send(e)));
      for (;;) {
        const page = core.events({ after: last, limit: 500 });
        for (const e of page.events) send(e);
        if (page.events.length < 500) break;
      }
      replaying = false;
      for (const e of pending) send(e);
      write(": ready\n\n");
      const beat = setInterval(() => write(": keepalive\n\n"), 25_000);
      onClose(() => {
        clearInterval(beat);
        unsubscribe();
      });
    },
  };
}

// ------------------------------------------------------------------ node:http adapter

export function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer | null> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new AshApiError(413, "body_too_large", "request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(chunks.length ? Buffer.concat(chunks) : null));
    req.on("error", fail);
  });
}

export function headerRecord(h: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k.toLowerCase()] = v;
  else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(", ");
  return out;
}

export function startServer(router: Router, host: string, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    let body: Buffer | null = null;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(413).end();
      return;
    }
    const headers = headerRecord(req.headers);
    const r = await router.handle({ method: req.method ?? "GET", url: new URL(req.url ?? "/", "http://ash"), headers, body }, router.localCaller(headers) ?? (req.url?.startsWith("/mcp/") ? { member: "mcp", local: true } : null));
    res.writeHead(r.status, r.headers ?? {});
    if ("stream" in r) {
      r.stream(
        (chunk) => res.write(chunk),
        (fn) => {
          if (res.destroyed || res.writableEnded) fn();
          else res.once("close", fn);
        },
      );
      return;
    }
    res.end(r.body);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
