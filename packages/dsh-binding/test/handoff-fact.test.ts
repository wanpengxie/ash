import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDshDoor } from "../src/door";

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "ash-handoff-fact-test-"));
  const protectedRoot = join(workspace, "core"); mkdirSync(protectedRoot);
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>();
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const tools = {
    register(definition: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) {
      definitions.set(definition.name, definition); return () => { definitions.delete(definition.name); };
    },
    restrict() { return () => {}; }, guard() { return () => {}; },
    get(name: string) { return definitions.get(name); },
    schemas() { return [...definitions.keys()].map((name) => ({ name })); },
  };
  const approval = { config: { policy: "ask" }, overrideOf() { return undefined; } };
  const agent = { ctx: { tools, on(event: string, handler: (...args: any[]) => unknown) {
    listeners.set(event, handler); return () => { listeners.delete(event); };
  }, get(name: string) { return name === "approval" ? approval : undefined; } },
  session: { seq: 1, eventAt() { return undefined; } } };
  const door = createDshDoor({ tools: tools as never, members: { describe() { return { members: [] }; } } as never,
    router: { requestInternalApproval: async () => "allowed-once" } as never, workspace, managedRoot: workspace, protectedRoots: [protectedRoot],
    scopeChainOf: () => [], sessionId: "session-550e8400-e29b-41d4-a716-446655440000" });
  door.bind(agent as never);
  const controller = new AbortController();
  door.beginTurn("t_handoff_probe", controller.signal);
  const exec = (callId: string, signal = controller.signal) => ({ name: "ash_describe", arguments: {}, agent, callId, signal });
  const perform = (callId: string) => definitions.get("ash_describe")!.execute({}, exec(callId));
  const close = () => { door.endTurn("t_handoff_probe"); door.close(); rmSync(workspace, { recursive: true, force: true }); };
  return { door, listeners, approval, definitions, exec, perform, close };
}

test("all five production-session owned descriptors reject a call with no trusted pre-execute fact", async () => {
  const f = fixture();
  try {
    for (const name of ["ash_describe", "ash_send", "ash_say", "ash_react", "ash_show"]) {
      await assert.rejects(f.definitions.get(name)!.execute({}, { ...f.exec(`toolu_no_preexecute_${name}`), name }),
        /approval|pre-execute|handoff|fact/i);
    }
  }
  finally { f.close(); }
});

test("a trusted pre-execute allow authorizes only one exact owned call", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.listeners.get("tools/pre-execute")!(f.exec("toolu_direct_allow"), async () => ({ kind: "allow" })), { kind: "allow" });
    assert.ok(await f.perform("toolu_direct_allow"));
    await assert.rejects(f.perform("toolu_direct_allow"), /approval|pre-execute|handoff|fact/i);
  } finally { f.close(); }
});

test("ask handoff rejects a changed definition and never restores the consumed fact", async () => {
  const f = fixture();
  try {
    const call = f.exec("toolu_changed_definition");
    assert.deepEqual(await f.listeners.get("tools/pre-execute")!(call, async () => ({ kind: "ask" })), { kind: "ask" });
    assert.equal(await f.listeners.get("approval/request")!({ ...call, toolName: call.name }, async () => "unavailable"), "allowed-once");
    const original = f.definitions.get("ash_describe")!;
    f.definitions.set("ash_describe", { ...original });
    await assert.rejects(original.execute({}, call), /approval|definition|source|fact/i);
    f.definitions.set("ash_describe", original);
    await assert.rejects(original.execute({}, call), /approval|definition|fact/i);
  } finally { f.close(); }
});

test("a direct pre-execute allow becomes invalid if policy is revoked before action", async () => {
  const f = fixture();
  try {
    const call = f.exec("toolu_policy_revoked");
    assert.deepEqual(await f.listeners.get("tools/pre-execute")!(call, async () => ({ kind: "allow" })), { kind: "allow" });
    f.approval.config.policy = "never";
    await assert.rejects(f.perform(call.callId), /approval|policy|fact/i);
    f.approval.config.policy = "ask";
    await assert.rejects(f.perform(call.callId), /approval|policy|fact/i);
  } finally { f.close(); }
});

test("policy always or never cannot mint an owned-tool execution fact", async () => {
  const f = fixture();
  try {
    for (const policy of ["always", "never"]) {
      f.approval.config.policy = policy;
      const call = f.exec(`toolu_policy_${policy}`);
      await f.listeners.get("tools/pre-execute")!(call, async () => ({ kind: "allow" }));
      await assert.rejects(f.perform(call.callId), /approval|fact/i);
    }
  } finally { f.close(); }
});

test("execution uses a separate live signal but an aborted pre-execute signal rejects the fact", async () => {
  const f = fixture();
  try {
    const pre = new AbortController();
    const action = new AbortController();
    await f.listeners.get("tools/pre-execute")!(f.exec("toolu_distinct_signal", pre.signal), async () => ({ kind: "allow" }));
    assert.ok(await f.definitions.get("ash_describe")!.execute({}, f.exec("toolu_distinct_signal", action.signal)));
    const stopped = new AbortController();
    await f.listeners.get("tools/pre-execute")!(f.exec("toolu_stopped_signal", stopped.signal), async () => ({ kind: "allow" }));
    stopped.abort();
    await assert.rejects(f.definitions.get("ash_describe")!.execute({}, f.exec("toolu_stopped_signal", action.signal)), /approval|fact/i);
  } finally { f.close(); }
});

test("a wrong root cannot use or later restore another root's one-shot fact", async () => {
  const f = fixture();
  try {
    const call = f.exec("toolu_wrong_root");
    await f.listeners.get("tools/pre-execute")!(call, async () => ({ kind: "allow" }));
    await assert.rejects(f.definitions.get("ash_describe")!.execute({}, { ...call, agent: {} }), /source|approval|fact/i);
    await assert.rejects(f.perform(call.callId), /approval|fact/i);
  } finally { f.close(); }
});

test("concurrent reuse of one callId poisons both pre-execute facts", async () => {
  const f = fixture();
  try {
    const call = f.exec("toolu_duplicate_pending");
    let release!: (value: { kind: string }) => void;
    const first = f.listeners.get("tools/pre-execute")!(call, () => new Promise((resolve) => { release = resolve; }));
    assert.deepEqual(await f.listeners.get("tools/pre-execute")!(call, async () => ({ kind: "allow" })), { kind: "allow" });
    release({ kind: "allow" });
    assert.deepEqual(await first, { kind: "allow" });
    await assert.rejects(f.perform(call.callId), /approval|fact/i);
  } finally { f.close(); }
});

test("an invalid approval/request consumes its matching ask fact", async () => {
  const f = fixture();
  try {
    const call = f.exec("toolu_wrong_request_name");
    await f.listeners.get("tools/pre-execute")!(call, async () => ({ kind: "ask" }));
    const approve = f.listeners.get("approval/request")!;
    assert.equal(await approve({ ...call, toolName: call.name, name: "ash_send" }, async () => "unavailable"), "unavailable");
    assert.equal(await approve({ ...call, toolName: call.name }, async () => "unavailable"), "unavailable");
    await assert.rejects(f.perform(call.callId), /approval|fact/i);
  } finally { f.close(); }
});

test("endTurn clears one-shot facts before a later turn", async () => {
  const f = fixture();
  try {
    const call = f.exec("toolu_old_turn");
    await f.listeners.get("tools/pre-execute")!(call, async () => ({ kind: "allow" }));
    f.door.endTurn("t_handoff_probe");
    f.door.beginTurn("t_later_probe", new AbortController().signal);
    await assert.rejects(f.perform(call.callId), /turn|approval|fact/i);
  } finally { f.close(); }
});
