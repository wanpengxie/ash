import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { createAgentMember, type AgentTurnInput, type AgentTurnRunner } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const caller = (member: string): TrustedRouteContext => ({ transport: member.startsWith("service:") ? "service" : "api",
  transportPrincipal: member, member, local: true, remote: false, ownerProxy: false });
const owner = caller("person:owner");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture(runner: AgentTurnRunner) {
  const dir = mkdtempSync(join(tmpdir(), "agent-steer-"));
  const ledger = await Ledger.open(join(dir, "ledger.db"));
  const router = new WorldRouter(ledger, async () => true);
  const member = createAgentMember({ ledger, router, stateDir: join(dir, "member"), runner });
  new WorldMembers(router).register(member);
  router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  member.prepareRecovery();
  const rows = () => ledger.list({ after: 0, limit: 1000 });
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) { if (check()) return; await sleep(10); }
    throw new Error("expected state was not reached");
  };
  return { ledger, router, member, rows, waitFor, async close() { await member.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a message sent mid-turn joins the running turn when the runtime takes it", async () => {
  const release = deferred();
  const turns: AgentTurnInput[] = [];
  const steered: string[] = [];
  const f = await fixture({
    async runTurn(input) { turns.push(input); await release.promise; return { reason: "completed" }; },
    async steer(input) { steered.push(input.rendered); return true; },
  });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
    await f.waitFor(() => turns.length === 1);
    const second = await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "also this" }, wait: true });
    await f.waitFor(() => steered.length === 1);
    await f.waitFor(() => f.rows().some((m) => m.word === "read" && (m.body.ids as string[]).includes(second.id)));
    release.resolve();
    await f.waitFor(() => f.rows().some((m) => m.word === "turn.end"));
    await sleep(50);
    assert.equal(turns.length, 1, "no second turn for a steered message");
    assert.match(steered[0]!, /also this/);
    const read = f.rows().find((m) => m.word === "read" && (m.body.ids as string[]).includes(second.id))!;
    assert.equal(read.body.turn, turns[0]!.turn);
    assert.deepEqual(f.member.counts(), { pending: 0, read: 2, active: 0 });
  } finally { await f.close(); }
});

test("a runtime that is not working leaves the message for the next turn", async () => {
  const release = deferred();
  const turns: AgentTurnInput[] = [];
  const f = await fixture({
    async runTurn(input) { turns.push(input); if (turns.length === 1) await release.promise; return { reason: "completed" }; },
    async steer() { return false; },
  });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
    await f.waitFor(() => turns.length === 1);
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "later" }, wait: true });
    await sleep(50);
    release.resolve();
    await f.waitFor(() => turns.length === 2);
    assert.match(turns[1]!.rendered, /later/);
  } finally { await f.close(); }
});

test("when the turn is stopped, the steered words go back to the queue and are answered next", async () => {
  const turns: AgentTurnInput[] = [];
  const f = await fixture({
    async runTurn(input, _emit, signal) {
      turns.push(input);
      if (turns.length === 1) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { reason: signal.aborted ? "error" : "completed" };
    },
    async steer() { return true; },
  });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
    await f.waitFor(() => turns.length === 1);
    const second = await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "stop, do this instead" }, wait: true });
    await f.waitFor(() => f.rows().some((m) => m.word === "read" && (m.body.ids as string[]).includes(second.id)));
    await f.router.send(caller("service:reflex"), { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "owner asked to stop" }, wait: true });
    await f.waitFor(() => turns.length === 2);
    assert.match(turns[1]!.rendered, /do this instead/);
  } finally { await f.close(); }
});
