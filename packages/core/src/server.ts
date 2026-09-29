// `ash-api/1` over local HTTP: the SDK routes, the event stream (SSE) and the per-agent MCP
// endpoint. Tokens decide who is calling: API tokens map to a member (owner, host, UI …),
// MCP tokens map to exactly one agent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { API_VERSION, AshApiError, type AshEvent } from "../../sdk/src/api";
import type { Core } from "./core";
import { handleMcp } from "./mcp";

export interface Tokens {
  /** API token → member id it speaks for. */
  api: Record<string, string>;
  /** agent id → its MCP token. */
  mcp: Record<string, string>;
}

const MAX_BODY = 1024 * 1024;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startServer(core: Core, tokens: Tokens, host: string, port: number): Promise<Server> {
  const who = (req: IncomingMessage): string | null => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    const t = auth.slice(7).trim();
    for (const [token, member] of Object.entries(tokens.api)) if (same(t, token)) return member;
    return null;
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) reject(new AshApiError(413, "body_too_large", "request body too large"));
        else chunks.push(c);
      });
      req.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        if (!s.trim()) return resolve({});
        try {
          resolve(JSON.parse(s));
        } catch {
          reject(new AshApiError(400, "bad_json", "body must be JSON"));
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://ash");
    const path = url.pathname;
    try {
      // ---- MCP (system services for one agent)
      const mcp = /^\/mcp\/(agent:[A-Za-z0-9_.-]+)$/.exec(decodeURIComponent(path));
      if (mcp) {
        const agent = mcp[1];
        const t = String(req.headers["x-ash-token"] ?? "");
        if (!tokens.mcp[agent] || !same(t, tokens.mcp[agent])) return json(res, 401, { error: "unauthorized" });
        if (req.method === "GET") {
          res.writeHead(405, { allow: "POST" });
          return res.end();
        }
        if (req.method === "DELETE") return json(res, 200, {});
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
        const [status, body] = await handleMcp(core, agent, await readBody(req));
        if (status === 202) {
          res.writeHead(202);
          return res.end();
        }
        return json(res, status, body);
      }

      // ---- SDK
      const me = who(req);
      if (!me) return json(res, 401, { error: "unauthorized", message: "missing or unknown bearer token" });
      const route = `${req.method} ${path}`;
      if (route === "GET /v1/manifest") return json(res, 200, { api: API_VERSION, space: core.space, me, members: core.listMembers(), agents: core.listAgents() });
      if (route === "GET /v1/members") return json(res, 200, core.listMembers());
      if (route === "GET /v1/agents") return json(res, 200, core.listAgents());
      if (route === "GET /v1/events") {
        const n = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
        return json(res, 200, core.events({ after: n("after"), limit: n("limit"), workspace: url.searchParams.get("workspace") ?? undefined, type: url.searchParams.get("type") ?? undefined }));
      }
      if (route === "GET /v1/events/stream") return stream(core, req, res, Number(url.searchParams.get("after") ?? "0") || 0);
      if (route === "GET /v1/timers") return json(res, 200, core.listTimers());
      if (route === "POST /v1/timers") return json(res, 200, core.setTimer((await readBody(req)) as never, me));
      if (route === "POST /v1/notify") return json(res, 200, await core.notify((await readBody(req)) as never, me));
      const m = /^\/v1\/agents\/([^/]+)\/(deliver|cancel)$/.exec(path);
      if (m && req.method === "POST") {
        const agent = decodeURIComponent(m[1]);
        if (m[2] === "deliver") return json(res, 200, core.deliver(agent, (await readBody(req)) as never, me));
        return json(res, 200, await core.cancel(agent));
      }
      const t = /^\/v1\/timers\/([^/]+)$/.exec(path);
      if (t && req.method === "DELETE") return json(res, 200, core.cancelTimer(decodeURIComponent(t[1]), me));
      return json(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof AshApiError) return json(res, e.status, { error: e.code, message: e.message });
      core.log("request failed", e);
      return json(res, 500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

/** Server-Sent Events: replay everything after `after`, then follow live. */
function stream(core: Core, req: IncomingMessage, res: ServerResponse, after: number): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  let last = after;
  const send = (e: AshEvent) => {
    if (e.seq <= last) return;
    last = e.seq;
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
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
  const beat = setInterval(() => res.write(": keepalive\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(beat);
    unsubscribe();
  });
}
