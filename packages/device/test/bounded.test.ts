import assert from "node:assert/strict";
import test from "node:test";
import { bounded } from "../src/link";

test("a step that hangs times out instead of holding up the next attempt; what arrives late is handed back", async () => {
  let resolveLate!: (value: string) => void;
  const late: string[] = [];
  const hung = new Promise<string>((resolve) => { resolveLate = resolve; });
  await assert.rejects(bounded(hung, 30, "gateway connection", (value) => late.push(value)), /timeout: gateway connection/);
  resolveLate("conn");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(late, ["conn"], "a connection that opens after the timeout is closed, not leaked");
  assert.equal(await bounded(Promise.resolve(7), 1000, "fast"), 7);
  await assert.rejects(bounded(Promise.reject(new Error("refused")), 1000, "x"), /refused/);
});
