import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";
import type { Message } from "../../../sdk/src/api";
import type { TrustedRouteContext } from "../../src/world/router";
import { FakeHost } from "../fixtures/fake-host";
import { auditEffectLedger, type ObservedEffect } from "./effect-audit";
import { STUCK_MS } from "../fixtures/wait";

const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
  local: true, remote: false, ownerProxy: false };
const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + STUCK_MS;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label} did not complete`);
};

test("AR6 production scenario matches witnessed host calls, file bytes, and live gate release to persisted messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-ar6-scenario-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const host = new FakeHost("synthetic-ar6-token");
  const observedOrder: string[] = [];
  host.onRecord = (record) => {
    if (record.path === "/call") observedOrder.push("device_call");
    if (record.path === "/present" && (record.body as { kind?: unknown } | undefined)?.kind === "due")
      observedOrder.push("notification");
  };
  host.manifest.capabilities = [{ name: "message.send", description: "Send a message", label: "Sending a message", risk: "outward",
    input_schema: { type: "object", properties: { recipient_id: { type: "string" }, text: { type: "string" } },
      required: ["recipient_id", "text"], additionalProperties: false } }];
  host.queueCall("message.send", { ok: true, content: "sent" });
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  let unsubscribe: (() => void) | null = null;
  try {
    await host.start();
    running = await startOwner({ stateDir: join(dir, "state"), listen: "127.0.0.1:0", workspaces: { home },
      agents: [{ id: "agent:main", runtime: "echo" }], host: { url: host.url, token: host.token } });
    const world = running.world, ledger = running.ledger;
    const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const owner: TrustedRouteContext = { member: "person:owner", transport: "api",
      transportPrincipal: `token:${createHash("sha256").update(ownerToken).digest("hex")}`,
      local: true, remote: false, ownerProxy: true };
    const liveGate: Message[] = [];
    unsubscribe = world.subscribe((message) => {
      if (message.from === "service:gate" && message.word === "gate.passed") {
        liveGate.push(message);
        observedOrder.push("gate_release");
      }
    });

    const access = await world.send(owner, { to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: "device:phone/message.send" }, wait: true });
    assert.equal(access.reply?.body.ok, true);
    const deviceBody = { recipient_id: "550e8400-e29b-41d4-a716-446655440000", text: "synthetic AR6" };
    const call = await world.send(agent, { to: "device:phone", kind: "request", word: "message.send", body: deviceBody });
    await until(() => Boolean(ledger.gateCase(call.id)), "risk ask");
    assert.equal(host.calls.filter((item) => item.path === "/call").length, 0);
    const ask = ledger.gateCase(call.id)!;
    const screen = running.edge.screens.register(owner, "ar6-scenario", "Controlled screen");
    const answer = await fetch(`${running.url}/api/send`, { method: "POST", headers: {
      authorization: `Bearer ${ownerToken}`, "content-type": "application/json", "Ash-Screen": screen.token },
    body: JSON.stringify({ to: "service:gate", kind: "response", word: "ask", reply_to: ask.askId,
      body: { ok: true, result: { choice: "once" } } }) });
    assert.equal(answer.status, 200);
    await until(() => Boolean(ledger.responseTo(call.id)) && host.calls.some((item) => item.path === "/call"), "device effect");
    assert.deepEqual(host.assertCall("/call").body, { capability: "message.send", args: deviceBody, caller: "agent:main" });
    assert.equal(liveGate.length, 1);

    const due = await world.send(agent, { to: "person:owner", kind: "request", word: "say",
      body: { text: "synthetic due", kind: "due" }, wait: true });
    await until(() => host.calls.some((item) => item.path === "/present") &&
      ledger.list({ limit: 1000 }).some((item) => item.to === "service:post" && item.word === "deliver" &&
        item.body.message_id === due.id && Boolean(ledger.responseTo(item.id))), "notification effect");
    host.assertCall("/present", { id: due.id, kind: "due", title: "Due", text: "synthetic due" });
    const delivery = ledger.list({ limit: 1000 }).find((item) => item.to === "service:post" && item.word === "deliver" && item.body.message_id === due.id)!;

    const content = "synthetic verified preference\n";
    const writeBody = { path: "USER.md", content, why: "AR6 observed file effect", expected_hash: null };
    const write = await world.send(owner, { to: "service:self", kind: "request", word: "write", body: writeBody, wait: true });
    assert.equal(write.reply?.body.ok, true);
    const written = readFileSync(join(home, "USER.md"), "utf8");
    assert.match(written, /synthetic verified preference/);
    assert.match(written, /^---\nversion: 1\n/);
    observedOrder.push("intrinsic_write");
    assert.deepEqual(observedOrder, ["gate_release", "device_call", "notification", "intrinsic_write"]);

    const effects: ObservedEffect[] = [
      { id: "live-gate", kind: "gate_release", ledger_id: liveGate[0].id, to: null, word: "gate.passed", body: liveGate[0].body },
      { id: "host-call", kind: "device_call", ledger_id: call.id, to: "device:phone", word: "message.send", body: deviceBody,
        result: { ok: true, result: { content: "sent" } } },
      { id: "host-notification", kind: "notification", ledger_id: delivery.id, to: "service:post", word: "deliver",
        body: { message_id: due.id, kind: "due" }, result: { ok: true, result: { channel: "notification" } } },
      { id: "file-bytes", kind: "intrinsic_write", ledger_id: write.id, to: "service:self", word: "write", body: writeBody,
        result: { ok: true, result: { hash: createHash("sha256").update(written).digest("hex"), version: 1 } } },
    ];
    const persisted = ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
    assert.deepEqual(auditEffectLedger(persisted, effects), []);
    assert.match(auditEffectLedger(persisted.filter((message) => message.id !== delivery.id), effects).join(" "), /no ledger cause/);
    assert.match(auditEffectLedger(persisted.filter((message) => message.id !== liveGate[0].id), effects).join(" "), /no ledger cause/);
    host.assertDrained();
  } finally {
    unsubscribe?.();
    await running?.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
