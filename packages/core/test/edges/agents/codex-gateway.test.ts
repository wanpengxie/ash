/**
 * The Codex gateway against a stand-in for Codex's WebSocket (a local `ws` server that keeps response state per connection, as the real
 * one does): the pool kept between two "pi processes" (two local connections), the delta of a continued session, a delta the server
 * cannot find, a connection that dies under a request, SSE served from the same pool, the way through a CONNECT proxy, and the login
 * never reaching a log.
 */
import assert from "node:assert/strict";
import { createServer as httpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as netServer, connect as netConnect, type Server as NetServer } from "node:net";
import test, { after } from "node:test";
import * as zlib from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { CodexGateway } from "../../../src/edges/agents/pi/codex-gateway";

const TOKEN = "tok-SECRET-0123456789";
const closers: Array<() => Promise<void> | void> = [];
after(async () => { for (const c of closers.reverse()) await c(); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, what: string) => { const end = Date.now() + 5000; while (!pred()) { if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await wait(10); } };

interface Seen { conn: number; frame: Record<string, any> }
interface Upstream {
  url: string; port: number; seen: Seen[]; conns: number; handshakes: Record<string, string>[];
  /** What the next request does instead of answering. */
  next?: "drop" | "silent"; dropAlways?: boolean;
  forget(): void; sockets: Set<WebSocket>;
}

/** Codex's side: every response.create is answered with a message item and response.completed `resp_<n>`; a previous_response_id has to be the last one of that connection. */
async function upstream(): Promise<Upstream> {
  const http = httpServer((req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ server: http });
  const state: Upstream = { url: "", port: 0, seen: [], conns: 0, handshakes: [], forget() { for (const s of state.sockets) (s as any).last = undefined; }, sockets: new Set() };
  let n = 0;
  wss.on("connection", (ws, req: IncomingMessage) => {
    const conn = ++state.conns;
    state.handshakes.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])));
    state.sockets.add(ws);
    ws.on("close", () => state.sockets.delete(ws));
    (ws as any).last = undefined;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      state.seen.push({ conn, frame });
      if (state.dropAlways || state.next === "drop") { state.next = undefined; ws.terminate(); return; }
      if (state.next === "silent") { state.next = undefined; return; }
      if (frame.previous_response_id && frame.previous_response_id !== (ws as any).last) {
        ws.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", code: "previous_response_not_found", message: "Previous response not found" } }));
        return;
      }
      const id = `resp_${++n}`;
      ws.send(JSON.stringify({ type: "response.created", response: { id } }));
      const item = { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: `answer ${n}` }] };
      ws.send(JSON.stringify({ type: "response.output_item.done", item }));
      ws.send(JSON.stringify({ type: "response.completed", response: { id, output: [item] } }));
      (ws as any).last = id;
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  state.port = (http.address() as { port: number }).port;
  state.url = `ws://127.0.0.1:${state.port}/backend-api/codex/responses`;
  closers.push(() => { for (const s of state.sockets) s.terminate(); wss.close(); http.close(); http.closeAllConnections(); });
  return state;
}

async function gateway(up: Upstream, extra: Partial<ConstructorParameters<typeof CodexGateway>[0]> = {}) {
  const logs: string[] = [];
  const gw = new CodexGateway({ upstream: up.url, log: (...a) => logs.push(a.join(" ")), connectMs: 1500, firstFrameMs: 1500, ...extra });
  const base = await gw.baseUrl();
  closers.push(() => gw.close());
  return { gw, logs, base, wsUrl: base.replace("http:", "ws:") + "/codex/responses" };
}

const headers = (session: string) => ({ authorization: `Bearer ${TOKEN}`, "chatgpt-account-id": "acct1", "session-id": session, "x-client-request-id": session, originator: "pi", "openai-beta": "responses_websockets=2026-02-06" });
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const BODY = { model: "gpt-6-luna", store: false, stream: true, instructions: "be brief", tools: [], prompt_cache_key: "k" };

/** What pi does: a local WebSocket for the process, response.create frames, and a close when the process ends. */
class PiClient {
  ws!: WebSocket; frames: Record<string, any>[] = []; closed = false;
  async open(url: string, session: string) {
    this.ws = new WebSocket(url, { headers: headers(session) });
    this.ws.on("message", (d) => this.frames.push(JSON.parse(d.toString())));
    this.ws.on("close", () => { this.closed = true; });
    this.ws.on("error", () => {});
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); });
    return this;
  }
  async ask(body: Record<string, any>) {
    const from = this.frames.length;
    this.ws.send(JSON.stringify({ type: "response.create", ...body }));
    await until(() => this.frames.slice(from).some((f) => f.type === "response.completed" || f.type === "error") || this.closed, "the answer");
    return this.frames.slice(from);
  }
  end() { this.ws.close(); }
}
const completed = (frames: Record<string, any>[]) => frames.find((f) => f.type === "response.completed")?.response;

test("a new pi process finds the connection of its session kept: one upstream connection for two processes, and only the new input is sent", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  const r1 = completed(await a.ask({ ...BODY, input: [user("one")] }));
  a.end(); // the process ends
  await until(() => a.closed, "the first process to end");
  const b = await new PiClient().open(g.wsUrl, "s1");
  // a fresh process sends the whole input: the first one, what came back (as pi renders it), and the new message
  const r2 = completed(await b.ask({ ...BODY, input: [user("one"), { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "answer 1" }] }, user("two")] }));
  assert.equal(up.conns, 1, "the upstream connection was kept");
  assert.equal(up.seen.length, 2);
  assert.equal(up.seen[1]!.frame.previous_response_id, r1.id);
  assert.deepEqual(up.seen[1]!.frame.input, [user("two")], "only what is new");
  assert.equal(up.seen[1]!.frame.type, "response.create");
  assert.ok(r2.id !== r1.id);
  assert.equal(g.gw.stats.deltas, 1);
  assert.equal(up.handshakes[0]!["openai-beta"], "responses_websockets=2026-02-06");
  assert.equal(up.handshakes[0]!["session-id"], "s1");
  assert.equal(up.handshakes[0]!["chatgpt-account-id"], "acct1");
  assert.equal(up.handshakes[0]!.authorization, `Bearer ${TOKEN}`);
});

test("a request that does not continue the last (another instruction, a rewritten history) is sent whole", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  await a.ask({ ...BODY, instructions: "something else", input: [user("one"), { type: "message", role: "assistant", content: [] }, user("two")] });
  await a.ask({ ...BODY, input: [user("changed history")] });
  assert.equal(up.conns, 1);
  assert.deepEqual(up.seen.map((s) => s.frame.previous_response_id), [undefined, undefined, undefined]);
  assert.equal(up.seen[2]!.frame.input.length, 1);
});

test("a delta pi builds inside its process (its own previous_response_id) goes through as it is, and the session carries on from it", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  const r1 = completed(await a.ask({ ...BODY, input: [user("one")] }));
  const r2 = completed(await a.ask({ ...BODY, previous_response_id: r1.id, input: [user("two")] }));
  assert.deepEqual(up.seen[1]!.frame, { type: "response.create", ...BODY, previous_response_id: r1.id, input: [user("two")] });
  // a new process then sends everything: one, answer 1, two, answer 2, three
  const b = await new PiClient().open(g.wsUrl, "s1");
  const ans = (n: number) => ({ type: "message", role: "assistant", id: `m${n}`, content: [{ type: "output_text", text: `answer ${n}` }] });
  await b.ask({ ...BODY, input: [user("one"), ans(1), user("two"), ans(2), user("three")] });
  assert.equal(up.seen[2]!.frame.previous_response_id, r2.id);
  assert.deepEqual(up.seen[2]!.frame.input, [user("three")]);
  assert.equal(up.conns, 1);
});

test("sessions have their own connections, and each continues its own", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "front");
  const b = await new PiClient().open(g.wsUrl, "lane");
  const ra = completed(await a.ask({ ...BODY, input: [user("a1")] }));
  const rb = completed(await b.ask({ ...BODY, input: [user("b1")] }));
  assert.equal(up.conns, 2);
  assert.deepEqual(up.handshakes.map((h) => h["session-id"]).sort(), ["front", "lane"]);
  const ans = { type: "message", role: "assistant", content: [] };
  await a.ask({ ...BODY, input: [user("a1"), ans, user("a2")] });
  await b.ask({ ...BODY, input: [user("b1"), ans, user("b2")] });
  assert.equal(up.conns, 2);
  assert.equal(up.seen[2]!.frame.previous_response_id, ra.id);
  assert.equal(up.seen[3]!.frame.previous_response_id, rb.id);
});

test("a delta the server cannot find (previous_response_not_found) is sent again whole, and pi never sees the error", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  up.forget(); // the server lost its state
  const frames = await a.ask({ ...BODY, input: [user("one"), { type: "message", role: "assistant", content: [] }, user("two")] });
  assert.ok(completed(frames));
  assert.ok(!frames.some((f) => f.type === "error"));
  assert.equal(up.seen.length, 3);
  assert.ok(up.seen[1]!.frame.previous_response_id, "the delta was tried");
  assert.equal(up.seen[2]!.frame.previous_response_id, undefined);
  assert.equal(up.seen[2]!.frame.input.length, 3, "then the whole input");
  assert.equal(g.gw.stats.recoveries, 1);
});

test("a continuation the gateway does not know goes through as it is, and its not-found error reaches pi (which has its own recovery)", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  const frames = await a.ask({ ...BODY, previous_response_id: "resp_unknown", input: [user("x")] });
  assert.equal(frames[0]!.error.code, "previous_response_not_found");
});

test("a connection that dies under a request: the request is tried once more on a new connection, and pi gets its answer", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  up.next = "drop";
  const frames = await a.ask({ ...BODY, input: [user("one"), { type: "message", role: "assistant", content: [] }, user("two")] });
  assert.ok(completed(frames));
  assert.equal(up.conns, 2);
  assert.equal(g.gw.stats.retries, 1);
  assert.equal(up.seen.at(-1)!.frame.previous_response_id, undefined, "a new connection has no state: the whole input");
  assert.equal(a.closed, false);
});

test("a silent connection is taken for dead after the first-frame time, and the retry answers", async () => {
  const up = await upstream();
  const g = await gateway(up, { firstFrameMs: 300 });
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  up.next = "silent";
  assert.ok(completed(await a.ask({ ...BODY, input: [user("one"), { type: "message", role: "assistant", content: [] }, user("two")] })));
  assert.equal(g.gw.stats.retries, 1);
});

test("when the retry fails too, the local connection is closed (pi sees a transport failure and falls back to SSE)", async () => {
  const up = await upstream();
  up.dropAlways = true;
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  assert.ok(a.closed);
  assert.equal(up.conns, 2, "two tries, no more");
});

test("an upstream that cannot be reached closes the local connection and the SSE request answers 502 (the driver then goes to DeepSeek)", async () => {
  const dead = await upstream();
  const url = dead.url;
  for (const s of dead.sockets) s.terminate();
  const g = await gateway({ ...dead, url: url.replace(String(dead.port), "1") } as Upstream);
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  assert.ok(a.closed);
  const res = await fetch(g.base + "/codex/responses", { method: "POST", headers: { ...headers("s1"), "content-type": "application/json" }, body: JSON.stringify({ ...BODY, input: [user("one")] }) });
  assert.equal(res.status, 502);
  assert.match(await res.text(), /cannot reach Codex/);
});

const sse = (text: string) => text.split("\n\n").filter(Boolean).map((c) => JSON.parse(c.replace(/^data: /, "")));

test("SSE: a POST (zstd as pi sends it, or plain) is served from the same pool and the answer is an event stream", async () => {
  const up = await upstream();
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  const r1 = completed(await a.ask({ ...BODY, input: [user("one")] }));
  const body = JSON.stringify({ ...BODY, input: [user("one"), { type: "message", role: "assistant", content: [] }, user("two")] });
  const zstd = (zlib as any).zstdCompressSync;
  const res = await fetch(g.base + "/codex/responses", {
    method: "POST",
    headers: { ...headers("s1"), accept: "text/event-stream", "content-type": "application/json", ...(zstd ? { "content-encoding": "zstd" } : {}) },
    body: zstd ? zstd(Buffer.from(body)) : body,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = sse(await res.text());
  assert.deepEqual(events.map((e) => e.type), ["response.created", "response.output_item.done", "response.completed"]);
  assert.equal(up.conns, 1);
  assert.equal(up.seen[1]!.frame.previous_response_id, r1.id);
  assert.equal(g.gw.stats.sse, 1);
});

test("SSE with no WebSocket upstream: the POST goes out as it came, and the answer comes back as it is", async () => {
  const posts: Array<{ method?: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const http: Server = httpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { posts.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }); res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"type":"response.completed","response":{"id":"r"}}\n\n'); });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  closers.push(() => { http.close(); http.closeAllConnections(); });
  const port = (http.address() as { port: number }).port;
  const g = await gateway({ url: `ws://127.0.0.1:${port}/backend-api/codex/responses` } as Upstream);
  const body = JSON.stringify({ ...BODY, input: [user("one")] });
  const res = await fetch(g.base + "/codex/responses", { method: "POST", headers: { ...headers("s1"), "content-type": "application/json", accept: "text/event-stream" }, body });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /response\.completed/);
  const post = posts.find((p) => p.method === "POST")!;
  assert.equal(post.body, body);
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(g.gw.stats.httpFallbacks, 1);
});

test("through a CONNECT proxy: the upstream connection is a tunnel the proxy opened to the Codex host", async () => {
  const up = await upstream();
  const seen: string[] = [];
  const proxy: NetServer = netServer((sock) => {
    let head = "";
    sock.on("data", function onData(c) {
      head += c.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      sock.off("data", onData);
      const m = /^CONNECT ([^ ]+) /.exec(head);
      seen.push(m?.[1] ?? "?");
      const out = netConnect({ host: "127.0.0.1", port: up.port }, () => { sock.write("HTTP/1.1 200 Connection established\r\n\r\n"); out.pipe(sock); sock.pipe(out); });
      out.on("error", () => sock.destroy()); sock.on("error", () => out.destroy());
    });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  closers.push(() => { proxy.close(); });
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const g = await gateway(up, { proxy: () => proxyUrl });
  const a = await new PiClient().open(g.wsUrl, "s1");
  assert.ok(completed(await a.ask({ ...BODY, input: [user("one")] })));
  assert.deepEqual(seen, [`127.0.0.1:${up.port}`]);
  assert.ok(!g.logs.some((l) => l.includes(proxyUrl)), "the proxy address is not logged");
});

test("a proxy that refuses the tunnel is a failed connection (and the request is not lost silently)", async () => {
  const up = await upstream();
  const proxy: NetServer = netServer((sock) => { sock.once("data", () => { sock.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); }); sock.on("error", () => {}); });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  closers.push(() => { proxy.close(); });
  const g = await gateway(up, { proxy: () => `http://127.0.0.1:${(proxy.address() as { port: number }).port}` });
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  assert.ok(a.closed);
  assert.equal(up.conns, 0);
  assert.ok(g.logs.some((l) => /proxy refused the tunnel \(HTTP\/1.1 503/.test(l)));
});

test("an idle connection that the server drops is renewed in the background: the next turn finds one open", async () => {
  const up = await upstream();
  const g = await gateway(up, { pingMs: 60 });
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  for (const s of up.sockets) s.terminate();
  await until(() => up.conns === 2, "the renewal");
  await wait(50);
  assert.ok(completed(await a.ask({ ...BODY, input: [user("one"), { type: "message", role: "assistant", content: [] }, user("two")] })));
  assert.equal(up.conns, 2);
  assert.equal(g.gw.stats.retries, 0);
});

test("the login never reaches a log, and the gateway answers only on 127.0.0.1", async () => {
  const up = await upstream();
  up.dropAlways = true;
  const g = await gateway(up);
  const a = await new PiClient().open(g.wsUrl, "s1");
  await a.ask({ ...BODY, input: [user("one")] });
  await fetch(g.base + "/codex/responses", { method: "POST", headers: { ...headers("s1"), "content-type": "application/json" }, body: JSON.stringify({ ...BODY, input: [user("one")] }) }).then((r) => r.text());
  assert.ok(g.logs.length > 0);
  assert.ok(!g.logs.some((l) => l.includes(TOKEN) || /acct1|bearer/i.test(l)), g.logs.join("\n"));
  assert.match(g.base, /^http:\/\/127\.0\.0\.1:\d+\/backend-api$/);
});
