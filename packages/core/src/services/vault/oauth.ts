/**
 * The hub's OAuth (VAULT-DESIGN §授权怎么来): a provider is data; the hub runs the authorization-code flow with PKCE on a
 * loopback callback it opens for the flow only (RFC 8252), keeps the token in the vault and renews it before it expires.
 * The token never leaves the hub: the hub's service members ask `token(ref)` and call the provider themselves.
 */
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { ProxyAgent, fetch as proxiedFetch } from "undici";
import { WordError } from "../../../../sdk/src/message";
import type { HostNetwork } from "../../../../sdk/src/host";

export interface Provider {
  service: string;
  label: string;
  /** What the owner reads on the approval card: what the connection lets Ash do. */
  grants: string;
  auth_url: string;
  token_url: string;
  revoke_url?: string;
  scopes: string[];
  extra?: Record<string, string>;
  /** The OAuth app: vault refs of its client id and secret (an agent stores them with vault.put), and how to make one. */
  client: { id_ref: string; secret_ref: string; how: string };
  /** Who the token belongs to, for the keys page. */
  account?: (token: string, fetcher: Fetcher) => Promise<string | undefined>;
}

export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

/**
 * The services the hub can connect: data, one entry per service (VAULT-DESIGN). A service member that uses a connection
 * gets its token with the vault's `token(ref)`; the ref is the service name.
 */
export const PROVIDERS: Record<string, Provider> = {};

/** A provider written as data (service:vault/provider), checked before the hub keeps it. */
export function providerOf(body: Record<string, unknown>): Provider {
  const url = (key: string, required: boolean): string | undefined => {
    const value = body[key];
    if (value === undefined || value === "") { if (required) throw new WordError("bad_request", `${key} is required`); return undefined; }
    let u: URL;
    try { u = new URL(String(value)); } catch { throw new WordError("bad_request", `${key} is not an address`); }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "127.0.0.1")) throw new WordError("bad_request", `${key} must be https`);
    return u.toString();
  };
  return {
    service: String(body.service), label: String(body.label), grants: String(body.grants), auth_url: url("auth_url", true)!, token_url: url("token_url", true)!,
    ...(url("revoke_url", false) ? { revoke_url: url("revoke_url", false)! } : {}), scopes: (body.scopes as string[]) ?? [],
    ...(body.extra ? { extra: body.extra as Record<string, string> } : {}),
    client: { id_ref: String(body.client_id_ref), secret_ref: String(body.client_secret_ref), how: typeof body.how === "string" ? body.how : "" },
  };
}

/** What the vault keeps for a connection: one sealed JSON value. */
export interface TokenSet { access_token: string; refresh_token?: string; expires_at: number; scope?: string; token_type?: string }

export interface OAuthDeps {
  secret(ref: string): string | null;
  save(ref: string, tokens: TokenSet, meta: { service: string; label: string; scopes: string[]; account?: string }): void;
  broken(ref: string, reason: string): void;
  network(): HostNetwork | null;
  now(): number;
  log(message: string, error?: unknown): void;
}

const FLOW_MS = 15 * 60_000;
const RENEW_BEFORE_MS = 2 * 60_000;

const page = (text: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ash</title><body style="font-family:sans-serif;padding:2rem"><h2>${text}</h2></body>`;

export function createOAuth(deps: OAuthDeps) {
  const flows = new Map<string, { server: Server; timer: NodeJS.Timeout }>();
  const renewing = new Map<string, Promise<string>>();

  const fetcher: Fetcher = (url, init = {}) => {
    const proxy = deps.network()?.proxy?.https ?? deps.network()?.proxy?.http ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
    return proxiedFetch(url, { ...init, ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}) }) as never;
  };

  async function tokenCall(p: Provider, form: Record<string, string>): Promise<TokenSet> {
    const r = await fetcher(p.token_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString() });
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok || !json.access_token) throw Object.assign(new Error(`${p.label} token: ${r.status} ${json.error ?? text.slice(0, 200)}`), { oauth: json.error });
    return { access_token: json.access_token, ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}), expires_at: deps.now() + (Number(json.expires_in) || 3600) * 1000,
      ...(json.scope ? { scope: json.scope } : {}), ...(json.token_type ? { token_type: json.token_type } : {}) };
  }

  function client(p: Provider): { id: string; secret: string } {
    const id = deps.secret(p.client.id_ref), secret = deps.secret(p.client.secret_ref);
    if (!id || !secret) throw new WordError("unavailable", `${p.label} needs an OAuth app first: ${p.client.id_ref} and ${p.client.secret_ref} are not stored`, { recovery_hint: p.client.how });
    return { id, secret };
  }

  function end(ref: string): void {
    const flow = flows.get(ref);
    if (!flow) return;
    clearTimeout(flow.timer);
    flow.server.close();
    flows.delete(ref);
  }

  return {
    providers: PROVIDERS,
    fetcher,

    /** Starts a flow for [service]; answers the page to authorize on. A flow already open for it is replaced. */
    async start(service: string): Promise<{ ref: string; auth_url: string; scopes: string[]; expires_at: number }> {
      const p = PROVIDERS[service];
      if (!p) throw new WordError("not_found", `the hub cannot connect ${service}; vault.services lists what it can`);
      const app = client(p);
      const ref = p.service;
      end(ref);
      const verifier = randomBytes(48).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      let exchange: Promise<void> | null = null;
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const send = (status: number, text: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(page(text)); };
        if (u.pathname !== "/oauth/callback") return send(404, "不是这里");
        if (u.searchParams.get("state") !== state) return send(400, "这个链接不是这一次的，回到 Ash 再来");
        if (u.searchParams.get("error")) { send(400, "没有授权。回到 Ash 就行。"); deps.log(`oauth ${service}: ${u.searchParams.get("error")}`); end(ref); return; }
        const code = u.searchParams.get("code");
        if (!code) return send(400, "没拿到授权码，回到 Ash 再来");
        // The browser may open the callback twice; the code is exchanged once and both visits wait for it.
        exchange ??= (async () => {
          const tokens = await tokenCall(p, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: app.id, client_secret: app.secret });
          const account = await p.account?.(tokens.access_token, fetcher).catch(() => undefined);
          deps.save(ref, tokens, { service, label: p.label, scopes: p.scopes, ...(account ? { account } : {}) });
        })();
        exchange.then(() => { send(200, `已连接 ${p.label}，回到 Ash 就行。`); end(ref); },
          (error) => { deps.log(`oauth ${service}`, error); send(500, "连接没成，回到 Ash 再试一次"); end(ref); });
      });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
      const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/oauth/callback`;
      const expires_at = deps.now() + FLOW_MS;
      flows.set(ref, { server, timer: setTimeout(() => end(ref), FLOW_MS) });
      const auth_url = `${p.auth_url}?${new URLSearchParams({ response_type: "code", client_id: app.id, redirect_uri: redirect, scope: p.scopes.join(" "), state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...(p.extra ?? {}) })}`;
      return { ref, auth_url, scopes: p.scopes, expires_at };
    },

    /** A working access token of the connection [ref], renewed first when it is about to expire (once at a time). */
    async token(ref: string): Promise<string> {
      const raw = deps.secret(ref);
      const p = PROVIDERS[ref];
      if (!raw || !p) throw new WordError("unavailable", `${p?.label ?? ref} is not connected`, { recovery_hint: `Connect it with service:vault/connect {service: "${ref}"} (skill credentials).` });
      const tokens = JSON.parse(raw) as TokenSet;
      if (tokens.expires_at - RENEW_BEFORE_MS > deps.now()) return tokens.access_token;
      if (!tokens.refresh_token) { deps.broken(ref, "expired"); throw new WordError("unavailable", `${p.label} expired`, { recovery_hint: `Connect it again with service:vault/connect {service: "${ref}"}.` }); }
      const running = renewing.get(ref);
      if (running) return running;
      const renew = (async () => {
        try {
          const app = client(p);
          const next = await tokenCall(p, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: app.id, client_secret: app.secret });
          deps.save(ref, { ...next, refresh_token: next.refresh_token ?? tokens.refresh_token }, { service: p.service, label: p.label, scopes: p.scopes });
          return next.access_token;
        } catch (error) {
          if ((error as { oauth?: string }).oauth === "invalid_grant") deps.broken(ref, "the service took the authorization back");
          throw new WordError("unavailable", `${p.label} could not be renewed: ${(error as Error).message}`, { recovery_hint: `Connect it again with service:vault/connect {service: "${ref}"}.` });
        } finally { renewing.delete(ref); }
      })();
      renewing.set(ref, renew);
      return renew;
    },

    /** Revokes the connection's token at the service, when it can; never throws. */
    async revoke(ref: string): Promise<void> {
      const p = PROVIDERS[ref], raw = deps.secret(ref);
      if (!p?.revoke_url || !raw) return;
      try {
        const t = JSON.parse(raw) as TokenSet;
        await fetcher(p.revoke_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }).toString() });
      } catch (error) { deps.log(`revoke ${ref}`, error); }
    },

    pending(ref: string): boolean { return flows.has(ref); },
    stop(): void { for (const ref of [...flows.keys()]) end(ref); },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
