// The hub's side of contract ash-app/1: find apps in the apps folder, start the ones the owner installed (one child
// process each, MCP over stdio), register each as member `app:<id>` whose words are its MCP tools and events, keep the
// grants, route the events it emits, and deliver the events it listens to. The bridge (./bridge.ts) is the way back in.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { APP_NAME_PATTERN, OWNER_ID } from "../../../../sdk/src/ids";
import { appToolContract, ASH_ON_EVENT_TOOL, wakeEvents, type AppJson, type AppNeed, type McpTool } from "../../../../sdk/src/app";
import { WordError, type Caller, type ErrorCode, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import { DEFAULT_CALLERS, type Member, type WordContract } from "../../../../sdk/src/word";
import type { Ledger } from "../../kernel/ledger";
import type { Registry, Router } from "../../kernel/types";
import { markNotified, RELEASE_DIR, type BuiltinKept } from "./builtin";
import { AppBridge, mcpContent, type RecentFacts } from "./bridge";
import { checkFolder, checkManifest, toolProblem, trialRun, UI_MIME, type AppProblem, type AppSpawn } from "./check";
import { scaffoldFiles, type ScaffoldSurface, type ScaffoldTool } from "./scaffold";
import { AppGrants, needKey, type AppGrant } from "./store";

export type { AppSpawn } from "./check";

/** Where apps live and how their servers are started (inside the container in production, on the host in tests). */
export interface AppLauncher {
  /** The folder holding one folder per app: <root>/<id>/app.json. */
  root: string;
  /** The same folder as the agent sees it (/root/apps in the container); `root` when there is no container. */
  agentRoot?: string;
  /** The command for the stdio MCP server of the app in folder `dir`; `env` (ASH_*) must reach the app unchanged. */
  spawn(app: AppJson, dir: string, env: Record<string, string>): AppSpawn;
}

/** Runs the server directly on this machine, in the app's folder, with a small environment of its own (not the hub's). */
export function hostLauncher(root: string): AppLauncher {
  return {
    root,
    spawn: (app, dir, env) => ({
      command: app.server.command, args: app.server.args ?? [], cwd: dir,
      env: { HOME: process.env.HOME ?? "/root", PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C.UTF-8", TERM: "dumb", ...(app.server.env ?? {}), ...env },
    }),
  };
}

export interface AppRuntimeOptions {
  router: Router;
  registry: Registry;
  ledger: Pick<Ledger, "db" | "tx">;
  /** The full id (`agent:<name>`) of the agent a wake event without an `agent` wakes. */
  primaryAgent(): string;
  launcher: AppLauncher | null;
  /** Folders already in the apps folder that are the hub's own organs: installed without a card the first time, then kept like any app. */
  builtinApps?: string[];
  /** Built-in apps whose newer release was not applied because the agent changed them (see ./builtin.ts): the main agent is told once. */
  builtinKept?: BuiltinKept[];
  /** The built-in apps whose folder is exactly the release: only these are granted again from their app.json. None when not given. */
  builtinExact?: ReadonlySet<string>;
  contract?: { doc: string; docPath?: string };
  log?: (...args: unknown[]) => void;
  clock?: { now(): number };
  /** Tests: shorter restart backoff. */
  backoffMs?: (failures: number) => number;
  bridgeWaitMs?: number;
  /** What the hub already recorded for a word that cannot answer right now (see AppBridge). */
  recent?: RecentFacts;
  /** How long a trial run may take to start and answer. */
  trialMs?: number;
}

/** Who made an app, as far as the hub can tell: the hub's own organ, written by an agent (not published), or anyone else. */
export type AppOrigin = "builtin" | "agent" | "other";
export interface AppReport { id: string; path: string; ok: boolean; problems: AppProblem[]; tools: string[]; surfaces: string[] }
export interface AppInfo {
  id: string; name: string; version: string; summary: string; role: string; publisher: string; enabled: boolean; granted: boolean; running: boolean;
  needs: AppNeed[]; surfaces: { id: string; title: string; resource: string }[]; events: string[]; tools: string[]; listens: string[]; error?: string;
  /** The dot the app asked for on its icon, while it runs: `warn`, `err` or `paused`. */
  badge?: "warn" | "err" | "paused";
  /** What kind of trouble `error` is, for a screen that must not show it as it is (it is for an agent): `manifest` (app.json cannot be read or does not pass), `folder` (an installed app whose folder is gone), `run` (it did not start or stopped). */
  problem?: "manifest" | "folder" | "run";
  /** The folder as the agent sees it, and who made the app. */
  path: string; origin: AppOrigin;
}

type Found = { id: string; dir: string; manifest: AppJson } | { id: string; dir: string; error: string };
interface LastExit { ts: number; code: number | null; signal: string | null; reason: string }

/** At most this many wakes a day per app, however many wake-worthy events it reports. */
const WAKES_A_DAY = 3;
const EVENT_BODY_MAX = 4000;
const SERVICE_CALLER: Caller = { member: "service:apps", via: "service", local: false };
/** Events waiting to be handed to one app's `ash.on_event`; more than this are dropped (the app is stuck or slow). */
const EVENT_QUEUE_MAX = 200;
const ON_EVENT_TIMEOUT_MS = 10_000;
const LOG_LINES = 400, LOG_LINE_CHARS = 1000;
const MIME: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
/** What an app with no icon (or whose icon file is gone) shows: a 96x96 PNG of four rounded tiles, so every channel can draw it as it would any icon. */
export const DEFAULT_APP_ICON = { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAC+0lEQVR42u3d605aURQE4PWYbe1NrVprvQByR0Dr3T6OCAiIgIDv0oeYpqbRmGpzlmfvs9xhdvL9nmTmHyRniTh4bzZuMYvE8s1q6eZjvN28BT3PY/FTUHROy3+3OQXpxS9+awqK70Xlz21NQe6w/JBGmEtNQO5FKv99agLyh+W/5hE+pCYg/54uPz0BJeeJAcag5Dwq/2N6DErewwCZMSh59wN8yoxByftb/g3IjnzevgHZ4QAcYMYHmM/egOzIfHYEsiML2RHIjizkRkgKgF8aoedGIa+xeFeFWOWqBljMjeBb3CJCy9WQxdwQPsUt4aGMMHK15Et+CJ9cFRFKrhYHsB5gKT+ET66KCCVXS5YKQ/jkrIhAcrVkqTCAT+6KCCNXS5YLA/jkqohQcrVkuTiAT86KCCRXS1aKA/jkqohQcrU4gPkApWv45KyIQHK15GvpGj65KiKUXC3vA7goI7Rc1QCr5Wv4FreI0HI1ZLXcR1L0BYSdG4V8K/dBdjiA+QCVPsiOrFX6IDuyVrkC2ZHvO1cgOxyAA8z4AOvVK5AdWa/2QHZko9oD2ZGNWg9kRzZrPSRF+6NY6LlRyGss3lUhVrm6Aepd+Ba7iMByNWSr3oVPrv4aDCVXiwNYD5Cqd+GTqyJCydWS1G4XPjkrIpBcLUntduCTuyLCyNWS9G4HPrkqIpRcLUnvdeCTsyICydWSzF4HPrkqIpRcLcnsXcInd0WEkasl2z8u4ZOrIkLJ1eIAHGDGB8juX8K3uCWElqsh2f02fItfRFi5GpLbbyMp2gJCz41CcgdtkB0OYD1A/qANsiP5gxbIjhQOWyA7HMB6gOJhC2Tn7gvqxaMWKHn39wOKR01Q8u4HKB01Qcl7dEemdNwEJeefK0rl4yYoOU/eEmMxhuXfDXByAfLvv/ckKycXIH8iXVRlUYbl/3k7pxcg91RXtXdOGyB3XnRXvnraAMUncR9LNCr+0QhnDVB04uvVzhqg50lSr3Z2Dnoglq/+8xyzyEV3vwHXORmi6Fr8HwAAAABJRU5ErkJggg==" };
const ID = new RegExp(APP_NAME_PATTERN);
const clean = (value: unknown, max: number) => String(value ?? "").replace(/[\p{C}\s]+/gu, " ").trim().slice(0, max);
const fail = (code: ConstructorParameters<typeof WordError>[0], message: string, extra?: { detail?: unknown; recovery_hint?: string }) => new WordError(code, message, extra);

interface Running {
  id: string;
  client: Client;
  transport: StdioClientTransport;
  manifest: AppJson;
  online: boolean;
  stopping: boolean;
  started: number;
  tools: Set<string>;
  hasOnEvent: boolean;
  queued: number;
  chain: Promise<void>;
}

export class AppRuntime {
  readonly grants: AppGrants;
  readonly bridge: AppBridge;
  private found = new Map<string, Found>();
  private readonly running = new Map<string, Running>();
  private readonly failures = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastError = new Map<string, string>();
  /** The dot an app asked for on its icon (apps.badge); memory only, shown while it runs. */
  private readonly badges = new Map<string, "warn" | "err" | "paused">();
  /** What the approval card of each install request showed (needs and listens), by request id; memory only. */
  private readonly shown = new Map<string, string>();
  private readonly output = new Map<string, { lines: string[]; exit: LastExit | null }>();
  private closed = false;
  private started = false;
  private readonly log: (...args: unknown[]) => void;

  constructor(private readonly options: AppRuntimeOptions) {
    this.log = options.log ?? (() => {});
    this.grants = new AppGrants(options.ledger, () => this.now());
    this.bridge = new AppBridge({
      router: options.router, registry: options.registry, log: this.log, waitMs: options.bridgeWaitMs, clock: options.clock,
      granted: (app, member, word) => this.granted(app, member, word), event: (id, name, body) => this.emit(id, name, body),
      ...(options.recent ? { recent: options.recent } : {}),
    });
  }

  private now(): number { return this.options.clock?.now() ?? Date.now(); }
  private get root(): string | null { return this.options.launcher?.root ?? null; }

  /**
   * May app:<id> reach `to`/`word`? This is the one permission check for an app, called by the router (`appGranted`) on
   * every request an app sends. A word needs a grant in app.json's `needs`, approved at install; an event (`to` null) must
   * be one the running app declared. Only a running, enabled app has anything.
   */
  /** Was app:<id> (running, enabled) granted the vault credential [ref]? The vault asks this for service:vault/token. */
  credential(app: string, ref: string): boolean {
    return this.running.has(app.replace(/^app:/, "")) && this.grants.credential(app, ref);
  }

  granted(app: string, to: string | null, word: string): boolean {
    const id = app.replace(/^app:/, "");
    const state = this.running.get(id);
    if (!state || !this.grants.get(id)?.enabled) return false;
    if (to === null) return (state.manifest.events ?? []).includes(word);
    return this.grants.allows(app, to, word);
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------

  /** Start the loopback endpoint, seed the hub's own organs, discover and start the installed apps. One bad app never stops the hub. */
  async start(): Promise<void> {
    if (this.closed) return;
    await this.bridge.start();
    this.found = this.discover();
    for (const id of this.options.builtinApps ?? []) this.seedBuiltin(id);
    // What is installed is known now (`info` answers from the install records and the scan); starting the servers can take a
    // minute each and tells nothing about whether an app exists, so `apps.describe` does not wait for it (its `running` is true
    // as each app comes up).
    this.started = true;
    await this.refresh();
    this.tellKept();
  }

  /** Whether the folders have been scanned and the built-in apps seeded: `info` can say what is installed. The servers may still be starting. */
  isStarted(): boolean { return this.started; }

  /** The main agent hears (a background `tell`) that a release is waiting for the apps it changed; the hub does not merge it. */
  private tellKept(): void {
    const agent = this.options.primaryAgent();
    for (const item of this.options.builtinKept ?? []) {
      const text = `Ash 自带的应用 ${item.id} 发了新版 ${item.shipped}，但你改过它（现在是 ${item.current}），所以没有覆盖，你的版本继续用。` +
        `新版的文件放在 ${this.agentPath(`${RELEASE_DIR}/${item.id}`)}/ ；需要的话你自己决定要不要把新版的改动合进 ${this.agentPath(item.id)}/（合完改 app.json 的 version，再 apps.restart）。${this.agentPath(RELEASE_DIR)}/ 每次启动都会被覆盖，是只读的，别在里面改。这条只提醒一次。`;
      this.log("builtin app kept", item.id, item.shipped);
      if (!agent) { this.log("builtin app kept: no main agent to tell", item.id); continue; }
      const dir = this.dir(item.id);
      void this.options.router.send({ to: agent, kind: "request", word: "tell", body: { text } }, SERVICE_CALLER)
        .then((reply) => { if (reply.ok) { if (dir) markNotified(dir, item.shipped); } else this.log("builtin app kept: tell failed", item.id, reply.error.message); },
          (error) => this.log("builtin app kept: tell failed", item.id, error instanceof Error ? error.message : error));
    }
  }

  /**
   * `lifecycle.stop`: end every app's server before `deadline` (epoch ms). The servers get their stdin closed (a polite
   * request to exit); whatever is still alive at the deadline is killed. Nothing is restarted afterwards.
   */
  async stopAll(deadline: number): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const states = [...this.running.values()];
    this.running.clear();
    for (const state of states) {
      state.stopping = true;
      state.online = false;
      this.options.registry.remove(`app:${state.id}`);
    }
    const pids = states.map((state) => state.transport.pid).filter((pid): pid is number => pid !== null);
    const closing = Promise.all(states.map((state) => state.client.close().catch(() => {})));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - this.now())); });
    await Promise.race([closing.then(() => {}), expired]);
    clearTimeout(timer);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await this.bridge.close();
  }

  async close(): Promise<void> { await this.stopAll(this.now() + 5000); }

  // ---- finding apps -------------------------------------------------------------------------------------------------

  /** Read every <root>/<id>/app.json; an invalid one is skipped with its reason. */
  discover(): Map<string, Found> {
    const found = new Map<string, Found>();
    const root = this.root;
    if (!root || !existsSync(root)) return found;
    for (const id of readdirSync(root).sort()) {
      if (!ID.test(id)) continue; // not an app name (.new-x, _release, ...): never an app
      const item = this.readFolder(root, id);
      if (!item) continue;
      found.set(id, item);
      if ("error" in item) this.log("app skipped", id, item.error);
    }
    return found;
  }

  /** One folder of the apps root: null when it holds no app.json. */
  private readFolder(root: string, id: string): Found | null {
    const dir = join(root, id);
    try { if (!statSync(dir).isDirectory() || !existsSync(join(dir, "app.json"))) return null; } catch { return null; }
    let text = "";
    try { text = readFileSync(join(dir, "app.json"), "utf8"); } catch (cause) { return { id, dir, error: `app.json is not readable: ${cause instanceof Error ? cause.message : cause}` }; }
    const { manifest, problems } = checkManifest(text, id);
    if (manifest) return { id, dir, manifest };
    return { id, dir, error: problems.filter((p) => p.level === "error").map((p) => `${p.where}: ${p.problem}`).join("; ").slice(0, 500) };
  }

  /** Read one app's folder again (an agent may just have written or changed it). */
  private rediscover(id: string): void {
    const root = this.root;
    if (!root || !ID.test(id)) return;
    const item = this.readFolder(root, id);
    if (item) this.found.set(id, item); else this.found.delete(id);
  }

  /** A folder of the apps root as the agent sees it. */
  agentPath(folder: string): string {
    const root = this.options.launcher?.agentRoot ?? this.options.launcher?.root ?? "/root/apps";
    return `${root.replace(/\/+$/, "")}/${folder}`;
  }

  /** Rediscover; start what is installed and enabled, stop what disappeared, restart what changed version. */
  async refresh(): Promise<void> {
    this.found = this.discover();
    for (const id of [...this.running.keys()]) {
      const item = this.found.get(id);
      const grant = this.grants.get(id);
      if (!item || !("manifest" in item) || !grant?.enabled) await this.stop(id);
      else if (item.manifest.version !== this.running.get(id)!.manifest.version) await this.stop(id);
    }
    for (const [id, item] of this.found) if ("manifest" in item && this.grants.get(id)?.enabled && !this.running.has(id)) await this.launch(id);
  }

  manifest(id: string): AppJson | null { const item = this.found.get(id); return item && "manifest" in item ? item.manifest : null; }
  dir(id: string): string | null { return this.found.get(id)?.dir ?? null; }
  isRunning(id: string): boolean { return Boolean(this.running.get(id)?.online); }
  has(id: string): boolean { return this.found.has(id); }

  /** Shipped with the hub (seeded), written by an agent (publisher agent:…, never published), or anyone else. */
  origin(id: string): AppOrigin {
    if (this.grants.get(id)?.builtin) return "builtin";
    return /^agent(?::|$)/.test(this.manifest(id)?.publisher ?? "") ? "agent" : "other";
  }

  /**
   * One app, from the folder and the install record. An app that is installed (a record in `apps_installed`) is described even
   * when its folder is not (yet) found: `granted` is the record's, not the scan's. Only an id with neither is null.
   */
  info(id: string): AppInfo | null {
    const item = this.found.get(id);
    const grant = this.grants.get(id);
    if (!item && !grant) return null;
    const state = this.running.get(id);
    const error = item && "error" in item ? item.error : item ? this.lastError.get(id) : "应用文件夹不在了（只剩安装记录）：恢复文件夹，或点「收回全部权限」把它卸掉";
    const problem = !error ? undefined : !item ? "folder" as const : "error" in item ? "manifest" as const : "run" as const;
    const m = item && "manifest" in item ? item.manifest : null;
    return {
      id, name: m?.name ?? id, version: m?.version ?? "", summary: m?.summary ?? "", role: m?.role ?? m?.summary ?? "", publisher: m?.publisher ?? "",
      enabled: Boolean(grant?.enabled), granted: Boolean(grant), running: Boolean(state?.online),
      needs: grant?.needs ?? m?.needs ?? [], surfaces: m?.surfaces ?? [], events: m?.events ?? [], tools: state ? [...state.tools] : [],
      listens: grant?.listens ?? [], ...(error ? { error, problem } : {}), ...(state?.online && this.badges.has(id) ? { badge: this.badges.get(id)! } : {}), path: this.agentPath(id), origin: this.origin(id),
    };
  }
  /** An app's own dot: `ok` takes it away. */
  setBadge(id: string, tone: "ok" | "warn" | "err" | "paused"): { tone: string } {
    if (tone === "ok") this.badges.delete(id); else this.badges.set(id, tone);
    return { tone };
  }
  /** Every app with a folder and every installed app (a record without a folder is listed too, with `error` saying so, so it can be removed). */
  list(): AppInfo[] { return [...new Set([...this.found.keys(), ...this.grants.ids()])].sort().map((id) => this.info(id)!); }

  // ---- starting and stopping one app --------------------------------------------------------------------------------

  private appCaller(id: string): Caller { return { member: `app:${id}`, via: "app", local: false }; }

  /** One or more lines of an app's output, kept for apps.logs (bounded). */
  private note(id: string, text: string, stream: "stderr" | "ash"): void {
    let log = this.output.get(id);
    if (!log) { log = { lines: [], exit: null }; this.output.set(id, log); }
    const time = new Date(this.now()).toLocaleTimeString("zh-CN", { hour12: false });
    for (const line of text.split(/\r?\n/)) if (line.trim()) log.lines.push(`${time} ${stream === "ash" ? "[Ash] " : ""}${line.slice(0, LOG_LINE_CHARS)}`);
    if (log.lines.length > LOG_LINES) log.lines.splice(0, log.lines.length - LOG_LINES);
  }

  private async launch(id: string): Promise<void> {
    if (this.closed || this.running.has(id)) return;
    const manifest = this.manifest(id);
    const launcher = this.options.launcher;
    const dir = this.dir(id);
    if (!manifest || !launcher || !dir) return;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    // The app's own data folder exists before it starts.
    if (manifest.data_dir) { try { mkdirSync(join(dir, manifest.data_dir), { recursive: true }); } catch { /* the app reports it */ } }
    const token = this.bridge.bind(id);
    const spec = launcher.spawn(manifest, dir, { ASH_APP_ID: id, ASH_APP_DIR: this.agentPath(id), ASH_MCP_URL: this.bridge.url, ASH_MCP_TOKEN: token });
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, ...(spec.cwd ? { cwd: spec.cwd } : {}), stderr: "pipe" });
    transport.stderr?.on("data", (chunk) => { this.log(`[app ${id}]`, String(chunk).trim().slice(0, 500)); this.note(id, String(chunk), "stderr"); });
    const client = new Client({ name: "ash", version: "1.0.0" });
    const state: Running = { id, client, transport, manifest, online: false, stopping: false, started: this.now(), tools: new Set(), hasOnEvent: false, queued: 0, chain: Promise.resolve() };
    this.running.set(id, state);
    client.onclose = () => { if (this.running.get(id) === state) void this.exited(id, state); };
    client.onerror = (error) => this.note(id, `MCP：${error instanceof Error ? error.message : error}（stdout 只能写协议消息，日志写 stderr）`, "ash");
    this.note(id, `启动 ${manifest.version}：${spec.command} ${spec.args.join(" ")}`.slice(0, 300), "ash");
    try {
      await client.connect(transport, { timeout: 60_000 });
      (transport as unknown as { _process?: import("node:child_process").ChildProcess })._process?.once("exit", (code, signal) => {
        const reason = state.stopping ? "Ash 让它停下" : code === 0 ? "自己退出了" : signal ? `被信号 ${signal} 结束` : `出错退出（退出码 ${code}）`;
        const log = this.output.get(id);
        if (log) log.exit = { ts: this.now(), code, signal, reason };
        this.note(id, `服务结束：${reason}`, "ash");
      });
      const listed = (await client.listTools(undefined, { timeout: 60_000 })).tools as McpTool[];
      if (this.running.get(id) !== state) return; // stopped while starting
      this.register(state, listed);
      this.lastError.delete(id);
      this.log("app started", id, manifest.version, [...state.tools].join(","));
    } catch (error) {
      this.lastError.set(id, `start failed: ${error instanceof Error ? error.message : error}`.slice(0, 300));
      this.note(id, `没有启动起来：${error instanceof Error ? error.message : error}`, "ash");
      this.log("app failed to start", id, error instanceof Error ? error.message : error);
      if (this.running.get(id) === state) await this.exited(id, state);
    }
  }

  /** Words = the tools that can be registered, plus the events the app declared. The member joins the registry. */
  private register(state: Running, listed: McpTool[]): void {
    const { id, manifest } = state;
    const contracts: WordContract[] = [];
    for (const tool of listed) {
      if (tool.name === ASH_ON_EVENT_TOOL) { state.hasOnEvent = true; continue; }
      const bad = toolProblem(tool);
      if (bad) { this.log("app tool rejected", id, tool.name, bad); continue; }
      if (state.tools.has(tool.name)) continue;
      state.tools.add(tool.name);
      contracts.push(appToolContract(id, tool, manifest.name));
    }
    for (const name of manifest.events ?? []) {
      if (state.tools.has(name)) continue;
      contracts.push({
        member: `app:${id}`, word: name, kind: "event", direction: "out", effect: "read", risk: "none", record: true, callers: [...DEFAULT_CALLERS],
        description: `Event ${name} reported by the app ${manifest.name}.`, input_schema: { type: "object" }, label: { doing: `在报告 ${name}` },
      });
    }
    const runtime = this;
    const member: Member = {
      id: `app:${id}`, kind: "app", name: manifest.name,
      // Read live: revoking `listens` takes effect at once, and an edited app.json widens nothing until the owner approves it.
      get listens() { return runtime.approvedListens(id, state.manifest); },
      words: () => structuredClone(contracts),
      handle: (msg, ctx) => runtime.handleMessage(state, msg, ctx),
    };
    state.online = true;
    this.options.registry.add(member);
  }

  /** What the app listens to: the events in app.json that the owner approved. */
  private approvedListens(id: string, manifest: AppJson): string[] {
    const approved = new Set(this.grants.get(id)?.listens ?? []);
    return (manifest.listens ?? []).filter((item) => approved.has(item));
  }

  /** A request is a tool call; an event is handed to the reserved tool `ash.on_event`. */
  private async handleMessage(state: Running, msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    if (!state.online) throw fail("offline", `app:${state.id} is not running`);
    if (msg.kind === "event") {
      // An app does not hear its own events.
      if (msg.from !== `app:${state.id}`) this.deliver(state, msg);
      return;
    }
    if (!state.tools.has(msg.word)) throw fail("not_found", `app:${state.id} has no tool ${msg.word}`);
    return this.callTool(state, msg.word, ctx.raw && typeof ctx.raw === "object" ? ctx.raw as Record<string, unknown> : (msg.body as Record<string, unknown>) ?? {}, ctx.signal);
  }

  private async callTool(state: Running, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<WordResult> {
    try {
      const result = await state.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 590_000 });
      const content = mcpContent(result.content);
      if (result.isError) throw fail("failed", content.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim().slice(0, 2000) || "the app's tool failed");
      const data = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : undefined;
      return { ...(data === undefined ? {} : { data }), ...(content.length ? { content } : {}) };
    } catch (error) {
      if (error instanceof WordError) throw error;
      if (signal.aborted) throw fail("cancelled", "call cancelled");
      if (state.stopping || !state.online) throw fail("offline", `app:${state.id} is not running`);
      throw fail("failed", error instanceof Error ? error.message.slice(0, 500) : "app call failed");
    }
  }

  /** Hand one event to the app, in order; a slow or stuck app loses events rather than holding the hub up. */
  private deliver(state: Running, msg: Message): void {
    if (!state.hasOnEvent) return;
    if (state.queued >= EVENT_QUEUE_MAX) { this.log("app event dropped", state.id, msg.word); return; }
    state.queued++;
    const arguments_ = { word: msg.word, body: msg.body, from: msg.from, at: msg.ts };
    state.chain = state.chain.then(async () => {
      if (!state.online) return;
      await state.client.callTool({ name: ASH_ON_EVENT_TOOL, arguments: arguments_ }, undefined, { timeout: ON_EVENT_TIMEOUT_MS });
    }).catch((error) => this.log("app on_event failed", state.id, msg.word, error instanceof Error ? error.message : error))
      .finally(() => { state.queued--; });
  }

  /** The server went away: leave the registry, and restart with backoff (1 s, doubling, at most a minute). */
  private async exited(id: string, state: Running): Promise<void> {
    if (state.stopping || this.running.get(id) !== state) return;
    state.online = false;
    this.running.delete(id);
    this.options.registry.remove(`app:${id}`);
    this.bridge.unbind(id);
    try { await state.client.close(); } catch { /* already gone */ }
    if (this.closed) return;
    const failures = this.now() - state.started > 120_000 ? 1 : (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, failures);
    const delay = this.options.backoffMs?.(failures) ?? Math.min(60_000, 1000 * 2 ** (failures - 1));
    this.log("app exited; restarting", id, `in ${delay} ms`);
    this.note(id, `服务停了，${Math.round(delay / 100) / 10} 秒后重启（第 ${failures} 次）`, "ash");
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => { this.timers.delete(id); if (!this.closed && this.grants.get(id)?.enabled) void this.launch(id); }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  async stop(id: string): Promise<void> {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const state = this.running.get(id);
    this.bridge.unbind(id);
    this.options.registry.remove(`app:${id}`);
    if (!state) return;
    state.stopping = true;
    state.online = false;
    this.running.delete(id);
    try { await state.client.close(); } catch { /* already gone */ }
  }

  // ---- what an app says -------------------------------------------------------------------------------------------

  /**
   * An event from app <id>: the router refuses one app.json does not declare. It goes out as an event from `app:<id>` (the router
   * records it and delivers it to whoever listens); a `wake_events` entry also wakes its agent, a few times a day at most.
   */
  async emit(id: string, name: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }> {
    // The manifest the app was started with: an edit on disk changes nothing until it is restarted.
    const manifest = this.running.get(id)?.manifest;
    if (!manifest) return { ok: false, code: "offline", message: "app not running" };
    if (JSON.stringify(body).length > EVENT_BODY_MAX) return { ok: false, code: "too_large", message: "event body too large" };
    const caller = this.appCaller(id);
    const sent = await this.options.router.send({ to: null, kind: "event", word: name, body }, caller);
    if (!sent.ok) return { ok: false, code: sent.error.code, message: sent.error.message };
    const targets = [...new Set(wakeEvents(manifest).filter((item) => item.event === name).map((item) => item.agent ?? this.options.primaryAgent()))];
    if (targets.length && this.grants.take(id, "wake", WAKES_A_DAY)) {
      const context = { app: `app:${id}`, name: manifest.name, role: manifest.role ?? manifest.summary, event: name, body };
      for (const agent of targets) {
        // From the app edge itself: the owner approved on the install card that these events wake that agent.
        void this.options.router.send({ to: agent, kind: "request", word: "wake", body: { reason: "app_event", context } }, SERVICE_CALLER)
          .then((reply) => { if (!reply.ok) this.log("app event wake failed", id, name, agent, reply.error.message); },
            (error) => this.log("app event wake failed", id, name, agent, error instanceof Error ? error.message : error));
      }
    }
    return { ok: true };
  }

  // ---- install and the other words ----------------------------------------------------------------------------------

  /**
   * The hub's own organs are installed without a card: the owner's hub is installing its own parts. The release decides, but
   * only while the folder is exactly the release (`builtinExact`): then the grants follow its app.json (version, needs,
   * listens). What the agent wrote into a built-in app never widens anything: a folder it changed keeps the grants it has, and
   * gets no first grant (that goes through apps.install). Whether the app is switched on stays the owner's. An app the owner installed
   * by hand under the same id is left alone.
   */
  seedBuiltin(id: string): void {
    const manifest = this.manifest(id);
    if (!manifest) { this.log("builtin app not found", id); return; }
    const had = this.grants.get(id);
    // A folder that is not the release gets nothing from its own app.json, not even a first grant: what the agent wrote
    // there goes through apps.install and the owner's card like any app.
    if (!had && this.options.builtinExact && !this.options.builtinExact.has(id)) { this.log("builtin app not granted: the folder is not the release", id); return; }
    if (had) {
      const same = (items: readonly unknown[]) => JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
      if (!had.builtin || !this.options.builtinExact?.has(id)) return;
      if (had.version === manifest.version && same(had.needs) === same(manifest.needs ?? []) && same(had.listens) === same(manifest.listens ?? [])) return;
      this.log("builtin app granted again", id, `${had.version} -> ${manifest.version}`);
    }
    this.grants.grant(id, manifest.version, manifest.needs ?? [], manifest.listens ?? [], { builtin: true });
    if (had && !had.enabled) this.grants.setEnabled(id, false);
  }

  /** What the install approval card says about the app: everything it asks for and what its events do. */
  private installDetail(manifest: AppJson, origin: AppOrigin): string {
    const lines = (manifest.needs ?? []).map((need) => ("member" in need
      ? `· ${clean(need.why, 200)}（${need.member}：${need.words.join("、")}）`
      : "credential" in need ? `· ${clean(need.why, 200)}（用保险箱里的「${need.credential}」：它能以你的身份调用这个服务）`
      : `· ${clean(need.why, 200)}（${({ notify: "提醒你", widgets: "小组件", card: "在对话里放入口卡片" } as Record<string, string>)[needKey(need)]}）`));
    const who = origin === "builtin" ? "Ash 自带" : origin === "agent" ? "Ash 自己写的，没有发布过，也没有别人检查过" : `发布者写的是「${clean(manifest.publisher, 40)}」，Ash 无法核实`;
    const listens = manifest.listens ?? [];
    const wakes = wakeEvents(manifest);
    return `${clean(manifest.name, 40)} ${manifest.version}（${who}）：${clean(manifest.summary, 200)}\n它需要：\n${lines.length ? lines.join("\n") : "· 不需要用 Ash 的其他东西"}\n` +
      (listens.length ? `它要实时收到这些事件：${listens.join("、")}\n` : "") +
      (wakes.length ? `这些事件发生时它会叫醒 agent：${wakes.map((item) => `${item.event}${item.agent ? ` → ${item.agent}` : ""}`).join("、")}\n` : "") +
      `批准后它在容器里运行（文件在 ${this.agentPath(manifest.id)}/），成为 app:${manifest.id}；可以随时撤销。`;
  }

  /**
   * The text the gate adds to the approval card of an `apps.install`, and a note (in memory) of exactly what the owner is
   * shown: the needs and listens. Null when there is no such app.
   */
  cardDetail(id: string, request: string): string | null {
    this.rediscover(id);
    const manifest = this.manifest(id);
    if (!manifest) return null;
    this.shown.set(request, JSON.stringify([manifest.needs ?? [], manifest.listens ?? []]));
    while (this.shown.size > 64) this.shown.delete(this.shown.keys().next().value!);
    return this.installDetail(manifest, /^agent(?::|$)/.test(manifest.publisher) ? "agent" : this.grants.get(id)?.builtin ? "builtin" : "other");
  }

  /**
   * apps.install: the folder is checked and tried first (a broken app never reaches the owner), then the grants are
   * stored and the app starts. The owner's approval is the gate's card (see `cardDetail`); the owner installing by hand
   * is the approval itself. For an agent's install the approval is for the needs and listens on the card: if they are
   * different now, or the card is not remembered (the hub restarted), nothing is installed.
   */
  async install(id: string, caller: Caller, request: string): Promise<AppInfo> {
    this.rediscover(id);
    const first = this.manifest(id);
    if (!first) {
      if (!this.found.has(id)) throw fail("not_found", `${this.agentPath(id)}/ 下没有应用（没有 app.json）；apps.list 看有哪些，apps.scaffold 新建一个`);
      throw this.refusal(await this.validate({ id }));
    }
    const report = await this.validate({ id });
    if (!report.ok) throw this.refusal(report);
    this.rediscover(id);
    const manifest = this.manifest(id) ?? first;
    if (caller.member !== OWNER_ID) {
      const shown = this.shown.get(request);
      this.shown.delete(request);
      // The gate always asks the owner for an agent's install, and the card is remembered under the request's id (a redeem keeps it).
      if (shown === undefined)
        throw fail("conflict", "这次安装没有经过主人的审批卡（或中枢重启过，卡片记录没了）；没有安装", { recovery_hint: "Call apps.install again; the owner will be asked." });
      if (shown !== JSON.stringify([manifest.needs ?? [], manifest.listens ?? []]))
        throw fail("conflict", `${this.agentPath(id)}/app.json 的 needs 或 listens 在主人批准之后变了；没有安装`, { recovery_hint: "Call apps.install again so the owner sees the current ones." });
    }
    await this.stop(id);
    this.grants.grant(id, manifest.version, manifest.needs ?? [], manifest.listens ?? []);
    this.failures.delete(id);
    await this.launch(id);
    return this.info(id)!;
  }

  /** The static half of the check, for the service's `precheck`: null when the folder looks installable, else the report. */
  precheckInstall(id: string): AppReport | null {
    const root = this.root;
    if (!root || !ID.test(id)) return null;
    this.rediscover(id);
    if (!this.found.has(id)) return { id, path: this.agentPath(id), ok: false, tools: [], surfaces: [], problems: [{ level: "error", where: "文件夹", problem: "这个文件夹不存在或没有 app.json", fix: "先用 apps.scaffold 生成，或自己建应用文件夹" }] };
    const { problems } = checkFolder(join(root, id), id);
    return problems.some((item) => item.level === "error") ? { id, path: this.agentPath(id), ok: false, tools: [], surfaces: [], problems } : null;
  }

  /** The error an install or restart is refused with: what is wrong, and the whole list in detail.problems. */
  refusal(report: AppReport): WordError {
    const errors = report.problems.filter((item) => item.level === "error");
    const text = `应用 ${report.id || report.path} 没通过检查，没有安装（${errors.length} 个问题）：` + errors.map((item, index) => `${index + 1}) ${item.where}：${item.problem}`).join("；");
    return fail("failed", text.length > 480 ? `${text.slice(0, 470)}…（全部见 detail.problems）` : text,
      { detail: { path: report.path, problems: report.problems }, recovery_hint: "Fix the listed problems in the app's folder, then try again." });
  }

  /** apps.validate: the folder (by id, or a path under the apps folder) checked as install would, then tried once. */
  async validate(target: { id?: string; path?: string }): Promise<AppReport> {
    const root = this.root;
    const agentRoot = (this.options.launcher?.agentRoot ?? root ?? "/root/apps").replace(/\/+$/, "");
    let folder = target.id ?? "";
    if (!folder && target.path) {
      const path = target.path.replace(/\/+$/, "");
      for (const base of [agentRoot, root]) if (base && path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes("/")) folder = path.slice(base.length + 1);
      if (!folder) return { id: "", path: target.path, ok: false, tools: [], surfaces: [],
        problems: [{ level: "error", where: "path", problem: `只检查 ${agentRoot}/ 下的应用文件夹`, fix: `把应用放在 ${agentRoot}/<id>/，再传 id 或这个路径` }] };
    }
    const report = (problems: AppProblem[], tools: string[] = [], surfaces: string[] = [], id = folder): AppReport =>
      ({ id, path: this.agentPath(folder), ok: !problems.some((item) => item.level === "error"), problems, tools, surfaces });
    if (!folder || folder === "." || folder === ".." || folder.includes("/")) return report([{ level: "error", where: "id", problem: "要给 id 或 path" }]);
    if (!root) return report([{ level: "error", where: "应用文件夹", problem: "应用文件夹还没准备好，现在检查不了" }]);
    const dir = join(root, folder);
    const { manifest, problems } = checkFolder(dir, folder);
    if (ID.test(folder)) this.rediscover(folder);
    if (!manifest) return report(problems);
    for (const need of manifest.needs ?? []) {
      if (!("member" in need) || need.member.includes("*")) continue;
      const described = this.options.registry.describe(need.member);
      if (!described) problems.push({ level: "warning", where: `app.json needs ${need.member}`, problem: `现在没有成员 ${need.member}（可能不在线）：装上后调用会失败，直到它回来` });
      else {
        const have = described.words.filter((word) => word.kind === "request").map((word) => word.word);
        const missing = need.words.filter((word) => !have.includes(word));
        if (missing.length) problems.push({ level: "warning", where: `app.json needs ${need.member}`, problem: `${need.member} 现在没有 ${missing.join("、")}（可能拼错了，或暂时不在线）`, fix: "用 capability_list 看它有哪些词" });
      }
    }
    if (problems.some((item) => item.level === "error")) return report(problems, [], [], manifest.id);
    const spec = this.options.launcher!.spawn(manifest, dir, { ASH_APP_ID: manifest.id, ASH_APP_DIR: this.agentPath(folder), ASH_MCP_URL: this.bridge.url, ASH_MCP_TOKEN: "trial-run", ASH_TRIAL: "1" });
    const trial = await trialRun(manifest, spec, this.options.trialMs);
    return report([...problems, ...trial.problems], trial.tools, trial.surfaces, manifest.id);
  }

  /** Thrown when a word needs the app's folder and an install record is all there is. */
  private missingFolder(id: string): WordError {
    return this.grants.get(id)
      ? fail("not_found", `${this.agentPath(id)}/ 下没有应用文件夹（${id} 还有安装记录）：恢复这个文件夹，或用 apps.remove 卸掉它`, { recovery_hint: "apps.remove {id} clears the install record." })
      : fail("not_found", `no app ${id}`);
  }

  async enable(id: string): Promise<AppInfo> {
    if (!this.manifest(id)) throw this.missingFolder(id);
    if (!this.grants.setEnabled(id, true)) throw fail("failed", "not installed; use apps.install", { recovery_hint: "apps.install asks the owner and starts it." });
    await this.launch(id);
    return this.info(id)!;
  }

  async disable(id: string): Promise<AppInfo> {
    if (!this.found.has(id) && !this.grants.get(id)) throw fail("not_found", `no app ${id}`);
    this.grants.setEnabled(id, false);
    await this.stop(id);
    return this.info(id)!;
  }

  /** Take back a grant. An installed app whose folder is gone can be revoked too: there is only the record to narrow. */
  async revoke(id: string, need?: string): Promise<AppInfo> {
    if (!this.found.has(id) && !this.grants.get(id)) throw fail("not_found", `no app ${id}`);
    const before = this.info(id)!;
    const left = this.grants.revoke(id, need);
    if (!left) { await this.stop(id); await this.dropTimers(id); }
    // Revoked completely and no folder: nothing is left to describe, so say what it was, no longer granted.
    return this.info(id) ?? { ...before, enabled: false, granted: false, running: false, needs: [], listens: [], tools: [] };
  }

  /** Restart after editing. Within what the owner approved: if needs or listens grew, it has to be installed again. */
  async restart(id: string): Promise<{ id: string; running: boolean; problems: AppProblem[] }> {
    this.rediscover(id);
    const grant = this.grants.get(id);
    if (!this.found.has(id)) throw this.missingFolder(id);
    if (!grant) throw fail("failed", `${id} 还没装：用 apps.install`);
    if (!grant.enabled) throw fail("failed", `${id} 停用了：用 apps.enable 重新打开`);
    const report = await this.validate({ id });
    const manifest = this.manifest(id);
    if (!report.ok || !manifest) throw this.refusal(report);
    const grew = (a: AppNeed[], b: AppNeed[]) => JSON.stringify(a.map(needKey).sort()) !== JSON.stringify(b.map(needKey).sort()) || JSON.stringify(a) !== JSON.stringify(b);
    const listensGrew = (manifest.listens ?? []).some((item) => !grant.listens.includes(item));
    if (grew(manifest.needs ?? [], grant.needs) || listensGrew)
      throw fail("failed", `${this.agentPath(id)}/app.json 的 needs 或 listens 和主人批准的不一样了：要用 apps.install 让主人重新批准，没有重启`);
    await this.stop(id);
    this.failures.delete(id);
    await this.launch(id);
    if (!this.isRunning(id)) throw fail("failed", `重启了但没起来：${this.info(id)?.error ?? "原因见 apps.logs"}`);
    return { id, running: true, problems: report.problems };
  }

  /** apps.logs: the server's recent stderr and the hub's notes on it, and how it last ended. */
  logs(id: string, lines = 100): { id: string; running: boolean; lines: string[]; last_exit: LastExit | null; error?: string } {
    if (!this.found.has(id)) throw fail("not_found", `no app ${id}; apps.list shows what exists`);
    const log = this.output.get(id);
    const item = this.found.get(id)!;
    const error = this.lastError.get(id) ?? ("error" in item ? item.error : undefined);
    return { id, running: this.isRunning(id), lines: (log?.lines ?? []).slice(-Math.max(1, Math.min(LOG_LINES, lines))), last_exit: log?.exit ?? null, ...(error ? { error } : {}) };
  }

  /** The app's data folder (app.json data_dir) on this machine, or why there is none. */
  private dataDir(id: string): string {
    const manifest = this.manifest(id), dir = this.dir(id);
    if (!manifest || !dir) throw fail("not_found", `no app ${id}`);
    if (!manifest.data_dir) throw fail("failed", `${this.agentPath(id)}/app.json 没写 data_dir：Ash 不知道哪些文件是它的数据。把数据放进一个子文件夹（如 data/），在 app.json 写 "data_dir": "data"`);
    const data = join(dir, manifest.data_dir);
    try { if (lstatSync(data).isSymbolicLink()) throw fail("failed", `${manifest.data_dir} 是一个链接，Ash 不去清它指向的地方`); } catch (error) { if (error instanceof WordError) throw error; /* not there yet */ }
    return data;
  }

  async reset(id: string): Promise<{ id: string; cleared: string }> {
    if (!this.found.has(id)) throw fail("not_found", `no app ${id}`);
    const data = this.dataDir(id);
    const was = this.running.has(id);
    await this.stop(id);
    rmSync(data, { recursive: true, force: true });
    mkdirSync(data, { recursive: true });
    this.note(id, "数据清空了（apps.reset）", "ash");
    if (was && this.grants.get(id)?.enabled) await this.launch(id);
    return { id, cleared: `${this.agentPath(id)}/${this.manifest(id)!.data_dir}` };
  }

  /**
   * The app is no longer installed (removed, or all its grants taken back): the timers it set in `service:clock` go out as the
   * app and could only be refused from now on, so the clock takes them back. A failure is only logged; the clock does the same
   * by itself the first time one of them is refused. Disabling an app keeps its grants and its timers.
   */
  private async dropTimers(id: string): Promise<void> {
    try {
      const reply = await this.options.router.send({ to: "service:clock", kind: "request", word: "cancel.owner", body: { member: `app:${id}` } }, SERVICE_CALLER);
      if (!reply.ok) this.log("apps: clearing the timers of", id, reply.error.code, reply.error.message);
    } catch (error) { this.log("apps: clearing the timers of", id, error instanceof Error ? error.message : error); }
  }

  /** Remove an app: its record and grants, its timers, and (unless keepData) its folder. An installed app whose folder is gone is removed too; there is no folder to delete. */
  async remove(id: string, keepData: boolean): Promise<{ id: string; removed: boolean; kept: string | null }> {
    if (!this.found.has(id) && !this.grants.get(id)) throw fail("not_found", `no app ${id}`);
    if (this.grants.get(id)?.builtin) throw fail("failed", `${id} 是 Ash 自带的器官：用 apps.disable 停用它（apps.reset 清空它的数据）`);
    await this.stop(id);
    this.grants.revoke(id);
    await this.dropTimers(id);
    const root = this.root;
    if (!this.found.has(id)) { this.output.delete(id); return { id, removed: true, kept: null }; } // only the record was left
    if (!keepData && root && ID.test(id)) {
      rmSync(join(root, id), { recursive: true, force: true });
      this.found.delete(id);
      this.output.delete(id);
      return { id, removed: true, kept: null };
    }
    this.note(id, "卸载了，文件夹留着（keep_data）", "ash");
    return { id, removed: true, kept: this.agentPath(id) };
  }

  icon(id: string): { mime: string; data: string } {
    const manifest = this.manifest(id);
    if (!manifest) throw fail("not_found", `no app ${id}`);
    if (!manifest.icon) return { ...DEFAULT_APP_ICON };
    const file = join(this.dir(id)!, manifest.icon);
    try { return { mime: MIME[extname(file).toLowerCase()] ?? "application/octet-stream", data: readFileSync(file).toString("base64") }; } catch { return { ...DEFAULT_APP_ICON }; }
  }

  /** Read a surface (a ui:// resource) of a running app. */
  async surface(id: string, surfaceId: string): Promise<{ mime: string; html: string; csp: { connectDomains: string[]; resourceDomains: string[] } }> {
    const manifest = this.manifest(id);
    if (!manifest) throw fail("not_found", `no app ${id}`);
    const surface = manifest.surfaces?.find((item) => item.id === surfaceId);
    if (!surface) throw fail("not_found", `${id} has no surface ${surfaceId}`);
    const state = this.running.get(id);
    if (!state?.online) throw fail("offline", `app:${id} is not running`, { recovery_hint: "apps.enable or apps.restart starts it." });
    let read: Awaited<ReturnType<Client["readResource"]>>;
    try { read = await state.client.readResource({ uri: surface.resource }, { timeout: 30_000 }); } catch (error) { throw fail("failed", `could not read ${surface.resource}: ${error instanceof Error ? error.message.slice(0, 300) : error}`); }
    const content = (read.contents ?? []).find((item) => item.uri === surface.resource) ?? read.contents?.[0];
    if (!content) throw fail("failed", `${surface.resource} returned nothing`);
    const html = typeof (content as { text?: unknown }).text === "string" ? String((content as { text: string }).text)
      : typeof (content as { blob?: unknown }).blob === "string" ? Buffer.from(String((content as { blob: string }).blob), "base64").toString("utf8") : "";
    const csp = (content as { _meta?: { ui?: { csp?: Record<string, unknown> } } })._meta?.ui?.csp ?? {};
    const domains = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 32) : []);
    return { mime: content.mimeType ?? UI_MIME, html, csp: { connectDomains: domains(csp.connectDomains), resourceDomains: domains(csp.resourceDomains) } };
  }

  /** apps.scaffold: a new app's files, written only where nothing would be overwritten. */
  scaffold(body: { id: string; name: string; summary?: string; role?: string; surfaces?: ScaffoldSurface[]; tools?: ScaffoldTool[] }, publisher: string): { id: string; path: string; files: string[]; next: string } {
    const root = this.root;
    if (!root) throw fail("unavailable", "应用文件夹还没准备好");
    const path = this.agentPath(body.id);
    const dupe = (list: string[]) => list.find((item, index) => list.indexOf(item) !== index);
    const surface = dupe((body.surfaces ?? []).map((item) => item.id)), tool = dupe((body.tools ?? []).map((item) => item.name));
    if (surface) throw fail("bad_request", `surfaces 里 ${surface} 重复了`);
    if (tool) throw fail("bad_request", `tools 里 ${tool} 重复了`);
    const dir = join(root, body.id);
    if (existsSync(join(dir, "app.json"))) throw fail("conflict", `${path}/app.json 已经有了：直接改那个应用，或换一个 id`);
    const files = scaffoldFiles({ ...body, publisher });
    const clash = Object.keys(files).filter((name) => existsSync(join(dir, name)) && name !== "data/.keep");
    if (clash.length) throw fail("conflict", `${path}/ 里已经有 ${clash.join("、")}：换一个 id，或先挪走它们`);
    // app.json last: a half-written folder is never discovered as an app.
    for (const name of [...Object.keys(files).filter((item) => item !== "app.json"), "app.json"]) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), files[name]!, { mode: 0o644 });
    }
    this.rediscover(body.id);
    return { id: body.id, path, files: Object.keys(files).sort(),
      next: `改 ${path}/server.mjs 里的 TOOLS 和 handle()，和 ui/ 下的页面；要用手机等能力就在 app.json 的 needs 里写上。然后 apps.validate {id:"${body.id}"} 检查，apps.install {id:"${body.id}"} 安装（主人批准它要的东西）。契约全文：apps.contract。` };
  }

  contract(): { doc: string; docPath: string } {
    return { doc: this.options.contract?.doc ?? "", docPath: this.options.contract?.docPath ?? this.agentPath("APP-CONTRACT.md") };
  }
}

export type { AppGrant };
