/**
 * The hub's view of the computers that offer agent runtimes, and of the agents running on them.
 *
 * One entry per agent, on the connection it was started on. When that connection ends the agent is `exited` as far as the
 * hub is concerned (the manager starts it again); the computer keeps it running for a while, and a new `agent.start`
 * from the manager attaches to it. Events and tool calls are accepted only for an agent that lives on the connection
 * they arrived on, so a computer cannot speak for an agent that is not its own.
 */
import { WordError } from "../../../../../sdk/src/message";
import type { Caller } from "../../../../../sdk/src/message";
import type { AgentEvent, AgentEventName, AgentState, AgentStartSpec, RuntimeInfo } from "../../../../../sdk/src/driver";
import type { Router } from "../../../kernel/types";
import type { ChannelAttach } from "../../link-server";
import { glob } from "../../../kernel/router";
import { Computer, type Frame } from "./computer";
import { attachedTurn } from "../attached";

export interface Entry {
  agent: string;
  kind: string;
  conn: Computer;
  spec: AgentStartSpec;
  state: AgentState;
  detail?: string;
  /** The handle of each lane as last reported (`session.get` answers from here). */
  handles: Map<string, string>;
  /** `stop` was asked for: nothing the computer says about it is passed on. */
  stopping: boolean;
  /** `ended` has been reported for this incarnation. */
  ended: boolean;
  /** The turn running on each lane, so a `turn.started` that arrives twice (what the computer kept, then the attach) counts once. */
  turns: Map<string, string>;
}


/** What the hub gives for the callers attached through a computer: the Codex App on it. */
export interface AttachedPort {
  /** The caller of that computer, made on first use. */
  declare(computer: string, computerName: string): { id: string; name: string };
  /** The computer's connection ended. */
  drop(computer: string): void;
  tools(agent: string): { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call(agent: string, turn: string, tool: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface RemoteOptions {
  router: Pick<Router, "send">;
  /** Without it the computers' attached callers are refused. */
  attached?: AttachedPort;
  /** The runtime kinds to offer a driver for (default `codex`, `claude`, `workbuddy`). */
  kinds?: string[];
  /** How long an operation may take (ms). */
  opMs?: number;
  /** How long `agent.start` may take (ms): the runtime has to open its sessions. */
  startMs?: number;
  /** How long `start` waits for a computer that is not connected, so a network blink or a hub restart does not use up the manager's three tries (ms). */
  reconnectWaitMs?: number;
  log?(message: string, error?: unknown): void;
}

export const DEFAULT_KINDS = ["codex", "claude", "workbuddy"];
const EVENTS: ReadonlySet<string> = new Set<AgentEventName>(["turn.started", "turn.ended", "output", "thought", "tool", "handle.updated", "error", "ended"]);
const HELD_MAX = 2000;

/** The three tools of SPEC-08 §2.7 and the word each is. */
const TOOLS: Record<string, { word: string; fields: string[] }> = {
  agent_list: { word: "list", fields: [] },
  agent_ask: { word: "ask", fields: ["agent", "text"] },
  agent_tell: { word: "tell", fields: ["agent", "text"] },
};

const message = (error: unknown): string => String((error as { message?: unknown } | null)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

export class Directory {
  readonly computers = new Map<string, Computer>();
  readonly entries = new Map<string, Entry>();
  readonly reporters = new Map<string, (event: AgentEvent) => void>();
  readonly opMs: number;
  readonly startMs: number;
  readonly kinds: string[];
  private readonly arrivals = new Map<string, Set<() => void>>();
  private readonly reconnectWaitMs: number;
  readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly o: RemoteOptions) {
    this.opMs = o.opMs ?? 60_000;
    this.startMs = o.startMs ?? 120_000;
    this.reconnectWaitMs = o.reconnectWaitMs ?? 20_000;
    this.kinds = o.kinds ?? DEFAULT_KINDS;
    this.log = o.log ?? (() => {});
  }

  // -- the channel -----------------------------------------------------------------------------------------------------

  readonly attach: ChannelAttach = (session, ctx) => {
    const raw = (session.hello.channels as { agent?: { runtimes?: unknown } }).agent;
    const computer = new Computer(session, ctx.handId, session.hello.hand.name, (Array.isArray(raw?.runtimes) ? raw.runtimes : []) as RuntimeInfo[]);
    this.computers.set(ctx.handId, computer);
    for (const arrived of this.arrivals.get(ctx.handId) ?? []) arrived();
    this.arrivals.delete(ctx.handId);
    return {
      agent: (frame) => this.frame(computer, frame as Frame),
      closed: () => this.closed(computer),
    };
  };

  private frame(computer: Computer, f: Frame): void {
    try {
      if (typeof f.op_result === "string") computer.settle(f);
      else if (typeof f.outbound === "string") void this.outbound(computer, f);
      else if (typeof f.event === "string") this.event(computer, f);
    } catch (error) { this.log(`agents: a frame from ${computer.name}`, error); }
  }

  /** The connection ended: every agent that lived on it is gone as far as the hub can tell. */
  private closed(computer: Computer): void {
    if (this.computers.get(computer.handId) === computer) { this.computers.delete(computer.handId); this.o.attached?.drop(computer.handId); }
    computer.shutdown();
    for (const entry of [...this.entries.values()]) {
      if (entry.conn !== computer || entry.state === "failed" || entry.state === "exited") continue;
      const starting = entry.state === "starting";
      if (starting) { entry.state = "exited"; entry.detail = `computer ${computer.name} disconnected`; continue; } // `start` is waiting on this connection and fails with its pending operation
      this.ended(entry, `computer ${computer.name} disconnected`, "exited");
    }
  }

  // -- computers -------------------------------------------------------------------------------------------------------

  /** The computer named by `native.on` and its connection now; one that is not connected is waited for briefly. */
  async computerFor(on: string | undefined, kind: string): Promise<Computer> {
    const hand = handOf(on);
    let computer = this.computers.get(hand);
    if (!computer && this.reconnectWaitMs > 0) computer = await this.arrival(hand, this.reconnectWaitMs);
    if (!computer) throw new WordError("unavailable", `computer ${hand} is not connected, so ${kind} cannot start on it`, { recovery_hint: "Start the Ash program on that computer, or point the agent's native.on at another one." });
    if (!computer.runtimes.has(kind)) throw new WordError("unavailable", `computer ${computer.name} does not offer ${kind} (not installed, not signed in, or not allowed to run local agents)`);
    return computer;
  }

  private arrival(hand: string, ms: number): Promise<Computer | undefined> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(this.computers.get(hand)); };
      const timer = setTimeout(() => { this.arrivals.get(hand)?.delete(done); resolve(undefined); }, ms);
      timer.unref();
      const waiting = this.arrivals.get(hand) ?? new Set();
      waiting.add(done);
      this.arrivals.set(hand, waiting);
    });
  }

  /** Whoever offers [kind] now (first connected), for `info`. */
  offering(kind: string): Computer | undefined { return [...this.computers.values()].find((c) => c.runtimes.has(kind)); }

  // -- events ----------------------------------------------------------------------------------------------------------

  private live(entry: Entry | undefined, computer: Computer): boolean {
    return !!entry && entry.conn === computer && !entry.stopping && (entry.state === "starting" || entry.state === "running");
  }

  private event(computer: Computer, f: Frame): void {
    const agent = f.agent;
    if (typeof agent !== "string" || !agent) return;
    const entry = this.entries.get(agent);
    if (entry && entry.conn !== computer && !entry.stopping && (entry.state === "starting" || entry.state === "running")) {
      this.log(`agents: ${computer.name} reported on ${agent}, which runs on ${entry.conn.name}; dropped`);
      return;
    }
    if (!this.live(entry, computer)) {
      // Not started on this connection (yet): what the computer kept while the hub was away is kept until `start`.
      if (entry?.conn === computer && entry.stopping) return;
      const held = computer.held.get(agent) ?? [];
      held.push(f);
      if (held.length > HELD_MAX) held.splice(0, held.length - HELD_MAX);
      computer.held.set(agent, held);
      return;
    }
    this.deliver(entry!, f);
  }

  /** An event of a live agent: the status changes the entry, the contract's events go to the hub's module. */
  deliver(entry: Entry, f: Frame): void {
    if (f.event === "agent.status") {
      // A state, not an end: the crash is the `ended` event, and the `exited` that follows a stop we asked for starts nothing.
      if (typeof f.detail === "string" && f.state !== "running") entry.detail = f.detail;
      return;
    }
    if (!EVENTS.has(f.event)) return;
    const { t: _t, ...event } = f;
    if (f.event === "handle.updated") {
      if (typeof f.key !== "string" || typeof f.handle !== "string") return;
      entry.handles.set(f.key, f.handle);
    }
    if (f.event === "ended") {
      if (entry.state === "starting") { entry.ended = true; entry.detail = typeof f.reason === "string" ? f.reason : "the process ended while starting"; return; }
      this.ended(entry, typeof f.reason === "string" ? f.reason : undefined, "failed");
      return;
    }
    if (f.event === "turn.started" && typeof f.key === "string") {
      if (entry.turns.get(f.key) === f.turn) return;
      entry.turns.set(f.key, f.turn);
    }
    if (f.event === "turn.ended" && typeof f.key === "string") {
      if (entry.turns.get(f.key) === f.turn) entry.turns.delete(f.key);
      this.failOutbound(entry.conn, entry.agent, f.key, f.turn, "the turn ended");
    }
    this.report(entry.kind, event as AgentEvent);
  }

  /** Tool calls still open when their turn ends are failed (the answer would come to a turn that is gone). */
  private failOutbound(computer: Computer, agent: string, key: string, turn: unknown, why: string): void {
    for (const call of [...computer.outbounds]) {
      if (call.agent !== agent || call.key !== key || call.turn !== turn) continue;
      call.answer({ ok: false, error: { code: "cancelled", message: why } });
      call.controller.abort();
    }
  }

  /** The agent is gone without being asked: tell the module once. */
  ended(entry: Entry, reason: string | undefined, state: "exited" | "failed"): void {
    if (entry.ended) return;
    entry.ended = true;
    entry.state = state;
    if (reason) entry.detail = reason;
    this.report(entry.kind, { event: "ended", agent: entry.agent, ...(reason ? { reason } : {}) });
  }

  report(kind: string, event: AgentEvent): void {
    try { this.reporters.get(kind)?.(event); } catch (error) { this.log(`agents: reporting ${event.event}`, error); }
  }

  // -- the agent's tools -----------------------------------------------------------------------------------------------

  /** A computer's agent calls an Ash tool: it runs through the router as that agent, and the answer goes back. */
  private async outbound(computer: Computer, f: Frame): Promise<void> {
    if (typeof f.id !== "string") return;
    const tool = f.outbound as string;
    let answered = false;
    const answer = (body: Frame) => { if (answered) return; answered = true; computer.send({ id: f.id, outbound_result: tool, ...body }); };
    const refuse = (code: string, text: string) => answer({ ok: false, error: { code, message: text } });
    if (isObject(f.attached)) return this.attachedCall(computer, f, tool, answer, refuse);
    const entry = typeof f.agent === "string" ? this.entries.get(f.agent) : undefined;
    if (!entry || !this.live(entry, computer)) return refuse("forbidden", "that agent does not run on this computer");
    const spec = TOOLS[tool];
    if (!spec) return refuse("not_found", `${tool} is not an Ash tool offered to this agent`);
    // The agent's declared tool list is enforced here; the router then judges the call as the agent's own.
    if (!entry.spec.tools.allowed.some((pattern) => glob(pattern, tool))) return refuse("forbidden", `${entry.agent} may not use ${tool}`);
    const args = f.args && typeof f.args === "object" && !Array.isArray(f.args) ? (f.args as Frame) : {};
    for (const field of spec.fields) if (typeof args[field] !== "string" || !args[field]) return refuse("bad_request", `${tool} needs ${field}`);
    const body = Object.fromEntries(spec.fields.map((field) => [field, args[field]]));
    // The computer names the lane and the turn; the hub checks that this lane is in that turn now, from the events it has
    // seen on this connection. A call is never recorded in, or let speak in, a turn the lane is not in.
    const turn = typeof f.key === "string" ? entry.turns.get(f.key) : undefined;
    if (!turn || f.turn !== turn) return refuse("forbidden", "no turn is running for you on that lane; Ash tools work only while you are handling a message or a wake");
    const who: Caller = { member: entry.agent, via: "agent", local: false, turn };
    const call = { controller: new AbortController(), agent: entry.agent, key: f.key, turn: f.turn, answer };
    computer.outbounds.add(call);
    try {
      const reply = await this.o.router.send({ to: "service:agents", kind: "request", word: spec.word, body }, who, { signal: call.controller.signal });
      if (reply.ok) answer({ ok: true, result: reply.result?.data ?? textOf(reply.result?.content) ?? null });
      else answer({ ok: false, error: { code: reply.error.code, message: reply.error.message } });
    } catch (error) {
      refuse("failed", message(error));
    } finally { computer.outbounds.delete(call); }
  }

  /**
   * A call of the app attached to this computer (the Codex App, through `ash-device mcp`): no agent of the hub's, no turn.
   * `outbound` is the tool's name, or `tools/list`; `attached.session` is the app's own session, kept in the turn the ledger records.
   */
  private async attachedCall(computer: Computer, f: Frame, tool: string, answer: (body: Frame) => void, refuse: (code: string, text: string) => void): Promise<void> {
    const port = this.o.attached;
    if (!port) return refuse("unavailable", "this hub does not take calls from the apps attached to a computer");
    const caller = port.declare(computer.handId, computer.name);
    if (tool === "tools/list") return answer({ ok: true, result: { tools: port.tools(caller.id), caller: { id: caller.id, name: caller.name } } });
    const args = isObject(f.args) ? f.args : {};
    const call = { controller: new AbortController(), agent: caller.id, key: "attached", turn: undefined, answer };
    computer.outbounds.add(call);
    try {
      answer({ ok: true, result: await port.call(caller.id, attachedTurn(f.attached.session), tool, args, call.controller.signal) });
    } catch (error) {
      refuse("failed", message(error));
    } finally { computer.outbounds.delete(call); }
  }
}

const isObject = (v: unknown): v is Frame => !!v && typeof v === "object" && !Array.isArray(v);

const textOf = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return text || undefined;
};

/** `native.on` as a computer's hand id: the bare id, or `device:<id>` / `body:<id>`. */
export function handOf(on: string | undefined): string {
  if (!on) throw new WordError("bad_request", "a remote agent needs native.on: the computer it lives on");
  if (on === "body:main") throw new WordError("bad_request", "native.on names the main body; a remote runtime lives on a computer");
  return on.replace(/^(?:device|body):/, "");
}
