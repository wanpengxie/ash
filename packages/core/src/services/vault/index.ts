/**
 * `service:vault`: the credentials of everything that goes through the hub (VAULT-DESIGN): its service connections
 * (OAuth tokens it renews itself), keys and passwords the owner saves or an agent obtained, secrets the hub generates.
 * Command-line tools in the body keep their own logins; none of that is here.
 *
 *   list / describe            what is kept: name, kind, service, status, expiry. Never a value.
 *   set / delete               the owner (keys page, fill-in card).
 *   put                        an agent stores a key it obtained; write-only, it cannot replace the owner's or a connection's.
 *   generate                   the hub makes a random secret.
 *   request                    an agent asks the owner for a key: the entry waits on the keys page and the owner gets a card.
 *   services / connect         the hub's OAuth connections: what can be connected, start one (oauth.ts).
 *
 * Values live sealed in the vault; what is not secret (label, kind, service, status, expiry) lives in `vault_meta`.
 * A change is announced as `vault.changed {ref, action}` to service:agents (names only).
 */
import { randomBytes } from "node:crypto";
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import { OWNER_ID } from "../../../../sdk/src/ids";
import type { HostNetwork } from "../../../../sdk/src/host";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Router, Vault } from "../../kernel/types";
import { REF_PATTERN } from "../../kernel/vault";
import { createOAuth, PROVIDERS, providerOf, type OAuth, type TokenSet } from "./oauth";

export const VAULT_ID = "service:vault";
type Kind = "oauth" | "key" | "password" | "generated";
type Origin = "owner" | "agent" | "hub";

/** The hub's own keys the owner is shown even before they are set. */
const KNOWN: Record<string, { label: string; kind: Kind }> = {
  DEEPSEEK_API_KEY: { label: "DeepSeek（对话模型）", kind: "key" },
  OPENROUTER_API_KEY: { label: "OpenRouter（小模型判断）", kind: "key" },
};

export interface VaultServiceOptions {
  vault: Pick<Vault, "set" | "delete" | "list" | "use">;
  ledger: Pick<Ledger, "db">;
  router: Pick<Router, "send">;
  network?: () => HostNetwork | null;
  /** Was this app granted the credential (app.json needs `{credential: ref}`)? */
  appCredential?: (app: string, ref: string) => boolean;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

interface Row { ref: string; label: string; kind: string; service: string | null; why: string | null; help_url: string | null; account: string | null;
  scopes: string | null; expires_at: number | null; status: string | null; origin: string | null; requested_by: string | null; last_used_at: number | null }

const SELF: Caller = { member: VAULT_ID, via: "service", local: true };
const COLUMNS: Record<string, string> = { service: "TEXT", why: "TEXT", help_url: "TEXT", account: "TEXT", scopes: "TEXT", expires_at: "INTEGER", status: "TEXT",
  origin: "TEXT", requested_by: "TEXT", last_used_at: "INTEGER" };

export function createVaultService(options: VaultServiceOptions): Member & { oauth: OAuth; token(ref: string): Promise<string> } {
  const { vault, router } = options;
  const now = options.now ?? Date.now;
  const db = options.ledger.db();
  const log = options.log ?? ((m, e) => console.error(`[vault] ${m}${e ? `: ${(e as Error).message}` : ""}`));
  db.exec("CREATE TABLE IF NOT EXISTS vault_meta (ref TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL)");
  const have = new Set((db.prepare("PRAGMA table_info(vault_meta)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of Object.entries(COLUMNS)) if (!have.has(name)) db.exec(`ALTER TABLE vault_meta ADD COLUMN ${name} ${type}`);

  // The services taught as data come back on every start.
  db.exec("CREATE TABLE IF NOT EXISTS vault_providers (service TEXT PRIMARY KEY, data TEXT NOT NULL)");
  for (const r of db.prepare("SELECT service, data FROM vault_providers").all() as { service: string; data: string }[]) {
    try { PROVIDERS[r.service] = JSON.parse(r.data); } catch (error) { log(`provider ${r.service}`, error); }
  }

  const row = (ref: string): Row | undefined => db.prepare("SELECT * FROM vault_meta WHERE ref=?").get(ref) as Row | undefined;
  const upsert = (ref: string, fields: Partial<Omit<Row, "ref">> & { label: string; kind: Kind }): void => {
    const cur = row(ref);
    const next = { ...(cur ?? {}), ...fields, ref } as Record<string, unknown>;
    const cols = ["ref", "label", "kind", ...Object.keys(COLUMNS)];
    db.prepare(`INSERT OR REPLACE INTO vault_meta(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => (next[c] ?? null) as string | number | null));
  };
  const kindOf = (k: string | undefined): Kind => (k === "oauth" || k === "password" || k === "generated" ? k : "key");

  const entry = (ref: string) => {
    const set = vault.list().find((e) => e.ref === ref);
    const r = row(ref);
    const known = KNOWN[ref];
    const expires = r?.expires_at ?? undefined;
    const status = !set ? (r?.status === "waiting" ? "waiting" : "missing") : r?.status === "broken" ? "broken" : expires && expires < now() + 7 * 86_400_000 && kindOf(r?.kind) !== "oauth" ? "expiring" : "ok";
    return {
      ref, label: r?.label ?? known?.label ?? ref, kind: kindOf(r?.kind ?? known?.kind), configured: set !== undefined, status,
      ...(r?.service ? { service: r.service } : {}), ...(r?.why ? { why: r.why } : {}), ...(r?.help_url ? { help_url: r.help_url } : {}),
      ...(r?.account ? { account: r.account } : {}), ...(r?.scopes ? { scopes: JSON.parse(r.scopes) as string[] } : {}),
      ...(expires ? { expires_at: expires } : {}), ...(set ? { updated_at: set.set_at } : {}), ...(r?.last_used_at ? { last_used_at: r.last_used_at } : {}),
    };
  };
  const announce = (ref: string, action: "saved" | "removed" | "connected" | "broken"): void => {
    router.send({ to: "service:agents", kind: "event", word: "vault.changed", body: { ref, action } }, SELF)
      .then((reply) => { if (!reply.ok) log(`vault.changed ${ref}: ${reply.error.code}: ${reply.error.message}`); }, (error) => log("vault.changed failed", error));
  };
  const tell = (agent: string, text: string): void => {
    router.send({ to: agent, kind: "request", word: "tell", body: { text } }, SELF).then((r) => { if (!r.ok) log(`tell ${agent}: ${r.error.code}`); }, (e) => log(`tell ${agent} failed`, e));
  };
  // The open fill-in card of each requested key: it closes once the key is saved or the entry deleted.
  const cards = new Map<string, AbortController>();
  const closeCard = (ref: string): void => { cards.get(ref)?.abort(); cards.delete(ref); };
  const refOf = (body: unknown): string => {
    const ref = (body as { ref?: unknown } | null)?.ref;
    if (typeof ref !== "string" || !REF_PATTERN.test(ref)) throw new WordError("bad_request", "ref is letters, digits and _ (at most 64), starting with a letter or _");
    return ref;
  };
  const store = (ref: string, value: string): void => {
    try { vault.set(ref, value); } catch (error) { throw new WordError("bad_request", (error as Error).message); }
  };

  const oauth = createOAuth({
    secret: (ref) => vault.use(ref),
    save: (ref, tokens: TokenSet, m) => {
      const first = row(ref)?.status !== "ok" || !vault.list().some((e) => e.ref === ref);
      store(ref, JSON.stringify(tokens));
      upsert(ref, { label: m.label, kind: "oauth", service: m.service, scopes: JSON.stringify(m.scopes), expires_at: tokens.expires_at, status: "ok", origin: "hub",
        ...(m.account ? { account: m.account } : {}) });
      if (first) announce(ref, "connected");
    },
    broken: (ref) => { const r = row(ref); if (r) upsert(ref, { label: r.label, kind: kindOf(r.kind), status: "broken" }); announce(ref, "broken"); },
    network: () => options.network?.() ?? null,
    now,
    log,
  });

  const tokenOf = async (ref: string): Promise<string> => {
    const token = await oauth.token(ref);
    db.prepare("UPDATE vault_meta SET last_used_at=? WHERE ref=?").run(now(), ref);
    return token;
  };

  return {
    id: VAULT_ID, kind: "service", name: "Vault",
    words: (): WordContract[] => wordsOf(VAULT_ID),
    oauth,
    /** For the hub's service members: a working token of the connection [ref]; its use is noted. */
    token: tokenOf,
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
      const body = (msg.body ?? {}) as Record<string, unknown>;
      // A value is only in the original request; the ledger's copy of the body is the masked placeholder.
      const raw = (ctx.raw ?? {}) as Record<string, unknown>;
      switch (msg.word) {
        case "list": {
          const metaRefs = (db.prepare("SELECT ref FROM vault_meta").all() as { ref: string }[]).map((r) => r.ref);
          const refs = new Set([...Object.keys(KNOWN), ...vault.list().map((e) => e.ref), ...metaRefs]);
          return { data: { entries: [...refs].sort().map(entry) } };
        }
        case "describe": return { data: entry(refOf(body)) };
        case "set": {
          const ref = refOf(raw);
          if (typeof raw.value !== "string") throw new WordError("bad_request", "value must be the secret text");
          store(ref, raw.value);
          const r = row(ref);
          upsert(ref, { label: typeof raw.label === "string" ? raw.label : r?.label ?? KNOWN[ref]?.label ?? ref, kind: kindOf(typeof raw.kind === "string" ? raw.kind : r?.kind ?? KNOWN[ref]?.kind),
            status: "ok", origin: "owner" });
          announce(ref, "saved");
          closeCard(ref);
          if (r?.requested_by) tell(r.requested_by, `主人存好了 ${ref}（${r.label}）。`);
          return { data: { ref, configured: true } };
        }
        case "put": {
          const ref = refOf(raw);
          const r = row(ref);
          const set = vault.list().some((e) => e.ref === ref);
          if (set && kindOf(r?.kind) === "oauth") throw new WordError("conflict", `${ref} is a connection's token, kept and renewed by the hub`, { recovery_hint: "Connect it again with service:vault/connect to replace it." });
          if (typeof raw.value !== "string") throw new WordError("bad_request", "value must be the secret text");
          store(ref, raw.value);
          upsert(ref, { label: String(raw.label ?? r?.label ?? KNOWN[ref]?.label ?? ref), kind: kindOf(String(raw.kind ?? r?.kind ?? "key")), status: "ok", origin: "agent", ...(typeof raw.service === "string" ? { service: raw.service } : {}) });
          announce(ref, "saved");
          return { data: { ref, configured: true } };
        }
        case "generate": {
          const ref = refOf(body);
          const bytes = typeof body.bytes === "number" ? body.bytes : 32;
          store(ref, randomBytes(bytes).toString("base64url"));
          upsert(ref, { label: String(body.label), kind: "generated", status: "ok", origin: "hub" });
          announce(ref, "saved");
          return { data: { ref, configured: true } };
        }
        case "request": {
          const ref = refOf(body);
          // A key that is set is asked for again only when it no longer works (replace: the provider rejected it, it ran out).
          if (vault.list().some((e) => e.ref === ref) && row(ref)?.status !== "broken" && body.replace !== true) return { data: { ref, status: "ok" } };
          const label = String(body.label), why = String(body.why);
          const help = typeof body.help_url === "string" && /^https:\/\//.test(body.help_url) ? body.help_url : undefined;
          upsert(ref, { label, kind: kindOf(String(body.kind ?? "key")), why, status: "waiting", origin: "owner", requested_by: ctx.caller.member,
            ...(help ? { help_url: help } : {}), ...(typeof body.service === "string" ? { service: body.service } : {}) });
          // The owner's card: filling in happens on the keys page (the card's button opens it there), never in the conversation.
          const card = { title: `需要你填：${label}`, detail: [why, help ? `去哪拿：${help}` : ""].filter(Boolean).join("\n"), human_kind: "question",
            // The option id `vault_fill` makes the owner's side open the keys page.
            options: [{ id: "vault_fill", label: "去填写" }, { id: "no", label: "不给" }], expires_at: now() + 7 * 86_400_000 };
          closeCard(ref);
          const controller = new AbortController();
          cards.set(ref, controller);
          void router.send({ to: OWNER_ID, kind: "request", word: "ask", body: card }, SELF, { signal: controller.signal }).then((reply) => {
            if (cards.get(ref) === controller) cards.delete(ref);
            const choice = reply.ok ? (reply.result?.data as { choice?: string } | undefined)?.choice : undefined;
            if (choice === "no") tell(ctx.caller.member, `主人不给 ${ref}（${label}）。换个不用它的办法，或问他为什么。`);
          }, (e) => log("request card failed", e));
          return { data: { ref, status: "waiting" } };
        }
        case "delete": {
          const ref = refOf(body);
          const existed = vault.list().some((e) => e.ref === ref) || row(ref) !== undefined;
          if (kindOf(row(ref)?.kind) === "oauth") await oauth.revoke(ref);
          if (vault.list().some((e) => e.ref === ref)) vault.delete(ref);
          db.prepare("DELETE FROM vault_meta WHERE ref=?").run(ref);
          closeCard(ref);
          if (existed) announce(ref, "removed");
          return { data: { deleted: existed } };
        }
        case "services": {
          const services = Object.values(PROVIDERS).map((p) => {
            const needs = [p.client.id_ref, p.client.secret_ref].filter((r) => !vault.use(r));
            return { service: p.service, label: p.label, scopes: p.scopes, needs, connected: entry(p.service).status === "ok" && vault.list().some((e) => e.ref === p.service),
              ref: p.service, ...(needs.length ? { how: p.client.how } : {}) };
          });
          return { data: { services } };
        }
        case "token": {
          const ref = refOf(body);
          if (ctx.caller.via !== "app" || !options.appCredential?.(ctx.caller.member, ref)) throw new WordError("forbidden", `${ctx.caller.member} was not granted ${ref}`, { recovery_hint: "Declare {credential: \"" + ref + "\", why} in app.json's needs; the owner approves it." });
          const kind = kindOf(row(ref)?.kind ?? KNOWN[ref]?.kind);
          if (kind === "oauth") {
            const value = await tokenOf(ref);
            return { data: { ref, value, kind, ...(row(ref)?.expires_at ? { expires_at: row(ref)!.expires_at! } : {}) } };
          }
          const value = vault.use(ref);
          if (!value) throw new WordError("unavailable", `${ref} is not set`, { recovery_hint: "Ask the owner for it (service:vault/request) or connect it." });
          db.prepare("UPDATE vault_meta SET last_used_at=? WHERE ref=?").run(now(), ref);
          return { data: { ref, value, kind } };
        }
        case "provider": {
          const p = providerOf(body);
          PROVIDERS[p.service] = p;
          db.prepare("INSERT OR REPLACE INTO vault_providers(service, data) VALUES(?,?)").run(p.service, JSON.stringify(p));
          return { data: { service: p.service } };
        }
        case "connect": {
          const started = await oauth.start(String(body.service));
          return { data: started };
        }
        default: throw new WordError("not_found", `service:vault has no word ${msg.word}`);
      }
    },
  };
}
