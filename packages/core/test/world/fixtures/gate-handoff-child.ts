import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { startOwner } from "../../../src/main";
import { Ledger } from "../../../src/world/ledger";

const root = process.env.TEST_ROOT!;
const stage = process.env.TEST_STAGE!;
const durableBarrier = () => {
  const fd = openSync(join(root, "commit-barrier"), "wx", 0o600);
  try { writeSync(fd, stage); fsyncSync(fd); } finally { closeSync(fd); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const notify = (type: string, extra: Record<string, unknown> = {}) => process.send?.({ type, ...extra });
const stop = (type: string, extra: Record<string, unknown> = {}) => {
  process.send?.({ type, ...extra });
  return new Promise<never>(() => {});
};

// These two probes are test-only synchronous commit barriers. There is no
// production hook or alternate route to internal.approval.
if (stage === "answered-before-cas" || stage === "cas-before-handoff") {
  const dispatch = Ledger.prototype.dispatchAllowedGate;
  Ledger.prototype.dispatchAllowedGate = function (...args) {
    const parent = this.byId(args[0]);
    if (parent?.word !== "internal.approval") return dispatch.apply(this, args);
    if (stage === "answered-before-cas") durableBarrier();
    const result = dispatch.apply(this, args);
    if (stage === "cas-before-handoff" && result) durableBarrier();
    return result;
  };
}

try {
  const running = await startOwner({ stateDir: join(root, "state"), workspaces: { home: join(root, "home") }, listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "dsh" }], host: { url: process.env.TEST_HOST_URL!, token: "synthetic-host-token" },
    dsh: { root: process.env.ASH_TEST_DSH_ROOT!, home: join(root, "dsh"), env: {
      DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: process.env.TEST_MODEL_URL!,
    } } });
  if (stage === "recover") {
    const rows = running.ledger.list({ after: 0, limit: 1000 });
    const parent = rows.find((item) => item.kind === "request" && item.word === "internal.approval");
    notify("recovered", { parentCount: rows.filter((item) => item.kind === "request" && item.word === "internal.approval").length,
      parentResponseCount: rows.filter((item) => item.kind === "response" && item.reply_to === parent?.id).length,
      parentOutcome: (parent && running.ledger.responseTo(parent.id)?.body.result as { outcome?: string } | undefined)?.outcome ?? null,
      gateAskCount: parent ? Number(Boolean(running.ledger.gateCase(parent.id))) : 0 });
    await running.close();
    process.exit(0);
  }
  const session = (running.dsh as unknown as { main: { agent: { ctx: { on: (name: string, handler: (...args: any[]) => unknown) => () => void } } } }).main;
  const approval = (running.dsh as unknown as { ctx: { get: (name: string) => { setPolicy: (agent: object, value: string) => void } } }).ctx.get("approval");
  session.agent.ctx.on("tools/pre-execute", async (exec: { name: string }, next: () => Promise<unknown>) =>
    exec.name === "ash_send" ? { kind: "ask", reason: "synthetic test approval" } : next());
  session.agent.ctx.on("tools/execute", async (exec: { name: string }, next: () => Promise<unknown>) => {
    if (exec.name !== "ash_send") return next();
    if (stage === "handoff-before-effect") return stop("barrier", { stage });
    if (stage === "policy-after-handoff") {
      const parent = running.ledger.list().find((item) => item.kind === "request" && item.word === "internal.approval");
      if (!parent || (running.ledger.responseTo(parent.id)?.body.result as { outcome?: string } | undefined)?.outcome !== "allowed-once")
        throw new Error("policy probe did not reach committed handoff");
      approval.setPolicy(session.agent, "never");
      notify("policy-changed-after-handoff");
    }
    if (stage === "acl-after-handoff") {
      const revoked = await send({ to: "service:gate", kind: "request", word: "access.revoke", body: { id: grantId }, wait: true });
      if (revoked.status !== 200 || !(await revoked.json() as { reply?: { body?: { ok?: boolean } } }).reply?.body?.ok)
        throw new Error("synthetic device grant revocation failed");
      notify("acl-revoked-after-handoff");
    }
    return next();
  });
  const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
  const screen = running.edge.screens.register({ member: "person:owner", transport: "api", local: true, remote: false,
    ownerProxy: true, transportPrincipal: `token:${createHash("sha256").update(ownerToken).digest("hex")}` }, "handoff-test", "Test tab");
  const send = (wire: object) => fetch(`${running.url}/api/send`, { method: "POST", headers: {
    authorization: `Bearer ${ownerToken}`, "content-type": "application/json", "Ash-Screen": screen.token,
  }, body: JSON.stringify(wire) });
  const grant = await send({ to: "service:gate", kind: "request", word: "access.grant",
    body: { member: "agent:main", scope: "device:phone/hold" }, wait: true });
  const granted = await grant.json() as { reply?: { body?: { ok?: boolean; result?: { id?: string } } } };
  if (grant.status !== 200 || !granted.reply?.body?.ok || !granted.reply.body.result?.id)
    throw new Error("synthetic access grant failed");
  const grantId = granted.reply.body.result.id;
  const sent = await send({ to: "agent:main", kind: "request", word: "say", body: { text: "use the synthetic hold tool" }, client_id: "handoff-turn" });
  if (sent.status !== 200) throw new Error(`synthetic say rejected: ${sent.status}`);
  const deadline = Date.now() + 15_000;
  let parent: ReturnType<typeof running.ledger.byId> | undefined;
  while (Date.now() < deadline) {
    parent = running.ledger.list().find((item) => item.kind === "request" && item.word === "internal.approval");
    if (parent && running.ledger.gateCase(parent.id)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!parent) throw new Error("internal approval parent absent");
  const gate = running.ledger.gateCase(parent.id);
  if (!gate) throw new Error("gate ask absent");
  if (stage === "policy-after-handoff" || stage === "acl-after-handoff") running.world.subscribe((item) => {
    // With its grant revoked, the device call does not run: the owner is asked for access again instead.
    if (stage === "acl-after-handoff" && item.word === "gate.asked" && item.body.risk === "none") notify("access-asked", {
      parentResponseCount: running.ledger.list().filter((row) => row.kind === "response" && row.reply_to === parent!.id).length,
      askResponseCount: running.ledger.list().filter((row) => row.kind === "response" && row.reply_to === gate.askId).length,
    });
    if (item.word === "turn.end") notify("turn-ended", {
      parentResponseCount: running.ledger.list().filter((row) => row.kind === "response" && row.reply_to === parent!.id).length,
      askResponseCount: running.ledger.list().filter((row) => row.kind === "response" && row.reply_to === gate.askId).length,
    });
  });
  process.on("message", async (message: unknown) => {
    if ((message as { type?: string })?.type !== "answer") return;
    const answer = await send({ to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId,
      body: { ok: true, result: { choice: "once" } } });
    notify("answer-ack", { status: answer.status });
  });
  notify("ask-ready", { parentId: parent.id, askId: gate.askId });
  await new Promise(() => {});
} catch (error) {
  notify("error", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
