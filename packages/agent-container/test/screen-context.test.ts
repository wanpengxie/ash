import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContainerTurnRunner } from "../src/runtime";
import type { ContainerHost, ContentBlock } from "../src/host";
import type { AgentBinding } from "../../core/src/agent-mcp/server";

test("container runner injects a trusted screen plan before the task and clears it on the next turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-screen-context-"));
  const injected: ContentBlock[][] = [], order: string[] = [];
  const host = { workspace: { hostWorkspace: dir },
    async session() { return "screen-session"; }, onUpdate() { return () => {}; }, cancel() {},
    async inject(_session: string, context: ContentBlock[]) { injected.push(context); order.push("inject"); },
    async prompt() { order.push("prompt"); return "completed"; },
  } as unknown as ContainerHost;
  const binding = { member: "agent:main", label: "main", begin() {}, end() {} } as unknown as AgentBinding;
  const runner = new ContainerTurnRunner({ host, binding, stateDir: dir, mcp: () => ({ url: "http://fixture", token: "fixture" }),
    keyMissing: () => false, failuresSince: () => [] });
  try {
    const input = { turn: "t_screen", messages: [], rendered: "帮我打开闲鱼", stopFacts: [],
      peripheralContext: "[Ash screen execution decision for THIS turn]\nMode: foreground_handoff; REAL phone screen" };
    assert.equal((await runner.runTurn(input, async () => {}, new AbortController().signal)).reason, "completed");
    assert.equal((await runner.runTurn({ ...input, turn: "t_next", peripheralContext: undefined }, async () => {}, new AbortController().signal)).reason, "completed");
    assert.deepEqual(order, ["inject", "prompt", "inject", "prompt"]);
    assert.match(injected[0].map((b) => b.text).join("\n"), /Mode: foreground_handoff/);
    assert.doesNotMatch(injected[1].map((b) => b.text).join("\n"), /Mode: foreground_handoff/);
    assert.match(injected[1].map((b) => b.text).join("\n"), /Earlier turn-specific screen preferences do not apply/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
