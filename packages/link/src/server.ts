import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders, Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer } from "ws";
import {
  CLOSE_CODES, LINK_PROTOCOL, LIMITS, checkCapabilitySpec,
  type AgentFrame, type AssessedFrame, type CallFrame, type CapabilitySpec, type EventFrame, type Frame, type HelloFrame,
  type LinkChannel, type ManifestFrame, type PresenceFrame, type PresentResultFrame, type ResultFrame, type SendFrame,
  type SyncCloseFrame, type SyncFrame, type WelcomeFrame, FRAME_DEFS,
} from "../../sdk/src/link";
import { systemClock, type Clock } from "./clock";
import { newId } from "./codec";
import { FrameConn, type RoundTrip } from "./conn";
import type { LinkSocket } from "./socket";
import { StreamReceiver, sendStream, type ReceivedStream, type StreamSendOptions } from "./stream";

// --- what the caller (the kernel) plugs in ---------------------------------------------------------------------------

export interface AuthContext {
  /** The challenge nonce the hand's `sig` signs. */
  nonce: string;
  /** Headers of the upgrade request (for example `authorization`); empty for a socket accepted without one. */
  headers: IncomingHttpHeaders;
  /** Whatever the caller passed to [LinkServer.accept] (for a gateway tunnel: the device id the gateway vouches for). */
  meta?: unknown;
}
export type ChannelGrant = { accepted: true } | { accepted: false; reason: string };
export type HumanGrant = { accepted: true; client: string; local: boolean } | { accepted: false; reason: string };
export type AuthResult =
  | { ok: true; hand_id: string; channels: { device?: ChannelGrant; human?: HumanGrant; agent?: ChannelGrant } }
  /** Refuse: the connection is closed with [code] (4001 identity, 4003 revoked, 4008 version, …). */
  | { ok: false; code: number; reason?: string };

export interface ManifestCheck {
  /** Capabilities that passed the shape check. */
  capabilities: CapabilitySpec[];
  /** Capabilities that did not, with the reason; they are already part of the ack. */
  rejected: { name: string; reason: string }[];
}
export interface ManifestVerdict { accepted?: boolean; rejected?: { name: string; reason: string }[] }

export interface SessionHandlers {
  /** A `manifest` arrived. The server acks with the result; [check] has done the per-capability shape check. */
  manifest?(frame: ManifestFrame, check: ManifestCheck): Promise<ManifestVerdict | void> | ManifestVerdict | void;
  /** An `event` arrived. The ack follows when this returns; if it throws there is no ack and the hand resends after reconnecting. A resend arrives again with the same id, so de-duplicating on it is the caller's job. */
  event?(frame: EventFrame): Promise<void> | void;
  /** Frames of the human channel, except the stream ones: send, sync, sync.close, presence, present.result. */
  human?(frame: SendFrame | SyncFrame | SyncCloseFrame | PresenceFrame | PresentResultFrame): void;
  agent?(frame: AgentFrame): void;
  /** A stream arrived whole. */
  stream?(stream: ReceivedStream): void;
  closed?(code: number, reason: string): void;
}

export interface LinkServerOptions {
  kernel: { id: string; version: string };
  /** Checks token and signature. The server knows neither where tokens nor public keys are kept. */
  authenticate(hello: HelloFrame, ctx: AuthContext): Promise<AuthResult> | AuthResult;
  /** The hand is in: the welcome is sent right after this returns. Take the session's handlers here. */
  onSession(session: LinkSession): SessionHandlers | void;
  clock?: Clock;
  monotonicNow?(): number;
  log?(message: string, error?: unknown): void;
  /** A connection was closed because of its protocol version, before [authenticate] was asked. [meta] is what was passed to [LinkServer.accept]. */
  refused?(info: { code: number; reason: string; meta?: unknown }): void;
}

export class LinkError extends Error {
  /** `closed`: the connection ended; `deadline`: no result by the call's deadline; `channel`: the channel is not open on this connection. */
  constructor(readonly kind: "closed" | "deadline" | "channel", message: string) { super(message); }
}

export interface CallRequest {
  capability: string;
  args: Record<string, unknown>;
  caller: CallFrame["caller"];
  /** Millisecond timestamp (on the server's clock). */
  deadline: number;
  onProgress?(text: string): void;
  /** Aborting sends `cancel`; the hand still answers (code `cancelled`). */
  signal?: AbortSignal;
}

export interface LinkSession {
  readonly id: string;
  readonly handId: string;
  readonly hello: HelloFrame;
  readonly channels: WelcomeFrame["channels"];
  readonly closed: boolean;
  /** Latest heartbeat sample for this exact session; no extra probe is sent. */
  latency?(): RoundTrip | null;
  /** Sends a frame. False when the connection is closed. */
  send(frame: Frame): boolean;
  /** Calls a capability of the hand. Rejects with [LinkError] when the connection ends or the deadline passes first. */
  call(request: CallRequest): Promise<ResultFrame>;
  /** Asks the hand for the risk of one call; null when it does not answer within 10 seconds (use the declared risk). */
  assess(capability: string, args: Record<string, unknown>): Promise<Pick<AssessedFrame, "risk" | "why"> | null>;
  sendStream(ch: LinkChannel, data: Uint8Array | string, opts?: StreamSendOptions): string;
  close(code: number, reason?: string): void;
}

export interface LinkServer {
  /** Takes WebSocket upgrades for path `/link` on [server]; other paths are left to other listeners. Returns a function that stops it. */
  attach(server: HttpServer | HttpsServer): () => void;
  /** Takes a WebSocket that is already open (for a gateway tunnel). */
  accept(socket: LinkSocket, ctx?: { headers?: IncomingHttpHeaders; meta?: unknown }): void;
  sessions(): LinkSession[];
  closeSession(sessionId: string, code: number, reason?: string): boolean;
  /** Closes every connection (and stops the upgrade handlers). */
  close(): void;
}

const LINK_PATH = "/link";
/** How long a new connection may stay without sending `hello`. */
const HELLO_TIMEOUT_MS = 10_000;
const carriesExecutor = (session: LinkSession): boolean =>
  [session.channels.device, session.channels.agent].some((grant) => grant !== undefined && "accepted" in grant && grant.accepted);
const rejectionOf = (reason: string) => ({ accepted: false as const, reason });

export function createLinkServer(options: LinkServerOptions): LinkServer {
  const clock = options.clock ?? systemClock;
  const live = new Map<string, LinkSession>();
  const conns = new Set<FrameConn>();
  const unsubscribe: (() => void)[] = [];
  const log = options.log ?? (() => {});

  function accept(socket: LinkSocket, ctx: { headers?: IncomingHttpHeaders; meta?: unknown } = {}): void {
    const nonce = randomBytes(32).toString("base64url");
    let phase: "hello" | "authenticating" | "ready" = "hello";
    let session: Session | null = null;
    let helloTimer: unknown;

    const conn: FrameConn = new FrameConn({
      socket: { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason), terminate: () => socket.terminate?.() },
      clock,
      monotonicNow: options.monotonicNow,
      role: "kernel",
      onFrame: (frame) => {
        if (phase === "hello" && frame.t === "hello") void authenticate(frame);
        else if (phase !== "ready" || !session) conn.close(CLOSE_CODES.badFrame, `unexpected ${frame.t} before the handshake finished`);
        else session.dispatch(frame);
      },
      onInvalid: (bad) => {
        // A hand of another protocol version must hear 4008 even if its hello is shaped differently.
        const v = bad.value as { t?: unknown; protocol?: unknown } | undefined;
        if (phase === "hello" && v?.t === "hello" && typeof v.protocol === "string" && v.protocol !== LINK_PROTOCOL) {
          refuse(`unsupported protocol ${v.protocol.slice(0, 40)}`);
          return true;
        }
      },
      onClosed: (code, reason) => {
        clock.clearTimer(helloTimer);
        conns.delete(conn);
        if (session) {
          live.delete(session.id);
          session.ended(code, reason);
        }
      },
    });
    const refuse = (reason: string) => {
      options.refused?.({ code: CLOSE_CODES.unsupported, reason, meta: ctx.meta });
      conn.close(CLOSE_CODES.unsupported, reason);
    };
    conns.add(conn);
    socket.on("message", (data: unknown, isBinary?: boolean) => conn.receive(data, isBinary));
    socket.on("close", (code: number, reason: unknown) => conn.remoteClosed(code, String(reason ?? "")));

    helloTimer = clock.setTimer(() => { if (phase === "hello") conn.close(CLOSE_CODES.unauthenticated, "no hello"); }, HELLO_TIMEOUT_MS);
    conn.send({ t: "challenge", nonce, kernel: { id: options.kernel.id, version: options.kernel.version, protocol: LINK_PROTOCOL } });

    async function authenticate(hello: HelloFrame): Promise<void> {
      phase = "authenticating";
      clock.clearTimer(helloTimer);
      if (hello.protocol !== LINK_PROTOCOL) return refuse(`unsupported protocol ${hello.protocol.slice(0, 40)}`);
      let verdict: AuthResult;
      try {
        verdict = await options.authenticate(hello, { nonce, headers: ctx.headers ?? {}, meta: ctx.meta });
      } catch (error) {
        log("authenticate failed", error);
        return conn.close(CLOSE_CODES.internal, "authentication error");
      }
      if (conn.closed) return;
      if (!verdict.ok) return conn.close(verdict.code, verdict.reason ?? "");
      const channels: WelcomeFrame["channels"] = {};
      for (const name of Object.keys(hello.channels) as LinkChannel[]) {
        if (name === "human") {
          const grant = verdict.channels.human;
          channels.human = grant?.accepted ? { client: grant.client, local: grant.local } : rejectionOf(grant?.reason ?? "not allowed");
        } else {
          const grant = verdict.channels[name];
          channels[name] = grant?.accepted ? { accepted: true } : rejectionOf(grant?.reason ?? "not allowed");
        }
      }
      const created = new Session({ id: newId("s_"), handId: verdict.hand_id, hello, channels, conn, clock, log });
      session = created;
      // One executor per hand (SPEC-03 §2.2.2): a connection carrying device or agent takes the place of the older one that does.
      if (carriesExecutor(created)) for (const old of live.values()) if (old.handId === created.handId && carriesExecutor(old)) old.close(CLOSE_CODES.superseded, "replaced by a newer connection");
      live.set(created.id, created);
      try {
        created.use(options.onSession(created) ?? {});
      } catch (error) {
        log("onSession failed", error);
        return conn.close(CLOSE_CODES.internal, "session setup error");
      }
      if (conn.closed) return;
      phase = "ready";
      conn.send({ t: "welcome", hand_id: created.handId, session: created.id, heartbeat_ms: LIMITS.heartbeatMs, channels });
      conn.startHeartbeat(LIMITS.heartbeatMs);
    }
  }

  const server: LinkServer = {
    attach(http) {
      const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frameBytes });
      const onUpgrade = (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
        if (new URL(req.url ?? "/", "http://link.invalid").pathname !== LINK_PATH) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("error", (error) => log("socket error", error));
          accept(ws, { headers: req.headers });
        });
      };
      http.on("upgrade", onUpgrade);
      const stop = () => { http.off("upgrade", onUpgrade); wss.close(); };
      unsubscribe.push(stop);
      return stop;
    },
    accept,
    sessions: () => [...live.values()],
    closeSession(sessionId, code, reason) {
      const session = live.get(sessionId);
      session?.close(code, reason);
      return Boolean(session);
    },
    close() {
      for (const stop of unsubscribe.splice(0)) stop();
      for (const conn of [...conns]) conn.close(CLOSE_CODES.normal, "server closing");
    },
  };
  return server;
}

// --- one connected hand ----------------------------------------------------------------------------------------------

interface SessionInit {
  id: string; handId: string; hello: HelloFrame; channels: WelcomeFrame["channels"]; conn: FrameConn; clock: Clock;
  log(message: string, error?: unknown): void;
}

class Session implements LinkSession {
  readonly id: string;
  readonly handId: string;
  readonly hello: HelloFrame;
  readonly channels: WelcomeFrame["channels"];
  private handlers: SessionHandlers = {};
  private readonly calls = new Map<string, { resolve(r: ResultFrame): void; reject(e: unknown): void; onProgress?(text: string): void; timer: unknown }>();
  private readonly assessing = new Map<string, { resolve(r: Pick<AssessedFrame, "risk" | "why"> | null): void; timer: unknown }>();
  private readonly streams: StreamReceiver;

  constructor(private readonly i: SessionInit) {
    this.id = i.id; this.handId = i.handId; this.hello = i.hello; this.channels = i.channels;
    this.streams = new StreamReceiver({
      send: (frame) => this.send(frame),
      accepts: (ch) => this.open(ch),
      onStream: (stream) => this.handlers.stream?.(stream),
      onBroken: (sid, code, message) => i.log(`stream ${sid} broken: ${code} ${message}`),
    });
  }

  get closed(): boolean { return this.i.conn.closed; }
  latency(): RoundTrip | null { return this.i.conn.latency(); }
  use(handlers: SessionHandlers): void { this.handlers = handlers; }
  private open(ch: LinkChannel): boolean {
    const grant = this.channels[ch];
    return Boolean(grant && (ch === "human" ? "client" in grant : (grant as { accepted: boolean }).accepted));
  }

  send(frame: Frame): boolean { return this.i.conn.send(frame); }
  close(code: number, reason?: string): void { this.i.conn.close(code, reason); }
  sendStream(ch: LinkChannel, data: Uint8Array | string, opts?: StreamSendOptions): string { return sendStream((frame) => this.send(frame), ch, data, opts); }

  call(request: CallRequest): Promise<ResultFrame> {
    if (!this.open("device")) return Promise.reject(new LinkError("channel", "the device channel is not open on this connection"));
    if (this.closed) return Promise.reject(new LinkError("closed", "connection closed"));
    const id = newId("c_");
    return new Promise<ResultFrame>((resolve, reject) => {
      const clock = this.i.clock;
      const timer = clock.setTimer(() => {
        this.calls.delete(id);
        this.send({ t: "cancel", id, reason: "deadline" });
        reject(new LinkError("deadline", `no result by the deadline for ${request.capability}`));
      }, Math.max(0, request.deadline - clock.now()));
      this.calls.set(id, { resolve, reject, onProgress: request.onProgress, timer });
      request.signal?.addEventListener("abort", () => { if (this.calls.has(id)) this.send({ t: "cancel", id, reason: "cancelled" }); }, { once: true });
      this.send({ t: "call", ch: "device", id, capability: request.capability, args: request.args, caller: request.caller, deadline: request.deadline });
    });
  }

  assess(capability: string, args: Record<string, unknown>): Promise<Pick<AssessedFrame, "risk" | "why"> | null> {
    if (!this.open("device") || this.closed) return Promise.resolve(null);
    const id = newId("a_");
    return new Promise((resolve) => {
      const timer = this.i.clock.setTimer(() => { this.assessing.delete(id); resolve(null); }, LIMITS.assessMs);
      this.assessing.set(id, { resolve, timer });
      this.send({ t: "assess", ch: "device", id, capability, args });
    });
  }

  /** The connection ended. */
  ended(code: number, reason: string): void {
    this.streams.reset();
    for (const [, call] of this.calls) { this.i.clock.clearTimer(call.timer); call.reject(new LinkError("closed", "connection closed")); }
    this.calls.clear();
    for (const [, wait] of this.assessing) { this.i.clock.clearTimer(wait.timer); wait.resolve(null); }
    this.assessing.clear();
    this.handlers.closed?.(code, reason);
  }

  /** A frame from the hand, after the handshake. */
  dispatch(frame: Frame): void {
    const channel = FRAME_DEFS[frame.t].channel;
    if (channel && !this.open(channel)) {
      this.send({ t: "error", ...("id" in frame && typeof frame.id === "string" ? { id: frame.id } : {}), code: "forbidden", message: `the ${channel} channel is not open on this connection` });
      return;
    }
    switch (frame.t) {
      case "stream": return this.streams.handle(frame);
      case "manifest": return void this.onManifest(frame);
      case "event": return void this.onEvent(frame);
      case "progress": return this.calls.get(frame.id)?.onProgress?.(frame.text);
      case "result": {
        const call = this.calls.get(frame.id);
        if (!call) return;
        this.calls.delete(frame.id);
        this.i.clock.clearTimer(call.timer);
        return call.resolve(frame);
      }
      case "assessed": {
        const wait = this.assessing.get(frame.id);
        if (!wait) return;
        this.assessing.delete(frame.id);
        this.i.clock.clearTimer(wait.timer);
        return wait.resolve({ risk: frame.risk, ...(frame.why ? { why: frame.why } : {}) });
      }
      case "send": case "sync": case "sync.close": case "presence": case "present.result": return this.handlers.human?.(frame);
      case "agent": return this.handlers.agent?.(frame);
      case "error": return this.i.log(`hand ${this.handId} reports ${frame.code}: ${frame.message}`);
      default: // hello again, or a frame only the kernel sends (the connection already refused those)
        this.close(CLOSE_CODES.badFrame, `unexpected ${frame.t}`);
    }
  }

  private async onManifest(frame: ManifestFrame): Promise<void> {
    const check: ManifestCheck = { capabilities: [], rejected: [] };
    for (const item of frame.capabilities) {
      const problem = checkCapabilitySpec(item);
      if (problem) check.rejected.push({ name: typeof item.name === "string" ? item.name : "?", reason: problem });
      else check.capabilities.push(item as CapabilitySpec);
    }
    let verdict: ManifestVerdict | void;
    try {
      verdict = await this.handlers.manifest?.(frame, check);
    } catch (error) {
      this.i.log("manifest handler failed", error);
      this.send({ t: "manifest.ack", rev: frame.rev, accepted: false, rejected: check.rejected });
      return;
    }
    this.send({ t: "manifest.ack", rev: frame.rev, accepted: verdict?.accepted ?? true, rejected: [...check.rejected, ...(verdict?.rejected ?? [])] });
  }

  private async onEvent(frame: EventFrame): Promise<void> {
    try {
      await this.handlers.event?.(frame);
    } catch (error) {
      this.i.log(`event ${frame.id} failed; not acked`, error);
      return;
    }
    this.send({ t: "event.ack", id: frame.id });
  }
}
