/**
 * A hub for the human edge: the real link server, a real ledger, the real `person:owner` member, and a small router that
 * does what the real one does for these tests (records, announces, delivers) and keeps what it was asked.
 */
import { randomBytes } from "node:crypto";
import { errorBody, WordError, type Caller, type Message, type Outgoing, type Reply } from "../../../../../sdk/src/message";
import type { PresentFrame, SyncMsgFrame, SyncPageFrame } from "../../../../../sdk/src/link";
import type { Member } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import type { PresentOutcome } from "../../../../../link/src/hand";
import { createHuman, type HumanDeps, type HumanEdge } from "../../../../src/edges/link-server/human";
import type { Ledger } from "../../../../src/kernel/ledger";
import type { Router } from "../../../../src/kernel/types";
import { openLedger } from "../../../kernel/ledger/helpers";
import { eventually } from "../../../fixtures/wait";
import { connect, connectViaRelay, newIdentity, startHub, type Hub, type TestHand } from "../harness";

export interface Sent { msg: Outgoing; caller: Caller }

export class MiniRouter implements Router {
  readonly members = new Map<string, Member>();
  readonly sent: Sent[] = [];
  private readonly subs = new Set<(m: Message) => void>();
  constructor(private readonly ledger: Ledger) {}

  stub(id: string, words: string[] = ["say"], answer: () => unknown = () => ({ accepted: true })): void {
    this.members.set(id, {
      id, kind: id.startsWith("agent:") ? "agent" : "service", name: id,
      words: () => wordsOf(id).filter((w) => words.includes(w.word)),
      async handle() { return { data: await answer() }; },
    });
  }

  publish(m: Message): void { for (const cb of [...this.subs]) cb(m); }
  subscribe(_filter: unknown, cb: (m: Message) => void): () => void { this.subs.add(cb); return () => void this.subs.delete(cb); }
  recover(): void {}

  /** An event nobody sends through `send` (a turn of an agent, as the agents module would announce it). */
  announce(word: string, body: Record<string, unknown>, to = "agent:main", from = "service:agents"): void {
    this.publish({ seq: 0, id: `e_${randomBytes(4).toString("hex")}`, ts: Date.now(), from, to, kind: "event", word, body });
  }

  async send(msg: Outgoing, caller: Caller, opts: { id?: string } = {}): Promise<Reply & { id?: string }> {
    this.sent.push({ msg, caller });
    const member = msg.to ? this.members.get(msg.to) : undefined;
    const contract = member?.words().find((w) => w.word === msg.word);
    if (msg.kind === "event") {
      // The router lets an event through when the sender's own words declare it; the owner member is held to that.
      if (caller.member === "person:owner" && caller.via === "service" && !this.members.get(caller.member)?.words().some((w) => w.word === msg.word)) return { ok: false, error: errorBody("forbidden", `${caller.member} does not declare ${msg.word}`) };
      const event = { seq: 0, id: `e_${randomBytes(4).toString("hex")}`, ts: Date.now(), from: caller.member, to: msg.to, kind: "event" as const, word: msg.word, body: msg.body };
      this.publish(event);
      if (member) await member.handle(event, { signal: new AbortController().signal, caller, raw: msg.body });
      return { ok: true, id: event.id };
    }
    if (!member) return { ok: false, error: errorBody("offline", `${msg.to} is not connected`) };
    if (!contract) return { ok: false, error: errorBody("not_found", `${msg.to} has no word ${msg.word}`) };
    const origin = caller.origin;
    const stored = this.ledger.append({ ...(opts.id ? { id: opts.id } : {}), from: caller.member, to: msg.to, kind: "request", word: msg.word, body: msg.body, ...(msg.reply_to ? { reply_to: msg.reply_to } : {}), ...(origin ? { origin } : {}), ...(caller.turn ? { turn: caller.turn } : {}) });
    this.publish(stored);
    let reply: Reply;
    try {
      const result = await member.handle(stored, { signal: new AbortController().signal, caller, raw: msg.body });
      reply = result ? { ok: true, result } : { ok: true };
    } catch (error) {
      reply = { ok: false, error: error instanceof WordError ? errorBody(error.code, error.message) : errorBody("internal", "failed") };
    }
    const response = this.ledger.append({ from: msg.to!, to: caller.member, kind: "response", word: msg.word, body: reply, reply_to: stored.id });
    this.publish(response);
    // The id rides along without being part of what tests compare.
    return Object.defineProperty({ ...reply }, "id", { value: stored.id, enumerable: false });
  }
}

export interface HumanHub extends Hub {
  ledger: Ledger;
  mini: MiniRouter;
  human: HumanEdge;
  clock: { now: number };
  settings: Record<string, unknown>;
  summaries: string[][];
  /** What `service:widgets/widget.list` answers. */
  widgetState: { value: unknown };
}

export async function startHumanHub(over: Partial<HumanDeps> = {}): Promise<HumanHub> {
  const hub = await startHub();
  const { ledger } = openLedger();
  const mini = new MiniRouter(ledger);
  const clock = { now: Date.now() };
  const settings: Record<string, unknown> = {};
  const summaries: string[][] = [];
  const widgetState = { value: { revision: 1, cards: [], widgets: [], bindings: [], previews: [] } as unknown };
  const human = createHuman({
    router: mini, ledger, settings: () => settings, now: () => clock.now, timeZone: "UTC", log: () => {},
    summarize: async (steps) => { summaries.push(steps); return "在整理日程"; },
    primary: () => "agent:main",
    timing: { presentMs: 2000, islandMs: 3000, recordMs: 1000, summaryDelayMs: 10 },
    ...over,
  });
  mini.members.set("person:owner", human.member);
  mini.stub("agent:main", ["say", "wake"]);
  mini.stub("service:vault", ["set"]);
  mini.stub("service:widgets", ["widget.list"], () => widgetState.value);
  hub.server.onChannel("human", human.attach);
  const stop = hub.stop;
  return Object.assign(hub, { ledger, mini, human, clock, settings, summaries, widgetState, stop: async () => { human.close(); await stop(); } });
}

export interface ChannelOptions {
  label?: string;
  surfaces?: string[];
  kind?: "phone" | "browser";
  /** How this channel answers `present` frames (default: shown). */
  present?: (frame: PresentFrame) => PresentOutcome | Promise<PresentOutcome>;
}

/** One channel of the owner, as a hand that opened only the human channel. */
export class Channel {
  readonly presents: PresentFrame[] = [];
  readonly messages: Message[] = [];
  readonly pages: SyncPageFrame[] = [];
  readonly logs: string[] = [];
  readonly streams: { sid: string; mime?: string; data: Uint8Array }[] = [];
  clientId = "";
  constructor(readonly hand: TestHand, private readonly options: ChannelOptions) {}

  static async open(hub: Pick<Hub, "url" | "token">, options: ChannelOptions = {}): Promise<Channel> {
    let self!: Channel;
    const hand = await connect(hub, {
      kind: options.kind ?? "phone",
      channels: { human: { label: options.label ?? "手机 · 对话", surfaces: options.surfaces ?? ["chat"] } },
      handlers: {
        present: async (frame) => { self.presents.push(frame); return options.present ? options.present(frame) : { ok: true }; },
        welcome: (w) => { const g = w.channels.human; if (g && "client" in g) self.clientId = g.client; },
        log: (message) => self.logs.push(message),
        stream: (stream) => { self.streams.push({ sid: stream.sid, ...(stream.mime ? { mime: stream.mime } : {}), data: stream.data }); },
      },
    });
    self = new Channel(hand, options);
    await hand.client.ready();
    await eventually(() => self.clientId, "the welcome");
    return self;
  }

  /** A channel that came through the relay (not local); the hand must be registered with web_ui first. */
  static async openRemote(hub: Hub, options: ChannelOptions = {}): Promise<Channel> {
    const identity = await newIdentity();
    hub.hands.register({ id: identity.handId, name: "远程网页", kind: "browser", public_key: identity.publicKey, paired_by: "gateway", web_ui: true });
    let self!: Channel;
    const hand = connectViaRelay(hub, identity.handId, identity, {
      kind: "browser", channels: { human: { label: options.label ?? "网页", surfaces: options.surfaces ?? ["chat"] } },
      handlers: { present: async (frame) => { self.presents.push(frame); return { ok: true }; }, welcome: (w) => { const g = w.channels.human; if (g && "client" in g) self.clientId = g.client; } },
    });
    self = new Channel(hand, options);
    await hand.client.ready();
    await eventually(() => self.clientId, "the welcome");
    return self;
  }

  get client() { return this.hand.client; }
  presence(state: { visible?: boolean; watching?: boolean; typing?: boolean; agent?: string }): void { this.client.presence(state); }

  /** Follows the whole ledger from the start. */
  follow(params: { after?: number; limit?: number } = {}) {
    return this.client.openSync({ after: 0, ...params, follow: true }, {
      page: (f) => { this.pages.push(f); this.take(f.messages as unknown as Message[]); },
      message: (f: SyncMsgFrame) => this.take([f.message as unknown as Message]),
    });
  }
  private take(messages: Message[]) { for (const m of messages) if (!this.messages.some((x) => x.id === m.id)) this.messages.push(m); }

  /** One read of the history, without following. */
  read(params: { after?: number; before?: number; limit?: number }): Promise<SyncPageFrame[]> {
    return new Promise((resolve) => {
      const pages: SyncPageFrame[] = [];
      const handle = this.client.openSync(params, {
        page: (f) => { pages.push(f); if (f.end) { handle.close(); resolve(pages); } },
        message: () => {},
      });
    });
  }

  seen(match: (m: Message) => boolean, what: string) { return eventually(() => this.messages.find(match), what); }
  present(match: (f: PresentFrame) => boolean, what: string) { return eventually(() => this.presents.find(match), what); }
  presented(surface: string, op?: string): PresentFrame[] { return this.presents.filter((f) => f.surface === surface && (!op || f.op === op)); }
  send(request: Parameters<Channel["client"]["send"]>[0]) { return this.client.send({ client_id: `c_${randomBytes(4).toString("hex")}`, ...request }); }
  /** The owner answers a question by option id. */
  answer(ask: { id: string; from: string }, choice: string, extra: Record<string, unknown> = {}) {
    return this.send({ to: ask.from, kind: "response", word: "ask", reply_to: ask.id, body: { ok: true, result: { data: { choice, ...extra } } } });
  }
}

export const quiet = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
export const GATE: Caller = { member: "service:gate", via: "service", local: true };
export const AGENT: Caller = { member: "agent:main", via: "agent", local: true };
export const APPROVAL = [{ id: "once", label: "可以" }, { id: "always", label: "以后都可以" }, { id: "deny", label: "不行" }];
