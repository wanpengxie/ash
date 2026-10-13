/**
 * The `agent` channel on this computer (SPEC-03 §6): the hub's frames in, the drivers' answers and events out.
 *
 * The hub calls a driver's methods with `{t:"agent", id, op, agent, ...}` and gets `{t:"agent", id, op_result, ok, ...}`.
 * The operation's own fields are the arguments of the matching `AgentDriver` method, by name (`key`, `messages`, `text`,
 * `handle`, `modules`, `config`...), so the hub's remote driver is a thin translation. Events go out as
 * `{t:"agent", event, ...}` (the sdk's `AgentEvent`, plus `agent.status`). A runtime's call of an Ash tool goes out as
 * `{t:"agent", id, outbound: <tool>, agent, key, turn, args}` and comes back as `{t:"agent", id, outbound_result, ok, result|error}`.
 *
 * The hub is not always there. A runtime keeps running for a while when the connection drops (a network blink must not
 * cut a long task): what it does meanwhile is kept, and sent when the channel is open again. If the hub does not
 * return within [graceMs], the agents are stopped.
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentStartSpec, DriverMessage, PromptModule } from "../../../sdk/src/driver";
import type { AgentFrame } from "../../../sdk/src/link";
import { WordError, type ErrorCode } from "../../../sdk/src/message";
import { redactText } from "../redact";
import type { ComputerDriver, DriverDeps } from "./driver";
import { isKind, type Kind } from "./info";

export interface AgentChannelOptions {
  /** The kinds this computer offers, each with its driver. */
  drivers: Partial<Record<Kind, (report: (event: AgentEvent) => void, outbound: DriverDeps["outbound"]) => ComputerDriver>>;
  /** Whether this computer has the runtime now (installed, not signed out); default: every kind with a driver. */
  offers?(kind: Kind): boolean;
  /** Sends a frame on the open channel; false when it cannot. */
  send(frame: AgentFrame): boolean;
  /** How long agents keep running without the hub. */
  graceMs?: number;
  log?(message: string, error?: unknown): void;
}

type Frame = Record<string, any>;
const BACKLOG_MAX = 2000;
const OUTBOUND_MS = 600_000;
const ATTACHED_MS = 120_000;

const text = (frame: Frame, field: string): string => {
  if (typeof frame[field] !== "string" || !frame[field]) throw new WordError("bad_request", `${field} is required`);
  return frame[field];
};
function messages(frame: Frame): DriverMessage[] {
  const list = frame.messages;
  if (!Array.isArray(list) || !list.length) throw new WordError("bad_request", "messages must be a non-empty list");
  for (const m of list) {
    if (!m || typeof m !== "object" || ["id", "from", "word", "text", "lane"].some((k) => typeof m[k] !== "string") || !Number.isFinite(m.at)) throw new WordError("bad_request", "a message needs id, from, word, text, lane and at");
  }
  return list;
}

export class AgentChannel {
  private readonly drivers = new Map<Kind, ComputerDriver>();
  private readonly owner = new Map<string, ComputerDriver>();
  private readonly pending = new Map<string, { agent: string; key: string; turn: string; settle(error?: Error, value?: unknown): void }>();
  private backlog: Frame[] = [];
  private open = false;
  private grace?: NodeJS.Timeout;
  private closedFlag = false;

  constructor(private readonly o: AgentChannelOptions) {
    for (const [kind, make] of Object.entries(o.drivers) as [Kind, NonNullable<AgentChannelOptions["drivers"][Kind]>][]) {
      this.drivers.set(kind, make((event) => this.event(event), (call) => this.outbound(call)));
    }
  }

  /** Runtimes this computer has a driver for. */
  get kinds(): Kind[] { return [...this.drivers.keys()]; }
  /** The agents this computer holds, with their state. */
  list(): { agent: string; runtime: Kind; state: string; detail?: string }[] {
    return [...this.drivers.entries()].flatMap(([runtime, d]) => d.list().map((a) => ({ ...a, runtime })));
  }
  /** A turn is running; an update must wait. */
  get busy(): boolean {
    return [...this.drivers.values()].some((d) => d.list().some((a) => d.running(a.agent).length > 0));
  }

  // -- the connection -------------------------------------------------------------------------------------------------

  /** The channel was accepted on a new connection: what happened while it was away is sent now. */
  opened(): void {
    this.open = true;
    clearTimeout(this.grace);
    const owed = this.backlog;
    this.backlog = [];
    for (const frame of owed) this.emit(frame);
  }

  /** The connection is gone. */
  closed(): void {
    this.open = false;
    for (const call of [...this.pending.values()]) call.settle(new Error("Ash communication unavailable: the connection to Ash was lost; whether the call was done is not known. Check before doing it again."));
    const anyone = [...this.drivers.values()].some((d) => d.list().some((a) => a.state === "running" || a.state === "starting"));
    clearTimeout(this.grace);
    if (anyone && !this.closedFlag) {
      this.grace = setTimeout(() => { this.o.log?.("the hub did not return; the agents are stopped"); this.backlog = []; void this.stopAll(); }, this.o.graceMs ?? 10 * 60_000);
      this.grace.unref();
    }
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    clearTimeout(this.grace);
    this.open = false;
    for (const call of [...this.pending.values()]) call.settle(new Error("device stopping"));
    await this.stopAll();
  }

  private async stopAll(): Promise<void> {
    await Promise.all([...this.drivers.values()].map((d) => d.closeAll()));
    this.owner.clear();
  }

  // -- out --------------------------------------------------------------------------------------------------------------

  private emit(frame: Frame): void {
    if (this.open && this.o.send(frame as AgentFrame)) return;
    this.backlog.push(frame);
    if (this.backlog.length > BACKLOG_MAX) this.backlog.splice(0, this.backlog.length - BACKLOG_MAX);
  }

  private event(event: AgentEvent): void {
    this.emit({ t: "agent", ...event });
    if (event.event === "turn.ended") {
      for (const call of [...this.pending.values()]) if (call.agent === event.agent && call.key === event.key && call.turn === event.turn) call.settle(new Error("turn ended"));
    }
    if (event.event === "ended") this.emit({ t: "agent", event: "agent.status", agent: event.agent, state: "failed", ...(event.reason ? { detail: event.reason } : {}) });
  }

  private status(agent: string, state: "starting" | "running" | "exited" | "failed", detail?: string): void {
    this.emit({ t: "agent", event: "agent.status", agent, state, ...(detail ? { detail } : {}) });
  }

  private outbound(call: Parameters<DriverDeps["outbound"]>[0]): Promise<unknown> {
    if (!this.open) return Promise.reject(new Error("Ash communication unavailable"));
    const id = `o_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error("Ash communication timed out")), OUTBOUND_MS);
      const settle = (error?: Error, value?: unknown) => { clearTimeout(timer); this.pending.delete(id); error ? reject(error) : resolve(value); };
      this.pending.set(id, { agent: call.agent, key: call.key, turn: call.turn, settle });
      if (!this.o.send({ t: "agent", id, outbound: call.tool, agent: call.agent, key: call.key, turn: call.turn, args: call.args } as AgentFrame)) settle(new Error("Ash communication unavailable"));
    });
  }

  /**
   * A call of the app attached to this computer (the Codex App, through `ash-device mcp`): it is no agent of ours and has no
   * turn. `tool` is a tool of the hub's tool surface, or `tools/list`; the answer is the tool's result as the hub shaped it.
   */
  attached(tool: string, args: unknown, session?: string): Promise<unknown> {
    if (!this.open) return Promise.reject(new Error("Ash communication unavailable: this computer is not connected to Ash right now (ash-device is starting, offline or not paired)"));
    const id = `o_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error("Ash communication timed out")), ATTACHED_MS);
      const settle = (error?: Error, value?: unknown) => { clearTimeout(timer); this.pending.delete(id); error ? reject(error) : resolve(value); };
      this.pending.set(id, { agent: "", key: "", turn: "", settle });
      if (!this.o.send({ t: "agent", id, outbound: tool, attached: { ...(session ? { session } : {}) }, args: args ?? {} } as AgentFrame)) settle(new Error("Ash communication unavailable"));
    });
  }

  // -- in ---------------------------------------------------------------------------------------------------------------

  /** A frame of the hub's. */
  async handle(frame: AgentFrame): Promise<void> {
    const f = frame as Frame;
    if (typeof f.outbound_result === "string") {
      const call = typeof f.id === "string" ? this.pending.get(f.id) : undefined;
      if (call) call.settle(f.ok === true ? undefined : new Error(typeof f.error?.message === "string" ? f.error.message.slice(0, 300) : "Ash refused the call"), f.result);
      return;
    }
    if (typeof f.op !== "string" || typeof f.id !== "string") return;
    const reply = (body: Frame) => void this.o.send({ t: "agent", id: f.id, op_result: f.op, ...body } as AgentFrame);
    try {
      reply({ ok: true, result: (await this.run(f.op, f)) ?? {} });
    } catch (error) {
      const known = error instanceof WordError;
      const code: ErrorCode = known ? error.code : "failed";
      reply({ ok: false, error: { code, message: redactText(error instanceof Error ? error.message : String(error)).slice(0, 1000), ...(known && error.recovery_hint ? { recovery_hint: error.recovery_hint } : {}) } });
    }
  }

  private driverOf(agent: string): ComputerDriver {
    const driver = this.owner.get(agent);
    if (!driver) throw new WordError("not_found", `${agent} is not running on this computer`);
    return driver;
  }

  private async run(op: string, f: Frame): Promise<unknown> {
    if (op === "agent.list") {
      return { agents: this.list() };
    }
    const agent = text(f, "agent");
    if (op === "agent.start") return this.start(agent, f.spec);
    const driver = this.driverOf(agent);
    switch (op) {
      case "agent.stop": {
        await driver.stop(agent, typeof f.reason === "string" ? f.reason : "stopped");
        this.owner.delete(agent);
        this.status(agent, "exited", typeof f.reason === "string" ? f.reason : undefined);
        return {};
      }
      case "session.get": return { handle: driver.session.get(agent, text(f, "key")) };
      case "session.set": await driver.session.set(agent, text(f, "key"), text(f, "handle")); return {};
      case "session.new": return driver.session["new"](agent, text(f, "key"));
      case "session.reload": {
        const modules = f.modules?.static;
        if (!Array.isArray(modules)) throw new WordError("bad_request", "modules.static is required");
        return driver.session.reload(agent, text(f, "key"), { static: modules as PromptModule[] });
      }
      case "session.compact": return driver.session.compact(agent, text(f, "key"));
      case "send": await driver.send(agent, text(f, "key"), messages(f)); return {};
      case "followup": await driver.followup(agent, text(f, "key"), messages(f)); return {};
      case "steer": return { accepted: await driver.steer(agent, text(f, "key"), text(f, "text")) };
      case "inject": {
        if (f.text !== undefined && typeof f.text !== "string") throw new WordError("bad_request", "text must be a string");
        if (f.modules !== undefined && !Array.isArray(f.modules)) throw new WordError("bad_request", "modules must be a list");
        await driver.inject(agent, text(f, "key"), { modules: f.modules, text: f.text });
        return {};
      }
      case "interrupt": await driver.interrupt(agent, text(f, "key")); return {};
      case "restart": await driver.restart(agent, typeof f.key === "string" ? f.key : undefined); return {};
      case "configure":
      case "config.get": {
        const config = op === "configure" ? f.config : undefined;
        if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) throw new WordError("bad_request", "config must be an object");
        return driver.configure(agent, typeof f.key === "string" ? f.key : undefined, config);
      }
      case "plugins": return driver.plugins(agent, f.action, typeof f.name === "string" ? f.name : undefined);
      default: throw new WordError("bad_request", `unknown operation ${op}`);
    }
  }

  private async start(agent: string, spec: AgentStartSpec): Promise<unknown> {
    const kind = spec?.runtime?.kind;
    if (!isKind(kind) || !this.drivers.has(kind) || this.o.offers?.(kind) === false) {
      this.status(agent, "failed", `${String(kind)} is not available on this computer`);
      throw new WordError("unavailable", `${String(kind)} is not installed (or not signed in) on this computer`);
    }
    const driver = this.drivers.get(kind)!;
    const other = this.owner.get(agent);
    if (other && other !== driver) throw new WordError("conflict", `${agent} already runs on another runtime here; stop it first`);
    const attached = driver.status(agent).state === "running";
    this.status(agent, "starting");
    try { await driver.start(agent, spec); } catch (error) {
      this.status(agent, "failed", redactText(error instanceof Error ? error.message : String(error)).slice(0, 300));
      throw error;
    }
    this.owner.set(agent, driver);
    this.status(agent, "running");
    if (attached) {
      // The agent kept running while the hub was away: tell it where every lane is, so it does not have to guess.
      for (const [key, handle] of Object.entries(driver.handles(agent))) this.emit({ t: "agent", event: "handle.updated", agent, key, handle });
      for (const turn of driver.running(agent)) this.emit({ t: "agent", event: "turn.started", agent, key: turn.key, turn: turn.turn, ids: turn.ids });
    }
    return { sessions: driver.handles(agent), attached };
  }
}
