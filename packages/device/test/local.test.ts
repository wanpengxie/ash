import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callLocal, serveLocal } from "../src/local";

const sock = async () => join(await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-sock-")), "mcp.sock");

test("a call goes in as one line and comes back as one; the socket is for its owner only; closing removes it", async () => {
  const path = await sock();
  const seen: any[] = [];
  const door = await serveLocal(path, async (tool, args, session) => { seen.push({ tool, args, session }); if (tool === "boom") throw new Error("the hub said no"); return { echoed: args }; });
  assert.equal(((await stat(path)).mode & 0o777), 0o600);
  assert.deepEqual(await callLocal(path, "capability_list", { member: "x" }, "S1"), { echoed: { member: "x" } });
  assert.deepEqual(seen, [{ tool: "capability_list", args: { member: "x" }, session: "S1" }]);
  await assert.rejects(callLocal(path, "boom", {}, undefined), /the hub said no/);
  door.close();
  await assert.rejects(callLocal(path, "capability_list", {}, undefined), /ash-device is not running/);
});

test("a socket file nobody listens on is replaced; one that answers is another ash-device and is left alone", async () => {
  const path = await sock();
  await writeFile(path, "");
  const first = await serveLocal(path, async () => "one");
  await assert.rejects(serveLocal(path, async () => "two"), /already serving/);
  assert.equal(await callLocal(path, "x", {}, undefined), "one");
  first.close();
});

test("a call that is slower than the wait gives up with a message", async () => {
  const path = await sock();
  const door = await serveLocal(path, () => new Promise(() => {}));
  await assert.rejects(callLocal(path, "x", {}, undefined, 80), /did not answer in time/);
  door.close();
});
