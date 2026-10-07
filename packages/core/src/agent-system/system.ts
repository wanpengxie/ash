import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { AGENT_ID, wordContract } from "../../../sdk/src/words";
import type { AgentMember } from "../members/agent";
import type { Member, WorldMembers } from "../world/member";
import type { RouteHandlerContext, TrustedRouteContext, WorldRouter } from "../world/router";
import { BUILT_IN_IDS, agentName, wordAllowed, type AgentDeclaration } from "../agents";
import type { AgentThread } from "../world/ledger";

/** What the Agent system needs from the runtime to bring a declared agent to life (the container runtime provides it). */
export interface AgentRuntime {
  /** The member (inbox, turns) and everything behind it: session, tool credential, workspace. */
  create(declaration: () => AgentDeclaration): AgentMember;
  /** Close the agent's session so its next turn reopens it (its history is kept). */
  reopen(id: string): Promise<void>;
  /** Forget everything created for a removed agent. */
  dispose(id: string): Promise<void>;
  /** Apply a changed declaration to the agent's tool credential. */
  apply(declaration: AgentDeclaration): void;
  available?(declaration: AgentDeclaration): string | null;
  runtimes?(): Record<string, unknown>[];
}

export interface AgentSystemOptions {
  router: WorldRouter;
  members: WorldMembers;
  stateDir: string;
  /** The agents of a fresh world: the main agent and the built-in ones. */
  defaults: AgentDeclaration[];
  main: AgentMember;
  /** Absent when only the main agent can run (no container). */
  runtime: AgentRuntime | null;
  /** Fixed tool names an agent can be given. */
  toolNames: readonly string[];
  isPaused: () => boolean;
  log?: (...args: unknown[]) => void;
}

interface Exchange { id: string; kind: "ask" | "tell"; from: string; to: string; turn: string | null; texts: string[]; done: boolean; at: number;
  resolve?: (body: ResponseBody) => void; result?: ResponseBody }

const WORDS = ["list", "runtimes", "threads", "thread.stop", "describe", "ask", "tell", "answer", "declare", "update", "start", "stop", "restart", "remove"];
const MANAGE = new Set(["declare", "update", "start", "stop", "restart", "remove"]);
const service: TrustedRouteContext = { member: "service:agents", transport: "service", transportPrincipal: "service:agents", local: true, remote: false, ownerProxy: false };
const schedule: TrustedRouteContext = { member: "service:work", transport: "service", transportPrincipal: "service:work", local: true, remote: false, ownerProxy: false };
const fail = (code: "bad_request" | "forbidden" | "not_found" | "offline" | "failed", message: string): ResponseBody => ({ ok: false, error: { code, message } });

/**
 * ash's Agent system. It holds every agent's declaration (kept in ash's state), brings declared agents to life and
 * stops, restarts or removes them, wakes them on their schedule, and carries what agents say to each other: a question
 * is answered by the turn that takes it, news is delivered and what comes back is passed on once (never bounced again).
 * Agents reach it through the agent words (list, describe, ask, tell); managers also through the system words.
 */
export class AgentSystem implements Member {
  readonly id = "service:agents";
  readonly kind = "service" as const;
  readonly name = "Agents";
  readonly online = true;
  private readonly declarations = new Map<string, AgentDeclaration>();
  private readonly live = new Map<string, AgentMember>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly lastWake: Record<string, number>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stopFollowing: () => void;
  private readonly file: string;
  private readonly wakeFile: string;

  constructor(private readonly options: AgentSystemOptions) {
    this.file = join(options.stateDir, "agents.json");
    this.wakeFile = join(options.stateDir, "agent-schedule.json");
    const stored = this.read<{ agents?: AgentDeclaration[] }>(this.file)?.agents;
    for (const item of stored ?? options.defaults) if (AGENT_ID.test(item.id)) this.declarations.set(item.id, item);
    // A built-in agent added by a newer ash joins an existing world; the main agent is always there.
    for (const item of options.defaults) if (!this.declarations.has(item.id) && (!stored || BUILT_IN_IDS.has(item.id))) this.declarations.set(item.id, item);
    this.save();
    this.lastWake = this.read<Record<string, number>>(this.wakeFile) ?? {};
    this.stopFollowing = options.router.subscribe((message) => this.follow(message));
    options.router.setAgentAvailability(id => {
      const item = this.declaration(id);
      return !!item && item.enabled !== false && !options.runtime?.available?.(item);
    });
  }

  words(): readonly WordSpec[] { return WORDS.map((word) => wordContract("service:agents", word)!); }

  /** Every declaration, the main agent first. */
  all(): AgentDeclaration[] { return [...this.declarations.values()].sort((a, b) => (a.id === "agent:main" ? -1 : b.id === "agent:main" ? 1 : a.id.localeCompare(b.id))); }
  declaration(id: string): AgentDeclaration | undefined { return this.declarations.get(id); }
  /** Live intersection: delegate and every delegator retain their own current limits. */
  private policies(id: string, turn?: string): AgentDeclaration[] {
    const ids = new Set([id, ...this.options.router.ledger.threadAncestors(turn).map(thread => thread.from)]);
    return [...ids].map(id => this.declaration(id) ?? { id, name: id, summary: "removed", tools: [], words: [] });
  }
  toolAllowed(id: string, turn: string | undefined, tool: string): boolean { return this.policies(id, turn).every(policy => !policy.tools || policy.tools.includes(tool)); }
  wordAllowed(id: string, turn: string | undefined, member: string, word: string): boolean { return this.policies(id, turn).every(policy => wordAllowed(policy, member, word)); }
  member(id: string): AgentMember | undefined { return id === "agent:main" ? this.options.main : this.live.get(id); }
  /** The declared agents that are running here, besides the main one. */
  agents(): AgentMember[] { return [...this.live.values()]; }

  private read<T>(file: string): T | null { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null; } catch { return null; } }
  private write(file: string, value: unknown): void {
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 });
    renameSync(temp, file);
  }
  private save(): void { this.write(this.file, { version: 1, agents: [...this.declarations.values()] }); }

  /** Create every declared agent's member. Call after the main agent is registered and before router recovery. */
  prepare(): void {
    if (!this.options.runtime) return;
    for (const item of this.declarations.values()) if (item.id !== "agent:main") this.bring(item.id, false);
  }

  /** Start the declared agents and their schedule. Call after router recovery. */
  async start(): Promise<void> {
    for (const member of this.live.values()) await member.start();
    for (const [id, member] of this.live) member.setEnabled(this.declarations.get(id)?.enabled !== false);
    // A newly added agent first wakes half an hour later, then on its interval.
    for (const item of this.declarations.values()) if (item.every && typeof this.lastWake[item.id] !== "number")
      this.lastWake[item.id] = Date.now() - Math.max(0, item.every * 1000 - 30 * 60_000);
    this.write(this.wakeFile, this.lastWake);
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stopFollowing();
    for (const exchange of this.exchanges.values()) if (!exchange.done) exchange.resolve?.(fail("offline", "ash is shutting down"));
    for (const member of this.live.values()) await member.close();
  }

  private bring(id: string, startNow: boolean): AgentMember {
    const member = this.options.runtime!.create(() => this.declarations.get(id)!);
    this.options.members.register(member);
    member.prepareRecovery();
    this.live.set(id, member);
    if (startNow) void member.start().then(() => member.setEnabled(this.declarations.get(id)?.enabled !== false))
      .catch((error) => this.options.log?.("agent failed to start", id, error));
    return member;
  }

  private info(item: AgentDeclaration): Record<string, unknown> {
    const member = this.member(item.id);
    const counts = member?.counts();
    const state = item.enabled === false || !member ? "stopped" : member.lastError ? "error" : counts?.active ? "working" : "idle";
    return { id: item.id, name: item.name, summary: item.summary, state, available: item.enabled !== false && !this.options.runtime?.available?.(item), main: item.id === "agent:main", manage: item.manage === true,
      brief: item.brief ?? "", tools: item.tools ? [...item.tools] : null, words: item.words ? [...item.words] : null, every: item.every ?? null,
      built_in: BUILT_IN_IDS.has(item.id), runtime: item.runtime ?? "container", ...(item.created_by ? { created_by: item.created_by } : {}) };
  }

  /** Wake each agent that has a schedule, when it is idle and ash is not paused. The last wake survives restarts. */
  private tick(): void {
    if (this.options.isPaused()) return;
    for (const item of this.declarations.values()) {
      const member = this.live.get(item.id);
      if (!item.every || !member || item.enabled === false || Date.now() - (this.lastWake[item.id] ?? 0) < item.every * 1000) continue;
      const counts = member.counts();
      if (counts.active || counts.pending) continue;
      this.lastWake[item.id] = Date.now();
      this.write(this.wakeFile, this.lastWake);
      void this.options.router.send(schedule, { to: item.id, kind: "request", word: "say",
        body: { text: `[定时唤醒] 按你的职责做一次例行工作。现在是 ${new Date().toISOString()}。` },
        client_id: `schedule:${item.id}:${Math.floor(Date.now() / (item.every * 1000))}` }).catch((error) => this.options.log?.("scheduled wake failed", item.id, error));
    }
  }

  /** Track which turn takes a delivered question or news, and finish the exchange when that turn ends. */
  private follow(message: Message): void {
    // Register before the destination runs, even when its answer is synchronous.
    if (message.kind === "request" && message.from === "service:agents" && message.word === "say" && message.thread) {
      const work = this.options.router.ledger.agentThread(message.thread);
      const request = work && this.options.router.ledger.byId(work.request);
      if (work && request && ["ask", "tell"].includes(request.word)) this.exchanges.set(message.id, {
        id: message.id, kind: request.word as "ask" | "tell", from: work.from, to: work.to, turn: null, texts: [], done: false, at: message.ts,
      });
    }
    if (message.kind !== "event" || !AGENT_ID.test(message.from)) return;
    const ids = Array.isArray(message.body.ids) ? message.body.ids as unknown[] : [];
    if ((message.word === "turn.start" || message.word === "read") && ids.length) {
      for (const exchange of this.exchanges.values()) if (!exchange.done && !exchange.turn && exchange.to === message.from && ids.includes(exchange.id)) exchange.turn = String(message.body.turn);
      return;
    }
    if (message.word !== "turn.end") return;
    const ledger = this.options.router.ledger;
    const work = ledger.threadForTurn(String(message.body.turn));
    if (work) ledger.saveAgentThread({ ...work, state: work.state === "cancelled" ? "cancelled" : message.body.reason as AgentThread["state"] });
    if (message.body.reason !== "completed") this.cancelChildren(String(message.body.turn));
    for (const exchange of this.exchanges.values()) {
      if (exchange.done || exchange.to !== message.from || exchange.turn !== message.body.turn) continue;
      exchange.done = true;
      const answer = exchange.texts.join("\n\n");
      if (exchange.kind === "ask") {
        exchange.result = message.body.reason === "completed" ? { ok: true, result: { agent: exchange.to, answer } }
          : fail("failed", `${exchange.to} stopped before answering (${String(message.body.reason)})`);
        exchange.resolve?.(exchange.result);
      } else if (answer.trim()) {
        // What came back from news goes to the sender once; the turn that reads it says nothing, so nobody bounces it.
        void this.options.router.send(service, { to: exchange.from, kind: "request", word: "say",
          body: { text: `（${exchange.to} 回复你之前告诉它的事）\n${answer}`, reply_from: exchange.to }, client_id: `agents:reply:${exchange.id}` })
          .catch((error) => this.options.log?.("agent reply not delivered", exchange.id, error));
      }
    }
    if (this.exchanges.size > 500) for (const [id, exchange] of this.exchanges) if (exchange.done && Date.now() - exchange.at > 3_600_000) this.exchanges.delete(id);
  }

  private cancelChildren(turn: string): void {
    for (const child of this.options.router.ledger.agentThreads(turn)) {
      if (["completed", "cancelled", "error"].includes(child.state)) continue;
      this.options.router.ledger.saveAgentThread({ ...child, state: "cancelled" });
      if (child.turn) { this.member(child.to)?.cancelWork(child.turn, "Delegating task was stopped"); this.cancelChildren(child.turn); }
    }
  }

  private async deliver(kind: "ask" | "tell", from: string, to: string, text: string, request: Message): Promise<{ id: string; exchange: Exchange }> {
    const lead = kind === "ask" ? `（${from} 问你，请在正文里直接回答）` : `（${from} 告诉你）`;
    const ledger = this.options.router.ledger;
    const thread: AgentThread = { id: `w_${request.seq.toString(36)}`, request: request.id, from, to, at: request.ts, state: "pending",
      ...(request.turn ? { parent_turn: request.turn, parent: ledger.threadForTurn(request.turn)?.id } : {}) };
    ledger.saveAgentThread(thread);
    const sent = await this.options.router.send({ ...service, thread: thread.id }, { to, kind: "request", word: "say", body: { text: `${lead}\n${text}`, from_agent: from }, client_id: `delivery:${request.id}` });
    ledger.saveAgentThread({ ...(ledger.agentThread(thread.id) ?? thread), delivery: sent.id });
    const exchange: Exchange = this.exchanges.get(sent.id) ?? { id: sent.id, kind, from, to, turn: null, texts: [], done: false, at: Date.now() };
    this.exchanges.set(sent.id, exchange);
    return { id: sent.id, exchange };
  }

  async handle(message: Message, _context: RouteHandlerContext): Promise<ResponseBody> {
    const from = message.from;
    const caller = this.declarations.get(from);
    const owner = from === "person:owner";
    if (!owner && !caller) return fail("forbidden", "only the owner and declared agents use the Agent system");
    if (caller && caller.enabled === false) return fail("forbidden", "a stopped agent cannot use the Agent system");
    if (MANAGE.has(message.word) && !owner && caller?.manage !== true) return fail("forbidden", "managing agents is not among your abilities");
    const body = message.body;
    const target = typeof body.agent === "string" ? body.agent : "";
    switch (message.word) {
      case "threads": return owner ? { ok: true, result: { threads: this.options.router.ledger.agentThreads() } } : fail("forbidden", "owner only");
      case "thread.stop": {
        if (!owner) return fail("forbidden", "owner only");
        const thread = this.options.router.ledger.agentThread(String(body.thread));
        if (!thread || ["completed", "error", "cancelled"].includes(thread.state)) return { ok: true, result: { cancelled: false } };
        this.options.router.ledger.saveAgentThread({ ...thread, state: "cancelled" });
        if (thread.turn) { this.member(thread.to)?.cancelWork(thread.turn, "Owner stopped this work thread"); this.cancelChildren(thread.turn); }
        return { ok: true, result: { cancelled: true } };
      }
      case "list": return { ok: true, result: { agents: this.all().map((item) => this.info(item)) } };
      case "runtimes": return { ok: true, result: { runtimes: this.options.runtime?.runtimes?.() ?? [] } };
      case "describe": {
        const item = this.declarations.get(target);
        return item ? { ok: true, result: this.info(item) } : fail("not_found", `no agent ${target}`);
      }
      case "ask":
      case "tell": {
        if (owner) return fail("forbidden", "the owner talks with the main agent");
        if (target === from) return fail("bad_request", "that is you");
        const item = this.declarations.get(target);
        if (!item || !this.member(target)) return fail("not_found", `no agent ${target}`);
        if (item.enabled === false) return fail("offline", `${target} is stopped`);
        const unavailable = this.options.runtime?.available?.(item); if (unavailable) return fail("forbidden", unavailable);
        const chain = this.options.router.ledger.threadAncestors(message.turn);
        if (chain.length >= 3 || chain.some(thread => thread.from === target)) return fail("forbidden", "Delegation is limited to three levels and must not form a cycle");
        const { id, exchange } = await this.deliver(message.word, from, target, String(body.text), message);
        if (message.word === "tell") return { ok: true, result: { sent: true, message_id: id } };
        return await new Promise<ResponseBody>((resolve) => {
          exchange.resolve = resolve;
          if (exchange.result) resolve(exchange.result);
          _context.signal.addEventListener("abort", () => {
            const thread = this.options.router.ledger.agentThread(`w_${message.seq.toString(36)}`);
            if (thread && !["completed", "cancelled", "error"].includes(thread.state)) {
              this.options.router.ledger.saveAgentThread({ ...thread, state: "cancelled" });
              if (thread.turn) { this.member(thread.to)?.cancelWork(thread.turn, "Delegation cancelled"); this.cancelChildren(thread.turn); }
            }
            resolve(fail("failed", "Delegation cancelled; effects may be unknown"));
          }, { once: true });
        });
      }
      case "answer": {
        const exchange = typeof body.in_reply_to === "string" ? this.exchanges.get(body.in_reply_to) : undefined;
        if (!exchange || exchange.to !== from) return fail("not_found", "no question or news of yours to answer");
        if (!exchange.done && typeof body.text === "string") exchange.texts.push(body.text);
        return { ok: true, result: { accepted: true } };
      }
      case "declare": return this.declare(body, caller, message.turn);
      case "update": return this.update(target, body, caller, message.turn);
      case "start":
      case "stop":
      case "restart": return this.control(message.word, target);
      case "remove": return this.remove(target);
    }
    return fail("not_found", "agent system word not available");
  }

  private validate(body: Record<string, unknown>): string | null {
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => !this.options.toolNames.includes(String(tool)))))
      return `tools must be names from: ${this.options.toolNames.join(", ")}`;
    if (body.words !== undefined && (!Array.isArray(body.words) || body.words.some((word) => typeof word !== "string" || !/^[a-z]+:[A-Za-z0-9_*-]+\/[A-Za-z0-9._*-]+$/.test(word))))
      return "words are member/word patterns such as service:self/read or device:phone/*";
    return null;
  }

  private authority(item: AgentDeclaration, caller?: AgentDeclaration): string | null {
    if (!caller) return null;
    if (caller.tools && (!item.tools || item.tools.some(tool => !caller.tools!.includes(tool)))) return "new agent tools exceed the creator's authority";
    if (caller.words && (!item.words || item.words.some(pattern => !caller.words!.some(parent => {
      if (parent === pattern || parent === "*/*") return true;
      // Conservative containment: simple trailing wildcards cover a narrower prefix; other patterns must match exactly.
      return parent.endsWith("*") && !parent.slice(0, -1).includes("*") && pattern.startsWith(parent.slice(0, -1));
    })))) return "new agent capabilities exceed the creator's authority";
    return null;
  }

  private declare(body: Record<string, unknown>, caller?: AgentDeclaration, turn?: string): ResponseBody {
    if (!this.options.runtime) return fail("offline", "declared agents need the container runtime");
    const id = String(body.id ?? "");
    if (!AGENT_ID.test(id) || this.declarations.has(id) || this.options.members.describe("owner").members.some((member) => member.id === id))
      return fail("bad_request", `${id} is not a new agent id (agent:<lowercase name>)`);
    const problem = this.validate(body);
    if (problem) return fail("bad_request", problem);
    // A new agent finds and talks with the others; anything more is given explicitly. Managing agents is the owner's to grant.
    const item: AgentDeclaration = { id, name: String(body.name), summary: String(body.summary), brief: String(body.brief),
      runtime: body.runtime as AgentDeclaration["runtime"], created_by: caller?.id ?? "person:owner",
      tools: (body.tools as string[] | undefined) ?? ["agent_list", "agent_describe", "agent_ask", "agent_tell", "history_query", "system_status"].filter(t => !caller?.tools || caller.tools.includes(t)),
      words: (body.words as string[] | undefined) ?? [], ...(typeof body.every === "number" ? { every: body.every } : {}) };
    const denied = (caller ? this.policies(caller.id, turn).map(policy => this.authority(item, policy)).find(Boolean) : null) ?? this.options.runtime.available?.(item); if (denied) return fail("forbidden", denied);
    this.declarations.set(id, item);
    this.save();
    if (item.every) { this.lastWake[id] = Date.now(); this.write(this.wakeFile, this.lastWake); }
    try { this.bring(id, true); }
    catch (error) { this.declarations.delete(id); delete this.lastWake[id]; this.save(); throw error; }
    this.options.log?.("agent declared", id);
    return { ok: true, result: this.info(item) };
  }

  private async update(target: string, body: Record<string, unknown>, caller?: AgentDeclaration, turn?: string): Promise<ResponseBody> {
    const item = this.declarations.get(target);
    if (!item) return fail("not_found", `no agent ${target}`);
    const problem = this.validate(body);
    if (problem) return fail("bad_request", problem);
    if (target === "agent:main" && (body.tools !== undefined || body.words !== undefined || body.runtime !== undefined)) return fail("forbidden", "the main agent's abilities are set by the owner");
    const next: AgentDeclaration = { ...item, ...(typeof body.name === "string" ? { name: body.name } : {}), ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
      ...(typeof body.brief === "string" ? { brief: body.brief } : {}), ...(Array.isArray(body.tools) ? { tools: body.tools as string[] } : {}),
      ...(Array.isArray(body.words) ? { words: body.words as string[] } : {}), ...(typeof body.every === "number" ? { every: body.every } : {}),
      ...(body.runtime !== undefined ? { runtime: body.runtime as AgentDeclaration["runtime"] } : {}) };
    const denied = (caller ? this.policies(caller.id, turn).map(policy => this.authority(next, policy)).find(Boolean) : null) ?? this.options.runtime?.available?.(next); if (denied) return fail("forbidden", denied);
    const changedRuntime = JSON.stringify(item.runtime) !== JSON.stringify(next.runtime);
    if (changedRuntime) {
      const previous = this.live.get(target); previous?.setEnabled(false, "Runtime changed");
      await previous?.close(); await this.options.runtime?.dispose(target);
      this.options.members.unregisterAgent(target); this.live.delete(target);
    }
    this.declarations.set(target, next);
    this.save();
    if (target !== "agent:main") this.options.runtime?.apply(next);
    if (changedRuntime) this.bring(target, true);
    return { ok: true, result: this.info(next) };
  }

  private async control(word: "start" | "stop" | "restart", target: string): Promise<ResponseBody> {
    const item = this.declarations.get(target);
    if (!item) return fail("not_found", `no agent ${target}`);
    if (target === "agent:main") return fail("forbidden", "the main agent is paused and resumed by the owner, not stopped");
    const unavailable = word !== "stop" && this.options.runtime?.available?.(item); if (unavailable) return fail("forbidden", unavailable);
    const member = this.live.get(target);
    if (!member) return fail("offline", `${target} is not running here`);
    if (word === "restart") {
      member.setEnabled(false, "Restarted by ash");
      await this.options.runtime!.reopen(target);
      member.setEnabled(item.enabled !== false);
      return { ok: true, result: this.info(item) };
    }
    const next = { ...item, enabled: word === "start" };
    this.declarations.set(target, next);
    this.save();
    member.setEnabled(word === "start", "Stopped by ash");
    return { ok: true, result: this.info(next) };
  }

  private async remove(target: string): Promise<ResponseBody> {
    if (!this.declarations.has(target)) return fail("not_found", `no agent ${target}`);
    if (BUILT_IN_IDS.has(target)) return fail("forbidden", "built-in agents can be stopped, not removed");
    const member = this.live.get(target);
    if (member) {
      member.setEnabled(false, "Removed by ash");
      this.options.members.unregisterAgent(target);
      this.live.delete(target);
      await member.close().catch((error) => this.options.log?.("agent did not close cleanly", target, error));
    }
    // Cleaning up its runtime is best effort (a computer may be offline or re-paired); the removal itself always completes.
    await this.options.runtime?.dispose(target).catch((error) => this.options.log?.("agent runtime not fully cleaned up", target, error));
    this.declarations.delete(target);
    delete this.lastWake[target];
    this.save();
    this.write(this.wakeFile, this.lastWake);
    this.options.log?.("agent removed", target, agentName(target));
    return { ok: true, result: { removed: true } };
  }
}
