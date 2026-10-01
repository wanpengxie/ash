import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import test from "node:test";
import { AshClient } from "../src/client";
import { AshApiError, AUTH_SCOPE_EVENT, MESSAGE_SUMMARY_EVENT, POST_DELIVERY_SNAPSHOT_EVENT, STREAM_PAGE_END_EVENT } from "../src/api";

const scope = `v1_${"a".repeat(43)}`;
const nextScope = `v1_${"b".repeat(43)}`;
const row = (seq: number) => ({ seq, id: `m${seq}`, ts: seq, from: "agent:main", to: "person:owner", kind: "event", word: "status", body: { state: "idle" } });
const sse = (seq: number) => `id: ${seq}\ndata: ${JSON.stringify(row(seq))}\n\n`;
const control = (name: string, body: unknown) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`;

async function serve(handler: RequestListener): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test address");
  return { server, url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("v2 client sends and describes only current routes with server errors intact", async () => {
  const paths: string[] = [];
  const fixture = await serve(async (req, res) => {
    paths.push(req.url ?? "");
    assert.equal(req.headers.authorization, "Bearer synthetic-token");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/describe?member=agent%3Amain") return void res.end(JSON.stringify({ members: [{ id: "agent:main", kind: "agent", name: "Echo", words: [] }] }));
    if (req.url === "/api/send") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const sent = JSON.parse(body);
      assert.deepEqual(sent, { to: "agent:main", kind: "request", word: "say", body: { text: "hi" }, client_id: "retry-key", wait: true });
      return void res.end(JSON.stringify({ id: "m1", seq: 1 }));
    }
    res.writeHead(404).end(JSON.stringify({ error: "not_found", message: "missing" }));
  });
  try {
    const client = new AshClient(fixture.url, "synthetic-token");
    assert.equal((await client.describe("agent:main")).members[0].id, "agent:main");
    assert.deepEqual(await client.send({ to: "agent:main", kind: "request", word: "say", body: { text: "hi" }, client_id: "retry-key", wait: true }), { id: "m1", seq: 1 });
    assert.deepEqual(paths, ["/api/describe?member=agent%3Amain", "/api/send"]);
    await assert.rejects(client.describe("unknown"), (error: unknown) => error instanceof AshApiError && error.status === 404 && error.code === "not_found");
  } finally { await fixture.close(); }
});

test("SSE fragmented CRLF frames, controls and reconnect use last delivered seq exactly once", async () => {
  const cursors: (string | undefined)[] = [];
  let visits = 0;
  const fixture = await serve((req, res) => {
    assert.equal(req.url, visits === 0 ? "/api/stream?after=0" : "/api/stream");
    cursors.push(req.headers["last-event-id"] as string | undefined);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const prefix = control(AUTH_SCOPE_EVENT, { auth_scope: scope });
    if (++visits === 1) {
      res.write(prefix.replaceAll("\n", "\r\n").slice(0, 15));
      res.write(prefix.replaceAll("\n", "\r\n").slice(15));
      res.write(sse(1).replaceAll("\n", "\r\n"));
      res.end("id: 2\ndata: {\"partial\":true");
    } else {
      res.write(prefix);
      res.write(sse(1)); // server replay must not duplicate delivery
      res.write(sse(2));
      res.write(control(STREAM_PAGE_END_EVENT, { has_more: false, first_seq: 1, last_seq: 2 }));
      res.end();
    }
  });
  const controller = new AbortController();
  try {
    const client = new AshClient(fixture.url, "synthetic-token", { retryMs: 1 });
    const received: string[] = [];
    for await (const frame of client.stream({ after: 0, signal: controller.signal })) {
      received.push(frame.type === "message" ? `m${frame.message.seq}` : frame.type);
      if (frame.type === "message" && frame.message.seq === 2) { controller.abort(); break; }
    }
    assert.deepEqual(received.filter((entry) => entry.startsWith("m")), ["m1", "m2"]);
    assert.deepEqual(cursors, [undefined, "1"]);
    assert.equal(client.lastSeq, 2);
    assert.equal(client.authScope, scope);
  } finally { controller.abort(); await fixture.close(); }
});

test("stream rejects identity change before emitting later rows and fails closed on 401", async () => {
  let visits = 0;
  const fixture = await serve((_req, res) => {
    if (++visits === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(control(AUTH_SCOPE_EVENT, { auth_scope: scope }) + sse(1));
    } else if (visits === 2) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(control(AUTH_SCOPE_EVENT, { auth_scope: nextScope }) + sse(2));
    } else res.writeHead(401).end(JSON.stringify({ error: "forbidden", message: "revoked" }));
  });
  try {
    const client = new AshClient(fixture.url, "synthetic-token", { retryMs: 1 });
    const seen: number[] = [];
    await assert.rejects(async () => { for await (const frame of client.stream({ after: 0 })) if (frame.type === "message") seen.push(frame.message.seq); },
      (error: unknown) => error instanceof AshApiError && error.code === "auth_scope_changed");
    assert.deepEqual(seen, [1]);
    const other = new AshClient(fixture.url, "synthetic-token", { retryMs: 1 });
    await assert.rejects(async () => { for await (const _frame of other.stream({ after: 1 })) {} },
      (error: unknown) => error instanceof AshApiError && error.status === 401);
  } finally { await fixture.close(); }
});

test("empty initial stream reconnects with after=0, never falling back to a truncated latest window", async () => {
  const paths: string[] = [];
  let visits = 0;
  const fixture = await serve((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(control(AUTH_SCOPE_EVENT, { auth_scope: scope }));
    if (++visits === 1) return void res.end();
    for (let seq = 1; seq <= 205; seq++) res.write(sse(seq));
    res.end();
  });
  const controller = new AbortController();
  try {
    const client = new AshClient(fixture.url, "synthetic-token", { retryMs: 1 });
    let count = 0;
    for await (const frame of client.stream({ signal: controller.signal, limit: 1 })) {
      if (frame.type === "message" && ++count === 205) { controller.abort(); break; }
    }
    assert.equal(count, 205);
    assert.deepEqual(paths.slice(0, 2), ["/api/stream?limit=1", "/api/stream?after=0&limit=1"]);
  } finally { controller.abort(); await fixture.close(); }
});

test("finite summary page exposes snapshots and boundary without counting them as messages", async () => {
  const fixture = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const summary = { ...row(3), summary: true, body_summary: { state: "idle" } } as Record<string, unknown>;
    delete summary.body;
    res.end(control(AUTH_SCOPE_EVENT, { auth_scope: scope }) +
      control(POST_DELIVERY_SNAPSHOT_EVENT, { at_seq: 4, items: [{ message_id: "m3", state: "released", version_seq: 4 }] }) +
      `id: 3\nevent: ${MESSAGE_SUMMARY_EVENT}\ndata: ${JSON.stringify(summary)}\n\n` +
      control(STREAM_PAGE_END_EVENT, { has_more: false, first_seq: 3, last_seq: 3 }));
  });
  try {
    const client = new AshClient(fixture.url, "synthetic-token");
    const types: string[] = [];
    for await (const frame of client.stream({ follow: false, summary: true })) types.push(frame.type);
    assert.deepEqual(types, ["scope", "snapshot", "message", "page_end"]);
    assert.equal(client.lastSeq, 3);
  } finally { await fixture.close(); }
});
