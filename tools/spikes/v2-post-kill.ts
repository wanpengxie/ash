// Synthetic-only crash probe: a host attempt is durable before a non-cooperative /present.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../../packages/core/src/world/ledger";
import { WorldRouter, type TrustedRouteContext } from "../../packages/core/src/world/router";
import { WorldMembers } from "../../packages/core/src/world/member";
import { OwnerMember } from "../../packages/core/src/members/owner";
import { PostMember } from "../../packages/core/src/members/post-delivery";

const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const file = process.argv[3];
const emptyScreen = { markVisible: () => {}, list: () => [], visible: () => false };
async function build(dbFile: string, present: () => Promise<void>) {
  const ledger = await Ledger.open(dbFile);
  const router = new WorldRouter(ledger, async (_message, caller) => caller.member === "service:post" && caller.transportPrincipal === "service:post");
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  const post = new PostMember({ ledger, router, screens: emptyScreen, delivery: { quiet: "21:30-09:00", dedupe_minutes: 60 },
    host: { present, hidePresentation: async () => {} } });
  members.register(post);
  post.prepareRecovery();
  await router.recover();
  await post.start();
  return { ledger, router, post };
}
if (process.argv[2] === "child") {
  const running = await build(file, () => new Promise<void>(() => { process.stdout.write("HOST_ENTERED\n"); }));
  await running.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { kind: "due", text: "synthetic crash notification" }, wait: true });
  await new Promise<void>(() => {});
} else {
  const dir = mkdtempSync(join(tmpdir(), "ash-post-kill-"));
  const dbFile = join(dir, "world.db");
  try {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "child", dbFile],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const entered = new Promise<void>((resolve, reject) => {
      let text = "";
      child.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); if (text.includes("HOST_ENTERED\n")) resolve(); });
      child.once("exit", () => reject(new Error("child exited before host attempt")));
    });
    let timeout: ReturnType<typeof setTimeout>;
    try { await Promise.race([entered, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("host attempt barrier timed out")), 10_000); })]); }
    finally { clearTimeout(timeout!); }
    child.kill("SIGKILL");
    await once(child, "exit");
    let extraPresent = 0;
    const running = await build(dbFile, async () => { extraPresent++; });
    try {
      const request = running.ledger.list({ limit: 1000 }).find((item) => item.kind === "request" && item.to === "service:post" && item.word === "deliver");
      assert.ok(request);
      for (let i = 0; i < 30 && !running.ledger.responseTo(request.id); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(running.ledger.responseTo(request.id)?.body.ok, false);
      assert.equal(running.post.journal.record(String(request.body.message_id))?.state, "unknown");
      assert.equal(extraPresent, 0, "uncertain external presentation must not replay");
      assert.equal(running.ledger.list({ limit: 1000 }).filter((item) => item.kind === "request" && item.to === "service:post" && item.word === "deliver").length, 1);
      process.stdout.write("post SIGKILL unknown recovery: PASS\n");
    } finally { await running.post.close(); running.ledger.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
