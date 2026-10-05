import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContainerTurnRunner } from "../src/runtime";
import type { ContainerHost, ContentBlock } from "../src/host";
import type { AgentBinding } from "../../core/src/agent-mcp/server";
import { Ledger } from "../../core/src/world/ledger";
import { WorldRouter } from "../../core/src/world/router";
import type { AcpUpdate } from "../src/acp";

test("ACP thought is summarized without storing raw reasoning; tools remain intact and closing discards late summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-progress-runtime-"));
  const ledger = await Ledger.open(join(dir, "ledger.db")); const router = new WorldRouter(ledger, () => true);
  let update!: (sid: string, value: AcpUpdate) => void;
  let late!: (text: string) => void;
  const host = { workspace: { hostWorkspace: dir }, async session() { return "s"; },
    onUpdate(fn: typeof update) { update = fn; return () => {}; }, cancel() {}, async inject() {},
    async prompt() {
      update("s", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "RAW_PRIVATE_REASONING" } });
      await new Promise((r) => setImmediate(r));
      update("s", { sessionUpdate: "tool_call", toolCallId: "call", title: "bash", rawInput: { description: "核对书架文件", command: "echo book\necho tail" } });
      update("s", { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed", content: [{ type: "content", content: { type: "text", text: "actual result" } }] });
      update("s", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "LATE_RAW_REASONING" } });
      return "completed";
    },
  } as unknown as ContainerHost;
  const binding = { member: "agent:main", begin() {}, end() {} } as unknown as AgentBinding;
  const runner = new ContainerTurnRunner({ host, router, binding, stateDir: dir, mcp: () => ({ url: "http://fixture", token: "fixture" }),
    keyMissing: () => false, failuresSince: () => [], summarizeProgress: async (thought) => thought.startsWith("LATE") ? new Promise((r) => { late = r; }) : "先核对书架文件是否完整" });
  try {
    await runner.runTurn({ turn: "t_progress", messages: [], rendered: "test", stopFacts: [] }, async () => {}, new AbortController().signal);
    late("LATE_SUMMARY"); await new Promise((r) => setImmediate(r));
    const records = ledger.list({ limit: 100 });
    assert.equal(records.filter((r) => r.word === "activity.summary").length, 1);
    assert.match(JSON.stringify(records), /先核对书架文件是否完整/);
    assert.doesNotMatch(JSON.stringify(records), /RAW_PRIVATE|LATE_RAW|LATE_SUMMARY/);
    assert.match(JSON.stringify(records), /actual result/);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

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
