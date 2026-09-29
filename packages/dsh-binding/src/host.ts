// DSH host: ash boots DSH's *core* (profile "ash" = @deepseek-ai/dsh-base only — no web app,
// no DSH UI) inside ash core's process, through DSH's public host entry
// (`@deepseek-ai/dsh/profile-boot`, the one DSH's desktop app uses). DSH stays byte-for-byte
// as published; ash only uses its public seams.
//
// The binding reaches deep, but it stays a bridge:
//   agents        ctx.agents create/resume, followup/steer/inject/cancel     (control plane)
//   events        session/event feed → ash event log
//   loop gate     agent/pre-step        → AgentPort.gateStep
//   tool gate     tools/pre-execute     → AgentPort.gateTool (sensitive tools, by message origin)
//   approvals     approval/request      → the owner, through ash confirmations
//   context       systemPrompt.section / .context  → identity, devices, timers owned by ash
//   tools         ctx.tools.register    → ash_* system tools + device capabilities (live)
//   services      ctx.ash               → the AgentPort resolver for other DSH plugins
//   settings      credentials / agentDefaultModel → the ash settings page

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentPort } from "../../core/src/runtime";
import { installDoor } from "./door";

export interface DshHostOptions {
  /** Directory of the installed @deepseek-ai/dsh package. */
  root: string;
  /** DSH home used by ash's DSH world (credentials, settings, sessions, plugins). */
  home: string;
  /** Another DSH home to copy credentials/settings from on first start (e.g. an earlier install). */
  seedFrom?: string;
  /** Host-owned patch layers (cordis.patch.yml documents) applied over the profile, e.g. the Android layer. */
  patchFiles?: string[];
  /** Environment DSH reads at boot (e.g. DSH_PERMISSION_MODE on Android, where no sandbox runner exists). */
  env?: Record<string, string>;
}

/** Minimal views of the DSH objects ash touches (DSH has its own full typings). */
export interface DshAgent {
  id: string;
  session?: unknown;
  followup(m: DshUserMessage): void;
  steer(m: DshUserMessage): void;
  inject(m: DshUserMessage): void;
  cancel(cause?: unknown): void;
  whenIdle(): Promise<void>;
}
export interface DshUserMessage {
  id: string;
  role: "user";
  content: { type: "text"; text: string }[];
  source: { kind: "user" };
}
export interface DshEvent {
  seq?: number;
  type: string;
  data: Record<string, any>;
}
type SessionListener = (sessionId: string, e: DshEvent) => void;

export class DshHost {
  ctx: any;
  private shutdownHandle: any;
  private readonly listeners = new Set<SessionListener>();
  /** DSH agent objects → the ash agent they belong to (children resolve through their scope chain). */
  private readonly byObject = new WeakMap<object, AgentPort>();
  private readonly byId = new Map<string, AgentPort>();
  private scopeChainOf: (k: object | undefined) => object[] = () => [];
  private req!: NodeRequire;
  private readonly agentHooks: ((port: AgentPort) => void)[] = [];
  version = "";

  constructor(
    private readonly opts: DshHostOptions,
    private readonly log: (...a: unknown[]) => void,
  ) {}

  /** Resolve a module the way DSH itself does (from inside its install). */
  async imp(spec: string): Promise<any> {
    return import(pathToFileURL(this.req.resolve(spec)).href);
  }

  async boot(): Promise<void> {
    const { root, home } = this.opts;
    mkdirSync(home, { recursive: true });
    for (const f of [".credentials.yaml", "settings.yaml"]) {
      if (this.opts.seedFrom && !existsSync(join(home, f)) && existsSync(join(this.opts.seedFrom, f))) copyFileSync(join(this.opts.seedFrom, f), join(home, f));
    }
    const prof = join(home, "profiles", "ash");
    mkdirSync(prof, { recursive: true });
    // The profile is core only. ash owns every surface (UI, channels); DSH brings the agent.
    // Its cordis.patch.yml belongs to DSH's own settings (they persist there); ash never rewrites it.
    writeFileSync(join(prof, "package.json"), JSON.stringify({ name: "dsh-profile-ash", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }, null, 1));
    if (!existsSync(join(prof, "cordis.yml"))) writeFileSync(join(prof, "cordis.yml"), "[]\n");
    if (!existsSync(join(prof, "cordis.patch.yml"))) writeFileSync(join(prof, "cordis.patch.yml"), "[]\n");

    process.env.DSH_HOME = home;
    for (const [k, v] of Object.entries(this.opts.env ?? {})) process.env[k] ??= v;
    this.req = createRequire(join(root, "package.json"));
    this.version = this.req(join(root, "package.json")).version;
    const { loadLayeredEnv } = await this.imp("@deepseek-ai/dsh-app-boot");
    const { runProfile } = await import(pathToFileURL(join(root, "lib", "profile-boot.js")).href);
    const scope = await this.imp("@deepseek-ai/dsh-scope").catch(() => null);
    if (scope?.scopeChainOf) this.scopeChainOf = scope.scopeChainOf;
    const t0 = Date.now();
    const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv("dsh"), profile: "ash", patchFiles: this.opts.patchFiles ?? [], args: [] });
    this.ctx = ctx;
    this.shutdownHandle = shutdown;
    this.log(`DSH ${this.version} core booted in ${Date.now() - t0} ms (profile ash, home ${home})`);
    this.captureLogs(join(home, "logs"));

    await installDoor(this);

    ctx.on("session/event", (session: { id?: string; header?: { id?: string } }, event: DshEvent) => {
      const id = session?.id ?? session?.header?.id ?? "";
      for (const l of this.listeners) l(id, event);
    });
  }

  /** DSH's own warnings and plugin failures go to <home>/logs/dsh.log (replaces the old boot-log patch). */
  private captureLogs(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "dsh.log");
    const write = (level: string, args: unknown[]) => {
      try {
        appendFileSync(file, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
      } catch {
        /* logging must never break the agent */
      }
    };
    // cordis keeps the last messages in a ring buffer (boot-time plugin failures land there) …
    type Msg = { type: string; name: string; args: unknown[] };
    const relevant = (m: Msg) => m.type === "warn" || m.type === "error";
    for (const m of (this.ctx?.logger?.buffer as Msg[] | undefined) ?? []) if (relevant(m)) write(m.type, [`[${m.name}]`, ...m.args]);
    // … and takes exporters for everything after.
    this.ctx?.logger?.exporter?.({ colors: false, export: (m: Msg) => relevant(m) && write(m.type, [`[${m.name}]`, ...m.args]) });
  }

  onSessionEvent(l: SessionListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** The ash agent a DSH agent (or one of its subagents) works for. */
  portOf(agent: { id?: string } | object | undefined): AgentPort | undefined {
    if (!agent) return undefined;
    const direct = this.byObject.get(agent) ?? ((agent as { id?: string }).id ? this.byId.get((agent as { id: string }).id) : undefined);
    if (direct) return direct;
    for (const k of this.scopeChainOf(agent)) {
      const p = this.byObject.get(k);
      if (p) return p;
    }
    return undefined;
  }

  /** Called once per ash agent attached to a DSH agent (the door projects its devices). */
  onAgent(fn: (port: AgentPort) => void): void {
    this.agentHooks.push(fn);
  }

  ports(): AgentPort[] {
    return [...this.byId.values()];
  }

  /** Create or resume one DSH agent (= one durable DSH session) for an ash agent. */
  async agent(port: AgentPort, cwd: string, sessionId?: string): Promise<{ agent: DshAgent; sessionId: string }> {
    const agents = this.ctx.get("agents");
    const agentOptions = this.agentOptions();
    let handle: { agent: DshAgent } | undefined;
    if (sessionId) {
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, agentOptions });
      } catch (e) {
        this.log(`[${port.agentId}] resume of ${sessionId} failed, starting a new session:`, e instanceof Error ? e.message : e);
        sessionId = undefined;
      }
    }
    if (!handle || !sessionId) {
      sessionId = `session-${randomUUID()}`;
      handle = (await agents.create({ sessionId, meta: { cwd }, agentOptions })) as { agent: DshAgent };
    }
    const agent = handle.agent;
    this.byObject.set(agent, port);
    this.byId.set(agent.id, port);
    for (const h of this.agentHooks) h(port);
    return { agent, sessionId };
  }

  agentOptions(): { provider: string; model: string } | undefined {
    const s = this.ctx?.get("agentDefaultModel")?.currentSelection?.();
    return s ? { provider: s.provider, model: s.model } : undefined;
  }

  async stop(): Promise<void> {
    await this.shutdownHandle?.shutdown?.("ash stopping");
  }
}

export const userMessage = (text: string, id: string = randomUUID()): DshUserMessage => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
