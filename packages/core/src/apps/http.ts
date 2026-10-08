// The owner's HTTP API for the shell app ("Ash 应用"). Fixed routes; the shell app is built against exactly these:
//   GET  /api/apps                         → [{id,name,version,summary,icon,surfaces:[{id,title}],enabled,granted}]
//   GET  /api/apps/<id>/icon               → the icon file
//   GET  /api/apps/<id>/surfaces/<surface> → {html, csp:{connectDomains,resourceDomains}}
//   POST /api/apps/<id>/call {tool, arguments} → the MCP CallToolResult (as the owner; recorded in the ledger)
//   POST /api/apps/<id>/message {text}     → an owner message to agent:main, prefixed with the app's name
import type { Message, SendRequestV2 } from "../../../sdk/src/api";
import type { TrustedRouteContext } from "../world/router";
import { ownerText } from "./bridge";
import type { AppRuntime } from "./runtime";

export interface AppsHttpResponse { status: number; headers?: Record<string, string>; body?: string | Buffer }
export interface AppsHttpDeps {
  runtime: AppRuntime;
  send: (ctx: TrustedRouteContext, request: SendRequestV2) => Promise<{ id: string; seq: number }>;
  waitFor: (id: string, ms: number) => Promise<Message | null>;
  waitMs?: number;
}

const json = (status: number, body: unknown): AppsHttpResponse =>
  ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) });
const parse = (body: Buffer | null): Record<string, unknown> | null => {
  try { const value = body?.length ? JSON.parse(body.toString("utf8")) : {}; return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
};

/** Null when the path is not an apps route. `context` is the verified owner context for routes that send. */
export async function appsRoute(deps: AppsHttpDeps, method: string, path: string, body: Buffer | null, context: () => TrustedRouteContext): Promise<AppsHttpResponse | null> {
  const { runtime } = deps;
  if (path === "/api/apps" || path === "/api/apps/") {
    if (method !== "GET") return json(405, { error: "method_not_allowed" });
    return json(200, runtime.list().filter((app) => app.version).map((app) => ({ id: app.id, name: app.name, version: app.version, summary: app.summary,
      icon: `/api/apps/${app.id}/icon`, surfaces: app.surfaces.map((item) => ({ id: item.id, title: item.title })), enabled: app.enabled, granted: app.granted })));
  }
  const match = /^\/api\/apps\/([a-z][a-z0-9-]{0,47})\/(icon|surfaces\/([a-z][a-z0-9-]{0,31})|call|message)$/.exec(path);
  if (!match) return path.startsWith("/api/apps/") ? json(404, { error: "not_found", message: "route not found" }) : null;
  const [, id, action, surface] = match as unknown as [string, string, string, string | undefined];
  const manifest = runtime.manifest(id);
  if (!manifest) return json(404, { error: "not_found", message: "no such app" });
  if (action === "icon") {
    if (method !== "GET") return json(405, { error: "method_not_allowed" });
    const icon = runtime.icon(id);
    return icon ? { status: 200, headers: { "content-type": icon.type, "cache-control": "no-cache", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }, body: icon.bytes } : json(404, { error: "not_found", message: "no icon" });
  }
  if (surface !== undefined) {
    if (method !== "GET") return json(405, { error: "method_not_allowed" });
    if (!runtime.isRunning(id)) return json(503, { error: "offline", message: "the app is not running" });
    try {
      const read = await runtime.surface(id, surface);
      return read ? json(200, read) : json(404, { error: "not_found", message: "no such surface" });
    } catch (error) { return json(502, { error: "app_failed", message: error instanceof Error ? error.message.slice(0, 300) : "resource read failed" }); }
  }
  if (method !== "POST") return json(405, { error: "method_not_allowed" });
  const input = parse(body);
  if (!input) return json(400, { error: "bad_json", message: "body must be a JSON object" });
  if (action === "call") {
    if (typeof input.tool !== "string" || !input.tool) return json(400, { error: "bad_request", message: "tool is required" });
    const args = input.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return json(400, { error: "bad_request", message: "arguments must be an object" });
    if (!runtime.isRunning(id)) return json(503, { error: "offline", message: "the app is not running" });
    const sent = await deps.send(context(), { to: `app:${id}`, kind: "request", word: input.tool, body: args as Record<string, unknown>, wait: false });
    const reply = await deps.waitFor(sent.id, deps.waitMs ?? 60_000);
    if (!reply) return json(202, { pending: true, id: sent.id });
    const result = reply.body as { ok: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string } };
    if (result.ok) return json(200, { content: [], ...(result.result ?? {}) });
    // The app's own failure is its own words; anything else (offline, refused, timed out) is said plainly for the owner.
    const code = String(result.error?.code ?? "failed"), text = String(result.error?.message ?? "failed");
    return json(200, { content: [{ type: "text", text: code === "failed" ? text : ownerText(`app:${id}`, input.tool, code, text) }], isError: true });
  }
  // message
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 4000) return json(400, { error: "bad_request", message: "text is required (at most 4000 characters)" });
  const sent = await deps.send(context(), { to: "agent:main", kind: "request", word: "say", body: { text: `[来自「${manifest.name}」] ${text}` }, wait: false });
  return json(200, { id: sent.id, seq: sent.seq });
}
