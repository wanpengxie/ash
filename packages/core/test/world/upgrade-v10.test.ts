// Upgrading an existing v10 install: the migrated ledger keeps the old conversation visible, and
// the core starts a fresh v2 DSH session instead of refusing to start.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;
const fixture = fileURLToPath(new URL("../fixtures/v10-ash.db", import.meta.url));

test("a v10 install upgrades in place: history stays visible and the core starts", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-upgrade-"));
  const home = join(root, "home"); mkdirSync(home);
  const state = join(root, "state"); mkdirSync(join(state, "agents", "agent_main"), { recursive: true });
  copyFileSync(fixture, join(state, "ash.db"));
  // What v10 left behind for its own DSH session; v2 does not reuse it.
  writeFileSync(join(state, "agents", "agent_main", "dsh-session.json"), JSON.stringify({ sessionId: "session-00000000-0000-4000-8000-000000000000" }));
  const config = { stateDir: state, listen: "127.0.0.1:0", workspaces: { home }, agents: [{ id: "agent:main" as const, runtime: "dsh" as const }],
    dsh: { root: install!, home: join(root, "dsh"), env: { DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/anthropic" } } };
  try {
    let running = await startOwner(config);
    const migrated = running.ledger.list({ limit: 1000 });
    assert.ok(running.ledger.migration.migrated > 0, "the v10 history was migrated");
    assert.ok(migrated.some((row) => row.from === "agent:main" && row.word === "turn.start"), "old turns stay visible");
    const first = JSON.parse(readFileSync(join(state, "dsh-main-session.json"), "utf8")) as { id: string };
    await running.close();
    // A second start resumes the v2 session; the migrated turns never block it.
    running = await startOwner(config);
    assert.equal((JSON.parse(readFileSync(join(state, "dsh-main-session.json"), "utf8")) as { id: string }).id, first.id);
    await running.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
