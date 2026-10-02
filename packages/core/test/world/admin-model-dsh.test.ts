import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "installed DSH required" : false;

test("production model.set saves the DSH default selection for the next boot", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-admin-model-"));
  const home = join(root, "home");
  mkdirSync(home);
  const config = { stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
    agents: [{ id: "agent:main" as const, runtime: "dsh" as const }], dsh: { root: install!, home: join(root, "dsh"), env: {
      DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/anthropic",
    } } };
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  const send = async (word: string, body: Record<string, unknown>) => {
    const token = Object.entries(running!.tokens.api).find(([, member]) => member === "person:owner")![0];
    const response = await fetch(`${running!.url}/api/send`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
    }, body: JSON.stringify({ to: "service:admin", kind: "request", word, body, wait: true }) });
    assert.equal(response.status, 200);
    return (await response.json() as { reply: { body: { ok: boolean; result: Record<string, unknown> } } }).reply.body;
  };
  try {
    running = await startOwner(config);
    const before = await send("settings.get", {});
    assert.equal(before.ok, true);
    const initial = before.result.model as { provider: string; model: string };
    assert.ok(initial.provider && initial.model);
    const model = initial.model === "deepseek-chat" ? "deepseek-reasoner" : "deepseek-chat";
    const saved = await send("model.set", { provider: initial.provider, model });
    assert.deepEqual(saved, { ok: true, result: { provider: initial.provider, model, restart_required: true } });
    await running.close(); running = null;
    running = await startOwner(config);
    const after = await send("settings.get", {});
    assert.deepEqual(after.result.model, { provider: initial.provider, model });
  } finally {
    await running?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
