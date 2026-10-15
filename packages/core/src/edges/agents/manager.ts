/**
 * The agents module's working part (HUB-MODULES §2.5, SPEC-08): declared agents, their lanes and inboxes, delivery
 * through a driver, the events a driver reports, keys and usage. `service.ts` is the words on top.
 *
 * Everything here reaches other members through `router.send` and the registry; the driver of each runtime kind is
 * injected, so nothing here knows how an agent is started.
 */
import { createHash, randomBytes } from "node:crypto";
import { WordError, type Caller, type Message } from "../../../../sdk/src/message";
import type { AgentDriver, AgentDriverFactory, AgentEvent, DriverAttachment, ModuleId, PromptModule } from "../../../../sdk/src/driver";
import type { HostNetwork } from "../../../../sdk/src/host";
import { OWNER_ID } from "../../../../sdk/src/ids";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { refsIn, resolveRefs } from "../../kernel/vault/refs";
import type { Ledger } from "../../kernel/ledger";
import type { Registry, Router, Vault } from "../../kernel/types";
import { proxyEnv } from "../../../../sdk/src/proxy";
import { failureText, RETRY_OPTION } from "./failure";
import { Inbox, toDriverMessage, type InboxRow } from "./inbox";
import { Modules, SERVICE_CALLER, type OwnerChannel } from "./modules";
import { lanesOf, Runs, type AgentDecl, type LaneDecl, type Run, type Templates } from "./runs";

export interface Timers {
  every(ms: number, fn: () => void): () => void;
  after(ms: number, fn: () => void): () => void;
}
const realTimers: Timers = {
  every(ms, fn) { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); },
  after(ms, fn) { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
};

export interface AgentsDeps {
  router: Router;
  registry: Registry;
  ledger: Pick<Ledger, "db" | "tx" | "blob">;
  /** Only `use` is given: plaintext for DSH's first key set-up. */
  vault: Pick<Vault, "use">;
  /** One driver factory per runtime kind (`dsh`...). */
  drivers: Record<string, AgentDriverFactory>;
  /** Declarations this build adds to the table after the first start has planted the primary agent (the debug build's script agent). */
  declare?: (runs: Runs) => void;
  /** `ash-skills/agents`: the `main` template that plants the first declaration, and the templates for `spawn`. */
  templates: Templates;
  /** The agent's own address on the tool surface and one token for each of its lanes (a new set on every call; the one before stops working); `allowed` is its declared tool list (already narrowed by delegation). */
  tools(agent: string, lanes: string[], allowed?: string[]): { mcp_url: string; tokens: Record<string, string>; allowed: string[] };
  /** The agent's tokens stop working (it was stopped, removed, or its process ended). */
  revokeTools?(agent: string): void;
  /** The agent's process is up (after every start, also after a crash): the tool surface tells it what it owes. */
  started?(agent: string): void;
  rules?(decl: AgentDecl): string | Promise<string>;
  /** The owner's open channels, for the environment's 「主人在哪」 line. */
  channels?(): OwnerChannel[];
  now?(): number;
  timers?: Timers;
  newId?(): string;
  log?(...args: unknown[]): void;
  /** Vault refs the runtime may hold for itself. */
  credentialRefs?: string[];
  /** The value behind `$vault.<name>` in a declaration's native.env (kernel/vault/refs), put in when the runtime starts. */
  vaultRef?: (name: string) => Promise<string>;
  /** The host's network when the module starts: what the running agents were given, to tell later whether the proxy changed. */
  network?: HostNetwork;
  /** The runtime kinds whose processes run on the main body, so a new proxy needs a new process (default `dsh`). Those on a computer are not the hub's to restart. */
  localKinds?: string[];
}

/** The proxy as the body gives it to a process: the same environment is the same proxy. */
const proxyKey = (network: HostNetwork | null | undefined): string => JSON.stringify(proxyEnv(network));

export const DEFAULT_CREDENTIAL_REFS = ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];
export const USAGE_POLL_MS = 10 * 60_000;
/** After a turn ends the agent's usage is pulled once this much later; turns that end inside the wait share the one pull (ms). */
export const USAGE_DEBOUNCE_MS = 5000;
/** How long a worker may take when `spawn` names no limit (seconds). */
export const SPAWN_TIMEOUT_S = 600;
/** A process that stayed up this long is stable (as is one that finished a round): the failure count clears, and a primary agent that was in trouble is told it is back. */
export const STABLE_RUN_MS = 60_000;
/**
 * How many failures in a row (a start that failed, or a process that died too soon after its start, with no round finished in
 * between) the module bears before it gives up on an agent that is not the primary one. The count starts again from nothing
 * when a process stayed up for STABLE_RUN_MS, or when it finished a round (a turn that ended `completed`): only a process
 * that keeps failing right away adds up. The primary agent is never given up on.
 */
export const MAX_FAILURES = 5;
/**
 * How long the module waits before the next try, by the number of failures in a row so far: 2 s, 5 s, 15 s, 60 s, then every
 * five minutes. The phone's container, proot and DSH may not be ready for a while after boot or a kernel restart; tries that
 * follow each other at once would be used up before they are.
 */
export const RETRY_STEPS_MS = [2000, 5000, 15_000, 60_000, 300_000];
export const retryDelay = (failures: number): number => RETRY_STEPS_MS[Math.min(Math.max(failures, 1), RETRY_STEPS_MS.length) - 1]!;
/** The owner hears that the primary agent cannot start after this many failures in a row, starts that failed and processes that died too soon alike (about 20 s of trying), not at the first one. */
export const TROUBLE_NOTICE_AT = 4;
/** A start that has not finished by then counts as failed (the runtime hung). Under the host's own five minutes for a core to say it is ready. */
export const START_TIMEOUT_MS = 180_000;
/** Before a turn opens, the keys are written once, and once more when the owner saved again meanwhile: at most this many writes. */
const KEY_SYNC_TRIES = 2;
/** A runtime that has not taken a key by then is let go of (the answer is lost, not the turns of every agent behind it). */
export const KEY_SYNC_TIMEOUT_MS = 15_000;
/** A temporary worker is tried this many times at once and is not waited for: its asker is waiting. */
const EPHEMERAL_TRIES = 3;
/** Dynamic modules are put in again after this many turns even if unchanged. */
export const REINJECT_EVERY = 20;
const BATCH = 20;

interface Lane {
  key: string;
  busy: boolean;
  /** A batch is being prepared or handed to the driver. */
  sending: boolean;
  turn?: string;
  /** Version of each dynamic module this lane's session has been given. */
  injected: Map<ModuleId, string>;
  turnsSince: number;
  reloadPending: boolean;
  compactPending: boolean;
  quotaNoticed: boolean;
  /** service:reflex looked at the screen before the turn on this lane, so it is asked to put things back when the turn ends. */
  routing: Set<string>;
}
/** The process of one start attempt, and the lanes it holds. A new attempt makes a new one; the old one is never used again. */
interface Live {
  id: string;
  driver: AgentDriver;
  lanes: Map<string, Lane>;
  startedAt: number;
  /** The process ended while the attempt was still going (after the driver's start, before the attempt took it as up). */
  ended?: string;
}
/**
 * Where an agent is. `stopped` (nothing runs; the agent is off, was given up on, or the next step is not taken yet) ->
 * `starting` (an attempt is in flight) -> `running`; an attempt that fails or a process that dies too soon goes through
 * `stopping` (the process is stopped) to `backoff` (waiting for the next try) and then `starting` again. `stopping` is also
 * what a restart or a stop passes through. Whether the agent should run at all is `desired` (in `Runs`): the one intent;
 * `reconcile` is the one place that reads intent and phase together and decides the next step.
 *
 * `gen` numbers the attempts: whatever voids the attempt in flight (stop, restart, timeout, a failure, a changed intent) adds
 * one, and every step that was waiting on something checks that it is still the current number before it lands.
 */
type Phase = "stopped" | "starting" | "running" | "backoff" | "stopping";
interface Slot {
  id: string;
  phase: Phase;
  gen: number;
  /** The attempt's process: from `starting` to `running`, else none. */
  live?: Live;
  /** Failures in a row so far: a start that failed, or a process that died too soon after its start (see MAX_FAILURES). A completed turn clears it. */
  failures: number;
  /** The primary agent's owner was told it cannot start, and has not been told it is back. */
  troubled: boolean;
  /** Given up on (not the primary agent): not a member, until it is started by hand. */
  gaveUp: boolean;
  /** Names the reason in the notice an interrupted turn leaves. */
  why: string;
  /** The `keySaves` that stood when the last key write to this agent's runtime was started and landed (none: nothing was saved at boot, the runtime keeps its own). Kept across restarts: the runtime keeps the keys. */
  keysSeen?: number;
  /** The proxy the attempt began with. */
  proxy: string;
  /** Ends the wait of `backoff`. */
  cancelWait?: () => void;
  /** Ends the timer that says a troubled agent is stable. */
  cancelStable?: () => void;
  /** While `stopping`: settles when the process is stopped. */
  stopped?: Promise<void>;
}
interface Waiter { id: string; agent: string; from: string; since: number; resolve(answer: string): void; reject(error: WordError): void }

export const agentCaller = (agent: string, turn?: string): Caller => ({ member: agent, via: "agent", local: true, ...(turn ? { turn } : {}) });
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const errorText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

export class AgentManager {
  readonly runs: Runs;
  readonly inbox: Inbox;
  readonly modules: Modules;
  private readonly slots = new Map<string, Slot>();
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly outputs = new Map<string, string[]>();
  private paused = false;
  /** Per agent: the keys being written into its runtime now (settled when none is); no turn of that agent opens before they are in. */
  private readonly keySync = new Map<string, Promise<void>>();
  /** How many keys the owner has saved so far: an agent that was starting meanwhile sees it change and writes them over. */
  private keySaves = 0;
  /** The module is stopping: no attempt starts and no member comes back, whatever restart is still on its way. */
  private closing = false;
  private proxy: string;
  private readonly stoppers: (() => void)[] = [];
  /** Agents whose usage pull after a turn is waiting on the debounce, with the way to cancel it. */
  private readonly usageDue = new Map<string, () => void>();
  /** Pulls run one after another: two at once would send the same records twice. */
  private usageQueue: Promise<unknown> = Promise.resolve();
  private readonly timers: Timers;
  readonly now: () => number;
  private readonly log: (...args: unknown[]) => void;

  constructor(readonly deps: AgentsDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.log = deps.log ?? (() => {});
    this.proxy = proxyKey(deps.network);
    this.runs = new Runs(deps.ledger, this.now);
    this.inbox = new Inbox(deps.ledger.db());
    this.modules = new Modules({ router: deps.router, registry: deps.registry, now: this.now, rules: deps.rules, channels: deps.channels });
  }

  newId = (): string => this.deps.newId?.() ?? `m_${randomBytes(9).toString("base64url")}`;
  private bg(work: Promise<unknown>, what: string): void { work.catch((error) => this.log(`agents: ${what}: ${errorText(error)}`)); }

  // ----------------------------------------------------------------------------------------------------------------
  // start and stop of the module
  // ----------------------------------------------------------------------------------------------------------------

  /** Does not wait for the agents: their processes come up on their own time, and what the owner says meanwhile waits in the inbox. */
  async startAll(): Promise<void> {
    this.closing = false;
    this.runs.seed(this.deps.templates);
    this.deps.declare?.(this.runs);
    this.inbox.prune(this.now() - 7 * 86_400_000);
    // From here on the declared agents are members. A kind with no driver here is not: nothing would ever start it.
    const on = this.runs.list().filter((run) => run.desired === "on" && this.deps.drivers[run.spec.decl.runtime.kind]);
    for (const run of on) this.ensureMember(run.id);
    await this.refreshPaused();
    this.stoppers.push(this.timers.every(USAGE_POLL_MS, () => this.bg(this.pollUsage(), "usage poll")));
    for (const run of on) this.bg(this.startAgent(run.id, "大脑重启"), `start ${run.id}`);
  }

  async stopAll(): Promise<void> {
    for (const stop of this.stoppers.splice(0)) stop();
    for (const stop of this.usageDue.values()) stop();
    this.usageDue.clear();
    this.closing = true;
    await Promise.allSettled([...this.slots.values()].map(async (slot) => {
      await this.halt(slot, "hub stopping");
      this.deps.registry.remove(slot.id);
    }));
  }

  // ----------------------------------------------------------------------------------------------------------------
  // drivers
  // ----------------------------------------------------------------------------------------------------------------

  driver(kind: string): AgentDriver {
    let driver = this.drivers.get(kind);
    if (!driver) {
      const factory = this.deps.drivers[kind];
      if (!factory) throw new WordError("unavailable", `no driver for runtime ${kind}`);
      driver = factory((event) => this.onEvent(event));
      this.drivers.set(kind, driver);
    }
    return driver;
  }
  kinds(): string[] { return Object.keys(this.deps.drivers); }

  // ----------------------------------------------------------------------------------------------------------------
  // declarations -> running agents
  // ----------------------------------------------------------------------------------------------------------------

  run(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new WordError("not_found", `no such agent: ${id}`);
    return run;
  }
  private slot(id: string): Slot {
    let slot = this.slots.get(id);
    if (!slot) this.slots.set(id, slot = { id, phase: "stopped", gen: 0, failures: 0, troubled: false, gaveUp: false, why: "大脑重启", proxy: this.proxy });
    return slot;
  }
  /** The process of the attempt in flight or running, with its lanes. */
  liveOf(id: string): Live | undefined { return this.slots.get(id)?.live; }
  /** This process is the agent's current one and is up. A step that waited on something asks this before it goes on. */
  private isUp(live: Live): boolean {
    const slot = this.slots.get(live.id);
    return slot?.live === live && slot.phase === "running";
  }
  private upOf(id: string): Live | undefined {
    const slot = this.slots.get(id);
    return slot?.phase === "running" ? slot.live : undefined;
  }
  private ups(): Live[] { return [...this.slots.values()].flatMap((s) => (s.phase === "running" && s.live ? [s.live] : [])); }
  running(id: string): Live {
    this.run(id);
    const live = this.upOf(id);
    if (!live) throw new WordError("offline", `${id} is not running`);
    return live;
  }
  stateOf(id: string): "idle" | "working" | "starting" | "stopped" | "error" {
    const slot = this.slots.get(id);
    if (!slot) return "stopped";
    if (slot.gaveUp) return "error";
    if (slot.phase === "running") return [...slot.live!.lanes.values()].some((l) => l.busy) ? "working" : "idle";
    // starting, waiting for the next try, or stopping to start again: all of it is "on its way" while the intent is on
    return slot.phase !== "stopped" && this.runs.get(id)?.desired === "on" ? "starting" : "stopped";
  }
  /** Whether the agent takes messages: it is a member of the registry, and the inbox keeps what comes while its process starts or is started again. Different from `available` (the process is up and can run a turn). */
  reachable(id: string): boolean { return this.deps.registry.get(id) !== null; }
  /** A member of the registry while the agent is meant to be on, process or not. */
  private ensureMember(id: string): void {
    if (!this.deps.registry.get(id)) this.deps.registry.add(this.memberFor(id));
  }

  // -- the state machine --------------------------------------------------------------------------------------------

  /**
   * The one place that reads the intent (`desired`) and the phase together. An agent that should run and is stopped starts;
   * one that should not is stopped; one that is on its way (starting, running, waiting for its next try) is left alone; one that
   * is stopping is looked at again when the process is gone. Resolves when the first attempt it started is over.
   */
  private async reconcile(slot: Slot, why: string): Promise<void> {
    if (this.closing) return;
    const want = this.runs.get(slot.id)?.desired === "on" && !slot.gaveUp;
    if (!want) { if (slot.phase !== "stopped") await this.halt(slot, why); return; }
    if (slot.phase === "stopping") { await slot.stopped; return this.reconcile(slot, why); }
    if (slot.phase === "stopped") await this.attempt(slot);
  }

  /**
   * Start an agent by hand (or at boot, or when it is declared). A start that fails is tried again later, by RETRY_STEPS_MS,
   * while the member stays in the registry and the inbox takes messages; this returns once the first try is over, not when a
   * later one succeeds. A start asked for while a try is waiting does not wait for it. `why` names the reason in the notice an
   * interrupted turn leaves.
   */
  async startAgent(id: string, why = "大脑重启"): Promise<void> {
    const run = this.run(id);
    this.driver(run.spec.decl.runtime.kind); // no driver for the kind: refused here, before anything changes
    const slot = this.slot(id);
    slot.why = why;
    slot.gaveUp = false;
    if (slot.phase === "starting" || slot.phase === "running") return;
    // A try that waits for its time, or a failed one whose process is still being stopped: the start by hand takes over (voids what follows).
    if (slot.phase === "backoff" || slot.phase === "stopping") await this.halt(slot, "start now");
    slot.failures = 0;
    await this.reconcile(slot, why);
  }

  /** The process is stopped and started again; the member stays in the registry meanwhile, and those who ask and wait are told it was stopped. */
  async restartAgent(id: string, why = "重启"): Promise<void> {
    const slot = this.slots.get(id);
    this.rejectWaiters(id, new WordError("unavailable", `${id} stopped`));
    if (slot) await this.halt(slot, "restart");
    this.runs.setDesired(id, "on");
    await this.startAgent(id, why);
  }

  /** Stop an agent for good: the intent turns off and the member leaves the registry, so words sent to it answer offline. */
  async stopAgent(id: string, reason: string): Promise<void> {
    const slot = this.slots.get(id);
    this.runs.setDesired(id, "off");
    this.deps.registry.remove(id);
    this.rejectWaiters(id, new WordError("unavailable", `${id} stopped`));
    if (slot) { slot.troubled = false; await this.halt(slot, reason); }
  }

  /** Remove an agent altogether: stop it, drop its inbox and its declaration, and have the clock take back the timers it set. */
  async forget(id: string, reason: string): Promise<void> {
    await this.stopAgent(id, reason).catch(() => {});
    this.slots.delete(id);
    this.inbox.drop(id);
    this.runs.remove(id);
    // Timers go out as the agent that set them; with the declaration gone they could only fail. A failure here is only logged:
    // the clock takes them back by itself the first time one fails for that reason.
    try {
      const reply = await this.deps.router.send({ to: "service:clock", kind: "request", word: "cancel.owner", body: { member: id } }, SERVICE_CALLER);
      if (!reply.ok) this.log(`agents: clearing the timers of ${id}: ${reply.error.code}: ${reply.error.message}`);
    } catch (error) { this.log(`agents: clearing the timers of ${id}: ${errorText(error)}`); }
  }

  /**
   * Void whatever is in flight for the agent (add one to `gen`), end its timers and stop its process; settles when it is gone.
   * `dead`: the process ended by itself, there is nothing to stop. A halt that comes while another is stopping voids that one's
   * continuation too and waits for the same process.
   */
  private halt(slot: Slot, reason: string, dead = false): Promise<void> {
    slot.gen++;
    this.endWait(slot);
    this.endStable(slot);
    if (slot.phase === "stopping") return slot.stopped!;
    const live = slot.live;
    slot.live = undefined;
    this.deps.revokeTools?.(slot.id);
    if (!live) { slot.phase = "stopped"; return Promise.resolve(); }
    this.cutTurns(live, reason, dead);
    slot.phase = "stopping";
    const gone = dead ? Promise.resolve() : live.driver.stop(slot.id, reason).catch((error) => this.log(`agents: stopping ${slot.id}: ${errorText(error)}`));
    return slot.stopped = gone.then(() => { slot.phase = "stopped"; slot.stopped = undefined; });
  }
  /**
   * The one place where a turn that was running when its process went away is ended: whatever discards a `Live` (the process
   * died, a stop, a restart) ends the turns still open in it, once, and the `Live` is gone, so nothing can end them again. The
   * driver does not report the end of a turn its process took with it. A process that died ends them as `error` (an owner's
   * turn gets the failure notice and the retry card); one that was stopped on purpose ends them as `interrupted`.
   */
  private cutTurns(live: Live, reason: string, died: boolean): void {
    const ended = died ? { outcome: "error" as const, error: `the agent process ended (${live.ended ?? reason})` } : { outcome: "interrupted" as const };
    for (const lane of live.lanes.values()) {
      if (!lane.busy || !lane.turn) continue;
      const turn = lane.turn; // `finishTurn` clears it at once
      // One lane that cannot be ended must not keep the others, or the stop of the process, from happening.
      try { this.finishTurn(live, lane, { event: "turn.ended", agent: live.id, key: lane.key, turn, ...ended }, reason); } catch (error) {
        this.log(`agents: ending the turn of ${live.id}/${lane.key}: ${errorText(error)}`);
        lane.busy = false;
        lane.turn = undefined;
        // Whoever asked in this turn is told it is not known whether it was done, not left to wait for the router's timeout.
        try { for (const row of this.inbox.byTurn(turn)) this.rejectWaiter(row.id, new WordError("result_unknown", `${live.id} went away in the middle of the turn that took this question (${reason}); it is not known whether it was done`)); } catch (e) { this.log(`agents: telling the askers of ${turn}: ${errorText(e)}`); }
      }
    }
  }
  private endWait(slot: Slot): void { slot.cancelWait?.(); slot.cancelWait = undefined; }
  private endStable(slot: Slot): void { slot.cancelStable?.(); slot.cancelStable = undefined; }

  /**
   * One start attempt: a new number, a new process record, the member in the registry from now on (the router files what comes
   * in the inbox; the drain at the end delivers it). Resolves when the attempt is over: up, or failed (and waiting for the
   * next one; a temporary worker's tries follow each other at once and are all inside this).
   */
  private async attempt(slot: Slot): Promise<void> {
    if (this.closing) return;
    const id = slot.id;
    const gen = ++slot.gen;
    const run = this.run(id);
    const decl = run.spec.decl;
    const lanes = lanesOf(decl);
    const live: Live = { id, driver: this.driver(decl.runtime.kind), lanes: new Map(), startedAt: this.now() };
    for (const key of Object.keys(lanes)) live.lanes.set(key, newLane(key));
    Object.assign(slot, { phase: "starting", live, proxy: this.proxy });
    this.ensureMember(id);
    const current = () => slot.gen === gen;
    let statics: PromptModule[] = [];
    try {
      statics = await this.modules.static(decl);
      if (!current()) return; // voided while the files were read: no process exists yet
      const baseline = this.keySaves; // keys saved from here on are not in what the start writes
      // $vault.<name> in the runtime's environment: the value goes to the process only, never back into the declaration.
      const native = decl.native?.env && refsIn(decl.native.env).length
        ? { ...decl.native, env: (await resolveRefs(decl.native.env, (name) => this.deps.vaultRef ? this.deps.vaultRef(name) : Promise.reject(new WordError("unavailable", "the vault cannot be used here")))).env }
        : decl.native;
      if (!current()) return;
      await this.within(START_TIMEOUT_MS, `${id} did not finish starting`, (async () => {
        await live.driver.start(id, {
          runtime: decl.runtime, ...(native ? { native } : {}), tools: this.deps.tools(id, Object.keys(lanes), decl.tools),
          modules: { static: statics }, lanes: Object.keys(lanes), sessions: run.spec.sessions,
        });
        // The runtime keeps its own keys: a key it has is left alone, unless the owner saved one since this agent last took keys.
        if (current()) await this.syncKeys(live, (slot.keysSeen ?? 0) !== baseline, baseline);
      })());
    } catch (error) {
      if (!current()) return; // voided while it started: the one that voided it has stopped the process
      return this.failed(slot, errorText(error), false);
    }
    if (!current()) return;
    if (live.ended) return this.failed(slot, live.ended, true);
    slot.phase = "running";
    live.startedAt = this.now();
    const hash = staticHash(statics);
    this.runs.patch(id, (spec) => { for (const key of Object.keys(lanes)) if (!spec.sessions[key] || !spec.static_hash[key]) spec.static_hash[key] ??= hash; });
    this.deps.started?.(id);
    this.interruptedNotice(id, slot.why);
    for (const lane of live.lanes.values()) this.bg(this.drain(live, lane), `drain ${id}/${lane.key}`);
    // Troubled: it is back once it has stayed up (or finished a round, which `finishTurn` takes).
    if (slot.troubled) slot.cancelStable = this.timers.after(STABLE_RUN_MS, () => { if (current()) this.stable(slot); });
    this.refreshProxy(slot);
  }

  /** A start that failed, or a process that died too soon: count it, stop what is left, and decide what comes next. */
  private async failed(slot: Slot, reason: string, died: boolean, why?: string): Promise<void> {
    const id = slot.id;
    const decl = this.runs.get(id)?.spec.decl;
    const n = ++slot.failures;
    if (why) slot.why = why;
    this.log(`agents: ${id} ${died ? "ended" : "did not start"}: ${reason}`);
    const done = this.halt(slot, "start failed", died);
    const mine = slot.gen; // a stop or a start by hand that comes while the process is stopped makes it another number
    await done;
    if (slot.gen !== mine || !decl || this.runs.get(id)?.desired !== "on") return; // stopped or started over meanwhile: not ours to go on
    if (decl.ephemeral ? n >= EPHEMERAL_TRIES : !decl.primary && n >= MAX_FAILURES) return this.giveUp(slot, reason, n);
    if (decl.primary && n >= TROUBLE_NOTICE_AT && !slot.troubled) {
      slot.troubled = true;
      this.tellOwner(`Ash 暂时起不来（${reason}），正在后台一直重试。你说的话我先收着，起来后再处理。`);
    }
    // The first quick crash is started again at once, and so is a temporary worker; the other ones wait on the steps.
    return this.backoff(slot, decl.ephemeral || (died && n <= 1) ? 0 : retryDelay(died ? n - 1 : n));
  }

  /** The next attempt after `delay` ms (at once when 0). Until then the agent is a member and takes messages. */
  private backoff(slot: Slot, delay: number): Promise<void> {
    if (delay <= 0) return this.attempt(slot);
    const gen = slot.gen;
    slot.phase = "backoff";
    slot.cancelWait = this.timers.after(delay, () => { if (slot.gen === gen) this.tryNow(slot); });
    return Promise.resolve();
  }

  /** Whatever waits for its next try (or is about to: its failed attempt is still being stopped) tries now. The count of failures goes on. */
  retryNow(): void { for (const slot of [...this.slots.values()]) this.tryNow(slot); }
  private tryNow(slot: Slot): void {
    if (slot.phase !== "backoff" && slot.phase !== "stopping") return;
    this.bg((async () => { await this.halt(slot, "retry now"); await this.reconcile(slot, slot.why); })(), `retry ${slot.id}`);
  }

  /** A round done, or a stay long enough: earlier failures no longer count, and a troubled agent is back. */
  private stable(slot: Slot): void {
    slot.failures = 0;
    this.endStable(slot);
    if (slot.troubled) { slot.troubled = false; this.tellOwner("Ash 恢复了。"); }
  }

  private giveUp(slot: Slot, reason: string, failures: number): void {
    slot.gaveUp = true;
    this.deps.registry.remove(slot.id);
    this.rejectWaiters(slot.id, new WordError("failed", `${slot.id} could not be started: ${reason}`));
    this.tellOwner(`${slot.id} 起不来了：连着失败了${failures}次（${reason}）。我先停下它，不再自动重试；你可以在设置里让它重启。`);
  }

  /** Reject `work` with a timeout error when it takes longer than `ms`; the work itself is not stopped here. */
  private within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
    let cancel = () => {};
    const late = new Promise<never>((_, reject) => { cancel = this.timers.after(ms, () => reject(new WordError("timeout", `${what} in ${Math.round(ms / 1000)} s`))); });
    return Promise.race([work, late]).finally(cancel);
  }

  /**
   * The host's network changed. When the proxy is not the one the agents were started with, the agents that run on the main
   * body are restarted at once, the way a process that ended is: a turn it was in is told as cut off, what waits in the inbox
   * goes to the new process, which answers those who asked and wait. Whoever asked in the turn that was cut is told result_unknown (as after a crash). An agent that is
   * still starting is looked at when its start is over. Temporary workers, agents that are off, and agents on a computer are left as they are.
   */
  onNetwork(network: HostNetwork): void {
    const next = proxyKey(network);
    if (next === this.proxy) return;
    this.proxy = next;
    for (const slot of this.slots.values()) this.refreshProxy(slot);
  }
  private refreshProxy(slot: Slot): void {
    const run = this.runs.get(slot.id);
    if (!run || slot.phase !== "running" || slot.proxy === this.proxy || run.desired !== "on" || run.spec.decl.ephemeral) return;
    if (!(this.deps.localKinds ?? ["dsh"]).includes(run.spec.decl.runtime.kind)) return;
    this.log(`agents: ${slot.id}: the proxy changed, restarting its process`);
    // Not a restart by hand: the intent is not touched, so a stop that comes meanwhile stays a stop. Those who wait for an answer keep waiting for the new process.
    slot.why = "代理换了";
    this.bg((async () => { await this.halt(slot, "restart"); await this.reconcile(slot, slot.why); })(), `restart ${slot.id} for the new proxy`);
  }

  /**
   * A turn the ledger still shows as open belongs to a process that is gone (this one has not taken a message yet): the hub died with
   * it, so nobody wrote its end, and the chat would say "working" for ever. Close each with `interrupted`, the lane from its start. It is
   * not a failure: the wake below tells the agent, which decides whether to go on.
   */
  private endStaleTurns(id: string): void {
    const open = this.deps.ledger.db().prepare("SELECT fact_turn AS turn, lane FROM messages WHERE fact_type='turn.start' AND \"from\"=? AND turn_end_seq IS NULL AND fact_turn IS NOT NULL").all(id) as { turn: string; lane: string }[];
    for (const { turn, lane } of open) this.emit(id, "turn.ended", { turn, lane, outcome: "interrupted", error: "the hub restarted" }, turn);
  }

  /** What was in flight when the agent went away is not sent again; the agent hears that it was cut off and decides. */
  private interruptedNotice(id: string, why: string): void {
    this.endStaleTurns(id);
    const rows = this.inbox.unfinished(id);
    if (!rows.length) return;
    const cut = rows.filter((r) => r.turn);
    this.inbox.mark(rows.filter((r) => !r.turn).map((r) => r.id), "pending");
    this.inbox.mark(cut.map((r) => r.id), "interrupted");
    // Whoever asked in the turn that was cut is told so now: nobody knows whether it was done. What still waits in the inbox is answered by the new process.
    for (const r of cut) this.rejectWaiter(r.id, new WordError("result_unknown", `${id} was restarted in the middle of the turn that took this question (${why}); it is not known whether it was done`));
    if (!cut.length) return;
    const doing = cut.slice(0, 3).map((r) => r.text.replace(/\s+/g, " ").slice(0, 80)).join("；");
    this.enqueue(id, { id: this.newId(), from: SERVICE_CALLER.member, word: "wake", text: `${why}，上一轮中断了（当时在处理：${doing}）。要不要接着做，你自己决定。`, attachments: [], at: this.now() });
  }

  // ----------------------------------------------------------------------------------------------------------------
  // the router's structural rules about turns (SPEC-01 §5.2). The turn in `caller.turn` is the one of the lane the tool
  // token was issued for (or the one the manager itself reported), so a lane is judged by its own turn.
  // ----------------------------------------------------------------------------------------------------------------

  /** A sub-agent (made by another agent) speaks to the owner only in a turn where the owner addressed it directly. The primary agent (even one that `primary.set` made from a sub-agent) and the top-level ones are not held to a turn here. */
  mayTalkToOwner(caller: Caller, _word: string): boolean {
    const run = this.runs.get(caller.member);
    if (!run || run.spec.decl.primary || run.spec.decl.depth === 0) return true;
    if (!caller.turn) return false;
    return this.inbox.byTurn(caller.turn).some((row) => row.agent === caller.member && row.from === OWNER_ID);
  }

  /** `service:agents/answer` is for the turn that took the message. A message that is not this agent's is left to the service to refuse. */
  mayAnswer(caller: Caller, body: unknown): boolean {
    const id = (body as { in_reply_to?: unknown } | null)?.in_reply_to;
    const row = typeof id === "string" ? this.inbox.get(id) : null;
    if (!row || row.agent !== caller.member) return true;
    return row.turn !== undefined && row.turn === caller.turn;
  }

  // ----------------------------------------------------------------------------------------------------------------
  // members
  // ----------------------------------------------------------------------------------------------------------------

  memberFor(id: string): Member {
    const name = this.run(id).spec.decl.name;
    return {
      id, kind: "agent", name,
      // What it hears (say, tell, ask, wake, typing) and what it emits (turn.started, turn.ended, agent.tool): the router lets a sender emit what its own words declare.
      words: () => wordsOf(id),
      handle: (msg, ctx) => this.accept(id, msg, ctx.raw, ctx.signal),
    };
  }

  // ----------------------------------------------------------------------------------------------------------------
  // the inbox: filing, delivery
  // ----------------------------------------------------------------------------------------------------------------

  /** Which lane takes a message: the first one whose `from` names the sender or its kind of sender; else `back`. */
  laneFor(decl: AgentDecl, from: string, word: string, kind: string, wanted?: string): string {
    const lanes = lanesOf(decl);
    if (wanted && lanes[wanted]) return wanted;
    // Only the owner's `say` is the owner speaking to the agent; their tell and ask are like anyone's.
    const asOwner = from === OWNER_ID && word === "say";
    const category = word === "wake" ? "wake" : asOwner ? OWNER_ID : kind === "event" ? "event" : "";
    const pick = (match: (f: string) => boolean) => Object.entries(lanes).find(([, l]) => l.from?.some(match))?.[0];
    return pick((f) => f === "*" || f === category || (word !== "wake" && from !== OWNER_ID && f === from)) ?? (lanes.back ? "back" : pick((f) => f === "wake")) ?? Object.keys(lanes)[0]!;
  }

  /** A request or event addressed to an agent. */
  async accept(id: string, msg: Message, raw: unknown, signal?: AbortSignal): Promise<{ data: unknown }> {
    if (msg.word === "typing") return { data: undefined }; // heard (the owner is active), but nothing waits for it
    const body = (raw && typeof raw === "object" ? raw : msg.body) as Record<string, any>;
    const decl = this.run(id).spec.decl;
    const attachments = this.storeAttachments(body.attachments);
    let words = text(body.text);
    if (msg.word === "say" && body.in_reply_to) words = `[answers ${body.in_reply_to}, option ${body.option_id}] ${words}`.trim();
    // The owner acted on a card this agent showed: which card, which action, and what the card holds now.
    if (msg.word === "say" && body.card && typeof body.card === "object") {
      const { id: card, action, context, data } = body.card as { id: string; action: string; context?: unknown; data?: unknown };
      words = `[card ${card}, action ${action}] ${JSON.stringify({ ...(context !== undefined ? { context } : {}), ...(data !== undefined ? { data } : {}) })}${words ? `\n${words}` : ""}`;
    }
    if (msg.word === "wake") words = `Wake · ${text(body.reason)}${body.context === undefined ? "" : `\n${JSON.stringify(body.context)}`}`;
    if (!words && attachments.length) words = "(attachments)";
    const lane = this.laneFor(decl, msg.from, msg.word, msg.kind, msg.word === "wake" ? text(body.lane) : undefined);
    // The owner chose 「重试」 on a failure card: the batch that failed is delivered again, and the click is not a message of its own.
    const retry = msg.word === "say" && typeof body.option_id === "string" && body.option_id.startsWith(`${RETRY_OPTION}:`) ? body.option_id.slice(RETRY_OPTION.length + 1) : null;
    if (retry && this.retryFailed(id, lane, retry)) return { data: { accepted: true } };
    const row = { id: msg.id, from: msg.from, word: msg.word, text: words, attachments, at: msg.ts, ...(msg.thread ? { thread: msg.thread } : {}), ...(msg.origin ? { origin: msg.origin } : {}) };
    if (msg.word !== "ask") {
      this.enqueue(id, row, lane);
      return { data: { accepted: true } };
    }
    const answer = this.expect(id, msg.id, msg.from, signal);
    this.enqueue(id, row, lane);
    return { data: { answer: await answer } };
  }

  private storeAttachments(raw: unknown): DriverAttachment[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((a) => a && typeof a.data === "string").map((a) => ({
      name: String(a.name), mime_type: String(a.mime_type), ref: this.deps.ledger.blob.put(Buffer.from(a.data, "base64"), String(a.mime_type)),
    }));
  }

  /** File a message in an agent's inbox and see whether it can be delivered. */
  enqueue(id: string, item: Omit<InboxRow, "agent" | "lane" | "state" | "turn">, lane?: string): InboxRow {
    const decl = this.run(id).spec.decl;
    const key = lane ?? this.laneFor(decl, item.from, item.word, "request");
    const row = this.inbox.add({ ...item, agent: id, lane: key });
    const live = this.upOf(id);
    const l = live?.lanes.get(key);
    if (live && l && row.state === "pending" && !this.paused) {
      if (l.busy) this.bg(this.busyRoute(live, l, row), `route ${row.id}`);
      else if (!l.sending) this.bg(this.drain(live, l), `drain ${id}/${key}`);
    }
    return row;
  }

  /** The agent is idle on this lane: give it what is waiting (one batch). */
  async drain(live: Live, lane: Lane): Promise<void> {
    if (!this.isUp(live) || lane.busy || lane.sending || this.paused) return;
    const rows = this.inbox.pending(live.id, lane.key, BATCH);
    if (!rows.length) return;
    lane.sending = true;
    let sent = false;
    try {
      if (!(await this.quotaAllows(live, lane))) return;
      await this.ensureKeys(live); // a key the owner has saved is in the runtime first, or this turn would meet the old one
      if (lane.busy || !this.isUp(live) || this.paused) return; // (the owner may have paused meanwhile)
      await this.inject(live, lane);
      this.inbox.mark(rows.map((r) => r.id), "sent");
      try {
        // The lane turns busy when the driver reports `turn.started`, not here: on a remote driver that report
        // (or even `turn.ended`) can arrive before this call returns.
        await live.driver.send(live.id, lane.key, rows.map(toDriverMessage));
        sent = true;
      } catch (error) {
        this.inbox.mark(rows.map((r) => r.id), "pending");
        if (!(error instanceof WordError && error.code === "conflict")) throw error; // conflict: the driver is in a turn already
      }
    } finally { lane.sending = false; }
    // What arrived while the batch was being handed over now meets a busy lane.
    if (lane.busy) for (const row of this.inbox.pending(live.id, lane.key)) this.bg(this.busyRoute(live, lane, row), `route ${row.id}`);
    else if (sent) this.bg(this.drain(live, lane), `drain ${live.id}/${lane.key}`); // the turn is over already: what came meanwhile goes next
  }

  /** A message came while the lane is in a turn: the owner's words go to the reflex judgement, the rest queue for the next turn. */
  private async busyRoute(live: Live, lane: Lane, row: InboxRow): Promise<void> {
    if (lane.routing.has(row.id) || this.paused) return;
    lane.routing.add(row.id);
    try {
      let action: "interrupt" | "steer" | "followup" = "followup";
      if (row.from === OWNER_ID) {
        const reply = await this.deps.router.send({ to: "service:reflex", kind: "request", word: "conversation.control", body: { message_id: row.id, agent: live.id, lane: lane.key } }, SERVICE_CALLER);
        const chosen = reply.ok ? (reply.result?.data as { action?: string } | undefined)?.action : undefined;
        if (chosen === "interrupt" || chosen === "steer") action = chosen;
        if (chosen === "pause") { // the switch is the admin service's; the message waits, and the pause interrupts the turn
          const paused = await this.deps.router.send({ to: "service:admin", kind: "request", word: "pause", body: { by: row.id } }, SERVICE_CALLER);
          if (paused.ok) return;
          action = "interrupt"; // admin is not there or refused: at least stop this turn
        }
      }
      if (!this.isUp(live)) return; // the process was stopped or replaced while we were asking: the message waits in the inbox
      if (!lane.busy) { this.bg(this.drain(live, lane), "drain"); return; } // the turn ended while we were asking
      if (this.inbox.get(row.id)?.state !== "pending") return;
      if (action === "interrupt") {
        await live.driver.interrupt(live.id, lane.key); // the message waits; the turn ending sends it
      } else if (action === "steer" && lane.turn && (await live.driver.steer(live.id, lane.key, row.text))) {
        this.inbox.mark([row.id], "sent", lane.turn);
      } else {
        this.inbox.mark([row.id], "sent");
        await live.driver.followup(live.id, lane.key, [toDriverMessage(row)]);
      }
    } catch (error) {
      this.inbox.mark([row.id], "pending");
      this.log(`agents: routing ${row.id}: ${errorText(error)}`);
    } finally { lane.routing.delete(row.id); }
  }

  /** Before a turn: ask `service:cost` whether the agent is within its quota. Offline or unsure: go ahead. */
  private async quotaAllows(live: Live, lane: Lane): Promise<boolean> {
    const reply = await this.deps.router.send({ to: "service:cost", kind: "request", word: "quota.check", body: { agent: live.id } }, SERVICE_CALLER);
    const data = reply.ok ? (reply.result?.data as { allowed?: boolean; reason?: string; used?: number; limit?: number } | undefined) : undefined;
    if (data?.allowed !== false) { lane.quotaNoticed = false; return true; }
    if (!lane.quotaNoticed) {
      lane.quotaNoticed = true;
      this.tellOwner(data.reason || `${live.id} 今天的额度用完了${data.limit ? `（${data.used ?? "?"}/${data.limit}）` : ""}，先不开新的一轮；你的消息我留着。`);
    }
    return false;
  }

  /** Put the dynamic modules whose content changed into the lane's session (all of them every REINJECT_EVERY turns). */
  private async inject(live: Live, lane: Lane, only?: ModuleId[]): Promise<void> {
    const decl = this.run(live.id).spec.decl;
    const all = (await this.modules.dynamic(decl, lane.key)).filter((m) => !only || only.includes(m.id));
    const force = lane.turnsSince >= REINJECT_EVERY || !!only;
    const changed = all.filter((m) => force || lane.injected.get(m.id) !== m.version);
    if (!changed.length) return;
    await live.driver.inject(live.id, lane.key, { modules: changed });
    for (const m of changed) lane.injected.set(m.id, m.version);
    if (force && !only) lane.turnsSince = 0;
  }

  /** Public: put what changed (files, environment) into a running agent's lanes now, between turns if need be. */
  async refreshModules(id: string, key?: string): Promise<void> {
    const live = this.running(id);
    for (const lane of live.lanes.values()) if (!key || key === lane.key) await this.inject(live, lane);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // what a driver reports
  // ----------------------------------------------------------------------------------------------------------------

  onEvent(ev: AgentEvent): void {
    try { this.handleEvent(ev); } catch (error) { this.log(`agents: event ${ev.event} of ${ev.agent}: ${errorText(error)}`); }
  }

  private handleEvent(ev: AgentEvent): void {
    const live = this.liveOf(ev.agent);
    switch (ev.event) {
      case "handle.updated":
        if (this.runs.get(ev.agent)) this.runs.patch(ev.agent, (spec) => { spec.sessions[ev.key] = ev.handle; });
        return;
      case "error": this.log(`agents: ${ev.agent}: ${ev.message}`); return;
      case "notice": this.tellOwner(ev.text); return;
      case "ended": this.onEnded(ev.agent, ev.reason); return;
      default:
    }
    if (!live) return;
    const lane = live.lanes.get(ev.key);
    if (!lane) return; // a lane the declaration does not have
    switch (ev.event) {
      case "turn.started":
        lane.busy = true;
        lane.turn = ev.turn;
        lane.turnsSince++;
        this.outputs.set(ev.turn, []);
        if (ev.ids?.length) this.inbox.mark(ev.ids, "sent", ev.turn);
        this.emit(ev.agent, "turn.started", { turn: ev.turn, lane: ev.key, ...(ev.ids ? { ids: ev.ids } : {}) }, ev.turn);
        return;
      case "output": {
        this.outputs.get(ev.turn)?.push(ev.text);
        if (this.speaks(live.id, ev.key)) this.say(ev.agent, ev.text, ev.turn);
        return;
      }
      case "thought": return; // the activity page only; not on the ledger
      case "tool":
        this.emit(ev.agent, "agent.tool", { turn: ev.turn, name: ev.name, phase: ev.phase, ...(ev.summary ? { summary: ev.summary } : {}), ...(ev.ok === undefined ? {} : { ok: ev.ok }) }, ev.turn);
        if (ev.phase === "start") this.trigger(live, ev.key, `${ev.key}:tool`, `Lane ${ev.key} called the tool ${ev.name}${ev.summary ? ` (${ev.summary})` : ""}.`, ev.turn);
        return;
      case "turn.ended":
        if (lane.turn !== ev.turn) return; // a turn that was already ended (the process was cut off) or is not this attempt's: ended once
        this.finishTurn(live, lane, ev);
        return;
    }
  }

  /** Tell the owner in one line what went wrong, and offer a retry card. */
  private failureNotice(agent: string, turn: string, error?: string): void {
    const who = agentCaller(agent, turn);
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "say", body: { text: failureText(error), kind: "reply" } }, who), "failure notice");
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "show", body: { card: { type: "options", prompt: "要我再试一次吗？", options: [{ id: `${RETRY_OPTION}:${turn}`, text: "重试" }] } } }, who), "retry card");
  }

  /** Put the failed batch of that turn (the retry card carries its turn in the option id) back in the inbox. False when there is none. */
  private retryFailed(id: string, lane: string, turn: string): boolean {
    if (!this.inbox.requeue(id, turn)) return false;
    const live = this.upOf(id);
    const l = live?.lanes.get(lane);
    if (live && l && !this.paused) this.bg(l.busy ? Promise.resolve() : this.drain(live, l), `retry ${id}/${lane}`);
    return true;
  }

  private speaks(id: string, key: string): boolean {
    const lane: LaneDecl | undefined = lanesOf(this.run(id).spec.decl)[key];
    return lane?.speak ?? !!lane?.from?.includes(OWNER_ID);
  }

  /**
   * `cut`: the turn ends because its process went away (see `cutTurns`), not because the driver said so. Nothing is handed to
   * that driver any more; what was not failed stays `sent`, so the next process hears of it (`interruptedNotice`); the ask that
   * was in it is told result_unknown, nobody knows whether it was done. The string is the reason named in that message.
   */
  private finishTurn(live: Live, lane: Lane, ev: Extract<AgentEvent, { event: "turn.ended" }>, cut?: string): void {
    const slot = this.slots.get(live.id);
    if (ev.outcome === "completed" && slot) this.stable(slot); // a round done: earlier failures no longer count, and a troubled agent is back
    lane.busy = false;
    lane.turn = undefined;
    const rows = this.inbox.byTurn(ev.turn);
    // A turn that was answering the owner and failed is kept as failed, so 「重试」 can deliver the same batch again.
    const failed = ev.outcome === "error" && this.speaks(live.id, ev.key) && rows.some((r) => r.from === OWNER_ID);
    if (!cut || failed) this.inbox.finish(ev.turn, ev.outcome === "interrupted" ? "interrupted" : failed ? "failed" : "done");
    const said = (this.outputs.get(ev.turn) ?? []).join("\n\n");
    this.outputs.delete(ev.turn);
    for (const row of rows) {
      const waiter = this.waiters.get(row.id);
      if (!waiter) continue;
      this.waiters.delete(row.id);
      if (cut !== undefined) waiter.reject(new WordError("result_unknown", `${live.id} went away in the middle of the turn that took this question (${cut}); it is not known whether it was done`));
      else if (ev.outcome === "completed") waiter.resolve(said);
      else waiter.reject(new WordError(ev.outcome === "cancelled" ? "cancelled" : "failed", ev.error ?? `the turn ended: ${ev.outcome}`));
    }
    if (cut === undefined) this.usageSoon(live.id);
    // The end of the turn goes first: whoever judges from it whether the turn spoke must not take the failure notice for speech.
    this.emit(live.id, "turn.ended", { turn: ev.turn, lane: ev.key, outcome: ev.outcome, ...(ev.error ? { error: ev.error } : {}) }, ev.turn);
    if (failed) this.failureNotice(live.id, ev.turn, ev.error);
    // The hub is going down: the turns it cuts are over, and they start nothing else.
    if (this.closing) return;
    // A turn that another lane's `on` started does not start further lanes: that would loop.
    if (!(rows.length && rows.every((r) => r.word === "lane"))) this.trigger(live, ev.key, `${ev.key}:turn.ended`, `Lane ${ev.key} finished a turn (${ev.outcome}). Its turn id is ${ev.turn}; service:history/turn shows what happened in it.`, ev.turn);
    if (cut !== undefined) return; // this process is gone: no reload, compact or drain on it
    if (lane.reloadPending) { lane.reloadPending = false; this.bg(this.reloadLane(live, lane), "reload"); }
    if (lane.compactPending) { lane.compactPending = false; this.bg(live.driver.session.compact(live.id, lane.key), "compact"); }
    this.bg(this.drain(live, lane), `drain ${live.id}/${lane.key}`);
  }

  /** `on: ["<lane>:turn.ended"]` and `["<lane>:tool"]`: inside the module, no subscription. */
  private trigger(live: Live, from: string, event: string, textOf: string, turn: string): void {
    for (const [key, lane] of Object.entries(lanesOf(this.run(live.id).spec.decl))) {
      if (key === from || !lane.on?.includes(event)) continue;
      this.enqueue(live.id, { id: this.newId(), from: live.id, word: "lane", text: textOf, attachments: [], at: this.now() }, key);
    }
  }

  /** The process ended by itself. The member stays: it is started again (at once the first time), and what the owner says in between goes to the inbox. */
  private onEnded(id: string, reason?: string): void {
    const slot = this.slots.get(id);
    const live = slot?.live;
    if (!slot || !live) return;
    live.ended = reason ?? "the process ended";
    if (slot.phase === "starting") return; // the attempt takes it from here
    if (slot.phase !== "running") return;
    // A process that stayed up for a while has not been dying "in a row".
    if (this.now() - live.startedAt >= STABLE_RUN_MS) this.stable(slot);
    this.bg(this.failed(slot, reason ?? "the process ended", true, "进程重启"), `restart ${id}`);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // out to the router
  // ----------------------------------------------------------------------------------------------------------------

  private emit(agent: string, word: string, body: unknown, turn?: string): void {
    this.bg(this.deps.router.send({ to: null, kind: "event", word, body }, agentCaller(agent, turn)), `event ${word}`);
  }
  private say(agent: string, words: string, turn?: string): void {
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "say", body: { text: words } }, agentCaller(agent, turn)).then((r) => { if (!r.ok) this.log(`agents: ${agent} could not say: ${r.error.code}`); }), "say");
  }
  /** The hub itself tells the owner something. */
  tellOwner(words: string): void {
    this.bg(this.deps.router.send({ to: OWNER_ID, kind: "request", word: "say", body: { text: words, kind: "heads_up" } }, SERVICE_CALLER), "tell owner");
  }

  // ----------------------------------------------------------------------------------------------------------------
  // asking an agent and waiting for its answer
  // ----------------------------------------------------------------------------------------------------------------

  /** Wait for the answer to a message: the words of the turn that took it, or an `answer` word. */
  expect(agent: string, id: string, from: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.waiters.set(id, { id, agent, from, since: this.now(), resolve, reject });
      signal?.addEventListener("abort", () => { if (this.waiters.delete(id)) reject(new WordError("cancelled", "the question was cancelled")); }, { once: true });
    });
  }
  waiter(id: string): Waiter | undefined { return this.waiters.get(id); }
  settle(id: string, answer: string): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    this.waiters.delete(id);
    w.resolve(answer);
    return true;
  }
  rejectWaiter(id: string, error: WordError): void {
    const w = this.waiters.get(id);
    if (w) { this.waiters.delete(id); w.reject(error); }
  }
  threads(): Waiter[] { return [...this.waiters.values()]; }
  private rejectWaiters(agent: string, error: WordError): void {
    for (const [id, w] of this.waiters) if (w.agent === agent) { this.waiters.delete(id); w.reject(error); }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // sessions
  // ----------------------------------------------------------------------------------------------------------------

  lane(live: Live, key: string): Lane {
    const lane = live.lanes.get(key);
    if (!lane) throw new WordError("not_found", `${live.id} has no lane ${key}`);
    return lane;
  }

  /** The lane's session starts afresh: nothing has been injected into it yet. */
  forgetInjected(lane: Lane): void { lane.injected.clear(); lane.turnsSince = 0; }

  /** A new session with the current static modules. Skipped when they have not changed since this lane's session opened. */
  async reloadLane(live: Live, lane: Lane, force = false): Promise<{ handle: string | null; skipped: boolean }> {
    const statics = await this.modules.static(this.run(live.id).spec.decl);
    const hash = staticHash(statics);
    if (!force && this.run(live.id).spec.static_hash[lane.key] === hash) return { handle: live.driver.session.get(live.id, lane.key), skipped: true };
    const { handle } = await live.driver.session.reload(live.id, lane.key, { static: statics });
    this.runs.patch(live.id, (spec) => { spec.sessions[lane.key] = handle; spec.static_hash[lane.key] = hash; });
    this.forgetInjected(lane);
    return { handle, skipped: false };
  }

  // ----------------------------------------------------------------------------------------------------------------
  // keys and usage
  // ----------------------------------------------------------------------------------------------------------------

  /**
   * Give the runtime the keys; true when every one that was to go in is in (a failed write is logged, the next turn tries again).
   * A key the runtime has is left alone unless `force`: the owner has saved one, which wins over whatever the runtime holds.
   */
  async syncCredentials(live: Live, refs = this.deps.credentialRefs ?? DEFAULT_CREDENTIAL_REFS, force = false): Promise<boolean> {
    const driver = live.driver;
    if (!driver.credentialsHas || !driver.credentialsSet) return true;
    let all = true;
    for (const ref of refs) {
      const value = this.deps.vault.use(ref);
      if (!value) continue;
      try {
        if (force || !(await driver.credentialsHas(live.id, ref))) await driver.credentialsSet(live.id, ref, value);
      } catch (error) { all = false; this.log(`agents: credential ${ref} for ${live.id}: ${(error as { code?: string }).code ?? "failed"}`); }
    }
    return all;
  }

  /**
   * One key write to the agent's runtime, after the ones before it (they follow each other). It lets go after KEY_SYNC_TIMEOUT_MS
   * when the runtime does not answer, and says whether it landed in time. What the slot learns from it is `keysSeen`, the count
   * that stood when the write began, and only when it landed: a write that lands late still records its own, older count, and
   * `ensureKeys` writes the newer keys over it before the next turn.
   */
  private syncKeys(live: Live, force: boolean, at?: number): Promise<boolean> {
    const slot = this.slots.get(live.id);
    const land = async (): Promise<boolean> => {
      const seen = at ?? this.keySaves;
      const ok = await this.syncCredentials(live, undefined, force);
      if (ok && slot && slot.live === live) slot.keysSeen = seen;
      return ok;
    };
    const work = (this.keySync.get(live.id) ?? Promise.resolve()).then(() => this.within(KEY_SYNC_TIMEOUT_MS, `${live.id} did not take the key`, land()).catch((error) => { this.log(`agents: keys for ${live.id}: ${errorText(error)}`); return false; }));
    const tail = work.then(() => {});
    this.keySync.set(live.id, tail);
    return work.finally(() => { if (this.keySync.get(live.id) === tail) this.keySync.delete(live.id); });
  }

  /**
   * Before a turn opens: wait for the key writes on their way, then, if the owner has saved a key since the last one that landed,
   * write the latest (and once more when keys were saved meanwhile). A write that fails or times out is logged and this turn goes
   * on; the next turn compares and tries again. What a stuck runtime costs a turn: first the wait for this agent's writes already on their
   * way (each of them gives up after KEY_SYNC_TIMEOUT_MS), then this turn's own writes, at most KEY_SYNC_TRIES of them and each at
   * most KEY_SYNC_TIMEOUT_MS (a failed one ends the loop, so a runtime that does not answer is tried once). This is
   * the one place the keys' being in time depends on; `onVaultChanged` only makes them arrive early.
   */
  private async ensureKeys(live: Live): Promise<void> {
    const slot = this.slots.get(live.id);
    if (!slot) return;
    await this.keySync.get(live.id);
    for (let writes = 0; writes < KEY_SYNC_TRIES; writes++) {
      if ((slot.keysSeen ?? 0) === this.keySaves || !this.isUp(live)) return;
      if (!(await this.syncKeys(live, true))) return;
    }
    if ((slot.keysSeen ?? 0) !== this.keySaves && this.isUp(live)) this.log(`agents: ${live.id} still lacks the latest keys after ${KEY_SYNC_TRIES} writes; the turn goes on`);
  }

  async onVaultChanged(ref: string, action: string): Promise<void> {
    // Only the keys a runtime may hold for itself; the vault keeps others (gateway, cloud) to itself.
    if (action !== "saved" || !(this.deps.credentialRefs ?? DEFAULT_CREDENTIAL_REFS).includes(ref)) return;
    // Counted before the first await, and the writes queued right away: a turn that is opened in the same breath (a wake from
    // another service) finds them on the way and waits (see `ensureKeys`). A running agent gets the key at once; any other
    // gets it when it starts or before its next turn.
    this.keySaves++;
    await Promise.all(this.ups().map((live) => this.syncKeys(live, true)));
  }

  // ----------------------------------------------------------------------------------------------------------------
  // pause (HUB-MODULES §2.5): the admin service holds the switch; here a pause stops turns, not the inbox
  // ----------------------------------------------------------------------------------------------------------------

  /** Read the switch. No admin service, or no answer, means not paused. */
  async refreshPaused(): Promise<void> {
    const reply = await this.deps.router.send({ to: "service:admin", kind: "request", word: "status", body: {} }, SERVICE_CALLER);
    const paused = reply.ok && (reply.result?.data as { paused?: boolean } | undefined)?.paused === true;
    if (paused === this.paused) return;
    this.paused = paused;
    for (const live of this.ups()) for (const lane of live.lanes.values()) {
      if (paused) { if (lane.busy) this.bg(live.driver.interrupt(live.id, lane.key), "interrupt for pause"); }
      else this.bg(this.drain(live, lane), `drain ${live.id}/${lane.key}`);
    }
  }

  /** After a turn: pull this agent's usage in a few seconds, so the day's count is current without waiting for the ten-minute timer. */
  private usageSoon(id: string): void {
    if (this.usageDue.has(id)) return;
    this.usageDue.set(id, this.timers.after(USAGE_DEBOUNCE_MS, () => { this.usageDue.delete(id); this.bg(this.pollUsage(id), "usage poll"); }));
  }

  /** What the runtimes recorded since last time goes to `service:cost` (every ten minutes for all, and soon after a turn for the one that ran). If it is not there the records are dropped. */
  pollUsage(only?: string): Promise<void> {
    const run = this.usageQueue.then(() => this.pullUsage(only));
    this.usageQueue = run.catch(() => {});
    return run;
  }

  private async pullUsage(only?: string): Promise<void> {
    for (const live of this.ups()) {
      if (only && live.id !== only) continue;
      if (!this.isUp(live) || !live.driver.usage) continue;
      const since = this.run(live.id).spec.usage_since;
      let usage;
      try { usage = await live.driver.usage(live.id, since); } catch (error) { this.log(`agents: usage of ${live.id}: ${errorText(error)}`); continue; }
      let cursor = since;
      for (const r of usage.records as Record<string, any>[]) {
        cursor = Math.max(cursor, Number(r.done ?? r.at ?? 0));
        const reply = await this.deps.router.send({ to: "service:cost", kind: "event", word: "usage.recorded", body: {
          caller: live.id, provider: String(r.provider || "unknown"), model: String(r.model || "unknown"),
          input_tokens: Number(r.input) || 0, output_tokens: Number(r.output) || 0, ...(Number(r.cacheRead) > 0 ? { cache_read_tokens: Number(r.cacheRead) } : {}), ok: r.ok !== false, at: Number(r.at ?? r.done ?? this.now()),
          ...(typeof r.cost === "number" && r.cost >= 0 ? { cost: r.cost } : {}), // no price known: no cost, never a made-up one
        } }, SERVICE_CALLER);
        if (!reply.ok && reply.error.code === "offline") break;
      }
      this.runs.patch(live.id, (spec) => { spec.usage_since = cursor; });
    }
    if (!only) for (const live of this.ups()) for (const lane of live.lanes.values()) this.bg(this.drain(live, lane), "drain");
  }

  // ----------------------------------------------------------------------------------------------------------------
  // temporary workers
  // ----------------------------------------------------------------------------------------------------------------

  /** Run one task on a throwaway agent: declare it, ask it, collect the answer, delete it. */
  async runWorker(decl: AgentDecl, task: string, from: string, timeoutS: number): Promise<string> {
    this.runs.put({ id: decl.id, spec: { decl, sessions: {}, static_hash: {}, usage_since: this.now() } });
    let stop = () => {};
    try {
      await this.startAgent(decl.id);
      if (!this.upOf(decl.id)) throw new WordError("failed", "the temporary agent could not start");
      const id = this.newId();
      const answer = this.expect(decl.id, id, from);
      const timeout = new Promise<never>((_, reject) => { stop = this.timers.after(timeoutS * 1000, () => reject(new WordError("timeout", "the temporary agent did not finish in time"))); });
      this.enqueue(decl.id, { id, from, word: "ask", text: task, attachments: [], at: this.now() });
      return await Promise.race([answer, timeout]);
    } finally {
      stop();
      await this.forget(decl.id, "done");
    }
  }
}

const newLane = (key: string): Lane => ({ key, busy: false, sending: false, injected: new Map(), turnsSince: 0, reloadPending: false, compactPending: false, quotaNoticed: false, routing: new Set() });

export const staticHash = (modules: PromptModule[]): string =>
  createHash("sha256").update(modules.map((m) => `${m.id}:${m.version}`).join("|")).digest("hex").slice(0, 12);

export type { Live, Lane, Waiter };
