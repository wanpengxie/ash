import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SendRequestV2 } from "../../sdk/src/api";
import type { WorldMembers } from "../../core/src/world/member";
import type { WorldRouter, TrustedRouteContext } from "../../core/src/world/router";

type ToolCall = { name: string; arguments: unknown; agent?: object; callId: string; signal: AbortSignal };
type ToolDefinition = { name: string; description: string; parameters: object;
  output: { schema: object; render(args: unknown, value: { text: string }): { type: "text"; text: string }[] };
  execute(args: unknown, exec: ToolCall): Promise<{ text: string }> };
type ToolRuntime = { register(definition: ToolDefinition): () => void; restrict(filter: { allow: string[] }): () => void;
  guard(check: (exec: ToolCall) => string | undefined): () => void; get(name: string, scope?: object): ToolDefinition | undefined;
  schemas(scope?: object): { name: string }[] };
export interface DoorAgent { ctx: { tools: ToolRuntime } }
export interface DoorOptions {
  tools: ToolRuntime;
  members: WorldMembers;
  router: WorldRouter;
  /** The ordinary workspace; native file tools may not write outside it. */
  workspace: string;
  /** The directory containing the self-owned files. It may equal workspace. */
  managedRoot: string;
  /** Core ledger, inbox, credentials, and configuration roots, even if nested in workspace. */
  protectedRoots: readonly string[];
  /** Production first stage exposes only the five owned tools. Audited native mode remains test-only pending full routing. */
  nativeMode?: "disabled" | "audited";
  /** The installed runtime's scope chain; no guessed agent-id inheritance. */
  scopeChainOf(agent: object): readonly object[];
}

const NATIVE = ["read", "read_image", "glob", "grep", "web_search", "web_fetch", "write", "edit"] as const;
const REQUIRED = ["read", "write", "edit"] as const;
const OWN = ["ash_describe", "ash_send", "ash_say", "ash_react", "ash_show"] as const;
const MANAGED_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "PROACTIVE.md"] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const errorText = (error: unknown): string => error instanceof Error ? error.message : "tool failed";
const inside = (root: string, target: string): boolean => { const rel = relative(root, target); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
function freezeOwned<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Resolve an existing target or the nearest existing parent of a new one; reject dangling links. */
function targetPath(raw: string, workspace: string): string | null {
  const absolute = resolve(workspace, raw);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parts: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    try { if (lstatSync(cursor).isSymbolicLink()) return null; } catch { /* absent component */ }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    parts.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...parts);
}

/** A deny policy, not a claim of race-free filesystem isolation. */
export class NativeFilePolicy {
  readonly workspace: string;
  readonly managedRoot: string;
  readonly protectedRoots: readonly string[];
  constructor(workspace: string, managedRoot: string, protectedRoots: readonly string[]) {
    this.workspace = realpathSync(workspace);
    this.managedRoot = realpathSync(managedRoot);
    if (!Array.isArray(protectedRoots) || !protectedRoots.length) throw new TypeError("protected roots must be explicit");
    this.protectedRoots = protectedRoots.map((root) => realpathSync(root));
  }
  denial(args: unknown): string | undefined {
    const raw = object(args) ? args.file_path : undefined;
    if (typeof raw !== "string" || !raw.trim()) return "File path is required.";
    let target: string | null;
    try { target = targetPath(raw, this.workspace); } catch { return "File path could not be safely resolved."; }
    if (!target || !inside(this.workspace, target)) return "Native writes require an ordinary workspace path.";
    const parent = dirname(target);
    const name = basename(target);
    const staged = MANAGED_FILES.some((file) => name.startsWith(`.${file}.self-`) && name.endsWith(".tmp")) &&
      (parent === this.managedRoot || inside(join(this.managedRoot, "memory"), parent));
    const managed = MANAGED_FILES.some((file) => target === join(this.managedRoot, file)) ||
      inside(join(this.managedRoot, "memory"), target) || inside(join(this.managedRoot, ".ash"), target) || staged;
    if (managed) return "Managed file: use ash_send to service:self (read, write, append or apply_plan).";
    if (this.protectedRoots.some((root) => inside(root, target))) return "Core state is not an ordinary workspace target.";
    // Deny all multiply-linked targets, including aliases of dated logs or snapshots.
    try { if (existsSync(target) && statSync(target).nlink > 1) return "Linked file alias: use an ordinary unlinked workspace file."; }
    catch { return "File identity could not be safely checked."; }
    return undefined;
  }
}

const OUTPUT = Object.freeze({
  schema: Object.freeze({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }),
  render(_args: unknown, value: { text: string }) { return [{ type: "text" as const, text: value.text }]; },
});
const shape = (properties: object, required: string[] = []) => Object.freeze({ type: "object", properties, required, additionalProperties: false });

interface Binding { agent: DoorAgent; definitions: Map<string, ToolDefinition>; natives: Map<string, ToolDefinition>; active: { turn: string; signal: AbortSignal; controller: AbortController } | null;
  disposers: (() => void)[] }

/** Bind only an explicitly registered root; descendants receive no inherited authority. */
export class DshDoor {
  private readonly options: DoorOptions;
  private readonly files: NativeFilePolicy;
  private binding: Binding | null = null;
  private readonly guardDispose: () => void;

  constructor(options: DoorOptions) {
    this.options = options;
    this.files = new NativeFilePolicy(options.workspace, options.managedRoot, options.protectedRoots);
    this.guardDispose = options.tools.guard((exec) => this.guard(exec));
  }

  bind(agent: DoorAgent): void {
    if (this.binding) throw new Error("door is already bound to a root agent");
    const natives = new Map<string, ToolDefinition>();
    for (const name of this.options.nativeMode === "audited" ? NATIVE : []) {
      const definition = this.options.tools.get(name);
      if (definition) natives.set(name, definition);
    }
    if (this.options.nativeMode === "audited") for (const name of REQUIRED) if (!natives.has(name)) throw new Error(`required native tool unavailable: ${name}`);
    const binding: Binding = { agent, natives, definitions: new Map(), active: null, disposers: [] };
    try {
      for (const definition of this.definitions()) {
        // Definition identity and executable closure must not be mutable in place.
        freezeOwned(definition);
        binding.disposers.push(agent.ctx.tools.register(definition));
        binding.definitions.set(definition.name, definition);
      }
      binding.disposers.push(agent.ctx.tools.restrict({ allow: [...natives.keys()] }));
      this.binding = binding;
      this.assertReady();
    } catch (error) {
      this.binding = null;
      for (const dispose of binding.disposers.reverse()) dispose();
      throw error;
    }
  }

  /** Called by the turn adapter, never from model arguments. */
  beginTurn(turn: string, signal: AbortSignal): void {
    this.assertReady();
    if (!/^t_[A-Za-z0-9_-]+$/.test(turn) || signal.aborted || this.binding?.active) throw new Error("invalid or overlapping door turn");
    const controller = new AbortController();
    this.binding!.active = { turn, controller, signal: AbortSignal.any([signal, controller.signal]) };
  }
  endTurn(turn: string): void {
    if (this.binding?.active?.turn === turn) { this.binding.active.controller.abort(); this.binding.active = null; }
  }

  assertReady(): void {
    const bound = this.binding;
    if (!bound) throw new Error("door has no registered root agent");
    const expected = new Set([...bound.definitions.keys(), ...bound.natives.keys()]);
    for (const [name, definition] of [...bound.definitions, ...bound.natives]) {
      if (this.options.tools.get(name, bound.agent) !== definition) throw new Error(`tool source changed: ${name}`);
    }
    const visible = this.options.tools.schemas(bound.agent).map((item) => item.name);
    if (visible.length !== expected.size || visible.some((name) => !expected.has(name)) || new Set(visible).size !== expected.size || visible.includes("run_code")) {
      throw new Error("tool surface changed or non-native presentation is active");
    }
  }

  private owns(agent: object | undefined): boolean {
    const root = this.binding?.agent;
    return Boolean(agent && root && (agent === root || this.options.scopeChainOf(agent).includes(root)));
  }
  private guard(exec: ToolCall): string | undefined {
    if (!this.owns(exec.agent)) return undefined; // other roots are governed by their own door
    const bound = this.binding!;
    if (exec.agent !== bound.agent) return "Derived agents cannot use this door or inherited tools.";
    if (!bound.active || bound.active.signal.aborted) return "No active authenticated turn.";
    const definition = bound.definitions.get(exec.name) ?? bound.natives.get(exec.name);
    if (!definition || this.options.tools.get(exec.name, exec.agent) !== definition) return "Tool is not in the audited source set.";
    if (exec.name === "write" || exec.name === "edit") return this.files.denial(exec.arguments);
    return undefined;
  }

  private definitions(): ToolDefinition[] {
    const descriptor = (name: string, description: string, parameters: object, action: (args: Record<string, unknown>, exec: ToolCall) => Promise<unknown>): ToolDefinition => ({
      name, description, parameters, output: OUTPUT,
      execute: async (args, exec) => {
        const binding = this.binding;
        if (!binding || exec.agent !== binding.agent || this.options.tools.get(name, exec.agent) !== binding.definitions.get(name)) throw new Error("door tool source changed");
        const active = binding.active;
        if (!active || active.signal.aborted || exec.signal.aborted) throw new Error("turn cancelled");
        try { return { text: JSON.stringify(await action(args as Record<string, unknown>, exec)) }; }
        catch (error) { throw new Error(errorText(error)); }
      },
    });
    const send = async (request: SendRequestV2, exec: ToolCall) => {
      const active = this.binding?.active;
      if (!active) throw new Error("no active turn");
      const caller: TrustedRouteContext = { transport: "agent", transportPrincipal: "agent:main", member: "agent:main",
        local: true, remote: false, ownerProxy: false, turn: active.turn };
      const signal = AbortSignal.any([active.signal, exec.signal]);
      return this.options.router.send(caller, { ...request, wait: true, client_id: `dsh:${active.turn}:${exec.callId}` }, signal);
    };
    return [
      descriptor("ash_describe", "Discover members and their available words before sending.", shape({ member: { type: "string" } }), async (args) =>
        typeof args.member === "string" ? this.options.members.describe("agent", args.member) : this.options.members.describe("agent")),
      descriptor("ash_send", "Send a validated request to a member and wait for its result.", shape({ to: { type: "string" }, word: { type: "string" }, body: { type: "object" } }, ["to", "word", "body"]),
        (args, exec) => send({ to: args.to as string, kind: "request", word: args.word as string, body: args.body as Record<string, unknown> }, exec)),
      descriptor("ash_say", "Say one message to the owner; may be called repeatedly.", shape({ text: { type: "string" }, kind: { type: "string", enum: ["reply", "offer", "heads_up", "due"] } }, ["text"]),
        (args, exec) => send({ to: "person:owner", kind: "request", word: "say", body: { text: args.text, kind: args.kind ?? "reply" } }, exec)),
      descriptor("ash_react", "React to a specific owner message.", shape({ message_id: { type: "string" }, emoji: { type: "string" } }, ["message_id", "emoji"]),
        (args, exec) => send({ to: "person:owner", kind: "request", word: "react", body: { message_id: args.message_id, emoji: args.emoji } }, exec)),
      descriptor("ash_show", "Show one owner card, including options or permission cards.", shape({ card: { type: "object" } }, ["card"]),
        (args, exec) => send({ to: "person:owner", kind: "request", word: "show", body: { card: args.card } }, exec)),
    ];
  }

  close(): void {
    const bound = this.binding;
    bound?.active?.controller.abort();
    this.binding = null;
    if (bound) for (const dispose of bound.disposers.reverse()) dispose();
    this.guardDispose();
  }
}

export function createDshDoor(options: DoorOptions): DshDoor { return new DshDoor(options); }
