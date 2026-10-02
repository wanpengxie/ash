import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorldMembers } from "../../core/src/world/member";
import type { WorldRouter } from "../../core/src/world/router";
import { createDshDoor, type DoorAgent, type DoorOptions, type DshDoor } from "./door";
import type { WorkerRates } from "../../core/src/workers/cost";

export interface DshHostOptions { root: string; home: string; skillsRoot?: string; env?: Record<string, string> }
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
  attachManagedPrompt?(agentContext: unknown): () => void;
}
export interface MainSession { agent: DshRootAgent; door: DshDoor; sessionId: string }
export interface MindSession { agent: DshRootAgent; door: DshDoor; sessionId: string }
export interface SessionResume {
  /** Private core-state journal, never a path supplied by the model or client. */
  file: string;
  /** Every core turn that has reached turn.start, including interrupted turns. */
  startedTurns: ReadonlySet<string>;
  /** Completed turns must have one corresponding DSH prompt in durable history. */
  completedTurns: ReadonlySet<string>;
}

function loadOrCreateSessionId(file: string, startedTurns: ReadonlySet<string>): string {
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("DSH session journal is not a regular private file");
    let raw: { version?: unknown; id?: unknown };
    try { raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; id?: unknown }; }
    catch { throw new Error("invalid DSH session journal"); }
    if (raw.version !== 1 || typeof raw.id !== "string" || !/^session-[0-9a-f-]{36}$/.test(raw.id)) throw new Error("invalid DSH session journal");
    return raw.id;
  }
  if (startedTurns.size) throw new Error("DSH session journal missing for existing core turns; history cannot be discarded");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const id = `session-${randomUUID()}`;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, id })); fsyncSync(fd); }
    finally { closeSync(fd); }
    // Hard-link publication is no-replace even if a second starter races us.
    linkSync(temp, file);
    unlinkSync(temp);
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
  return id;
}

/** Reject DSH-owned queued work before resume can publish an agent and drive it. */
export function assertResumableHistory(events: readonly { type: string; data?: any }[], startedTurns: ReadonlySet<string>, completedTurns: ReadonlySet<string> = new Set()): void {
  const pending = { "next-turn": [] as string[], "next-step": [] as string[] };
  const seenPrompts = new Set<string>();
  const promptTurns = new Map<string, number>();
  const boundDshTurns = new Set<number>();
  const finishedTurns = new Map<number, string>();
  let openTurn: number | null = null;
  for (const event of events) {
    if (event.type === "turn/start") {
      const turn = event.data?.turn;
      if (openTurn !== null || !Number.isSafeInteger(turn) || turn < 1) throw new Error("invalid DSH turn start in history");
      openTurn = turn;
    } else if (event.type === "turn/end") {
      const turn = event.data?.turn;
      const reason = event.data?.reason?.kind;
      // A cancelled turn ends without a reason.
      if (openTurn !== turn || (typeof reason !== "string" && event.data?.reason !== null)) throw new Error("invalid DSH turn end in history");
      finishedTurns.set(turn, reason ?? "cancelled");
      openTurn = null;
    }
    if (event.type === "user/message") {
      const id = event.data?.id;
      // The installed runtime adds its own context snapshot as a user-role
      // history item. A claimed source kind alone is insufficient provenance.
      const source = event.data?.source;
      const content = event.data?.content;
      const oneText = Array.isArray(content) && content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string";
      let runtimeContext = false;
      if (source?.kind === "runtime-context" && typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) && oneText) {
        const keys = Object.keys(source).sort().join(",");
        if (keys === "kind") runtimeContext = content[0].text === "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";
        else if (keys === "form,kind,sections" && source.form === "snapshot" && Array.isArray(source.sections) && source.sections.length > 0 &&
          source.sections.every((section: { name?: unknown; text?: unknown }) => typeof section?.name === "string" && section.name.length > 0 && typeof section?.text === "string" && section.text.length > 0))
          runtimeContext = content[0].text === `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${source.sections.map((section: { text: string }) => section.text).join("\n\n")}`;
      }
      // Workspace instructions (AGENTS.md) and the repeated-tool-call notice are DSH-owned user-role items, not prompts.
      // Each must match the exact form DSH renders; anything else still needs a core turn.
      if (typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) && Array.isArray(content) && content.length > 0 &&
        content.every((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string")) {
        const texts = content.map((part: { text: string }) => part.text);
        if (source?.kind === "agent-instructions" && source.form === "instructions" && Array.isArray(source.changes))
          runtimeContext = texts.every((text: string) => /^<system-reminder>\n[\s\S]*\n<\/system-reminder>\s*$/u.test(text) &&
            text.indexOf("</system-reminder>") === text.lastIndexOf("</system-reminder>"));
        else if (source?.kind === "repeat-tool-reminder" && source.form === "notice" && oneText)
          runtimeContext = texts[0] === GENTLE_REMINDER || DETAILED_REMINDER.test(texts[0]);
      }
      if (!runtimeContext && (typeof id !== "string" || !id.startsWith("core-") || !startedTurns.has(id.slice(5))))
        throw new Error("DSH history contains a user message without a core turn");
      if (!runtimeContext) {
        if (seenPrompts.has(id)) throw new Error("DSH history repeats a core prompt");
        if (openTurn === null || boundDshTurns.has(openTurn)) throw new Error("DSH core prompt has no distinct active turn");
        seenPrompts.add(id);
        promptTurns.set(id, openTurn);
        boundDshTurns.add(openTurn);
      }
    }
    if (event.type !== "agent/inbox/spliced") continue;
    const splice = event.data;
    const target: unknown = splice?.target;
    if (target !== "next-turn" && target !== "next-step" || !Number.isSafeInteger(splice.start) || !Number.isSafeInteger(splice.removedCount ?? 0) ||
      !Array.isArray(splice.inserted)) throw new Error("invalid DSH inbox history");
    const list = pending[target];
    if (splice.start < 0 || splice.start > list.length || (splice.removedCount ?? 0) < 0 || splice.start + (splice.removedCount ?? 0) > list.length)
      throw new Error("invalid DSH inbox splice");
    list.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted.map((message: { id?: unknown }) => {
      if (typeof message?.id !== "string") throw new Error("invalid DSH queued message");
      return message.id;
    }));
  }
  for (const turn of completedTurns) {
    const dshTurn = promptTurns.get(`core-${turn}`);
    if (dshTurn === undefined) throw new Error("completed core turn is missing from DSH history");
    if (finishedTurns.get(dshTurn) !== "completed") throw new Error("completed core turn lacks a matching completed DSH turn");
  }
  if (pending["next-turn"].length || pending["next-step"].length) throw new Error("DSH has queued work that cannot be automatically resumed safely");
}

// The repeated-tool-call notices DSH renders (dsh-repeat-tool-reminder): the first threshold, then the detailed form.
const GENTLE_REMINDER = "You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.";
const DETAILED_REMINDER = /^Repeated tool call detected:\n- tool: [A-Za-z0-9_.:-]{1,128}\n- consecutive_calls: [0-9]{1,6}\n- arguments: [^\n]*\nThe repeated calls are not making progress\. Do not call this tool with these exact arguments again\. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered\.$/u;

// Deliberately replaces the approval and permission rows whole: ash owns this DSH home and the door needs ask
// under every preset, so a narrower user default (if one were ever configured here) is not carried over.
const APPROVAL_PATCH = `- id: approval
  config:
    policy: ask
- id: permission
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: ask }
`;

/** Core-only DSH host. It never installs the retired tool surface or starts an unbound model session. */
export class DshHost {
  ctx: any;
  private shutdownHandle: any;
  private requireFromInstall: NodeRequire;
  private main: MainSession | null = null;
  private mind: MindSession | null = null;
  private managedPromptCleanup: (() => void) | null = null;
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
    if (!existsSync(packageFile)) writeFileSync(packageFile, JSON.stringify({ name: "dsh-profile-ash-v2", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }), { mode: 0o600 });
    for (const file of ["cordis.yml", "cordis.patch.yml"]) {
      const path = join(profile, file);
      if (!existsSync(path)) writeFileSync(path, "[]\n", { mode: 0o600 });
    }
    // The door hands every tool call through DSH approval, so the policy is always "ask", even where the
    // deployment drops the file sandbox (Android has no sandbox runner and sets danger-full-access).
    const approvalPatch = join(home, "ash-approval.patch.yml");
    writeFileSync(approvalPatch, APPROVAL_PATCH, { mode: 0o600 });
    process.env.DSH_HOME = home;
    // A later root in this process must not inherit an earlier test/deployment's
    // provider endpoint; explicit trusted host config wins over stale ambient env.
    for (const [key, value] of Object.entries(this.options.env ?? {})) process.env[key] = value;
    const { loadLayeredEnv } = await this.imp("@deepseek-ai/dsh-app-boot");
    const { runProfile } = await import(pathToFileURL(join(root, "lib", "profile-boot.js")).href);
    const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv("dsh"), profile: "ash-v2", patchFiles: [approvalPatch], args: [] });
    this.ctx = ctx;
    this.shutdownHandle = shutdown;
    if (this.options.skillsRoot) {
      const plugin = await import(pathToFileURL(join(this.options.skillsRoot, "index.mjs")).href);
      await ctx.plugin(plugin);
    }
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
  /** Read prices from the model catalog shipped with this DSH install, never from a guessed rate table. */
  async modelRates(provider: string, model: string): Promise<WorkerRates | null> {
    const file = join(this.options.root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js");
    if (!existsSync(file)) return null;
    try {
      const catalog = await import(pathToFileURL(file).href) as { getBuiltinModel?: (provider: string, model: string) => { cost?: WorkerRates } | undefined };
      return catalog.getBuiltinModel?.(provider, model)?.cost ?? null;
    } catch { return null; }
  }
  agentOptions(): { provider: string; model: string } | undefined {
    const selection = this.ctx?.get("agentDefaultModel")?.currentSelection?.();
    return selection ? { provider: selection.provider, model: selection.model } : undefined;
  }

  async startMain(options: Omit<DoorOptions, "tools" | "scopeChainOf"> & { workspace: string; adapter?: DoorTurnAdapter; resume?: SessionResume }): Promise<MainSession> {
    if (!this.ctx) throw new Error("DSH host not booted");
    if (!options.adapter) throw new Error("turn adapter unavailable; no DSH session was created");
    if (this.main) throw new Error("main session already started");
    const scope = await this.imp("@deepseek-ai/dsh-scope");
    if (typeof scope.scopeChainOf !== "function") throw new Error("DSH scope provenance unavailable");
    let door: DshDoor | null = null;
    try {
      const sessionId = options.resume ? loadOrCreateSessionId(options.resume.file, options.resume.startedTurns) : `session-${randomUUID()}`;
      const agentOptions = this.agentOptions();
      door = createDshDoor({ tools: this.ctx.tools, members: options.members, router: options.router,
        workspace: options.workspace, managedRoot: options.managedRoot, protectedRoots: options.protectedRoots,
        scopeChainOf: scope.scopeChainOf, nativeMode: options.nativeMode ?? "disabled", sessionId });
      const preparedDoor = door;
      const persistence = this.ctx.get("sessionPersistence");
      if (options.resume && !persistence) throw new Error("DSH history persistence unavailable");
      const snapshot = options.resume ? await persistence.stat(sessionId) : undefined;
      if (options.resume && !snapshot && options.resume.startedTurns.size) throw new Error("DSH history missing for existing core turns");
      if (snapshot) {
        if (snapshot.header.id !== sessionId || snapshot.header.cwd !== options.workspace || snapshot.header.parentSession || snapshot.header.isSeeded)
          throw new Error("DSH session header does not match the protected root session");
        const reader = await persistence.open(sessionId, "read");
        try { assertResumableHistory((await reader.read()).events, options.resume!.startedTurns, options.resume!.completedTurns); }
        finally { await reader.close(); }
      }
      const handle = await this.ctx.get("agents")[snapshot ? "resume" : "create"]({
        ...(snapshot ? { resumeSessionId: sessionId } : { sessionId, meta: { cwd: options.workspace } }), agentOptions,
        setup: (agentCtx: unknown, rawAgent: DshRootAgent) => {
          // DSH runs setup while the agent is unpublished; no model call can precede binding.
          preparedDoor.bind(rawAgent);
          options.adapter!.attach(rawAgent, preparedDoor, sessionId);
          this.managedPromptCleanup = options.adapter!.attachManagedPrompt?.(agentCtx) ?? null;
          // A session recorded under "never" (an earlier Android build) would refuse every door tool.
          const approval = this.ctx.get("approval");
          const session = (rawAgent as { session?: { append(type: string, data: object): void } }).session;
          if (approval?.effectivePolicy?.(session) !== "ask") session?.append("approval/policy", { policy: "ask" });
          return { commit() {
            preparedDoor.assertReady();
            if (approval?.effectivePolicy?.(session) !== "ask") throw new Error("DSH approval policy is not ask; door tools cannot run");
          } };
        } });
      const agent = handle.agent as DshRootAgent;
      this.main = { agent, door, sessionId };
      return this.main;
    } catch (error) {
      this.managedPromptCleanup?.();
      this.managedPromptCleanup = null;
      door?.close();
      // A published but unbound session must never outlive a failed attachment.
      try { await this.shutdownHandle?.shutdown?.(1); } catch { /* retain the original failure */ }
      this.ctx = null;
      throw error;
    }
  }

  async startMind(options: Omit<DoorOptions, "tools" | "scopeChainOf" | "sessionId"> & {
    adapter: { attach(agent: DshRootAgent, door: DshDoor, sessionId: string): void };
  }): Promise<MindSession> {
    if (!this.ctx || !this.main || this.mind) throw new Error("main session must start before the mind session");
    const scope = await this.imp("@deepseek-ai/dsh-scope");
    const sessionId = `session-${randomUUID()}`;
    const door = createDshDoor({ ...options, tools: this.ctx.tools, scopeChainOf: scope.scopeChainOf,
      nativeMode: "disabled" });
    try {
      const handle = await this.ctx.get("agents").create({ sessionId, meta: { cwd: options.workspace }, agentOptions: this.agentOptions(),
        setup: (_context: unknown, agent: DshRootAgent) => {
          door.bind(agent);
          options.adapter.attach(agent, door, sessionId);
          return { commit() { door.assertReady(); } };
        } });
      this.mind = { agent: handle.agent as DshRootAgent, door, sessionId };
      return this.mind;
    } catch (error) { door.close(); throw error; }
  }

  async close(): Promise<void> {
    this.managedPromptCleanup?.();
    this.managedPromptCleanup = null;
    this.main?.door.close();
    this.mind?.door.close();
    this.main = null;
    this.mind = null;
    await this.shutdownHandle?.shutdown?.(0);
    this.ctx = null;
    this.listeners.clear();
  }
}
