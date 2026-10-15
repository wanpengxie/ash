import assert from "node:assert/strict";
import test from "node:test";
import { WordError } from "../../../../sdk/src/message";
import { bodySecrets, refsIn, resolveRefs, Scrubber } from "../../../src/kernel/vault/refs";

const SECRET = "p@ss word/+=Zz9";

test("refsIn finds the vault names of an environment; resolveRefs puts the values in and unescapes $$vault", async () => {
  assert.deepEqual(refsIn({ A: "$vault.KEY", B: "plain", C: "$vault.KEY", D: "$$vault.X", E: "x $vault.Y" }), ["KEY"]);
  const out = await resolveRefs({ A: "$vault.KEY", B: "plain", D: "$$vault.X" }, async (name) => `${name}-value`);
  assert.deepEqual(out, { env: { A: "KEY-value", B: "plain", D: "$vault.X" }, values: ["KEY-value"] });
  await assert.rejects(resolveRefs({ A: "$vault.NO" }, async () => { throw new WordError("not_found", "no"); }), (e: WordError) => e.code === "not_found");
});

test("the scrubber masks a value and its base64 and URL-encoded forms at any depth, and ignores very short values", () => {
  const s = new Scrubber();
  s.add(SECRET);
  s.add("abc");
  const b64 = Buffer.from(SECRET).toString("base64");
  const out = s.scrub({ output: `pw=${SECRET}\n${b64}\n${encodeURIComponent(SECRET)}`, list: [SECRET, "abc"], n: 1 });
  assert.deepEqual(out, { output: "pw=***\n***\n***", list: ["***", "abc"], n: 1 });
});

test("bodySecrets: only a command on a body; a missing name is refused before anything runs; replies from bodies are masked", async () => {
  const secrets = bodySecrets(async () => SECRET, (name) => (name === "KEY" ? "ok" : name === "OLD" ? "broken" : "missing"));
  const bash = (to: string, env: Record<string, string>) => ({ to, word: "workspace.bash", body: { command: "x", env } });
  assert.equal(secrets.check(bash("body:main", { A: "$vault.KEY" })), null);
  assert.equal(secrets.check(bash("body:main", { A: "$vault.NOPE" }))?.code, "not_found");
  assert.equal(secrets.check(bash("body:main", { A: "$vault.OLD" }))?.code, "unavailable");
  assert.equal(secrets.check(bash("device:x", { A: "$vault.NOPE" })), null, "only bodies take a command's environment");
  assert.equal(await secrets.inject({ to: "device:x", word: "workspace.bash" }, { env: { A: "$vault.KEY" } }), null);
  assert.deepEqual(await secrets.inject({ to: "body:main", word: "workspace.bash" }, { command: "x", env: { A: "$vault.KEY", B: "b" } }), { command: "x", env: { A: SECRET, B: "b" } });
  assert.deepEqual(secrets.scrub("body:main", { ok: true, result: { data: { output: SECRET } } }), { ok: true, result: { data: { output: "***" } } });
  assert.deepEqual(secrets.scrub("service:x", { output: SECRET }), { output: SECRET }, "only what bodies answer");
});
