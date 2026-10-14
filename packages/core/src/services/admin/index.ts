/**
 * `service:admin`: switches and settings (HUB-MODULES §3).
 *
 *   pause {by?} / resume {confirmed}     the owner or an agent. The state is kept in `kv`
 *                                        (`admin.paused`) and announced as `settings.changed {keys: ["paused"], by}`; the
 *                                        agents module listens, interrupts the running turns and opens no new ones.
 *   settings.get {keys?} / settings.set {<key>: <value>, ...}
 *                                        plain key-value in `kv` under `setting.<key>`; a null value removes the key.
 *                                        No key is special here: whoever reads a setting (delivery rules, the daily
 *                                        reload time...) names its own key. A change is announced as `settings.changed`.
 *   model.set {provider, model}          the runtime keeps the truth: this forwards to `service:agents/configure` for
 *                                        the primary agent and stores nothing.
 *   plugins.list / plugins.op            forwarded to `service:agents/plugins` for the primary agent.
 *   status                               time, pause, version, uptime, how many agents and hands are here.
 *   logs {lines?, level?, since?}        owner, this machine; the lines come from an injected reader.
 *   checkup.changed (event in)           a hand reports its checkup in counts; the last one is kept in `kv` (`admin.checkup`).
 *   checkup                              the last one: {known, todo, groups, at, device}.
 *
 * Who must stop while paused listens for `settings.changed` and asks `status`.
 */
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Registry, Router } from "../../kernel/types";

export const ADMIN_ID = "service:admin";
export const PAUSED_KEY = "admin.paused";
const SETTING_PREFIX = "setting.";
const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const DEFAULT_LOG_LINES = 200;

export interface AdminOptions {
  ledger: Pick<Ledger, "db" | "tx">;
  router: Pick<Router, "send">;
  registry: Pick<Registry, "list">;
  version?: string;
  now?: () => number;
  /** When the hub started, Unix ms. */
  startedAt?: number;
  /** The recent log lines, oldest first. Without it `logs` answers `unavailable`. */
  readLogs?: (query: { lines: number; level?: string; since?: number }) => string[] | Promise<string[]>;
  log?: (message: string, error?: unknown) => void;
}

const SELF: Caller = { member: ADMIN_ID, via: "service", local: true };

export class AdminService implements Member {
  readonly id = ADMIN_ID;
  readonly kind = "service" as const;
  readonly name = "Administration";
  private readonly db;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: AdminOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((m, e) => console.error(`[admin] ${m}${e ? `: ${(e as Error).message}` : ""}`));
  }

  words(): WordContract[] { return wordsOf(ADMIN_ID); }

  private isPaused(): boolean { return this.read(PAUSED_KEY, { paused: false }).paused; }

  // ---- kv ----
  private read<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  }
  private write(key: string, value: unknown): void { this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const body = (msg.body ?? {}) as Record<string, any>;
    switch (msg.word) {
      case "pause": return { data: await this.setPaused(true, typeof body.by === "string" ? body.by : msg.from) };
      case "resume": return { data: await this.setPaused(false, msg.from) };
      case "settings.get": return { data: { settings: this.settings(body.keys) } };
      case "settings.set": return { data: this.setSettings(body, msg.from) };
      case "model.set": return { data: await this.modelSet(body.provider, body.model) };
      case "plugins.list": return { data: await this.plugins({ op: "list" }) };
      case "plugins.op": return { data: await this.plugins(body.op === "plugin" ? { op: body.enabled ? "enable" : "disable", name: body.id } : body) };
      case "status": return { data: this.status() };
      case "logs": return { data: await this.logs(body) };
      case "checkup.changed": return this.keepCheckup(msg.from, body);
      case "checkup": return { data: this.read("admin.checkup", { known: false }) };
      default: throw new WordError("not_found", `service:admin has no word ${msg.word}`);
    }
  }

  // ---- pause ----
  private async setPaused(paused: boolean, by: string) {
    this.write(PAUSED_KEY, { paused, by, at: this.now() });
    this.announce(["paused"], by);
    return { paused };
  }

  /** `settings.changed` names the keys, never the values. */
  private announce(keys: string[], by: string): void {
    this.options.router.send({ to: null, kind: "event", word: "settings.changed", body: { keys, by } }, SELF)
      .then((reply) => { if (!reply.ok) this.log(`settings.changed: ${reply.error.code}: ${reply.error.message}`); }, (error) => this.log("settings.changed failed", error));
  }

  // ---- settings ----
  /** The hub's settings by name (all of them, or just the named ones). For modules that read them at assembly (the human edge). */
  settings(keys?: unknown): Record<string, unknown> {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key").all(`${SETTING_PREFIX.replace(/[\\%_]/g, "\\$&")}%`) as { key: string; value: string }[];
    const all = Object.fromEntries(rows.map((r) => [r.key.slice(SETTING_PREFIX.length), JSON.parse(r.value)]));
    return Array.isArray(keys) ? Object.fromEntries(keys.filter((k) => Object.hasOwn(all, k)).map((k) => [k, all[k]])) : all;
  }

  private setSettings(body: Record<string, unknown>, from: string) {
    const keys = Object.keys(body);
    if (!keys.length) throw new WordError("bad_request", "give the settings to change as {key: value}; null removes one");
    const bad = keys.find((k) => !KEY_PATTERN.test(k));
    if (bad) throw new WordError("bad_request", `setting name "${bad}" is lower-case words joined by dots (a-z 0-9 _)`);
    this.options.ledger.tx(() => {
      for (const key of keys) {
        if (body[key] === null) this.db.prepare("DELETE FROM kv WHERE key=?").run(SETTING_PREFIX + key);
        else this.write(SETTING_PREFIX + key, body[key]);
      }
    });
    this.announce(keys, from);
    return Object.fromEntries(keys.map((k) => [k, body[k]]));
  }

  // ---- the agent runtime owns these ----
  private async primary(): Promise<string> {
    const list = await this.options.router.send({ to: "service:agents", kind: "request", word: "list", body: {} }, SELF);
    if (!list.ok) throw new WordError(list.error.code, list.error.message);
    const agents = ((list.result?.data as { agents?: { id: string; primary?: boolean }[] } | undefined)?.agents) ?? [];
    const primary = agents.find((a) => a.primary);
    if (!primary) throw new WordError("not_found", "there is no primary agent");
    return primary.id;
  }

  private async ask(word: string, body: unknown): Promise<Record<string, any>> {
    const reply = await this.options.router.send({ to: "service:agents", kind: "request", word, body }, SELF);
    if (!reply.ok) throw new WordError(reply.error.code, reply.error.message, { recovery_hint: reply.error.recovery_hint });
    return (reply.result?.data ?? {}) as Record<string, any>;
  }

  private async modelSet(provider: string, model: string) {
    const agent = await this.primary();
    // The runtime's own way of writing it: DSH takes its model option as a JSON pair [provider, model].
    await this.ask("configure", { agent, config: { model: JSON.stringify([provider, model]) } });
    return { provider, model, restart_required: false };
  }

  private async plugins(body: Record<string, unknown>) {
    return this.ask("plugins", { ...body, agent: await this.primary() });
  }

  /** The phone's summary, as it sent it (counts and short phrases). Only a hand's report counts. */
  private keepCheckup(from: string, body: Record<string, any>): void {
    if (!from.startsWith("device:")) return;
    this.write("admin.checkup", { known: true, todo: body.todo, groups: body.groups, at: this.now(), device: from });
  }

  // ---- reading ----
  private status() {
    return { now: this.now(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, paused: this.isPaused(),
      ...(this.options.version ? { version: this.options.version } : {}),
      ...(this.options.startedAt !== undefined ? { uptime_ms: Math.max(0, this.now() - this.options.startedAt) } : {}),
      agents: this.options.registry.list({ kind: "agent" }).length, hands_online: this.options.registry.list({ kind: "device" }).length };
  }

  private async logs(body: Record<string, any>) {
    if (!this.options.readLogs) throw new WordError("unavailable", "this hub keeps no log file to read");
    return { lines: await this.options.readLogs({ lines: body.lines ?? DEFAULT_LOG_LINES, level: body.level, since: body.since }) };
  }
}

export function createAdminService(options: AdminOptions): AdminService { return new AdminService(options); }

export { tailFile } from "./tail";
