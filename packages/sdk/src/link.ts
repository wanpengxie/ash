/**
 * `ash-link/2`: the one connection protocol between the kernel and every hand (phone app, computer program, browser).
 * On a relay tunnel it runs inside TLS (packages/link/src/secure.ts, docs/LINK-E2E.md); on the local link in the clear.
 *
 * This file is the only definition of the protocol's frames. Each frame is written once, as a small schema builder
 * value; the TypeScript type, the JSON Schema (generated into `schema/link/`) and the runtime validator all come from
 * that value. The implementation (server, clients) lives in `packages/link`.
 */
import Ajv from "ajv/dist/2020.js";
import { ERROR_CODES } from "./message";
import { LINK_PROTOCOL } from "./versions";
import { CALLER_KINDS, EFFECTS, RISKS } from "./word";

export { LINK_PROTOCOL };

/** Close codes (SPEC-03 §7). 1000 is a normal close; the 4xxx codes tell the hand what to do next. */
export const CLOSE_CODES = {
  normal: 1000,
  /** Identity not proven (wrong token or signature). */
  unauthenticated: 4001,
  /** The hand has been revoked. Do not reconnect. */
  revoked: 4003,
  /** Protocol version not supported. Do not reconnect. */
  unsupported: 4008,
  /** A newer connection of the same hand took this one's place. Do not reconnect. */
  superseded: 4009,
  /** A frame was malformed. */
  badFrame: 4400,
  /** Kernel internal error. */
  internal: 4500,
} as const;
/** A hand that is closed with one of these codes does not reconnect. */
export const NO_RECONNECT_CODES: readonly number[] = [CLOSE_CODES.revoked, CLOSE_CODES.unsupported, CLOSE_CODES.superseded];

export const LIMITS = {
  /** One frame, as UTF-8 JSON text. */
  frameBytes: 4 * 1024 * 1024,
  /** One `stream` data chunk, before base64. */
  streamChunkBytes: 256 * 1024,
  /** Calls in flight on one hand; beyond this the hand answers `unavailable`. */
  inflightCalls: 16,
  heartbeatMs: 30_000,
  /** No frame at all for this long: the connection is dropped. */
  silenceMs: 90_000,
  /** The kernel waits this long for `assessed`, then uses the declared risk. */
  assessMs: 10_000,
} as const;

// --- schema builder: one value gives the type, the JSON Schema and the validator ---------------------------------------

type Json = Record<string, unknown>;
export interface Schema<T> { readonly json: Json; readonly _type?: T }
type Static<S> = S extends Schema<infer T> ? T : never;
type Fields = Record<string, Schema<any>>;
type Props<F extends Fields> = { [K in keyof F]: Static<F[K]> };
type Flat<T> = { [K in keyof T]: T[K] } & {};
const make = <T>(json: Json): Schema<T> => ({ json });

const string = (extra: Json = {}) => make<string>({ type: "string", ...extra });
const integer = (extra: Json = {}) => make<number>({ type: "integer", ...extra });
const boolean = () => make<boolean>({ type: "boolean" });
const anything = () => make<unknown>({});
const lit = <const V extends string | number | boolean>(value: V) => make<V>({ const: value });
const oneOfValues = <const V extends readonly string[]>(...values: V) => make<V[number]>({ type: "string", enum: values });
const list = <T>(item: Schema<T>, extra: Json = {}) => make<T[]>({ type: "array", items: item.json, ...extra });
const nullable = <T>(inner: Schema<T>) => make<T | null>({ anyOf: [inner.json, { type: "null" }] });
const union = <const S extends readonly Schema<any>[]>(...variants: S) => make<Static<S[number]>>({ oneOf: variants.map((v) => v.json) });
/** A closed object: unknown fields are rejected. */
function obj<R extends Fields, O extends Fields = {}>(required: R, optional?: O, extra: Json = {}): Schema<Flat<Props<R> & Partial<Props<O>>>> {
  const properties: Json = {};
  for (const [key, value] of Object.entries({ ...required, ...optional })) properties[key] = value.json;
  const json: Json = { type: "object", properties, required: Object.keys(required), additionalProperties: false, ...extra };
  if (Object.keys(required).length === 0) delete json.required;
  return make(json);
}
/** An object that may carry fields this protocol does not name (the payload is owned by another contract). */
function loose<R extends Fields, O extends Fields = {}>(required: R, optional?: O): Schema<Flat<Props<R> & Partial<Props<O>>> & Record<string, unknown>> {
  const closed = obj(required, optional).json;
  delete closed.additionalProperties;
  return make(closed);
}
const record = () => loose({});

// --- shared parts ------------------------------------------------------------------------------------------------------

const id = string({ minLength: 1, maxLength: 128 });
const channelName = oneOfValues("device", "human", "agent");
const dotted = "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$";
const base64Pattern = "^[A-Za-z0-9+/]*={0,2}$";
const base64 = string({ pattern: base64Pattern });
/** The longest base64 text of one stream chunk. */
const maxChunkBase64 = Math.ceil(LIMITS.streamChunkBytes / 3) * 4;
const risk = oneOfValues(...RISKS);
const errorCode = oneOfValues(...ERROR_CODES);
const errorBody = obj({ code: errorCode, message: string() }, { detail: anything(), recovery_hint: string() });

const contentPart = union(
  obj({ type: lit("text"), text: string() }),
  obj({ type: lit("image"), mime: string({ minLength: 1 }), b64: base64 }),
  obj({ type: lit("resource"), stream: id, mime: string({ minLength: 1 }), size: integer({ minimum: 0 }) }),
);

const capabilitySpec = obj(
  {
    name: string({ pattern: dotted, maxLength: 128 }),
    description: string(),
    input_schema: record(),
    effect: oneOfValues(...EFFECTS),
    risk,
  },
  {
    label: string(),
    result_schema: record(),
    per_call_risk: boolean(),
    foreground: boolean(),
    callers: list(oneOfValues(...CALLER_KINDS), { minItems: 1, uniqueItems: true }),
    timeout_ms: integer({ minimum: 1 }),
  },
);

const sendRequest = obj(
  { to: nullable(string({ minLength: 1 })), kind: oneOfValues("request", "response", "event"), word: string({ minLength: 1 }), body: record() },
  { reply_to: string({ minLength: 1 }), client_id: string({ minLength: 1 }), wait: boolean() },
);

const humanSurfaces = ["chat", "notification", "island", "widget", "status"] as const;

// --- frames --------------------------------------------------------------------------------------------------------------

const challenge = obj({ t: lit("challenge"), nonce: string({ minLength: 1 }), kernel: obj({ id: string({ minLength: 1 }), version: string(), protocol: string() }) });

// `protocol` is a plain string here: a hand that speaks another version must get 4008, not 4400.
const hello = obj(
  {
    t: lit("hello"),
    protocol: string(),
    hand: obj({ kind: oneOfValues("phone", "computer", "browser", "im"), name: string(), version: string(), platform: string() }, { public_key: string({ minLength: 1 }) }),
    channels: obj({}, {
      device: record(),
      human: obj({}, { label: string(), surfaces: list(oneOfValues(...humanSurfaces), { uniqueItems: true }) }),
      agent: loose({}, { runtimes: list(record()) }),
    }, { minProperties: 1 }),
  },
  { sig: string({ minLength: 1 }), features: list(string()) },
  { if: { required: ["hand"], properties: { hand: { required: ["public_key"] } } }, then: { required: ["sig"] } },
);

const channelAnswer = union(obj({ accepted: lit(true) }), obj({ accepted: lit(false), reason: string() }));
const welcome = obj({
  t: lit("welcome"),
  hand_id: string({ minLength: 1 }),
  session: string({ minLength: 1 }),
  heartbeat_ms: integer({ minimum: 1 }),
  channels: obj({}, {
    device: channelAnswer,
    human: union(obj({ client: string({ minLength: 1 }), local: boolean() }, { accepted: lit(true) }), obj({ accepted: lit(false), reason: string() })),
    agent: channelAnswer,
  }),
});

const ping = obj({ t: lit("ping"), at: integer({ minimum: 0 }) });
const pong = obj({ t: lit("pong"), at: integer({ minimum: 0 }) });
const errorFrame = obj({ t: lit("error"), code: errorCode, message: string() }, { id });
const stream = union(
  obj({ t: lit("stream"), sid: id, op: lit("open"), ch: channelName }, { ref: id, mime: string({ minLength: 1 }), size: integer({ minimum: 0 }) }),
  obj({ t: lit("stream"), sid: id, op: lit("data"), seq: integer({ minimum: 0 }), b64: string({ pattern: base64Pattern, maxLength: maxChunkBase64 }) }),
  obj({ t: lit("stream"), sid: id, op: lit("end") }),
  obj({ t: lit("stream"), sid: id, op: lit("error"), code: errorCode, message: string() }),
);

// device channel
const manifest = obj({
  t: lit("manifest"), ch: lit("device"), rev: integer({ minimum: 0 }),
  // Items are checked one by one with `checkCapabilitySpec`: one bad capability is rejected, not the whole manifest.
  capabilities: list(record()),
  events: list(obj({ word: string({ pattern: dotted }), description: string() }, { schema: record() })),
});
const manifestAck = obj({ t: lit("manifest.ack"), rev: integer({ minimum: 0 }), accepted: boolean(), rejected: list(obj({ name: string(), reason: string() })) });
const event = obj({ t: lit("event"), ch: lit("device"), id, word: string({ pattern: dotted }), body: record(), at: integer({ minimum: 0 }) });
const eventAck = obj({ t: lit("event.ack"), id });
const call = obj({
  t: lit("call"), ch: lit("device"), id, capability: string({ pattern: dotted }), args: record(),
  caller: obj({ member: string({ minLength: 1 }), label: string() }, { turn: string({ minLength: 1 }) }),
  deadline: integer({ minimum: 0 }),
});
const progress = obj({ t: lit("progress"), id, text: string() });
const result = union(
  obj({ t: lit("result"), id, ok: lit(true), content: list(contentPart) }, { data: anything() }),
  obj({ t: lit("result"), id, ok: lit(false), error: errorBody }),
);
const cancel = obj({ t: lit("cancel"), id, reason: string() });
const assess = obj({ t: lit("assess"), ch: lit("device"), id, capability: string({ pattern: dotted }), args: record() });
const assessed = obj({ t: lit("assessed"), id, risk }, { why: string() });

// human channel
const send = obj({ t: lit("send"), ch: lit("human"), id, request: sendRequest });
const sendResult = union(
  obj({ t: lit("send.result"), id, ok: lit(true), message: obj({ id: string({ minLength: 1 }), seq: integer({ minimum: 0 }) }) }, { duplicate: boolean(), response: record() }),
  obj({ t: lit("send.result"), id, ok: lit(false), error: errorBody }),
);
const sync = obj(
  { t: lit("sync"), ch: lit("human"), sid: id },
  { after: integer({ minimum: 0 }), before: integer({ minimum: 0 }), limit: integer({ minimum: 1 }), follow: boolean(), summary: boolean() },
  { not: { required: ["after", "before"] } },
);
const syncPage = obj({ t: lit("sync.page"), sid: id, messages: list(record()), end: boolean() });
const syncMsg = obj({ t: lit("sync.msg"), sid: id, message: record() });
const syncClose = obj({ t: lit("sync.close"), sid: id });
const presence = obj(
  { t: lit("presence"), ch: lit("human") },
  { visible: boolean(), watching: boolean(), typing: boolean(), agent: string({ minLength: 1 }) },
  { anyOf: [{ required: ["visible"] }, { required: ["watching"] }, { required: ["typing"] }, { required: ["agent"] }] },
);
const presentOf = <S extends string, O extends string, B>(surface: S, op: O, body: Schema<B>) =>
  obj({ t: lit("present"), ch: lit("human"), id, surface: lit(surface), op: lit(op), body });
const present = union(
  presentOf("notification", "show", loose({ id: string({ minLength: 1 }), kind: string({ minLength: 1 }), title: string(), text: string() })),
  presentOf("notification", "hide", obj({ id: string({ minLength: 1 }) })),
  presentOf("notification", "alert", obj({ id: string({ minLength: 1 }) })),
  presentOf("island", "query", obj({})),
  presentOf("status", "frame", record()),
  presentOf("status", "vscreen", obj({ open: boolean() })),
  presentOf("status", "lease", record()),
  presentOf("widget", "state", record()),
  presentOf("widget", "preview", obj({ card: anything(), size: anything() })),
  presentOf("chat", "focus", obj({})),
  presentOf("chat", "card.preview", obj({ card: record(), theme: string() })),
  presentOf("chat", "card.patch", obj({ card: record() })),
  // A page (target) or an app (app, with what it is asked to show: arg); the hub sends one of the two.
  presentOf("chat", "open", obj({}, { target: string({ minLength: 1 }), app: string({ minLength: 1 }), arg: string(), id: string(), mode: string() }, { anyOf: [{ required: ["target"], properties: { target: { type: "string" } } }, { required: ["app"], properties: { app: { type: "string" } } }] })),
);
const presentResult = union(
  obj({ t: lit("present.result"), id, ok: lit(true) }, { data: anything() }),
  obj({ t: lit("present.result"), id, ok: lit(false), error: errorBody }),
);

// agent channel. Only the envelope is fixed here; each operation's own fields belong to the agent contract (SPEC-08).
export const AGENT_OPS = [
  "agent.start", "agent.stop", "agent.list",
  "session.get", "session.set", "session.new", "session.reload", "session.compact",
  "send", "followup", "steer", "inject", "interrupt", "restart", "configure", "config.get", "plugins",
] as const;
const agent = union(
  loose({ t: lit("agent"), id, op: oneOfValues(...AGENT_OPS) }),
  loose({ t: lit("agent"), id, op_result: string({ minLength: 1 }), ok: boolean() }, { result: anything(), error: errorBody }),
  loose({ t: lit("agent"), event: string({ minLength: 1 }) }),
  loose({ t: lit("agent"), id, outbound: string({ minLength: 1 }) }),
  loose({ t: lit("agent"), id, outbound_result: string({ minLength: 1 }) }),
);

// --- registry ----------------------------------------------------------------------------------------------------------

/** Who may send the frame: the kernel, the hand, or both. */
export type FrameFrom = "kernel" | "hand" | "both";
/** The channel a frame belongs to; null for the frames that are about the connection itself. */
export type FrameChannel = "device" | "human" | "agent" | null;
const def = <T>(schema: Schema<T>, from: FrameFrom, channel: FrameChannel) => ({ schema, from, channel });

export const FRAME_DEFS = {
  challenge: def(challenge, "kernel", null),
  hello: def(hello, "hand", null),
  welcome: def(welcome, "kernel", null),
  ping: def(ping, "both", null),
  pong: def(pong, "both", null),
  error: def(errorFrame, "both", null),
  stream: def(stream, "both", null),
  manifest: def(manifest, "hand", "device"),
  "manifest.ack": def(manifestAck, "kernel", "device"),
  event: def(event, "hand", "device"),
  "event.ack": def(eventAck, "kernel", "device"),
  call: def(call, "kernel", "device"),
  progress: def(progress, "hand", "device"),
  result: def(result, "hand", "device"),
  cancel: def(cancel, "kernel", "device"),
  assess: def(assess, "kernel", "device"),
  assessed: def(assessed, "hand", "device"),
  send: def(send, "hand", "human"),
  "send.result": def(sendResult, "kernel", "human"),
  sync: def(sync, "hand", "human"),
  "sync.page": def(syncPage, "kernel", "human"),
  "sync.msg": def(syncMsg, "kernel", "human"),
  "sync.close": def(syncClose, "hand", "human"),
  presence: def(presence, "hand", "human"),
  present: def(present, "kernel", "human"),
  "present.result": def(presentResult, "hand", "human"),
  agent: def(agent, "both", "agent"),
} as const;

export type FrameType = keyof typeof FRAME_DEFS;
export type FrameOf<K extends FrameType> = Static<(typeof FRAME_DEFS)[K]["schema"]>;
export type Frame = { [K in FrameType]: FrameOf<K> }[FrameType];
export const FRAME_TYPES = Object.keys(FRAME_DEFS) as FrameType[];

export type ChallengeFrame = FrameOf<"challenge">;
export type HelloFrame = FrameOf<"hello">;
export type WelcomeFrame = FrameOf<"welcome">;
export type PingFrame = FrameOf<"ping">;
export type PongFrame = FrameOf<"pong">;
export type ErrorFrame = FrameOf<"error">;
export type StreamFrame = FrameOf<"stream">;
export type ManifestFrame = FrameOf<"manifest">;
export type ManifestAckFrame = FrameOf<"manifest.ack">;
export type EventFrame = FrameOf<"event">;
export type EventAckFrame = FrameOf<"event.ack">;
export type CallFrame = FrameOf<"call">;
export type ProgressFrame = FrameOf<"progress">;
export type ResultFrame = FrameOf<"result">;
export type CancelFrame = FrameOf<"cancel">;
export type AssessFrame = FrameOf<"assess">;
export type AssessedFrame = FrameOf<"assessed">;
export type SendFrame = FrameOf<"send">;
export type SendResultFrame = FrameOf<"send.result">;
export type SyncFrame = FrameOf<"sync">;
export type SyncPageFrame = FrameOf<"sync.page">;
export type SyncMsgFrame = FrameOf<"sync.msg">;
export type SyncCloseFrame = FrameOf<"sync.close">;
export type PresenceFrame = FrameOf<"presence">;
export type PresentFrame = FrameOf<"present">;
export type PresentResultFrame = FrameOf<"present.result">;
export type AgentFrame = FrameOf<"agent">;

export type CapabilitySpec = Static<typeof capabilitySpec>;
export type ContentPart = Static<typeof contentPart>;
export type SendRequest = Static<typeof sendRequest>;
export type ErrorBody = Static<typeof errorBody>;
export type LinkChannel = "device" | "human" | "agent";
export type HandKind = HelloFrame["hand"]["kind"];
export type HelloChannels = HelloFrame["channels"];

// --- validation --------------------------------------------------------------------------------------------------------

const ajv = new Ajv({ strict: false });
const validators = Object.fromEntries(FRAME_TYPES.map((t) => [t, ajv.compile(FRAME_DEFS[t].schema.json)])) as Record<FrameType, ReturnType<typeof ajv.compile>>;
const capabilityValidator = ajv.compile(capabilitySpec.json);

function firstError(errors: { instancePath: string; message?: string }[] | null | undefined): string {
  const first = errors?.[0];
  return first ? `${first.instancePath || "/"} ${first.message ?? "is invalid"}` : "is invalid";
}

/** The error text when [value] is not a valid frame of type [t], otherwise null. */
export function frameError(t: FrameType, value: unknown): string | null {
  const check = validators[t];
  return check(value) ? null : firstError(check.errors);
}
/** True when [value] is a valid frame of type [t]. */
export function isFrame<K extends FrameType>(t: K, value: unknown): value is FrameOf<K> {
  return validators[t](value) === true;
}
export function frameType(value: unknown): FrameType | null {
  const t = value && typeof value === "object" ? (value as { t?: unknown }).t : undefined;
  return typeof t === "string" && Object.hasOwn(FRAME_DEFS, t) ? (t as FrameType) : null;
}
/** Checks a decoded JSON value against the schema of the type its `t` names. */
export function validateFrame(value: unknown): { ok: true; frame: Frame } | { ok: false; t: FrameType | null; error: string } {
  const t = frameType(value);
  if (!t) return { ok: false, t: null, error: "unknown or missing frame type" };
  const error = frameError(t, value);
  return error ? { ok: false, t, error } : { ok: true, frame: value as Frame };
}
/**
 * Why one capability of a manifest is rejected, or null when it is acceptable: its shape, and that its schemas are
 * valid JSON Schema. The kernel rejects the single capability, never the whole manifest.
 */
export function checkCapabilitySpec(value: unknown): string | null {
  if (!capabilityValidator(value)) return firstError(capabilityValidator.errors);
  const spec = value as CapabilitySpec;
  if (!ajv.validateSchema(spec.input_schema)) return `/input_schema ${firstError(ajv.errors)}`;
  if (spec.result_schema && !ajv.validateSchema(spec.result_schema)) return `/result_schema ${firstError(ajv.errors)}`;
  return null;
}

// --- generated JSON Schema -----------------------------------------------------------------------------------------------

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const fileOf = (name: string) => `${name}.json`;
const text = (json: unknown) => `${JSON.stringify(json, null, 2)}\n`;

/**
 * The files of `schema/link/`: file name -> content. One schema per frame type, `capability-spec.json`, and
 * `index.json` (protocol name, limits, close codes, and for each frame its file, channel and sender).
 */
export function linkSchemaFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const frames: Record<string, { file: string; channel: FrameChannel; from: FrameFrom }> = {};
  for (const t of FRAME_TYPES) {
    const { schema, from, channel } = FRAME_DEFS[t];
    files[fileOf(t)] = text({ $schema: DRAFT, title: `${LINK_PROTOCOL} ${t} frame`, ...schema.json });
    frames[t] = { file: fileOf(t), channel, from };
  }
  files["capability-spec.json"] = text({ $schema: DRAFT, title: `${LINK_PROTOCOL} CapabilitySpec`, ...capabilitySpec.json });
  files["index.json"] = text({ protocol: LINK_PROTOCOL, limits: LIMITS, close_codes: CLOSE_CODES, no_reconnect: NO_RECONNECT_CODES, agent_ops: AGENT_OPS, frames });
  return files;
}
