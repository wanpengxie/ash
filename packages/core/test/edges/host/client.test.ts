import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HOST_OPTIONAL_CAPABILITIES, HOST_POWER_HOLD_MAX_MS } from "../../../../sdk/src/host";
import { createHostPipe, HostCallError, HostClient, loadHostBoot } from "../../../src/edges/host";
import { FakeClock, FakeHost, type FakeHostConnection } from "../../fixtures/host";

let current: FakeHost | undefined;
afterEach(async () => { await current?.stop(); current = undefined; });

async function setup(options: ConstructorParameters<typeof FakeHost>[0] = {}, clock?: FakeClock, heartbeatErrors?: unknown[], timeoutMs?: number) {
  const host = current = await new FakeHost(options).start();
  const boot = loadHostBoot({ env: host.writeLaunch().env });
  assert.ok(boot.ok);
  const conn: FakeHostConnection = host.connect();
  const pipe = createHostPipe(conn.stdin, conn.stdout, () => {});
  await pipe.boot();
  const client = new HostClient({
    pipe, capabilities: boot.boot.spec.capabilities, timeoutMs,
    setInterval: clock?.setInterval, onHeartbeatError: (error) => heartbeatErrors?.push(error),
  });
  return { host, client, conn };
}

describe("host client", () => {
  it("sends every method over the pipe and returns the result", async () => {
    const { host, client } = await setup();
    assert.deepEqual(await client.identityKey(), { id: "fakeid0123456789abcdef", public_key: "fake-public-key" });
    assert.deepEqual(await client.identitySign("aGk"), { sig: "sig:aGk" });
    await client.lifecycleReady("1.2.3", 43001);
    await client.lifecycleRestart("config changed");
    await client.statusSet("all fine", "running");
    assert.deepEqual(await client.wakeAt(1791234567000), { supported: true, result: {} });
    assert.deepEqual(await client.wakeClear(), { supported: true, result: {} });
    await client.powerHold(5000, "turn");
    await client.powerRelease();
    assert.deepEqual(await client.handsHandoff(43001, "link-token"), { supported: true, result: { delivered: ["hand:fake"] } });
    await client.updateInstall({ version: "2.0.0", packages: [{ package: "ai.ash.kernel", url: "https://example.test/k.apk", sha256: "ab".repeat(32) }] });
    await client.updateStatus();

    assert.deepEqual(host.calls.map((call) => [call.method, call.body]), [
      ["identity.key", {}],
      ["identity.sign", { data: "aGk" }],
      ["lifecycle.ready", { version: "1.2.3", link_port: 43001 }],
      ["lifecycle.restart", { reason: "config changed" }],
      ["status.set", { text: "all fine", state: "running" }],
      ["wake.at", { at: 1791234567000 }],
      ["wake.clear", {}],
      ["power.hold", { ms: 5000, reason: "turn" }],
      ["power.release", {}],
      ["hands.handoff", { port: 43001, token: "link-token" }],
      ["update.install", { version: "2.0.0", packages: [{ package: "ai.ash.kernel", url: "https://example.test/k.apk", sha256: "ab".repeat(32) }] }],
      ["update.status", {}],
    ]);
  });

  it("caps a power hold at the contract maximum", async () => {
    const { host, client } = await setup();
    await client.powerHold(HOST_POWER_HOLD_MAX_MS * 5, "long");
    assert.equal((host.callsOf("power.hold")[0].body as { ms: number }).ms, HOST_POWER_HOLD_MAX_MS);
  });

  it("passes the host's error code through", async () => {
    const { host, client } = await setup();
    host.failures.set("identity.sign", "unavailable");
    await assert.rejects(client.identitySign("x"), (error: unknown) => error instanceof HostCallError && error.code === "unavailable");
  });

  it("turns a code outside the shared set into failed", async () => {
    const { host, client } = await setup();
    host.failures.set("identity.sign", "weird_code");
    await assert.rejects(client.identitySign("x"), (error: unknown) => error instanceof HostCallError && error.code === "failed");
  });

  it("ends an unanswered call as result_unknown after the call timeout", async () => {
    const { host, client } = await setup({}, undefined, undefined, 50);
    host.hangs.add("wake.at");
    await assert.rejects(client.wakeAt(1), (error: unknown) => error instanceof HostCallError && error.code === "result_unknown" && error.method === "wake.at");
    assert.equal(host.callsOf("wake.at").length, 1, "it was sent");
  });

  it("reports a host that closed the pipe as unavailable", async () => {
    const { client, conn } = await setup();
    conn.close();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(client.statusSet("x", "running"), (error: unknown) => error instanceof HostCallError && error.code === "unavailable");
  });

  for (const capability of HOST_OPTIONAL_CAPABILITIES) {
    it(`without ${capability}: its methods say unsupported and send nothing, the rest work`, async () => {
      const { host, client } = await setup({ without: [capability] });
      const attempts = {
        wake: () => Promise.all([client.wakeAt(1), client.wakeClear()]),
        power: () => Promise.all([client.powerHold(1, "x"), client.powerRelease()]),
        hands: () => Promise.all([client.handsHandoff(1, "t")]),
        update: () => Promise.all([client.updateInstall({ version: "1.0.0", packages: [] }), client.updateStatus()]),
        vscreen: () => Promise.all([client.phone("vscreen.status", {}), client.phone("vscreen.tap", { x: 1, y: 1 })]),
        input: () => Promise.all([client.phone("input.key", { key: "home" })]),
        apps: () => Promise.all([client.phone("apps.open", { app: "x" })]),
      }[capability];
      for (const answer of await attempts()) assert.deepEqual(answer, { supported: false });
      assert.equal(host.calls.length, 0, "nothing was sent");
      assert.equal(client.has(capability), false);
      await client.statusSet("still fine", "degraded");
      assert.equal(host.callsOf("status.set").length, 1);
      for (const other of HOST_OPTIONAL_CAPABILITIES.filter((name) => name !== capability)) assert.ok(client.has(other));
    });
  }

  it("beats status.set once every 60 seconds on the injected clock", async () => {
    const clock = new FakeClock();
    const { host, client } = await setup({}, clock);
    const stop = client.startHeartbeat(() => ({ text: "alive", state: "running" }));
    clock.tick(59_999);
    assert.equal(host.callsOf("status.set").length, 0);
    clock.tick(1);
    await host.waitForCalls(1, "status.set");
    clock.tick(120_000);
    await host.waitForCalls(3, "status.set");
    assert.equal(host.callsOf("status.set").length, 3);
    assert.deepEqual(host.callsOf("status.set")[2].body, { text: "alive", state: "running" });
    stop();
    clock.tick(180_000);
    assert.equal(host.callsOf("status.set").length, 3, "stopped heartbeat stays quiet");
  });

  it("keeps beating and reports when one heartbeat fails", async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const { host, client } = await setup({}, clock, errors);
    host.failures.set("status.set", "unavailable");
    client.startHeartbeat(() => ({ text: "x", state: "running" }));
    clock.tick(60_000);
    await host.waitForCalls(1, "status.set");
    while (errors.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(errors[0] instanceof HostCallError);
    host.failures.clear();
    clock.tick(60_000);
    await host.waitForCalls(2, "status.set");
  });

  it("keeps beating when the status callback itself throws", async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const { host, client } = await setup({}, clock, errors);
    let broken = true;
    client.startHeartbeat(() => {
      if (broken) throw new Error("status callback broke");
      return { text: "back", state: "running" };
    });
    clock.tick(60_000);
    while (errors.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.match((errors[0] as Error).message, /status callback broke/);
    assert.equal(host.callsOf("status.set").length, 0);
    broken = false;
    clock.tick(60_000);
    await host.waitForCalls(1, "status.set");
    assert.deepEqual(host.callsOf("status.set")[0].body, { text: "back", state: "running" });
  });
});
