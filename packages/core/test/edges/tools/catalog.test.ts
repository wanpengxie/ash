import assert from "node:assert/strict";
import test from "node:test";
import type { WordContract } from "../../../../sdk/src/word";
import { MAIN, PHONE, fakeRegistry, members, startRig } from "./helpers";

const word = (member: string, name: string, over: Partial<WordContract> = {}): WordContract => ({
  member, word: name, kind: "request", direction: "in", description: `${name}: a word of the test hand, long enough to pass.`, input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  effect: "read", risk: "none", callers: ["owner", "agent", "app"], label: { doing: `在做${name}` }, ...over,
});
const phone = { id: PHONE, kind: "device" as const, name: "Find X8", words: [
  word(PHONE, "location.get"),
  word(PHONE, "screen.tap", { effect: "act", risk: "outward", per_call_risk: true }),
  word(PHONE, "x.test.owner_only", { callers: ["owner"] }),
  word(PHONE, "x.test.kernel_only", { callers: ["kernel"] }),
  word(PHONE, "x.test.install", { effect: "write", risk: "structure" }),
] };

const wordsIn = (data: any, member: string): string[] => (data.members.find((m: any) => m.id === member)?.capabilities ?? []).map((c: any) => c.word);

const rig = () => startRig({ registry: fakeRegistry(members([phone])) });

test("capability_list shows the words whose callers include an agent, and none of the others, with no special case for any member", async () => {
  const r = await rig();
  const tools = await r.client();
  const listed = await tools.call("capability_list");
  assert.equal(listed.isError, false);
  const data = listed.data;
  // the services an older surface hid are listed: the agent may call them
  assert.ok(wordsIn(data, "service:gate").includes("rules.set"), "service:gate/rules.set is in the catalog of the default agent");
  assert.ok(wordsIn(data, "service:agents").includes("declare"));
  assert.ok(wordsIn(data, "service:devices").includes("pair_start"));
  assert.ok(wordsIn(data, MAIN).includes("tell"), "other agents' words too");
  // the words an agent may not call are not
  assert.equal(wordsIn(data, "service:pulse").includes("pulse.due"), false, "pulse.due is for the kernel");
  assert.equal(wordsIn(data, "service:vault").includes("set"), false, "vault set is for the owner");
  assert.equal(wordsIn(data, "service:admin").includes("pause"), false);
  assert.deepEqual(wordsIn(data, PHONE).sort(), ["location.get", "screen.tap", "x.test.install"]);
  // events are not words to call
  for (const m of data.members) for (const c of m.capabilities) assert.notEqual(c.word, "typing");
});

test("a word that needs the owner is listed all the same, marked needs_approval", async () => {
  const r = await rig();
  const tools = await r.client();
  const phoneWords = (await tools.call("capability_list", { member: PHONE })).data.members[0].capabilities as any[];
  const by = Object.fromEntries(phoneWords.map((c) => [c.word, c]));
  assert.equal(by["location.get"].needs_approval, undefined);
  assert.equal(by["screen.tap"].needs_approval, "per_call");
  assert.equal(by["x.test.install"].needs_approval, true);
  assert.equal(by["x.test.install"].effect, "write");
  assert.equal(by["location.get"].label, "在做location.get");
});

test("the declaration cuts the catalog down: tools stand for their words, words are patterns, the two are added together", async () => {
  const r = await rig();
  r.policies.set(MAIN, { tools: ["capability_list", "capability_describe", "capability_call", "timer_*"], words: [`${PHONE}/location.get`, "service:vault/*"] });
  const tools = await r.client();
  const data = (await tools.call("capability_list")).data;
  assert.deepEqual(data.members.map((m: any) => m.id).sort(), [PHONE, "service:clock", "service:gate", "service:vault"].sort());
  assert.deepEqual(wordsIn(data, "service:gate").sort(), ["pending.get", "pending.list", "pending.redeem", "pending.skip", "pending.withdraw"], "an agent always has the words of its own pending requests");
  assert.deepEqual(wordsIn(data, PHONE), ["location.get"]);
  assert.deepEqual(wordsIn(data, "service:clock").sort(), ["cancel", "list", "set"]);
  assert.deepEqual(wordsIn(data, "service:vault").sort(), ["connect", "describe", "generate", "list", "provider", "put", "request", "services"], "vault set, delete and token are not for an agent whatever the pattern says");
  // a declaration with no limit sees everything the contracts allow; an empty list sees nothing
  r.policies.set(MAIN, { tools: ["capability_list"], words: [] });
  assert.deepEqual((await tools.call("capability_list")).data.members.map((m: any) => m.id), ["service:gate"], "only the words of its own pending requests, which every agent has");
});

test("capability_list with a member names the others; an unknown or invisible member is not_found with a hint", async () => {
  const r = await rig();
  const tools = await r.client();
  const one = (await tools.call("capability_list", { member: "service:clock" })).data;
  assert.deepEqual(one.members.map((m: any) => m.id), ["service:clock"]);
  assert.ok(one.other_members.includes(PHONE) && !one.other_members.includes("service:clock"));
  for (const member of ["service:nope"]) {
    const res = await tools.call("capability_list", { member });
    assert.equal(res.isError, true);
    assert.equal(res.data.error.code, "not_found");
    assert.ok(res.data.error.recovery_hint);
  }
});

test("capability_describe gives the whole contract of the words the agent may call", async () => {
  const r = await rig();
  const tools = await r.client();
  const one = (await tools.call("capability_describe", { member: "service:clock", word: "set" })).data;
  assert.equal(one.capabilities.length, 1);
  const c = one.capabilities[0];
  assert.equal(c.word, "set");
  assert.ok(c.description.length > 20 && c.input_schema.type === "object" && "result_schema" in c && c.effect === "write" && c.risk === "none" && c.label);
  const all = (await tools.call("capability_describe", { member: PHONE })).data;
  assert.deepEqual(all.capabilities.map((x: any) => x.word).sort(), ["location.get", "screen.tap", "x.test.install"]);
  assert.equal(all.capabilities.find((x: any) => x.word === "screen.tap").needs_approval, "per_call");
  for (const [member, name] of [["service:pulse", "pulse.due"], [PHONE, "x.test.owner_only"], ["service:vault", "set"], ["service:nope", undefined]] as const) {
    const res = await tools.call("capability_describe", name ? { member, word: name } : { member });
    assert.equal(res.isError, true, `${member}/${name}`);
    assert.equal(res.data.error.code, "not_found");
  }
});
