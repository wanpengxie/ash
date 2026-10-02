import Ajv from "ajv";
import { createHash } from "node:crypto";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { AuthenticatedCallerContext, JsonSchema, Message, MessageErrorCode, ResponseBody, SendRequestV2, WordSpec } from "../../../sdk/src/api";
import { matchesSchema, schemaErrors } from "../../../sdk/src/schema";
import { deviceWordSpec, optionReplyErrors, wordContract } from "../../../sdk/src/words";
import { gateObject, Ledger, type RequestContextSnapshot, type RequestPhase, type TrackedRequest } from "./ledger";

type Transport = "web_ui" | "api" | "phone" | "agent" | "device" | "service";
/** Constructed only after edge authentication and (for web_ui) screen-token verification. */
export interface TrustedRouteContext extends AuthenticatedCallerContext {
  transport: Transport;
  screenLabel?: string;
  turn?: string;
}
export interface RouteHandlerContext { signal: AbortSignal; recovered: boolean; /** Server-stamped acceptance context; never supplied by a word body. */ caller?: Readonly<RequestContextSnapshot> }
export interface RouteEndpoint {
  member: string;
  spec: WordSpec;
  handle: (message: Message, context: RouteHandlerContext) => Promise<ResponseBody | void> | ResponseBody | void;
  cancel?: (requestId: string) => void;
  /** Only handlers with durable, message-id deduplicated intake may opt in. */
  idempotentRecovery?: boolean;
  direction?: "in" | "out";
}
export interface DeviceCapability {
  name: string;
  description: string;
  input_schema: unknown;
  result_schema?: unknown;
  risk: "none" | "outward" | "structure";
  label: string;
}
export interface GateDecision { allow: boolean; by?: "rule" | "answer" | "timeout"; reason?: string }
export type GateHook = (request: Message, spec: WordSpec, caller: RequestContextSnapshot, signal: AbortSignal) => Promise<GateDecision>;
export type RecoveryAuthorizer = (request: Message, caller: RequestContextSnapshot) => boolean | Promise<boolean>;
/** Not a send envelope: only the bound DSH Door may construct this after pre-execute provenance. */
export interface InternalApprovalIngress {
  sessionId: string;
  turn: string;
  callId: string;
  toolName: string;
  contractFingerprint: string;
  signal: AbortSignal;
  stillValid: () => boolean;
}
export type InternalApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
type Subscriber = (message: Message) => void;
interface Registered extends RouteEndpoint { validateInput: (value: unknown) => boolean; validateResult?: (value: unknown) => boolean }
interface Pending {
  request: Message;
  endpoint: Registered;
  context: RequestContextSnapshot;
  controller: AbortController;
  deadlineAt: number;
  phase: RequestPhase;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  reply: Promise<Message>;
  resolve: (message: Message) => void;
}

export class RouterError extends Error {
  constructor(readonly code: MessageErrorCode, message: string) { super(message); this.name = "RouterError"; }
}
const fail = (code: MessageErrorCode, message: string): never => { throw new RouterError(code, message); };
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const SCREEN = /^screen:[A-Za-z0-9_-]+$/;
const LOCAL_SELF_MUTATIONS = new Set(["write", "append", "apply_plan", "rollback"]);
const errors = (code: MessageErrorCode, message: string): ResponseBody => ({ ok: false, error: { code, message } });
const detached = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const ERROR_CODES = new Set<MessageErrorCode>(["bad_request", "not_found", "forbidden", "denied", "cancelled", "timeout", "offline", "failed"]);
const contextSnapshot = (ctx: TrustedRouteContext): RequestContextSnapshot => ({ member: ctx.member, local: ctx.local, remote: ctx.remote, ownerProxy: ctx.ownerProxy,
  transportPrincipal: ctx.transportPrincipal,
  ...(ctx.pairedDeviceId ? { pairedDeviceId: ctx.pairedDeviceId } : {}), ...(ctx.screenId ? { screenId: ctx.screenId } : {}) });
const askExpiry = (message: Pick<Message, "to" | "word" | "body">): number | null =>
  message.to === "person:owner" && message.word === "ask" && typeof message.body.expires_at === "number" && Number.isFinite(message.body.expires_at)
    ? Math.ceil(message.body.expires_at) : null;

function ajvFor(schema: unknown): ValidateFunction {
  if (!plainObject(schema)) throw new TypeError("device schema must be an object");
  const dialect = schema.$schema;
  const options = { strict: true, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, validateFormats: true } as const;
  const ctor = dialect === undefined || dialect === "http://json-schema.org/draft-07/schema#" || dialect === "https://json-schema.org/draft-07/schema" ? Ajv
    : dialect === "https://json-schema.org/draft/2019-09/schema" ? Ajv2019
      : dialect === "https://json-schema.org/draft/2020-12/schema" ? Ajv2020
        : null;
  if (!ctor) throw new TypeError("unsupported JSON Schema dialect");
  const instance = new ctor(options);
  addFormats(instance);
  // compile() resolves local refs but never downloads a remote schema. Unknown refs/keywords fail closed.
  return instance.compile(schema);
}

function makePending(request: Message, endpoint: Registered, context: RequestContextSnapshot, deadlineAt: number, phase: RequestPhase): Pending {
  let resolve!: (message: Message) => void;
  const reply = new Promise<Message>((done) => { resolve = done; });
  return { request, endpoint, context, deadlineAt, phase, controller: new AbortController(), timer: null, settled: false, reply, resolve };
}

export class WorldRouter {
  private readonly endpoints = new Map<string, Registered>();
  private readonly pending = new Map<string, Pending>();
  private readonly subscribers = new Set<Subscriber>();
  private gate: GateHook | null = null;
  private durableGate = false;
  private readonly internalApprovals = new Map<string, (outcome: InternalApprovalOutcome | "approved") => void>();

  constructor(readonly ledger: Ledger, private readonly authorizeRecovery: RecoveryAuthorizer) {}

  /** A one-shot DSH waterfall bridge. No public endpoint or Member owns internal.approval. */
  async requestInternalApproval(input: InternalApprovalIngress): Promise<InternalApprovalOutcome> {
    if (!this.durableGate || input.signal.aborted || !input.stillValid() || !this.endpoint("person:owner", "ask")) return "unavailable";
    let parent: Message;
    try { parent = this.ledger.acceptInternalApproval({ sessionId: input.sessionId, turn: input.turn, callId: input.callId,
      toolName: input.toolName, contractFingerprint: input.contractFingerprint, deadlineAt: Date.now() + 600_000 }); }
    catch { return "unavailable"; }
    this.publish(parent);
    const outcome = new Promise<InternalApprovalOutcome | "approved">((resolve) => this.internalApprovals.set(parent.id, resolve));
    let askId: string | null = null;
    const abort = () => { if (askId) this.cancel([askId]); else {
      const response = this.ledger.failInternalApproval(parent.id);
      if (response) this.publish(response);
      this.internalApprovals.get(parent.id)?.("cancelled");
    } };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted || !input.stillValid()) { abort(); return "cancelled"; }
      const accepted = this.ledger.trackedRequests().find((item) => item.message.id === parent.id);
      if (!accepted) return "unavailable";
      // The ask shares the parent's durable deadline. Recomputing from parent.ts
      // can exceed it by even one millisecond and sporadically reject beginGate.
      const expiresAt = accepted.deadlineAt;
      const started = this.ledger.beginGate(parent.id, { subject: hash({ member: "agent:main", sessionId: input.sessionId }),
        risk: "structure", contractFingerprint: input.contractFingerprint, expiresAt,
        askBody: { title: "Confirm tool", detail: `Allow ${input.toolName} once?`,
          options: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny" }],
          source: { word: "internal.approval", to: "service:gate", body_preview: "DSH tool request" } } });
      if (!started) return "unavailable";
      askId = started.ask.id;
      this.publish(started.ask); this.publish(started.event);
      this.activateGateAsk(started.ask);
      if (input.signal.aborted) abort();
      const decision = await outcome;
      if (decision !== "approved") return decision;
      if (input.signal.aborted || !input.stillValid()) return "cancelled";
      const tracked = this.ledger.trackedRequests().find((item) => item.message.id === parent.id);
      if (!tracked || !await this.currentlyAuthorized(parent, tracked.context) || input.signal.aborted || !input.stillValid()) return "unavailable";
      if (!this.ledger.dispatchAllowedGate(parent.id, hash({ member: "agent:main", sessionId: input.sessionId }), input.contractFingerprint))
        return "unavailable";
      const response = this.ledger.settle(parent.id, "service:gate", { ok: true, result: { outcome: "allowed-once" } }).message;
      this.publish(response);
      return "allowed-once";
    } catch {
      const response = this.ledger.failInternalApproval(parent.id);
      if (response) this.publish(response);
      return "unavailable";
    } finally {
      input.signal.removeEventListener("abort", abort);
      if (!this.ledger.responseTo(parent.id)) {
        if (askId && this.pending.has(askId)) this.cancel([askId]);
        const response = this.ledger.failInternalApproval(parent.id);
        if (response) this.publish(response);
      }
      this.internalApprovals.delete(parent.id);
    }
  }

  /** Recheck a stored delegate against the current credential/grant authority. */
  async currentlyAuthorized(request: Message, caller: RequestContextSnapshot): Promise<boolean> {
    try { return Boolean(await this.authorizeRecovery(detached(request), detached(caller))); }
    catch { return false; }
  }

  /** Internal preflight for a future request; actual dispatch validates again. */
  acceptsRequest(to: string, word: string, body: unknown): boolean {
    const endpoint = this.endpoint(to, word);
    try { return Boolean(endpoint && endpoint.direction !== "out" && endpoint.spec.kind === "request" && endpoint.validateInput(body)); }
    catch { return false; }
  }

  /** Internal status inputs only: no body, credential, or handler escapes this projection. */
  pendingStatusInputs(actor: string): { id: string; from: string; to: string; word: string; turn?: string }[] {
    return [...this.pending.values()].filter((item) => item.request.to &&
      (item.request.from === actor || (item.request.to === "person:owner" && item.request.word === "ask")))
      .map(({ request }) => ({ id: request.id, from: request.from, to: request.to!, word: request.word,
        ...(request.turn ? { turn: request.turn } : {}) }));
  }

  /** Return the validated registration snapshot, not a caller- or model-supplied label. */
  registeredLabel(to: string, word: string): string | undefined { return this.endpoint(to, word)?.spec.label; }

  register(endpoint: RouteEndpoint): void {
    this.registerBatch([endpoint]);
  }

  /** Validate every static endpoint before publishing any route. Returned specs are detached. */
  registerBatch(endpoints: readonly RouteEndpoint[]): WordSpec[] {
    const prepared = new Map<string, Registered>();
    for (const endpoint of endpoints) {
      if (!endpoint.member || !endpoint.spec || typeof endpoint.spec.word !== "string" || !endpoint.spec.word || !endpoint.spec.input_schema || typeof endpoint.spec.description !== "string" || !endpoint.spec.description.trim() || !["request", "event"].includes(endpoint.spec.kind)) throw new TypeError("invalid endpoint");
      const contract = endpoint.spec as WordSpec & { member?: unknown; direction?: unknown };
      if (contract.member !== undefined && contract.member !== endpoint.member) throw new TypeError("endpoint member mismatch");
      if (contract.direction !== undefined && !["in", "out"].includes(contract.direction as string)) throw new TypeError("invalid endpoint direction");
      if (endpoint.direction !== undefined && contract.direction !== undefined && endpoint.direction !== contract.direction) throw new TypeError("endpoint direction mismatch");
      const direction = endpoint.direction ?? contract.direction as RouteEndpoint["direction"];
      const key = `${endpoint.member}/${endpoint.spec.word}`;
      if (this.endpoints.has(key) || prepared.has(key)) throw new TypeError("duplicate endpoint");
      const spec = detached(endpoint.spec);
      delete (spec as WordSpec & { member?: unknown; direction?: unknown }).member;
      delete (spec as WordSpec & { member?: unknown; direction?: unknown }).direction;
      schemaErrors(spec.input_schema!, {}); // preflight the complete internal schema tree
      if (spec.result_schema) schemaErrors(spec.result_schema, {});
      if (spec.timeout_ms !== undefined && (!Number.isSafeInteger(spec.timeout_ms) || spec.timeout_ms <= 0)) throw new TypeError("invalid endpoint timeout");
      if (spec.audience !== undefined && !["agent", "owner", "all"].includes(spec.audience)) throw new TypeError("invalid endpoint audience");
      if (spec.risk !== undefined && !["none", "outward", "structure"].includes(spec.risk)) throw new TypeError("invalid endpoint risk");
      const validateInput = (value: unknown) => matchesSchema(spec.input_schema!, value);
      const validateResult = spec.result_schema ? (value: unknown) => matchesSchema(spec.result_schema!, value) : undefined;
      prepared.set(key, { ...endpoint, direction, spec, validateInput, validateResult });
    }
    for (const [key, endpoint] of prepared) this.endpoints.set(key, endpoint);
    return [...prepared.values()].map((endpoint) => detached(endpoint.spec));
  }

  registerDevice(member: string, capability: DeviceCapability, handle: RouteEndpoint["handle"], options: Pick<RouteEndpoint, "cancel" | "idempotentRecovery"> = {}): void {
    this.registerDeviceBatch(member, [capability], handle, options);
  }

  /** Compile all external schemas with Ajv before any capability becomes callable. */
  registerDeviceBatch(member: string, capabilities: readonly DeviceCapability[], handle: RouteEndpoint["handle"], options: Pick<RouteEndpoint, "cancel" | "idempotentRecovery"> = {}): WordSpec[] {
    const prepared = this.prepareDeviceBatch(member, capabilities, handle, options);
    for (const key of prepared.keys()) if (this.endpoints.has(key)) throw new TypeError("duplicate endpoint");
    for (const [key, endpoint] of prepared) this.endpoints.set(key, endpoint);
    return [...prepared.values()].map((endpoint) => detached(endpoint.spec));
  }

  /** Recompile the complete manifest before a synchronous, all-or-nothing route switch. */
  replaceDeviceBatch(member: string, capabilities: readonly DeviceCapability[], handle: RouteEndpoint["handle"], options: Pick<RouteEndpoint, "cancel" | "idempotentRecovery"> = {}): WordSpec[] {
    const prepared = this.prepareDeviceBatch(member, capabilities, handle, options);
    this.unregisterDevice(member);
    for (const [key, endpoint] of prepared) this.endpoints.set(key, endpoint);
    return [...prepared.values()].map((endpoint) => detached(endpoint.spec));
  }

  unregisterDevice(member: string): void {
    if (!/^device:[A-Za-z0-9_-]+$/.test(member)) throw new TypeError("device member required");
    for (const key of this.endpoints.keys()) if (key.startsWith(`${member}/`)) this.endpoints.delete(key);
  }

  cancelMember(member: string): Message[] {
    return this.cancel([...this.pending.values()].filter((item) => item.request.to === member).map((item) => item.request.id));
  }

  private prepareDeviceBatch(member: string, capabilities: readonly DeviceCapability[], handle: RouteEndpoint["handle"], options: Pick<RouteEndpoint, "cancel" | "idempotentRecovery">): Map<string, Registered> {
    if (!/^device:[A-Za-z0-9_-]+$/.test(member)) throw new TypeError("device member required");
    const prepared = new Map<string, Registered>();
    for (const capability of capabilities) {
      const safeCapability = detached(capability);
      const spec = deviceWordSpec(safeCapability as Parameters<typeof deviceWordSpec>[0]);
      const key = `${member}/${spec.word}`;
      if (prepared.has(key)) throw new TypeError("duplicate endpoint");
      const validateInput = ajvFor(safeCapability.input_schema);
      const validateResult = ajvFor(spec.result_schema);
      prepared.set(key, { member, spec, handle, ...options, validateInput, validateResult });
    }
    return prepared;
  }

  setGate(gate: GateHook): void { this.gate = gate; }
  /** Production gate is ledger-backed; fake GateHook remains only for isolated router tests. */
  enableDurableGate(): void {
    if (this.gate) throw new TypeError("cannot combine durable gate with fake gate hook");
    this.durableGate = true;
  }
  subscribe(listener: Subscriber): () => void { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }

  /** Publish a post event only after its journal transition and event have committed. */
  publishPostEvent(message: Message): void {
    const stored = this.ledger.byId(message.id);
    const schema = stored && ["post.changed", "post.delivery"].includes(stored.word)
      ? wordContract("service:post", stored.word)?.input_schema : null;
    if (!stored || stored.seq !== message.seq || stored.from !== "service:post" || stored.to !== "person:owner" ||
      stored.kind !== "event" || !schema || !matchesSchema(schema, stored.body))
      throw new TypeError("not a committed post event");
    this.publish(stored);
  }
  /** Notify streams only after a work row and its event have committed together. */
  publishWorkEvent(message: Message): void {
    const stored = this.ledger.byId(message.id);
    const schema = stored && ["run.start", "run.step", "run.end"].includes(stored.word)
      ? wordContract("service:work", stored.word)?.input_schema : null;
    if (!stored || stored.seq !== message.seq || stored.from !== "service:work" || stored.to !== null ||
      stored.kind !== "event" || !schema || !matchesSchema(schema, stored.body) || stored.turn !== stored.body.run)
      throw new TypeError("not a committed work event");
    this.publish(stored);
  }
  /** The bound DSH session reports its own tool events; these are audit facts, not dispatch requests. */
  recordDshToolCall(turn: string, callId: string, name: string, argumentsText: string): Message {
    if (!/^t_[A-Za-z0-9_-]+$/.test(turn) || !/^[A-Za-z0-9_-]{1,128}$/.test(callId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(name) || typeof argumentsText !== "string") throw new TypeError("invalid DSH tool event");
    const stored = this.ledger.append({ from: "agent:main", to: "service:dsh-tool", kind: "request", word: name,
      body: { call_id: callId, arguments: argumentsText }, turn }, { transportPrincipal: `dsh:${turn}`, clientId: callId });
    if (!stored.duplicate) this.publish(stored.message);
    return stored.message;
  }
  recordDshToolResult(requestId: string, ok: boolean, preview: string): Message {
    const request = this.ledger.byId(requestId);
    if (!request || request.from !== "agent:main" || request.to !== "service:dsh-tool" || request.kind !== "request")
      throw new TypeError("unknown DSH tool call");
    const body: ResponseBody = ok ? { ok: true, result: { preview: preview.slice(0, 1000) } }
      : { ok: false, error: { code: "failed", message: "DSH tool failed" } };
    const settled = this.ledger.settle(requestId, "service:dsh-tool", body);
    if (settled.settled) this.publish(settled.message);
    return settled.message;
  }
  private publish(message: Message): void {
    for (const listener of this.subscribers) {
      try { listener(detached(message)); } catch { /* a broken stream cannot interrupt durable routing */ }
    }
  }
  private endpoint(to: string, word: string): Registered | undefined {
    return this.endpoints.get(`${to}/${word}`) ?? (SCREEN.test(to) ? this.endpoints.get(`screen:*/${word}`) : undefined);
  }

  private validateContext(ctx: TrustedRouteContext): void {
    if (!ctx.transportPrincipal || !ctx.member || ctx.local === ctx.remote) fail("forbidden", "invalid authenticated caller context");
    if (ctx.transport === "web_ui") {
      if (ctx.member !== "person:owner" || !ctx.ownerProxy || !ctx.screenId || !ctx.screenLabel || !SCREEN.test(ctx.screenId)) fail("forbidden", "verified screen registration required");
    } else if (ctx.transport === "phone") {
      if (ctx.member !== "device:phone") fail("forbidden", "phone transport mismatch");
    } else if (ctx.transport === "agent" && !ctx.member.startsWith("agent:")) fail("forbidden", "agent transport mismatch");
    else if (ctx.transport === "device" && !ctx.member.startsWith("device:")) fail("forbidden", "device transport mismatch");
    else if (ctx.transport === "service" && !ctx.member.startsWith("service:")) fail("forbidden", "service transport mismatch");
    else if (ctx.transport === "api" && ctx.member !== "person:owner") fail("forbidden", "owner API identity required");
    else if (!["web_ui", "api", "phone", "agent", "device", "service"].includes(ctx.transport)) fail("forbidden", "unknown authenticated transport");
  }

  private stampedSender(ctx: TrustedRouteContext, request: SendRequestV2): { from: string; origin?: Message["origin"] } {
    if (ctx.transport === "web_ui") {
      const screen = ctx.screenId!;
      if ((request.to === "agent:main" && request.word === "typing") || (request.to === "service:post" && (request.word === "visible" || request.word === "hidden"))) return { from: screen, origin: { screen, label: ctx.screenLabel! } };
      if (request.kind === "response" && request.word === "ui.open") return { from: screen, origin: { screen, label: ctx.screenLabel! } };
      return { from: "person:owner", origin: { screen, label: ctx.screenLabel! } };
    }
    if (ctx.transport === "phone") {
      if (request.kind === "request" && request.to === "service:admin" && request.word === "pause") {
        if (!ctx.ownerProxy || !ctx.local || ctx.remote) fail("forbidden", "local phone pause requires owner proxy");
        return { from: "person:owner", origin: { screen: "device:phone", label: "Phone notification" } };
      }
      if ((request.kind === "request" && request.to === "agent:main" && request.word === "say") || (request.kind === "response" && request.word === "ask")) {
        if (!ctx.ownerProxy) fail("forbidden", "notification proxy not authorized");
        return { from: "person:owner", origin: { screen: "device:phone", label: "Phone notification" } };
      }
      if (request.kind !== "event" || !request.word.startsWith("sense.")) fail("forbidden", "phone may only send senses, notification replies, or pause");
    }
    return { from: ctx.member };
  }

  private async reflexPauseSource(by: unknown): Promise<boolean> {
    if (typeof by !== "string" || !by) return false;
    const source = this.ledger.requestSource(by);
    if (!source || source.message.seq <= this.ledger.migration.lastLegacySeq || source.message.kind !== "request" ||
      source.message.from !== "person:owner" || source.message.to !== "agent:main" || source.message.word !== "say" ||
      source.context.member !== "person:owner" || !source.context.local || source.context.remote || !source.context.ownerProxy ||
      !source.context.transportPrincipal) return false;
    return this.currentlyAuthorized(source.message, source.context);
  }

  /** Recheck the original owner provenance immediately before a reflex pause effect. */
  async currentlyAuthorizedReflexPause(by: unknown): Promise<boolean> { return this.reflexPauseSource(by); }

  private async authorize(ctx: TrustedRouteContext, request: SendRequestV2, from: string): Promise<void> {
    if (request.to === "person:owner" && request.word === "say" && Object.hasOwn(request.body, "dedupe_key") &&
      (ctx.remote || !ctx.local || !((ctx.transport === "agent" && from === "agent:main" && ctx.transportPrincipal === "agent:main") ||
        (ctx.transport === "service" && from === "service:work" && ctx.transportPrincipal === "service:work"))))
      fail("forbidden", "proactive delivery key requires trusted local agent or work service");
    if (request.to === "service:admin") {
      const reflexPause = request.word === "pause" && from === "service:reflex" && ctx.transport === "service" &&
        ctx.transportPrincipal === "service:reflex" && ctx.local && !ctx.remote && await this.reflexPauseSource(request.body.by);
      if (!reflexPause && (ctx.remote || !ctx.local || from !== "person:owner" || (request.word === "pause" && Object.hasOwn(request.body, "by"))))
        fail("forbidden", "administration requires current local owner authority");
      if (request.word === "resume" && (ctx.transport !== "web_ui" || !ctx.screenId || !ctx.ownerProxy))
        fail("forbidden", "resume requires a verified local owner screen");
    }
    if (request.to === "service:self" && LOCAL_SELF_MUTATIONS.has(request.word)) {
      const workFlowWrite = ctx.transport === "service" && from === "service:work" && (request.word === "append" || request.word === "apply_plan");
      if (ctx.remote || !ctx.local || !(from === "person:owner" || from === "agent:main" || workFlowWrite)) fail("forbidden", "managed writes require local authority");
    }
    if (request.to === "service:work" && (request.word === "run" || request.word === "runs") && from !== "person:owner")
      fail("forbidden", "only owner may inspect or start background work");
    if (request.to === "service:gate" && from !== "person:owner") fail("forbidden", "gate inspection requires owner");
    if (request.to === "service:gate" && (request.word === "rules.revoke" || request.word.startsWith("access.")) &&
      (ctx.remote || !ctx.local || !ctx.ownerProxy || (request.word.startsWith("access.") && !["api", "web_ui"].includes(ctx.transport))))
      fail("forbidden", "gate change requires current local owner");
    if (request.to === "agent:main" && request.word === "cancel_turn" && !["service:reflex", "service:admin"].includes(from)) fail("forbidden", "cancel_turn is internal only");
    if (request.to === "agent:main" && request.word === "wake" && !["service:clock", "service:senses", "service:work"].includes(from)) fail("forbidden", "wake is internal only");
    if (["typing", "visible", "hidden"].includes(request.word) && (ctx.transport !== "web_ui" || !from.startsWith("screen:"))) fail("forbidden", "presence requires registered screen");
    if (request.to === "service:post" && request.word === "deliver" && ctx.transport !== "service") fail("forbidden", "delivery is internal only");
    // Workers are single judgement steps of a background run; nobody else may spend model calls on them.
    if (request.to?.startsWith("worker:") && !(ctx.transport === "service" && from === "service:work" && ctx.local && !ctx.remote))
      fail("forbidden", "workers only take requests from background work");
    if (request.to === "service:senses" && request.word.startsWith("sense.") && (ctx.transport !== "phone" || from !== "device:phone")) fail("forbidden", "senses require phone identity");
    if (ctx.transport === "web_ui" && request.kind === "event" && !["typing", "visible", "hidden"].includes(request.word)) fail("forbidden", "screen cannot emit internal events");
  }

  private validateRequestShape(request: SendRequestV2): void {
    if (!plainObject(request) || Object.keys(request).some((key) => !["to", "kind", "word", "body", "reply_to", "wait", "client_id"].includes(key))) fail("bad_request", "unsupported send field");
    if (request.to !== null && (typeof request.to !== "string" || !request.to)) fail("bad_request", "invalid recipient");
    if (!["request", "response", "event"].includes(request.kind) || typeof request.word !== "string" || !request.word || !plainObject(request.body)) fail("bad_request", "invalid message");
    if (request.client_id !== undefined && (typeof request.client_id !== "string" || request.client_id.length < 1 || request.client_id.length > 128)) fail("bad_request", "invalid client_id");
    if (request.wait !== undefined && (typeof request.wait !== "boolean" || (request.kind !== "request" && request.wait))) fail("bad_request", "wait is only for requests");
    if (request.kind === "response" ? !request.reply_to || typeof request.reply_to !== "string" : request.reply_to !== undefined) fail("bad_request", "invalid reply_to");
  }

  /** Internal cancellation fence: abort before acceptance prevents a delayed caller from committing. It cannot undo an accepted message or external effect. */
  async send(ctx: TrustedRouteContext, request: SendRequestV2, signal?: AbortSignal): Promise<{ id: string; seq: number; reply?: Message }> {
    if (signal?.aborted) fail("cancelled", "send aborted before acceptance");
    this.validateContext(ctx); this.validateRequestShape(request);
    const { from, origin } = this.stampedSender(ctx, request);
    await this.authorize(ctx, request, from);
    if (request.kind === "response") return this.acceptResponse(request, from, ctx, origin, signal);
    if (request.to === null && request.kind !== "event") fail("bad_request", "request needs recipient");
    const endpoint = request.to ? this.endpoint(request.to, request.word) : undefined;
    const outbound = request.kind === "event" ? wordContract(from, request.word) : undefined;
    const sourceEvent = outbound?.kind === "event" && outbound.direction === "out";
    // Model-facing MCP/API agent credentials may request work, but cannot forge
    // the agent's code-derived receipt, turn, or status control events.
    if (sourceEvent && from === "agent:main" && (ctx.transport !== "agent" || ctx.transportPrincipal !== "agent:main"))
      fail("forbidden", "agent control events require the internal agent context");
    const senseContract = request.kind === "event" && ctx.transport === "phone" && from === "device:phone" && request.to === null ? wordContract("service:senses", request.word) : undefined;
    const phoneSense = senseContract?.kind === "event" && senseContract.direction === "in" && request.word.startsWith("sense.");
    if (request.to && !endpoint && !sourceEvent) fail("not_found", "recipient word not found");
    if (endpoint && (endpoint.direction === "out" || endpoint.spec.kind !== request.kind)) fail("forbidden", "word cannot be sent in this direction");
    if (endpoint && !endpoint.validateInput(request.body)) fail("bad_request", "body does not match word schema");
    if (from === "person:owner" && request.to === "agent:main" && request.word === "say" && optionReplyErrors(request.body).length)
      fail("bad_request", "invalid option answer fields");
    if (request.kind === "event" && !endpoint && !sourceEvent && !phoneSense) fail("not_found", "event word not found");
    if (sourceEvent && !matchesSchema(outbound.input_schema!, request.body)) fail("bad_request", "event body does not match schema");
    if (phoneSense && !matchesSchema(senseContract.input_schema!, request.body)) fail("bad_request", "sense body does not match schema");
    if (request.to === null && !sourceEvent && !phoneSense) fail("forbidden", "broadcast not authorized");
    if (sourceEvent && request.to !== null && request.to !== "person:owner") fail("forbidden", "outbound event target is not allowed");
    if (sourceEvent && from === "service:post" && request.word === "post.changed" && request.to !== "person:owner") fail("forbidden", "post snapshot is owner-targeted");
    if (this.durableGate && request.kind === "request" && request.to?.startsWith("device:") &&
      !this.ledger.gateDeviceAccess(from, request.to, request.word)) fail("forbidden", "current device access grant unavailable");
    // A risky request and its owner approval share one persisted total budget.
    // Explicit endpoint deadlines remain authoritative, even when shorter.
    const timeoutMs = endpoint?.spec.timeout_ms ?? (request.kind === "request" && endpoint?.spec.risk && endpoint.spec.risk !== "none" ? 600_000 : 60_000);
    if (request.kind === "request" && request.to === "person:owner" && request.word === "ask" && askExpiry(request) === null) fail("bad_request", "ask requires a finite expiry");
    const deadlineAt = Math.min(Date.now() + timeoutMs, request.kind === "request" ? askExpiry(request) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
    const input = { from, to: request.to, kind: request.kind, word: request.word, body: request.body, ...(origin ? { origin } : {}), ...(ctx.turn ? { turn: ctx.turn } : {}) };
    let accepted: ReturnType<Ledger["append"]>;
    if (signal?.aborted) fail("cancelled", "send aborted before acceptance");
    try { accepted = this.ledger.append(input, request.client_id ? { transportPrincipal: ctx.transportPrincipal, clientId: request.client_id } : undefined,
      request.kind === "request" ? { deadlineAt, context: contextSnapshot(ctx) } : undefined,
      from === "service:reflex" && request.to === "service:admin" && request.word === "pause" ? { byMessageId: String(request.body.by) } : undefined); }
    catch (error) { if (error instanceof TypeError) fail("bad_request", error.message); throw error; }
    const message = accepted.message;
    if (accepted.duplicate) {
      const reply = this.ledger.responseTo(message.id) ?? (request.wait ? await this.pending.get(message.id)?.reply : undefined);
      return { id: message.id, seq: message.seq, ...(reply ? { reply } : {}) };
    }
    this.publish(message);
    if (request.kind === "event") {
      if (endpoint) void Promise.resolve(endpoint.handle(detached(message), { signal: new AbortController().signal, recovered: false, caller: Object.freeze(contextSnapshot(ctx)) })).catch(() => {});
      return { id: message.id, seq: message.seq };
    }
    if (!endpoint) throw new RouterError("not_found", "recipient word not found");
    if (this.endpoint(message.to!, message.word) !== endpoint) {
      const response = this.ledger.settle(message.id, message.to!, errors("cancelled", "device route changed before dispatch")).message;
      this.publish(response);
      return { id: message.id, seq: message.seq, ...(request.wait ? { reply: response } : {}) };
    }
    const tracked = this.ledger.trackedRequests().find((item) => item.message.id === message.id)!;
    const pending = makePending(message, endpoint, tracked.context, tracked.deadlineAt, "accepted");
    this.pending.set(message.id, pending);
    if (Date.now() >= pending.deadlineAt) this.expirePending(pending);
    else { this.armTimeout(pending); void this.dispatch(pending, false); }
    const reply = request.wait ? await pending.reply : undefined;
    return { id: message.id, seq: message.seq, ...(reply ? { reply } : {}) };
  }

  private async acceptResponse(request: SendRequestV2, from: string, ctx: TrustedRouteContext, origin?: Message["origin"], signal?: AbortSignal): Promise<{ id: string; seq: number }> {
    const original = this.ledger.byId(request.reply_to!);
    if (!original || original.kind !== "request" || original.seq <= this.ledger.migration.lastLegacySeq || original.to !== from || original.from !== request.to || original.word !== request.word) throw new RouterError("bad_request", "response does not match an active request");
    if (original.to === "person:owner" && original.word === "ask" && !(ctx.transport === "web_ui" || (ctx.transport === "phone" && ctx.ownerProxy))) fail("forbidden", "ask requires a verified screen or notification proxy");
    const retry = request.client_id ? { transportPrincipal: ctx.transportPrincipal, clientId: request.client_id } : undefined;
    if (retry) {
      let previous: Message | null;
      try { previous = this.ledger.responseRetry(retry, { from, to: request.to, kind: "response", word: request.word, body: request.body, reply_to: request.reply_to, ...(origin ? { origin } : {}) }); }
      catch (error) { if (error instanceof TypeError) fail("bad_request", error.message); throw error; }
      if (previous) return { id: previous.id, seq: previous.seq };
    }
    const endpoint = this.endpoint(original.to!, original.word);
    if (!endpoint || this.ledger.responseTo(original.id)) throw new RouterError("bad_request", "request already settled or unavailable");
    const body = request.body as ResponseBody;
    if (typeof body.ok !== "boolean" || (body.ok && endpoint.validateResult && !endpoint.validateResult(body.result)) || (!body.ok && (!plainObject(body.error) || !ERROR_CODES.has(body.error.code as MessageErrorCode) || typeof body.error.message !== "string"))) fail("bad_request", "invalid response body");
    const pending = this.pending.get(original.id);
    if (!pending || pending.settled) throw new RouterError("bad_request", "request no longer accepting replies");
    if (Date.now() >= pending.deadlineAt) {
      this.expirePending(pending);
      throw new RouterError("bad_request", "request expired before reply");
    }
    if (original.to === "person:owner" && original.word === "ask") {
      const choice = body.ok && plainObject(body.result) ? body.result.choice : undefined;
      const options = original.body.options;
      if (typeof choice !== "string" || !Array.isArray(options) || !options.some((option) => plainObject(option) && option.id === choice)) fail("bad_request", "ask choice was not offered");
    }
    if (signal?.aborted) fail("cancelled", "send aborted before settlement");
    const gateCase = this.durableGate && original.from === "service:gate" ? this.ledger.gateCaseByAsk(original.id) : null;
    if (gateCase) {
      const choice = body.ok && plainObject(body.result) ? body.result.choice : undefined;
      if (choice !== "once" && choice !== "always" && choice !== "deny") throw new RouterError("bad_request", "gate choice is not available");
      const response = this.settleGateAsk(pending, choice, "answer", origin, retry);
      if (!response) throw new RouterError("bad_request", "gate ask already settled");
      return { id: response.id, seq: response.seq };
    }
    const result = this.finish(pending, body, from, false, origin, retry);
    if (!result) throw new RouterError("bad_request", "request already settled");
    return { id: result.id, seq: result.seq };
  }

  private deadlineBody(pending: Pending): ResponseBody {
    const expiry = askExpiry(pending.request);
    return expiry !== null && Date.now() >= expiry ? { ok: true, result: { choice: "deny" } } : errors("timeout", "request timed out");
  }

  private armTimeout(pending: Pending): void {
    const remaining = Math.max(0, pending.deadlineAt - Date.now());
    pending.timer = setTimeout(() => {
      if (pending.settled) return;
      if (Date.now() < pending.deadlineAt) { this.armTimeout(pending); return; }
      this.expirePending(pending);
    }, remaining);
  }

  private finish(pending: Pending, body: ResponseBody, from: string, abort: boolean, origin?: Message["origin"], retry?: { transportPrincipal: string; clientId: string }): Message | null {
    if (pending.settled) return null;
    const result = this.ledger.settle(pending.request.id, from, body, origin, retry);
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(pending.request.id);
    if (abort) {
      pending.controller.abort();
      try { pending.endpoint.cancel?.(pending.request.id); } catch { /* a handler cannot delay settlement */ }
    }
    if (result.settled) this.publish(result.message);
    pending.resolve(result.message);
    return result.settled ? result.message : null;
  }

  private gateEvent(word: "gate.asked" | "gate.passed" | "gate.denied", body: Record<string, unknown>): void {
    const event = this.ledger.append({ from: "service:gate", to: null, kind: "event", word, body }).message;
    this.publish(event);
  }

  private gateIdentity(pending: Pending): { subject: string; fingerprint: string } {
    const { request, endpoint, context } = pending;
    return {
      subject: hash({ member: request.from, principal: context.transportPrincipal, pairedDeviceId: context.pairedDeviceId ?? null }),
      fingerprint: hash({ to: request.to, word: request.word, spec: endpoint.spec }),
    };
  }

  private activateGateAsk(ask: Message): void {
    const endpoint = this.endpoint("person:owner", "ask");
    const tracked = this.ledger.trackedRequests().find((item) => item.message.id === ask.id);
    if (!endpoint || !tracked || endpoint.spec.kind !== "request" || !endpoint.validateInput(ask.body))
      throw new TypeError("owner ask endpoint unavailable after gate commit");
    const pending = makePending(ask, endpoint, tracked.context, tracked.deadlineAt, "accepted");
    this.pending.set(ask.id, pending);
    this.armTimeout(pending);
    void this.dispatch(pending, false);
  }

  private adoptGateTerminal(pending: Pending, response: Message, abort: boolean): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(pending.request.id);
    if (abort) {
      pending.controller.abort();
      try { pending.endpoint.cancel?.(pending.request.id); } catch { /* no handler may block settlement */ }
    }
    pending.resolve(response);
  }

  private settleGateAsk(pending: Pending, choice: "once" | "always" | "deny", cause: "answer" | "deadline" | "cancelled",
    origin?: Message["origin"], retry?: { transportPrincipal: string; clientId: string }): Message | null {
    const outcome = this.ledger.settleGateAsk(pending.request.id, choice, cause, origin, retry);
    if (!outcome) return null;
    this.adoptGateTerminal(pending, outcome.askResponse, cause !== "answer");
    this.publish(outcome.askResponse);
    if (outcome.event) this.publish(outcome.event);
    const originalId = this.ledger.gateCaseByAsk(pending.request.id)!.requestId;
    const internal = this.internalApprovals.get(originalId);
    if (internal) internal(cause === "cancelled" ? "cancelled" : cause === "deadline" ? "unavailable"
      : choice === "deny" ? "rejected" : "approved");
    const original = this.pending.get(originalId);
    if (outcome.originalResponse) {
      if (original) this.adoptGateTerminal(original, outcome.originalResponse, true);
      this.publish(outcome.originalResponse);
    } else if (original && !original.settled) void this.dispatch(original, false);
    return outcome.askResponse;
  }

  private expirePending(pending: Pending): void {
    const gateAsk = pending.request.from === "service:gate" && pending.request.to === "person:owner" && pending.request.word === "ask"
      ? this.ledger.gateCaseByAsk(pending.request.id) : null;
    const gateOriginal = this.durableGate && pending.phase === "gate_waiting" ? this.ledger.gateCase(pending.request.id) : null;
    if (gateAsk && gateAsk.decision === "waiting") { this.settleGateAsk(pending, "deny", "deadline"); return; }
    if (gateOriginal?.decision === "waiting") {
      const ask = this.pending.get(gateOriginal.askId);
      if (ask) { this.settleGateAsk(ask, "deny", "deadline"); return; }
      const outcome = this.ledger.settleGateAsk(gateOriginal.askId, "deny", "deadline");
      if (outcome?.originalResponse) {
        this.publish(outcome.askResponse);
        if (outcome.event) this.publish(outcome.event);
        this.adoptGateTerminal(pending, outcome.originalResponse, true);
        this.publish(outcome.originalResponse);
        return;
      }
      // Missing owner ask is corrupt state, never a reason to execute the request.
    }
    this.finish(pending, this.deadlineBody(pending), pending.request.to!, true);
  }

  private async dispatch(pending: Pending, recovered: boolean): Promise<void> {
    const { request, endpoint } = pending;
    if (pending.settled) return;
    try {
      const gateBypass = request.from === "person:owner";
      if (this.durableGate && pending.phase === "accepted" && endpoint.spec.risk && endpoint.spec.risk !== "none" && !gateBypass) {
        const currentAuthority = await this.currentlyAuthorized(request, pending.context);
        if (pending.settled) return;
        if (!currentAuthority || this.endpoint(request.to!, request.word) !== endpoint || !endpoint.validateInput(request.body) ||
          (request.to?.startsWith("device:") && !this.ledger.gateDeviceAccess(request.from, request.to, request.word))) {
          this.finish(pending, errors("forbidden", "risk request authority changed before gate"), request.to!, false); return;
        }
        if (!pending.context.transportPrincipal || !this.endpoint("person:owner", "ask")) {
          this.finish(pending, errors("failed", "owner approval unavailable"), request.to!, false); return;
        }
        const identity = this.gateIdentity(pending);
        const objectPattern = gateObject(request.to!, request.word, request.body);
        const ruleEvent = objectPattern ? this.ledger.passGateByRule(request.id, identity.subject, identity.fingerprint, objectPattern) : null;
        if (ruleEvent) {
          pending.phase = "dispatching";
          this.publish(ruleEvent);
        } else {
        const expiresAt = Math.min(request.ts + 600_000, pending.deadlineAt);
        const calendarAsk = request.word === "calendar.create" && Number.isSafeInteger(request.body.calendar_id) &&
          (request.body.calendar_id as number) > 0;
        const eventTitle = typeof request.body.title === "string" ? request.body.title.slice(0, 100) : "未命名事件";
        const eventStart = request.body.start_ms;
        const startText = typeof eventStart === "number" && Number.isFinite(new Date(eventStart).getTime())
          ? `，开始时间 ${new Date(eventStart).toLocaleString("zh-CN")}` : "";
        const detail = calendarAsk ? `在日历 ${objectPattern} 添加“${eventTitle}”${startText}。`
          : `${endpoint.spec.label ?? request.word}: ${JSON.stringify(request.body).slice(0, 500)}`;
        const started = this.ledger.beginGate(request.id, { subject: identity.subject, risk: endpoint.spec.risk,
          contractFingerprint: identity.fingerprint, expiresAt, objectPattern,
          askBody: { title: calendarAsk ? "创建日历事件" : "Confirm action", detail,
            options: [{ id: "once", label: "Allow once" }, { id: "always", label: calendarAsk
              ? "Allow this calendar for 30 days" : "Allow this action and object for 30 days" },
              { id: "deny", label: "Deny" }],
            source: { word: request.word, to: request.to!, body_preview: detail } } });
        if (!started) { this.finish(pending, errors("failed", "gate case unavailable"), request.to!, false); return; }
        pending.phase = "gate_waiting";
        this.publish(started.ask);
        this.publish(started.event);
        this.activateGateAsk(started.ask);
        return;
        }
      }
      if (!this.durableGate && request.from !== "person:owner" && pending.phase === "accepted" && endpoint.spec.risk && endpoint.spec.risk !== "none") {
        if (!this.gate) { this.finish(pending, errors("failed", "gate unavailable"), request.to!, false); return; }
        if (!this.ledger.advanceRequest(request.id, "accepted", "gate_waiting")) return;
        pending.phase = "gate_waiting";
        this.gateEvent("gate.asked", { request_id: request.id, risk: endpoint.spec.risk });
        const decision = await this.gate(detached(request), detached(endpoint.spec), detached(pending.context), pending.controller.signal);
        if (pending.settled) return;
        const by = decision.allow ? (decision.by === "rule" ? "rule" : "answer") : (decision.by === "timeout" ? "timeout" : "answer");
        this.gateEvent(decision.allow ? "gate.passed" : "gate.denied", { request_id: request.id, by });
        if (!decision.allow) { this.finish(pending, errors("denied", decision.reason ?? "gate denied request"), request.to!, false); return; }
      }
      if (this.durableGate && pending.phase === "gate_waiting") {
        const caseState = this.ledger.gateCase(request.id);
        if (!caseState || caseState.decision !== "allowed") return;
        const identity = this.gateIdentity(pending);
        const currentAuthority = await this.currentlyAuthorized(request, pending.context);
        if (pending.settled) return;
        // No await between the final route/schema check, the SQLite CAS and handler dispatch.
        const currentValid = currentAuthority && this.endpoint(request.to!, request.word) === endpoint && endpoint.validateInput(request.body);
        if (!currentValid || !this.ledger.dispatchAllowedGate(request.id, identity.subject, identity.fingerprint)) {
          this.finish(pending, errors("forbidden", "approval no longer authorizes this action"), request.to!, false);
          return;
        }
        pending.phase = "dispatching";
      }
      if (pending.settled) return;
      if (this.durableGate && request.to?.startsWith("device:") &&
        !this.ledger.gateDeviceAccess(request.from, request.to, request.word)) {
        this.finish(pending, errors("forbidden", "device access changed before effect"), request.to, false); return;
      }
      if (pending.phase === "accepted" || pending.phase === "gate_waiting") {
        if (!this.ledger.advanceRequest(request.id, pending.phase, "dispatching")) return;
        pending.phase = "dispatching";
      }
      const result = await endpoint.handle(detached(request), { signal: pending.controller.signal, recovered, caller: Object.freeze(detached(pending.context)) });
      if (pending.settled) return; // a cancellation/timeout already published its sole terminal
      const committed = this.ledger.responseTo(request.id);
      if (committed) { this.adoptGateTerminal(pending, committed, false); this.publish(committed); return; }
      if (result === undefined) return;
      if (result.ok && endpoint.validateResult && !endpoint.validateResult(result.result)) { this.finish(pending, errors("failed", "handler returned invalid result"), request.to!, false); return; }
      this.finish(pending, result, request.to!, false);
    } catch {
      if (pending.settled) return;
      const committed = this.ledger.responseTo(request.id);
      if (committed) { this.adoptGateTerminal(pending, committed, false); this.publish(committed); return; }
      this.finish(pending, errors("failed", "handler or gate failed"), request.to!, false);
    }
  }

  cancel(ids: readonly string[]): Message[] {
    const settled: Message[] = [];
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (!pending || pending.settled) continue;
      if (this.durableGate) {
        const gateCase = pending.request.from === "service:gate" && pending.request.word === "ask"
          ? this.ledger.gateCaseByAsk(id) : this.ledger.gateCase(id);
        if (gateCase?.decision === "waiting") {
          const ask = this.pending.get(gateCase.askId);
          if (ask) {
            this.settleGateAsk(ask, "deny", "cancelled");
            const response = this.ledger.responseTo(id);
            if (response) settled.push(response);
            continue;
          }
          const outcome = this.ledger.settleGateAsk(gateCase.askId, "deny", "cancelled");
          if (outcome) {
            this.publish(outcome.askResponse);
            if (outcome.originalResponse) {
              const originalPending = this.pending.get(gateCase.requestId);
              if (originalPending) this.adoptGateTerminal(originalPending, outcome.originalResponse, true);
              this.publish(outcome.originalResponse);
              settled.push(id === gateCase.askId ? outcome.askResponse : outcome.originalResponse);
            }
            continue;
          }
        }
      }
      const response = this.finish(pending, errors("cancelled", "request cancelled; external effect may be unknown"), pending.request.to!, true);
      if (response) settled.push(response);
    }
    return settled;
  }

  /** Reconcile a trusted agent's durable turn cancellation before normal request recovery can replay it. */
  cancelTurn(actor: string, turn: string): Message[] {
    if (!/^agent:[A-Za-z0-9_-]+$/.test(actor) || !/^t_[A-Za-z0-9_-]+$/.test(turn)) throw new TypeError("invalid agent turn cancellation");
    const settled: Message[] = [];
    for (const tracked of this.ledger.trackedRequests().filter((item) => item.message.turn === turn && item.message.from === actor)) {
      const pending = this.pending.get(tracked.message.id);
      if (pending) settled.push(...this.cancel([tracked.message.id]));
      else {
        const gateCase = this.durableGate && tracked.phase === "gate_waiting" ? this.ledger.gateCase(tracked.message.id) : null;
        if (gateCase?.decision === "waiting") {
          const outcome = this.ledger.settleGateAsk(gateCase.askId, "deny", "cancelled");
          if (outcome) {
            this.publish(outcome.askResponse);
            if (outcome.event) this.publish(outcome.event);
            if (outcome.originalResponse) { this.publish(outcome.originalResponse); settled.push(outcome.originalResponse); }
          }
          continue;
        }
        const result = this.ledger.settle(tracked.message.id, tracked.message.to!, errors("cancelled", "request cancelled; external effect may be unknown"));
        if (result.settled) { this.publish(result.message); settled.push(result.message); }
      }
    }
    return settled;
  }

  /** Restricted work-run cancellation; never reuses the agent t_ turn authority. */
  cancelWorkTurn(run: string): Message[] {
    if (!/^r_[A-Za-z0-9_-]+$/.test(run)) throw new TypeError("invalid work turn cancellation");
    const settled: Message[] = [];
    for (const tracked of this.ledger.trackedRequests().filter((item) => item.message.turn === run && item.message.from === "service:work")) {
      const pending = this.pending.get(tracked.message.id);
      if (pending) settled.push(...this.cancel([tracked.message.id]));
      else {
        const result = this.ledger.settle(tracked.message.id, tracked.message.to!, errors("cancelled", "work run stopped; external effect may be unknown"));
        if (result.settled) { this.publish(result.message); settled.push(result.message); }
      }
    }
    return settled;
  }

  /** Call only after endpoint registration. Revalidate current grants/permissions; never replay uncertain effects. */
  async recover(): Promise<void> {
    for (const tracked of this.ledger.trackedRequests()) {
      const { message, phase, context, deadlineAt } = tracked;
      if (this.ledger.responseTo(message.id)) continue;
      if (this.pending.has(message.id)) continue;
      if (message.to === "service:dsh-tool" && message.from === "agent:main") {
        this.publish(this.ledger.settle(message.id, "service:dsh-tool", errors("failed", "DSH tool result unknown after restart")).message);
        continue;
      }
      if (message.from === "agent:main" && message.to === "service:gate" && message.word === "internal.approval") {
        const askId = this.ledger.gateCase(message.id)?.askId;
        const priorAskResponse = askId ? this.ledger.responseTo(askId) : null;
        const response = this.ledger.failInternalApproval(message.id);
        if (askId && !priorAskResponse) {
          const askResponse = this.ledger.responseTo(askId);
          if (askResponse) this.publish(askResponse);
        }
        if (response) this.publish(response);
        continue;
      }
      if (this.durableGate && message.from === "service:gate" && message.to === "person:owner" && message.word === "ask") {
        const gateCase = this.ledger.gateCaseByAsk(message.id);
        const original = gateCase && this.ledger.trackedRequests().find((item) => item.message.id === gateCase.requestId);
        if (!gateCase || gateCase.decision !== "waiting" || !original || original.phase !== "gate_waiting" ||
          this.ledger.responseTo(gateCase.requestId)) {
          this.publish(this.ledger.settle(message.id, "person:owner", errors("failed", "orphaned gate ask after restart")).message);
          continue;
        }
      }
      const endpoint = this.endpoint(message.to!, message.word);
      let contractValid = false;
      try { contractValid = Boolean(endpoint && endpoint.direction !== "out" && endpoint.spec.kind === "request" && endpoint.validateInput(message.body)); } catch { /* changed or invalid endpoint contract */ }
      if (!contractValid) {
        this.publish(this.ledger.settle(message.id, message.to!, errors("bad_request", "request no longer matches endpoint contract after restart")).message);
        continue;
      }
      if (this.durableGate && message.to?.startsWith("device:") &&
        !this.ledger.gateDeviceAccess(message.from, message.to, message.word)) {
        this.publish(this.ledger.settle(message.id, message.to, errors("forbidden", "device access unavailable after restart")).message);
        continue;
      }
      // Screen registrations are process-local. An old screenId plus a still-valid
      // owner token cannot prove a fresh, explicit resume confirmation after boot.
      if (message.to === "service:admin" && message.word === "resume") {
        this.publish(this.ledger.settle(message.id, message.to!, errors("forbidden", "resume needs a newly verified local screen confirmation")).message);
        continue;
      }
      if (message.to === "person:owner" && message.word === "say" && Object.hasOwn(message.body, "dedupe_key") &&
        (context.remote || !context.local || !((message.from === "agent:main" && context.member === "agent:main" && context.transportPrincipal === "agent:main") ||
          (message.from === "service:work" && context.member === "service:work" && context.transportPrincipal === "service:work")))) {
        this.publish(this.ledger.settle(message.id, message.to!, errors("forbidden", "proactive delivery key source is no longer authorized")).message);
        continue;
      }
      let authorized = false;
      try { authorized = Boolean(endpoint && await this.authorizeRecovery(detached(message), detached(context))); } catch { /* current permission cannot be verified */ }
      if (authorized && message.from === "service:reflex" && message.to === "service:admin" && message.word === "pause")
        authorized = context.member === "service:reflex" && context.local && !context.remote && context.transportPrincipal === "service:reflex" &&
          await this.reflexPauseSource(message.body.by);
      if (!endpoint || !authorized) {
        this.publish(this.ledger.settle(message.id, message.to!, errors("forbidden", "authorization unavailable after restart")).message);
        continue;
      }
      const pending = makePending(message, endpoint, context, deadlineAt, phase);
      this.pending.set(message.id, pending);
      if (this.durableGate && phase === "gate_waiting") {
        const gateCase = this.ledger.gateCase(message.id);
        if (!gateCase || !this.ledger.byId(gateCase.askId) || !["waiting", "allowed"].includes(gateCase.decision)) {
          this.finish(pending, errors("failed", "gate case missing or invalid after restart"), message.to!, false);
          continue;
        }
        if (Date.now() >= deadlineAt && gateCase.decision === "waiting") {
          this.expirePending(pending);
          continue;
        }
        if (Date.now() >= deadlineAt) { this.expirePending(pending); continue; }
        this.armTimeout(pending);
        if (gateCase.decision === "allowed") void this.dispatch(pending, true);
        continue;
      }
      if (Date.now() >= deadlineAt) { this.expirePending(pending); continue; }
      if (phase === "gate_waiting" || (phase === "dispatching" && !endpoint.idempotentRecovery)) {
        this.finish(pending, errors("failed", "outcome unknown after restart; request not replayed"), message.to!, false);
        continue;
      }
      this.armTimeout(pending);
      void this.dispatch(pending, true);
    }
  }

  /** An atomic-in-JS replay boundary for the edge SSE implementation; caller handles auth/filtering. */
  subscribeFrom(after: number, listener: Subscriber): () => void {
    let replaying = true;
    const buffered: number[] = [];
    const stop = this.subscribe((message) => { if (replaying) buffered.push(message.seq); else listener(message); });
    try {
      const watermark = this.ledger.lastSeq();
      let cursor = after;
      while (cursor < watermark) {
        const page = this.ledger.rawPage({ after: cursor, limit: 1 }).filter((message) => message.seq <= watermark);
        if (!page.length) break;
        const nextCursor = page.at(-1)!.seq;
        for (const message of page) listener(detached(message));
        cursor = nextCursor;
      }
      replaying = false;
      for (const seq of buffered.filter((item) => item > watermark).sort((a, b) => a - b)) {
        const message = this.ledger.bySeq(seq);
        if (message) listener(detached(message));
      }
    } catch (error) { stop(); throw error; }
    return stop;
  }

  /** Same replay boundary, but a summary client never materializes raw bodies. */
  subscribeSeqFrom(after: number, listener: (seq: number) => void): () => void {
    let replaying = true;
    const buffered: number[] = [];
    const stop = this.subscribe((message) => { if (replaying) buffered.push(message.seq); else listener(message.seq); });
    try {
      const watermark = this.ledger.lastSeq();
      let cursor = after;
      while (cursor < watermark) {
        const page = this.ledger.seqPage(cursor).filter((seq) => seq <= watermark);
        if (!page.length) break;
        for (const seq of page) listener(seq);
        cursor = page.at(-1)!;
      }
      replaying = false;
      for (const seq of buffered.filter((item) => item > watermark).sort((a, b) => a - b)) listener(seq);
    } catch (error) { stop(); throw error; }
    return stop;
  }
}
