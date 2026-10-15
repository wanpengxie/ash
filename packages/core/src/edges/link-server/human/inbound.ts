/**
 * `send` (SPEC-03 §5.1): the owner's word from a channel becomes `router.send`, stamped `person:owner` with where it
 * came from. A `send` with the same `client_id` and the same content is answered again with the first message
 * (`duplicate: true`), with other content it is a `conflict`.
 *
 * The id of the request is made here and given to the router (`SendOptions.id`); `send.result` goes out as soon as the
 * router announces that message, or at once if the router refuses it, without waiting for the word to be handled
 * (`wait: true` waits for that, and carries the response).
 *
 * The owner's answer to a question (`kind: "response"`, `reply_to` the ask) is not a request to anyone: it ends the
 * pending `person:owner/ask` here, and the router records it as that request's response.
 */
import { createHash, randomBytes } from "node:crypto";
import type { SendFrame } from "../../../../../sdk/src/link";
import { errorBody, type ErrorBody, type Message, type Outgoing, type Reply } from "../../../../../sdk/src/message";
import { OWNER_ID } from "../../../../../sdk/src/ids";
import type { Ledger } from "../../../kernel/ledger";
import type { Caller, Router } from "../../../kernel/types";
import type { Asks } from "./ask";
import type { Forms } from "./form";
import type { LiveClient } from "./clients";

type Request = SendFrame["request"];
export type SendOutcome =
  | { ok: true; message: { id: string; seq: number }; duplicate?: true; response?: Record<string, unknown> }
  | { ok: false; error: ErrorBody };

/** The caller the router is given for the owner on a channel; `origin` is what the router stamps on the message. */
export const ownerCaller = (c: Pick<LiveClient, "client" | "hand" | "channel" | "provider" | "label" | "local">): Caller => ({
  member: OWNER_ID, via: "human", local: c.local, client: c.client,
  origin: { channel: c.channel, client: c.client, hand: c.hand, ...(c.provider ? { provider: c.provider } : {}), label: c.label },
});

/** Waits for the router to announce a message of the owner (used for the response that records an answer). */
export class Recorded {
  private readonly waiters = new Set<{ match(m: Message): boolean; resolve(m: Message): void }>();

  /** Must be called before the thing that makes the message. */
  expect(match: (m: Message) => boolean): { promise: Promise<Message>; cancel(): void } {
    let waiter!: { match(m: Message): boolean; resolve(m: Message): void };
    const promise = new Promise<Message>((resolve) => { waiter = { match, resolve }; });
    this.waiters.add(waiter);
    return { promise, cancel: () => void this.waiters.delete(waiter) };
  }

  offer(m: Message): void {
    for (const waiter of this.waiters) {
      if (!waiter.match(m)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(m);
      return;
    }
  }
}

export interface InboundDeps {
  router: Pick<Router, "send">;
  ledger: Pick<Ledger, "db" | "get">;
  recorded: Recorded;
  asks: Asks;
  forms: Forms;
  now(): number;
  /** How long an answer waits to be recorded. */
  recordMs: number;
  log(message: string, error?: unknown): void;
}

const hashOf = (r: Request) => createHash("sha256").update(JSON.stringify([r.to, r.kind, r.word, r.body, r.reply_to ?? null])).digest("hex");
const fail = (error: ErrorBody): SendOutcome => ({ ok: false, error });
const later = (ms: number) => new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), ms); t.unref?.(); });
const KEEP_MS = 7 * 24 * 3600_000;

export class Inbound {
  private readonly inflight = new Map<string, Promise<SendOutcome>>();

  constructor(private readonly d: InboundDeps) {
    d.ledger.db().exec(`CREATE TABLE IF NOT EXISTS human_sends (client_id TEXT PRIMARY KEY, hash TEXT NOT NULL, message_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL);`);
    d.ledger.db().prepare("DELETE FROM human_sends WHERE at<?").run(d.now() - KEEP_MS);
  }

  async send(c: LiveClient, req: Request): Promise<SendOutcome> {
    const key = req.client_id;
    if (!key) return this.deliver(c, req);
    const hash = hashOf(req);
    const running = this.inflight.get(key);
    if (running) return this.again(await running, hash, key);
    const row = this.d.ledger.db().prepare("SELECT hash,message_id,seq FROM human_sends WHERE client_id=?").get(key) as { hash: string; message_id: string; seq: number } | undefined;
    if (row) return row.hash === hash ? { ok: true, message: { id: row.message_id, seq: row.seq }, duplicate: true } : fail(errorBody("conflict", "this client_id was used for other content"));
    const work = this.deliver(c, req);
    this.inflight.set(key, work);
    try {
      const outcome = await work;
      if (outcome.ok) this.d.ledger.db().prepare("INSERT OR REPLACE INTO human_sends(client_id,hash,message_id,seq,at) VALUES(?,?,?,?,?)").run(key, hash, outcome.message.id, outcome.message.seq, this.d.now());
      return outcome;
    } finally { this.inflight.delete(key); }
  }

  /** The same client_id again while the first is still running. */
  private again(first: SendOutcome, hash: string, key: string): SendOutcome {
    if (!first.ok) return first;
    const row = this.d.ledger.db().prepare("SELECT hash FROM human_sends WHERE client_id=?").get(key) as { hash: string } | undefined;
    return !row || row.hash === hash ? { ok: true, message: first.message, duplicate: true } : fail(errorBody("conflict", "this client_id was used for other content"));
  }

  private async deliver(c: LiveClient, req: Request): Promise<SendOutcome> {
    if (req.kind === "response") return this.answer(c, req);
    const out: Outgoing = { to: req.to, kind: req.kind, word: req.word, body: req.body, ...(req.reply_to ? { reply_to: req.reply_to } : {}) };
    const id = `m_${randomBytes(9).toString("base64url")}`;
    const seen = this.d.recorded.expect((m) => m.id === id);
    const sending: Promise<Reply> = this.d.router.send(out, ownerCaller(c), { id }).catch((error) => {
      this.d.log(`send ${out.to}/${out.word} failed`, error);
      return { ok: false, error: errorBody("internal", "the hub failed while handling this request") } as Reply;
    });
    const first = await Promise.race([seen.promise.then(() => null), sending]);
    seen.cancel();
    // Refused before it was recorded is an error; recorded and then failed in the handler is a response that says so.
    if (first && !first.ok && !this.d.ledger.get(id)) return fail(first.error);
    const ref = { id, seq: this.d.ledger.get(id)?.seq ?? 0 };
    if (req.wait !== true) return { ok: true, message: ref };
    const reply = await sending;
    const response = reply.ok ? { ok: true, ...(reply.result ? { result: reply.result } : {}) } : { ok: false, error: reply.error };
    return { ok: true, message: ref, response: response as Record<string, unknown> };
  }

  private async answer(c: LiveClient, req: Request): Promise<SendOutcome> {
    const id = req.reply_to;
    const form = req.word === "form";
    if ((req.word !== "ask" && !form) || !id) return fail(errorBody("bad_request", "a response from the owner is the answer to an ask or a form: word ask or form, with reply_to"));
    if (!(form ? this.d.forms.has(id) : this.d.asks.has(id))) {
      const known = this.d.ledger.get(id);
      return fail(known?.word === req.word ? errorBody("conflict", form ? "this form was already sent or has ended" : "this question was already answered or has ended") : errorBody("not_found", form ? "no such form" : "no such question"));
    }
    const recorded = this.d.recorded.expect((m) => m.kind === "response" && m.reply_to === id);
    const answered = form ? this.d.forms.answer(id, req.body) : this.d.asks.answer(id, req.body, c);
    if (!answered.ok) { recorded.cancel(); return fail(answered.error); }
    const message = await Promise.race([recorded.promise, later(this.d.recordMs)]);
    recorded.cancel();
    return message ? { ok: true, message: { id: message.id, seq: message.seq } } : fail(errorBody("result_unknown", "the answer was accepted; its record has not shown up yet"));
  }
}
