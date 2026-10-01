import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`timed out waiting for ${label}`);
}

for (const choice of ["once", "deny", "cancel", "policy", "policy-before" ] as const) test(`installed DSH gate handles ${choice} without extra tool effects`, { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-gate-dsh-"));
  const home = join(root, "home"); mkdirSync(home);
  let calls = 0;
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      calls++;
      const request = JSON.parse(raw || "{}") as { model?: string };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_gate_${calls}`, type: "message", role: "assistant", model: request.model,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (calls === 1) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_gate_${calls}`, name: "ash_describe", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "synthetic completion" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: calls === 1 ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {}); res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install!, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      } } });
    const session = (running.dsh as unknown as { main: { agent: { ctx: { on: (name: string, listener: (...args: any[]) => unknown) => () => void } } } }).main;
    let effects = 0;
    let spoofOutcome: string | undefined;
    const audit: { type: string; data?: Record<string, unknown> }[] = [];
    const stopAsk = session.agent.ctx.on("tools/pre-execute", async (exec: { name: string; agent: object; signal: AbortSignal }, next: () => Promise<unknown>) => {
      if (exec.name !== "ash_describe") return next();
      spoofOutcome = await (running!.dsh as unknown as { ctx: { get: (name: string) => { request: (input: object) => Promise<string> } } }).ctx
        .get("approval").request({ agent: exec.agent, toolName: exec.name, callId: "toolu_gate_spoof", signal: exec.signal });
      if (choice === "policy-before") (running!.dsh as unknown as { ctx: { get: (name: string) => { setPolicy: (agent: object, policy: string) => void } } }).ctx
        .get("approval").setPolicy(exec.agent, "never");
      return { kind: "ask", reason: "synthetic approval" };
    });
    const stopEffect = session.agent.ctx.on("tools/execute", async (exec: { name: string }, next: () => Promise<unknown>) => {
      if (exec.name === "ash_describe") effects++;
      return next();
    });
    const stopAudit = running.dsh!.onSessionEvent((_sessionId, event) => {
      if (event.type === "approval/asked" || event.type === "approval/decided") audit.push({ type: event.type, data: event.data });
    });
    const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const screen = running.edge.screens.register({ member: "person:owner", transport: "api", local: true, remote: false,
      ownerProxy: true, transportPrincipal: `token:${createHash("sha256").update(ownerToken).digest("hex")}` }, "dsh-gate", "Test tab");
    const send = (wire: object) => fetch(`${running!.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json", "Ash-Screen": screen.token }, body: JSON.stringify(wire) });
    const first = await send({ to: "agent:main", kind: "request", word: "say", body: { text: "first synthetic turn" } });
    assert.equal(first.status, 200);
    if (choice === "policy-before") {
      await until(() => running!.ledger.list().some((message) => message.word === "turn.end"), "policy-rejected turn");
      assert.equal(running.ledger.list().filter((message) => message.word === "internal.approval").length, 0);
      assert.equal(effects, 0);
      assert.equal(spoofOutcome, "unavailable");
      assert.equal(audit.at(-1)?.data?.outcome, "rejected");
      stopAudit(); stopEffect(); stopAsk();
      return;
    }
    await until(() => running!.ledger.list().some((message) => message.word === "internal.approval" && message.kind === "request"), "first internal approval");
    const parent = running.ledger.list().find((message) => message.word === "internal.approval" && message.kind === "request")!;
    try { await until(() => Boolean(running!.ledger.gateCase(parent.id)), "committed gate case"); }
    catch (error) { throw new Error(`gate case absent (model calls=${calls}, audit=${audit.map((item) => `${item.type}:${String(item.data?.outcome ?? "")}`).join(",")}, spoof=${spoofOutcome}, parent error=${String((running.ledger.responseTo(parent.id)?.body.error as { code?: string } | undefined)?.code ?? "none")})`, { cause: error }); }
    const gate = running.ledger.gateCase(parent.id)!;
    assert.equal(effects, 0);
    assert.equal(spoofOutcome, "unavailable");
    assert.equal(running.ledger.list().filter((message) => message.word === "internal.approval" && message.kind === "request").length, 1);
    assert.deepEqual((running.ledger.byId(gate.askId)!.body.options as { id: string }[]).map((option) => option.id), ["once", "deny"]);
    if (choice === "policy") {
      const approval = (running.dsh as unknown as { ctx: { get: (name: string) => { setPolicy: (agent: object, policy: string) => void } } }).ctx.get("approval");
      approval.setPolicy(session.agent, "never");
      approval.setPolicy(session.agent, "ask"); // same final value, distinct policy-event identity
      assert.equal((await send({ to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId,
        body: { ok: true, result: { choice: "once" } } })).status, 200);
    } else if (choice === "cancel") {
      const cancelled = await running.world.send({ transport: "service", member: "service:reflex", transportPrincipal: "service:reflex",
        local: true, remote: false, ownerProxy: false }, { to: "agent:main", kind: "request", word: "cancel_turn",
        body: { reason: "stop synthetic approval" }, wait: true });
      assert.equal(cancelled.reply?.body.ok, true);
    } else assert.equal((await send({ to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId,
      body: { ok: true, result: { choice } } })).status, 200);
    await until(() => Boolean(running!.ledger.responseTo(parent.id)), "approval terminal");
    if (choice === "once") {
      await until(() => effects === 1, "approved tool handoff");
      assert.equal((running.ledger.responseTo(parent.id)?.body.result as { outcome?: string } | undefined)?.outcome, "allowed-once");
    } else {
      assert.equal(effects, 0);
      assert.equal((running.ledger.responseTo(parent.id)?.body.error as { code?: string } | undefined)?.code,
        choice === "cancel" ? "cancelled" : choice === "policy" ? "failed" : "denied");
    }
    await until(() => running!.ledger.list().some((message) => message.word === "turn.end"), "first completed turn");
    assert.deepEqual(audit.map((event) => event.type), ["approval/asked", "approval/decided", "approval/asked", "approval/decided"]);
    assert.equal(audit[0]?.data?.id, audit[1]?.data?.id);
    assert.equal(audit[2]?.data?.id, audit[3]?.data?.id);
    assert.equal(audit[2]?.data?.callId, parent.body.call_id);
    assert.equal(audit[1]?.data?.outcome, "unavailable");
    assert.equal(audit[3]?.data?.outcome, choice === "once" ? "allowed-once" : choice === "deny" ? "rejected" : "cancelled");
    stopAudit(); stopEffect(); stopAsk();
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
