// When the provider rejects a call the owner hears why in plain words, not silence.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modelFailureText } from "../../../dsh-binding/src/runtime";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("failure text names the likely cause and never echoes the provider's payload", () => {
  assert.match(modelFailureText({ code: "AUTH", status: 401, message: "Authentication Fails sk-leak" }), /Key/);
  assert.doesNotMatch(modelFailureText({ status: 401, message: "Authentication Fails sk-leak" }), /sk-leak/);
  assert.match(modelFailureText({ status: 402, message: "Insufficient Balance" }), /余额/);
  assert.match(modelFailureText({ status: 429, message: "slow down" }), /限流/);
  assert.match(modelFailureText({ code: "ENOTFOUND", message: "getaddrinfo" }), /网络/);
  assert.match(modelFailureText(undefined), /出了点问题/);
});

test("a rejected key ends the turn with a plain message to the owner", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-401-"));
  const home = join(root, "home"); mkdirSync(home);
  const provider = createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(401, { "content-type": "application/json" })
    .end(JSON.stringify({ error: { message: "Authentication Fails", type: "authentication_error" } }))); });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "dsh" }],
      dsh: { root: install!, home: join(root, "dsh"), env: { DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-rejected",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/anthropic` } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "你好" }, client_id: "rejected-1" }) });
    const all = () => running!.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !all().some((m) => m.word === "turn.end" && m.from === "agent:main")) await new Promise((r) => setTimeout(r, 30));
    const told = all().find((m) => m.from === "agent:main" && m.to === "person:owner" && m.word === "say" && m.kind === "request");
    assert.match(String(told?.body.text), /没认我的 Key/);
    assert.doesNotMatch(JSON.stringify(all()), /sk-rejected/);
  } finally {
    await running?.close();
    provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
