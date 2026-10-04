import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
  DEEPSEEK_API_KEY: { label: "DeepSeek（对话模型）", kind: "model" },
  OPENROUTER_API_KEY: { label: "OpenRouter（JEV 快速判断模型）", kind: "model" },
};

export interface VaultInfo { ref: string; label: string; kind: Kind; configured: boolean; updated_at?: number }
export interface VaultAvailability { available: boolean }

export class VaultUnavailableError extends Error {
  constructor() { super("secure credential storage is unavailable"); this.name = "VaultUnavailableError"; }
}

/**
 * The values themselves: one private file in ash's state directory, replaced atomically. Nothing here is on the ledger,
 * in a message body, or in the process environment. Only ash's own code reads a value; the DSH world gets one through the
 * ash-vault plugin and nothing else.
 */
export class VaultStore {
  private entries: Record<string, Entry>;
  private readonly unavailable: boolean;

  /**
   * With a seal key (on the phone: a key that only Android Keystore can unwrap), the file is AES-256-GCM encrypted, and a
   * plain file from before is sealed on first load. Without one the file stays plain, as in tests and on a computer.
   */
  constructor(private readonly file: string, private readonly now: () => number = Date.now, private readonly sealKey?: Buffer,
    unavailable = false) {
    this.unavailable = unavailable;
    if (unavailable) { this.entries = {}; return; }
    if (sealKey && sealKey.length !== 32) throw new TypeError("vault seal key must be 32 bytes");
    this.entries = existsSync(file) ? this.read() : {};
    if (sealKey && this.plainOnDisk) this.write(this.entries); // a vault from before sealing is sealed now
  }

  /** Android uses this path: no usable Keystore key means no read, write, rename, or plaintext fallback. */
  static secure(file: string, now: () => number = Date.now, sealKey?: Buffer): VaultStore {
    if (!sealKey) return new VaultStore(file, now, undefined, true);
    try { return new VaultStore(file, now, sealKey); }
    catch { return new VaultStore(file, now, undefined, true); }
  }

  private plainOnDisk = false;

  private open(raw: string): string {
    const outer = JSON.parse(raw) as { sealed?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
    this.plainOnDisk = outer.sealed === undefined;
    if (outer.sealed === undefined) return raw;
    if (outer.sealed !== 1 || typeof outer.iv !== "string" || typeof outer.tag !== "string" || typeof outer.data !== "string") throw new Error("unknown vault format");
    if (!this.sealKey) throw new Error("vault is sealed and no key was given");
    const decipher = createDecipheriv("aes-256-gcm", this.sealKey, Buffer.from(outer.iv, "base64"));
    decipher.setAuthTag(Buffer.from(outer.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(outer.data, "base64")), decipher.final()]).toString("utf8");
  }

  private seal(text: string): string {
    if (!this.sealKey) return text;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey, iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return JSON.stringify({ sealed: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
  }

  private read(): Record<string, Entry> {
    try {
      const parsed = JSON.parse(this.open(readFileSync(this.file, "utf8"))) as { entries?: Record<string, Entry> };
      const out: Record<string, Entry> = {};
      for (const [ref, entry] of Object.entries(parsed.entries ?? {}))
        if (REF.test(ref) && typeof entry?.value === "string" && entry.value) out[ref] = entry;
      return out;
    } catch { throw new Error("the credential vault file is unreadable; it was left untouched"); }
  }

  static validRef(ref: unknown): ref is string { return typeof ref === "string" && REF.test(ref); }

  availability(): VaultAvailability { return { available: !this.unavailable }; }

  /** The value, for ash's own code only. */
  get(ref: string): string | null { return this.entries[ref]?.value ?? null; }
  has(ref: string): boolean { return this.entries[ref] !== undefined; }

  set(ref: string, value: string): void {
    if (this.unavailable) throw new VaultUnavailableError();
    if (!VaultStore.validRef(ref)) throw new TypeError("invalid credential name");
    if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE) throw new TypeError("invalid credential value");
    const known = KNOWN[ref];
    this.write({ ...this.entries, [ref]: { value: value.trim(), label: known?.label ?? ref, kind: known?.kind ?? "other", updated_at: this.now() } });
  }

  remove(ref: string): boolean {
    if (this.unavailable) throw new VaultUnavailableError();
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
    writeFileSync(tmp, this.seal(JSON.stringify({ version: 1, entries: next })), { mode: 0o600 });
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
