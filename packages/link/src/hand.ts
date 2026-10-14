import {
  CLOSE_CODES, LINK_PROTOCOL, LIMITS, NO_RECONNECT_CODES,
  type AgentFrame, type AssessedFrame, type CallFrame, type CapabilitySpec, type ContentPart, type ErrorBody, type HandKind,
  type HelloChannels, type ManifestAckFrame, type ManifestFrame, type PresentFrame, type PresenceFrame, type ResultFrame,
  type SendRequest, type SendResultFrame, type SyncFrame, type SyncMsgFrame, type SyncPageFrame, type WelcomeFrame, type LinkChannel,
} from "../../sdk/src/link";
import { systemClock, type Clock } from "./clock";
import { newId } from "./codec";
import { FrameConn } from "./conn";
import type { RawSocket } from "./socket";
import { StreamReceiver, sendStream, type ReceivedStream, type StreamSendOptions } from "./stream";

// --- the WebSocket underneath (Node: `ws`; browser: the global WebSocket) -------------------------------------------------

export interface SocketEvents {
  open(): void;
  message(data: unknown, isBinary?: boolean): void;
  close(code: number, reason: string): void;
}
/** Opens one WebSocket. [headers] is empty or ignored where the platform cannot set request headers (browsers). */
export type Connector = (url: string, headers: Record<string, string>, events: SocketEvents) => RawSocket;

// --- events that survive a restart -----------------------------------------------------------------------------------------

export interface QueuedEvent { id: string; word: string; body: Record<string, unknown>; at: number }
/**
 * Events are queued before they are sent and removed only when the kernel acks them, so what was never acked is sent
 * again, with the same id, after a reconnect. An app keeps the queue on disk; [MemoryEventQueue] is for tests.
 */
export interface EventQueue {
  add(event: QueuedEvent): void | Promise<void>;
  remove(id: string): void | Promise<void>;
  /** Everything not yet acked, oldest first. */
  pending(): QueuedEvent[] | Promise<QueuedEvent[]>;
}
export class MemoryEventQueue implements EventQueue {
  private readonly events = new Map<string, QueuedEvent>();
  add(event: QueuedEvent): void { this.events.set(event.id, event); }
  remove(id: string): void { this.events.delete(id); }
  pending(): QueuedEvent[] { return [...this.events.values()]; }
}

// --- reconnecting ---------------------------------------------------------------------------------------------------------

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/** The wait before reconnect attempt number [attempt] (0 is the first): 1, 2, 4, 8, 16, 30 s, then 30 s, each ±20%. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  return Math.round(base * (1 + (random() * 2 - 1) * 0.2));
}

// --- the client -----------------------------------------------------------------------------------------------------------

export type CallOutcome = { ok: true; content: ContentPart[]; data?: unknown } | { ok: false; error: ErrorBody };
export type PresentOutcome = { ok: true; data?: unknown } | { ok: false; error: ErrorBody };

export interface HandHandlers {
  /** The kernel calls a capability. Resolve with the outcome; throwing becomes `failed`. [signal] aborts on `cancel` or when the connection drops. */
  call?(call: CallFrame, ctx: { signal: AbortSignal; progress(text: string): void }): Promise<CallOutcome>;
  /** The kernel asks the risk of one call. */
  assess?(capability: string, args: Record<string, unknown>): Promise<Pick<AssessedFrame, "risk" | "why">>;
  /** The kernel presents something on this hand's human channel. */
  present?(frame: PresentFrame): Promise<PresentOutcome>;
  agent?(frame: AgentFrame): void;
  stream?(stream: ReceivedStream): void;
  /** Connected and welcomed (also after every reconnect). */
  welcome?(welcome: WelcomeFrame): void;
  /** The connection ended. [willReconnect] is false for 4003, 4008, 4009 and after `stop()`. */
  closed?(info: { code: number; reason: string; willReconnect: boolean }): void;
  log?(message: string, error?: unknown): void;
}

export interface HandOptions {
  /** Where to connect; a function is asked again on every attempt (the port can change when the host re-attaches). */
  url: string | (() => string | Promise<string>);
  /** Request headers per attempt, e.g. `Authorization: Bearer …` for a local connection. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  hand: { kind: HandKind; name: string; version: string; platform: string; public_key?: string };
  channels: HelloChannels;
  /** Signs the challenge nonce (ECDSA P-256, base64url). Needed when `hand.public_key` is set. */
  sign?(nonce: string): string | Promise<string>;
  connector: Connector;
  handlers?: HandHandlers;
  eventQueue?: EventQueue;
  clock?: Clock;
  random?: () => number;
}

type State = "idle" | "connecting" | "ready" | "waiting" | "stopped";

interface Waiter<T> { resolve(value: T): void; reject(error: unknown): void }
export class HandLinkError extends Error {
  constructor(readonly kind: "closed" | "channel", message: string) { super(message); }
}

/**
 * A hand's side of `ash-link/2`: connects, answers the challenge, keeps the connection (reconnecting with backoff),
 * serves the kernel's calls, and keeps the manifest and unacked events across reconnects.
 */
export class HandClient {
  private stateValue: State = "idle";
  private conn: FrameConn | null = null;
  private welcomeFrame: WelcomeFrame | null = null;
  private stopCode: number | null = null;
  private failures = 0;
  private retry: unknown;
  private reconnecting = false;
  private manifest: Omit<ManifestFrame, "rev"> & { rev: number } | null = null;
  private manifestRev = 0;
  private readonly manifestWaiters = new Map<number, Waiter<ManifestAckFrame>[]>();
  private readonly requests = new Map<string, Waiter<SendResultFrame>>();
  private readonly syncs = new Map<string, { page(frame: SyncPageFrame): void; message(frame: SyncMsgFrame): void }>();
  private readonly running = new Map<string, AbortController>();
  private readyWaiters: Waiter<WelcomeFrame>[] = [];
  private readonly queue: EventQueue;
  private readonly clock: Clock;
  private readonly streams: StreamReceiver;

  constructor(private readonly o: HandOptions) {
    this.queue = o.eventQueue ?? new MemoryEventQueue();
    this.clock = o.clock ?? systemClock;
    this.streams = new StreamReceiver({
      send: (frame) => void this.conn?.send(frame),
      accepts: (ch) => this.channelOpen(ch),
      onStream: (stream) => o.handlers?.stream?.(stream),
      onBroken: (sid, code, message) => this.log(`stream ${sid} broken: ${code} ${message}`),
    });
  }

  get state(): State { return this.stateValue; }
  get welcome(): WelcomeFrame | null { return this.welcomeFrame; }
  /** The close code that ended the client for good (4003, 4008, 4009), if any. */
  get stoppedBy(): number | null { return this.stopCode; }

  /** Starts connecting; it keeps trying until `stop()` or a close code that forbids reconnecting. */
  start(): void {
    if (this.stateValue !== "idle") return;
    void this.attempt();
  }

  /** Ends the client; no reconnecting. */
  stop(): void {
    this.clock.clearTimer(this.retry);
    this.stateValue = "stopped";
    this.conn?.close(CLOSE_CODES.normal, "stopped");
    this.rejectReady(new HandLinkError("closed", "client stopped"));
  }

  /** Connects now, dropping the current connection and any waiting or stopped state (the host handed over a new port or token). */
  reconnectNow(): void {
    this.clock.clearTimer(this.retry);
    this.stopCode = null;
    this.failures = 0;
    if (this.conn && !this.conn.closed) {
      this.reconnecting = true;
      this.conn.close(CLOSE_CODES.normal, "reconnecting");
    } else {
      void this.attempt();
    }
  }

  /** Resolves when connected and welcomed. */
  ready(): Promise<WelcomeFrame> {
    if (this.stateValue === "ready" && this.welcomeFrame) return Promise.resolve(this.welcomeFrame);
    if (this.stateValue === "stopped") return Promise.reject(new HandLinkError("closed", "client stopped"));
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  // --- device channel ---

  /**
   * Declares what this hand can do. The manifest is kept and sent again after every reconnect. Resolves with the
   * kernel's ack (waits for the connection if there is none yet).
   */
  setManifest(capabilities: CapabilitySpec[], events: ManifestFrame["events"] = []): Promise<ManifestAckFrame> {
    const rev = ++this.manifestRev;
    this.manifest = { t: "manifest", ch: "device", rev, capabilities, events };
    return new Promise((resolve, reject) => {
      this.manifestWaiters.set(rev, [...(this.manifestWaiters.get(rev) ?? []), { resolve, reject }]);
      if (this.stateValue === "ready") this.sendManifest();
    });
  }

  /** Queues an event and sends it; it is sent again after reconnecting until the kernel acks it. Returns the event id. */
  async emit(word: string, body: Record<string, unknown>, at: number = this.clock.now()): Promise<string> {
    if (this.stateValue === "ready" && !this.channelOpen("device")) throw new HandLinkError("channel", "the device channel is not open");
    const event = { id: newId("e_"), word, body, at };
    await this.queue.add(event);
    if (this.stateValue === "ready") this.conn?.send({ t: "event", ch: "device", ...event });
    return event.id;
  }

  // --- human channel ---

  /** Sends a word as the person; resolves with the kernel's answer (an error answer is a result, not a rejection). */
  send(request: SendRequest): Promise<SendResultFrame> {
    const conn = this.liveConn();
    const id = newId("s_");
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      conn.send({ t: "send", ch: "human", id, request });
    });
  }

  /** Opens a sync; pages and pushed messages go to [listener]. */
  openSync(params: Omit<SyncFrame, "t" | "ch" | "sid">, listener: { page(frame: SyncPageFrame): void; message(frame: SyncMsgFrame): void }): { sid: string; close(): void } {
    const conn = this.liveConn();
    const sid = newId("y_");
    this.syncs.set(sid, listener);
    conn.send({ t: "sync", ch: "human", sid, ...params });
    return { sid, close: () => { if (this.syncs.delete(sid)) this.conn?.send({ t: "sync.close", sid }); } };
  }

  presence(state: Omit<PresenceFrame, "t" | "ch">): void {
    this.liveConn().send({ t: "presence", ch: "human", ...state });
  }

  // --- agent channel, streams ---

  sendAgent(frame: AgentFrame): void { this.liveConn().send(frame); }
  sendStream(ch: LinkChannel, data: Uint8Array | string, opts?: StreamSendOptions): string {
    const conn = this.liveConn();
    return sendStream((frame) => void conn.send(frame), ch, data, opts);
  }

  // --- connecting ---

  private log(message: string, error?: unknown): void { this.o.handlers?.log?.(message, error); }
  private channelOpen(ch: LinkChannel): boolean {
    const grant = this.welcomeFrame?.channels[ch];
    return Boolean(grant && (ch === "human" ? "client" in grant : (grant as { accepted: boolean }).accepted));
  }
  private liveConn(): FrameConn {
    if (this.stateValue !== "ready" || !this.conn || this.conn.closed) throw new HandLinkError("closed", "not connected");
    return this.conn;
  }

  private async attempt(): Promise<void> {
    this.stateValue = "connecting";
    let url: string;
    let headers: Record<string, string>;
    try {
      url = typeof this.o.url === "function" ? await this.o.url() : this.o.url;
      headers = (await this.o.headers?.()) ?? {};
    } catch (error) {
      this.log("could not prepare the connection", error);
      return this.scheduleRetry();
    }
    if ((this.stateValue as State) === "stopped") return;

    let phase: "challenge" | "signing" | "welcome" | "ready" = "challenge";
    let conn: FrameConn | null = null;
    const onClosed = (code: number, reason: string) => {
      if (this.conn === conn) this.conn = null;
      this.welcomeFrame = null;
      this.streams.reset();
      for (const control of this.running.values()) control.abort();
      this.running.clear();
      for (const waiter of this.requests.values()) waiter.reject(new HandLinkError("closed", "connection closed"));
      this.requests.clear();
      this.syncs.clear();
      const final = this.stateValue === "stopped" || NO_RECONNECT_CODES.includes(code);
      if (final && this.stateValue !== "stopped") { this.stopCode = code; this.stateValue = "stopped"; this.rejectReady(new HandLinkError("closed", `closed with ${code}`)); }
      this.o.handlers?.closed?.({ code, reason, willReconnect: !final });
      if (final) return;
      if (this.reconnecting) { this.reconnecting = false; void this.attempt(); } else this.scheduleRetry();
    };
    const events: SocketEvents = {
      open: () => {},
      message: (data, isBinary) => conn?.receive(data, isBinary),
      close: (code, reason) => conn?.remoteClosed(code, reason),
    };
    let socket: RawSocket;
    try {
      socket = this.o.connector(url, headers, events);
    } catch (error) {
      this.log("could not open the socket", error);
      return this.scheduleRetry();
    }
    conn = new FrameConn({
      socket, clock: this.clock, role: "hand", onClosed,
      onFrame: (frame) => {
        if (phase === "challenge" && frame.t === "challenge") {
          phase = "signing";
          void this.answerChallenge(conn!, frame.nonce, frame.kernel.protocol).then((ok) => { if (ok) phase = "welcome"; });
        } else if (phase === "welcome" && frame.t === "welcome") {
          phase = "ready";
          this.onWelcome(conn!, frame);
        } else if (phase === "ready") {
          this.dispatch(conn!, frame);
        } else {
          conn!.close(CLOSE_CODES.badFrame, `unexpected ${frame.t} during the handshake`);
        }
      },
    });
    this.conn = conn;
  }

  private async answerChallenge(conn: FrameConn, nonce: string, protocol: string): Promise<boolean> {
    if (protocol !== LINK_PROTOCOL) { conn.close(CLOSE_CODES.unsupported, `kernel speaks ${protocol.slice(0, 40)}`); return false; }
    try {
      const sig = await this.o.sign?.(nonce);
      conn.send({ t: "hello", protocol: LINK_PROTOCOL, hand: this.o.hand, ...(sig ? { sig } : {}), features: [], channels: this.o.channels });
      return true;
    } catch (error) {
      this.log("could not answer the challenge", error);
      conn.close(CLOSE_CODES.internal, "could not sign");
      return false;
    }
  }

  private onWelcome(conn: FrameConn, welcome: WelcomeFrame): void {
    this.welcomeFrame = welcome;
    this.stateValue = "ready";
    this.failures = 0;
    conn.startHeartbeat(welcome.heartbeat_ms);
    if (this.channelOpen("device")) {
      this.sendManifest();
      void this.resendEvents(conn);
    }
    this.o.handlers?.welcome?.(welcome);
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.resolve(welcome);
  }

  private sendManifest(): void {
    if (this.manifest) this.conn?.send(this.manifest);
  }

  private async resendEvents(conn: FrameConn): Promise<void> {
    try {
      for (const event of await this.queue.pending()) if (!conn.send({ t: "event", ch: "device", ...event })) break;
    } catch (error) {
      this.log("could not resend queued events", error);
    }
  }

  private scheduleRetry(): void {
    if (this.stateValue === "stopped") return;
    this.stateValue = "waiting";
    this.retry = this.clock.setTimer(() => void this.attempt(), reconnectDelay(this.failures++, this.o.random));
  }

  private rejectReady(error: unknown): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  // --- frames after the handshake ---

  private dispatch(conn: FrameConn, frame: import("../../sdk/src/link").Frame): void {
    switch (frame.t) {
      case "stream": return this.streams.handle(frame);
      case "manifest.ack": {
        const waiters = this.manifestWaiters.get(frame.rev);
        this.manifestWaiters.delete(frame.rev);
        for (const waiter of waiters ?? []) waiter.resolve(frame);
        return;
      }
      case "event.ack": return void Promise.resolve(this.queue.remove(frame.id)).catch((error) => this.log("could not drop an acked event", error));
      case "call": return void this.runCall(conn, frame);
      case "cancel": return this.running.get(frame.id)?.abort();
      case "assess": return void this.runAssess(conn, frame.id, frame.capability, frame.args);
      case "send.result": {
        const waiter = this.requests.get(frame.id);
        this.requests.delete(frame.id);
        return waiter?.resolve(frame);
      }
      case "sync.page": return this.syncs.get(frame.sid)?.page(frame);
      case "sync.msg": return this.syncs.get(frame.sid)?.message(frame);
      case "present": return void this.runPresent(conn, frame);
      case "agent": return this.o.handlers?.agent?.(frame);
      case "error": return this.log(`kernel reports ${frame.code}: ${frame.message}`);
      default:
        conn.close(CLOSE_CODES.badFrame, `unexpected ${frame.t}`);
    }
  }

  private async runCall(conn: FrameConn, call: CallFrame): Promise<void> {
    const reply = (result: ResultFrame) => { if (!conn.closed && this.conn === conn) conn.send(result); };
    const handler = this.o.handlers?.call;
    if (!handler) return reply({ t: "result", id: call.id, ok: false, error: { code: "unavailable", message: "this hand serves no calls" } });
    if (this.running.size >= LIMITS.inflightCalls) return reply({ t: "result", id: call.id, ok: false, error: { code: "unavailable", message: `more than ${LIMITS.inflightCalls} calls in flight` } });
    const control = new AbortController();
    this.running.set(call.id, control);
    try {
      const outcome = await handler(call, { signal: control.signal, progress: (text) => { if (this.running.get(call.id) === control) conn.send({ t: "progress", id: call.id, text }); } });
      if (this.running.get(call.id) !== control) return; // the connection dropped meanwhile: the result is dropped
      reply(outcome.ok ? { t: "result", id: call.id, ok: true, content: outcome.content, ...(outcome.data !== undefined ? { data: outcome.data } : {}) } : { t: "result", id: call.id, ok: false, error: outcome.error });
    } catch (error) {
      if (this.running.get(call.id) !== control) return;
      reply({ t: "result", id: call.id, ok: false, error: { code: control.signal.aborted ? "cancelled" : "failed", message: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (this.running.get(call.id) === control) this.running.delete(call.id);
    }
  }

  private async runAssess(conn: FrameConn, id: string, capability: string, args: Record<string, unknown>): Promise<void> {
    const handler = this.o.handlers?.assess;
    if (!handler) return; // no answer: the kernel uses the declared risk after 10 s
    try {
      const answer = await handler(capability, args);
      if (this.conn === conn) conn.send({ t: "assessed", id, risk: answer.risk, ...(answer.why ? { why: answer.why } : {}) });
    } catch (error) {
      this.log("assess failed", error);
    }
  }

  private async runPresent(conn: FrameConn, frame: PresentFrame): Promise<void> {
    let outcome: PresentOutcome;
    try {
      outcome = (await this.o.handlers?.present?.(frame)) ?? { ok: false, error: { code: "unavailable", message: `${frame.surface} is not shown on this hand` } };
    } catch (error) {
      outcome = { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } };
    }
    if (this.conn === conn) conn.send(outcome.ok ? { t: "present.result", id: frame.id, ok: true, ...(outcome.data !== undefined ? { data: outcome.data } : {}) } : { t: "present.result", id: frame.id, ok: false, error: outcome.error });
  }
}
