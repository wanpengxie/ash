// ash's side of contract ash-app/1: find apps in the container, start the ones the owner installed, register each as
// member app:<id> whose words are its MCP tools, keep the grants, record its events, and serve the shell app.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { AppMemberLike, Member, WorldMembers } from "../world/member";
import type { DeviceCapability, RouteHandlerContext, WorldRouter } from "../world/router";
import { AppBridge } from "./bridge";
import { AppGrants } from "./grants";
import { APP_ID_PATTERN, needKey, validateManifest, type AppManifest, type AppNeed } from "./schema";

export interface AppSpawn { command: string; args: string[]; env: Record<string, string>; cwd?: string }
/** Where apps live and how their servers are started (inside the container in production). */
export interface AppLauncher {
  /** The host folder holding one folder per app: <root>/<id>/app.json. */
  root: () => string | null;
  /** The command for an app's stdio MCP server; `env` (ASH_*) must reach the app unchanged. */
  spawn(app: AppManifest, dir: string, env: Record<string, string>): AppSpawn;
}
export interface AppRuntimeOptions {
  launcher: AppLauncher | null;
  stateDir: string;
  world: WorldRouter;
  members: WorldMembers;
  log?: (...args: unknown[]) => void;
  /** Tests: shorter restart backoff. */
  backoffMs?: (failures: number) => number;
  bridgeWaitMs?: number;
  /** Put ash's own apps into the apps folder before each discovery (missing or older ones only). */
  builtins?: (root: string) => void;
}
export interface AppInfo {
  id: string; name: string; version: string; summary: string; publisher: string; enabled: boolean; granted: boolean; running: boolean;
  needs: AppNeed[]; surfaces: { id: string; title: string; resource: string }[]; events: string[]; tools: string[]; error?: string;
}

type Found = { id: string; dir: string; manifest: AppManifest } | { id: string; dir: string; error: string };
const ID = new RegExp(APP_ID_PATTERN);
const SERVICE_WORDS = ["apps.list", "apps.describe", "apps.install", "apps.enable", "apps.disable", "apps.revoke", "apps.refresh"];
const clean = (value: unknown, max: number) => String(value ?? "").replace(/[\p{C}\s]+/gu, " ").trim().slice(0, max);
const MIME: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };

/** An app's MCP tools as ash capabilities. ash decides the risk: only a read-only, non-destructive claim is a read. */
export function appCapabilities(appName: string, tools: { name: string; title?: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> }[]): DeviceCapability[] {
  const name = clean(appName, 40) || "应用";
  return tools.filter((tool) => typeof tool.name === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(tool.name)).map((tool) => {
    const read = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
    const title = clean(tool.title ?? tool.annotations?.title ?? tool.name, 60) || tool.name;
    const schema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? tool.inputSchema : { type: "object" };
    return { name: tool.name, description: clean(tool.description || title, 2000) || tool.name, input_schema: schema,
      risk: read ? "none" as const : "structure" as const, effect: read ? "read" as const : "write" as const, label: `在${name}里${title}` };
  });
}

class AppMember implements AppMemberLike {
  readonly kind = "app" as const;
  online = true;
  constructor(readonly id: string, readonly name: string, private readonly list: DeviceCapability[],
    private readonly run: (message: Message, context: RouteHandlerContext) => Promise<ResponseBody>) {}
  capabilities(): readonly DeviceCapability[] { return structuredClone(this.list); }
  handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> | ResponseBody {
    if (!this.online) return { ok: false, error: { code: "offline", message: `${this.name} is not running` } };
    return this.run(message, context);
  }
}

interface Running { client: Client; member: AppMember | null; tools: string[]; started: number; stopping: boolean; version: string }

export class AppRuntime {
  readonly grants: AppGrants;
  readonly bridge: AppBridge;
  private found = new Map<string, Found>();
  private readonly running = new Map<string, Running>();
  private readonly failures = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastError = new Map<string, string>();
  private closed = false;
  private readonly log: (...args: unknown[]) => void;

  constructor(private readonly options: AppRuntimeOptions) {
    this.log = options.log ?? (() => {});
    this.grants = new AppGrants(join(options.stateDir, "app-grants.json"));
    this.bridge = new AppBridge({ world: options.world, members: options.members, log: this.log, waitMs: options.bridgeWaitMs,
      allows: (app, member, word) => this.grants.allows(app, member, word), event: (id, name, body) => this.event(id, name, body) });
    options.world.setAppGrants((app, member, word) => this.running.has(app.replace(/^app:/, "")) && this.grants.allows(app, member, word));
    options.world.setGateCard((request) => this.card(request));
  }

  /** Discover and start the installed apps. Failures of one app never stop ash. */
  async start(): Promise<void> {
    if (this.closed) return;
    await this.bridge.start();
    if (this.closed) { await this.bridge.close(); return; }
    await this.refresh();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    await this.bridge.close();
  }

  /** Read every <root>/<id>/app.json; an invalid one is skipped with its reason. */
  discover(): Map<string, Found> {
    const root = this.options.launcher?.root() ?? null;
    const found = new Map<string, Found>();
    if (!root) return found;
    try { this.options.builtins?.(root); } catch (error) { this.log("built-in apps not installed", error instanceof Error ? error.message : error); }
    if (!existsSync(root)) return found;
    for (const id of readdirSync(root).sort()) {
      const dir = join(root, id);
      try { if (!statSync(dir).isDirectory() || !existsSync(join(dir, "app.json"))) continue; } catch { continue; }
      let error = "";
      let manifest: AppManifest | null = null;
      try {
        const checked = validateManifest(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")));
        if (checked.ok) manifest = checked.manifest; else error = checked.error;
      } catch (cause) { error = `app.json is not JSON: ${cause instanceof Error ? cause.message : cause}`; }
      if (manifest && manifest.id !== id) { error = `id ${manifest.id} does not match its folder ${id}`; manifest = null; }
      if (!ID.test(id)) { error = "folder name is not a valid app id"; manifest = null; }
      if (manifest) found.set(id, { id, dir, manifest });
      else { found.set(id, { id, dir, error }); this.log("app skipped", id, error); }
    }
    return found;
  }

  /** Rediscover; start what is installed and enabled, stop what disappeared, restart what changed version. */
  async refresh(): Promise<void> {
    this.found = this.discover();
    for (const id of [...this.running.keys()]) {
      const item = this.found.get(id);
      const grant = this.grants.get(id);
      if (!item || !("manifest" in item) || !grant?.enabled) await this.stop(id);
      else if (item.manifest.version !== this.running.get(id)!.version) await this.stop(id);
    }
    for (const [id, item] of this.found) if ("manifest" in item && this.grants.get(id)?.enabled && !this.running.has(id)) await this.launch(id);
  }

  manifest(id: string): AppManifest | null { const item = this.found.get(id); return item && "manifest" in item ? item.manifest : null; }
  dir(id: string): string | null { return this.found.get(id)?.dir ?? null; }
  isRunning(id: string): boolean { return Boolean(this.running.get(id)?.member?.online); }

  info(id: string): AppInfo | null {
    const item = this.found.get(id);
    if (!item) return null;
    const grant = this.grants.get(id);
    const running = this.running.get(id);
    const error = "error" in item ? item.error : this.lastError.get(id);
    const m = "manifest" in item ? item.manifest : null;
    return { id, name: m?.name ?? id, version: m?.version ?? "", summary: m?.summary ?? "", publisher: m?.publisher ?? "",
      enabled: Boolean(grant?.enabled), granted: Boolean(grant), running: Boolean(running?.member?.online),
      needs: grant?.needs ?? m?.needs ?? [], surfaces: m?.surfaces ?? [], events: m?.events ?? [], tools: running?.tools ?? [], ...(error ? { error } : {}) };
  }
  list(): AppInfo[] { return [...this.found.keys()].map((id) => this.info(id)!); }

  private async launch(id: string): Promise<void> {
    if (this.closed || this.running.has(id)) return;
    const manifest = this.manifest(id);
    const launcher = this.options.launcher;
    if (!manifest || !launcher) return;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const token = this.bridge.bind(id);
    const spec = launcher.spawn(manifest, this.dir(id)!, { ASH_APP_ID: id, ASH_MCP_URL: this.bridge.url, ASH_MCP_TOKEN: token });
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, ...(spec.cwd ? { cwd: spec.cwd } : {}), stderr: "pipe" });
    transport.stderr?.on("data", (chunk) => this.log(`[app ${id}]`, String(chunk).trim().slice(0, 500)));
    const client = new Client({ name: "ash", version: "1.0.0" });
    const state: Running = { client, member: null, tools: [], started: Date.now(), stopping: false, version: manifest.version };
    this.running.set(id, state);
    client.onclose = () => { if (this.running.get(id) === state) void this.exited(id, state); };
    try {
      await client.connect(transport, { timeout: 60_000 });
      const listed = await client.listTools(undefined, { timeout: 60_000 });
      const capabilities = appCapabilities(manifest.name, listed.tools as Parameters<typeof appCapabilities>[1]);
      const accepted = this.register(id, manifest.name, capabilities, state);
      state.tools = accepted.map((item) => item.name);
      this.lastError.delete(id);
      this.log("app started", id, manifest.version, state.tools.join(","));
    } catch (error) {
      this.lastError.set(id, `start failed: ${error instanceof Error ? error.message : error}`.slice(0, 300));
      this.log("app failed to start", id, error instanceof Error ? error.message : error);
      if (this.running.get(id) === state) await this.exited(id, state);
    }
  }

  /** All-or-nothing compile per batch; a tool whose schema cannot be compiled is left out alone. */
  private register(id: string, name: string, capabilities: DeviceCapability[], state: Running): DeviceCapability[] {
    const run = (message: Message, context: RouteHandlerContext) => this.callTool(state, message, context);
    const memberId = `app:${id}`;
    try {
      const member = new AppMember(memberId, name, capabilities, run);
      this.options.members.registerApp(member);
      state.member = member;
      return capabilities;
    } catch {
      const accepted: DeviceCapability[] = [];
      for (const capability of capabilities) {
        try {
          const member = new AppMember(memberId, name, [...accepted, capability], run);
          this.options.members.registerApp(member);
          state.member = member;
          accepted.push(capability);
        } catch (error) { this.log("app tool rejected", id, capability.name, error instanceof Error ? error.message : error); }
      }
      if (!state.member) { const member = new AppMember(memberId, name, [], run); this.options.members.registerApp(member); state.member = member; }
      return accepted;
    }
  }

  private async callTool(state: Running, message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    try {
      const result = await state.client.callTool({ name: message.word, arguments: message.body }, undefined, { signal: context.signal, timeout: 590_000 });
      const content = Array.isArray(result.content) ? result.content : [];
      if (result.isError) {
        const text = content.map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text" ? String((item as { text?: unknown }).text ?? "") : "").join("\n").trim();
        return { ok: false, error: { code: "failed", message: text.slice(0, 2000) || "the app's tool failed" } };
      }
      return { ok: true, result: { content, ...(result.structuredContent && typeof result.structuredContent === "object" ? { structuredContent: result.structuredContent } : {}) } };
    } catch (error) {
      if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "call cancelled" } };
      return { ok: false, error: { code: state.stopping || !state.member?.online ? "offline" : "failed", message: error instanceof Error ? error.message.slice(0, 500) : "app call failed" } };
    }
  }

  /** The server went away: mark offline and restart with backoff (1 s, doubling, at most a minute). */
  private async exited(id: string, state: Running): Promise<void> {
    if (state.member) state.member.online = false;
    if (state.stopping || this.closed) return;
    this.running.delete(id);
    this.bridge.unbind(id);
    try { await state.client.close(); } catch { /* already gone */ }
    const failures = Date.now() - state.started > 120_000 ? 1 : (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, failures);
    const delay = this.options.backoffMs?.(failures) ?? Math.min(60_000, 1000 * 2 ** (failures - 1));
    this.log("app exited; restarting", id, `in ${delay} ms`);
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); if (this.grants.get(id)?.enabled) void this.launch(id); }, delay));
  }

  async stop(id: string): Promise<void> {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const state = this.running.get(id);
    this.bridge.unbind(id);
    try { this.options.members.removeApp(`app:${id}`); } catch { /* not registered */ }
    if (!state) return;
    state.stopping = true;
    if (state.member) state.member.online = false;
    this.running.delete(id);
    try { await state.client.close(); } catch { /* already gone */ }
  }

  /** An app's MCP client, for reading its UI resources. */
  client(id: string): Client | null { const state = this.running.get(id); return state?.member?.online ? state.client : null; }

  icon(id: string): { type: string; bytes: Buffer } | null {
    const manifest = this.manifest(id);
    if (!manifest?.icon) return null;
    const file = join(this.dir(id)!, manifest.icon);
    try { return { type: MIME[extname(file).toLowerCase()] ?? "application/octet-stream", bytes: readFileSync(file) }; } catch { return null; }
  }

  /** Read a surface (a ui:// resource) of a running app: its HTML and declared CSP domains. */
  async surface(id: string, surfaceId: string): Promise<{ html: string; csp: { connectDomains: string[]; resourceDomains: string[] } } | null> {
    const surface = this.manifest(id)?.surfaces?.find((item) => item.id === surfaceId);
    const client = this.client(id);
    if (!surface || !client) return null;
    const read = await client.readResource({ uri: surface.resource }, { timeout: 30_000 });
    const content = (read.contents ?? []).find((item) => item.uri === surface.resource) ?? read.contents?.[0];
    if (!content) return null;
    const html = typeof (content as { text?: unknown }).text === "string" ? String((content as { text: string }).text)
      : typeof (content as { blob?: unknown }).blob === "string" ? Buffer.from(String((content as { blob: string }).blob), "base64").toString("utf8") : "";
    const csp = ((content as { _meta?: { ui?: { csp?: Record<string, unknown> } } })._meta?.ui?.csp) ?? {};
    const domains = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 32) : [];
    return { html, csp: { connectDomains: domains(csp.connectDomains), resourceDomains: domains(csp.resourceDomains) } };
  }

  /** An event from app <id>. ash decides where it goes; the app only says what happened. */
  event(id: string, name: string, body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    const manifest = this.manifest(id);
    if (!manifest || !this.running.has(id)) return { ok: false, error: "app not running" };
    if (JSON.stringify(body).length > 4000) return { ok: false, error: "event body too large" };
    const app = `app:${id}`;
    if (name === "app.card") {
      if (!this.grants.has(id, "card")) return { ok: false, error: "the owner did not grant entry cards (needs: card)" };
      const title = clean(body.title, 40), text = clean(body.text, 200);
      if (!title) return { ok: false, error: "app.card needs a title" };
      if (!this.grants.take(id, "app.card", 1)) return { ok: false, error: "rate limited: one entry card a day" };
      this.options.world.recordAppEvent(app, "app.card", { app: id, name: manifest.name, title, ...(text ? { text } : {}) }, "person:owner");
      return { ok: true };
    }
    if (!(manifest.events ?? []).includes(name)) return { ok: false, error: `event ${name} is not declared in app.json` };
    // With the notify grant, an event that says something (text) reaches the owner as an entry card, a few a day.
    const said = typeof body.text === "string" && body.text.trim();
    const notify = said && this.grants.has(id, "notify") && this.grants.take(id, "notify", 3);
    this.options.world.recordAppEvent(app, name, notify ? { ...body, app: id, name: manifest.name, title: clean(body.title ?? manifest.name, 40), text: clean(body.text, 200) } : body,
      notify ? "person:owner" : null);
    return { ok: true };
  }

  /** The owner's card for widening an app's reach, and for an app's own requests. */
  private card(request: Message): { title: string; detail: string } | null {
    if (request.to === "service:apps" && (request.word === "apps.install" || request.word === "apps.enable")) {
      const id = String(request.body.id ?? "");
      const manifest = this.manifest(id);
      if (!manifest) return null;
      if (request.word === "apps.enable") return { title: `重新打开「${clean(manifest.name, 20)}」`, detail: `按你之前批准的范围重新运行「${clean(manifest.name, 20)}」。` };
      const lines = (manifest.needs ?? []).map((need) => "member" in need ? `· ${clean(need.why, 200)}（${need.member}：${need.words.join("、")}）`
        : `· ${clean(need.why, 200)}（${({ notify: "提醒你", widgets: "小组件", card: "在对话里放入口卡片" } as Record<string, string>)[needKey(need)]}）`);
      return { title: `安装「${clean(manifest.name, 20)}」`,
        detail: `${clean(manifest.name, 40)} ${manifest.version}（${clean(manifest.publisher, 40)}）：${clean(manifest.summary, 200)}\n它需要：\n${lines.length ? lines.join("\n") : "· 不需要用 Ash 的其他东西"}\n批准后它在容器里运行，成为 app:${id}；可以随时撤销。` };
    }
    if (/^app:/.test(request.from)) {
      const manifest = this.manifest(request.from.slice(4));
      return manifest ? { title: `「${clean(manifest.name, 20)}」需要你确认`, detail: `${request.to}/${request.word}：${JSON.stringify(request.body).slice(0, 500)}` } : null;
    }
    return null;
  }

  /** service:apps — the owner's and agents' words for apps. */
  member(): Member {
    const words = SERVICE_WORDS.map((word) => wordContract("service:apps", word)) as WordSpec[];
    if (words.some((word) => !word)) throw new Error("service:apps word contracts unavailable");
    return { id: "service:apps", kind: "service", name: "Apps", online: true, words: () => words,
      handle: async (message) => this.handle(message) };
  }

  private async handle(message: Message): Promise<ResponseBody> {
    const fail = (code: "not_found" | "failed" | "bad_request", text: string): ResponseBody => ({ ok: false, error: { code, message: text } });
    const id = typeof message.body.id === "string" ? message.body.id : "";
    switch (message.word) {
      case "apps.list": return { ok: true, result: { apps: this.list() } };
      case "apps.refresh": await this.refresh(); return { ok: true, result: { apps: this.list() } };
      case "apps.describe": { const info = this.info(id); return info ? { ok: true, result: info } : fail("not_found", `no app ${id}; apps.list shows what exists`); }
      case "apps.install": {
        const manifest = this.manifest(id);
        if (!manifest) return this.found.has(id) ? fail("failed", `app ${id} is invalid: ${this.info(id)?.error}`) : fail("not_found", `no app ${id}`);
        await this.stop(id);
        this.grants.grant(id, manifest.version, manifest.needs ?? []);
        await this.launch(id);
        return { ok: true, result: this.info(id)! };
      }
      case "apps.enable": {
        if (!this.manifest(id)) return fail("not_found", `no app ${id}`);
        if (!this.grants.setEnabled(id, true)) return fail("failed", "not installed; use apps.install");
        await this.launch(id);
        return { ok: true, result: this.info(id)! };
      }
      case "apps.disable": {
        if (!this.found.has(id)) return fail("not_found", `no app ${id}`);
        this.grants.setEnabled(id, false);
        await this.stop(id);
        return { ok: true, result: this.info(id)! };
      }
      case "apps.revoke": {
        if (!this.found.has(id)) return fail("not_found", `no app ${id}`);
        const need = typeof message.body.need === "string" ? message.body.need : undefined;
        const left = this.grants.revoke(id, need);
        if (!left) await this.stop(id);
        return { ok: true, result: this.info(id)! };
      }
      default: return fail("not_found", "unknown word");
    }
  }
}
