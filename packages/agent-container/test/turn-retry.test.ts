import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContainerTurnRunner } from "../src/runtime";
import type { ContainerHost, ContentBlock } from "../src/host";
import type { AcpUpdate } from "../src/acp";
import type { AgentBinding } from "../../core/src/agent-mcp/server";
import { Ledger } from "../../core/src/world/ledger";
import { WorldRouter } from "../../core/src/world/router";

const BROKEN = new Error("Internal error: turn failed: DeepSeek Messages stream: tool input is invalid JSON");

/** A host whose prompts play the given steps: each may send updates, then fail or finish. */
async function rig(steps: ((update: (value: AcpUpdate) => void) => Promise<string>)[]) {
  const dir = mkdtempSync(join(tmpdir(), "ash-turn-retry-"));
  const ledger = await Ledger.open(join(dir, "ledger.db")); const router = new WorldRouter(ledger, () => true);
  const prompts: ContentBlock[][] = [];
  let listener!: (sid: string, value: AcpUpdate) => void;
  const host = { workspace: { hostWorkspace: dir }, async session() { return "s"; }, onUpdate(fn: typeof listener) { listener = fn; return () => {}; },
    cancel() {}, async inject() {},
    async prompt(_sid: string, content: ContentBlock[]) {
      prompts.push(content);
      const step = steps[prompts.length - 1];
      if (!step) throw new Error("unexpected prompt");
      return step((value) => listener("s", value));
    } } as unknown as ContainerHost;
  const binding = { member: "agent:main", begin() {}, end() {} } as unknown as AgentBinding;
  const runner = new ContainerTurnRunner({ host, router, binding, stateDir: dir, mcp: () => ({ url: "http://fixture", token: "fixture" }),
    keyMissing: () => false, failuresSince: () => [] });
  const run = (turn: string) => runner.runTurn({ turn, messages: [], rendered: "给我做一张卡片", stopFacts: [] }, async () => {}, new AbortController().signal);
  return { prompts, run, router, close() { ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a broken tool input before anything ran is tried once more, with a note", async () => {
  const r = await rig([async () => { throw BROKEN; }, async () => "end_turn"]);
  try {
    assert.deepEqual(await r.run("t_retry_ok"), { reason: "completed" });
    assert.equal(r.prompts.length, 2);
    assert.match(String(r.prompts[1][0].text), /previous attempt at this message stopped on a model error/);
    assert.match(String(r.prompts[1][1].text), /给我做一张卡片/);
  } finally { r.close(); }
});

test("it is tried only once", async () => {
  const r = await rig([async () => { throw BROKEN; }, async () => { throw BROKEN; }]);
  try {
    const result = await r.run("t_retry_twice");
    assert.equal(result.reason, "error");
    assert.match(String(result.error), /invalid JSON/);
    assert.equal(r.prompts.length, 2);
  } finally { r.close(); }
});

test("no automatic retry once a tool ran, or for other errors", async () => {
  const acted = await rig([async (update) => {
    update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "touch x" } } as AcpUpdate);
    update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [] } as AcpUpdate);
    throw BROKEN;
  }]);
  try {
    assert.equal((await acted.run("t_acted")).reason, "error");
    assert.equal(acted.prompts.length, 1);
  } finally { acted.close(); }
  const other = await rig([async () => { throw new Error("fetch failed"); }]);
  try {
    assert.equal((await other.run("t_other")).reason, "error");
    assert.equal(other.prompts.length, 1);
  } finally { other.close(); }
});

test("no automatic retry when the ledger shows a request of this turn", async () => {
  let router!: WorldRouter;
  const r = await rig([async () => { router.recordDshToolCall("t_ledger", "c1", "phone_tap", "{}"); throw BROKEN; }]);
  router = r.router;
  try {
    assert.equal((await r.run("t_ledger")).reason, "error");
    assert.equal(r.prompts.length, 1);
  } finally { r.close(); }
});
