import assert from "node:assert/strict";
import test from "node:test";
import type { Caller } from "../../../../sdk/src/message";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { createDirectoryService, type AgentPolicy } from "../../../src/services/directory";
import { agent, call, code, kernel, owner } from "../support";

const member = (id: string, kind: Member["kind"]): Member => ({ id, kind, name: id, words: () => wordsOf(id), handle: async () => undefined });
const members = [member("service:vault", "service"), member("service:host", "service"), member("service:clock", "service")];
const registry = {
  list: () => members.map((m) => ({ id: m.id, kind: m.kind, name: m.name })),
  describe: (id: string) => { const m = members.find((x) => x.id === id); return m ? { info: { id, kind: m.kind, name: m.name }, words: m.words() } : null; },
};
const policies: Record<string, AgentPolicy | null> = { "agent:main": {}, "agent:narrow": { words: ["service:vault/list", "service:clock/*"] }, "agent:tooled": { tools: ["timer_set"] } };
const service = createDirectoryService({
  registry, agentPolicy: (a) => policies[a] ?? null,
  toolWords: (t) => (t === "timer_set" ? ["service:clock/set"] : []),
  appGranted: (app, to, word) => app === "app:notes" && to === "service:clock" && word === "list",
});
const words = (data: any, id: string): string[] => (data.members.find((m: any) => m.id === id)?.words ?? []).map((w: any) => w.name);
const remoteOwner: Caller = { ...owner, local: false };

test("the owner sees what its kind may call", async () => {
  const list = await call(service, owner, "list");
  assert.ok(words(list, "service:vault").includes("set"));
  assert.ok(words(list, "service:clock").includes("set"));
  assert.ok(!list.members.some((m: any) => m.id === "service:host" && m.words.includes("wake.at")), "kernel-only words are hidden from the owner");
  assert.ok(!words(list, "service:vault").includes("vault.changed"), "events are not words to call");
});

test("nothing is local-only: a remote owner sees what the owner on this machine sees", async () => {
  assert.deepEqual(await call(service, remoteOwner, "list"), await call(service, owner, "list"));
  assert.ok(words(await call(service, remoteOwner, "list"), "service:vault").includes("set"));
});

test("an agent sees what callers allows (what the owner can call, but the owner's typing of a secret); the kernel sees all, including kernel-only words", async () => {
  const a = await call(service, agent("main"), "list");
  assert.deepEqual(words(a, "service:vault").sort(), ["connect", "delete", "describe", "generate", "list", "provider", "put", "request", "services"]);
  assert.deepEqual(words(a, "service:host").sort(), ["ctx.list", "ctx.read", "restart", "update.install", "update.status"], "the host's words an agent may call, not its kernel-only ones");
  const k = await call(service, kernel, "list");
  assert.ok(words(k, "service:host").includes("wake.at"));
  assert.ok(words(k, "service:vault").includes("set"));
});

test("an agent is cut down to its own declaration: words, and the words of its tools", async () => {
  const narrow = await call(service, agent("narrow"), "list");
  assert.deepEqual(words(narrow, "service:vault"), ["list"]);
  assert.deepEqual(words(narrow, "service:clock").sort(), ["cancel", "list", "set"]);
  const tooled = await call(service, agent("tooled"), "list");
  assert.deepEqual(tooled.members.map((m: any) => [m.id, m.words.map((w: any) => w.name)]), [["service:clock", ["set"]]]);
  assert.deepEqual((await call(service, agent("ghost"), "list")).members, [], "an undeclared agent sees nothing");
});

test("an app sees only what it was granted; a hand nothing", async () => {
  const app: Caller = { member: "app:notes", via: "app", local: false };
  assert.deepEqual((await call(service, app, "list")).members.map((m: any) => [m.id, m.words.map((w: any) => w.name)]), [["service:clock", ["list"]]]);
  assert.deepEqual((await call(service, { member: "device:phone", via: "hand", local: true }, "list")).members, []);
});

test("list {member} narrows, and an unknown or invisible member is not_found", async () => {
  const one = await call(service, agent("main"), "list", { member: "service:vault" });
  assert.deepEqual(one.members.map((m: any) => m.id), ["service:vault"]);
  await assert.rejects(call(service, agent("main"), "list", { member: "service:nope" }), (e: any) => e.code === "not_found");
  await assert.rejects(call(service, agent("narrow"), "list", { member: "service:host" }), (e: any) => e.code === "not_found", "outside its declaration");
});

test("describe gives the full contract and marks words that need approval", async () => {
  const d = await call(service, agent("main"), "describe", { member: "service:clock" });
  const set = d.words.find((w: any) => w.word === "set");
  assert.ok(set.input_schema && set.description && set.label);
  assert.equal(set.effect, "write");
  assert.equal(set.risk, "none");
  assert.equal(set.needs_approval, undefined);
  const gate = await call(service, agent("main"), "describe", { member: "service:vault", word: "list" });
  assert.deepEqual(gate.words.map((w: any) => w.word), ["list"]);
  assert.equal(await code(service.handle({ seq: 0, id: "m", ts: 0, from: "agent:main", to: "service:directory", kind: "request", word: "describe", body: { member: "service:vault", word: "set" } },
    { signal: new AbortController().signal, caller: agent("main"), raw: null }) as Promise<unknown>), "not_found");
  // a word that needs approval is listed and flagged for an agent, but not for the owner
  const withRisk = createDirectoryService({ registry: { ...registry, describe: (id) => id === "service:vault" ? { info: { id, kind: "service", name: id }, words: wordsOf(id).map((w) => w.word === "list" ? { ...w, risk: "outward", effect: "act" } : w) } : registry.describe(id) },
    agentPolicy: () => ({}) });
  assert.equal((await call(withRisk, agent(), "describe", { member: "service:vault", word: "list" })).words[0].needs_approval, true);
  assert.equal((await call(withRisk, owner, "describe", { member: "service:vault", word: "list" })).words[0].needs_approval, undefined);
});

test("list carries each word's label, and flags words that need approval for agents but not for the owner", async () => {
  const risky = createDirectoryService({
    registry: { ...registry, describe: (id) => id === "service:vault" ? { info: { id, kind: "service", name: id }, words: wordsOf(id).map((w) => w.word === "list" ? { ...w, risk: "outward", effect: "act" } : w.word === "describe" ? { ...w, per_call_risk: true, risk: "structure", effect: "write" } : w) } : registry.describe(id) },
    agentPolicy: () => ({}),
  });
  const vaultWords = (data: any) => data.members.find((m: any) => m.id === "service:vault").words;
  const forAgent = vaultWords(await call(risky, agent(), "list"));
  assert.deepEqual(forAgent.find((w: any) => w.name === "list"), { name: "list", label: "在看保存的凭据", needs_approval: true });
  assert.equal(forAgent.find((w: any) => w.name === "describe").needs_approval, "per_call");
  assert.ok(vaultWords(await call(risky, owner, "list")).every((w: any) => w.needs_approval === undefined && w.label));
});
