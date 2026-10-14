// Test doubles for the app edge: a registry and a router that behave like the kernel's for what the app edge uses,
// with a gate stand-in that refuses what the real gate refuses an app (anything but a read or a risk-none word).
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { errorBody, isErrorCode, WordError, type Caller, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { Ledger } from "../../../src/kernel/ledger";
import type { MemberInfo, Registry, Router } from "../../../src/kernel/types";
import { createApps, hostLauncher, type Apps } from "../../../src/edges/apps";
import type { AppRuntimeOptions } from "../../../src/edges/apps";

export const FIXTURE = fileURLToPath(new URL("../../fixtures/apps/fixture", import.meta.url));

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const clean of cleanups.splice(0).reverse()) { try { await clean(); } catch { /* best effort */ } }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
export function tempDir(prefix = "apps-test-"): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
export const later = (fn: () => Promise<void> | void) => { cleanups.push(fn); };

export async function until<T>(check: () => T | Promise<T>, what = "condition", ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------------------------------------------------

export function fakeRegistry(): Registry & { members: Map<string, Member> } {
  const members = new Map<string, Member>();
  const watchers = new Set<(id: string, change: "added" | "removed") => void>();
  const speaks = (m: Member, c: WordContract) => c.member === m.id || (c.member.endsWith(":*") && m.id.startsWith(c.member.slice(0, -1)));
  const info = (m: Member): MemberInfo => ({ id: m.id, kind: m.kind, name: m.name });
  return {
    members,
    add(m) { members.set(m.id, m); for (const cb of watchers) cb(m.id, "added"); },
    remove(id) { if (members.delete(id)) for (const cb of watchers) cb(id, "removed"); },
    find(to, word) {
      const member = members.get(to);
      const contract = member?.words().find((c) => c.word === word && speaks(member, c));
      return member && contract ? { member, contract } : null;
    },
    get: (id) => members.get(id) ?? null,
    listeners: () => [],
    findByWord: (word) => [...members.values()].filter((m) => m.words().some((c) => c.word === word)),
    list: (filter) => [...members.values()].filter((m) => !filter?.kind || m.kind === filter.kind).map(info),
    describe(id) { const m = members.get(id); return m ? { info: info(m), words: m.words().filter((c) => speaks(m, c)) } : null; },
    onChange(cb) { watchers.add(cb); return () => { watchers.delete(cb); }; },
  };
}

export interface Sent { msg: Outgoing; caller: Caller }
export interface FakeRouter extends Router {
  sent: Sent[];
  /** What the owner answers to an approval card: the choice id. Undefined: nobody answers (an error). */
  ownerChoice: string | undefined;
  /** The approval cards, as the gate would show them: the word and the detail the member added (`cardDetail`). */
  cards: { word: string; detail: string | null }[];
  /** The router's one permission check for an app (the runtime's `granted`); set once the app edge exists. */
  appGranted?: (app: string, to: string | null, word: string) => boolean;
  /** Run before an edit of the files lands in the answer: tests change app.json here to simulate an edit while the card is open. */
  onCard?: () => void;
}

const matches = (patterns: string[] | undefined, word: string) => (patterns ?? []).some((p) => (p.endsWith("*") ? word.startsWith(p.slice(0, -1)) : p === word));

/**
 * A router with the parts of the kernel's that matter here: find the member (offline / not_found), the gate for an app
 * (read or risk none only), handle (WordError becomes the reply's error), and events going to listeners.
 */
export function fakeRouter(registry: Registry): FakeRouter {
  let seq = 0;
  const router: FakeRouter = {
    sent: [], ownerChoice: "allow", cards: [],
    subscribe: () => () => {},
    recover: () => {},
    async send(out: Outgoing, caller: Caller, opts?: { signal?: AbortSignal }): Promise<Reply> {
      router.sent.push({ msg: out, caller });
      const message: Message = { seq: ++seq, id: `m_${seq}`, ts: 1_000 + seq, from: caller.member, to: out.to, kind: out.kind, word: out.word, body: out.body };
      const signal = opts?.signal ?? new AbortController().signal;
      if (caller.via === "app" && !router.appGranted?.(caller.member, out.kind === "event" ? null : out.to, out.word))
        return { ok: false, error: errorBody("forbidden", `${caller.member} may not use ${out.to ?? "an event"}/${out.word}`, { recovery_hint: "ask the agent or the owner" }) };
      if (out.kind === "event") {
        const targets = new Map<string, Member>();
        for (const info of registry.list()) {
          const full = (registry as ReturnType<typeof fakeRegistry>).members.get(info.id)!;
          if (info.id === out.to || matches(full.listens, out.word)) targets.set(info.id, full);
        }
        for (const member of targets.values()) { try { await member.handle(message, { signal, caller, raw: out.body }); } catch { /* an event handler's failure is not the sender's */ } }
        return { ok: true };
      }
      const found = out.to ? registry.find(out.to, out.word) : null;
      if (!found) return { ok: false, error: errorBody(out.to && registry.describe(out.to) ? "not_found" : "offline", `${out.to} cannot be reached`) };
      // The gate for an app: only a read or a risk-none word, and only one that lists apps among its callers.
      if (caller.via === "app" && (!found.contract.callers.includes("app") || (found.contract.effect !== "read" && found.contract.risk !== "none")))
        return { ok: false, error: errorBody("forbidden", "an app may only use reads and harmless words", { recovery_hint: "ask the agent or the owner" }) };
      const early = await found.member.precheck?.(message);
      if (early) return early;
      // An approval card for whoever is not the owner and asks for what needs one (here: an install): the member adds its detail.
      if (caller.member !== "person:owner" && caller.via !== "service" && found.contract.risk !== "none") {
        router.cards.push({ word: out.word, detail: found.member.cardDetail?.(message) ?? null });
        router.onCard?.();
        if (router.ownerChoice === undefined) return { ok: false, error: errorBody("timeout", "nobody answered") };
        if (router.ownerChoice !== "allow") return { ok: false, error: errorBody("denied", "the owner said no") };
      }
      try {
        const result = await found.member.handle(message, { signal, caller, raw: out.body });
        return { ok: true, ...(result ? { result } : {}) };
      } catch (error) {
        if (error instanceof WordError) return { ok: false, error: errorBody(error.code, error.message, { detail: error.detail, recovery_hint: error.recovery_hint }) };
        return { ok: false, error: errorBody(isErrorCode((error as { code?: string }).code) ? (error as { code: never }).code : "internal", String((error as Error).message)) };
      }
    },
  };
  return router;
}

/** A plain member with scripted words, for the other side of the bridge (a phone, an agent). */
export function stubMember(id: string, kind: Member["kind"], contracts: Partial<WordContract>[], handlers: Record<string, (msg: Message) => unknown | Promise<unknown>> = {}): Member & { received: Message[] } {
  const received: Message[] = [];
  const words = contracts.map((c): WordContract => ({
    member: id, kind: "request", direction: "in", description: `Stub word ${c.word} for tests of the app edge.`, input_schema: { type: "object" },
    effect: "read", risk: "none", callers: ["owner", "agent", "app"], label: { doing: "在测试" }, ...c,
  }) as WordContract);
  return {
    id, kind, name: id, received, words: () => words,
    async handle(msg) {
      received.push(msg);
      const run = handlers[msg.word];
      return run ? { data: await run(msg) } as never : { data: { ok: true } } as never;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------

export interface World {
  apps: Apps;
  registry: ReturnType<typeof fakeRegistry>;
  router: FakeRouter;
  ledger: Ledger;
  root: string;
  dbPath: string;
}

/** Copy the fixture app into a fresh apps folder, optionally changing its app.json. */
export function installFixtureFolder(root: string, edit?: (app: Record<string, any>) => void, id = "fixture"): string {
  const dir = join(root, id);
  cpSync(FIXTURE, dir, { recursive: true });
  rmSync(join(dir, "data"), { recursive: true, force: true });
  const file = join(dir, "app.json");
  const app = JSON.parse(readFileSync(file, "utf8"));
  app.id = id;
  edit?.(app);
  writeFileSync(file, JSON.stringify(app, null, 2));
  return dir;
}

export function world(options: Partial<AppRuntimeOptions> & { fixture?: boolean | ((app: Record<string, any>) => void); dbPath?: string; root?: string } = {}): World {
  const root = options.root ?? tempDir();
  const dbPath = options.dbPath ?? join(tempDir(), "ash.db");
  if (options.fixture !== false) installFixtureFolder(root, typeof options.fixture === "function" ? options.fixture : undefined);
  const ledger = Ledger.open(dbPath);
  later(() => ledger.close());
  const registry = fakeRegistry();
  const router = fakeRouter(registry);
  const { fixture: _fixture, dbPath: _db, root: _root, ...rest } = options;
  const apps = createApps({
    router, registry, ledger, primaryAgent: () => "agent:main", launcher: hostLauncher(root),
    backoffMs: () => 60_000, trialMs: 15_000, log: () => {}, ...rest,
  });
  registry.add(apps.service);
  router.appGranted = (app, to, word) => apps.runtime.granted(app, to, word);
  later(() => apps.stopAll(Date.now() + 3000));
  return { apps, registry, router, ledger, root, dbPath };
}

export const OWNER: Caller = { member: "person:owner", via: "human", local: true };
export const AGENT: Caller = { member: "agent:main", via: "agent", local: false };

/** Send a word to a member through the fake router and return the whole reply. */
export const call = (w: World, to: string, word: string, body: unknown = {}, caller: Caller = OWNER) => w.router.send({ to, kind: "request", word, body }, caller);
export const dataOf = (reply: Reply): any => { if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`); return reply.result?.data; };
export const hasFile = (path: string) => existsSync(path);
