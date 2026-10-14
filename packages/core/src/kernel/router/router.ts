/**
 * The router (HUB-MODULES §1.4, SPEC-01 §5): the one way a word reaches a member. `send` is seven fixed steps in a fixed
 * order; there is no branch that skips one.
 *
 *   1 validate   2 stamp   3 authorize   4 find the endpoint   5 gate   6 record   7 deliver
 *
 * Step 3 needs the word's contract, so the endpoint is looked up first; what that lookup finds (offline, no such word)
 * is answered in step 4, after authorization. Events go through 1 to 4 and 6, never the gate.
 */
import { randomBytes } from "node:crypto";
import { idKind, isMemberId, OWNER_ID } from "../../../../sdk/src/ids";
import { CALLER_VIAS, errorBody, WordError, type ErrorBody, type Outgoing, type Reply } from "../../../../sdk/src/message";
import { compileSchema, WORD_NAME_PATTERN, type Member, type WordContract } from "../../../../sdk/src/word";
import { DEFAULT_TTL_MINUTES, type GateStore, type PendingRecord } from "../gate";
import type { Ledger } from "../ledger";
import type { Caller, Gate, Message, Redact, Registry, Router, SendOptions, SendReply, Traffic } from "../types";
import { authorize, type AuthDeps } from "./authorize";
import { shouldRecord } from "./record";

export interface RouterDeps extends AuthDeps {
  ledger: Ledger;
  registry: Registry;
  gate: Gate;
  redact: Redact;
  /** The pending requests the gate keeps (kernel/gate/store). */
  store: GateStore;
  /** A request was parked for the owner; `service:gate` sends the card. */
  onParked(pending: PendingRecord): void;
  /**
   * How long an agent's call that needs the owner waits for their answer before it gets the usual receipt (ms; 0: not at all). When
   * the owner answers in that time, the call goes on in the same breath: it runs (or is refused) and its result is this call's result.
   */
  fastWaitMs?(): number;
  /** Something went wrong that the sender is not told about (a failed notification, an event nobody could take). */
  onError?(where: string, error: unknown): void;
  /** Sees every message once on the way in and once on the way out, recorded or not (health counts here). Must be quick. */
  tap?(traffic: Traffic): void;
  now?: () => number;
}

/** What `waiting_owner` looks like as a reply. */
export const waitingOwner = (pendingId: string, expiresAt: number): Reply => ({ ok: true, result: { data: { status: "waiting_owner", pending_id: pendingId, expires_at: expiresAt } } });

/**
 * What an agent's call may take in all, for the fast path of an approval: its tool call is given 60 s by the agent runtime and the tool
 * surface waits 50 s for a result (edges/tools: MAX_WAIT_MS); the wait for the owner ends well before that, with what the call took so far taken off.
 */
export const CALL_BUDGET_MS = 45_000;
const READ_TIMEOUT_MS = 60_000;
const OTHER_TIMEOUT_MS = 600_000;
const OUTGOING_KEYS = new Set(["to", "kind", "word", "body", "reply_to", "thread"]);

const fail = (error: ErrorBody): Reply => ({ ok: false, error });
const newId = () => `m_${randomBytes(9).toString("base64url")}`;

function validate(msg: Outgoing, caller: Caller): ErrorBody | null {
  if (!msg || typeof msg !== "object") return errorBody("bad_request", "the message must be an object");
  const extra = Object.keys(msg).filter((k) => !OUTGOING_KEYS.has(k));
  if (extra.length) return errorBody("bad_request", `unknown keys: ${extra.join(", ")}`);
  if (msg.kind !== "request" && msg.kind !== "event") return errorBody("bad_request", "kind must be request or event");
  if (typeof msg.word !== "string" || !WORD_NAME_PATTERN.test(msg.word)) return errorBody("bad_request", "word must be lower-case dotted segments");
  if (msg.to === null ? msg.kind === "request" : !isMemberId(msg.to)) return errorBody("bad_request", msg.to === null ? "a request needs a recipient" : `to is not a member id: ${String(msg.to)}`);
  for (const key of ["reply_to", "thread"] as const) if (msg[key] !== undefined && (typeof msg[key] !== "string" || !msg[key])) return errorBody("bad_request", `${key} must be a non-empty string`);

  if (!caller || typeof caller !== "object" || !(CALLER_VIAS as readonly string[]).includes(caller.via) || typeof caller.local !== "boolean") return errorBody("unauthorized", "the caller is not valid");
  const kind = idKind(caller.member);
  const wanted = { human: "person", agent: "agent", hand: "device", app: "app", service: "service" }[caller.via];
  // The human edge acts as the owner without a channel (the owner's events, reading the widget state): the hub's own code, not the owner speaking.
  const asOwnerService = caller.via === "service" && caller.member === OWNER_ID;
  if (kind !== wanted && !asOwnerService) return errorBody("unauthorized", `${String(caller.member)} cannot call as ${caller.via}`);
  return null;
}

const validators = new WeakMap<object, ReturnType<typeof compileSchema>>();
function checkInput(contract: WordContract, body: unknown): ErrorBody | null {
  let check = validators.get(contract);
  if (!check) {
    try { check = compileSchema(contract.input_schema); } catch (error) { return errorBody("internal", `the schema of ${contract.member}/${contract.word} does not compile: ${(error as Error).message}`); }
    validators.set(contract, check);
  }
  if (check(body)) return null;
  const problems = (check.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
  return errorBody("bad_request", `the input does not match ${contract.member}/${contract.word}: ${problems}`, { detail: check.errors });
}

function toError(error: unknown): ErrorBody {
  if (error instanceof WordError) return errorBody(error.code, error.message, { detail: error.detail, recovery_hint: error.recovery_hint });
  return errorBody("internal", "the hub failed while handling this request");
}

/** What the lookup of step 3 and 4 found. `declared`: for an event, the sender's own words include it. */
interface Located { member: Member | null; contract: WordContract | null; problem: ErrorBody | null; declared: boolean }

export class HubRouter implements Router {
  private readonly now: () => number;
  private readonly subscribers = new Set<{ filter: Parameters<Router["subscribe"]>[0]; cb: (m: Message) => void }>();
  /** Ids of the requests being handled now, so an id a caller picked cannot be used twice, recorded or not. */
  private readonly inflight = new Set<string>();
  /** The requests handed to a member and not answered yet, so one can be cancelled from outside (a lease ending cancels the screen requests on the way). */
  private readonly delivering = new Map<string, { from: string; to: string | null; word: string; caller: Caller; cancel(): void }>();

  constructor(private readonly deps: RouterDeps) {
    this.now = deps.now ?? Date.now;
    deps.store.onClosed = (response) => this.publish(response);
  }

  send(msg: Outgoing, caller: Caller, opts: SendOptions = {}): Promise<SendReply> { return this.run(msg, caller, opts, null); }

  /** The internal door of `service:gate/pending.redeem`: run the stored request again, approved, once, and before its question would have expired. */
  async redeem(pendingId: string, redeemer: Caller, opts: SendOptions = {}): Promise<SendReply> {
    const { store } = this.deps;
    const pending = store.getPending(pendingId);
    if (!pending) return fail(errorBody("not_found", "no such pending request"));
    if (pending.state !== "approved") return fail(errorBody("conflict", pending.state === "redeemed" ? "this approval was already used" : pending.state === "expired" ? "this approval ran out; make the request again" : `this request is ${pending.state}, not approved`));
    const msg: Outgoing = { to: pending.to, kind: "request", word: pending.word, body: pending.body, ...(pending.thread ? { thread: pending.thread } : {}) };
    return this.run(msg, { ...pending.caller, turn: redeemer.turn }, opts, pending);
  }

  /** Cancels the requests being handled now that [match] picks (the caller sees `cancelled`); how many. */
  cancelWhere(match: (r: { id: string; from: string; to: string | null; word: string; caller: Caller }) => boolean): number {
    let n = 0;
    for (const [id, r] of [...this.delivering]) if (match({ id, from: r.from, to: r.to, word: r.word, caller: r.caller })) { r.cancel(); n++; }
    return n;
  }

  subscribe(filter: Parameters<Router["subscribe"]>[0], cb: (m: Message) => void): () => void {
    const entry = { filter, cb };
    this.subscribers.add(entry);
    return () => { this.subscribers.delete(entry); };
  }

  recover(): void {
    const { ledger } = this.deps;
    for (const r of ledger.unfinished()) {
      // A request this process is handling now is not one the last process left behind (the hub may take calls while it starts).
      if (r.state !== "dispatched" || this.inflight.has(r.id)) continue;
      ledger.setRequest(r.id, "interrupted");
      const error = errorBody("result_unknown", "大脑重启，结果不确定，请先查再决定要不要重做");
      ledger.append({ from: r.to, to: r.from, kind: "response", word: r.word, body: { ok: false, error }, reply_to: r.id });
      // Nobody is messaged: an agent's calls come through the tool surface, which tells it by itself (a `wake` with the request_id for
      // a receipt it gave, SPEC-02 §3.4), and a turn the restart cut off is told by the agents module.
    }
  }

  // -------------------------------------------------------------------------------------------------------------

  private locate(msg: Message): Located {
    const { registry } = this.deps;
    if (msg.kind === "request") {
      if (!registry.describe(msg.to!)) return { member: null, contract: null, problem: errorBody("offline", `${msg.to} is not connected`), declared: true };
      const found = registry.find(msg.to!, msg.word);
      if (!found) return { member: null, contract: null, problem: errorBody("not_found", `${msg.to} has no word ${msg.word}`), declared: true };
      if (found.contract.kind !== "request") return { member: found.member, contract: found.contract, problem: errorBody("bad_request", `${msg.word} is an event, not a request`), declared: true };
      return { member: found.member, contract: found.contract, problem: null, declared: true };
    }
    // An event is described by what its sender declares, else by what the member it goes to declares.
    const sender = registry.find(msg.from, msg.word);
    const member = msg.to === null ? null : registry.get(msg.to);
    if (msg.to !== null && !member) return { member: null, contract: null, problem: errorBody("offline", `${msg.to} is not connected`), declared: sender !== null };
    const contract = sender?.contract ?? (member ? registry.find(member.id, msg.word)?.contract : null) ?? null;
    if (!contract) return { member, contract: null, problem: errorBody("not_found", `no member declares the event ${msg.word}`), declared: false };
    if (contract.kind !== "event") return { member, contract, problem: errorBody("bad_request", `${msg.word} is a request, not an event`), declared: sender !== null };
    return { member, contract, problem: null, declared: sender !== null };
  }

  private async run(out: Outgoing, caller: Caller, opts: SendOptions, resume: PendingRecord | null): Promise<SendReply> {
    // 1. validate
    const bad = validate(out, caller);
    if (bad) return fail(bad);

    // 2. stamp: the sender and the origin come from the caller, never from the message
    const raw = out.body === undefined ? {} : out.body;
    // The caller may choose the id (the human edge needs it before the reply); an id that is in use is a conflict.
    const id = resume ? resume.id : opts.id ?? newId();
    if (!resume && opts.id !== undefined) {
      if (typeof opts.id !== "string" || !opts.id) return fail(errorBody("bad_request", "the id must be a non-empty string"));
      if (this.inflight.has(id) || this.deps.ledger.get(id) !== null) return fail(errorBody("conflict", `the id ${id} is already used`));
    }
    const stamped: Message = {
      seq: 0, id, ts: resume ? resume.created_at : this.now(), from: caller.member, to: out.to, kind: out.kind, word: out.word, body: raw,
      ...(out.reply_to ? { reply_to: out.reply_to } : {}), ...(out.thread ? { thread: out.thread } : {}), ...(caller.turn ? { turn: caller.turn } : {}),
      ...(caller.origin ? { origin: caller.origin } : {}),
    };
    this.inflight.add(id);
    const seen = { kind: stamped.kind, from: stamped.from, to: stamped.to, word: stamped.word, via: caller.via };
    this.tap({ ...seen, phase: "in" });
    try {
      const reply: SendReply = await this.proceed(stamped, raw, caller, opts, resume);
      reply.id = stamped.id;
      this.tap({ ...seen, phase: "out", ...(reply.ok ? {} : { error: reply.error.code }) });
      return reply;
    } finally { this.inflight.delete(id); }
  }

  private async proceed(stamped: Message, raw: unknown, caller: Caller, opts: SendOptions, resume: PendingRecord | null): Promise<SendReply> {
    const { ledger, gate, redact, store } = this.deps;

    // 3. authorize
    const located = this.locate(stamped);
    const refused = authorize(stamped, located.contract, caller, this.deps, located.declared);
    if (refused) return fail(refused);

    // 4. find the endpoint; check the input; let the member refuse first
    if (located.problem || !located.contract) return fail(located.problem!);
    const contract = located.contract;
    const invalid = checkInput(contract, raw);
    if (invalid) return fail(invalid);
    // The gate, the ledger and the handler's message see the body with secrets masked; only `ctx.raw` has them.
    const view = redact.forLedger(stamped, contract);
    const early = located.member?.precheck?.(view);
    if (early) return early;

    if (stamped.kind === "event") return this.deliverEvent(stamped, view, contract, caller, located.member);
    const member = located.member!;

    // 5. the gate
    if (resume) {
      if (!store.setState(resume.id, ["approved"], "redeemed")) return fail(errorBody("conflict", "this approval was already used"));
      store.amend(resume.id, { executed: this.now() });
    } else {
      const decision = await gate.decide(view, contract, caller);
      if (decision.verdict === "deny") {
        return fail(caller.via === "app" ? errorBody("forbidden", decision.reason ?? "an app cannot do this", { recovery_hint: "An app cannot ask the owner. Leave it to an agent or the owner." })
          : errorBody("denied", decision.reason ?? "the gate refused"));
      }
      if (decision.verdict === "ask") return this.holdForOwner(this.park(stamped, view, raw, contract, caller, decision.offer_always, opts, member, decision.review_reason), stamped, caller, opts);
    }

    // 6. record: a request that was parked is in the ledger already and only goes on
    const timeout = contract.timeout_ms ?? (contract.effect === "read" ? READ_TIMEOUT_MS : OTHER_TIMEOUT_MS);
    const record = resume !== null || shouldRecord(stamped, contract, caller);
    try {
      if (resume) ledger.setRequest(stamped.id, "dispatched");
      else if (record) this.publish({ ...view, seq: ledger.append(view, { request: { state: "dispatched", deadline: stamped.ts + timeout } }).seq });
      else this.publish(view);
    } catch (error) { this.deps.onError?.("record", error); return fail(errorBody("internal", "the request could not be recorded")); }

    // 7. deliver
    const reply = await this.deliver(view, member, caller, raw, timeout, opts.signal);
    const shown: SendReply = this.forCaller(reply, contract, caller);
    if (record) {
      try {
        const response = redact.forLedger({ seq: 0, id: newId(), ts: this.now(), from: stamped.to!, to: stamped.from, kind: "response", word: stamped.word, body: reply, reply_to: stamped.id, ...(stamped.thread ? { thread: stamped.thread } : {}) }, contract);
        const done = ledger.append(response);
        ledger.setRequest(stamped.id, "done");
        this.publish({ ...response, seq: done.seq });
        shown.ref = done.id;
      } catch (error) { this.deps.onError?.("record", error); }
    }
    return shown;
  }

  /**
   * The fast path: an agent's call that was parked waits here for the owner's answer for a few seconds. Answered in time, it goes on at once:
   * approved, it is carried out and its result is the result of this call (no pending id, no message to the agent); refused, it is refused
   * with the reason. Not answered in time, the agent gets the receipt as before and the answer comes later, in the conversation. One of the
   * two happens, whichever is first (the store's `hold`).
   */
  private async holdForOwner(parked: Reply, stamped: Message, caller: Caller, opts: SendOptions): Promise<SendReply> {
    const data = parked.ok ? parked.result?.data as { status?: unknown; expires_at?: unknown } | undefined : undefined;
    const wait = this.deps.fastWaitMs?.() ?? 0;
    if (caller.via !== "agent" || data?.status !== "waiting_owner" || typeof data.expires_at !== "number" || !(wait > 0)) return parked;
    const ms = Math.min(wait, CALL_BUDGET_MS - (this.now() - stamped.ts), data.expires_at - this.now());
    if (!(ms > 0)) return parked;
    opts.waiting?.(this.now() + ms);
    switch (await this.deps.store.hold(stamped.id, ms, opts.signal)) {
      case "approved": return this.redeem(stamped.id, caller, opts);
      case "denied": return fail(errorBody("denied", "the owner refused this request", { recovery_hint: "Do not repeat it as it is. Tell the owner what you could not do, or offer a way that does not need this." }));
      case "timeout": return parked;
      case "cancelled": return fail(errorBody("cancelled", "the request was cancelled"));
      default: return fail(errorBody("timeout", "the question to the owner ended before they answered, which counts as a refusal"));
    }
  }

  private park(stamped: Message, view: Message, raw: unknown, contract: WordContract, caller: Caller, offerAlways: boolean, opts: SendOptions, member: Member, reviewReason?: string): Reply {
    // A secret is never written down, so a request that carries one cannot wait for the owner.
    if (JSON.stringify(view.body) !== JSON.stringify(raw)) return fail(errorBody("forbidden", "a request that carries a secret cannot wait for the owner's approval", { recovery_hint: "The owner can do this directly; an agent cannot." }));
    const ttl = Math.min(Math.max(Math.trunc(opts.approval?.ttl_minutes ?? DEFAULT_TTL_MINUTES) || DEFAULT_TTL_MINUTES, 1), 10_080);
    const expires = stamped.ts + ttl * 60_000;
    // The member may say more about what this request will do (an app install: the permissions it takes); the card carries it.
    let detail: string | null = null;
    try { detail = member.cardDetail?.(view) ?? null; } catch (error) { this.deps.onError?.("cardDetail", error); }
    try {
      const pending = this.deps.ledger.tx(() => {
        const recorded = this.deps.ledger.append(view, { request: { state: "waiting_owner", deadline: expires } });
        this.publish({ ...view, seq: recorded.seq });
        return this.deps.store.park({
          id: stamped.id, originator: caller.member, caller, to: stamped.to!, word: stamped.word, body: view.body, effect: contract.effect, risk: contract.risk,
          ...(stamped.thread ? { thread: stamped.thread } : {}), label: contract.label.doing, expires_at: expires, offer_always: offerAlways,
          ...(opts.approval?.purpose ? { purpose: opts.approval.purpose } : {}), ...(detail ? { detail } : {}),
          ...(reviewReason ? { review_reason: reviewReason } : {}),
        });
      });
      queueMicrotask(() => { try { this.deps.onParked(pending); } catch (error) { this.deps.onError?.("onParked", error); } });
    } catch (error) { this.deps.onError?.("park", error); return fail(errorBody("internal", "the request could not be parked")); }
    return waitingOwner(stamped.id, expires);
  }

  private deliver(msg: Message, member: Member, caller: Caller, raw: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (reply: Reply) => {
        if (settled) return;
        settled = true;
        this.delivering.delete(msg.id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(reply);
      };
      const stop = (reply: Reply) => {
        if (settled) return;
        controller.abort();
        try { member.cancel?.(msg.id); } catch (error) { this.deps.onError?.("cancel", error); }
        finish(reply);
      };
      const onAbort = () => stop(fail(errorBody("cancelled", "the request was cancelled")));
      const timer = setTimeout(() => stop(fail(errorBody("timeout", `no result within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.delivering.set(msg.id, { from: msg.from, to: msg.to, word: msg.word, caller, cancel: onAbort });
      Promise.resolve().then(() => member.handle(msg, { signal: controller.signal, caller, raw })).then(
        (result) => finish(result ? { ok: true, result } : { ok: true }),
        (error) => { if (!(error instanceof WordError)) this.deps.onError?.("handle", error); finish(fail(toError(error))); },
      );
    });
  }

  /** The reply the caller gets: sensitive fields masked for everyone but the owner. */
  private forCaller(reply: Reply, contract: WordContract, caller: Caller): Reply {
    if (!reply.ok || reply.result?.data === undefined) return reply;
    const data = this.deps.redact.forCaller(reply.result.data, contract, caller);
    return data === reply.result.data ? reply : { ok: true, result: { ...reply.result, data } };
  }

  /** Events: to the member named (if it is here), and to every member that listens; nobody waits for the answer. */
  private deliverEvent(stamped: Message, view: Message, contract: WordContract, caller: Caller, named: Member | null): Reply {
    let recorded = view;
    if (shouldRecord(stamped, contract, caller)) {
      try { recorded = { ...view, seq: this.deps.ledger.append(view).seq }; } catch (error) { this.deps.onError?.("record", error); return fail(errorBody("internal", "the event could not be recorded")); }
    }
    this.publish(recorded);
    const targets = new Map<string, Member>();
    if (named) targets.set(named.id, named);
    for (const m of this.deps.registry.listeners(stamped.word)) targets.set(m.id, m);
    targets.delete(stamped.from);
    for (const m of targets.values()) {
      const controller = new AbortController();
      Promise.resolve().then(() => m.handle(recorded, { signal: controller.signal, caller, raw: stamped.body })).catch((e) => this.deps.onError?.(`event ${stamped.word} to ${m.id}`, e));
    }
    return { ok: true };
  }

  private tap(traffic: Traffic): void {
    try { this.deps.tap?.(traffic); } catch (error) { this.deps.onError?.("tap", error); }
  }

  private publish(m: Message): void {
    for (const { filter, cb } of this.subscribers) {
      if (filter.to !== undefined && m.to !== filter.to) continue;
      if (filter.from !== undefined && m.from !== filter.from) continue;
      if (filter.involving !== undefined && m.from !== filter.involving && m.to !== filter.involving) continue;
      if (filter.word !== undefined && m.word !== filter.word) continue;
      try { cb(m); } catch (error) { this.deps.onError?.("subscriber", error); }
    }
  }
}

export function createRouter(deps: RouterDeps): HubRouter { return new HubRouter(deps); }
