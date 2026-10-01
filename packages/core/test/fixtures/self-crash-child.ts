import { join } from "node:path";
import { readdirSync } from "node:fs";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter } from "../../src/world/router";
import { WorldMembers } from "../../src/world/member";
import { createSelfMember, type SelfStage } from "../../src/members/self";
import { createHash } from "node:crypto";

const [dir, stage, mode = "write"] = process.argv.slice(2);
if (!dir || !stage) throw new Error("self-crash-child requires directory and failpoint");
const ledger = await Ledger.open(join(dir, "ash.db"));
const world = new WorldRouter(ledger, async () => true);
if (mode === "rollback") world.setGate(async () => ({ allow: true, by: "answer" }));
const members = new WorldMembers(world);
const self = createSelfMember({ home: join(dir, "home"), stateDir: join(dir, "self"), ledger, router: world,
  failpoint: (at: SelfStage) => { if (at === stage) process.kill(process.pid, "SIGKILL"); } });
members.register(self);
const expected_hash = createHash("sha256").update(mode === "legacy-user" ? "Legacy notes\n" : mode === "rollback" ? "after\n" : "before\n").digest("hex");
const snapshot = mode === "rollback" ? readdirSync(join(dir, "home", ".ash", "versions", "MEMORY.md")).find((name) => /^[0-9]+\.md$/.test(name)) : undefined;
if (mode === "rollback" && !snapshot) throw new Error("rollback snapshot missing");
await world.send({ transport: "api", transportPrincipal: "owner-test", member: "person:owner", local: true, remote: false, ownerProxy: true },
  mode === "append"
    ? { to: "service:self", kind: "request", word: "append", body: { path: "memory/2026-10-01.md", text: "after\n" }, wait: true, client_id: "crash-append" }
    : mode === "rollback" && snapshot
      ? { to: "service:self", kind: "request", word: "rollback", body: { path: "MEMORY.md", to_ts: Number(snapshot.slice(0, -3)), expected_hash }, wait: true, client_id: "crash-rollback" }
    : { to: "service:self", kind: "request", word: "write", body: { path: mode === "legacy-user" ? "USER.md" : "MEMORY.md", content: mode === "legacy-user" ? "Legacy notes\nUpdated\n" : "after\n", why: "synthetic crash", expected_hash }, wait: true, client_id: mode === "legacy-user" ? "crash-legacy-user" : "crash-write" });
throw new Error(`failpoint ${stage} did not kill the child`);
