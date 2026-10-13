// A stand-in for ash's pi login helper: `status` and `login`, as JSON lines. FAKE_LOGIN=error makes the login fail; FAKE_LOGIN_READY=1 is a login that is there.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const mode = process.argv[2];
log({ login_helper: mode, env: { HTTPS_PROXY: process.env.HTTPS_PROXY } });
// A login that was done stays done (the marker stands for pi's auth.json).
const marker = process.env.FAKE_LOG ? `${process.env.FAKE_LOG}.loggedin` : null;
const storeFile = process.env.FAKE_LOG ? `${process.env.FAKE_LOG}.store` : null;
const storeInfo = () => { try { return JSON.parse(readFileSync(storeFile, "utf8")); } catch { return null; } };
if (mode === "refresh") {
  // FAKE_REFRESH=fail: upstream cannot be reached (and the proxy is the only other way: FAKE_REFRESH=proxy-only works only with HTTPS_PROXY set)
  const ok = process.env.FAKE_REFRESH !== "fail" && !(process.env.FAKE_REFRESH === "proxy-only" && !process.env.HTTPS_PROXY);
  if (ok && storeFile) writeFileSync(storeFile, JSON.stringify({ checked_at: Date.now(), upstream_at: 1_700_000_000_000 }));
  out(ok ? { ok: true, errors: {}, store: storeInfo() } : { ok: false, errors: { deepseek: "ENETUNREACH", "openai-codex": "ENETUNREACH", openrouter: "ENETUNREACH" }, store: storeInfo() });
  process.exit(0);
}
if (mode === "catalog") {
  const m = (id, name, efforts, images = true) => ({ id, name, context_window: 128000, max_output: 8000, images, reasoning: efforts.length > 0, efforts });
  const many = Array.from({ length: 25 }, (_, i) => m(`openrouter/vendor/model-${i}`, `Vendor: Model ${i}`, i % 2 ? ["low", "high"] : []));
  out({ providers: [
    { id: "deepseek", name: "DeepSeek", models: [m("deepseek/deepseek-flash", "DeepSeek Flash", ["off", "low", "high", "max"]), m("deepseek/deepseek-v4-pro", "DeepSeek Pro", ["off", "high", "max"], false)] },
    { id: "openai-codex", name: "OpenAI Codex", models: [m("openai-codex/gpt-5.5", "GPT-5.5", ["off", "minimal", "low", "medium", "high", "xhigh"]), m("openai-codex/gpt-6-sol", "GPT-6 Sol", ["off", "low", "high", "max"])] },
    { id: "openrouter", name: "OpenRouter", models: many },
  ], store: storeInfo() });
  process.exit(0);
}
if (mode === "status") { out({ ready: process.env.FAKE_LOGIN_READY === "1" || (!!marker && existsSync(marker)) }); process.exit(0); }
out({ event: "device_code", verification_uri: "https://auth.example/codex/device", user_code: "ABCD-1234", expires_in: 900 });
setTimeout(() => { if (process.env.FAKE_LOGIN !== "error" && marker) writeFileSync(marker, "1"); out(process.env.FAKE_LOGIN === "error" ? { event: "error", message: "expired" } : { event: "done" }); process.exit(0); }, Number(process.env.FAKE_LOGIN_MS ?? 300));
