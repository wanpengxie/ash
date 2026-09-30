import assert from "node:assert/strict";
import { request, type IncomingMessage, type Server } from "node:http";
import { afterEach, test } from "node:test";
import { type Res, type Router, startServer } from "../src/server";

const servers = new Set<Server>();
const intervals = new Set<NodeJS.Timeout>();
afterEach(async () => {
  for (const server of servers) {
    if (server.listening) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  }
  servers.clear();
  for (const interval of intervals) clearInterval(interval);
  intervals.clear();
});

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), "SSE cleanup did not run");
}

function fixture(delayed = false) {
  let release: ((value: Res) => void) | undefined;
  let entered: (() => void) | undefined;
  const handling = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<Res>((resolve) => { release = resolve; });
  let subscriptions = 0;
  let unsubscriptions = 0;
  const response: Res = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    stream: (write, onClose) => {
      subscriptions++;
      const beat = setInterval(() => write(": keepalive\n\n"), 25_000);
      intervals.add(beat);
      onClose(() => {
        clearInterval(beat);
        intervals.delete(beat);
        unsubscriptions++;
      });
      write(": ready\n\n");
    },
  };
  const router = {
    localCaller: () => null,
    handle: async () => {
      entered?.();
      return delayed ? held : response;
    },
  } as unknown as Router;
  return {
    router, handling,
    release: () => release?.(response),
    counts: () => ({ subscriptions, unsubscriptions, intervals: intervals.size }),
  };
}

async function listen(router: Router) {
  const server = await startServer(router, "127.0.0.1", 0);
  servers.add(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/stream` };
}

function open(url: string): Promise<{ response: IncomingMessage; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = request(url);
    req.on("error", reject);
    req.on("response", (response) => resolve({ response, close: () => response.destroy() }));
    req.end();
  });
}

test("SSE disconnect cancels keepalive and subscription exactly once", async () => {
  const f = fixture();
  const { url } = await listen(f.router);
  const client = await open(url);
  assert.equal(f.counts().subscriptions, 1);
  client.close();
  await settle(() => f.counts().unsubscriptions === 1);
  assert.deepEqual(f.counts(), { subscriptions: 1, unsubscriptions: 1, intervals: 0 });
});

test("server shutdown closes an active SSE subscription and keepalive", async () => {
  const f = fixture();
  const { server, url } = await listen(f.router);
  const client = await open(url);
  assert.equal(f.counts().subscriptions, 1);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await settle(() => f.counts().unsubscriptions === 1);
  assert.deepEqual(f.counts(), { subscriptions: 1, unsubscriptions: 1, intervals: 0 });
  client.close();
});

test("disconnect before async route completes still cleans late SSE setup", async () => {
  const f = fixture(true);
  const { url } = await listen(f.router);
  const req = request(url);
  req.on("error", () => {});
  req.end();
  await f.handling;
  req.destroy();
  await new Promise<void>((resolve) => req.once("close", resolve));
  f.release();
  await settle(() => f.counts().unsubscriptions === 1);
  assert.deepEqual(f.counts(), { subscriptions: 1, unsubscriptions: 1, intervals: 0 });
});
