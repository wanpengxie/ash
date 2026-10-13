import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchControlAuthorization } from "../src/collaboration/control-watch";
test("parent-directory watch survives atomic replace and invalidates equal bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-control-watch-")), path = join(dir, "grant.json"); writeFileSync(path, "same");
  let count = 0, wake: (() => void) | undefined;
  const close = watchControlAuthorization([path], () => { count++; wake?.(); });
  const replace = async () => { const event = new Promise<void>((resolve, reject) => { wake = resolve; const timer = setTimeout(() => reject(new Error("watch timeout")), 1000); timer.unref(); }); writeFileSync(join(dir, "tmp"), "same"); renameSync(join(dir, "tmp"), path); await event; wake = undefined; };
  try { await replace(); const before = count; await replace(); assert.ok(count > before); close(); const after = count; writeFileSync(path, "changed"); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(count, after); } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});
test("watch construction failure invalidates and gives fixed error", () => { let events = 0; assert.throws(() => watchControlAuthorization(["/nonexistent/ash-test/grant"], () => events++), /Control authorization watcher unavailable/); assert.equal(events, 1); });
