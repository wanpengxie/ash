// Signs wrangler in to the owner's Cloudflare account: prints the authorize link, waits on localhost:8976 for the
// browser's callback, exchanges the code once and writes wrangler's own token file. Used instead of `wrangler login`,
// whose callback server exchanges the code again when the phone's browser opens the callback twice (invalid_grant).
// Usage: node login.mjs > ~/relay/login.log 2>&1 &   — the link is the first line; "LOGIN_OK" when done.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT = "54d11594-84e4-41aa-b438-e81b8fa78ee7"; // wrangler's public OAuth client
const REDIRECT = "http://localhost:8976/oauth/callback";
// wrangler 4's own scope list: it asks to log in again when the token file names fewer.
const SCOPES = ["k2.read", "k2.write", "account:read", "user:read", "workers:write", "workers_kv:write", "workers_routes:write",
  "workers_scripts:write", "workers_tail:read", "d1:write", "pages:write", "zone:read", "ssl_certs:write", "ai:write", "ai-search:write",
  "ai-search:run", "agent-memory:write", "queues:write", "pipelines:write", "secrets_store:write", "artifacts:write", "flagship:write",
  "containers:write", "cloudchamber:write", "connectivity:admin", "email_routing:write", "email_sending:write", "browser:write",
  "challenge-widgets.write", "offline_access"];
const CONFIG = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), ".wrangler", "config", "default.toml");

const verifier = crypto.randomBytes(48).toString("base64url");
const state = crypto.randomBytes(16).toString("base64url");
const link = "https://dash.cloudflare.com/oauth2/auth?" + new URLSearchParams({
  response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, scope: SCOPES.join(" "), state,
  code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
});

const page = (text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ash</title><body style="font-family:sans-serif;padding:2rem"><h2>${text}</h2></body>`;
let exchange = null; // the one exchange; a second visit of the callback waits for it instead of using the code again

async function exchangeCode(code) {
  const r = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code, code_verifier: verifier, redirect_uri: REDIRECT }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token ${r.status} ${text.slice(0, 300)}`);
  const t = JSON.parse(text);
  const expires = new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString();
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, [`oauth_token = ${JSON.stringify(t.access_token)}`, `expiration_time = ${JSON.stringify(expires)}`,
    `refresh_token = ${JSON.stringify(t.refresh_token ?? "")}`, `scopes = [ ${SCOPES.map((s) => JSON.stringify(s)).join(", ")} ]`, ""].join("\n"), { mode: 0o600 });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost:8976");
  const send = (status, text) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(page(text)); };
  if (u.pathname !== "/oauth/callback") return send(404, "不是这里");
  if (u.searchParams.get("error")) { console.log(`DENIED ${u.searchParams.get("error")}`); send(400, "你没有授权，回到 Ash 再试一次"); return finish(1); }
  if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) return send(400, "这个链接不是这一次的，回到 Ash 要新的");
  exchange ??= exchangeCode(u.searchParams.get("code"));
  try { await exchange; send(200, "授权成功，回到 Ash 就行"); console.log("LOGIN_OK"); finish(0); }
  catch (error) { console.log(`LOGIN_FAILED ${error.message}`); send(500, "授权没成，回到 Ash 再试一次"); finish(1); }
});
const finish = (code) => setTimeout(() => process.exit(code), 1000);
server.on("error", (error) => { console.log(error.code === "EADDRINUSE" ? "PORT_BUSY 8976: an earlier login still waits; kill it first" : `ERROR ${error.message}`); process.exit(1); });
server.listen(8976, () => console.log(link));
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 20 * 60_000).unref();
