/**
 * The Codex gateway: the hub's own end of pi's connection to Codex (chatgpt.com). pi's `openai-codex` provider is pointed at this
 * server (`models.json`, see `driver.ts`), and the gateway holds what a pi process cannot keep because it comes and goes with the turns:
 *   - a pool of upstream WebSockets, one per session, kept alive between turns (ping every `pingMs`, renewed before they get too old)
 *     and through the proxy the driver is using (a CONNECT tunnel to v2rayA, or straight out), so a turn no longer pays for the
 *     proxy hop, TLS and the WebSocket upgrade, nor for the failures of a bad node while doing it;
 *   - the continuation state. pi sends the whole input in a fresh process and only a delta (`previous_response_id`) inside one. The
 *     gateway remembers, per session, the input it sent, what came back and the response id, and when the next full input starts
 *     with that (and nothing else of the request changed) it sends only the rest, on the connection that holds the response. When the
 *     delta cannot be used (the connection is gone, the server says `previous_response_not_found`) it sends the full input on a new one;
 *   - one retry of a request that failed before anything was sent back, on a new connection.
 * pi talks to it by WebSocket (`response.create` frames) and, when it falls back, by an SSE POST; both are served from the same pool
 * (an SSE request becomes a frame on an upstream WebSocket; when no WebSocket can be had, the POST goes out as it came).
 *
 * The login is not here: pi reads and refreshes it, and puts it on every request (`authorization`, `chatgpt-account-id`). The gateway
 * only passes those on to the handshake of an upstream connection, in memory, and never writes them to a log or a file.
 * It listens on 127.0.0.1 only, on a port the system chooses.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import * as zlib from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";

export interface CodexGatewayOptions {
  /** The Codex responses endpoint. */
  upstream?: string;
  /** The HTTP proxy to go through now (the driver's current way), or nothing for straight out. */
  proxy?: () => string | undefined;
  log?: (...args: unknown[]) => void;
  connectMs?: number;
  /** A request that gets no frame at all in this long, on a connection that was in use, is taken for dead. */
  firstFrameMs?: number;
  /** No frame in this long in the middle of a response ends it. */
  idleFrameMs?: number;
  pingMs?: number;
  /** A connection is renewed before it is this old. */
  maxAgeMs?: number;
  /** A session nobody has used for this long loses its connection. */
  sessionMs?: number;
  maxSessions?: number;
}

export interface CodexGatewayStats { connects: number; reuses: number; deltas: number; fulls: number; retries: number; recoveries: number; sse: number; httpFallbacks: number }

type Hdr = Record<string, string>;
type Frame = Record<string, any>;

const DEFAULT_UPSTREAM = "wss://chatgpt.com/backend-api/codex/responses";
const TERMINAL = new Set(["response.completed", "response.done", "response.incomplete", "response.failed", "error"]);
/** What of a request's headers goes to the upstream handshake: not the ones that belong to the local connection. */
const LOCAL_ONLY = /^(host|connection|upgrade|content-length|content-type|content-encoding|accept|accept-encoding|accept-language|pragma|cache-control|sec-fetch-.*|transfer-encoding|keep-alive|expect|sec-websocket-.*)$/;
/** What pi puts in `OpenAI-Beta` of a WebSocket handshake (its SSE requests carry another value). */
const WS_BETA = "responses_websockets=2026-02-06";
const MAX_PAYLOAD = 64 * 1024 * 1024;

const headersOf = (h: IncomingHttpHeaders): Hdr => {
  const out: Hdr = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k.toLowerCase()] = v; else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(", ");
  return out;
};
const passHeaders = (h: Hdr): Hdr => Object.fromEntries(Object.entries(h).filter(([k]) => !LOCAL_ONLY.test(k)));
const msg = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e).replace(/\s+/g, " ").slice(0, 200);

/** A socket to host:port (TLS or not), straight or through an HTTP proxy's CONNECT. */
export function openSocket(target: { host: string; port: number; tls: boolean }, proxy: string | undefined, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sock: Socket | undefined;
    const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); sock?.destroy(); reject(e); };
    const done = (s: Socket) => { if (settled) { s.destroy(); return; } settled = true; clearTimeout(timer); s.setNoDelay(true); resolve(s); };
    const timer = setTimeout(() => fail(new Error(`connect timeout after ${timeoutMs}ms`)), timeoutMs);
    const secure = (raw?: Socket) => {
      const t = raw ? tlsConnect({ socket: raw, servername: target.host }) : tlsConnect({ host: target.host, port: target.port, servername: target.host });
      sock = t; t.once("secureConnect", () => done(t)); t.once("error", fail);
    };
    if (!proxy) {
      if (target.tls) secure();
      else { const s = netConnect({ host: target.host, port: target.port }); sock = s; s.once("connect", () => done(s)); s.once("error", fail); }
      return;
    }
    let pu: URL;
    try { pu = new URL(proxy); } catch { fail(new Error("the proxy address is not a URL")); return; }
    const raw = netConnect({ host: pu.hostname, port: Number(pu.port) || 80 });
    sock = raw;
    raw.once("error", fail);
    let head = "";
    const auth = pu.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`).toString("base64")}\r\n` : "";
    raw.once("connect", () => raw.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth}\r\n`));
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      raw.off("data", onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) { fail(new Error(`the proxy refused the tunnel (${head.split("\r\n")[0]!.slice(0, 40)})`)); return; }
      if (target.tls) secure(raw); else done(raw);
    };
    raw.on("data", onData);
  });
}

/** One upstream connection. The response state a `previous_response_id` refers to lives on it. */
class Up {
  busy = false;
  dead = false;
  alive = true;
  lastResponseId: string | undefined;
  readonly createdAt = Date.now();
  constructor(readonly ws: WebSocket, readonly session: string) {}
  get open() { return !this.dead && this.ws.readyState === WebSocket.OPEN; }
  close() { this.dead = true; try { this.ws.terminate(); } catch { /* gone */ } }
}

interface Sess {
  key: string;
  headers: Hdr;
  touched: number;
  conn?: Up;
  connecting?: Promise<Up>;
  /** What the last request was, as a whole input (what pi would send in a fresh process), what came back, and its id. */
  full?: Frame[];
  /** The items of `full` as pi sent them, as text; null for an item that came back from Codex (pi renders those its own way: only their kind is compared). */
  fullJson?: Array<string | null>;
  outputs: Frame[];
  restJson?: string;
  lastResponseId?: string;
}

type Outcome = "ok" | "ended" | "notfound" | "dead" | "aborted";
type Emit = (text: string) => void;
interface Client { closed: boolean; /** Calls `fn` when the local side goes away; returns the way to stop listening. */ onClose(fn: () => void): () => void }

function clientOf(target: { once(event: "close", fn: () => void): unknown }): Client {
  const subs = new Set<() => void>();
  const client: Client = { closed: false, onClose: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; } };
  target.once("close", () => { client.closed = true; for (const fn of [...subs]) fn(); });
  return client;
}

export class CodexGateway {
  readonly stats: CodexGatewayStats = { connects: 0, reuses: 0, deltas: 0, fulls: 0, retries: 0, recoveries: 0, sse: 0, httpFallbacks: 0 };
  private server?: Server;
  private wss?: WebSocketServer;
  private starting?: Promise<number>;
  private timer?: NodeJS.Timeout;
  private readonly sessions = new Map<string, Sess>();
  private readonly o: Required<Omit<CodexGatewayOptions, "log" | "proxy">> & { log: (...a: unknown[]) => void; proxy: () => string | undefined };

  constructor(o: CodexGatewayOptions = {}) {
    this.o = {
      upstream: o.upstream ?? DEFAULT_UPSTREAM, proxy: o.proxy ?? (() => undefined), log: o.log ?? (() => {}),
      connectMs: o.connectMs ?? 10_000, firstFrameMs: o.firstFrameMs ?? 25_000, idleFrameMs: o.idleFrameMs ?? 300_000,
      pingMs: o.pingMs ?? 30_000, maxAgeMs: o.maxAgeMs ?? 50 * 60_000, sessionMs: o.sessionMs ?? 30 * 60_000, maxSessions: o.maxSessions ?? 8,
    };
  }

  /** What pi's `baseUrl` for the provider is: pi adds `/codex/responses`, as it does to chatgpt.com's `/backend-api`. */
  async baseUrl(): Promise<string> { return `http://127.0.0.1:${await this.start()}/backend-api`; }

  start(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const wss = this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
      const server = this.server = createServer((req, res) => { this.serveHttp(req, res).catch((e) => { this.o.log(`codex-gateway: http: ${msg(e)}`); if (!res.headersSent) res.writeHead(502); res.end(); }); });
      server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => { this.serveWs(ws, headersOf(req.headers)); });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        this.timer = setInterval(() => this.maintain(), this.o.pingMs);
        this.timer.unref();
        resolve((server.address() as { port: number }).port);
      });
    });
    return this.starting;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values()) s.conn?.close();
    this.sessions.clear();
    this.wss?.clients.forEach((c) => c.terminate());
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  // -- the local side ----------------------------------------------------------------------------------------------

  private serveWs(ws: WebSocket, headers: Hdr): void {
    const client = clientOf(ws);
    ws.on("error", () => {});
    let chain = Promise.resolve();
    ws.on("message", (data) => {
      const text = data.toString();
      chain = chain.then(async () => {
        let frame: Frame;
        try { frame = JSON.parse(text); } catch { return; }
        if (frame.type !== "response.create") return;
        const { type: _type, ...body } = frame;
        try {
          await this.run(body, headers, (t) => { if (ws.readyState === WebSocket.OPEN) ws.send(t); }, client);
        } catch (e) {
          this.o.log(`codex-gateway: ws request failed: ${msg(e)}`);
          // pi takes a close as a failure of the transport and goes on to its SSE fallback, which comes back here.
          try { ws.close(1011, "upstream unavailable"); } catch { /* gone */ }
        }
      });
    });
  }

  private async serveHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !/\/codex\/responses\/?$/.test(req.url ?? "")) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const headers = headersOf(req.headers);
    let body: Frame | undefined;
    try {
      const enc = headers["content-encoding"];
      const text = enc === "zstd" ? (zlib as any).zstdDecompressSync(raw).toString("utf8") : raw.toString("utf8");
      body = JSON.parse(text);
    } catch { /* forwarded as it is below */ }
    this.stats.sse++;
    const client = clientOf(res);
    if (body) {
      let started = false;
      try {
        await this.run(body, headers, (t) => {
          if (!started) { started = true; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); }
          res.write(`data: ${t}\n\n`);
        }, client);
        res.end();
        return;
      } catch (e) {
        if (started) { res.end(); return; }
        this.o.log(`codex-gateway: no upstream websocket for an SSE request (${msg(e)}); posting it as it is`);
      }
    }
    this.stats.httpFallbacks++;
    await this.httpForward(raw, headers, res);
  }

  /** The POST as pi made it, to the same host over the same way: the answer comes back as it is. */
  private async httpForward(raw: Buffer, headers: Hdr, res: ServerResponse): Promise<void> {
    const u = new URL(this.o.upstream);
    const secure = u.protocol === "wss:" || u.protocol === "https:";
    const port = Number(u.port) || (secure ? 443 : 80);
    let sock: Socket;
    try { sock = await openSocket({ host: u.hostname, port, tls: secure }, this.o.proxy(), this.o.connectMs); }
    catch (e) { res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `cannot reach Codex: ${msg(e)}` } })); return; }
    await new Promise<void>((resolve) => {
      const out = httpRequest({ createConnection: () => sock, host: u.hostname, port, path: u.pathname, method: "POST", headers: { ...passHeaders(headers), host: u.host, "content-length": String(raw.length), ...(headers["content-type"] ? { "content-type": headers["content-type"] } : {}), ...(headers["content-encoding"] ? { "content-encoding": headers["content-encoding"] } : {}), ...(headers.accept ? { accept: headers.accept } : {}) } }, (r) => {
        res.writeHead(r.statusCode ?? 502, { ...(r.headers["content-type"] ? { "content-type": r.headers["content-type"] } : {}), "cache-control": "no-cache" });
        r.pipe(res);
        r.once("end", resolve); r.once("error", () => { res.end(); resolve(); });
      });
      out.once("error", (e) => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `cannot reach Codex: ${msg(e)}` } })); resolve(); });
      res.once("close", () => { out.destroy(); sock.destroy(); resolve(); });
      out.end(raw);
    });
  }

  // -- one request -------------------------------------------------------------------------------------------------

  private sessionOf(headers: Hdr, body: Frame): Sess {
    const key = `${headers["chatgpt-account-id"] ?? ""}|${headers["session-id"] || headers["x-client-request-id"] || (typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "") || "-"}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, headers, touched: Date.now(), outputs: [] };
      this.sessions.set(key, s);
      if (this.sessions.size > this.o.maxSessions) {
        const oldest = [...this.sessions.values()].filter((x) => x !== s && !x.conn?.busy).sort((a, b) => a.touched - b.touched)[0];
        if (oldest) { oldest.conn?.close(); this.sessions.delete(oldest.key); }
      }
    }
    s.headers = headers;
    s.touched = Date.now();
    return s;
  }

  /**
   * One response.create: the frames of the answer go to `emit` as they come. Resolves when the answer is over (completed or not).
   * Rejects when nothing could be got from upstream (nothing was emitted).
   */
  private async run(body: Frame, headers: Hdr, emit: Emit, client: Client): Promise<void> {
    const S = this.sessionOf(headers, body);
    const { input: clientInput, previous_response_id: clientPrev, ...rest } = body;
    const restJson = JSON.stringify(rest);
    const items: Frame[] | undefined = Array.isArray(clientInput) ? clientInput : clientInput === undefined ? [] : undefined;
    // The whole input this request stands for: what it carries, or (a delta pi built inside a process) the last whole input, what came back, and the delta.
    let full: Frame[] | undefined;
    let fullJson: Array<string | null> | undefined;
    if (!clientPrev) { full = items; fullJson = items?.map((x) => JSON.stringify(x)); }
    else if (items && S.full && S.fullJson && S.lastResponseId === clientPrev && S.restJson === restJson) {
      full = [...S.full, ...S.outputs, ...items];
      fullJson = [...S.fullJson, ...S.outputs.map(() => null), ...items.map((x) => JSON.stringify(x))];
    }

    type Plan = { conn?: Up; frame: Frame; delta: boolean };
    const plans: Plan[] = [];
    const sc = S.conn;
    if (sc?.open && !sc.busy && S.lastResponseId && sc.lastResponseId === S.lastResponseId && S.restJson === restJson) {
      if (clientPrev === S.lastResponseId) plans.push({ conn: sc, frame: body, delta: true });
      else if (full && S.full && S.fullJson) {
        const at = this.baseline(S, full);
        if (at >= 0) plans.push({ conn: sc, frame: { ...rest, previous_response_id: S.lastResponseId, input: full.slice(at) }, delta: true });
      }
    }
    if (full) plans.push({ frame: { ...rest, input: full }, delta: false });
    else plans.push({ conn: sc?.open && !sc.busy ? sc : undefined, frame: body, delta: !!clientPrev }); // a continuation the gateway does not know: as it came
    const fullPlan = plans.find((p) => !p.delta);
    let retried = false;
    let lastError: unknown = new Error("no connection");

    while (plans.length) {
      const plan = plans.shift()!;
      if (client.closed) return;
      let conn: Up | undefined;
      let result: { outcome: Outcome; started: boolean; error?: unknown; held?: string } | undefined;
      try { conn = plan.conn ?? (await this.take(S)); }
      catch (e) { lastError = e; }
      if (conn) {
        if (plan.conn) this.stats.reuses++;
        if (plan.delta) this.stats.deltas++; else this.stats.fulls++;
        result = await this.exchange(S, conn, plan.frame, emit, client, full && fullJson ? { full, json: fullJson } : undefined, restJson);
        if (result.outcome === "ok" || result.outcome === "ended" || result.outcome === "aborted") return;
        if (result.outcome === "notfound") {
          if (plans.length) { this.stats.recoveries++; continue; }
          emit(result.held!); // nothing better to send: pi's own recovery gets the error
          return;
        }
        lastError = result.error;
        if (result.started) throw lastError;
      }
      // Nothing came back: one more try, on a new connection with the whole input (the next plan is that when there is one).
      if (plans.length) { retried = true; this.stats.retries++; }
      else if (!retried && !client.closed) { retried = true; this.stats.retries++; plans.push(fullPlan ?? plan); }
    }
    throw lastError;
  }

  /** Where the new whole input continues the last one: the number of items already held upstream, or -1. */
  private baseline(S: Sess, full: Frame[]): number {
    const n = S.fullJson!.length;
    const m = S.outputs.length;
    if (full.length <= n + m) return -1;
    const kind = (x: Frame | undefined) => `${x?.type}|${x?.type === "function_call" ? x.call_id : ""}`;
    for (let i = 0; i < n; i++) {
      const want = S.fullJson![i];
      if (want === null ? kind(full[i]) !== kind(S.full![i]) : JSON.stringify(full[i]) !== want) return -1;
    }
    for (let i = 0; i < m; i++) if (kind(full[n + i]) !== kind(S.outputs[i])) return -1;
    return n + m;
  }

  /** Send one frame on a connection and relay the answer. `held`: an error that was not passed on (see `notfound`). */
  private exchange(S: Sess, conn: Up, frame: Frame, emit: Emit, client: Client, whole: { full: Frame[]; json: Array<string | null> } | undefined, restJson: string): Promise<{ outcome: Outcome; started: boolean; error?: unknown; held?: string }> {
    return new Promise((resolve) => {
      conn.busy = true;
      conn.lastResponseId = undefined;
      let started = false;
      const outputs: Frame[] = [];
      let timer: NodeJS.Timeout | undefined;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish({ outcome: "dead", error: new Error(started ? "the stream went quiet" : "no answer from Codex") }), started ? this.o.idleFrameMs : this.o.firstFrameMs); };
      let unsubscribe = () => {};
      const finish = (r: { outcome: Outcome; error?: unknown; held?: string }) => {
        clearTimeout(timer);
        unsubscribe();
        conn.ws.off("message", onMessage); conn.ws.off("close", onClose); conn.ws.off("error", onError);
        conn.busy = false;
        if (r.outcome === "ok") {
          // One connection per session: a spare one made for a request that came while the first was busy is let go.
          if (S.conn && S.conn !== conn && S.conn.open && !S.conn.busy) S.conn.close();
          S.conn = conn;
        } else if (r.outcome === "ended" || r.outcome === "notfound") {
          conn.lastResponseId = undefined; S.lastResponseId = undefined;
          if (!S.conn?.open) S.conn = conn; else if (S.conn !== conn && !S.conn.busy) conn.close();
        } else {
          conn.close();
          if (S.conn === conn) S.conn = undefined;
          S.lastResponseId = undefined;
        }
        resolve({ ...r, started });
      };
      const onMessage = (data: WebSocket.RawData) => {
        const text = data.toString();
        let ev: Frame | undefined;
        try { ev = JSON.parse(text); } catch { /* relayed as it is */ }
        const type = typeof ev?.type === "string" ? ev.type : "";
        if (!started && type === "error" && text.includes("previous_response_not_found")) { finish({ outcome: "notfound", held: text }); return; }
        started = true;
        arm();
        if (type === "response.output_item.done" && ev?.item) outputs.push(ev.item);
        emit(text);
        if (!TERMINAL.has(type)) return;
        if (type === "response.completed" || type === "response.done") {
          const id = ev?.response?.id;
          const out = Array.isArray(ev?.response?.output) && ev!.response.output.length ? ev!.response.output : outputs;
          if (typeof id === "string" && whole) {
            S.full = whole.full; S.fullJson = whole.json; S.outputs = out; S.restJson = restJson; S.lastResponseId = id;
            conn.lastResponseId = id;
          } else if (typeof id === "string") {
            S.full = undefined; S.fullJson = undefined; S.outputs = []; S.lastResponseId = id; S.restJson = restJson;
            conn.lastResponseId = id;
          }
          finish({ outcome: "ok" });
        } else finish({ outcome: "ended" });
      };
      const onClose = () => finish({ outcome: "dead", error: new Error("the Codex connection closed") });
      const onError = (e: Error) => finish({ outcome: "dead", error: e });
      conn.ws.on("message", onMessage); conn.ws.once("close", onClose); conn.ws.once("error", onError);
      unsubscribe = client.onClose(() => finish({ outcome: "aborted" }));
      arm();
      try { conn.ws.send(JSON.stringify({ type: "response.create", ...frame })); } catch (e) { finish({ outcome: "dead", error: e }); }
    });
  }

  // -- the pool ----------------------------------------------------------------------------------------------------

  /** A connection for this session: its own when it is free and open, else a new one. */
  private async take(S: Sess): Promise<Up> {
    const c = S.conn;
    if (c?.open && !c.busy && Date.now() - c.createdAt < this.o.maxAgeMs) return c;
    if (S.connecting) { try { const up = await S.connecting; if (up.open && !up.busy) return up; } catch { /* a new try below */ } }
    return this.connect(S);
  }

  private connect(S: Sess): Promise<Up> {
    const p = this.dial(S).then((up) => { if (!S.conn?.busy) S.conn = up; return up; });
    S.connecting = p;
    const clear = () => { if (S.connecting === p) S.connecting = undefined; };
    p.then(clear, clear);
    return p;
  }

  private async dial(S: Sess): Promise<Up> {
    const u = new URL(this.o.upstream);
    const secure = u.protocol === "wss:";
    const port = Number(u.port) || (secure ? 443 : 80);
    const proxy = this.o.proxy();
    const t0 = Date.now();
    const ws = new WebSocket(u.toString(), {
      headers: { ...passHeaders(S.headers), "openai-beta": WS_BETA }, perMessageDeflate: true, handshakeTimeout: this.o.connectMs, maxPayload: MAX_PAYLOAD,
      createConnection: ((_o: unknown, cb: (e: Error | null, s?: Socket) => void) => { openSocket({ host: u.hostname, port, tls: secure }, proxy, this.o.connectMs).then((s) => cb(null, s), (e) => cb(e)); }) as never,
    });
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => { ws.terminate(); reject(new Error(`connect timeout after ${this.o.connectMs}ms`)); }, this.o.connectMs + 2000);
      ws.once("open", () => { clearTimeout(guard); resolve(); });
      ws.once("error", (e) => { clearTimeout(guard); reject(e); });
      ws.once("unexpected-response", (_req, resp) => { clearTimeout(guard); resp.resume(); reject(new Error(`Codex refused the connection (${resp.statusCode})`)); });
    });
    this.stats.connects++;
    this.o.log(`codex-gateway: connected to Codex in ${Date.now() - t0}ms${proxy ? " through the proxy" : ""}`);
    const up = new Up(ws, S.key);
    ws.on("pong", () => { up.alive = true; });
    ws.once("close", () => { up.dead = true; });
    return up;
  }

  /** Every `pingMs`: ping what is idle, end what did not answer, renew the connections of sessions in use, drop the sessions long unused. */
  private maintain(): void {
    const now = Date.now();
    for (const S of this.sessions.values()) {
      const c = S.conn;
      if (now - S.touched > this.o.sessionMs) { c?.close(); this.sessions.delete(S.key); continue; }
      if (c?.open && !c.busy) {
        if (!c.alive) { c.close(); S.lastResponseId = undefined; }
        else { c.alive = false; try { c.ws.ping(); } catch { c.close(); } }
      }
      const old = c && now - c.createdAt > this.o.maxAgeMs - 2 * this.o.pingMs;
      if ((!c || !c.open || old) && !c?.busy && !S.connecting) {
        // Renewed before the next turn needs it; a failure is only tried again at the next round.
        this.connect(S).then((up) => { if (c && c !== up && c.open && !c.busy) c.close(); }).catch((e) => this.o.log(`codex-gateway: renewing a connection: ${msg(e)}`));
      }
    }
  }
}
