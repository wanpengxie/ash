import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WordEffect } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import { GateMember } from "../../src/members/gate";
import type { Reviewer, ReviewVerdict } from "../../src/review/reviewer";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const agent: TrustedRouteContext = { transport: "agent", member: "agent:main", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false, turn: "t_audit" };
const keeper: TrustedRouteContext = { transport: "agent", member: "agent:keeper", transportPrincipal: "agent:keeper", local: true, remote: false, ownerProxy: false, turn: "t_keep" };
const screen: TrustedRouteContext = { transport: "web_ui", member: "person:owner", transportPrincipal: "owner-principal", local: true, remote: false, ownerProxy: true,
  screenId: "screen:approved", screenLabel: "Test screen" };
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
const caps: { name: string; label: string; risk: "none" | "outward" | "structure"; effect?: WordEffect }[] = [
  { name: "clipboard.set", label: "改剪贴板", risk: "outward", effect: "act" },
  { name: "post.publish", label: "发帖", risk: "outward", effect: "send" },
  { name: "shell.run", label: "执行命令", risk: "structure", effect: "execute" },
];

async function setup(verdict: ReviewVerdict) {
  const ledger = await Ledger.open(join(mkdtempSync(join(tmpdir(), "ash-gate-audit-")), "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => {} });
  let mode: "auto" | "always" = "auto";
  members.register(new GateMember(ledger, router, members, { get: () => mode, set: (next) => { mode = next; } }));
  router.setApprovalMode(() => mode);
  const effects: string[] = [];
  router.registerDeviceBatch("device:phone", caps.map((cap) => ({ ...cap, description: cap.label, input_schema: { type: "object", additionalProperties: true } })),
    (message) => { effects.push(message.word); return { ok: true, result: {} }; });
  router.enableDurableGate();
  let reviews = 0;
  const reviewer: Reviewer = async () => { reviews++; return verdict; };
  router.setReviewer(reviewer);
  const send = async (ctx: TrustedRouteContext, to: string, word: string, body: Record<string, unknown>) => {
    const sent = await router.send(ctx, { to, kind: "request", word, body });
    await tick();
    return sent.id;
  };
  const card = (id: string) => { const gate = ledger.gateCase(id); return gate ? { gate, ask: ledger.byId(gate.askId)! } : null; };
  const answer = async (id: string, choice: "once" | "always" | "deny") => {
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: card(id)!.gate.askId, body: { ok: true, result: { choice } } });
    await tick();
  };
  const audit = (query: Record<string, unknown> = {}) => ledger.gateAudit(query).entries;
  return { ledger, router, effects, mode: () => mode, send, card, answer, audit, reviews: () => reviews,
    close: () => { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); } };
}

test("every judged action leaves evidence: facts, verdict, card, decision, who decided, and whether it ran", async () => {
  const w = await setup({ decision: "allow", reason: "主人明确要求写剪贴板" });
  try {
    const allowed = await w.send(agent, "device:phone", "clipboard.set", { text: "开会" });
    const [entry] = w.audit({ request_id: allowed });
    assert.equal(entry!.decision, "review");
    assert.equal(entry!.decided_by, "review");
    assert.equal(entry!.reason, "主人明确要求写剪贴板");
    assert.equal((entry!.review as { decision: string }).decision, "allow");
    assert.equal((entry!.facts as { requester: string }).requester, "agent:main");
    assert.match(String(entry!.content), /开会/);
    assert.deepEqual(entry!.executed, { ok: true });
    // The owner's history list names the action as the capability does.
    const listed = w.ledger.gateHistoryPage().items.find((item) => item.source === "current" && item.request_id === allowed);
    assert.equal(listed && "label" in listed ? listed.label : undefined, "改剪贴板");
    // A command is never reviewed: the card is the evidence, and the owner's answer is recorded with it.
    const command = await w.send(agent, "device:phone", "shell.run", { command: "ls" });
    await w.answer(command, "deny");
    const [denied] = w.audit({ request_id: command });
    assert.equal(denied!.decided_by, "owner");
    assert.equal(denied!.decision, "deny");
    assert.ok(denied!.card && (denied!.card as { title: string }).title);
    assert.ok(denied!.answered_at);
    assert.equal((denied!.executed as { ok: boolean }).ok, false);
    assert.deepEqual(w.effects, ["clipboard.set"]);
  } finally { w.close(); }
});

test("an agent's rule change always asks the owner, whatever the reviewer or rules say, and never offers always", async () => {
  const w = await setup({ decision: "allow", reason: "looks fine" });
  try {
    const reviewsBefore = w.reviews();
    const ask = await w.send(agent, "service:gate", "rules.set", { agent: "agent:main", member: "device:phone", word: "post.publish" });
    assert.equal(w.reviews(), reviewsBefore, "the reviewer is never consulted about rule changes");
    const pending = w.card(ask)!;
    assert.deepEqual((pending.ask.body.options as { id: string }[]).map((option) => option.id), ["once", "deny"]);
    assert.match(String(pending.ask.body.title), /审批规则/);
    assert.equal(w.ledger.gateRulesPage().rules.length, 0, "nothing changes before the owner answers");
    await w.answer(ask, "once");
    const rules = w.ledger.gateRulesPage().rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.object_pattern, "*");
    // The new rule covers exactly that: the agent publishing there now passes without the reviewer or a card.
    const covered = await w.send(agent, "device:phone", "post.publish", { site: "x.com", text: "hi" });
    assert.equal(w.audit({ request_id: covered })[0]!.decided_by, "rule");
    // Revoking is asked about too; a refusal leaves the rule in place.
    const revoke = await w.send(agent, "service:gate", "rules.revoke", { id: rules[0]!.id });
    await w.answer(revoke, "deny");
    assert.equal(w.ledger.gateRulesPage().rules[0]!.revoked_at, undefined);
    // A target on a capability that has none is refused rather than stored as a rule that never matches.
    const dead = await w.send(agent, "service:gate", "rules.set", { agent: "agent:main", member: "device:phone", word: "clipboard.set", target: "site:x.com" });
    await w.answer(dead, "once");
    assert.equal((w.ledger.responseTo(dead)!.body as { ok: boolean }).ok, false);
    // Commands can never be covered by a rule, even with the owner's yes.
    const commandRule = await w.send(agent, "service:gate", "rules.set", { agent: "agent:main", member: "device:phone", word: "shell.run" });
    await w.answer(commandRule, "once");
    assert.equal(w.ledger.gateRulesPage().rules.length, 1);
    // Reading evidence and rules needs no approval.
    const read = await w.router.send(keeper, { to: "service:gate", kind: "request", word: "audit", body: { limit: 5 }, wait: true });
    assert.equal((read.reply!.body as { ok: boolean }).ok, true);
  } finally { w.close(); }
});

test("an agent may ask to switch the approval mode, but only the owner's card switches it", async () => {
  const w = await setup({ decision: "allow", reason: "looks fine" });
  try {
    const ask = await w.send(agent, "service:gate", "mode.set", { mode: "always" });
    const pending = w.card(ask)!;
    assert.deepEqual((pending.ask.body.options as { id: string }[]).map((option) => option.id), ["once", "deny"]);
    assert.match(String(pending.ask.body.title), /每次都问/);
    assert.equal(w.mode(), "auto", "nothing changes before the owner answers");
    await w.answer(ask, "deny");
    assert.equal(w.mode(), "auto");
    assert.equal(w.audit({ request_id: ask })[0]!.decided_by, "owner");
    const again = await w.send(agent, "service:gate", "mode.set", { mode: "always" });
    await w.answer(again, "once");
    assert.equal(w.mode(), "always");
    // In always mode the reviewer's allow no longer lets an outside action through on its own.
    const write = await w.send(agent, "device:phone", "clipboard.set", { text: "x" });
    assert.ok(w.card(write), "always mode asks the owner");
    assert.deepEqual(w.effects, []);
    // The agent sees the mode next to the rules, without a card.
    const rules = await w.router.send(keeper, { to: "service:gate", kind: "request", word: "rules.list", body: {}, wait: true });
    assert.equal((rules.reply!.body as { result: { mode: string } }).result.mode, "always");
  } finally { w.close(); }
});
