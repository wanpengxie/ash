// A phone installed without a model key must say so, in words, instead of failing silently.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NO_MODEL_KEY } from "../../../dsh-binding/src/runtime";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("with no model key the owner is told where to put one, and Ash still starts again afterwards", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-nokey-"));
  const home = join(root, "home"); mkdirSync(home);
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "dsh" }],
      dsh: { root: install!, home: join(root, "dsh"), env: { DSH_TELEMETRY_DISABLED: "1" } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "你好" }, client_id: "no-key-1" }) });
    const all = () => running!.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !all().some((m) => m.word === "turn.end" && m.from === "agent:main")) await new Promise((r) => setTimeout(r, 30));
    const told = all().find((m) => m.from === "agent:main" && m.to === "person:owner" && m.word === "say" && m.kind === "request");
    assert.equal(told?.body.text, NO_MODEL_KEY);
    // DSH never ran this turn, so it must not be recorded as completed: restart checks completed turns against DSH history.
    assert.equal(all().find((m) => m.word === "turn.end" && m.from === "agent:main")?.body.reason, "error");
    await running.close();
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "dsh" }],
      dsh: { root: install!, home: join(root, "dsh"), env: { DSH_TELEMETRY_DISABLED: "1" } } });
  } finally {
    await running?.close();
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
