import assert from "node:assert/strict";
import test from "node:test";
import { standardContracts } from "../src/namespaces";
import Ajv2020 from "ajv/dist/2020";
import { DELEGATION_RULE, SERVICE_NAMES, WORD_CONTRACTS, wordContract, wordsOf } from "../src/words";
import {
  CALLER_KINDS, DEFAULT_CALLERS, EFFECTS, LINT_RULES, RESERVED_INPUT_NAMES, RISKS, effectRiskProblem, lintWord, lintWords, mayCall, secret, sensitive, wordEffect,
  type LintRule, type WordContract,
} from "../src/word";

const ALL = [...WORD_CONTRACTS, ...standardContracts()];

// The name of the private project this was split from must not appear in public text; spelled out in pieces so this file itself is clean.
const FORBIDDEN_NAME = new RegExp(["at", "oll"].join(""), "i");

test("every word passes lint", () => {
  assert.deepEqual(lintWords(ALL), []);
  assert.ok(WORD_CONTRACTS.length > 150 && ALL.length > 250);
});

test("labels are the one present-continuous label; descriptions say when to use the word", () => {
  for (const word of ALL) {
    assert.match(word.label.doing, /^在/, `${word.member}/${word.word}`);
    assert.ok([...word.description].length >= 20, `${word.member}/${word.word}`);
  }
});

test("no contract names an agent or the old fixed members", () => {
  const text = JSON.stringify(ALL);
  for (const gone of ["agent:main", "agent:keeper", "device:phone", "screen:*", "service:self", "service:files", "service:work", "service:post", "worker:"]) assert.ok(!text.includes(gone), gone);
  assert.ok(!ALL.some((word) => word.member === "service:self" || word.member === "service:post" || word.member.startsWith("worker:")));
  assert.ok(!("agents" in ALL[0]!), "the contract has no agents field");
  assert.ok(!FORBIDDEN_NAME.test(text));
});

test("the services of SPEC-02 §4.1 are all there, and the removed ones are not", () => {
  for (const service of ["admin", "gate", "vault", "devices", "link", "agents", "apps", "clock", "llm", "persona", "widgets", "pulse", "cost", "reflex", "senses", "directory", "history", "blobs", "host", "bodies", "health", "cards"]) {
    assert.ok(SERVICE_NAMES.includes(`service:${service}`), service);
  }
  assert.equal(SERVICE_NAMES.length, 22);
  const has = (member: string, ...words: string[]) => words.forEach((word) => assert.ok(wordContract(member, word), `${member}/${word}`));
  has("service:gate", "rules.list", "rules.set", "rules.revoke", "mode.set", "audit", "history", "pending.list", "pending.get", "pending.redeem", "pending.skip", "pending.withdraw");
  has("service:vault", "list", "describe", "set", "delete", "put", "generate", "request", "services", "connect", "provider");
  has("service:devices", "list", "describe", "pair_start", "pair_status", "pair_pending", "pair_approve", "pair_reject", "revoke", "rename", "access_set", "update", "pair_code", "restore");
  has("service:link", "list", "describe", "diagnose", "disconnect", "reconnect", "refresh_manifest", "gateway.status", "gateway.use", "connected", "disconnected", "handshake_failed");
  has("service:agents", "list", "runtimes", "threads", "thread.stop", "describe", "ask", "tell", "answer", "declare", "update", "start", "stop", "restart", "remove", "configure", "plugins", "spawn", "primary.set",
    "session.get", "session.set", "session.new", "session.reload", "session.compact", "session.send", "session.followup", "session.steer", "session.inject", "session.interrupt", "session.restart");
  has("service:bodies", "list", "describe", "bind", "unbind");
  has("service:history", "query", "read", "turn", "activity");
  has("service:blobs", "read", "get");
  has("service:host", "wake.at", "wake.clear", "power.hold", "power.release", "hands.handoff", "update.install");
  has("service:cost", "usage.get", "balance.get", "quota.check");
  has("service:health", "status", "recent");
  has("service:persona", "get", "propose");
  has("service:directory", "list", "describe");
  has("service:apps", "apps.surface", "apps.icon", "apps.install", "apps.validate");
  assert.equal(wordContract("service:apps", "surface"), undefined);
  assert.equal(wordContract("service:apps", "icon"), undefined);
  has("service:llm", "complete");
  has("service:admin", "pause", "resume", "settings.get", "settings.set", "model.set", "plugins.list", "plugins.op", "status", "logs");
  has("person:owner", "say", "react", "show", "ask", "open");
  has("agent:main", "say", "tell", "ask", "wake");
  has("agent:w-3f9a1c", "wake");
  assert.equal(wordContract("service:post", "deliver"), undefined);
  assert.equal(wordContract("service:widgets", "widget.bind")?.kind, "event");
});

test("the events SPEC-02 names exist, and the ones that go in the ledger are marked", () => {
  const events = WORD_CONTRACTS.filter((word) => word.kind === "event");
  for (const [member, word] of [["agent:main", "typing"], ["service:widgets", "widget.rendered"], ["service:vault", "vault.changed"]]) assert.equal(wordContract(member!, word!)?.kind, "event", `${member}/${word}`);
  const recorded = events.filter((word) => word.record).map((word) => `${word.member}/${word.word}`).sort();
  assert.deepEqual(recorded, [
    "agent:*/agent.tool", "agent:*/turn.ended", "agent:*/turn.started", "service:admin/settings.changed",
    "service:devices/device.changed", "service:devices/pair.changed", "service:link/connected", "service:link/disconnected", "service:link/gateway.changed",
  ]);
  for (const word of events) assert.deepEqual([word.effect, word.risk], ["read", "none"]);
  assert.ok(!WORD_CONTRACTS.some((word) => word.kind === "event" && /^sense\./.test(word.word) && word.record), "sense.* is not recorded");
});

test("wake, say and the kernel-only words have the callers the spec gives", () => {
  const wake = wordContract("agent:main", "wake")!;
  assert.deepEqual([wake.effect, wake.risk], ["act", "none"]);
  assert.deepEqual(wake.callers, ["agent", "app"]);
  assert.deepEqual(wordContract("service:vault", "set")?.callers, ["owner"]);
  assert.deepEqual(wordContract("service:devices", "pair_code")?.callers, ["owner", "agent"], "agent first: the agent can hand the owner the pairing address");
  assert.deepEqual(wordContract("service:pulse", "pulse.due")?.callers, ["kernel"]);
  assert.deepEqual(wordContract("service:cost", "quota.check")?.callers, ["kernel"]);
  assert.deepEqual(wordContract("service:gate", "rules.set")?.callers, ["owner", "agent"]);
  assert.deepEqual(wordContract("service:gate", "pending.redeem")?.callers, ["agent"]);
  assert.equal(wordContract("service:llm", "complete")?.effect, "read");
  assert.equal(wordContract("service:llm", "complete")?.risk, "none");
  assert.deepEqual(wordContract("device:x", "sense.configure"), undefined);
  assert.equal(standardContracts().find((word) => word.word === "sense.configure")?.risk, "none");
  for (const word of standardContracts().filter((item) => item.word.startsWith("decision."))) assert.deepEqual(word.callers, ["kernel"]);
});

test("secrets and masks sit where SPEC-01 §10.0 says", () => {
  const set = wordContract("service:vault", "set")!;
  assert.equal(set.input_schema.properties.value["x-ash-secret"], true);
  assert.ok(!JSON.stringify(set.result_schema).includes("x-ash-secret"));
  for (const word of wordsOf("service:vault")) assert.ok(!/value/.test(JSON.stringify(word.result_schema ?? {})) || word.word === "set" || word.word === "token", word.word);
  // token hands a value to an app only: an app's read is never recorded.
  const token = wordContract("service:vault", "token")!;
  assert.deepEqual([token.callers, token.effect], [["app"], "read"]);
});

test("effect and risk: the one set of values and the two constraints", () => {
  assert.deepEqual([...EFFECTS], ["read", "write", "act", "execute"]);
  assert.deepEqual([...RISKS], ["none", "outward", "structure"]);
  for (const effect of EFFECTS) for (const risk of RISKS) {
    const problem = effectRiskProblem(effect, risk);
    const legal = effect === "read" ? risk === "none" : effect === "execute" ? risk === "structure" : true;
    assert.equal(problem === null, legal, `${effect}/${risk}`);
  }
  assert.ok(effectRiskProblem("send", "none") && effectRiskProblem("read", "bogus"));
  // wordEffect: the declared effect, or one derived from the risk; a lying "read" is treated by its risk
  assert.equal(wordEffect({ effect: "execute", risk: "structure" }), "execute");
  assert.equal(wordEffect({ effect: "act", risk: "none" }), "act");
  assert.equal(wordEffect({ risk: "none" }), "read");
  assert.equal(wordEffect({ risk: "outward" }), "act");
  assert.equal(wordEffect({ risk: "structure" }), "write");
  assert.equal(wordEffect({ effect: "send", risk: "outward" }), "act");
  assert.equal(wordEffect({ effect: "read", risk: "outward" }), "act");
  assert.equal(wordEffect({ effect: "read", risk: "structure" }), "write");
  assert.equal(wordEffect({}), "read");
  for (const word of ALL) assert.equal(wordEffect(word), word.effect, `${word.member}/${word.word}`);
});

// ---- one deliberate violation per lint rule ------------------------------------------------------------------------

const GOOD: WordContract = {
  member: "service:test", word: "ping.now", kind: "request", direction: "in",
  description: "Ping the thing and report how long it took, in milliseconds.",
  input_schema: { type: "object", properties: { count: { type: "integer" } }, additionalProperties: false },
  result_schema: { type: "object", properties: { ms: { type: "number" } } },
  effect: "act", risk: "none", callers: ["owner", "agent"], label: { doing: "在测延迟" },
};
const EVENT: WordContract = { ...GOOD, word: "ping.done", kind: "event", direction: "out", effect: "read", risk: "none", callers: ["kernel"] };
const bad = (patch: Record<string, unknown>, base: WordContract = GOOD): WordContract => ({ ...base, ...patch }) as WordContract;

const VIOLATIONS: Record<LintRule, [string, WordContract][]> = {
  "member": [["not an id", bad({ member: "Service:test" })], ["unknown kind", bad({ member: "worker:extract" })], ["a client is not a member", bad({ member: "client:abc" })]],
  "word-name": [["upper case", bad({ word: "Ping" })], ["empty", bad({ word: "" })], ["trailing dot", bad({ word: "ping." })]],
  "description": [["missing", bad({ description: undefined })], ["too short", bad({ description: "Ping it." })], ["blank", bad({ description: " ".repeat(40) })]],
  "label": [["missing", bad({ label: undefined })], ["empty doing", bad({ label: { doing: "" } })], ["a plain string", bad({ label: "在测延迟" })], ["extra key", bad({ label: { doing: "在测延迟", done: "x" } })]],
  "input-schema": [["missing", bad({ input_schema: undefined })], ["not an object schema", bad({ input_schema: { type: "string" } })], ["does not compile", bad({ input_schema: { type: "object", properties: { a: { type: "nope" } } } })]],
  "result-schema": [["not a schema", bad({ result_schema: "x" })], ["does not compile", bad({ result_schema: { type: "bogus" } })]],
  "effect-risk": [["read with risk", bad({ effect: "read", risk: "outward" })], ["execute without structure", bad({ effect: "execute", risk: "none" })], ["old effect value", bad({ effect: "send" })], ["old effect structure", bad({ effect: "structure" })], ["unknown risk", bad({ risk: "high" })]],
  "event-shape": [["event with an effect", bad({ effect: "act" }, EVENT)], ["event with risk", bad({ effect: "read", risk: "outward" }, EVENT)], ["event with foreground", bad({ foreground: true }, EVENT)]],
  "callers": [["missing", bad({ callers: undefined })], ["empty", bad({ callers: [] })], ["unknown caller", bad({ callers: ["owner", "robot"] })], ["repeated", bad({ callers: ["owner", "owner"] })], ["kernel next to another kind", bad({ callers: ["agent", "kernel"] })], ["kernel after owner", bad({ callers: ["owner", "kernel"] })], ["the old audience field is not callers", bad({ callers: "all" })]],
  "local-only": [["without owner", bad({ local_only: true, callers: ["agent"] })], ["false is not a value", bad({ local_only: false })]],
  "record": [["on a request", bad({ record: true })], ["false is not a value", bad({ record: false }, EVENT)]],
  "timeout": [["zero", bad({ timeout_ms: 0 })], ["fraction", bad({ timeout_ms: 1.5 })], ["string", bad({ timeout_ms: "5" })]],
  "reserved-name": RESERVED_INPUT_NAMES.map((name): [string, WordContract] => [name, bad({ input_schema: { type: "object", properties: { [name]: { type: "string" } } } })]),
  "secret": [["result secret that is not true", bad({ result_schema: { type: "object", properties: { key: { type: "string", "x-ash-secret": false } } } })], ["secret that is not true", bad({ input_schema: { type: "object", properties: { key: { type: "string", "x-ash-secret": "yes" } } } })]],
  "sensitive": [["sensitive on an input", bad({ input_schema: { type: "object", properties: { ip: sensitive({ type: "string" }, "ip") } } })], ["unknown mask", bad({ result_schema: { type: "object", properties: { ip: { type: "string", "x-ash-sensitive": { mask: "stars" } } } } })]],
};

test("the good example and the event example pass", () => {
  assert.deepEqual(lintWord(GOOD), []);
  assert.deepEqual(lintWord(EVENT), []);
  assert.deepEqual(lintWord(bad({ callers: [...DEFAULT_CALLERS] })), []);
  assert.deepEqual(lintWord(bad({ local_only: true, record: undefined })), []);
  assert.deepEqual(lintWord(bad({ effect: "write", risk: "structure", per_call_risk: true })), []);
  assert.deepEqual(lintWord(bad({ input_schema: { type: "object", properties: { key: secret({ type: "string" }) } }, result_schema: { type: "object", properties: { ip: sensitive({ type: "string" }, "ip") } } })), []);
  assert.deepEqual(lintWord(bad({ result_schema: { type: "object", properties: { command: secret({ type: "string" }) } } })), []);
  assert.deepEqual(lintWord(bad({ member: "agent:*" })), []);
  assert.deepEqual(lintWord(bad({ member: "device:*", word: "x.kimi.browser.upload" })), []);
  assert.deepEqual([...CALLER_KINDS], ["owner", "agent", "app", "kernel"]);
});

test("every lint rule rejects its deliberate violation", () => {
  assert.deepEqual(Object.keys(VIOLATIONS).sort(), [...LINT_RULES].sort(), "a rule has no counter-example");
  for (const [rule, cases] of Object.entries(VIOLATIONS)) {
    assert.ok(cases.length > 0, rule);
    for (const [what, contract] of cases) {
      const issues = lintWord(contract);
      assert.ok(issues.some((issue) => issue.rule === rule), `${rule}: ${what} should be rejected by that rule, got ${JSON.stringify(issues.map((issue) => issue.rule))}`);
    }
  }
});

test("a word defined twice is rejected, and so is a nested reserved name only when it is a top-level field", () => {
  assert.ok(lintWords([GOOD, GOOD]).some((issue) => /twice/.test(issue.message)));
  const nested = bad({ input_schema: { type: "object", properties: { card: { type: "object", properties: { purpose: { type: "string" } } } } } });
  assert.deepEqual(lintWord(nested), []);
  const viaAnyOf = bad({ input_schema: { type: "object", anyOf: [{ required: ["wait"], properties: { wait: { type: "boolean" } } }] } });
  assert.ok(lintWord(viaAnyOf).some((issue) => issue.rule === "reserved-name"));
});

test("the lint also covers a hand-written contract with the old fields", () => {
  const old = { ...GOOD, audience: "owner", label: "看提醒" } as unknown as WordContract;
  assert.ok(lintWord(old).some((issue) => issue.rule === "label"));
});

// ---- decisions of the review -------------------------------------------------------------------------------------------

test("the kernel passes the first layer for every word; ['kernel'] is for the kernel alone", () => {
  assert.equal(mayCall(["owner"], "kernel"), true);
  assert.equal(mayCall(["agent", "app"], "kernel"), true);
  assert.equal(mayCall(["kernel"], "kernel"), true);
  for (const who of ["owner", "agent", "app"] as const) {
    assert.equal(mayCall(["kernel"], who), false, who);
    assert.equal(mayCall(["owner"], who), who === "owner", who);
    assert.equal(mayCall([...DEFAULT_CALLERS], who), true, who);
  }
  // so `kernel` only ever stands alone: no word lists it next to another kind
  assert.ok(ALL.every((item) => !item.callers.includes("kernel") || item.callers.length === 1));
  // and every word that is for the kernel alone says exactly ["kernel"]
  for (const word of ALL.filter((item) => item.callers.includes("kernel") && item.callers.length === 1)) {
    for (const who of ["owner", "agent", "app"] as const) assert.equal(mayCall(word.callers, who), false, `${word.member}/${word.word}`);
  }
});

test("pause and resume: the owner's and an agent's alike (the kernel's reflex may call pause too)", () => {
  const pause = wordContract("service:admin", "pause")!;
  const resume = wordContract("service:admin", "resume")!;
  assert.deepEqual(pause.callers, ["owner", "agent"]);
  assert.deepEqual(pause.callers, resume.callers);
  assert.equal(mayCall(pause.callers, "kernel"), true);
});

test("pulse has no guidance field any more", () => {
  for (const word of wordsOf("service:pulse")) {
    assert.ok(!/guidance/i.test(JSON.stringify(word)), word.word);
  }
  assert.ok(!JSON.stringify(wordContract("service:pulse", "pulse.set")!.input_schema).includes("guidance"));
  assert.ok(!(wordContract("service:pulse", "pulse.get")!.result_schema!.required as string[]).includes("guidance"));
  assert.ok(!JSON.stringify(wordsOf("service:pulse")).includes("review"));
});

test("person:owner/ask: only title is required, a question needs options, human_ask and human_confirm are its aliases", () => {
  const ask = wordContract("person:owner", "ask")!;
  const validate = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(ask.input_schema);
  assert.deepEqual(ask.input_schema.required, ["title"]);
  assert.ok(validate({ title: "Send it?", options: [{ id: "yes", label: "Yes" }] }));
  assert.ok(validate({ title: "Sure?", human_kind: "confirmation" }));
  assert.ok(!validate({ title: "Which one?" }), "a question has options");
  assert.ok(!validate({ title: "Which one?", human_kind: "question" }));
  assert.ok(!validate({ options: [{ id: "a", label: "A" }] }), "no title");
  assert.ok(validate({ title: "t", detail: "d", options: [{ id: "a", label: "A" }], expires_at: 1, source: { word: "w", to: "device:x", body_preview: "b" } }));
  assert.match(ask.description, /human_ask and human_confirm/);
  assert.deepEqual(ask.callers, ["agent"]);
  const say = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(wordContract("person:owner", "say")!.input_schema);
  assert.ok(say({ text: "hi" }) && say({ text: "hi", kind: "heads_up" }) && !say({ text: "hi", kind: "other" }) && !say({ kind: "reply" }));
});

test("an option reply is both fields or neither, in the schema", () => {
  const say = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(wordContract("agent:main", "say")!.input_schema);
  assert.ok(say({ text: "a" }) && say({ text: "a", in_reply_to: "m1", option_id: "yes" }));
  assert.ok(!say({ text: "a", in_reply_to: "m1" }) && !say({ text: "a", option_id: "yes" }));
});

test("declare, update and spawn share one delegation rule", () => {
  assert.match(DELEGATION_RULE, /subset/);
  assert.match(DELEGATION_RULE, /forbidden/);
  for (const word of ["declare", "update", "spawn"]) {
    const contract = wordContract("service:agents", word)!;
    assert.ok(contract.description.includes(DELEGATION_RULE), word);
    assert.equal(contract.risk, "none", word);
  }
  assert.deepEqual([wordContract("service:agents", "declare")!.effect, wordContract("service:agents", "update")!.effect], ["write", "write"]);
});

test("the host events and the usage event take the shapes their producers have", () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  for (const member of ["service:link", "service:agents"]) {
    const check = ajv.compile(wordContract(member, "env.changed")!.input_schema);
    assert.ok(check({ what: "network", network: { proxy: null }, online: true }));
    assert.ok(check({ what: "network", network: { proxy: { http: "http://h:1", no_proxy: "x" } }, online: false }));
    assert.ok(check({ what: "power", saver: true }));
    assert.ok(!check({ what: "power" }) && !check({ what: "network", online: true }) && !check({ what: "other" }));
  }
  const usage = ajv.compile(wordContract("service:cost", "usage.recorded")!.input_schema);
  assert.ok(usage({ caller: "service:gate", provider: "deepseek", model: "m", input_tokens: 1, output_tokens: 2, ok: true, at: 5 }));
  assert.ok(usage({ caller: "agent:x", provider: "openrouter", model: "m", input_tokens: 1, output_tokens: 2, cost: 0.01, ok: false, at: 5 }));
  assert.ok(usage({ caller: "a", provider: "other", model: "m", input_tokens: 1, output_tokens: 2, ok: true, at: 5 }) && !usage({ caller: "a", provider: "", model: "m", input_tokens: 1, output_tokens: 2, ok: true, at: 5 }) && !usage({ caller: "a", provider: "deepseek", model: "m", ok: true, at: 5 }));
});

test("the one checkpoint is the narrow waist: what the owner can call, an agent can too; nothing is local-only or masked from it", () => {
  // The only words an agent may not call: the owner's own voice (what he says, taps, answers) and his typing a secret's value.
  const OWNERS_OWN = new Set(["agent:*/say", "service:widgets/widget.tap", "service:vault/set"]);
  const shut = ALL.filter((w) => w.callers.includes("owner") && !w.callers.includes("agent")).map((w) => `${w.member}/${w.word}`);
  assert.deepEqual(shut.filter((k) => !OWNERS_OWN.has(k)), [], "an owner-only word: open it to agents (approval happens at the gate, not here)");
  assert.deepEqual(ALL.filter((w) => w.local_only).map((w) => `${w.member}/${w.word}`), [], "no word is local-only");
  assert.deepEqual(ALL.filter((w) => JSON.stringify(w.result_schema ?? {}).includes("x-ash-sensitive")).map((w) => `${w.member}/${w.word}`), [], "no result is masked from an agent; only secret values are kept from it");
});
