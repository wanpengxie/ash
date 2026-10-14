import assert from "node:assert/strict";
import test from "node:test";
import { CLOSE_CODES, LINK_PROTOCOL } from "../../sdk/src/link";
import { eventually } from "../../core/test/fixtures/wait";
import { HandClient, type HandHandlers } from "../src/hand";
import { LinkError, type LinkSession } from "../src/server";
import { SecureRefusal, secureConnector, type DeviceSecureOptions } from "../src/secure";
import { endorse, party, secureWorld, type Party, type SecureWorld, type Wire } from "./fixtures/secure";

const caller = { member: "agent:main", label: "main" };
const SECRET_ARG = "SECRET-PAYLOAD-7f3a";
const SECRET_RESULT = "SECRET-RESULT-91bc";

interface Device {
  client: HandClient;
  runs: string[];
  closes: { code: number; reason: string; willReconnect: boolean }[];
  refusals: SecureRefusal[];
  pinned: string[];
}

/** The device: a link client behind `secureConnector`, with one capability that records what it was asked. */
function device(world: SecureWorld, o: { trust?: () => { ownerKey: string; pairSecret: string | null }; as?: Party; handlers?: HandHandlers; now?: () => number } = {}): Device {
  const me = o.as ?? world.device;
  const runs: string[] = [], closes: Device["closes"] = [], refusals: SecureRefusal[] = [], pinned: string[] = [];
  const secure: DeviceSecureOptions = {
    key: me.key, trust: o.trust ?? (() => ({ ownerKey: world.owner.publicKey, pairSecret: null })),
    paired: (ownerKey) => pinned.push(ownerKey), refused: (error) => refusals.push(error), now: o.now,
  };
  const client = new HandClient({
    url: "relay://tunnel/link", connector: secureConnector(world.connector, secure),
    hand: { kind: "computer", name: "mac", version: "0.0.0", platform: "test", public_key: me.publicKey },
    channels: { device: {} }, sign: (nonce) => me.sign(nonce),
    random: () => 0.5,
    handlers: {
      call: async (call) => { runs.push(String((call.args as { text?: unknown }).text)); return { ok: true, content: [{ type: "text", text: SECRET_RESULT }] }; },
      closed: (info) => closes.push(info),
      ...o.handlers,
    },
  });
  client.start();
  return { client, runs, closes, refusals, pinned };
}

const call = (session: LinkSession, text: string) => session.call({ capability: "echo.say", args: { text }, caller, deadline: Date.now() + 10_000 });
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
/** What a recorded message says, read both as text and as base64. */
const readable = (text: string) => `${text}\n${Buffer.from(text, "base64").toString("latin1")}`;

test("the relay sees only the version announcement in the clear; calls and results cross it as TLS", async () => {
  const world = secureWorld();
  const mac = device(world);
  try {
    await mac.client.ready();
    const result = await call(world.sessions[0]!, SECRET_ARG);
    assert.equal(result.ok, true);
    assert.deepEqual(mac.runs, [SECRET_ARG]);
    const log = world.wires[0]!.log;
    assert.ok(log.length > 6, "the handshake and the call went over the wire");
    for (const { text } of log) for (const secret of [SECRET_ARG, SECRET_RESULT, "echo.say", '"t":"call"', '"t":"hello"', "welcome"]) {
      assert.ok(!readable(text).includes(secret), `the relay saw ${secret}`);
    }
    // The one message in the clear: the hub's version announcement.
    assert.deepEqual(JSON.parse(log[0]!.text).kernel.protocol, LINK_PROTOCOL);
    assert.equal(log.filter(({ text }) => text.startsWith("{")).length, 1);
    assert.deepEqual(world.outcomes, [{ ok: true, peerKey: world.device.publicKey }]);
  } finally { mac.client.stop(); world.link.close(); }
});

/** Waits until the device is connected and the TLS handshake's own messages have passed, then hands the wire over. */
async function quiet(world: SecureWorld, mac: Device): Promise<Wire> {
  await mac.client.ready();
  await settled();
  return world.wires.at(-1)!;
}

test("a changed byte ends the connection, and the command is not run", async () => {
  const world = secureWorld();
  const mac = device(world);
  try {
    const wire = await quiet(world, mac);
    wire.tamper = (dir, text, pass) => {
      if (dir !== "down") return pass(text);
      const bytes = Buffer.from(text, "base64");
      bytes[bytes.length - 3]! ^= 0x01;
      wire.tamper = null;
      pass(bytes.toString("base64"));
    };
    await assert.rejects(call(world.sessions[0]!, "rm -rf /"), (error) => error instanceof LinkError && error.kind === "closed");
    assert.deepEqual(mac.runs, []);
    await eventually(() => mac.closes.length > 0, "the device dropped the connection");
    assert.match(mac.closes[0]!.reason, /TLS failed/);
  } finally { mac.client.stop(); world.link.close(); }
});

test("a replayed message ends the connection; the command runs once only", async () => {
  const world = secureWorld();
  const mac = device(world);
  try {
    const wire = await quiet(world, mac);
    let captured: string | null = null;
    wire.tamper = (dir, text, pass) => { if (dir === "down" && captured === null) captured = text; pass(text); };
    assert.equal((await call(world.sessions[0]!, "once")).ok, true);
    wire.tamper = null;
    wire.inject("down", captured!);
    await eventually(() => mac.closes.length > 0, "the device dropped the connection");
    await settled();
    assert.deepEqual(mac.runs, ["once"]);
  } finally { mac.client.stop(); world.link.close(); }
});

test("two messages in swapped order end the connection; neither command runs", async () => {
  const world = secureWorld();
  const mac = device(world);
  try {
    const wire = await quiet(world, mac);
    let held: string | null = null;
    wire.tamper = (dir, text, pass) => {
      if (dir !== "down") return pass(text);
      if (held === null) { held = text; return; }
      wire.tamper = null;
      pass(text);
      pass(held);
    };
    const session = world.sessions[0]!;
    const first = call(session, "first");
    await new Promise((resolve) => setImmediate(resolve));
    const second = call(session, "second");
    await assert.rejects(first);
    await assert.rejects(second);
    assert.deepEqual(mac.runs, []);
  } finally { mac.client.stop(); world.link.close(); }
});

test("a relay that answers as the hub with a key the owner did not endorse is refused", async () => {
  const stranger = party();
  const cases: [string, (w: Omit<SecureWorld, "connector">) => object, RegExp][] = [
    ["its own owner", () => ({ key: stranger.key, endorsement: endorse(party(), stranger) }), /not from the owner/],
    ["the real endorsement on another key", (w) => ({ key: stranger.key, endorsement: endorse(w.owner, w.hub) }), /certificate is not the key/],
    ["an expired endorsement", (w) => ({ endorsement: endorse(w.owner, w.hub, Date.now() - 1) }), /expired/],
    ["a forged signature", (w) => ({ endorsement: { ...endorse(w.owner, w.hub), sig: endorse(party(), w.hub).sig } }), /signature/],
  ];
  for (const [what, hubOptions, reason] of cases) {
    const world = secureWorld({ hubOptions });
    const mac = device(world);
    try {
      await eventually(() => mac.refusals.length > 0, `the device refused ${what}`);
      assert.match(mac.refusals[0]!.message, reason, what);
      assert.equal(world.sessions.length, 0, `no session with ${what}`);
      assert.equal(mac.client.state === "ready", false);
      assert.ok(mac.closes.every((c) => c.willReconnect), "the device keeps trying: the real hub may come later");
    } finally { mac.client.stop(); world.link.close(); }
  }
});

test("a device whose key is not the one that was paired is refused with 4001", async () => {
  const world = secureWorld();
  const impostor = device(world, { as: party() });
  try {
    await eventually(() => world.outcomes.length > 0, "the hub decided");
    assert.deepEqual(world.outcomes[0], { ok: false, code: CLOSE_CODES.unauthenticated, reason: "the device's key is not the one that was paired", pairing: false });
    assert.equal(world.sessions.length, 0);
  } finally { impostor.client.stop(); world.link.close(); }
});

test("pairing: both ends prove the one-time secret on the first connection and the device pins the owner", async () => {
  const secret = "k-one-time-secret-for-this-pairing";
  const world = secureWorld({ hubOptions: () => ({ pairSecret: secret }) });
  // The relay told the device someone else's key at pairing; the secret shows which owner is real.
  const told = party().publicKey;
  const mac = device(world, { trust: () => ({ ownerKey: told, pairSecret: secret }) });
  try {
    await mac.client.ready();
    assert.deepEqual(mac.pinned, [world.owner.publicKey]);
    assert.deepEqual(world.outcomes, [{ ok: true, peerKey: world.device.publicKey }]);
  } finally { mac.client.stop(); world.link.close(); }
});

test("pairing: a relay that swapped the owner's key cannot prove the secret, and the device says so", async () => {
  const fake = party();
  const world = secureWorld({ hubOptions: () => ({ key: fake.key, endorsement: endorse(fake, fake), pairSecret: null }) });
  const mac = device(world, { trust: () => ({ ownerKey: fake.publicKey, pairSecret: "the-real-secret" }) });
  try {
    await eventually(() => mac.refusals.length > 0, "the device refused");
    assert.equal(mac.refusals[0]!.pairing, true);
    assert.match(mac.refusals[0]!.message, /could not prove the pairing secret: the relay may have swapped the owner's key/);
    assert.deepEqual(mac.pinned, []);
    assert.equal(world.sessions.length, 0);
  } finally { mac.client.stop(); world.link.close(); }
});

test("pairing: a relay that swapped the device's key cannot prove the secret, and the hub says so", async () => {
  const swapped = party();
  const world = secureWorld({ hubOptions: () => ({ deviceKey: swapped.publicKey, pairSecret: "the-real-secret" }) });
  // The relay holds the key it slipped in, but not the secret: it can only answer without the proof.
  const impostor = device(world, { as: swapped, trust: () => ({ ownerKey: world.owner.publicKey, pairSecret: null }) });
  try {
    await eventually(() => world.outcomes.length > 0, "the hub decided");
    const outcome = world.outcomes[0]!;
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.ok ? null : [outcome.code, outcome.pairing], [CLOSE_CODES.unauthenticated, true]);
    assert.match(outcome.ok ? "" : outcome.reason, /could not prove the pairing secret/);
    assert.equal(world.sessions.length, 0);
  } finally { impostor.client.stop(); world.link.close(); }
});

test("a device of the older protocol answers the announcement with 4008; one that speaks in the clear is refused", async () => {
  const world = secureWorld();
  // ash-link/1's client: a challenge naming another protocol is closed with 4008.
  const older = world.connector("relay://tunnel/link", {}, {
    open: () => {}, close: () => {},
    message: (data) => { const frame = JSON.parse(String(data)); if (frame.kernel.protocol !== "ash-link/1") older.close(CLOSE_CODES.unsupported, `kernel speaks ${frame.kernel.protocol}`); },
  });
  await eventually(() => world.outcomes.length > 0, "the hub heard back");
  assert.deepEqual(world.outcomes[0], { ok: false, code: CLOSE_CODES.unsupported, reason: `kernel speaks ${LINK_PROTOCOL}`, pairing: false });

  const plain = world.connector("relay://tunnel/link", {}, {
    open: () => {}, close: () => {},
    message: () => plain.send(JSON.stringify({ t: "hello", protocol: LINK_PROTOCOL, hand: { kind: "computer", name: "mac", version: "0", platform: "x" }, channels: { device: {} } })),
  });
  await eventually(() => world.outcomes.length > 1, "the hub refused the plain device");
  assert.deepEqual(world.outcomes[1], { ok: false, code: CLOSE_CODES.badFrame, reason: "the device spoke in the clear; a relay connection must be secured", pairing: false });
  assert.equal(world.sessions.length, 0);
  world.link.close();
});

test("close codes: only those inside TLS count; the relay's own cannot stop the device", async () => {
  const world = secureWorld();
  const mac = device(world);
  try {
    await mac.client.ready();
    // The relay closes the tunnel with "revoked": not believed, the device reconnects.
    world.wires[0]!.end(CLOSE_CODES.revoked, "revoked");
    await eventually(() => mac.closes.length > 0, "closed");
    assert.deepEqual([mac.closes[0]!.code, mac.closes[0]!.willReconnect], [1006, true]);
    await eventually(() => world.sessions.length === 2 && mac.client.state === "ready", "reconnected");
    // The hub revokes for real: the code comes inside TLS and the device stops.
    world.sessions[1]!.close(CLOSE_CODES.revoked, "revoked");
    await eventually(() => mac.client.state === "stopped", "stopped");
    assert.equal(mac.client.stoppedBy, CLOSE_CODES.revoked);
  } finally { mac.client.stop(); world.link.close(); }
});

test("a forged announcement of another protocol makes the device try again later, not stop", async () => {
  const forged = JSON.stringify({ t: "challenge", nonce: "x", kernel: { id: "x", version: "x", protocol: "ash-link/9" } });
  const world = secureWorld({ onWire: (wire) => { wire.tamper = (dir, text, pass) => { wire.tamper = null; pass(dir === "down" ? forged : text); }; } });
  const mac = device(world);
  try {
    await eventually(() => mac.closes.length > 0, "closed");
    assert.equal(mac.closes[0]!.willReconnect, true);
    assert.notEqual(mac.client.state, "stopped");
  } finally { mac.client.stop(); world.link.close(); }
});
