import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VaultStore, VaultUnavailableError } from "../../src/members/vault";

test("with a seal key the vault file never holds a value in the clear, and reopens with the same key", () => {
  const file = join(mkdtempSync(join(tmpdir(), "vault-seal-")), "vault.json");
  const key = randomBytes(32);
  new VaultStore(file, Date.now, key).set("DEEPSEEK_API_KEY", "sk-sealed-value-123");
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("sk-sealed-value-123"));
  assert.equal(JSON.parse(raw).sealed, 1);
  assert.equal(new VaultStore(file, Date.now, key).get("DEEPSEEK_API_KEY"), "sk-sealed-value-123");
  assert.throws(() => new VaultStore(file, Date.now, randomBytes(32)), /unreadable/);
  assert.throws(() => new VaultStore(file), /unreadable/);
});

test("a plain vault from before is sealed on first open with a key", () => {
  const file = join(mkdtempSync(join(tmpdir(), "vault-seal-")), "vault.json");
  writeFileSync(file, JSON.stringify({ version: 1, entries: { OPENROUTER_API_KEY: { value: "sk-or-old", label: "x", kind: "model", updated_at: 1 } } }));
  const key = randomBytes(32);
  assert.equal(new VaultStore(file, Date.now, key).get("OPENROUTER_API_KEY"), "sk-or-old");
  assert.ok(!readFileSync(file, "utf8").includes("sk-or-old"));
  assert.equal(new VaultStore(file, Date.now, key).get("OPENROUTER_API_KEY"), "sk-or-old");
});

test("the Android secure path leaves the vault untouched and rejects changes when no seal key is available", () => {
  const file = join(mkdtempSync(join(tmpdir(), "vault-seal-")), "vault.json");
  const raw = JSON.stringify({ version: 1, entries: { DEEPSEEK_API_KEY: { value: "sk-existing", label: "x", kind: "model", updated_at: 1 } } });
  writeFileSync(file, raw);
  const vault = VaultStore.secure(file);
  assert.deepEqual(vault.availability(), { available: false });
  assert.equal(vault.get("DEEPSEEK_API_KEY"), null);
  assert.equal(vault.describe("DEEPSEEK_API_KEY").configured, false);
  assert.throws(() => vault.set("DEEPSEEK_API_KEY", "sk-new"), VaultUnavailableError);
  assert.throws(() => vault.remove("DEEPSEEK_API_KEY"), VaultUnavailableError);
  assert.equal(readFileSync(file, "utf8"), raw);
});

test("the Android secure path does not rename or replace a sealed vault that cannot be opened", () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-seal-"));
  const file = join(dir, "vault.json");
  const key = randomBytes(32);
  new VaultStore(file, Date.now, key).set("OPENROUTER_API_KEY", "sk-existing");
  const raw = readFileSync(file, "utf8");
  const vault = VaultStore.secure(file, Date.now, randomBytes(32));
  assert.deepEqual(vault.availability(), { available: false });
  assert.equal(readFileSync(file, "utf8"), raw);
  assert.throws(() => vault.set("OPENROUTER_API_KEY", "sk-new"), VaultUnavailableError);
});
