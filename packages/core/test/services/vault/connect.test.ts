import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import test from "node:test";
import { openVault } from "../../../src/kernel/vault";
import { createVaultService } from "../../../src/services/vault";
import { PROVIDERS } from "../../../src/services/vault/oauth";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, call, code, ctxOf, fakeRouter, msg, owner } from "../support";

const SECRET = "sk-test-0123456789-very-secret";

function setup(answer?: Parameters<typeof fakeRouter>[0], appCredential?: (app: string, ref: string) => boolean) {
  const { ledger, path } = openLedger();
  const vault = openVault({ file: join(dirname(path), "vault.json"), sealKey: randomBytes(32), now: () => 99 });
  const router = fakeRouter(answer);
  let clock = 1_000_000;
  const service = createVaultService({ vault, ledger, router, now: () => clock, log: () => {}, ...(appCredential ? { appCredential } : {}) });
  return { ledger, vault, router, service, tick: (ms: number) => { clock += ms; } };
}
const flush = () => new Promise((r) => setImmediate(r));

test("put is write-only and may replace any key, the owner's too; generate makes a secret nobody reads", async () => {
  const s = setup();
  await call(s.service, owner, "set", { ref: "MINE", value: SECRET, label: "mine" });
  assert.deepEqual((await s.service.handle(msg("service:vault", "put", { ref: "MINE", value: { set: true, length: 3 }, label: "x" }), ctxOf(agent(), { ref: "MINE", value: "abc", label: "x" })) as any).data, { ref: "MINE", configured: true });
  assert.equal(s.vault.use("MINE"), "abc", "an agent replaces the owner's key as the owner would");
  assert.deepEqual(await call(s.service, agent(), "put", { ref: "GOOGLE_CLIENT_ID", value: "id-1", label: "Google 应用" }), { ref: "GOOGLE_CLIENT_ID", configured: true });
  assert.deepEqual(await call(s.service, agent(), "put", { ref: "GOOGLE_CLIENT_ID", value: "id-2", label: "Google 应用" }), { ref: "GOOGLE_CLIENT_ID", configured: true }, "its own one it may replace");
  assert.equal(s.vault.use("GOOGLE_CLIENT_ID"), "id-2");
  assert.deepEqual(await call(s.service, agent(), "generate", { ref: "relay_claim", label: "中转站认领" }), { ref: "relay_claim", configured: true });
  assert.ok((s.vault.use("relay_claim") ?? "").length >= 40);
  const listed = JSON.stringify(await call(s.service, agent(), "list"));
  assert.ok(!listed.includes("id-2") && !listed.includes(s.vault.use("relay_claim")!));
});

test("request: the entry waits, the owner gets a card whose button opens the keys page; when the owner saves it the agent is told", async () => {
  const s = setup((m) => (m.word === "ask" ? { ok: true, result: { data: { choice: "vault_fill" } } } : { ok: true }));
  assert.deepEqual(await call(s.service, agent("main"), "request", { ref: "SLACK_TOKEN", label: "Slack 令牌", why: "发消息到你的 Slack", help_url: "https://api.slack.com/apps" }), { ref: "SLACK_TOKEN", status: "waiting" });
  await flush();
  const card = s.router.sent.find((x) => x.msg.word === "ask")!.msg.body as any;
  assert.deepEqual(card.options.map((o: any) => o.id), ["vault_fill", "no"]);
  assert.match(card.detail, /api\.slack\.com/);
  assert.equal((await call(s.service, agent(), "describe", { ref: "SLACK_TOKEN" })).status, "waiting");
  await call(s.service, owner, "set", { ref: "SLACK_TOKEN", value: SECRET, label: "Slack 令牌" });
  await flush();
  const told = s.router.sent.find((x) => x.msg.word === "tell")!;
  assert.equal(told.msg.to, "agent:main");
  assert.ok(!JSON.stringify(told.msg.body).includes(SECRET));
  assert.equal((await call(s.service, agent(), "describe", { ref: "SLACK_TOKEN" })).status, "ok");
});

test("connect: the hub runs OAuth with PKCE on its own loopback callback, keeps the token, renews it, and the agent never sees it", async (t) => {
  // A provider of our own: the token endpoint checks the PKCE verifier and hands out tokens; renewing gives a new access token.
  const codes = new Map<string, string>();
  let issued = 0;
  const idp = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      res.setHeader("content-type", "application/json");
      if (form.get("client_secret") !== "csecret") { res.statusCode = 401; return res.end(JSON.stringify({ error: "invalid_client" })); }
      if (form.get("grant_type") === "authorization_code") {
        const challenge = codes.get(form.get("code")!);
        const got = createHash("sha256").update(form.get("code_verifier")!).digest("base64url");
        if (!challenge || challenge !== got) { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" })); }
        codes.delete(form.get("code")!);
        return res.end(JSON.stringify({ access_token: `at-${++issued}`, refresh_token: "rt-1", expires_in: 3600 }));
      }
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "rt-1") return res.end(JSON.stringify({ access_token: `at-${++issued}`, expires_in: 3600 }));
      res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" }));
    });
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
  t.after(() => idp.close());
  const base = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  const s = setup();
  t.after(() => { delete PROVIDERS.testmail; });
  // The provider is taught as data; https only, except the loopback.
  assert.equal(await code(s.service.handle(msg("service:vault", "provider", { service: "evil", label: "x", grants: "x", auth_url: "http://evil.example/a", token_url: `${base}/token`, scopes: [], client_id_ref: "A", client_secret_ref: "B" }), ctxOf(agent()))), "bad_request");
  await call(s.service, agent(), "provider", { service: "testmail", label: "Test", grants: "读邮件", auth_url: `${base}/auth`, token_url: `${base}/token`, scopes: ["mail.read"],
    client_id_ref: "TEST_CLIENT_ID", client_secret_ref: "TEST_CLIENT_SECRET", how: "make an app" });
  t.after(() => s.service.oauth.stop());
  assert.equal(await code(s.service.handle(msg("service:vault", "connect", { service: "testmail" }), ctxOf(agent()))), "unavailable", "no OAuth app yet");
  await call(s.service, agent(), "put", { ref: "TEST_CLIENT_ID", value: "cid", label: "app id" });
  await call(s.service, agent(), "put", { ref: "TEST_CLIENT_SECRET", value: "csecret", label: "app secret" });

  const started = await call(s.service, agent(), "connect", { service: "testmail" });
  const auth = new URL(started.auth_url);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  const redirect = auth.searchParams.get("redirect_uri")!;
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  // The owner's browser comes back to the hub; the provider issued the code against the challenge.
  codes.set("the-code", auth.searchParams.get("code_challenge")!);
  const callback = `${redirect}?code=the-code&state=${auth.searchParams.get("state")}`;
  assert.equal((await fetch(`${redirect}?code=the-code&state=wrong`)).status, 400, "another state is refused");
  const [first, second] = await Promise.all([fetch(callback), fetch(callback)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, "a second visit waits for the one exchange");
  assert.equal(issued, 1, "the code was exchanged once");

  const entry = await call(s.service, agent(), "describe", { ref: "testmail" });
  assert.equal(entry.status, "ok");
  assert.equal(entry.kind, "oauth");
  assert.ok(!JSON.stringify(entry).includes("at-1"));
  assert.equal(await s.service.token("testmail"), "at-1");
  assert.equal(await code(s.service.handle(msg("service:vault", "put", { ref: "testmail", value: { set: true, length: 1 }, label: "x" }), ctxOf(agent(), { ref: "testmail", value: "x", label: "x" }))), "conflict",
    "a connection's token is the only key put does not replace: connect again instead");
  assert.equal(await s.service.token("testmail"), "at-1");
  s.tick(3600_000);
  assert.equal(await s.service.token("testmail"), "at-2", "renewed when it expires");
  await flush();
  assert.ok(s.router.sent.some((x) => x.msg.word === "vault.changed" && (x.msg.body as any).action === "connected"));
});

test("token: only an app granted that credential gets its value; an agent never does", async () => {
  const app = { member: "app:mail", via: "app" as const, local: true };
  const s = setup(undefined, (who, ref) => who === "app:mail" && ref === "MAIL_KEY");
  await call(s.service, owner, "set", { ref: "MAIL_KEY", value: SECRET, label: "mail" });
  await call(s.service, owner, "set", { ref: "OTHER", value: "other-secret", label: "other" });
  assert.deepEqual(await call(s.service, app, "token", { ref: "MAIL_KEY" }), { ref: "MAIL_KEY", value: SECRET, kind: "key" });
  assert.equal(await code(s.service.handle(msg("service:vault", "token", { ref: "OTHER" }), ctxOf(app))), "forbidden");
  assert.equal(await code(s.service.handle(msg("service:vault", "token", { ref: "MAIL_KEY" }), ctxOf(agent()))), "forbidden");
  assert.ok((await call(s.service, agent(), "describe", { ref: "MAIL_KEY" })).last_used_at);
});

test("request: the fill-in card closes once the key is saved (no stale card waits for the owner)", async () => {
  const { ledger, path } = openLedger();
  const vault = openVault({ file: join(dirname(path), "vault.json"), sealKey: randomBytes(32), now: () => 99 });
  const signals: AbortSignal[] = [];
  const router = { send: async (m: any, _c: any, opts?: { signal?: AbortSignal }) => { if (m.word === "ask" && opts?.signal) signals.push(opts.signal); return m.word === "ask" ? new Promise<any>(() => {}) : { ok: true }; } };
  const service = createVaultService({ vault, ledger, router: router as any, log: () => {} });
  await call(service, agent(), "request", { ref: "K1", label: "k1", why: "x" });
  await call(service, agent(), "request", { ref: "K2", label: "k2", why: "y" });
  await flush();
  assert.equal(signals.length, 2);
  await call(service, owner, "set", { ref: "K1", value: SECRET, label: "k1" });
  assert.deepEqual(signals.map((x) => x.aborted), [true, false]);
  await call(service, owner, "delete", { ref: "K2" });
  assert.deepEqual(signals.map((x) => x.aborted), [true, true]);
});
