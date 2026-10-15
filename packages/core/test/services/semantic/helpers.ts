// A small hub for the semantic layer's tests: a real ledger and a real clock service on a fake time, a router that routes to
// members, checks every request body against the word's contract and plays the gate for a non-service caller (a word with
// risk above none asks the owner), and stand-ins for the members the layer talks to (agents, admin, senses, widgets, the body).
import type { Caller, Message, Outgoing, Reply } from "../../../../sdk/src/message";
import { errorBody, WordError } from "../../../../sdk/src/message";
import { compileSchema, type Member, type WordContract } from "../../../../sdk/src/word";
import { WORD_CONTRACTS, wordContract } from "../../../../sdk/src/words";
import { createClockService, type ClockService } from "../../../src/services/clock";
import { scratchDir } from "../../fixtures/scratch";
import { createSemantic, type Semantic } from "../../../src/services/semantic";
import { openLedger } from "../../kernel/ledger/helpers";
import type { Ledger } from "../../../src/kernel/ledger";

export const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
export const DAY1 = local(2026, 10, 12, 6, 0);
export const OWNER: Caller = { member: "person:owner", via: "human", local: true };
export const AGENT: Caller = { member: "agent:main", via: "agent", local: false };
export const SERVICE = (id: string): Caller => ({ member: id, via: "service", local: true });

export interface Sent { msg: Outgoing; caller: Caller; at: number }
export interface AgentStub { id: string; primary?: boolean; ephemeral?: boolean; lanes: Record<string, unknown>; state?: string }

const contractsFor = (id: string, words: string[]): WordContract[] => words.map((word) => {
  const generic = id.startsWith("agent:") ? "agent:*" : id;
  const found = wordContract(id, word) ?? wordContract(generic, word);
  return found ? { ...found, member: id } : { member: id, word, kind: "request", direction: "in", description: "stub", input_schema: { type: "object" }, effect: "read", risk: "none", callers: ["owner", "agent", "app"], label: { doing: "在测试" } } as WordContract;
});

export interface Stub extends Member { calls: { word: string; body: any; from: string; at: number }[] }
function stub(id: string, kind: Member["kind"], handlers: Record<string, (body: any, msg: Message) => unknown>, now: () => number, listens?: string[]): Stub {
  const calls: Stub["calls"] = [];
  const words = contractsFor(id, Object.keys(handlers));
  return {
    id, kind, name: id, calls, words: () => words, ...(listens ? { listens } : {}),
    async handle(msg) {
      calls.push({ word: msg.word, body: msg.body, from: msg.from, at: now() });
      const result = handlers[msg.word]?.(msg.body, msg);
      return result === undefined ? undefined : { data: result as never };
    },
  };
}

export interface Hub {
  t: number;
  ledger: Ledger;
  clock: ClockService;
  semantic: Semantic;
  members: Map<string, Member>;
  sent: Sent[];
  /** Words that did not fit their contract's input schema; every test ends by asserting this is empty. */
  invalid: string[];
  cards: { to: string; word: string; from: string }[];
  ownerChoice: "allow" | "deny";
  agents: AgentStub[];
  files: Map<string, string>;
  bodyUp: boolean;
  settings: Record<string, unknown>;
  /** The vault refs that are saved (the stand-in vault's `list` says so); both model keys by default. */
  savedKeys: string[];
  paused: boolean;
  cardWidgets: number;
  sensesDaily: any;
  main: Stub;
  agentsService: Stub;
  wakes(agent?: string): { reason: string; context: any; lane: string; at: number; agent: string }[];
  reloads(): { agent: string; key: string; at: number }[];
  send(to: string, word: string, body?: unknown, caller?: Caller): Promise<Reply>;
  event(from: string, word: string, body: unknown): Promise<void>;
  /** Move the time and let what is due happen. */
  advanceTo(t: number): Promise<void>;
  idle(): Promise<void>;
  /** A new process over the same ledger: the members are rebuilt, state comes from the ledger. */
  restart(): Promise<void>;
}

export const TEMPLATES = { "SOUL.md": "# SOUL\nbe kind\n", "IDENTITY.md": "# IDENTITY\nAsh\n", "PULSE.md": "# PULSE\nlook first\n" };
/** The same texts as the files `createSemantic` reads (`<NAME>.template.md`). */
const TEMPLATES_DIR = scratchDir(Object.fromEntries(Object.entries(TEMPLATES).map(([file, text]) => [file.replace(/\.md$/, ".template.md"), text])), "semantic-templates-");

export function newHub(options: { ledger?: Ledger; t?: number; budget?: number; cardWidgets?: number } = {}): Hub {
  const ledger = options.ledger ?? openLedger().ledger;
  const hub: Hub = {
    t: options.t ?? DAY1, ledger, members: new Map(), sent: [], invalid: [], cards: [], ownerChoice: "allow",
    agents: [{ id: "agent:main", primary: true, lanes: { front: {}, back: {} } }],
    files: new Map(), bodyUp: true, settings: {}, savedKeys: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"], paused: false, cardWidgets: options.cardWidgets ?? 1, sensesDaily: { counts: { location: 0 } },
  } as unknown as Hub;
  let inflight = 0;
  const now = () => hub.t;

  const router = {
    async send(out: Outgoing, caller: Caller): Promise<Reply> {
      inflight++;
      try { return await route(out, caller); } finally { inflight--; }
    },
    subscribe: () => () => {}, recover: () => {},
  };
  hub.sent = [];
  async function route(out: Outgoing, caller: Caller): Promise<Reply> {
    hub.sent.push({ msg: out, caller, at: hub.t });
    const message: Message = { seq: hub.sent.length, id: `m_${hub.sent.length}`, ts: hub.t, from: caller.member, to: out.to, kind: out.kind, word: out.word, body: out.body };
    const ctx = { signal: new AbortController().signal, caller, raw: out.body };
    if (out.kind === "event") {
      for (const member of hub.members.values()) {
        if (member.id === out.to || member.listens?.some((p) => (p.endsWith("*") ? out.word.startsWith(p.slice(0, -1)) : p === out.word))) {
          try { await member.handle(message, ctx); } catch { /* an event's failure is not the sender's */ }
        }
      }
      return { ok: true };
    }
    const member = out.to ? hub.members.get(out.to) : undefined;
    if (!member) return { ok: false, error: errorBody("offline", `${out.to} is not here`) };
    const contract = member.words().find((w) => w.word === out.word);
    if (!contract) return { ok: false, error: errorBody("not_found", `${out.to} has no word ${out.word}`) };
    const check = compileSchema(contract.input_schema);
    if (!check(out.body)) { hub.invalid.push(`${out.to}/${out.word}: ${JSON.stringify(check.errors)}`); return { ok: false, error: errorBody("bad_request", "does not fit the contract") }; }
    // The gate for a caller that is neither the owner nor the hub's own code: a word with a risk asks the owner.
    if (caller.via !== "human" && caller.via !== "service" && contract.risk !== "none") {
      hub.cards.push({ to: out.to!, word: out.word, from: caller.member });
      if (hub.ownerChoice !== "allow") return { ok: false, error: errorBody("denied", "the owner said no") };
    }
    // A wake is on the real ledger, with the answer it got, as the router records it: the first meeting reads its own wakes back.
    const recordWake = out.word === "wake";
    if (recordWake) ledger.append({ id: message.id, ts: hub.t, from: caller.member, to: out.to!, kind: "request", word: "wake", body: out.body });
    const answer = async (): Promise<Reply> => {
      try {
        const result = await member.handle(message, ctx);
        return { ok: true, ...(result ? { result } : {}) };
      } catch (error) {
        if (error instanceof WordError) return { ok: false, error: errorBody(error.code, error.message) };
        return { ok: false, error: errorBody("internal", String((error as Error).message)) };
      }
    };
    const reply = await answer();
    if (recordWake) ledger.append({ ts: hub.t, from: out.to!, to: caller.member, kind: "response", word: "wake", body: reply, reply_to: message.id });
    return reply;
  }

  // stand-ins
  hub.main = stub("agent:main", "agent", { wake: () => ({ accepted: true }) }, now);
  hub.agentsService = stub("service:agents", "service", {
    list: () => ({ agents: hub.agents.map((a) => ({ id: a.id, name: a.id.slice(6), summary: "x", state: a.state ?? "idle", primary: !!a.primary, ephemeral: !!a.ephemeral, lanes: a.lanes })) }),
    "session.reload": (body) => ({ key: body.key, handle: "h" }),
  }, now);
  const extra: Member[] = [
    hub.main,
    stub("agent:helper", "agent", { wake: () => ({ accepted: true }) }, now),
    hub.agentsService,
    stub("service:admin", "service", {
      status: () => ({ now: hub.t, paused: hub.paused }),
      "settings.get": (body) => ({ settings: Object.fromEntries((body.keys as string[]).filter((k) => k in hub.settings).map((k) => [k, hub.settings[k]])) }),
    }, now),
    stub("service:vault", "service", {
      list: () => ({ entries: ["CLOUDFLARE_TOKEN", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"].map((ref) => ({ ref, label: ref, kind: "other", configured: hub.savedKeys.includes(ref) })) }),
    }, now),
    stub("service:senses", "service", { daily: () => hub.sensesDaily }, now),
    stub("service:widgets", "service", { "widget.list": () => ({ widgets: Array.from({ length: hub.cardWidgets }, (_, i) => ({ id: `w${i}`, type: "card", card: null })), cards: [] }) }, now),
    stub("body:main", "body", {
      "workspace.read": (body) => { if (!hub.bodyUp) throw new WordError("offline", "body is away"); const text = hub.files.get(body.path); if (text === undefined) throw new WordError("not_found", "no such file"); return { path: body.path, text }; },
      "workspace.ls": (body) => {
        if (!hub.bodyUp) throw new WordError("offline", "body is away");
        const dir = `${body.path}/`;
        const entries = [...hub.files.keys()].filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes("/")).map((p) => ({ name: p.slice(dir.length), type: "file", size: hub.files.get(p)!.length }));
        if (!entries.length) throw new WordError("not_found", "no such directory");
        return { path: body.path, entries };
      },
      "workspace.write": (body) => { if (!hub.bodyUp) throw new WordError("offline", "body is away"); hub.files.set(body.path, body.content); return { path: body.path, bytes: body.content.length }; },
    }, now),
  ];

  const build = () => {
    hub.members.clear();
    for (const m of extra) hub.members.set(m.id, m);
    hub.clock = createClockService({ ledger, router, now, setTimer: () => () => {}, log: () => {} });
    hub.members.set(hub.clock.id, hub.clock);
    hub.semantic = createSemantic({ ledger, router, now, templatesDir: TEMPLATES_DIR, modelKeys: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"], tickMs: 0, log: () => {}, ...(options.budget !== undefined ? { budget: options.budget } : {}) });
    for (const m of hub.semantic.members) hub.members.set(m.id, m);
  };
  build();

  hub.wakes = (agent) => hub.sent.filter((s) => s.msg.word === "wake" && (!agent || s.msg.to === agent)).map((s) => ({ agent: s.msg.to!, ...(s.msg.body as any), at: s.at }));
  hub.reloads = () => hub.sent.filter((s) => s.msg.word === "session.reload").map((s) => ({ ...(s.msg.body as any), at: s.at }));
  hub.send = (to, word, body = {}, caller = OWNER) => router.send({ to, kind: "request", word, body }, caller);
  hub.event = async (from, word, body) => { await router.send({ to: null, kind: "event", word, body }, from.startsWith("device:") ? { member: from, via: "hand", local: true } : SERVICE(from)); await hub.idle(); };
  hub.idle = async () => { for (let i = 0; i < 30; i++) { await new Promise((r) => setImmediate(r)); if (inflight === 0 && i > 3) break; } };
  hub.advanceTo = async (t) => { hub.t = t; hub.clock.check(); await hub.idle(); await hub.semantic.pulse.settled(); await hub.idle(); };
  hub.restart = async () => {
    hub.semantic.stop();
    build();
    hub.clock.start();
    await hub.idle();
    await hub.semantic.start();
    await hub.idle();
    await hub.semantic.pulse.settled();
    await hub.idle();
  };
  return hub;
}

/** A fresh hub that is started: the clock first (as the assembly does), then the semantic layer. */
export async function startedHub(options: Parameters<typeof newHub>[0] = {}): Promise<Hub> {
  const hub = newHub(options);
  hub.clock.start();
  await hub.semantic.start();
  await hub.idle();
  await hub.semantic.pulse.settled();
  await hub.idle();
  return hub;
}

export const contractOf = (member: string, word: string) => WORD_CONTRACTS.find((c) => c.member === member && c.word === word)!;
