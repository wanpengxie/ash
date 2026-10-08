// The app's way back into ash: one loopback MCP endpoint, one credential per running app. It exposes only
// capability_list / capability_describe / capability_call (restricted to the app's grants) and ash_event.
// Calls are made as app:<id> and go through the normal router and gate.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ResponseBody, WordSpec } from "../../../sdk/src/api";
import type { WorldMembers } from "../world/member";
import { RouterError, type TrustedRouteContext, type WorldRouter } from "../world/router";

/**
 * What ash itself already recorded for a capability that cannot answer right now (the phone or its helper is away):
 * for example device:phone health.read from the senses archive. Null when ash has nothing for it.
 */
export type RecentFacts = (member: string, word: string, body: Record<string, unknown>) => { as_of: number | null; source: string; [key: string]: unknown } | null;

export interface AppBridgeOptions {
  world: WorldRouter;
  members: WorldMembers;
  /** The grant check: may app:<id> use member/word? */
  allows: (app: string, member: string, word: string) => boolean;
  /** An event the app emitted; returns what to tell the app. */
  event: (id: string, name: string, body: Record<string, unknown>) => { ok: true } | { ok: false; error: string };
  log?: (...args: unknown[]) => void;
  /** How long one capability_call waits before answering "still running" (default 50 s). */
  waitMs?: number;
  recent?: RecentFacts;
}

type Result = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; owner_text?: string; recent?: unknown } };

/** Words served by the phone's senses helper, which Android may stop and restart on its own. */
const SENSES = /^(health|sensors|location|activity|sense)\./;
/** The error says the capability is not there right now (helper disconnected, device away), not that the call was wrong. */
const away = (code: string, message: string) => code === "offline" || code === "not_found" ||
  /has no capability|is not available right now|unknown word|not registered|device offline|not running/i.test(message);

/** A failed call as the owner should read it on an app's page: plain words, no codes. */
export function ownerText(member: string, word: string, code: string, message: string): string {
  const thing = SENSES.test(word) && member.startsWith("device:") ? "感知" : member.startsWith("device:") ? "手机上的这项功能" : member.startsWith("app:") ? "这个应用" : "Ash";
  if (/is not available right now/i.test(message)) return `${thing}现在用不了：手机上相关的权限或服务可能没打开`;
  if (member.startsWith("device:") && (code === "offline" || /device offline/i.test(message))) return "手机暂时没连上 Ash，稍后再试";
  if (away(code, message)) return `${thing}暂时不在线，稍后再试`;
  switch (code) {
    case "pending": return "还在处理，或在等你在 Ash 里确认";
    case "forbidden": return "安装时没有批准这一项，用不了";
    case "denied": return "你没有同意这次操作";
    case "timeout": return `${thing}没有及时回应，稍后再试`;
    case "cancelled": return "这次操作取消了";
    default: return "没办成，稍后再试";
  }
}
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const text = (description: string) => ({ type: "string", description });
export const APP_BRIDGE_TOOLS = [
  { name: "capability_list", description: "What this app may use of ash (granted by the owner at install): members and their capabilities.", inputSchema: object({ member: text("Only this member") }) },
  { name: "capability_describe", description: "Full contract of one granted capability (or all of a member's granted ones): input_schema, effect, label.", inputSchema: object({ member: text("Member id, e.g. device:phone"), word: text("Capability name") }, ["member"]) },
  { name: "capability_call", description: "Call one granted capability. Reads run at once; anything that changes something may wait for the owner's approval in ash.", inputSchema: object({ member: text("Member id"), word: text("Capability name"), body: { type: "object", description: "Input matching its input_schema" } }, ["member", "word"]) },
  { name: "ash_event", description: "Tell ash something happened: one of the events in app.json, or app.card {title, text} for an entry card in the owner's conversation (needs the card grant; at most one a day).", inputSchema: object({ name: text("Event name"), body: { type: "object" } }, ["name"]) },
] as const;

export class AppBridge {
  private http: HttpServer | null = null;
  private readonly tokens = new Map<string, string>();
  private seq = 0;
  url = "";
  constructor(private readonly options: AppBridgeOptions) {}

  /** A fresh credential for app <id>; the previous one stops working. */
  bind(id: string): string {
    this.unbind(id);
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, id);
    return token;
  }
  unbind(id: string): void { for (const [token, app] of this.tokens) if (app === id) this.tokens.delete(token); }

  async start(): Promise<string> {
    const server = createServer((request, response) => { void this.serve(request, response); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    this.http = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return this.url;
  }

  async close(): Promise<void> {
    const server = this.http;
    this.http = null;
    this.tokens.clear();
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private authenticate(request: IncomingMessage): string | null {
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const presented = Buffer.from(header.slice(7));
    for (const [token, id] of this.tokens) {
      const expected = Buffer.from(token);
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) return id;
    }
    return null;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // A web page could reach a loopback port; only an app's server process (no Origin) may talk here.
      if (request.headers.origin) { response.writeHead(403).end(); return; }
      if (!(request.url ?? "").startsWith("/mcp")) { response.writeHead(404).end(); return; }
      const id = this.authenticate(request);
      if (!id) { response.writeHead(401).end(); return; }
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (raw.length > 1024 * 1024) { response.writeHead(413).end(); return; } }
      const server = new Server({ name: "ash", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: APP_BRIDGE_TOOLS.map((tool) => ({ ...tool })) }));
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        const result = await this.call(id, call.params.name, (call.params.arguments ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>, ...(result.ok ? {} : { isError: true }) };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
    } catch (error) {
      this.options.log?.("app bridge request failed", error);
      if (!response.headersSent) response.writeHead(500).end();
    }
  }

  private granted(app: string, member: string): WordSpec[] {
    try {
      return (this.options.members.describe("agent", member).members[0]?.words ?? [])
        .filter((word) => word.kind === "request" && this.options.allows(app, member, word.word));
    } catch { return []; }
  }

  /** A granted call, made as app:<id> through the router and gate. */
  private async capabilityCall(app: string, id: string, member: string, word: string, body: Record<string, unknown>): Promise<Result> {
    const ctx: TrustedRouteContext = { transport: "app", member: app, transportPrincipal: app, local: true, remote: false, ownerProxy: false };
    const sent = this.options.world.send(ctx, { to: member, kind: "request", word, body,
      wait: true, client_id: `app:${id}:${Date.now()}:${++this.seq}:${randomBytes(4).toString("hex")}` });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([sent, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.options.waitMs ?? 50_000); })]);
    clearTimeout(timer);
    if (!waited) { sent.catch(() => {}); return this.failed(member, word, body, "pending", "still running or waiting for the owner's approval in ash; try again later"); }
    const reply = waited.reply?.body as ResponseBody | undefined;
    if (!reply) return this.failed(member, word, body, "result_unknown", "no answer was recorded");
    return reply.ok ? { ok: true, result: reply.result ?? {} } : this.failed(member, word, body, reply.error.code, reply.error.message);
  }

  /** A failure as the app gets it: the code and message, a sentence for the owner, and what ash already has when the device is away. */
  private failed(member: string, word: string, body: Record<string, unknown>, code: string, message: string): Result {
    let recent: unknown = null;
    if (away(code, message) || code === "timeout") {
      try { recent = this.options.recent?.(member, word, body) ?? null; } catch (error) { this.options.log?.("recent facts failed", error instanceof Error ? error.message : error); }
    }
    return { ok: false, error: { code, message, owner_text: ownerText(member, word, code, message), ...(recent ? { recent } : {}) } };
  }

  /** One tool call from app <id>. */
  async call(id: string, name: string, args: Record<string, unknown>): Promise<Result> {
    const app = `app:${id}`;
    const fail = (code: string, message: string): Result => ({ ok: false, error: { code, message } });
    try {
      switch (name) {
        case "capability_list": {
          const members = this.options.members.describe("agent").members
            .filter((member) => member.id !== app && (typeof args.member !== "string" || member.id === args.member))
            .map((member) => ({ id: member.id, name: member.name, ...(member.online === undefined ? {} : { online: member.online }),
              capabilities: this.granted(app, member.id).map((word) => ({ word: word.word, label: word.label, summary: word.description.slice(0, 160) })) }))
            .filter((member) => member.capabilities.length);
          return { ok: true, result: { members } };
        }
        case "capability_describe": {
          const words = this.granted(app, String(args.member ?? "")).filter((word) => typeof args.word !== "string" || word.word === args.word);
          if (!words.length) return fail("forbidden", "not granted or not found; capability_list shows what this app may use");
          return { ok: true, result: { member: args.member, capabilities: words.map((word) => ({ word: word.word, label: word.label, description: word.description,
            input_schema: word.input_schema ?? { type: "object" }, output_schema: word.result_schema ?? null, effect: word.effect ?? (word.risk === "none" ? "read" : "write") })) } };
        }
        case "capability_call": {
          if (typeof args.member !== "string" || typeof args.word !== "string") return fail("payload_invalid", "member and word are required");
          if (args.body !== undefined && (typeof args.body !== "object" || args.body === null || Array.isArray(args.body))) return fail("payload_invalid", "body must be an object");
          if (!this.options.allows(app, args.member, args.word)) return this.failed(args.member, args.word, {}, "forbidden", `${args.member}/${args.word} was not granted to this app`);
          try { return await this.capabilityCall(app, id, args.member, args.word, (args.body ?? {}) as Record<string, unknown>); }
          catch (error) {
            if (error instanceof RouterError) return this.failed(args.member, args.word, (args.body ?? {}) as Record<string, unknown>, error.code, error.message);
            throw error;
          }
        }
        case "ash_event": {
          if (typeof args.name !== "string") return fail("payload_invalid", "name is required");
          if (args.body !== undefined && (typeof args.body !== "object" || args.body === null || Array.isArray(args.body))) return fail("payload_invalid", "body must be an object");
          const done = this.options.event(id, args.name, (args.body ?? {}) as Record<string, unknown>);
          return done.ok ? { ok: true, result: { recorded: true } } : fail("forbidden", done.error);
        }
        default: return fail("payload_invalid", `unknown tool ${name}`);
      }
    } catch (error) {
      if (error instanceof RouterError) return fail(error.code, error.message);
      return fail("internal_error", error instanceof Error ? error.message : "tool failed");
    }
  }
}
