import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpClient, AcpError, type AcpUpdate } from "./acp";
import type { LaunchSpec } from "./launch";

export interface McpEndpoint { url: string; token: string }
export interface ContentBlock { type: string; [key: string]: unknown }

export interface ContainerHostOptions {
  launch: () => LaunchSpec;
  stateDir: string;
  log?: (...args: unknown[]) => void;
}

/**
 * The agent runtime inside the container, seen from ash: one process speaking ACP over stdio, hosting one persistent
 * session per ash agent (main, mind, ...). Session ids are kept in ash's state so a restart resumes the same history.
 * A dead process is started again on the next use; its sessions are resumed, never silently replaced.
 */
export class ContainerHost {
  private client: AcpClient | null = null;
  private starting: AcpClient | null = null;
  private booting: Promise<AcpClient> | null = null;
  private readonly sessions = new Map<string, { id: string; mcp: McpEndpoint }>();
  private readonly opening = new Map<string, Promise<string>>();
  private readonly listeners = new Set<(sessionId: string, update: AcpUpdate) => void>();
  private readonly exitListeners = new Set<(reason: string) => void>();
  private spec: LaunchSpec | null = null;
  private closed = false;
  imageInput = false;
  bootMs = 0;
  readonly timings: Record<string, number> = {};

  constructor(private readonly options: ContainerHostOptions) {}

  get workspace(): LaunchSpec | null { return this.spec; }
  get alive(): boolean { return Boolean(this.client?.alive); }
  /** Set once ash shuts the runtime down; failures after that are part of shutting down, not faults. */
  get isClosed(): boolean { return this.closed; }
  onUpdate(listener: (sessionId: string, update: AcpUpdate) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Called when the runtime process ends; an active turn must settle instead of waiting for updates that will never come. */
  onExit(listener: (reason: string) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }

  private get file(): string { return join(this.options.stateDir, "container-sessions.json"); }
  private stored(): Record<string, string> {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string> : {}; } catch { return {}; }
  }
  private store(key: string, id: string): void {
    const next = { ...this.stored(), [key]: id };
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 1), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  private forgetStored(key: string): void {
    const next = this.stored();
    if (!(key in next)) return;
    delete next[key];
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 1), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  /** Start the runtime process and complete the ACP handshake. Idempotent while it is alive. */
  async boot(): Promise<AcpClient> {
    if (this.closed) throw new Error("agent runtime is closed");
    if (this.client?.alive) return this.client;
    if (this.booting) return this.booting;
    this.booting = (async () => {
      const started = Date.now();
      const spec = this.options.launch();
      this.spec = spec;
      const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"], cwd: spec.mode === "direct" ? spec.hostWorkspace : undefined });
      const client = new AcpClient(child, this.options.log);
      this.starting = client;
      client.onUpdate((sessionId, update) => { for (const listener of this.listeners) listener(sessionId, update); });
      client.onExit((reason) => {
        this.options.log?.("agent runtime stopped:", reason);
        if (this.client === client) { this.client = null; this.sessions.clear(); }
        for (const listener of this.exitListeners) { try { listener(reason); } catch { /* keep notifying */ } }
      });
      const init = await client.request<{ agentCapabilities?: { promptCapabilities?: { image?: boolean } } }>("initialize", {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ash", version: "3" } });
      this.imageInput = init?.agentCapabilities?.promptCapabilities?.image === true;
      this.bootMs = Date.now() - started;
      this.timings.boot = this.bootMs;
      if (this.closed) { client.close(); throw new Error("agent runtime is closed"); }
      this.client = client;
      return client;
    })();
    try { return await this.booting; } finally { this.booting = null; this.starting = null; }
  }

  /** The live session for an ash agent: resumed from ash's record when possible, created otherwise. */
  async session(key: string, mcp: McpEndpoint, cwd?: string): Promise<string> {
    const live = this.sessions.get(key);
    if (live && this.client?.alive) return live.id;
    const opening = this.opening.get(key);
    if (opening) return opening;
    const task = (async () => {
      const client = await this.boot();
      const workspace = cwd ?? this.spec!.agentWorkspace;
      const servers = [{ type: "http", name: "ash", url: mcp.url, headers: [{ name: "authorization", value: `Bearer ${mcp.token}` }] }];
      const previous = this.stored()[key];
      const started = Date.now();
      if (previous) {
        try {
          await client.request("session/resume", { sessionId: previous, cwd: workspace, mcpServers: servers });
          this.sessions.set(key, { id: previous, mcp });
          this.timings[`resume:${key}`] = Date.now() - started;
          return previous;
        } catch (error) {
          // Only a session the runtime no longer knows is replaced; any other failure stays a failure.
          if (!(error instanceof AcpError) || !/not resumable|does not match|not found|unknown/i.test(error.message)) throw error;
          this.options.log?.(`session ${key} could not be resumed (${error.message}); starting a new one`);
        }
      }
      const created = await client.request<{ sessionId: string }>("session/new", { cwd: workspace, mcpServers: servers });
      if (typeof created?.sessionId !== "string") throw new Error("agent runtime returned no session id");
      this.store(key, created.sessionId);
      this.sessions.set(key, { id: created.sessionId, mcp });
      this.timings[`new:${key}`] = Date.now() - started;
      return created.sessionId;
    })();
    this.opening.set(key, task);
    try { return await task; } finally { this.opening.delete(key); }
  }

  async prompt(sessionId: string, prompt: ContentBlock[], signal?: AbortSignal): Promise<string> {
    const client = await this.boot();
    const result = await client.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt }, signal);
    return String(result?.stopReason ?? "end_turn");
  }

  /** Add words to the work in progress; the agent sees them at its next step. */
  async steer(sessionId: string, content: ContentBlock[]): Promise<boolean> {
    const result = await (await this.boot()).request<{ steered?: boolean }>("_ash/steer", { sessionId, content });
    return result?.steered === true;
  }
  /** Put context in front of the agent's next step without starting work. */
  async inject(sessionId: string, content: ContentBlock[]): Promise<void> { await (await this.boot()).request("_ash/inject", { sessionId, content }); }
  cancel(sessionId: string): void { this.client?.notify("session/cancel", { sessionId }); }

  /** Close one agent's session; forget=true is reserved for deleting that agent identity and its history. */
  async closeSession(key: string, forget = false): Promise<void> {
    const opening = this.opening.get(key);
    if (opening) await opening.catch(() => undefined);
    const live = this.sessions.get(key);
    this.sessions.delete(key);
    if (forget) this.forgetStored(key);
    if (live && this.client?.alive) await this.client.request("session/close", { sessionId: live.id }).catch((error) => this.options.log?.("session close failed", key, error));
  }

  /** The sessions open in the running runtime right now. */
  openSessions(): string[] { return this.client?.alive ? [...this.sessions.values()].map((item) => item.id) : []; }

  /** DSH's plugin manager inside the container: list, or switch a bundle or plugin (applies when the runtime restarts). */
  async plugins(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await (await this.boot()).request<Record<string, unknown>>("_ash/plugins", body) ?? {};
  }

  /** Stop the runtime; the next use starts it again and resumes every session. */
  async restart(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.sessions.clear();
    if (!client) return;
    const done = new Promise<void>((resolve) => { client.onExit(() => resolve()); setTimeout(resolve, 5_000).unref(); });
    client.close();
    await done;
  }

  /** Choose a model for a session. Values are the runtime's own option ids, a JSON [provider, model] pair. */
  async setModel(sessionId: string, provider: string, model: string): Promise<void> {
    const client = await this.boot();
    await client.request("session/set_config_option", { sessionId, configId: "model", value: JSON.stringify([provider, model]) });
  }

  async close(): Promise<void> {
    this.closed = true;
    // A runtime still starting is stopped too; it must never outlive ash.
    const clients = [this.client, this.starting].filter((item): item is AcpClient => item !== null && item.alive);
    this.client = null;
    await Promise.all(clients.map((client) => {
      const done = new Promise<void>((resolve) => { client.onExit(() => resolve()); setTimeout(resolve, 5_000).unref(); });
      client.close();
      return done;
    }));
  }
}
