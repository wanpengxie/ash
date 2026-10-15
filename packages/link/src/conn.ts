import { CLOSE_CODES, FRAME_DEFS, LIMITS, type Frame } from "../../sdk/src/link";
import type { Clock } from "./clock";
import { decodeFrame, encodeFrame, type Decoded } from "./codec";
import type { RawSocket } from "./socket";

export interface ConnOptions {
  socket: RawSocket;
  clock: Clock;
  /** RTT uses elapsed time, never the wall clock echoed in ping. Injectable for deterministic tests. */
  monotonicNow?(): number;
  /** Which end this is. A frame that only the same end may send is a protocol error. */
  role: "kernel" | "hand";
  /** A valid frame, except ping and pong, which the connection answers itself. */
  onFrame(frame: Frame): void;
  /**
   * A message that is not a valid frame. Return true when it was handled (for example closed with another code);
   * otherwise the connection answers with an `error` frame and closes with 4400.
   */
  onInvalid?(bad: Extract<Decoded, { ok: false }>): boolean | void;
  /** Called once, whoever closed the connection. */
  onClosed(code: number, reason: string): void;
}

export interface RoundTrip { rtt_ms: number; age_ms: number }

/** Close reasons travel in a control frame, which holds 123 bytes. */
const clip = (reason: string) => reason.slice(0, 100);

/**
 * One WebSocket carrying frames: decoding and checking, ping and pong, and the silence watchdog. The server's
 * sessions and the clients share it; it knows nothing about what the frames mean.
 */
export class FrameConn {
  closed = false;
  private silence: unknown;
  private beat: unknown;
  private lastPingAt = -1;
  private pendingPing: { at: number; sent: number } | null = null;
  private sample: { rtt: number; received: number } | null = null;
  private elapsed(): number { return this.o.monotonicNow?.() ?? performance.now(); }

  /** The latest measured heartbeat round trip of this connection; null before a matched pong or after disconnect. */
  latency(): RoundTrip | null {
    if (this.closed || !this.sample) return null;
    return { rtt_ms: this.sample.rtt, age_ms: Math.max(0, Math.floor(this.elapsed() - this.sample.received)) };
  }

  constructor(private readonly o: ConnOptions) {
    this.armSilence();
  }

  /** Sends a frame; false when the connection is already closed. */
  send(frame: Frame): boolean {
    if (this.closed) return false;
    if (frame.t === "ping") {
      // A repeated echo key cannot distinguish a delayed old pong; still send it, but do not measure it.
      this.pendingPing = frame.at > this.lastPingAt ? { at: frame.at, sent: this.elapsed() } : null;
      this.lastPingAt = Math.max(this.lastPingAt, frame.at);
    }
    try { this.o.socket.send(encodeFrame(frame)); }
    catch (error) { if (frame.t === "ping") this.pendingPing = null; throw error; }
    return true;
  }

  /** The socket's `message` event. */
  receive(data: unknown, isBinary?: boolean): void {
    if (this.closed) return;
    this.armSilence();
    const decoded = decodeFrame(data, isBinary);
    if (!decoded.ok) {
      if (this.o.onInvalid?.(decoded) === true) return;
      this.send({ t: "error", ...(decoded.id ? { id: decoded.id } : {}), code: "bad_request", message: decoded.error });
      this.close(CLOSE_CODES.badFrame, decoded.error);
      return;
    }
    const frame = decoded.frame;
    if (FRAME_DEFS[frame.t].from === this.o.role) {
      this.send({ t: "error", code: "bad_request", message: `a ${this.o.role} does not send ${frame.t}` });
      this.close(CLOSE_CODES.badFrame, `${frame.t} sent by the wrong end`);
      return;
    }
    if (frame.t === "ping") { this.send({ t: "pong", at: frame.at }); return; }
    if (frame.t === "pong") {
      if (this.pendingPing?.at === frame.at) {
        const received = this.elapsed();
        const rtt = received - this.pendingPing.sent;
        if (Number.isFinite(rtt) && rtt >= 0) this.sample = { rtt, received };
        this.pendingPing = null;
      }
      return;
    }
    this.o.onFrame(frame);
  }

  /** Sends a ping every [ms]. */
  startHeartbeat(ms: number): void {
    this.o.clock.clearTimer(this.beat);
    const tick = () => {
      if (this.closed) return;
      this.send({ t: "ping", at: Math.max(0, this.o.clock.now(), this.lastPingAt + 1) });
      this.beat = this.o.clock.setTimer(tick, ms);
    };
    this.beat = this.o.clock.setTimer(tick, ms);
  }

  /** Closes from this end. */
  close(code: number, reason = ""): void {
    if (this.closed) return;
    this.finish(code, reason);
    try { this.o.socket.close(code, clip(reason)); } catch { /* already gone */ }
  }

  /** The socket's `close` event: the peer (or the network) ended it. */
  remoteClosed(code: number, reason: string): void {
    if (!this.closed) this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    this.closed = true;
    this.pendingPing = null;
    this.sample = null;
    this.o.clock.clearTimer(this.silence);
    this.o.clock.clearTimer(this.beat);
    this.o.onClosed(code, reason);
  }

  private armSilence(): void {
    this.o.clock.clearTimer(this.silence);
    this.silence = this.o.clock.setTimer(() => {
      this.close(CLOSE_CODES.normal, "no frame within the silence limit");
      this.o.socket.terminate?.();
    }, LIMITS.silenceMs);
  }
}
