/**
 * Vault entries used by name (VAULT-DESIGN): a value `"$vault.<name>"` stands for the entry of that name. An agent writes
 * only the name; the hub puts the value in where it is used and nowhere else.
 *
 * - `resolveRefs`: one place that turns names into values, for a request on its way to a body (`workspace.bash` env) and
 *   for the environment an app, an agent runtime or an MCP server starts with. Nothing here logs or keeps a value.
 * - `Scrubber`: every value put in is replaced by `***` in what comes back from where it went (its base64 and URL-encoded
 *   forms too), before the ledger or the caller sees it.
 */
import { WordError } from "../../../../sdk/src/message";

export const VAULT_REF = /^\$vault\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;
/** `$$vault.x` is the literal text `$vault.x`. */
const ESCAPED = /^\$\$vault\./;

/** The vault names an environment refers to. */
export function refsIn(env: unknown): string[] {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const names = new Set<string>();
  for (const value of Object.values(env as Record<string, unknown>)) {
    const m = typeof value === "string" ? VAULT_REF.exec(value) : null;
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/**
 * The environment with every `$vault.<name>` replaced by its value ([resolve]: the value, or a WordError not_found /
 * unavailable that says how to get it). Returns the values put in, for the scrubber.
 */
export async function resolveRefs(env: Record<string, string>, resolve: (name: string) => Promise<string>): Promise<{ env: Record<string, string>; values: string[] }> {
  const out: Record<string, string> = {};
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const m = VAULT_REF.exec(value);
    if (m) { const v = await resolve(m[1]!); out[key] = v; values.push(v); }
    else out[key] = ESCAPED.test(value) ? value.slice(1) : value;
  }
  return { env: out, values };
}

/** A name that is not there, or not usable now: what the agent is told. */
export const missingRef = (name: string, status: "missing" | "waiting" | "broken" | "expired"): WordError =>
  status === "missing"
    ? new WordError("not_found", `the vault has no ${name}`, { recovery_hint: `Ask the owner for it with person:owner/form {secret: {field: "${name}"}} (or service:vault/request), then use $vault.${name}.` })
    : new WordError("unavailable", `${name} is in the vault but cannot be used now (${status})`, { recovery_hint: `Ask the owner for it again with service:vault/request {ref: "${name}", replace: true} or person:owner/form.` });

/** The shortest value that is masked: shorter ones would mask ordinary words. */
const MIN_SCRUB = 4;
const MAX_VALUES = 256;

export class Scrubber {
  private readonly forms = new Map<string, true>();

  /** Mask this value (and its encoded forms) from now on. */
  add(value: string): void {
    if (value.length < MIN_SCRUB) return;
    for (const form of [value, Buffer.from(value, "utf8").toString("base64"), Buffer.from(value, "utf8").toString("base64url"), encodeURIComponent(value)]) {
      if (form.length < MIN_SCRUB) continue;
      this.forms.delete(form);
      this.forms.set(form, true);
    }
    // The oldest go first; a long-running hub does not grow without end.
    while (this.forms.size > MAX_VALUES * 4) this.forms.delete(this.forms.keys().next().value!);
  }

  get size(): number { return this.forms.size; }

  /** [value] with every known secret replaced by `***`, at any depth (strings in objects and arrays). */
  scrub<T>(value: T): T {
    if (!this.forms.size) return value;
    const longest = [...this.forms.keys()].sort((a, b) => b.length - a.length);
    const text = (s: string): string => { let out = s; for (const f of longest) if (out.includes(f)) out = out.split(f).join("***"); return out; };
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return text(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(value) as T;
  }
}

/** What the router is given (RouterDeps.secrets): `$vault.<name>` in a command's environment, for every body. */
export function bodySecrets(resolve: (name: string) => Promise<string>, state: (name: string) => "ok" | "missing" | "broken") {
  const scrubber = new Scrubber();
  const isBody = (to: string | null) => typeof to === "string" && to.startsWith("body:");
  return {
    scrubber,
    /** Before the gate: a name the vault does not have (or cannot use now) is refused at once, without asking the owner about it. */
    check(msg: { to: string | null; word: string; body?: unknown }): WordError | null {
      if (!isBody(msg.to) || msg.word !== "workspace.bash") return null;
      for (const name of refsIn((msg.body as { env?: unknown } | null)?.env)) {
        const now = state(name);
        if (now !== "ok") return missingRef(name, now);
      }
      return null;
    },
    async inject(msg: { to: string | null; word: string }, raw: unknown): Promise<unknown | null> {
      const env = (raw as { env?: unknown } | null)?.env;
      if (!isBody(msg.to) || msg.word !== "workspace.bash" || !env || typeof env !== "object") return null;
      if (!Object.values(env).some((v) => typeof v === "string" && v.startsWith("$"))) return null;
      const resolved = await resolveRefs(env as Record<string, string>, resolve);
      for (const value of resolved.values) scrubber.add(value);
      return { ...(raw as Record<string, unknown>), env: resolved.env };
    },
    scrub<T>(to: string | null, reply: T): T { return isBody(to) ? scrubber.scrub(reply) : reply; },
  };
}
