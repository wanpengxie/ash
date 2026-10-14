// The page's one connection to the kernel: the `human` channel of ash-link/2 (SPEC-03 §5).
//
// The page opens the WebSocket itself with the browser client of packages/link (the handshake, the heartbeat and the
// reconnecting are the client's). (The phone app draws its own chat natively and does not run this page.)
//
// Everything above this file (net.js and the sheets) sees only a `Port`:
//   start() / stop() / reconnect()
//   state       "connecting" | "online" | "offline" | "closed"      info   {client, local, session} while online
//   send(request)                    -> the `send.result` frame (never rejects; a lost connection is an error result)
//   call(to, word, body, options)    -> the word's `Reply` (see below)
//   sync(params, {page, message})    -> {sid, close()} or null when there is no connection
//   presence({visible?, typing?, agent?})
//   stream(sid)                      -> Promise<{mime, data: Uint8Array}> for a `resource` the kernel answered with
import { HandClient, browserConnector } from "./link-browser.js";

const newId = (prefix) => `${prefix}${globalThis.crypto.randomUUID()}`;
const text = (error) => (error instanceof Error ? error.message : String(error));
const failure = (code, message) => ({ ok: false, error: { code, message } });

/** What went wrong when a word did not succeed. `code` is one of the error codes of SPEC-02 §7. */
export class WordFailure extends Error {
  constructor(error) {
    super(error?.message || "没有成功");
    this.code = error?.code || "failed";
    this.detail = error?.detail;
    this.recovery_hint = error?.recovery_hint;
  }
}

/** The data of a successful `Reply`; a failed one throws [WordFailure]. */
export function unwrap(reply) {
  if (reply?.ok === true) return reply.result?.data ?? {};
  throw new WordFailure(reply?.ok === false ? reply.error : { code: "result_unknown", message: "没有收到确认" });
}

/** True when the failure says only that the answer did not arrive, so the same request may be sent again. */
export const retryable = (error) => ["offline", "unavailable", "timeout", "result_unknown", "internal"].includes(error?.code);

/** The close codes that end a connection for good (SPEC-03 §7), as the owner should hear them. */
export const FINAL_CLOSE = { 4003: "这台设备已被撤销，不能再连接。", 4008: "页面和 Ash 的版本对不上，需要更新。", 4009: "已在别处打开，这一个断开了。" };

// --- shared by both transports --------------------------------------------------------------------------------------------

class Streams {
  constructor() { this.waiting = new Map(); this.arrived = new Map(); }
  /** A stream arrived whole. */
  deliver(stream) {
    const waiter = this.waiting.get(stream.sid);
    if (waiter) { this.waiting.delete(stream.sid); waiter.resolve(stream); return; }
    this.arrived.set(stream.sid, stream);
    // Nobody asked for it (yet): keep a few, the result frame may simply be late.
    if (this.arrived.size > 16) this.arrived.delete(this.arrived.keys().next().value);
  }
  take(sid) {
    const have = this.arrived.get(sid);
    if (have) { this.arrived.delete(sid); return Promise.resolve(have); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(sid); reject(new WordFailure({ code: "timeout", message: "文件没有送到" })); }, 60_000);
      this.waiting.set(sid, { resolve: (stream) => { clearTimeout(timer); resolve(stream); }, reject });
    });
  }
  broken(sid, code, message) {
    const waiter = this.waiting.get(sid);
    if (waiter) { this.waiting.delete(sid); waiter.reject(new WordFailure({ code, message })); }
  }
  reset() { this.arrived.clear(); for (const [sid, waiter] of this.waiting) waiter.reject(new WordFailure({ code: "offline", message: "连接断了" })); this.waiting.clear(); }
}

/** The common part of a port: `call` over `send`, and the streams the kernel sends. */
class BasePort {
  constructor(hooks) {
    this.hooks = hooks;
    this.state = "connecting";
    this.info = null;
    this.streams = new Streams();
  }

  stream(sid) { return this.streams.take(sid); }

  async call(to, word, body = {}, { clientId, signal } = {}) {
    if (signal?.aborted) return failure("cancelled", "已取消");
    const result = await this.send({ to, kind: "request", word, body, wait: true, ...(clientId ? { client_id: clientId } : {}) });
    if (!result.ok) return { ok: false, error: result.error };
    // The kernel waits up to 60 s for the answer; without one the word may still be running.
    return result.response ?? failure("result_unknown", "还没有收到结果");
  }

  set(state, info = null) {
    this.state = state;
    this.info = info;
    this.hooks.state?.(state, info);
  }
}

// --- the browser ------------------------------------------------------------------------------------------------------------

const wsUrl = () => {
  const here = new URL("/link", globalThis.location.href);
  here.protocol = here.protocol === "https:" ? "wss:" : "ws:";
  return here.href;
};

/**
 * A browser tab is a hand of kind `browser` that opens only the `human` channel. It has no key to sign with: the relay
 * vouches for the browser's device (SPEC-03 §2.2), so the hello carries no `public_key`.
 */
export class BrowserPort extends BasePort {
  constructor(hooks, { url, label = "网页", connector, clock, random } = {}) {
    super(hooks);
    this.client = new HandClient({
      url: url ?? wsUrl, connector: connector ?? browserConnector, ...(clock ? { clock } : {}), ...(random ? { random } : {}),
      hand: { kind: "browser", name: label, version: "web", platform: globalThis.navigator?.platform || "web" },
      channels: { human: { label, surfaces: ["chat"] } },
      handlers: {
        welcome: (welcome) => {
          const human = welcome.channels.human;
          if (!human || !("client" in human)) {
            this.stopped = true;
            this.set("closed", { denied: human?.reason || "这台设备没有被允许使用聊天。" });
            this.client.stop();
            return;
          }
          this.set("online", { client: human.client, local: human.local === true, session: welcome.session });
        },
        closed: ({ code, willReconnect }) => {
          this.streams.reset();
          if (this.stopped) return;
          if (willReconnect) this.set("offline");
          else this.set("closed", { denied: FINAL_CLOSE[code] || "连接已关闭。", code });
        },
        present: (frame) => this.hooks.present(frame),
        stream: (stream) => this.streams.deliver(stream),
        log: (message, error) => this.hooks.log?.(message, error),
      },
    });
  }

  start() { this.stopped = false; this.set("connecting"); this.client.start(); }
  stop() { this.stopped = true; this.client.stop(); this.streams.reset(); this.set("offline"); }
  reconnect() { this.stopped = false; this.set("connecting"); this.client.reconnectNow(); }

  async send(request) {
    try {
      return await this.client.send(request);
    } catch (error) {
      // The connection ended before the answer: the kernel may have taken the request.
      return failure("result_unknown", text(error));
    }
  }

  sync(params, listener) {
    try { return this.client.openSync(params, listener); } catch { return null; }
  }

  presence(state) {
    try { this.client.presence(state); } catch { /* not connected: the next connection tells the kernel again */ }
  }
}

/** The port for this page. */
export function openPort(hooks, browser = {}) {
  return new BrowserPort(hooks, browser);
}
