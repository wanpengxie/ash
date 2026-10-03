// The secure vault end to end: a key saved by the owner reaches the model through DSH's own credential lookup,
// with no environment variable, no file DSH can see, and nothing but the key's name on the ledger.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("a key saved in the vault is what DSH sends to the provider, and it never reaches the ledger", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-vault-"));
  const home = join(root, "home"); mkdirSync(home);
  const seen: string[] = [];
  const provider = createServer((req, res) => {
    let raw = ""; req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (req.url === "/user/balance") { seen.push(`balance ${req.headers.authorization}`);
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.00", granted_balance: "0", topped_up_balance: "9.00" }] })); }
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      seen.push(`messages ${req.headers["x-api-key"] ?? req.headers.authorization}`);
      const request = JSON.parse(raw || "{}") as { model?: string };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_v", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "收到" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
      event("message_stop", {}); res.end();
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "dsh" }],
      dsh: { root: install!, home: join(root, "dsh"), costRoot: resolve("packages/ash-cost"), vaultRoot: resolve("packages/ash-vault"),
        env: { DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/anthropic` } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const send = async (body: object) => (await fetch(`${running!.url}/api/send`, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
    const all = () => running!.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });

    // Nothing saved: she says where to put a key rather than failing silently.
    await send({ to: "agent:main", kind: "request", word: "say", body: { text: "你好" }, client_id: "v1" });
    let deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !all().some((m) => m.word === "turn.end" && m.from === "agent:main")) await new Promise((r) => setTimeout(r, 30));
    assert.match(String(all().find((m) => m.from === "agent:main" && m.to === "person:owner" && m.word === "say" && m.kind === "request")?.body.text), /没有模型的 Key/);

    // The agent's view of the vault: names only.
    const listed = (await send({ to: "service:vault", kind: "request", word: "list", body: {}, wait: true, client_id: "v-list" })).reply.body.result.entries;
    assert.deepEqual(listed.find((e: { ref: string }) => e.ref === "DEEPSEEK_API_KEY"), { ref: "DEEPSEEK_API_KEY", label: "DeepSeek（对话模型）", kind: "model", configured: false });

    // The owner saves a key through the settings route.
    const put = await fetch(`${running.url}/api/vault/DEEPSEEK_API_KEY`, { method: "PUT", headers, body: JSON.stringify({ value: "sk-from-the-vault" }) });
    assert.equal(put.status, 200);
    assert.equal(statSync(join(root, "state", "vault.json")).mode & 0o777, 0o600);
    const described = (await send({ to: "service:vault", kind: "request", word: "describe", body: { ref: "DEEPSEEK_API_KEY" }, wait: true, client_id: "v-desc" })).reply.body.result;
    assert.equal(described.configured, true);
    assert.equal("value" in described, false);

    // No restart: the next turn uses it.
    const before = all().filter((m) => m.word === "turn.end" && m.from === "agent:main").length;
    await send({ to: "agent:main", kind: "request", word: "say", body: { text: "再来" }, client_id: "v2" });
    deadline = Date.now() + 20_000;
    while (Date.now() < deadline && all().filter((m) => m.word === "turn.end" && m.from === "agent:main").length <= before) await new Promise((r) => setTimeout(r, 30));
    assert.ok(seen.some((s) => s.includes("sk-from-the-vault")), `the provider saw the vault key: ${JSON.stringify(seen)}`);
    const balance = (await send({ to: "service:cost", kind: "request", word: "balance.get", body: {}, wait: true, client_id: "v-bal" })).reply.body.result;
    assert.equal(balance.balances[0].total, "9.00");
    assert.ok(seen.includes("balance Bearer sk-from-the-vault"));

    // The ledger knows a key was saved, and never what it was.
    assert.ok(all().some((m) => m.word === "vault.changed" && m.body.ref === "DEEPSEEK_API_KEY" && m.body.action === "saved"));
    assert.doesNotMatch(JSON.stringify(all()), /sk-from-the-vault/);
    assert.doesNotMatch(readFileSync(join(root, "state", "ash.db")).toString("latin1"), /sk-from-the-vault/);

    // Only the local owner may write; removing works and the next turn is told again.
    const stranger = await fetch(`${running.url}/api/vault/DEEPSEEK_API_KEY`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "sk-x" }) });
    assert.ok([401, 403].includes(stranger.status));
    const del = await fetch(`${running.url}/api/vault/DEEPSEEK_API_KEY`, { method: "DELETE", headers });
    assert.deepEqual(await del.json(), { ok: true, removed: true });
  } finally {
    await running?.close();
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    provider.closeAllConnections(); await new Promise<void>((r) => provider.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
