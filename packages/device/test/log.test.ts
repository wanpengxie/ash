import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceLogger } from "../src/log";
test("device operational logs redact credentials and rotate to three bounded backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-device-log-")), log = deviceLogger(root, 180);
  for (let i = 0; i < 20; i++) log("token=hidden-value Bearer hidden-bearer", i);
  const files = await readdir(root); assert.equal(files.length, 4);
  for (const file of files) { const text = await readFile(join(root, file), "utf8"); assert.ok(!text.includes("hidden-")); assert.ok(text.includes("redacted")); assert.ok(Buffer.byteLength(text) <= 180); }
});
