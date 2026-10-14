import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { openVault } from "../../../src/kernel/vault";
import { createVaultService } from "../../../src/services/vault";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, call, code, ctxOf, fakeRouter, msg, owner } from "../support";

const SECRET = "sk-test-0123456789-very-secret";

function setup() {
  const { ledger, path } = openLedger();
  const vaultFile = join(dirname(path), "vault.json");
  const vault = openVault({ file: vaultFile, sealKey: randomBytes(32), now: () => 99 });
  const router = fakeRouter();
  const logs: string[] = [];
  const service = createVaultService({ vault, ledger, router, log: (m, e) => logs.push(`${m} ${e ?? ""}`) });
  return { ledger, path, vault, vaultFile, router, logs, service };
}

test("the words: the owner sets and deletes, an agent puts, generates and requests, both list, describe and connect", () => {
  const { service } = setup();
  const w = (name: string) => service.words().find((x) => x.word === name)!;
  assert.deepEqual(service.words().filter((x) => x.kind === "request").map((x) => x.word).sort(), ["connect", "delete", "describe", "generate", "list", "provider", "put", "request", "services", "set", "token"]);
  for (const name of ["set", "delete"]) assert.deepEqual(w(name).callers, ["owner"]);
  for (const name of ["put", "request"]) assert.deepEqual(w(name).callers, ["agent"]);
  for (const name of ["set", "put"]) assert.equal((w(name).input_schema.properties as any).value["x-ash-secret"], true);
});
test("set stores the original value, announces vault.changed with names only, and the secret is nowhere else", async () => {
  const s = setup();
  // What the router does: the ledger and the handler's message see the masked body, only ctx.raw has the value.
  const masked = { ref: "DEEPSEEK_API_KEY", value: { set: true, length: SECRET.length } };
  const raw = { ref: "DEEPSEEK_API_KEY", value: SECRET };
  s.ledger.append({ from: "person:owner", to: "service:vault", kind: "request", word: "set", body: masked });
  const result = await s.service.handle(msg("service:vault", "set", masked), ctxOf(owner, raw));
  assert.deepEqual((result as any).data, { ref: "DEEPSEEK_API_KEY", configured: true });
  await new Promise((r) => setImmediate(r));

  assert.equal(s.vault.use("DEEPSEEK_API_KEY"), SECRET);
  assert.equal(s.router.sent.length, 1);
  assert.deepEqual(s.router.sent[0]!.msg, { to: "service:agents", kind: "event", word: "vault.changed", body: { ref: "DEEPSEEK_API_KEY", action: "saved" } });
  assert.equal(s.router.sent[0]!.caller.member, "service:vault");

  // The plaintext is not in the event, the result, the logs, the ledger database (with its journal) or the vault file.
  assert.ok(!JSON.stringify([s.router.sent, result, s.logs]).includes(SECRET));
  const dbDir = dirname(s.path);
  for (const name of readdirSync(dbDir).filter((n) => n.startsWith("ash.db"))) assert.ok(!readFileSync(join(dbDir, name)).includes(SECRET), name);
  assert.ok(!readFileSync(s.vaultFile).includes(SECRET));
});

test("a placeholder instead of the value is refused, and never stored", async () => {
  const s = setup();
  const placeholder = { ref: "A", value: { set: true, length: 5 } };
  assert.equal(await code(s.service.handle(msg("service:vault", "set", placeholder), ctxOf(owner, placeholder))), "bad_request");
  assert.equal(await code(s.service.handle(msg("service:vault", "set", placeholder), ctxOf(owner, undefined))), "bad_request");
  assert.deepEqual(s.vault.list(), []);
  assert.equal(s.router.sent.length, 0);
});

test("list and describe show names, labels and whether set, never a value", async () => {
  const s = setup();
  await call(s.service, owner, "set", { ref: "CF_TOKEN", value: SECRET, label: "Cloudflare", kind: "key" });
  const list = await call(s.service, agent(), "list");
  const refs = list.entries.map((e: any) => e.ref);
  assert.ok(refs.includes("CF_TOKEN") && refs.includes("DEEPSEEK_API_KEY"));
  assert.deepEqual(list.entries.find((e: any) => e.ref === "CF_TOKEN"), { ref: "CF_TOKEN", label: "Cloudflare", kind: "key", configured: true, status: "ok", updated_at: 99 });
  assert.equal(list.entries.find((e: any) => e.ref === "DEEPSEEK_API_KEY").configured, false);
  assert.equal((await call(s.service, agent(), "describe", { ref: "CF_TOKEN" })).configured, true);
  assert.ok(!JSON.stringify(list).includes(SECRET));
});

test("delete removes the value and announces removed", async () => {
  const s = setup();
  await call(s.service, owner, "set", { ref: "X", value: SECRET });
  assert.deepEqual(await call(s.service, owner, "delete", { ref: "X" }), { deleted: true });
  assert.deepEqual(await call(s.service, owner, "delete", { ref: "X" }), { deleted: false });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.router.sent.map((x) => (x.msg.body as any).action), ["saved", "removed"]);
  assert.equal(s.vault.use("X"), null);
});
