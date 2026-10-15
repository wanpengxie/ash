/**
 * The message format `ash-api/3`, the response body, the one set of error codes, and the types every module shares
 * when a word is delivered: who is calling (`Caller`), what comes back (`Reply`), what a handler is given (`HandleContext`).
 */

import type { ContentPart } from "./link";
// ---------------------------------------------------------------------------------------------------------------------
// error codes (SPEC-02 §7)
// ---------------------------------------------------------------------------------------------------------------------

/** One set of codes for the router, the tool surface, the app bridge, the human interface and the link protocol. */
export const ERROR_CODES = [
  "bad_request", "unauthorized", "forbidden", "not_found", "denied", "cancelled", "timeout",
  "offline", "result_unknown", "conflict", "too_large", "unavailable", "failed", "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);

/** What each code means. */
export const ERROR_MEANINGS: Readonly<Record<ErrorCode, string>> = Object.freeze({
  bad_request: "The input is not in the right form.",
  unauthorized: "The caller's identity was not proven.",
  forbidden: "The caller is known but may not do this.",
  not_found: "There is no such member, word or object.",
  denied: "The gate or the owner refused.",
  cancelled: "The request was cancelled.",
  timeout: "No result by the deadline; it was certainly not done.",
  offline: "The target is not connected; it was certainly not done.",
  result_unknown: "The request went out but it is not known whether it was done.",
  conflict: "The state does not allow it (same client_id with other content, already answered, stale reference).",
  too_large: "Too large.",
  unavailable: "The service cannot be used for now (vault locked, bridge busy, extension not connected).",
  failed: "The target ran and failed.",
  internal: "The hub itself failed.",
});

/** The next step for the caller, one sentence; `recovery_hint` is required on the tool surface. */
export const DEFAULT_RECOVERY_HINTS: Readonly<Record<ErrorCode, string>> = Object.freeze({
  bad_request: "Check the input against the word's input_schema (capability_describe) and send it again.",
  unauthorized: "Do not retry; the identity of this caller could not be established.",
  forbidden: "You may not do this; ask the owner, or use another way that is within your permissions.",
  not_found: "Check the member id and the word with capability_list or capability_describe.",
  denied: "The owner or the approval gate said no; do not repeat the request unchanged, tell the owner what is blocked.",
  cancelled: "It was stopped before it finished; check the current state before deciding to do it again.",
  timeout: "It was not done. Try again, or ask for a smaller piece.",
  offline: "The target is not connected and nothing was done. Check who is online with capability_list and try again later or use another member.",
  result_unknown: "It may or may not have happened. Read the current state first; do not blindly repeat it.",
  conflict: "The state has changed. Read it again and then decide.",
  too_large: "Ask for a smaller piece (offset, limit, a narrower query).",
  unavailable: "The service cannot be used right now; try again later or tell the owner what is missing.",
  failed: "The target tried and failed; read the message, fix the cause, or tell the owner.",
  internal: "This is a fault in Ash, not in your request; tell the owner and do not retry in a loop.",
});

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  detail?: unknown;
  recovery_hint?: string;
}

/** An error body whose `recovery_hint` falls back to the default for the code. */
export function errorBody(code: ErrorCode, message: string, extra: { detail?: unknown; recovery_hint?: string } = {}): ErrorBody {
  return { code, message, ...(extra.detail !== undefined ? { detail: extra.detail } : {}), recovery_hint: extra.recovery_hint ?? DEFAULT_RECOVERY_HINTS[code] };
}

// ---------------------------------------------------------------------------------------------------------------------
// message (SPEC-01 §3)
// ---------------------------------------------------------------------------------------------------------------------

export type MessageKind = "request" | "response" | "event";

/** Where a message from the owner came from. Only messages from `person:owner` have one. */
export interface HumanOrigin {
  channel: "app" | "web" | "im";
  /** `client:<sid>` */
  client: string;
  /** The hand the channel lives on (the phone app: that phone's `device:<id>`). */
  hand?: string;
  /** The platform of an `im` channel (the chat app's name). */
  provider?: string;
  /** For the owner to read, e.g. 「手机 · 对话」. */
  label: string;
}
export const HUMAN_CHANNELS = ["app", "web", "im"] as const;

export interface Message {
  seq: number;
  id: string;
  ts: number;
  from: string;
  to: string | null;
  kind: MessageKind;
  word: string;
  body: unknown;
  reply_to?: string;
  origin?: HumanOrigin;
  turn?: string;
  thread?: string;
}

/** What a sender gives the hub; the hub stamps `from`, `origin` and the rest. Extra keys are refused. */
export interface SendRequest {
  to: string | null;
  kind: MessageKind;
  word: string;
  body: unknown;
  reply_to?: string;
  wait?: boolean;
  client_id?: string;
}

/** What a module gives `router.send` (the caller is a separate argument). */
export interface Outgoing {
  to: string | null;
  kind: "request" | "event";
  word: string;
  body: unknown;
  reply_to?: string;
  thread?: string;
}

/**
 * What a member's `handle` returns for a request: the same two parts as a link `result` frame, so a result keeps
 * one shape from a hand through the router to the tool surface. `data` follows the word's output schema; `content`
 * is what a model or a person reads (text, images, resources). Events return nothing.
 */
export interface WordResult {
  data?: unknown;
  content?: ContentPart[];
}

/**
 * Thrown by a handler to refuse with a contract code; the router turns it into `Reply.error`. Anything else a
 * handler throws becomes `internal`.
 */
export class WordError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;
  readonly recovery_hint?: string;
  constructor(code: ErrorCode, message: string, extra: { detail?: unknown; recovery_hint?: string } = {}) {
    super(message);
    this.name = "WordError";
    this.code = code;
    this.detail = extra.detail;
    this.recovery_hint = extra.recovery_hint;
  }
}

/** What `router.send` returns and the body of a `response` message (SPEC-01 §3): one shape. */
export type Reply = { ok: true; result?: WordResult } | { ok: false; error: ErrorBody };

// ---------------------------------------------------------------------------------------------------------------------
// shared by the modules (HUB-MODULES §1.1, §1.4)
// ---------------------------------------------------------------------------------------------------------------------

export const CALLER_VIAS = ["human", "agent", "hand", "app", "service"] as const;

/** Who is calling. Filled in by the edge module the call came in through; nothing in the message body can change it. */
export interface Caller {
  /** person:owner, agent:<name>, device:<id>, app:<id>, service:<name> */
  member: string;
  via: (typeof CALLER_VIAS)[number];
  /** The owner came in through a channel on this machine. */
  local: boolean;
  /** `client:<sid>`: which channel of the owner. */
  client?: string;
  /** Which turn of an agent. */
  turn?: string;
  /** Where the owner's message came from, as the human edge knows it; the router stamps it on the message as is. */
  origin?: HumanOrigin;
  /**
   * An app's call made because the owner pressed a button of this card on his screen (service:cards/act): the owner is there,
   * so the gate may ask him about it, as for an agent's call. Without it an app is never asked about.
   */
  card?: string;
}


/** What a member's `handle` is given. */
export interface HandleContext {
  signal: AbortSignal;
  caller: Caller;
  /** The request body as held in memory, secret fields included. Never write it to the ledger. */
  raw: unknown;
}
