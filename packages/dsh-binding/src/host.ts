import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorldMembers } from "../../core/src/world/member";
import type { WorldRouter } from "../../core/src/world/router";
import { createDshDoor, type DoorAgent, type DoorOptions, type DshDoor } from "./door";

export interface DshHostOptions { root: string; home: string; env?: Record<string, string> }
export interface DshRootAgent extends DoorAgent {
  id: string;
  followup(message: { id: string; role: "user"; content: unknown[]; source: { kind: "user" } }): void;
  cancel(cause?: unknown): void;
  whenIdle(): Promise<void>;
}
export interface DshSessionEvent { type: string; data?: Record<string, any> }
export interface DoorTurnAdapter {
  /** Attach the 206 turn lifecycle before this session receives any application input. */
  attach(agent: DshRootAgent, door: DshDoor, sessionId: string): void;
}
export interface MainSession { agent: DshRootAgent; door: DshDoor; sessionId: string }

/** Core-only DSH host. It never installs the retired tool surface or starts an unbound model session. */
export class DshHost {
  ctx: any;
  private shutdownHandle: any;
  private requireFromInstall: NodeRequire;
  private main: MainSession | null = null;
  private readonly listeners = new Set<(sessionId: string, event: DshSessionEvent) => void>();

  constructor(private readonly options: DshHostOptions) {
    this.requireFromInstall = createRequire(join(options.root, "package.json"));
  }

  async imp(spec: string): Promise<any> { return import(pathToFileURL(this.requireFromInstall.resolve(spec)).href); }

  async boot(): Promise<void> {
    if (this.ctx) throw new Error("DSH host already booted");
    const { root, home } = this.options;
    const profile = join(home, "profiles", "ash-v2");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const packageFile = join(profile, "package.json");
    if (existsSync(packageFile)) {
      const current = JSON.parse(readFileSync(packageFile, "utf8")) as { dependencies?: object; dsh?: { profile?: { bundles?: string[] } } };
      if (Object.keys(current.dependencies ?? {}).length || JSON.stringify(current.dsh?.profile?.bundles) !== JSON.stringify(["@deepseek-ai/dsh-base"])) {
        throw new Error("ash-v2 DSH profile must contain only the audited base bundle");
      }
    } else writeFileSync(packageFile, JSON.stringify({ name: "dsh-profile-ash-v2", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }), { mode: 0o600 });
    for (const file of ["cordis.yml", "cordis.patch.yml"]) {
      const path = join(profile, file);
      // The runtime rewrites an empty root with explanatory YAML comments on first boot.
      const entries = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((line) => !/^\s*(?:#.*)?$/.test(line)).join("\n").trim() : "[]";
      if (entries !== "[]") throw new Error("ash-v2 DSH profile has unreviewed plugins or patches");
      if (!existsSync(path)) writeFileSync(path, "[]\n", { mode: 0o600 });
    }
    process.env.DSH_HOME = home;
    for (const [key, value] of Object.entries(this.options.env ?? {})) process.env[key] ??= value;
    const { loadLayeredEnv } = await this.imp("@deepseek-ai/dsh-app-boot");
    const { runProfile } = await import(pathToFileURL(join(root, "lib", "profile-boot.js")).href);
    const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv("dsh"), profile: "ash-v2", patchFiles: [], args: [] });
    this.ctx = ctx;
    this.shutdownHandle = shutdown;
    ctx.on("session/event", (session: { id?: string; header?: { id?: string } }, event: DshSessionEvent) => {
      const id = session?.id ?? session?.header?.id ?? "";
      for (const listener of this.listeners) listener(id, event);
    });
  }

  onSessionEvent(listener: (sessionId: string, event: DshSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The worker's non-session llm service remains available without creating a model agent. */
  llm(): unknown { if (!this.ctx) throw new Error("DSH host not booted"); return this.ctx.get("llm"); }
  agentOptions(): { provider: string; model: string } | undefined {
    const selection = this.ctx?.get("agentDefaultModel")?.currentSelection?.();
    return selection ? { provider: selection.provider, model: selection.model } : undefined;
  }

  async startMain(options: Omit<DoorOptions, "tools" | "scopeChainOf"> & { workspace: string; adapter?: DoorTurnAdapter }): Promise<MainSession> {
    if (!this.ctx) throw new Error("DSH host not booted");
    if (!options.adapter) throw new Error("turn adapter unavailable; no DSH session was created");
    if (this.main) throw new Error("main session already started");
    const scope = await this.imp("@deepseek-ai/dsh-scope");
    if (typeof scope.scopeChainOf !== "function") throw new Error("DSH scope provenance unavailable");
    let door: DshDoor | null = null;
    try {
      const sessionId = `session-${randomUUID()}`;
      const agentOptions = this.agentOptions();
      door = createDshDoor({ tools: this.ctx.tools, members: options.members, router: options.router,
        workspace: options.workspace, managedRoot: options.managedRoot, protectedRoots: options.protectedRoots,
        scopeChainOf: scope.scopeChainOf, nativeMode: options.nativeMode ?? "disabled" });
      const preparedDoor = door;
      const handle = await this.ctx.get("agents").create({ sessionId, meta: { cwd: options.workspace }, agentOptions,
        setup: (_agentCtx: unknown, rawAgent: DshRootAgent) => {
          // DSH runs setup while the agent is unpublished; no model call can precede binding.
          preparedDoor.bind(rawAgent);
          options.adapter!.attach(rawAgent, preparedDoor, sessionId);
          return { commit() { preparedDoor.assertReady(); } };
        } });
      const agent = handle.agent as DshRootAgent;
      this.main = { agent, door, sessionId };
      return this.main;
    } catch (error) {
      door?.close();
      // A published but unbound session must never outlive a failed attachment.
      try { await this.shutdownHandle?.shutdown?.(1); } catch { /* retain the original failure */ }
      this.ctx = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.main?.door.close();
    this.main = null;
    await this.shutdownHandle?.shutdown?.(0);
    this.ctx = null;
    this.listeners.clear();
  }
}
