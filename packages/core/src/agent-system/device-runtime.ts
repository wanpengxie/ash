import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteAgents } from "../../../device/src/agents/remote";
import type { AgentDeclaration, DeviceRuntime } from "../agents";
import type { AgentBinding, AgentMcpServer } from "../agent-mcp/server";
import type { OwnerLink } from "../gateway/link";
import type { AgentTurnInput, AgentTurnOutput, AgentTurnRunner } from "../members/agent";
import type { WorldRouter } from "../world/router";

type Frame = Record<string, any>;
type Target = { session: string; generation: string; uncertain?: string };
interface Options {
  link(): OwnerLink | null;
  allowed(device: string): boolean;
  router: WorldRouter;
  tools: AgentMcpServer;
  stateDir: string;
}

/** One multiplexed stream per computer; each session keeps its own live phone binding. */
export class DeviceAgentRuntimes {
  private runners = new Map<string, DeviceTurnRunner>();
  constructor(private readonly options: Options) {}
  list(): Record<string, unknown>[] {
    const devices = this.options.link()?.state().devices as Frame[] | undefined;
    return (devices ?? []).flatMap(device => this.options.allowed(device.id)
      ? (Array.isArray(device.agents) ? device.agents : []).map((runtime: Frame) => ({ ...runtime, device: device.id, name: device.name, workdir: device.workdir })) : []);
  }
  available(item: AgentDeclaration): string | null {
    if (typeof item.runtime !== "object") return null;
    const runtime = item.runtime;
    if (!this.options.allowed(runtime.device)) return "Computer is offline or local_agents is not authorized";
    const found = this.list().find(candidate => candidate.device === runtime.device && candidate.kind === runtime.kind);
    return !found?.installed ? "Runtime is not installed on that computer" : found.logged_in === false ? "Log in to the runtime on the computer first" : null;
  }
  create(declaration: () => AgentDeclaration, binding: AgentBinding): DeviceTurnRunner {
    const runner = new DeviceTurnRunner(this, declaration, binding, this.options);
    this.runners.set(declaration().id, runner); return runner;
  }
  async close(id: string, forget = false): Promise<void> {
    const runner = this.runners.get(id); await runner?.close(forget);
    if (forget) this.runners.delete(id);
  }
  async peer(device: string, signal?: AbortSignal): Promise<RemoteAgents> {
    if (!this.options.allowed(device)) throw new Error("local_agents is no longer authorized or computer is offline");
    const link = this.options.link(); if (!link) throw new Error("Gateway is not connected");
    const peer = link.openAgentChannel(device, {
      event: frame => this.find(device, frame)?.event(frame),
      outbound: async frame => {
        const runner = this.find(device, frame);
        if (!runner || !this.options.allowed(device)) throw new Error("Remote turn is no longer authorized");
        return runner.outbound(frame);
      },
    });
    const until = Date.now() + 30_000;
    while (!peer.connected) { signal?.throwIfAborted(); if (Date.now() >= until) throw new Error("Computer stream did not connect"); await delay(50, undefined, { signal }); }
    return peer;
  }
  private find(device: string, frame: Frame): DeviceTurnRunner | undefined {
    return [...this.runners.values()].find(runner => runner.matches(device, frame));
  }
}

/** A turn is sent once. Reconnection only reads its receipt; unknown execution is never replayed. */
export class DeviceTurnRunner implements AgentTurnRunner {
  private target?: Target;
  private active?: { turn: string; signal: AbortSignal; final?: Frame };
  private readonly file: string;
  constructor(private readonly pool: DeviceAgentRuntimes, private readonly declaration: () => AgentDeclaration,
    private readonly binding: AgentBinding, private readonly options: Options) {
    const dir = join(options.stateDir, "agents", declaration().id.slice(6)); mkdirSync(dir, { recursive: true });
    this.file = join(dir, "device-session.json");
    if (existsSync(this.file)) this.target = JSON.parse(readFileSync(this.file, "utf8")) ?? undefined;
  }
  private get runtime(): DeviceRuntime { return this.declaration().runtime as DeviceRuntime; }
  private save(): void { writeFileSync(this.file + ".tmp", JSON.stringify(this.target ?? null), { mode: 0o600 }); renameSync(this.file + ".tmp", this.file); }
  matches(device: string, frame: Frame): boolean {
    return device === this.runtime.device && frame.session === this.target?.session && frame.generation === this.target?.generation;
  }
  event(frame: Frame): void {
    const active = this.active, event = frame.event;
    if (!active || active.signal.aborted || event?.turn !== active.turn) return;
    if (event.type === "turn_ended") active.final = event;
    else if (event.type === "note" || event.type === "tool") {
      const text = event.type === "tool" ? `${event.name}${event.summary ? ` · ${event.summary}` : ""}` : event.text;
      if (typeof text === "string" && text.trim()) this.options.router.recordActivitySummary(active.turn, text.slice(0, 400), this.declaration().id, true);
    }
  }
  async outbound(frame: Frame): Promise<unknown> {
    const active = this.active;
    if (!active || active.signal.aborted || frame.turn !== active.turn) throw new Error("Remote turn ended");
    let result = await this.options.tools.call(this.binding, frame.tool, frame.args, active.signal) as Frame;
    // The computer only has the three communication tools, so collect the phone's async receipt here.
    while (result.status === "accepted" && typeof result.request_id === "string") {
      active.signal.throwIfAborted();
      result = await this.options.tools.call(this.binding, "await_result", { request_id: result.request_id }, active.signal) as Frame;
    }
    return result;
  }
  private async session(peer: RemoteAgents): Promise<Target> {
    if (this.target) {
      // An unconfirmed stop blocks reuse. Do not silently start another process doing the same work.
      const status = await peer.op("status", {}, this.target).catch(() => null);
      if (status?.turn) throw new Error("Previous remote task is still running; stop it before sending another");
      if (!status && this.target.uncertain) throw new Error("Previous task outcome is unknown; reconnect or explicitly restart the agent");
      if (status?.running) { this.target.uncertain = undefined; this.save(); return this.target; }
      if (status) await peer.op("close", {}, this.target);
    }
    const item = this.declaration(), runtime = this.runtime;
    this.target = await peer.op("open", { session: this.target?.session ?? randomUUID(), kind: runtime.kind,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}), ...(runtime.model ? { model: runtime.model } : {}), ...(runtime.effort ? { effort: runtime.effort } : {}),
      system: `${item.name} (${item.id})\n${item.brief ?? item.summary}\nUse the Ash communication tools for delegation. Return your answer as text.` });
    this.save(); return this.target!;
  }
  async steer(input: { turn: string; rendered: string }, signal: AbortSignal): Promise<boolean> {
    if (!this.target || input.turn !== this.active?.turn || signal.aborted) return false;
    const peer = await this.pool.peer(this.runtime.device, signal);
    return (await peer.op("steer", { turn: input.turn, text: input.rendered }, this.target)).accepted === true;
  }
  async runTurn(input: AgentTurnInput, emit: (output: AgentTurnOutput) => Promise<void>, signal: AbortSignal): Promise<{ reason: "completed" | "error"; error?: string }> {
    const denied = this.pool.available(this.declaration()); if (denied) throw new Error(denied);
    const peer = await this.pool.peer(this.runtime.device, signal), target = await this.session(peer);
    signal.throwIfAborted();
    const active = this.active = { turn: input.turn, signal } as NonNullable<DeviceTurnRunner["active"]>;
    this.binding.begin(input.turn, signal);
    target.uncertain = input.turn; this.save();
    let stopRequested = false;
    const interrupt = () => { stopRequested = true; void peer.op("interrupt", { turn: input.turn }, target).catch(() => {}); };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      // A lost acceptance must be resolved by result/status, never another send.
      await peer.op("send", { turn: input.turn, text: input.rendered }, target).catch(() => {});
      let unavailableSince = 0, disconnectedShown = false;
      while (true) {
        if (signal.aborted && !stopRequested) interrupt();
        if (!this.options.allowed(this.runtime.device) && !stopRequested) interrupt();
        if (peer.connected) {
          const result = active.final ?? (await peer.op("result", { turn: input.turn }, target).catch(() => null))?.event;
          const status = await peer.op("status", {}, target).catch(() => null);
          if (result?.type === "turn_ended" && status && !status.turn) {
            target.uncertain = undefined; this.save();
            if (!signal.aborted && result.reply) await emit({ id: `remote:${input.turn}`, text: result.reply + (result.truncated && result.reply_path ? `\n\n完整回复：${result.reply_path}（电脑 ${this.runtime.device}）` : "") });
            return result.outcome === "ok" ? { reason: "completed" } : { reason: "error", error: result.error || `Remote task ${result.outcome}` };
          }
          if (status?.turn === input.turn && !stopRequested) unavailableSince = 0;
          else if (!unavailableSince) unavailableSince = Date.now();
        } else if (!unavailableSince) unavailableSince = Date.now();
        if (!peer.connected && !disconnectedShown) { disconnectedShown = true; this.options.router.recordActivitySummary(input.turn, "电脑连接断开，正在等待重连（不重发任务）", this.declaration().id, true); }
        if (peer.connected && disconnectedShown) { disconnectedShown = false; this.options.router.recordActivitySummary(input.turn, "电脑已重新连接，正在核对任务结果", this.declaration().id, true); }
        if (unavailableSince && Date.now() - unavailableSince > (stopRequested ? 60_000 : 600_000)) throw new Error("result_unknown: remote task could not be reconciled; it was not replayed");
        await delay(1000);
      }
    } finally {
      signal.removeEventListener("abort", interrupt); this.binding.end(input.turn); this.active = undefined;
    }
  }
  async close(forget = false): Promise<void> {
    if (!this.target) return;
    const peer = await this.pool.peer(this.runtime.device);
    await peer.op("close", {}, this.target);
    if (forget) this.target = undefined;
    else this.target.uncertain = undefined;
    this.save();
  }
}
