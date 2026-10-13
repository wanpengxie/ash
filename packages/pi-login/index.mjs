// Codex's login for the pi runtime, for a phone: no browser on this side, so the device-code flow. The pi driver runs
//   node index.mjs status   ->  {"ready": true|false}
//   node index.mjs catalog  ->  {"providers": [{"id","name","models":[{"id","name","context_window","max_output","images","reasoning","efforts"}]}]}: pi's own model tables
//                               for the providers Ash can use (deepseek, openai-codex, openrouter), so the list is never a copy that goes stale
//   node index.mjs refresh  ->  {"ok": bool, "errors": {provider: message}, "store": {checked_at, upstream_at}}: asks pi.dev for newer model tables (what
//                               `pi update --models` does; pi keeps them in $PI_CODING_AGENT_DIR/models-store.json and reads them offline afterwards)
//   node index.mjs login    ->  {"event":"device_code","verification_uri","user_code","expires_in"}   (the owner types the code in the phone's browser)
//                               then {"event":"done"} when the token is stored, or {"event":"error","message"}
// The token goes where pi keeps it (`$PI_CODING_AGENT_DIR/auth.json`, default ~/.pi/agent) and pi refreshes it itself afterwards.
// The requests of the login go through HTTPS_PROXY when the driver sets it (pi's own processes do the same).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI = process.env.ASH_PI_DIR || "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
const PROVIDER = "openai-codex";
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const CATALOG_PROVIDERS = ["deepseek", "openai-codex", "openrouter"];

/** When pi last asked pi.dev (checked_at) and the date of the newest catalog it got (upstream_at), from pi's own store: null when it never did. */
function storeInfo() {
  try {
    const store = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
    const entries = CATALOG_PROVIDERS.map((id) => store[id]).filter((e) => e && typeof e === "object");
    const max = (key) => entries.reduce((m, e) => (typeof e[key] === "number" && e[key] > m ? e[key] : m), 0) || null;
    return entries.length ? { checked_at: max("checkedAt"), upstream_at: max("lastModified") } : null;
  } catch { return null; }
}

const CATALOG_URL = process.env.ASH_PI_CATALOG_URL || "https://pi.dev";

function parseCatalog(id, value) {
  const entries = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.models) ? value.models : value && typeof value === "object" ? Object.values(value) : null;
  if (!entries) throw new Error(`bad catalog for ${id}`);
  return entries.filter((m) => m && typeof m === "object" && "id" in m).map((m) => ({ ...m, provider: id }));
}

/**
 * Ask pi.dev for newer tables, the way pi does (GET /api/models/providers/<id>, revalidated with the ETag) and keep them where pi keeps
 * them, in models-store.json: every pi process reads them from there, offline too, and uses them only when they are newer than the
 * tables it shipped with. pi's own refresh skips a provider that has no login or key, and Ash's providers often have neither yet, so the
 * request is made here. Goes through HTTPS_PROXY when the driver sets it.
 */
async function refresh() {
  const undici = createRequire(join(PI, "package.json"))("undici");
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  undici.install?.();
  const file = join(agentDir, "models-store.json");
  const read = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  const errors = {};
  for (const id of CATALOG_PROVIDERS) {
    const store = read();
    const entry = store[id];
    try {
      const url = new URL(`/api/models/providers/${encodeURIComponent(id)}`, CATALOG_URL);
      url.searchParams.set("types", "chat,image,classifier");
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "pi-ash-catalog", ...(entry?.models?.length && entry.etag ? { "if-none-match": entry.etag } : {}) }, signal: AbortSignal.timeout(15_000) });
      const checkedAt = Date.now();
      let next;
      if (response.status === 304 && entry) next = { ...entry, checkedAt };
      else if (response.status === 404 || response.status === 501) next = { ...(entry ?? { models: [] }), checkedAt, lastModified: 0 };
      else if (!response.ok) throw new Error(`HTTP ${response.status}`);
      else {
        const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
        next = { models: parseCatalog(id, await response.json()), lastModified: Number.isNaN(lastModified) ? 0 : lastModified, ...(response.headers.get("etag") ? { etag: response.headers.get("etag") } : {}), checkedAt };
      }
      const latest = read();
      latest[id] = next;
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(latest, null, 2), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      errors[id] = String(error?.cause?.code ?? error?.message ?? error).slice(0, 200);
    }
  }
  out({ ok: Object.keys(errors).length === 0, errors, store: storeInfo() });
}

function status() {
  const file = join(agentDir, "auth.json");
  let ready = false;
  try {
    const entry = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[PROVIDER] : null;
    ready = !!entry && entry.type === "oauth" && typeof entry.refresh === "string" && entry.refresh.length > 0;
  } catch { /* unreadable: not ready */ }
  out({ ready });
}

async function login() {
  process.env.PI_OFFLINE = "1";
  const undici = createRequire(join(PI, "package.json"))("undici");
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
  undici.install?.();
  const { ModelRuntime } = await import(pathToFileURL(join(PI, "dist", "index.js")).href);
  const runtime = await ModelRuntime.create();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 16 * 60 * 1000);
  try {
    await runtime.login(PROVIDER, "oauth", {
      signal: abort.signal,
      prompt: async (p) => {
        if (p.type === "select") return "device_code";
        return new Promise(() => {}); // nothing else is asked in the device-code flow
      },
      notify: (event) => {
        if (event.type === "device_code") out({ event: "device_code", verification_uri: event.verificationUri, user_code: event.userCode, expires_in: event.expiresInSeconds });
      },
    });
    out({ event: "done" });
  } finally { clearTimeout(timer); }
}

/** pi's model tables for the providers Ash can use. Efforts are the thinking levels the model takes ("off" is one of them). */
async function catalog() {
  process.env.PI_OFFLINE = "1";
  const { ModelRuntime } = await import(pathToFileURL(join(PI, "dist", "index.js")).href);
  const ai = await import(pathToFileURL(join(PI, "..", "pi-ai", "dist", "index.js")).href);
  const runtime = await ModelRuntime.create();
  const NAMES = { deepseek: "DeepSeek", "openai-codex": "OpenAI Codex（ChatGPT 订阅）", openrouter: "OpenRouter" };
  const providers = [];
  for (const id of Object.keys(NAMES)) {
    const models = runtime.getModels(id).map((m) => ({
      id: `${id}/${m.id}`, name: String(m.name ?? m.id), context_window: m.contextWindow, max_output: m.maxTokens,
      images: Array.isArray(m.input) && m.input.includes("image"), reasoning: !!m.reasoning,
      efforts: m.reasoning ? ai.getSupportedThinkingLevels(m) : [],
    }));
    providers.push({ id, name: NAMES[id], models });
  }
  out({ providers, store: storeInfo() });
}

const mode = process.argv[2];
try {
  if (mode === "status") status();
  else if (mode === "catalog") await catalog();
  else if (mode === "refresh") await refresh();
  else if (mode === "login") await login();
  else { out({ event: "error", message: `unknown mode ${mode}` }); process.exitCode = 2; }
} catch (error) {
  out({ event: "error", message: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300) });
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
