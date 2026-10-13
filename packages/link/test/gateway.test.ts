import { DeviceKey, GatewayClient } from "ash-gateway/client/client";
import { MaterialTargetProvider, currentMaterialTargetProof } from "../src/material/material-target-provider";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import test from "node:test";
import { eventually } from "../../core/test/fixtures/wait";
import { Relay, RelayError, type BrowserOpen, type RelayDevice, type RelayOptions, type RelayPairRequest } from "../src/gateway";
import { FakeGateway } from "./fixtures/fake-gateway";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** An owner whose key is held here; the relay only ever sees signatures. */
function newOwner() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    id: b64u(createHash("sha256").update(spki).digest()).slice(0, 22),
    publicKey: b64u(spki),
    sign: async (data: Uint8Array) => b64u(signBytes("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "der" })),
  };
}

async function setup(t: test.TestContext, o: { secret?: string | null; claimed?: boolean } = {}, relay: Partial<RelayOptions> = {}) {
  const owner = newOwner();
  const gw = await FakeGateway.start({ secret: o.secret, ...(o.claimed ? { claimedBy: { id: owner.id, key: owner.publicKey } } : {}) });
  const devices: RelayDevice[][] = [];
  const requests: RelayPairRequest[] = [];
  const browsers: BrowserOpen[] = [];
  const connection: boolean[] = [];
  let onBrowser: (open: BrowserOpen) => void = (open) => browsers.push(open);
  const made = new Relay({
    url: gw.url, owner, claimSecret: () => gw.secret, backoff: { initialMs: 10, maxMs: 50 }, timeoutMs: 5000,
    handlers: { devices: (d) => devices.push(d), pairRequest: (r) => requests.push(r), browser: (open) => onBrowser(open), connection: (c) => connection.push(c) },
    ...relay,
  });
  t.after(async () => { made.stop(); await gw.stop(); });
  return { owner, gw, relay: made, devices, requests, browsers, connection, onBrowser: (fn: (open: BrowserOpen) => void) => { onBrowser = fn; } };
}

test("an unclaimed relay is claimed with the secret, signed by the owner's key, and then connected", async (t) => {
  const { gw, relay, owner, connection } = await setup(t);
  await relay.ensureClaimed();
  assert.equal(gw.ownerId, owner.id);
  assert.equal(relay.claimed, true);
  relay.start();
  assert.ok(await relay.waitConnected(5000));
  assert.deepEqual(connection, [true]);
  assert.equal(gw.ownerConnections, 1);
});

test("what cannot be fixed by trying again is a problem the owner has to see, not a retry", async (t) => {
  const none = await setup(t, { secret: "right" }, { claimSecret: () => null });
  await assert.rejects(none.relay.ensureClaimed(), (e: RelayError) => e.problem === "missing_secret");

  const wrong = await setup(t, { secret: "right" }, { claimSecret: () => "wrong" });
  await assert.rejects(wrong.relay.ensureClaimed(), (e: RelayError) => e.problem === "bad_secret");

  const other = await setup(t);
  const stranger = await FakeGateway.start({ claimedBy: { id: "someone-else-entirely-1", key: "x" } });
  t.after(() => stranger.stop());
  const relay = new Relay({ url: stranger.url, owner: other.owner, backoff: { initialMs: 10, maxMs: 20 } });
  relay.start();
  await eventually(() => relay.problem, "the problem");
  assert.equal(relay.problem, "claimed_by_other");
  assert.equal(relay.connected, false);
  relay.stop();

  const gone = new Relay({ url: "http://127.0.0.1:1", owner: other.owner, backoff: { initialMs: 10, maxMs: 20 }, timeoutMs: 500 });
  await assert.rejects(gone.ensureClaimed(), (e: RelayError) => e.problem === "unreachable");
});

test("the device list and its permissions arrive after connecting and whenever a device comes online", async (t) => {
  const { gw, relay, devices } = await setup(t, { claimed: true });
  gw.setDevice("mac1", { name: "Mac", permissions: ["expose_capability"], online: false });
  relay.start();
  assert.ok(await relay.waitConnected(5000));
  assert.deepEqual(relay.devices().map((d) => [d.id, d.online, d.permissions]), [["mac1", false, ["expose_capability"]]]);

  const before = devices.length;
  gw.setDevice("mac1", { online: true });
  await eventually(() => devices.length > before && devices.at(-1)!.find((d) => d.id === "mac1")!.online, "the presence read");
  assert.deepEqual(relay.devices()[0]!.permissions, ["expose_capability"]);
});

test("a /link tunnel to a device carries text both ways; the relay's refusals arrive as a close", async (t) => {
  const { gw, relay } = await setup(t, { claimed: true });
  gw.setDevice("mac1", { permissions: ["expose_capability"], online: true });
  gw.setDevice("web1", { permissions: ["web_ui"], online: true });
  gw.onDeviceStream = (_id, endpoint) => endpoint.onMessage((text) => endpoint.send(`echo ${text}`));
  relay.start();
  assert.ok(await relay.waitConnected(5000));

  const socket = relay.openLink("mac1");
  const heard: string[] = [];
  socket.on("message", (data: string) => heard.push(data));
  socket.send("hello");
  await eventually(() => heard.length === 1, "the echo");
  assert.deepEqual(heard, ["echo hello"]);

  const closes: [number, string][] = [];
  const refused = relay.openLink("web1");
  refused.on("close", (code: number, reason: string) => closes.push([code, reason]));
  await eventually(() => closes.length > 0, "the refusal");
  assert.equal(closes[0]![0], 4404, "a device with only web permissions cannot be reached");

  // one stream per device: opening again replaces the first
  const first: number[] = [];
  socket.on("close", (code: number) => first.push(code));
  relay.openLink("mac1");
  await eventually(() => first.length > 0, "the replacement");
  assert.equal(first[0], 4409);
});

test("a browser stream is handed over with its path; nothing is answered until the caller decides", async (t) => {
  const { gw, relay, onBrowser, browsers } = await setup(t, { claimed: true });
  relay.start();
  assert.ok(await relay.waitConnected(5000));

  onBrowser((open) => {
    if (open.path !== "/link") return open.reject(4404, "path_not_allowed");
    const socket = open.accept();
    socket.on("message", (text: string) => socket.send(`you said ${text}`));
  });
  const good = gw.openBrowser("browser1", "/link");
  await eventually(() => good.opened, "the open to be acknowledged");
  good.send("hi");
  await eventually(() => good.received.length > 0, "the answer");
  assert.deepEqual(good.received, ["you said hi"]);

  const bad = gw.openBrowser("browser1", "/api/send");
  await eventually(() => bad.closedWith, "the refusal");
  assert.equal(bad.closedWith!.code, 4404);
  assert.equal(bad.opened, false);
  assert.equal(browsers.length, 0);
});

test("a browser stream nobody handles is refused, and an HTTP request is answered with an error rather than left hanging", async (t) => {
  const { gw, relay } = await setup(t, { claimed: true }, { handlers: {} });
  relay.start();
  assert.ok(await relay.waitConnected(5000));
  const stream = gw.openBrowser("browser1", "/link");
  await eventually(() => stream.closedWith, "the refusal");
  assert.equal(stream.closedWith!.code, 4404);
  const answer = await gw.browserHttp("browser1");
  assert.match(answer.error!, /does not serve web pages/);
});

test("pairing: a ticket is registered by its hash, a request arrives, approval and permission changes are signed with the next grant version", async (t) => {
  const { gw, relay, requests } = await setup(t, { claimed: true });
  relay.start();
  assert.ok(await relay.waitConnected(5000));

  const { ticket, origin } = await relay.ticket();
  assert.equal(origin, gw.url);
  assert.deepEqual(gw.tickets, [createHash("sha256").update(ticket).digest("base64url")]);

  gw.pairRequest({ request_id: "req1", client_id: "mac1", name: "Mac", pubkey: "PUB" });
  await eventually(() => requests.length > 0, "the request");
  assert.equal(requests[0]!.client_id, "mac1");

  await relay.approve("req1", ["expose_capability"]);
  // The owner's key here signs DER (as Android's keystore does); the relay is given r||s, which is what a browser's WebCrypto verifies.
  assert.equal(Buffer.from(String(gw.ops.find((op) => op.op === "pair.approve")!.sig), "base64url").length, 64, "the approval is signed raw, not DER");
  assert.deepEqual(gw.devices.get("mac1")!.permissions, ["expose_capability"]);
  assert.equal(gw.grantVersion, 1);
  await assert.rejects(relay.approve("nope", []), /unknown pairing request/);

  await relay.setPermissions("mac1", (cur) => [...cur, "web_ui", "chat"]);
  assert.deepEqual(gw.devices.get("mac1")!.permissions, ["expose_capability", "web_ui", "chat"]);
  assert.equal(gw.grantVersion, 2);

  await relay.revoke("mac1");
  assert.equal(gw.devices.get("mac1")!.revoked, true);
  assert.equal(relay.devices().find((d) => d.id === "mac1")!.revoked, true);
});

test("a dropped connection is made again by itself, and stop ends it", async (t) => {
  const { gw, relay, connection } = await setup(t, { claimed: true });
  relay.start();
  assert.ok(await relay.waitConnected(5000));
  gw.owner!.terminate();
  await eventually(() => gw.ownerConnections === 2 && relay.connected, "the new connection");
  assert.deepEqual(connection, [true, false, true]);
  relay.stop();
  await eventually(() => !relay.connected, "stopping");
});

test("a browser's HTTP request arrives whole and the answer goes back as head, body pieces and end", async (t) => {
  const seen: { from: string; method: string; path: string; headers: [string, string][]; body: string }[] = [];
  const big = Buffer.alloc(600_000, 7);
  const { gw, relay } = await setup(t, { claimed: true }, {
    handlers: {
      http: async (req) => {
        seen.push({ from: req.from, method: req.method, path: req.path, headers: req.headers, body: Buffer.from(req.body).toString() });
        if (req.path === "/big") return { status: 200, headers: [["content-type", "application/octet-stream"]], body: big };
        if (req.path === "/stream") return { status: 200, headers: [], body: (async function* () { yield Buffer.from("one "); yield Buffer.from("two"); })() };
        if (req.path === "/boom") throw new Error("handler broke");
        return { status: 201, headers: [["x-seen", "yes"]], body: Buffer.from("made") };
      },
    },
  });
  relay.start();
  assert.ok(await relay.waitConnected(5000));

  const posted = await gw.browserHttp("browser1", { method: "POST", path: "/api/x?y=1", headers: [["content-type", "text/plain"]], body: Buffer.from("a".repeat(250_000)) });
  assert.deepEqual([posted.status, posted.headers, posted.body.toString(), posted.ended], [201, [["x-seen", "yes"]], "made", true]);
  assert.deepEqual([seen[0]!.from, seen[0]!.method, seen[0]!.path, seen[0]!.body.length], ["browser1", "POST", "/api/x?y=1", 250_000]);
  assert.deepEqual(seen[0]!.headers, [["content-type", "text/plain"]]);

  const large = await gw.browserHttp("browser1", { path: "/big" });
  assert.ok(large.body.equals(big), "all of it, in order");
  assert.ok(large.bodyFrames >= 3, "in pieces of at most 256 KiB");

  assert.equal((await gw.browserHttp("browser1", { path: "/stream" })).body.toString(), "one two");
  assert.match((await gw.browserHttp("browser1", { path: "/boom" })).error!, /could not answer/);
});

test("a browser that goes away mid-request stops the work", async (t) => {
  let signal: AbortSignal | undefined;
  const { gw, relay } = await setup(t, { claimed: true }, { handlers: { http: async (req) => { signal = req.signal; return { status: 200, headers: [], body: Buffer.from("x") }; } } });
  relay.start();
  assert.ok(await relay.waitConnected(5000));
  const aborted = gw.browserHttp("browser1", { abortAfterMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(signal, undefined, "an aborted request is never run");
  void aborted;
  const tooBig = await gw.browserHttp("browser1", { method: "POST", body: Buffer.alloc(9 * 1024 * 1024) });
  assert.match(tooBig.error!, /too large/);
});


test("signed material side channel fences grants and reconnect epochs and rejects a forged provider answer", async t => {
  const {gw,relay,owner}=await setup(t,{claimed:true});
  const device=await DeviceKey.generate();gw.setDevice(device.id,{permissions:["expose_capability"],online:true});
  relay.start();assert.ok(await relay.waitConnected(5000));
  const side=relay.material(device.id,device.publicKey),peer=await side.transport.capture();
  const signed=await side.gateway.envelope("ash.material.provider.request.v1",device.id,{test:true},{ttlMs:1000});
  assert.ok(await GatewayClient.verifyEnvelope(signed,owner.publicKey));
  await assert.rejects(side.gateway.envelope("other.protocol",device.id,{},{}));
  assert.throws(()=>side.transport.send({...signed,type:"other.protocol"}));
  const target=new MaterialTargetProvider({gateway:side.gateway,transport:side.transport,observeUnfinished:()=>undefined,budgetMs:1000});
  const stop=side.observe(frame=>{void target.acceptFrame(frame);});t.after(()=>{stop();target.close();});
  const remote=new GatewayClient(gw.url,device);let forged=false;
  gw.onMaterial=frame=>{void(async()=>{const request=JSON.parse(String(frame.payload));const input=request.input;
    const answer=await remote.envelope("ash.material.provider.response.v1",owner.id,{version:1,call_id:request.call_id,result:{...input,cwd:"/work",generation:"generation",target_known:true,send_authorized:true,expires_at:Number(frame.expires_at)-1,authorized_until:null}},{replyTo:String(frame.message_id),ttlMs:Math.max(1,Number(frame.expires_at)-Date.now()-2)});
    gw.sendMaterial({...answer,...(forged?{sig:"invalid"}:{})});
  })();};
  const binding={work:{node_id:device.id,endpoint_id:device.id,kind:"conversation" as const,native_id:"thread"},authorization_revision:"a".repeat(64),action:"send_input" as const};
  const proof=await target.captureTarget(binding);assert.equal(currentMaterialTargetProof(proof).facts.cwd,"/work");
  forged=true;await assert.rejects(target.captureTarget(binding),{code:"permission_denied"});
  gw.setDevice(device.id,{permissions:[]});await relay.refreshDevices();assert.throws(()=>side.transport.current(peer));
  gw.setDevice(device.id,{permissions:["expose_capability"]});await relay.refreshDevices();assert.throws(()=>side.transport.current(peer),"restoring a permission cannot restore an old lease");
  const restored=await side.transport.capture();relay.reconnect();await eventually(()=>!relay.connected,"relay disconnect");assert.throws(()=>side.transport.current(restored));assert.ok(await relay.waitConnected(5000));assert.throws(()=>side.transport.current(restored));
});
