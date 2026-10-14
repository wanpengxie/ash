import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ERROR_CODES } from "../../../../sdk/src/message";
import { RESERVED_INPUT_NAMES, mayCall } from "../../../../sdk/src/word";
import { WORD_CONTRACTS, wordContract } from "../../../../sdk/src/words";
import { FIXED_TOOLS, TOOL_NAMES, fixedTool, toolDefinitions, toolWords } from "../../../src/edges/tools";

const definition = (name: string) => toolDefinitions().find((d) => d.name === name)!;
/** A tool's schema without the call-envelope properties: what the word itself takes. */
const withoutEnvelope = (schema: any) => {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([name]) => !RESERVED_INPUT_NAMES.includes(name)));
  return { ...schema, properties };
};

test("every fixed tool is one word: its input schema is the word's input_schema, less the envelope fields", () => {
  assert.ok(FIXED_TOOLS.length >= 40);
  for (const tool of FIXED_TOOLS) {
    const contract = wordContract(tool.member, tool.word);
    assert.ok(contract, `${tool.name} -> ${tool.member}/${tool.word} exists in sdk/words.ts`);
    assert.ok(mayCall(contract.callers, "agent"), `${tool.name}: an agent may call ${tool.member}/${tool.word}`);
    assert.equal(contract.kind, "request");
    assert.deepEqual(withoutEnvelope(definition(tool.name).inputSchema), withoutEnvelope(contract.input_schema), tool.name);
    // No word of the contract uses the envelope names, so a tool without them takes the word's schema as it is.
    if (!tool.approval && !tool.wait) assert.equal(definition(tool.name).inputSchema, contract.input_schema, `${tool.name} is the schema itself`);
  }
});

test("the envelope fields are only on the tools that may ask the owner (and wait only on capability_call and agent_ask)", () => {
  const withApproval = toolDefinitions().filter((d) => "approval_ttl_minutes" in (d.inputSchema.properties ?? {})).map((d) => d.name).sort();
  const expected = ["capability_call", "approval_rule_add", "approval_rule_remove", "approval_mode_set", "human_ask", "human_confirm",
    ...WORD_CONTRACTS.filter((c) => c.member === "service:devices" && c.kind === "request" && mayCall(c.callers, "agent")).map((c) => `device_${c.word.replaceAll(".", "_")}`)].sort();
  assert.deepEqual(withApproval, expected);
  assert.deepEqual(toolDefinitions().filter((d) => "wait" in (d.inputSchema.properties ?? {})).map((d) => d.name).sort(), ["agent_ask", "capability_call"]);
  for (const d of toolDefinitions()) assert.equal(d.inputSchema.type, "object", d.name);
});

test("human_ask and human_confirm are person:owner/ask under two names, with exactly its input schema", () => {
  const ask = wordContract("person:owner", "ask")!;
  for (const name of ["human_ask", "human_confirm"]) {
    assert.equal(fixedTool(name)!.member, "person:owner");
    assert.equal(fixedTool(name)!.word, "ask");
    assert.deepEqual(withoutEnvelope(definition(name).inputSchema), withoutEnvelope(ask.input_schema));
  }
  assert.deepEqual(definition("human_ask").inputSchema, definition("human_confirm").inputSchema);
});

test("the names the spec lists are all there, once each, and TOOL_NAMES is the whole list", () => {
  const spec = ["human_say", "human_show", "human_ask", "human_confirm", "human_pending", "human_pending_get", "human_pending_redeem", "human_pending_skip", "human_withdraw",
    "timer_set", "timer_list", "timer_cancel", "approval_log", "approval_rules", "approval_rule_add", "approval_rule_remove", "approval_mode_set",
    "agent_list", "agent_runtimes", "agent_describe", "agent_tell", "agent_ask", "agent_create", "agent_update", "agent_start", "agent_stop", "agent_restart", "agent_remove",
    "vault_list", "vault_describe", "history_query", "system_status", "capability_list", "capability_describe", "capability_call", "await_result", "list_pending", "cancel"];
  for (const name of spec) assert.ok(TOOL_NAMES.includes(name), name);
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  assert.deepEqual(toolDefinitions().map((d) => d.name), [...TOOL_NAMES]);
  assert.equal(TOOL_NAMES.includes("human_notify"), false, "human_notify is gone");
});

test("device_* tools are made from the words of service:devices an agent may call, and only those", () => {
  const names = TOOL_NAMES.filter((n) => n.startsWith("device_"));
  assert.ok(names.includes("device_pair_start") && names.includes("device_access_set") && names.includes("device_list"));
  assert.equal(names.includes("device_pair_code"), true, "an agent reads the code of a pairing it started");
  assert.equal(names.includes("device_restore"), true, "an agent restores a device the way the owner does");
});

test("toolWords: a fixed tool stands for its word, a pattern for all matching tools, meta and receipt tools for none", () => {
  assert.deepEqual(toolWords("timer_set"), ["service:clock/set"]);
  assert.deepEqual(toolWords("human_confirm"), ["person:owner/ask"]);
  assert.ok(toolWords("device_*").every((p) => p.startsWith("service:devices/")) && toolWords("device_*").length > 5);
  for (const name of ["capability_call", "capability_list", "await_result", "cancel", "nonsense"]) assert.deepEqual(toolWords(name), []);
});

test("only the unified error codes appear in the tool surface's source: no old code is left", () => {
  const old = ["payload" + "_invalid", "unreach" + "able", "capability" + "_error", "internal" + "_error", "vault" + "_unavailable", "bad" + "_json"];
  const dir = join(import.meta.dirname, "../../../src/edges/tools");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const code of old) assert.equal(source.includes(code), false, `${file} mentions ${code}`);
  }
  assert.equal(ERROR_CODES.length, 14);
});
