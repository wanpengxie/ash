import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { createAgentMember } from "../../src/members/agent";
import { ReflexMember } from "../../src/members/reflex";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { decisionContext, type DecisionRoute } from "../../src/world/decision/runtime";
import type { ScreenSnapshot } from "../../src/members/reflex/screen-reconcile";
import { EdgeRouter } from "../../src/server";

const owner: TrustedRouteContext = { member: "person:owner", transport: "web_ui", transportPrincipal: "owner:test", local: true,
  remote: false, ownerProxy: true, screenId: "screen:phone", screenLabel: "Phone", nativeUi: true };
const wait = async (condition: () => boolean) => {
  const deadline = Date.now() + 15000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("decision did not settle"); await new Promise((r) => setTimeout(r, 10)); }
};
const answer = (real = "return_to_ash", virtual = "none") => ({ answers: {
  real_screen: { choice: real, confidence: 0.98 }, virtual_screen: { choice: virtual, confidence: 0.98 },
} });

test("only authenticated Android transport proof marks an owner request as native UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-native-proof-")), ledger = await Ledger.open(join(dir, "world.db"));
  try {
    const router = new WorldRouter(ledger, async () => true), members = new WorldMembers(router);
    const edge = new EdgeRouter(ledger, router, members, { api: { owner: "person:owner", device: "device:phone" }, mcp: {} },
      { authScopeKey: Buffer.alloc(32, 1), nativeUiToken: "fixture-native-proof" });
    assert.equal(edge.localCaller({ authorization: "Bearer owner" })?.nativeUi, undefined);
    assert.equal(edge.localCaller({ authorization: "Bearer owner", "x-ash-native-ui": "forged" })?.nativeUi, undefined);
    assert.equal(edge.localCaller({ authorization: "Bearer owner", "x-ash-native-ui": "fixture-native-proof" })?.nativeUi, true);
    assert.equal(edge.localCaller({ authorization: "Bearer device", "x-ash-native-ui": "fixture-native-proof" })?.nativeUi, undefined);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("restart closes unfinished decisions once without replaying their effects", async () => {
  const f = await fixture();
  try {
    await f.router.send(decisionContext, { to: null, kind: "event", word: "decision.started", body: {
      decision_id: "interrupted-fixture", route: "screen.reconcile", route_version: 1, trigger_id: "fixture-trigger",
      evidence_ids: [], state_fingerprint: "0".repeat(64) }, client_id: "decision:interrupted-fixture:started" });
    assert.equal(f.ledger.unfinishedDecisions().length, 1);
    await f.reflex.runtime.recover(); await f.reflex.runtime.recover();
    assert.equal(f.ledger.unfinishedDecisions().length, 0);
    const applied = f.rows().filter((row) => row.word === "decision.applied");
    assert.equal(applied.length, 1); assert.equal(applied[0].body.skipped, "interrupted");
    assert.equal(f.calls, 0); assert.equal(f.returns, 0); assert.equal(f.closes, 0);
  } finally { await f.close(); }
});

async function fixture(options: { native?: boolean; visible?: boolean; action?: string; real?: string; virtual?: string;
  evaluate?: (state: any, signal?: AbortSignal) => Promise<unknown>; surface?: (signal: AbortSignal) => Promise<void>;
  surfaceValue?: unknown;
  text?: string;
  execution?: { mode?: string; virtualAvailable?: boolean; confidence?: number; evaluate?: (state: any, signal?: AbortSignal) => Promise<unknown> };
  reason?: "completed" | "error"; extraRoute?: DecisionRoute } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ash-decision-")), ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true), members = new WorldMembers(router);
  let calls = 0, executionCalls = 0, runnerCalls = 0, returns = 0, closes = 0, latestState: any, inputContext: string | undefined;
  const order: string[] = [];
  const screen: ScreenSnapshot = { foreground_package: "com.android.settings", state_epoch: 5,
    virtual_generation: 1, virtual_owner_turn: "", virtual_open: false };
  const action = options.action ?? "apps.open";
  router.registerDeviceBatch("device:phone", [{ name: action, description: "Synthetic screen action", label: "test", risk: "none", effect: "read",
    input_schema: { type: "object", additionalProperties: false } }], (message) => {
    if (action.startsWith("vscreen.")) { screen.virtual_open = true; screen.virtual_owner_turn = message.turn!; }
    return { ok: true, result: {} };
  });
  members.register({ id: "person:owner", kind: "person", name: "Owner", words: () => [wordContract("person:owner", "say")!],
    handle: () => ({ ok: true, result: { accepted: true } }) });
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"),
    beforeTurn: async (turn) => { await router.send({ member: "service:reflex", transport: "service", transportPrincipal: "service:reflex",
      local: true, remote: false, ownerProxy: false, turn }, { to: "service:reflex", kind: "request", word: "before_turn", body: { turn }, wait: true });
      return reflex.executionContext(turn); },
    runner: { async runTurn(input, emit) {
      runnerCalls++; order.push("runner"); inputContext = input.peripheralContext;
      await router.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false,
        ownerProxy: false, turn: input.turn }, { to: "device:phone", kind: "request", word: action, body: {}, wait: true });
      await emit({ id: "done", text: "检查完成，请看结果" });
      return { reason: options.reason ?? "completed" };
    } } });
  const reflex = new ReflexMember(router, () => agent.inbox.activeTurn()?.id ?? null, {
    screenExecutionEnabled: Boolean(options.execution), // Original route fixtures remain independent.
    ready: () => !agent.inbox.activeTurn() && !agent.waitingForQuiescence,
    routes: options.extraRoute ? [options.extraRoute] : [],
    model: { async evaluate(state, questions, signal) {
      if (Object.hasOwn(questions, "execution_screen")) { executionCalls++; order.push("execution");
        return options.execution?.evaluate ? options.execution.evaluate(state, signal) : { answers: {
          execution_screen: { choice: options.execution?.mode ?? "foreground_handoff", confidence: options.execution?.confidence ?? 0.99 } } }; }
      calls++; latestState = state;
      return options.evaluate ? options.evaluate(state, signal) : answer(options.real, options.virtual); } },
    screenHost: { async decisionCall(word, body, signal) {
      if (word === "surface.get") { order.push("surface"); await options.surface?.(signal);
        return options.surfaceValue ?? { home_visible: options.visible !== false, page_live: true, visibility_epoch: 1,
          virtual_available: options.execution?.virtualAvailable === true }; }
      if (word === "screen.get") return structuredClone(screen);
      if (word === "screen.return") { returns++; return { acted: true }; }
      if (word === "virtual.close") { closes++; return { acted: true }; }
      throw new Error("unexpected word");
    } },
  });
  members.register(agent); members.register(reflex);
  router.setDeviceExecutionGuard((message) => reflex.executionViolation(message));
  agent.prepareRecovery(); await router.recover(); await agent.start();
  const send = () => router.send({ ...owner, nativeUi: options.native !== false }, { to: "agent:main", kind: "request", word: "say",
    body: { text: options.text ?? "帮我查一下设置，然后告诉我结果" }, wait: true });
  const rows = () => ledger.list({ limit: 2000 });
  return { ledger, router, reflex, agent, screen, order, send, rows,
    get calls() { return calls; }, get runnerCalls() { return runnerCalls; }, get returns() { return returns; }, get closes() { return closes; },
    get executionCalls() { return executionCalls; }, get inputContext() { return inputContext; },
    get state() { return latestState; },
    async done() { await wait(() => rows().some((row) => row.word === "turn.end")); await reflex.settled(); },
    async close() { await agent.close(); await reflex.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("phone turn waits for the fast local surface snapshot, then JEV can return its real screen to Ash", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const f = await fixture({ surface: async () => hold });
  try {
    await f.send(); await wait(() => f.order.includes("surface"));
    assert.equal(f.runnerCalls, 0);
    release(); await f.done();
    assert.deepEqual(f.order, ["surface", "runner"]);
    assert.equal(f.calls, 1); assert.equal(f.returns, 1);
    assert.equal(f.state.owner_request[0], "帮我查一下设置，然后告诉我结果");
    assert.deepEqual(f.state.final_replies, ["检查完成，请看结果"]);
    assert.equal(f.rows().filter((row) => row.word === "decision.applied" && row.body.acted).length, 1);
  } finally { release(); await f.close(); }
});

test("remote, hidden, malformed-surface, and read-only turns never take phone focus", async () => {
  for (const options of [{ native: false }, { visible: false }, { action: "screen.read" },
    { surfaceValue: { home_visible: "true", page_live: true, visibility_epoch: 1 } }]) {
    const f = await fixture(options);
    try { await f.send(); await f.done(); assert.equal(f.calls, 0); assert.equal(f.returns, 0); assert.equal(f.runnerCalls, 1); }
    finally { await f.close(); }
  }
});

test("surface timeout releases the task without enabling screen reconciliation", async () => {
  const f = await fixture({ surface: (signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  try { await f.send(); await f.done(); assert.equal(f.runnerCalls, 1); assert.equal(f.calls, 0); assert.equal(f.returns, 0); }
  finally { await f.close(); }
});

test("JEV stay preserves a destination/login screen; virtual-only work closes only its owned screen", async () => {
  for (const options of [{ real: "stay" }, { action: "vscreen.create", real: "return_to_ash", virtual: "close" }]) {
    const f = await fixture(options);
    try { await f.send(); await f.done(); assert.equal(f.calls, 1); assert.equal(f.returns, 0);
      assert.equal(f.closes, options.virtual === "close" ? 1 : 0); }
    finally { await f.close(); }
  }
});

test("user screen changes while JEV is pending invalidate its answer", async () => {
  let release!: (raw: unknown) => void;
  const pending = new Promise<unknown>((r) => { release = r; });
  const f = await fixture({ evaluate: async () => pending });
  try { await f.send(); await wait(() => f.calls === 1); f.screen.state_epoch++;
    release(answer()); await f.done(); assert.equal(f.returns, 0);
    assert.equal(f.rows().find((row) => row.word === "decision.applied")?.body.skipped, "stale"); }
  finally { release(answer()); await f.close(); }
});

test("a newer turn supersedes an old screen judgment even when a model ignores abort", async () => {
  let release!: (raw: unknown) => void, evals = 0;
  const pending = new Promise<unknown>((r) => { release = r; });
  const f = await fixture({ evaluate: async () => ++evals === 1 ? pending : answer("stay") });
  try { await f.send(); await wait(() => f.calls === 1); await f.send(); await wait(() => f.runnerCalls === 2);
    release(answer()); await f.done(); assert.equal(f.returns, 0);
    assert.ok(f.rows().some((row) => row.word === "decision.applied" && row.body.skipped === "superseded")); }
  finally { release(answer()); await f.close(); }
});

test("invalid/unavailable JEV and errored turns leave the screen unchanged", async () => {
  for (const options of [{ evaluate: async () => answer("shell.run") }, { evaluate: async () => { throw new Error("JEV unavailable"); } },
    { reason: "error" as const }]) {
    const f = await fixture(options);
    try { await f.send(); await f.done(); assert.equal(f.returns, 0); assert.equal(f.closes, 0); }
    finally { await f.close(); }
  }
});

test("peripheral host words are inaccessible to owners/agents; repeated triggers apply once", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.router.send(owner, { to: "service:reflex", kind: "request", word: "screen.return",
      body: { expected_package: "app", expected_state_epoch: 1, decision_id: "forged" }, wait: true }), /trusted local runtime/);
    await assert.rejects(f.router.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true,
      remote: false, ownerProxy: false }, { to: "service:reflex", kind: "request", word: "before_turn", body: { turn: "forged" } }), /trusted local runtime/);
    assert.equal(f.reflex.words().every((word) => word.audience === "owner"), true);
    await f.send(); await f.done();
    const end = f.rows().find((row) => row.word === "turn.end")!;
    f.reflex.runtime.observe(end); await f.reflex.settled(); assert.equal(f.returns, 1);
    assert.ok(f.ledger.retryMessage("service:reflex", `decision:${f.rows().find((r) => r.word === "decision.started")!.body.decision_id}:started`));
  } finally { await f.close(); }
});

test("an independent third route registers without runtime or JEV transport changes", async () => {
  let applied = 0;
  const route: DecisionRoute = { id: "test.attention", version: 1, match(message) {
    if (message.word !== "turn.end") return null;
    return { trigger: message, state: {}, evidence: [message.id], judge: async () => ({ stage: "test", outcome: { attention: "none" } }),
      current: () => true, apply: async () => { applied++; return { acted: false }; } };
  } };
  const f = await fixture({ extraRoute: route });
  try { await f.send(); await f.done(); assert.equal(applied, 1); assert.equal(f.calls, 1); }
  finally { await f.close(); }
});

test("open-app delivery is planned before the runner and cannot be undone by completion cleanup", async () => {
  let release!: (raw: unknown) => void;
  const pending = new Promise<unknown>((r) => { release = r; });
  const f = await fixture({ text: "帮我打开闲鱼", execution: { virtualAvailable: true, evaluate: async (state) => {
    assert.deepEqual(state.owner_request, ["帮我打开闲鱼"]); assert.equal(state.virtual_available, true); return pending;
  } } });
  try {
    await f.send(); await wait(() => f.executionCalls === 1); assert.equal(f.runnerCalls, 0);
    release({ answers: { execution_screen: { choice: "foreground_handoff", confidence: 0.99 } } });
    await f.done();
    assert.deepEqual(f.order, ["surface", "execution", "surface", "runner"]);
    assert.match(f.inputContext!, /foreground_handoff/); assert.match(f.inputContext!, /REAL phone screen/);
    assert.equal(f.state.execution_plan.mode, "foreground_handoff");
    assert.equal(f.returns, 0, "even an erroneous return verdict must not undo visible app delivery");
    assert.equal(f.rows().find((r) => r.word === "decision.applied")?.body.skipped, "foreground_handoff");
    const hook = f.rows().find((r) => r.kind === "request" && r.word === "before_turn")!;
    const captures = (f.ledger.responseTo(hook.id)!.body.result as { captures: any[] }).captures;
    assert.equal(captures.find((c) => c.route === "screen.execution").state.execution.mode, "foreground_handoff");
  } finally { release({}); await f.close(); }
});

test("foreground app delivery rejects a wrong virtual launch instead of authorizing invisible delivery", async () => {
  const f = await fixture({ text: "帮我打开闲鱼", action: "vscreen.launch", execution: { mode: "foreground_handoff", virtualAvailable: true } });
  try {
    await f.send(); await f.done();
    const attempted = f.rows().find((r) => r.kind === "request" && r.word === "vscreen.launch")!;
    const reply = f.ledger.responseTo(attempted.id)!;
    const error = reply.body.error as { code: string; message: string };
    assert.equal(reply.body.ok, false); assert.equal(error.code, "forbidden");
    assert.match(error.message, /real-screen capabilities/);
    assert.equal(f.screen.virtual_open, false); assert.equal(f.calls, 0);
  } finally { await f.close(); }
});

test("delegated in-app work prefers usable virtual screen, and closes only the task-owned display", async () => {
  const f = await fixture({ text: "在闲鱼帮我查一下二手相机价格，然后告诉我", action: "vscreen.create",
    execution: { mode: "virtual_task", virtualAvailable: true }, virtual: "close" });
  try {
    await f.send(); await f.done(); assert.match(f.inputContext!, /Mode: virtual_task/);
    assert.equal(f.state.execution_plan.virtual_available, true);
    assert.equal(f.returns, 0); assert.equal(f.closes, 1);
  } finally { await f.close(); }
});

test("unavailable Shizuku, invalid/low-confidence/missing JEV cannot silently select virtual execution", async () => {
  for (const execution of [{ mode: "virtual_task", virtualAvailable: false }, { mode: "shell.run", virtualAvailable: true },
    { mode: "virtual_task", virtualAvailable: true, confidence: 0.2 },
    { virtualAvailable: true, evaluate: async () => { throw new Error("JEV unavailable"); } }]) {
    const f = await fixture({ execution });
    try { await f.send(); await f.done(); assert.match(f.inputContext!, /Mode: foreground_task; stage: fallback/);
      assert.equal(f.state.execution_plan.mode, "foreground_task"); assert.equal(f.returns, 1); }
    finally { await f.close(); }
  }
});

test("remote/hidden turns never invoke pre-run JEV; ordinary web lookup needs no screen handoff", async () => {
  for (const option of [{ native: false }, { visible: false }]) {
    const f = await fixture({ ...option, execution: { mode: "foreground_handoff" } });
    try { await f.send(); await f.done(); assert.equal(f.executionCalls, 0); assert.equal(f.inputContext, undefined); }
    finally { await f.close(); }
  }
  const f = await fixture({ text: "查一下今天的科技新闻", action: "screen.read", execution: { mode: "no_preference" } });
  try { await f.send(); await f.done(); assert.match(f.inputContext!, /no_preference/); assert.equal(f.calls, 0); assert.equal(f.returns, 0); }
  finally { await f.close(); }
});

test("a user changing focus during the execution judgment invalidates its screen plan", async () => {
  const surface = { home_visible: true, page_live: true, visibility_epoch: 1, virtual_available: true };
  const f = await fixture({ surfaceValue: surface, execution: { evaluate: async () => {
    surface.home_visible = false; surface.visibility_epoch++;
    return { answers: { execution_screen: { choice: "foreground_handoff", confidence: 0.99 } } };
  } } });
  try { await f.send(); await f.done(); assert.equal(f.runnerCalls, 1); assert.equal(f.inputContext, undefined);
    assert.equal(f.calls, 0); assert.equal(f.returns, 0); }
  finally { await f.close(); }
});

test("an execution decision timeout releases the runner with a foreground fallback", async () => {
  const f = await fixture({ execution: { evaluate: async () => new Promise(() => {}) } });
  try { await f.send(); await f.done(); assert.equal(f.runnerCalls, 1);
    assert.match(f.inputContext!, /stage: fallback/); assert.equal(f.state.execution_plan.fallback, "timeout"); }
  finally { await f.close(); }
});

test("execution-screen constraints run before approval and are rechecked after approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-screen-constraint-")), ledger = await Ledger.open(join(dir, "world.db"));
  try {
    const router = new WorldRouter(ledger, async () => true);
    let forbidden = true, approvals = 0, executions = 0;
    router.registerDeviceBatch("device:phone", [{ name: "vscreen.launch", label: "Launch", description: "Test", risk: "outward", effect: "act",
      input_schema: { type: "object" } }], () => { executions++; return { ok: true, result: {} }; });
    router.setDeviceExecutionGuard(() => forbidden ? "foreground_handoff forbids virtual launch" : null);
    router.setGate(async () => { approvals++; forbidden = true; return { allow: true }; });
    const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true,
      remote: false, ownerProxy: false, turn: "t_constraint" };
    const send = (caller: TrustedRouteContext) => router.send(caller, { to: "device:phone", kind: "request", word: "vscreen.launch", body: {}, wait: true });
    assert.equal((await send(agent)).reply!.body.ok, false); assert.equal(approvals, 0); assert.equal(executions, 0);
    forbidden = false;
    assert.equal((await send(agent)).reply!.body.ok, false); assert.equal(approvals, 1); assert.equal(executions, 0);
    assert.equal((await send(owner)).reply!.body.ok, true); assert.equal(executions, 1, "the owner's direct action is not an Agent screen decision");
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the existing stop route cancels a pre-run screen judgment without starting DSH or waiting for a late model", async () => {
  let release!: (raw: unknown) => void;
  const pending = new Promise<unknown>((r) => { release = r; });
  const f = await fixture({ execution: { evaluate: async () => pending } });
  try {
    await f.send(); await wait(() => f.executionCalls === 1);
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "停下" }, wait: true });
    await wait(() => f.rows().some((r) => r.word === "turn.end" && r.body.reason === "cancelled"));
    await wait(() => f.rows().some((r) => r.kind === "response" && r.word === "before_turn"));
    assert.equal(f.runnerCalls, 0); assert.equal(f.inputContext, undefined);
    release({ answers: { execution_screen: { choice: "virtual_task", confidence: 0.99 } } });
    await f.reflex.settled(); assert.equal(f.returns, 0); assert.equal(f.closes, 0);
  } finally { release({}); await f.close(); }
});
