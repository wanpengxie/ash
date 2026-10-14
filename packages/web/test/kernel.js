// A kernel for the page's tests: the real link server of packages/link, with a small fake of the hub behind its human
// channel. It checks what the page sends against the word contracts (the word exists, the owner may call it, the body
// fits the input schema), keeps a ledger, answers `sync`, and lets a test play the other members (an agent that
// speaks, the gate that asks, a word's answer).
import Ajv from "ajv/dist/2020.js";
import { createLinkServer } from "../../link/src/server.ts";
import { memoryConnector } from "../../link/test/fixtures/memory.ts";
import { CLOSE_CODES } from "../../sdk/src/link.ts";
import { standardAction, standardContract } from "../../sdk/src/namespaces.ts";
import { wordContract } from "../../sdk/src/words.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../core/src/kernel/ledger/index.ts";
import { createWindowReader } from "../../core/src/services/history/window.ts";
import { createBlobsService } from "../../core/src/services/blobs/index.ts";

const ajv = new Ajv({ strict: false });
const checks = new Map();
const validator = (contract) => {
  if (!checks.has(contract)) checks.set(contract, ajv.compile(contract.input_schema));
  return checks.get(contract);
};

/** The contract of a word on a member; `body:<id>/workspace.*` and `device:<id>/...` come from the standard actions. */
export function contractOf(member, word) {
  const own = wordContract(member, word);
  if (own) return own;
  const action = standardAction(word);
  return action ? standardContract(action) : undefined;
}

/** A clock that makes reconnecting quick; the long timers (heartbeat 30 s, silence 90 s) are left alone. */
export const quickClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms < 20_000 ? 5 : ms),
  clearTimer: (handle) => clearTimeout(handle),
};

const ok = (data, content) => ({ ok: true, result: { ...(data !== undefined ? { data } : {}), ...(content ? { content } : {}) } });
const fail = (code, message) => ({ ok: false, error: { code, message } });
// A scripted answer is a Reply when it has the Reply's shape and nothing else; otherwise it is the word's data.
const isReply = (value) => value && typeof value === "object" && typeof value.ok === "boolean" && Object.keys(value).every((key) => ["ok", "result", "error"].includes(key));

export function startKernel({ local = true, grant = null, owner = "person:owner" } = {}) {
  let seq = 0;
  let reads = 0;
  let clientCount = 0;
  let clock = Date.now();
  const kernel = {
    ledger: [],
    /** Every request the page sent as the owner, in order. */
    requests: [],
    presence: [],
    synced: [],
    results: new Map(),
    handlers: new Map(),
    sessions: [],
    followers: new Set(),
    local,
    /** The answer to `<member>/<word>`: data, a `Reply`, or a function of (body, request) returning either. */
    on(member, word, answer) { this.handlers.set(`${member}/${word}`, answer); return this; },
    now: () => clock,
    tick(ms = 1000) { clock += ms; return clock; },
  };
  // Display APIs exercise the real append-time indexes and safe reader, rather than a second test-only projector.
  const directory = mkdtempSync(join(tmpdir(), "web-history-"));
  const historyLedger = Ledger.open(join(directory, "history.db"));
  const display = createWindowReader(historyLedger, () => clock);
  for (const word of ["window", "current", "confirm"]) kernel.on("service:history", word, body => display[word](body));
  kernel.on("service:history", "activity.page", body => display.activityPage(body));
  kernel.on("service:history", "read", body => ({ messages: historyLedger.page({ after: (body.from_seq ?? 1) - 1, before: body.to_seq === undefined ? undefined : body.to_seq + 1, limit: 1000 }), next_offset: null }));
  const blobs = createBlobsService(historyLedger);
  kernel.on("service:blobs", "read", async body => (await blobs.handle({ word: "read", body }, {})).data);

  kernel.handlers.set("service:agents/list", { agents: [{ id: "agent:main", name: "Ash", summary: "", state: "idle", primary: true }] });

  const row = (partial) => {
    const message = { seq: ++seq, id: partial.id ?? `m_${seq}`, ts: partial.ts ?? (clock += 1000), from: partial.from, to: partial.to ?? null,
      kind: partial.kind ?? (partial.to ? "request" : "event"), word: partial.word, body: partial.body ?? {}, ...(partial.reply_to ? { reply_to: partial.reply_to } : {}),
      ...(partial.origin ? { origin: partial.origin } : {}), ...(partial.turn ? { turn: partial.turn } : {}), ...(partial.thread ? { thread: partial.thread } : {}),
      summary: partial.summary ?? (typeof partial.body?.text === "string" ? partial.body.text : partial.word), size: 1 };
    const recorded = historyLedger.append(message, { summary: message.summary });
    kernel.ledger.push(recorded);
    for (const follower of kernel.followers) follower.push(recorded);
    return recorded;
  };
  /** Something another member said or did: it goes into the ledger and to every following sync. */
  kernel.append = (partial) => row(partial);
  // Initial fixtures use the real append/index path with one commit, before any browser subscribes.
  kernel.batch = (seed) => historyLedger.tx(seed);

  /** The page's frames, one connection. */
  const attach = (session) => {
    const client = `client:t${++clientCount}`;
    kernel.sessions.push(session);
    const syncs = new Map();
    const owned = { client, push: (message) => { for (const sync of syncs.values()) if (sync.follow && message.seq > sync.last) { sync.last = message.seq; session.send({ t: "sync.msg", sid: sync.sid, message }); } } };
    kernel.followers.add(owned);
    const presentWaiters = new Map();
    session.kernelPresent = (frame) => new Promise((resolve) => { presentWaiters.set(frame.id, resolve); session.send(frame); });
    const origin = { channel: "web", client, label: session.hello.channels.human?.label ?? "网页" };
    const dedupe = new Map();

    const respond = (message, reply) => (message.kind === "request" && message.to ? row({ from: message.to, to: owner, kind: "response", word: message.word, reply_to: message.id, body: reply }) : null);

    const handleSend = async (frame) => {
      const request = frame.request;
      kernel.requests.push(request);
      const reply = (result) => session.send({ t: "send.result", id: frame.id, ...result });
      const refuse = (code, message) => reply({ ok: false, error: { code, message } });
      if (request.kind === "response") {
        const earlier = request.client_id ? dedupe.get(request.client_id) : undefined;
        if (earlier) return JSON.stringify(earlier.request) === JSON.stringify(request) ? reply({ ok: true, message: earlier.message, duplicate: true }) : refuse("conflict", "same client_id, other content");
        // The owner answers an ask: the first answer counts.
        const ask = kernel.ledger.find((m) => m.id === request.reply_to);
        if (!ask || ask.word !== "ask" || ask.to !== owner || request.to !== ask.from) return refuse("not_found", "no such question");
        if (kernel.ledger.some((m) => m.kind === "response" && m.reply_to === ask.id)) return refuse("conflict", "already answered or ended");
        const choice = request.body?.result?.data?.choice;
        const offered = (ask.body.options?.map((o) => o.id) ?? (ask.body.human_kind === "confirmation" ? ["yes", "no"] : []));
        if (request.body?.ok === true && !offered.includes(choice) && ask.body.allow_custom !== true) return refuse("bad_request", `${choice} is not one of the options`);
        const message = row({ from: owner, to: ask.from, kind: "response", word: "ask", reply_to: ask.id, body: request.body, origin });
        const out = { message: { id: message.id, seq: message.seq } };
        if (request.client_id) dedupe.set(request.client_id, { request, message: out.message });
        kernel.onAnswer?.(ask, request.body, message);
        return reply({ ok: true, ...out });
      }

      const contract = request.to ? contractOf(request.to, request.word) : undefined;
      if (request.kind === "event") return refuse("forbidden", "the owner sends no events");
      if (!contract) return refuse("not_found", `${request.to} has no word ${request.word}`);
      if (request.kind === "request" && !contract.callers.includes("owner")) return refuse("forbidden", `${request.word} is not for the owner`);
      if (request.kind === "request" && !validator(contract)(request.body)) return refuse("bad_request", `${request.to}/${request.word}: ${ajv.errorsText(validator(contract).errors)}`);
      if (request.client_id) {
        const earlier = dedupe.get(request.client_id);
        if (earlier) {
          if (JSON.stringify(earlier.request) !== JSON.stringify(request)) return refuse("conflict", "same client_id, other content");
          return reply({ ok: true, message: earlier.message, duplicate: true, ...(earlier.response ? { response: earlier.response } : {}) });
        }
      }

      const message = contract.effect === "read" ? { id: `r_${++reads}`, seq: 0 } : row({ from: owner, to: request.to, kind: "request", word: request.word, body: request.body, origin, ...(request.reply_to ? { reply_to: request.reply_to } : {}) });
      const answer = kernel.handlers.get(`${request.to}/${request.word}`) ?? (contract.member === "agent:*" && request.word === "say" ? { accepted: true } : undefined);
      let response;
      try {
        const given = typeof answer === "function" ? await answer(request.body, request, message) : answer;
        response = given === undefined ? fail("not_found", `the test kernel has no answer for ${request.to}/${request.word}`) : isReply(given) ? given : ok(given);
      } catch (error) {
        response = fail("failed", error?.message ?? String(error));
      }
      if (contract.effect !== "read") respond({ ...message, kind: "request", to: request.to, word: request.word }, response);
      const out = { message: { id: message.id, seq: message.seq } };
      if (request.client_id) dedupe.set(request.client_id, { request, message: out.message, response: request.wait ? response : undefined });
      kernel.results.set(message.id, response);
      reply({ ok: true, ...out, ...(request.wait ? { response } : {}) });
    };

    const handleSync = (frame) => {
      kernel.synced.push(frame);
      const limit = Math.min(frame.limit ?? 200, 1000);
      const sync = { sid: frame.sid, follow: frame.follow === true, last: 0 };
      if (frame.before !== undefined && frame.follow) return session.send({ t: "error", id: frame.sid, code: "bad_request", message: "before cannot follow" });
      let pages;
      if (frame.after !== undefined) {
        const all = kernel.ledger.filter((m) => m.seq > frame.after);
        pages = [];
        for (let at = 0; at < all.length || !pages.length; at += limit) pages.push(all.slice(at, at + limit));
      } else if (frame.before !== undefined) pages = [kernel.ledger.filter((m) => m.seq < frame.before).slice(-limit)];
      else pages = [kernel.ledger.slice(-limit)];
      pages.forEach((messages, i) => {
        sync.last = Math.max(sync.last, ...messages.map((m) => m.seq), sync.last);
        session.send({ t: "sync.page", sid: frame.sid, messages, end: i === pages.length - 1 });
      });
      if (sync.follow) syncs.set(frame.sid, sync);
    };

    return {
      human: (frame) => {
        if (frame.t === "send") void handleSend(frame);
        else if (frame.t === "sync") handleSync(frame);
        else if (frame.t === "sync.close") syncs.delete(frame.sid);
        else if (frame.t === "presence") kernel.presence.push(frame);
        else if (frame.t === "present.result") { presentWaiters.get(frame.id)?.(frame); presentWaiters.delete(frame.id); }
      },
      closed: () => { kernel.followers.delete(owned); kernel.sessions = kernel.sessions.filter((s) => s !== session); },
    };
  };

  const server = createLinkServer({
    kernel: { id: "test-hub", version: "0" },
    authenticate: (hello) => ({
      ok: true, hand_id: "browser-hand",
      channels: { human: grant ?? { accepted: true, client: `client:g${clientCount + 1}`, local } },
    }),
    onSession: attach,
  });
  kernel.server = server;
  kernel.connector = memoryConnector(server);
  /** Plays the kernel's side of a `present` and resolves with the page's `present.result`. */
  kernel.present = (surface, op, body = {}) => {
    const session = kernel.sessions.at(-1);
    return session.kernelPresent({ t: "present", ch: "human", id: `p_${++reads}`, surface, op, body });
  };
  /** The connection drops (the page should reconnect and sync again). */
  kernel.drop = () => { for (const session of kernel.sessions) session.close(CLOSE_CODES.internal, "test drop"); };
  let closed = false;
  kernel.close = () => { if (closed) return; closed = true; server.close(); historyLedger.close(); rmSync(directory, { recursive: true, force: true }); };
  return kernel;
}

/**
 * Serves the production static page/assets and `/link` on a real port, for a browser to open. Resolves with the
 * kernel, now with `url`; `kernel.close()` stops the server too.
 */
export async function serveKernel(options = {}) {
  const { createServer } = await import("node:http");
  const { staticWeb } = await import("../../core/src/edges/link-server/web.ts");
  const kernel = startKernel(options);
  const http = createServer(staticWeb());
  kernel.server.attach(http);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  kernel.url = `http://127.0.0.1:${http.address().port}`;
  const stop = kernel.close;
  kernel.close = () => { stop(); http.closeAllConnections(); http.close(); };
  return kernel;
}
