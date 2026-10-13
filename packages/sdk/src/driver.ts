/**
 * The agent driver contract (SPEC-08): what the hub's agents module asks of one agent runtime, and what the runtime
 * reports back. One driver serves every agent declared on its runtime kind (`dsh`, `codex`, `claude`...). A driver
 * in the hub's process is called directly; a driver on a computer is the same interface carried over the link
 * protocol's `agent` channel, so the hub's code does not tell them apart.
 *
 * The hub decides *when* (the inbox, quota, which messages go together); the driver decides *how* for its runtime
 * (start the process, put the message in the agent's own words, keep the session). Session handles are opaque: the
 * hub stores them and gives them back, never reads them.
 *
 * Errors are `WordError`: `conflict` when the agent is busy and the operation needs it idle, `unavailable` when the
 * runtime cannot do it, `failed` when it tried and could not, `not_found` for an agent or lane the driver does not hold.
 */
import type { HumanOrigin } from "./message";

// ---------------------------------------------------------------------------------------------------------------------
// the extension methods of the DSH driver's ACP superset (the `dsh-ash-control` plugin answers them)
// ---------------------------------------------------------------------------------------------------------------------

export const ASH_METHODS = Object.freeze({
  steer: "_ash/steer",
  inject: "_ash/inject",
  compact: "_ash/compact",
  plugins: "_ash/plugins",
  credentialsHas: "_ash/credentials.has",
  credentialsSet: "_ash/credentials.set",
  usage: "_ash/usage",
} as const);
export type AshMethod = (typeof ASH_METHODS)[keyof typeof ASH_METHODS];

/** JSON-RPC code the plugin answers `_ash/compact` with when the session is not idle (the driver turns it into `conflict`). */
export const ASH_BUSY_CODE = -32002;

// ---------------------------------------------------------------------------------------------------------------------
// prompt modules (SPEC-08 §2.3)
// ---------------------------------------------------------------------------------------------------------------------

export const STATIC_MODULE_IDS = ["identity", "rules"] as const;
export const DYNAMIC_MODULE_IDS = ["user", "skills", "environment", "lane"] as const;
export const MODULE_IDS = [...STATIC_MODULE_IDS, ...DYNAMIC_MODULE_IDS] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** `version` is the hash of the content. `content` is final text, headed with the module's name and version. */
export interface PromptModule { id: ModuleId; version: string; content: string }

// ---------------------------------------------------------------------------------------------------------------------
// what the hub gives the driver
// ---------------------------------------------------------------------------------------------------------------------

/** A file the owner or another member attached; `ref` is a ledger blob (`ledger.blob.get(ref)`). */
export interface DriverAttachment { name: string; mime_type: string; ref: string }

/**
 * One message of a batch. The driver builds the envelope in front of it (time, source, lane, id) from these fields;
 * `text` is the content only.
 */
export interface DriverMessage {
  /** The ledger id of the message; the agent quotes it to answer (`service:agents/answer`). */
  id: string;
  /** Sender member id. */
  from: string;
  /** The word it came as: say, tell, ask, wake... */
  word: string;
  text: string;
  /** The lane it was filed on: the session key. */
  lane: string;
  thread?: string;
  attachments?: DriverAttachment[];
  /** Unix ms. */
  at: number;
  /** Which channel the owner spoke from; only on messages from the owner. */
  origin?: HumanOrigin;
}

/** What an agent's declaration says about its runtime (the long-lived settings): the kind, the model it uses now, and a settings entry per model. */
export interface RuntimeSettings {
  kind: string;
  /** The model in use, as `provider/model`. */
  model?: string;
  /** The thinking effort of the model in use (a model's own entry in `models` wins). */
  effort?: string;
  /** Settings by model (`provider/model`): applied whenever that model is the one in use, the fallback model included. */
  models?: Record<string, ModelSettings>;
}
export interface ModelSettings { effort?: string }

/** What `start` is given (SPEC-08 §1.4 `agent.start`). */
export interface AgentStartSpec {
  runtime: RuntimeSettings;
  /** Where the agent lives (SPEC-08 §2.2). `cwd` is a path on that body. */
  native?: { on: string; cwd?: string; env?: Record<string, string> };
  /**
   * The tool surface of this agent: the address on `<hub url>/mcp` and one token per lane. A lane's session sends only its
   * own token, and the hub takes the lane (so the turn) from the token: nothing the agent says can change it.
   * `allowed` is the tool list (already narrowed by delegation).
   */
  tools: { mcp_url: string; tokens: Record<string, string>; allowed: string[] };
  /** The static modules (identity, rules) the session opens with. */
  modules: { static: PromptModule[] };
  /** The session keys (lanes) to hold open. */
  lanes: string[];
  /** Resumable handles by session key, as the hub last stored them. A lane with no handle starts a new session. */
  sessions: Record<string, string>;
}

export type AgentState = "starting" | "running" | "exited" | "failed";
export interface AgentStatus { state: AgentState; detail?: string }

export interface RuntimeAbilities {
  resume: boolean;
  steer: boolean;
  /** Content can be put into a running session. */
  inject_live: boolean;
  images: boolean;
  compact: boolean | "unknown";
  /** Which settings `configure` takes (`"*"`: any the runtime reports). */
  configure: string[];
  plugins: boolean;
  mcp: boolean;
  system_prompt: "replace" | "append" | "file" | "inject";
  /** Can hold a key for itself (`credentials.has/set`) and report usage (`usage`). */
  credentials: boolean;
  usage: boolean;
  /** A change of the declaration's runtime settings (model, effort, models) is taken by `configure {runtime}` between turns, without restarting the agent. */
  runtime_live?: boolean;
}
export interface RuntimeInfo {
  kind: string;
  version?: string;
  models: { id: string; efforts?: string[] }[];
  abilities: RuntimeAbilities;
}

// ---------------------------------------------------------------------------------------------------------------------
// the catalog: which providers and models a runtime can use, and what each needs (service:agents/runtime.catalog)
// ---------------------------------------------------------------------------------------------------------------------

export interface CatalogModel {
  /** `provider/model`: what `runtime.model` and the keys of `runtime.models` are written as. */
  id: string;
  name: string;
  context_window?: number;
  max_output?: number;
  images: boolean;
  reasoning: boolean;
  /** The thinking efforts the model takes, weakest first; empty when it does not think. Leaving `effort` out means the model's own default. */
  efforts: string[];
}
/** What a provider needs before its models can be used: a key in the vault (the hub knows whether it is there), or a login the runtime holds. */
export type CatalogAuth =
  | { kind: "key"; ref: string }
  | { kind: "login"; method: string; state: "ready" | "none" | "pending" | "unknown"; how: string }
  | { kind: "none" };
export interface CatalogProvider {
  id: string;
  name: string;
  /** Needs the proxy (v2rayA) or a VPN on the phone to be reached. */
  needs_proxy: boolean;
  auth: CatalogAuth;
  models: CatalogModel[];
}
export interface CatalogOptions {
  /** Every model of every provider, for checking a declaration. */
  full?: boolean;
}
/** What a driver knows of the runtime now (its live choices), and what it can use. */
export interface RuntimeCatalog {
  providers: CatalogProvider[];
  /** Where the lists come from and how new they are: the tables the runtime shipped with, or newer ones it fetched from upstream. */
  source?: { checked_at?: number | null; upstream_at?: number | null; refreshing?: boolean };
  /** What is in force now, which may differ from the declaration (a temporary `configure`, a fallback). */
  effective?: Record<string, unknown>;
}

export type TurnOutcome = "completed" | "cancelled" | "error" | "interrupted";
export interface DriverUsage { records: unknown[]; balance?: unknown }

// ---------------------------------------------------------------------------------------------------------------------
// what the driver reports (SPEC-08 §2.4)
// ---------------------------------------------------------------------------------------------------------------------

/** `agent` is the member id (`agent:main`); `key` is the session key = the lane. */
export type AgentEvent =
  | { event: "turn.started"; agent: string; key: string; turn: string; ids?: string[] }
  | { event: "turn.ended"; agent: string; key: string; turn: string; outcome: TurnOutcome; error?: string; usage?: { input_tokens: number; output_tokens: number } }
  /** One finished piece of speech (a whole message of the agent, not a chunk). */
  | { event: "output"; agent: string; key: string; turn: string; text: string }
  | { event: "thought"; agent: string; key: string; turn: string; text: string }
  | { event: "tool"; agent: string; key: string; turn: string; phase: "start" | "end"; name: string; summary?: string; ok?: boolean }
  | { event: "handle.updated"; agent: string; key: string; handle: string }
  | { event: "error"; agent: string; message: string }
  /** A line for the owner from the runtime itself (a model change, a login done): the hub passes it on as a heads-up that never rings. */
  | { event: "notice"; agent: string; key?: string; text: string }
  /** The process is gone (not asked to stop): the hub starts the agent again and resumes its sessions. */
  | { event: "ended"; agent: string; reason?: string };
export type AgentEventName = AgentEvent["event"];

// ---------------------------------------------------------------------------------------------------------------------
// the driver
// ---------------------------------------------------------------------------------------------------------------------

export interface AgentDriver {
  readonly info: RuntimeInfo;

  /** Start the agent's process and hold a session for each lane (resumed when there is a handle). Reports `handle.updated` for each. */
  start(agent: string, spec: AgentStartSpec): Promise<void>;
  /** Cancel what is running and end the process. A stop that was asked for is not reported as `ended`. */
  stop(agent: string, reason: string): Promise<void>;
  status(agent: string): AgentStatus;
  /** Stop the process and start it again, resuming every session (one `key` or all: the process is shared). */
  restart(agent: string, key?: string): Promise<void>;

  readonly session: {
    /** The handle the session is at now, or null. */
    get(agent: string, key: string): string | null;
    /** Point the lane at a session handle; the session is resumed. */
    set(agent: string, key: string, handle: string): Promise<void>;
    /** Open a new session on the lane (agent idle). */
    "new"(agent: string, key: string): Promise<{ handle: string }>;
    /** Write the static modules as the start of the agent's sessions and open a new session (agent idle). */
    reload(agent: string, key: string, modules: { static: PromptModule[] }): Promise<{ handle: string }>;
    /** Compact the lane's context. A running lane is `conflict`. */
    compact(agent: string, key: string): Promise<{ compacted: boolean; detail?: string }>;
  };

  /** Open a turn with this batch on an idle lane. Resolves once the turn has started. A running lane is `conflict`. */
  send(agent: string, key: string, batch: DriverMessage[]): Promise<void>;
  /** Queue messages for the next turn; on an idle lane it opens a turn like `send`. */
  followup(agent: string, key: string, batch: DriverMessage[]): Promise<void>;
  /** Say something into the running turn. False: nothing is running, the words were not taken. */
  steer(agent: string, key: string, text: string): Promise<boolean>;
  /** Put prompt modules (or plain text) into the session without opening a turn. */
  inject(agent: string, key: string, content: { modules?: PromptModule[]; text?: string }): Promise<void>;
  /** Stop the running turn. */
  interrupt(agent: string, key: string): Promise<void>;

  /** The providers and models this runtime can use, with what each needs. Absent: the hub builds a plain list from `info.models`. `saved` is the declaration's runtime settings. */
  catalog?(agent: string, saved: RuntimeSettings, options?: CatalogOptions): Promise<RuntimeCatalog>;

  /** Set the runtime's own configuration, or read it back with no `config`. The runtime keeps the truth. */
  configure(agent: string, key: string | undefined, config?: Record<string, unknown>): Promise<Record<string, unknown>>;
  plugins(agent: string, op: "list" | "enable" | "disable", name?: string): Promise<Record<string, unknown>>;

  /** Whether the runtime holds this key already (never its value). Only when `info.abilities.credentials`. */
  credentialsHas?(agent: string, ref: string): Promise<boolean>;
  credentialsSet?(agent: string, ref: string, value: string): Promise<void>;
  /** Records the runtime kept after `since` (Unix ms), and its balance if it has one. Only when `info.abilities.usage`. */
  usage?(agent: string, since: number): Promise<DriverUsage>;
}

/** The hub calls this once per runtime kind and gives it the place to report events. */
export type AgentDriverFactory = (report: (event: AgentEvent) => void) => AgentDriver;
