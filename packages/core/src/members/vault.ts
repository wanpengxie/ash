import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { WorldRouter, RouteHandlerContext, TrustedRouteContext } from "../world/router";

const service: TrustedRouteContext = { member: "service:vault", transport: "service", transportPrincipal: "service:vault",
  local: true, remote: false, ownerProxy: false };

const REF = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_VALUE = 4096;

type Kind = "model" | "login" | "api" | "other";
interface Entry { value: string; label: string; kind: Kind; updated_at: number }

/** What the owner sees a known credential called. Anything else is shown under its own name. */
const KNOWN: Record<string, { label: string; kind: Kind }> = {
  DEEPSEEK_API_KEY: { label: "DeepSeek 模型", kind: "model" },
  OPENROUTER_API_KEY: { label: "OpenRouter（JEV 停止判断）", kind: "model" },
};

export interface VaultInfo { ref: string; label: string; kind: Kind; configured: boolean; updated_at?: number }

/**
 * The values themselves: one private file in ash's state directory, replaced atomically. Nothing here is on the ledger,
 * in a message body, or in the process environment. Only ash's own code reads a value; the DSH world gets one through the
 * ash-vault plugin and nothing else.
 */
export class VaultStore {
  private entries: Record<string, Entry>;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.entries = existsSync(file) ? this.read() : {};
  }

  private read(): Record<string, Entry> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { entries?: Record<string, Entry> };
      const out: Record<string, Entry> = {};
      for (const [ref, entry] of Object.entries(parsed.entries ?? {}))
        if (REF.test(ref) && typeof entry?.value === "string" && entry.value) out[ref] = entry;
      return out;
    } catch { throw new Error("the credential vault file is unreadable; it was left untouched"); }
  }

  static validRef(ref: unknown): ref is string { return typeof ref === "string" && REF.test(ref); }

  /** The value, for ash's own code only. */
  get(ref: string): string | null { return this.entries[ref]?.value ?? null; }
  has(ref: string): boolean { return this.entries[ref] !== undefined; }

  set(ref: string, value: string): void {
    if (!VaultStore.validRef(ref)) throw new TypeError("invalid credential name");
    if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE) throw new TypeError("invalid credential value");
    const known = KNOWN[ref];
    this.write({ ...this.entries, [ref]: { value: value.trim(), label: known?.label ?? ref, kind: known?.kind ?? "other", updated_at: this.now() } });
  }

  remove(ref: string): boolean {
    if (!this.entries[ref]) return false;
    const next = { ...this.entries };
    delete next[ref];
    this.write(next);
    return true;
  }

  describe(ref: string): VaultInfo {
    const entry = this.entries[ref];
    const known = KNOWN[ref];
    return entry ? { ref, label: entry.label, kind: entry.kind, configured: true, updated_at: entry.updated_at }
      : { ref, label: known?.label ?? ref, kind: known?.kind ?? "other", configured: false };
  }

  list(): VaultInfo[] {
    const refs = new Set([...Object.keys(KNOWN), ...Object.keys(this.entries)]);
    return [...refs].sort().map((ref) => this.describe(ref));
  }

  private write(next: Record<string, Entry>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: next }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.entries = next;
  }
}

/** The ash-world face of the vault: what an agent or the owner may ask, and the audit fact when a credential changes. */
export class VaultMember implements Member {
  readonly id = "service:vault";
  readonly kind = "service" as const;
  readonly name = "Vault";
  readonly online = true;

  constructor(readonly store: VaultStore, private readonly router: WorldRouter) {}

  words(): readonly WordSpec[] { return ["list", "describe"].map((word) => wordContract("service:vault", word)!); }

  async handle(message: Message, _context: RouteHandlerContext): Promise<ResponseBody> {
    if (message.word === "list") return { ok: true, result: { entries: this.store.list().map(({ ref, label, kind, configured }) => ({ ref, label, kind, configured })) } };
    if (message.word === "describe") {
      const ref = message.body.ref;
      if (!VaultStore.validRef(ref)) return { ok: false, error: { code: "bad_request", message: "invalid credential name" } };
      const info = this.store.describe(ref);
      return { ok: true, result: { ref: info.ref, label: info.label, kind: info.kind, configured: info.configured } };
    }
    return { ok: false, error: { code: "not_found", message: "vault word unavailable" } };
  }

  /** Called by the owner's settings route only. The value goes to the store and nowhere else. */
  async save(ref: string, value: string): Promise<void> {
    this.store.set(ref, value);
    await this.announce(ref, "saved");
  }

  async remove(ref: string): Promise<boolean> {
    const removed = this.store.remove(ref);
    if (removed) await this.announce(ref, "removed");
    return removed;
  }

  private async announce(ref: string, action: "saved" | "removed"): Promise<void> {
    await this.router.send(service, { to: null, kind: "event", word: "vault.changed", body: { ref, action } });
  }
}
