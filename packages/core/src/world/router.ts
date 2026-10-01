import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { AuthenticatedCallerContext, JsonSchema, Message, MessageErrorCode, ResponseBody, SendRequestV2, WordSpec } from "../../../sdk/src/api";
import { matchesSchema, schemaErrors } from "../../../sdk/src/schema";
import { deviceWordSpec, wordContract } from "../../../sdk/src/words";
import { Ledger, type RequestContextSnapshot, type RequestPhase, type TrackedRequest } from "./ledger";

type Transport = "web_ui" | "api" | "phone" | "agent" | "device" | "service";
/** Constructed only after edge authentication and (for web_ui) screen-token verification. */
export interface TrustedRouteContext extends AuthenticatedCallerContext {
  transport: Transport;
  screenLabel?: string;
  turn?: string;
}
export interface RouteHandlerContext { signal: AbortSignal; recovered: boolean }
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

  constructor(readonly ledger: Ledger, private readonly authorizeRecovery: RecoveryAuthorizer) {}

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
  subscribe(listener: Subscriber): () => void { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }
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
      if ((request.to === "agent:main" && request.word === "typing") || (request.to === "service:post" && request.word === "visible")) return { from: screen, origin: { screen, label: ctx.screenLabel! } };
      return { from: "person:owner", origin: { screen, label: ctx.screenLabel! } };
    }
    if (ctx.transport === "phone") {
      if ((request.kind === "request" && request.to === "agent:main" && request.word === "say") || (request.kind === "response" && request.word === "ask")) {
        if (!ctx.ownerProxy) fail("forbidden", "notification proxy not authorized");
        return { from: "person:owner", origin: { screen: "device:phone", label: "Phone notification" } };
      }
      if (request.kind !== "event" || !request.word.startsWith("sense.")) fail("forbidden", "phone may only send senses or notification replies");
    }
    return { from: ctx.member };
  }

  private authorize(ctx: TrustedRouteContext, request: SendRequestV2, from: string): void {
    if (request.to === "service:admin" && (ctx.remote || !ctx.local || from !== "person:owner")) fail("forbidden", "administration requires local owner");
    if (request.to === "service:self" && LOCAL_SELF_MUTATIONS.has(request.word)) {
      const workFlowWrite = ctx.transport === "service" && from === "service:work" && (request.word === "append" || request.word === "apply_plan");
      if (ctx.remote || !ctx.local || !(from === "person:owner" || from === "agent:main" || workFlowWrite)) fail("forbidden", "managed writes require local authority");
    }
    if (request.to === "service:work" && request.word === "run" && from !== "person:owner") fail("forbidden", "only owner may start a background run");
    if (request.to === "service:gate" && request.word === "rules.revoke" && (ctx.remote || !ctx.local || from !== "person:owner")) fail("forbidden", "rule revocation requires local owner");
    if (request.to === "agent:main" && request.word === "cancel_turn" && !["service:reflex", "service:admin"].includes(from)) fail("forbidden", "cancel_turn is internal only");
    if (request.to === "agent:main" && request.word === "wake" && !["service:clock", "service:senses", "service:work"].includes(from)) fail("forbidden", "wake is internal only");
    if ((request.word === "typing" || request.word === "visible") && (ctx.transport !== "web_ui" || !from.startsWith("screen:"))) fail("forbidden", "presence requires registered screen");
    if (request.to === "service:post" && request.word === "deliver" && ctx.transport !== "service") fail("forbidden", "delivery is internal only");
    if (request.to === "service:senses" && request.word.startsWith("sense.") && (ctx.transport !== "phone" || from !== "device:phone")) fail("forbidden", "senses require phone identity");
    if (ctx.transport === "web_ui" && request.kind === "event" && !["typing", "visible"].includes(request.word)) fail("forbidden", "screen cannot emit internal events");
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
    this.authorize(ctx, request, from);
    if (request.kind === "response") return this.acceptResponse(request, from, ctx, origin, signal);
    if (request.to === null && request.kind !== "event") fail("bad_request", "request needs recipient");
    const endpoint = request.to ? this.endpoint(request.to, request.word) : undefined;
    const outbound = request.kind === "event" ? wordContract(from, request.word) : undefined;
    const sourceEvent = outbound?.kind === "event" && outbound.direction === "out";
    const senseContract = request.kind === "event" && ctx.transport === "phone" && from === "device:phone" && request.to === null ? wordContract("service:senses", request.word) : undefined;
    const phoneSense = senseContract?.kind === "event" && senseContract.direction === "in" && request.word.startsWith("sense.");
    if (request.to && !endpoint && !sourceEvent) fail("not_found", "recipient word not found");
    if (endpoint && (endpoint.direction === "out" || endpoint.spec.kind !== request.kind)) fail("forbidden", "word cannot be sent in this direction");
    if (endpoint && !endpoint.validateInput(request.body)) fail("bad_request", "body does not match word schema");
    if (request.kind === "event" && !endpoint && !sourceEvent && !phoneSense) fail("not_found", "event word not found");
    if (sourceEvent && !matchesSchema(outbound.input_schema!, request.body)) fail("bad_request", "event body does not match schema");
    if (phoneSense && !matchesSchema(senseContract.input_schema!, request.body)) fail("bad_request", "sense body does not match schema");
    if (request.to === null && !sourceEvent && !phoneSense) fail("forbidden", "broadcast not authorized");
    if (sourceEvent && request.to !== null && request.to !== "person:owner") fail("forbidden", "outbound event target is not allowed");
    if (sourceEvent && from === "service:post" && request.word === "post.changed" && request.to !== "person:owner") fail("forbidden", "post snapshot is owner-targeted");
    const timeoutMs = endpoint?.spec.timeout_ms ?? 60_000;
    if (request.kind === "request" && request.to === "person:owner" && request.word === "ask" && askExpiry(request) === null) fail("bad_request", "ask requires a finite expiry");
    const deadlineAt = Math.min(Date.now() + timeoutMs, request.kind === "request" ? askExpiry(request) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
    const input = { from, to: request.to, kind: request.kind, word: request.word, body: request.body, ...(origin ? { origin } : {}), ...(ctx.turn ? { turn: ctx.turn } : {}) };
    let accepted: ReturnType<Ledger["append"]>;
    if (signal?.aborted) fail("cancelled", "send aborted before acceptance");
    try { accepted = this.ledger.append(input, request.client_id ? { transportPrincipal: ctx.transportPrincipal, clientId: request.client_id } : undefined,
      request.kind === "request" ? { deadlineAt, context: contextSnapshot(ctx) } : undefined); }
    catch (error) { if (error instanceof TypeError) fail("bad_request", error.message); throw error; }
    const message = accepted.message;
    if (accepted.duplicate) {
      const reply = this.ledger.responseTo(message.id) ?? (request.wait ? await this.pending.get(message.id)?.reply : undefined);
      return { id: message.id, seq: message.seq, ...(reply ? { reply } : {}) };
    }
    this.publish(message);
    if (request.kind === "event") {
      if (endpoint) void Promise.resolve(endpoint.handle(detached(message), { signal: new AbortController().signal, recovered: false })).catch(() => {});
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
    if (Date.now() >= pending.deadlineAt) this.finish(pending, this.deadlineBody(pending), message.to!, true);
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
      this.finish(pending, this.deadlineBody(pending), original.to!, true);
      throw new RouterError("bad_request", "request expired before reply");
    }
    if (original.to === "person:owner" && original.word === "ask") {
      const choice = body.ok && plainObject(body.result) ? body.result.choice : undefined;
      const options = original.body.options;
      if (typeof choice !== "string" || !Array.isArray(options) || !options.some((option) => plainObject(option) && option.id === choice)) fail("bad_request", "ask choice was not offered");
    }
    if (signal?.aborted) fail("cancelled", "send aborted before settlement");
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
      this.finish(pending, this.deadlineBody(pending), pending.request.to!, true);
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

  private async dispatch(pending: Pending, recovered: boolean): Promise<void> {
    const { request, endpoint } = pending;
    if (pending.settled) return;
    try {
      if (pending.phase === "accepted" && endpoint.spec.risk && endpoint.spec.risk !== "none") {
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
      if (pending.settled) return;
      if (pending.phase === "accepted" || pending.phase === "gate_waiting") {
        if (!this.ledger.advanceRequest(request.id, pending.phase, "dispatching")) return;
        pending.phase = "dispatching";
      }
      const result = await endpoint.handle(detached(request), { signal: pending.controller.signal, recovered });
      if (pending.settled || result === undefined) return;
      if (result.ok && endpoint.validateResult && !endpoint.validateResult(result.result)) { this.finish(pending, errors("failed", "handler returned invalid result"), request.to!, false); return; }
      this.finish(pending, result, request.to!, false);
    } catch {
      if (pending.settled) return;
      this.finish(pending, errors("failed", "handler or gate failed"), request.to!, false);
    }
  }

  cancel(ids: readonly string[]): Message[] {
    const settled: Message[] = [];
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (!pending || pending.settled) continue;
      const response = this.finish(pending, errors("cancelled", "request cancelled; external effect may be unknown"), pending.request.to!, true);
      if (response) settled.push(response);
    }
    return settled;
  }

  /** Call only after endpoint registration. Revalidate current grants/permissions; never replay uncertain effects. */
  async recover(): Promise<void> {
    for (const tracked of this.ledger.trackedRequests()) {
      const { message, phase, context, deadlineAt } = tracked;
      if (this.pending.has(message.id)) continue;
      const endpoint = this.endpoint(message.to!, message.word);
      let contractValid = false;
      try { contractValid = Boolean(endpoint && endpoint.direction !== "out" && endpoint.spec.kind === "request" && endpoint.validateInput(message.body)); } catch { /* changed or invalid endpoint contract */ }
      if (!contractValid) {
        this.publish(this.ledger.settle(message.id, message.to!, errors("bad_request", "request no longer matches endpoint contract after restart")).message);
        continue;
      }
      let authorized = false;
      try { authorized = Boolean(endpoint && await this.authorizeRecovery(detached(message), detached(context))); } catch { /* current permission cannot be verified */ }
      if (!endpoint || !authorized) {
        this.publish(this.ledger.settle(message.id, message.to!, errors("forbidden", "authorization unavailable after restart")).message);
        continue;
      }
      const pending = makePending(message, endpoint, context, deadlineAt, phase);
      this.pending.set(message.id, pending);
      if (Date.now() >= deadlineAt) { this.finish(pending, this.deadlineBody(pending), message.to!, true); continue; }
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
    const buffered: Message[] = [];
    const stop = this.subscribe((message) => { if (replaying) buffered.push(message); else listener(message); });
    try {
      const watermark = this.ledger.lastSeq();
      let cursor = after;
      while (cursor < watermark) {
        const page = this.ledger.list({ after: cursor, limit: 1000 }).filter((message) => message.seq <= watermark);
        if (!page.length) break;
        const nextCursor = page.at(-1)!.seq;
        for (const message of page) listener(detached(message));
        cursor = nextCursor;
      }
      replaying = false;
      for (const message of buffered.filter((item) => item.seq > watermark).sort((a, b) => a.seq - b.seq)) listener(detached(message));
    } catch (error) { stop(); throw error; }
    return stop;
  }
}
