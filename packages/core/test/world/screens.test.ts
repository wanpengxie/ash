import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { WorldMembers } from "../../src/world/member";
import { EdgeRouter, type EdgeCaller, type EdgeRequest, type EdgeResponse } from "../../src/server";
import { OwnerMember } from "../../src/members/owner";
import { PostPresenceMember } from "../../src/members/post";

const owner: EdgeCaller = { member: "person:owner", transportPrincipal: "owner-test", local: true, remote: false, ownerProxy: true, transport: "api" };
const agent: TrustedRouteContext = { member: "agent:main", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false, transport: "agent" };
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): EdgeRequest =>
  ({ method, url: new URL(path, "http://ash"), headers, body: body === undefined ? null : Buffer.from(JSON.stringify(body)) });
const body = (response: EdgeResponse): Record<string, any> => JSON.parse("body" in response ? String(response.body) : "{}");

async function fixture(clock?: () => number, ackMs = 100) {
  const root = mkdtempSync(join(tmpdir(), "ash-screens-"));
  const ledger = await Ledger.open(join(root, "ash.db"));
  const world = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(world);
  members.register(new OwnerMember("Owner", ledger));
  const edge = new EdgeRouter(ledger, world, members, { api: {}, mcp: {} }, { clock, screenAckMs: ackMs });
  members.register(new PostPresenceMember((screen) => edge.screens.markVisible(screen)));
  return { ledger, world, members, edge };
}

async function tab(edge: EdgeRouter, label: string) {
  const response = await edge.handle(req("GET", `/api/stream?after=0&follow=true&label=${encodeURIComponent(label)}`), owner);
  assert.equal(response.status, 200);
  assert.ok("stream" in response);
  let output = "";
  let close = () => {};
  response.stream((chunk) => { output += chunk; }, (cleanup) => { close = cleanup; }, () => {});
  const match = /^event: screen\.registered\ndata: (.+)\n\n/.exec(output);
  assert.ok(match);
  const registration = JSON.parse(match[1]) as { screen: string; token: string; label: string };
  return { ...registration, output: () => output, close };
}

test("two live tabs receive only their own ui.open command; only the target may ACK actual navigation", async () => {
  const f = await fixture();
  const a = await tab(f.edge, "Tab A");
  const b = await tab(f.edge, "Tab B");
  try {
    const listed = f.members.describe("agent");
    assert.deepEqual(listed.members.filter((member) => member.kind === "screen").map((member) => member.id).sort(), [a.screen, b.screen].sort());
    assert.equal(f.members.describe("agent", a.screen).members[0].online, true);
    const sent = await f.world.send(agent, { to: a.screen, kind: "request", word: "ui.open", body: { target: "memory", mode: "perform" } });
    assert.ok(a.output().includes(`"id":"${sent.id}"`));
    assert.ok(!b.output().includes(`"id":"${sent.id}"`), "another live tab must not receive a target command");
    const answer = { to: "agent:main", kind: "response", word: "ui.open", reply_to: sent.id, body: { ok: true, result: { opened: true } }, client_id: "open-ack-1" };
    const other = await f.edge.handle(req("POST", "/api/send", answer, { "ash-screen": b.token }), owner);
    assert.equal(other.status, 400);
    const forged = await f.edge.handle(req("POST", "/api/send", { ...answer, from: a.screen }, { "ash-screen": b.token }), owner);
    assert.equal(forged.status, 400);
    const unregistered = await f.edge.handle(req("POST", "/api/send", answer), owner);
    assert.equal(unregistered.status, 400);
    assert.equal(f.ledger.responseTo(sent.id), null);
    const correct = await f.edge.handle(req("POST", "/api/send", answer, { "ash-screen": a.token }), owner);
    assert.equal(correct.status, 200);
    const reply = f.ledger.responseTo(sent.id)!;
    assert.equal(reply.from, a.screen);
    assert.equal((reply.body.result as { opened: boolean }).opened, true);
    assert.deepEqual(reply.origin, { screen: a.screen, label: "Tab A" });
    const retry = await f.edge.handle(req("POST", "/api/send", answer, { "ash-screen": a.token }), owner);
    assert.equal(body(retry).id, body(correct).id);
    assert.equal(f.ledger.list().filter((message) => message.reply_to === sent.id).length, 1);
    const tampered = await f.edge.handle(req("POST", "/api/send", { ...answer, body: { ok: true, result: { opened: false } } }, { "ash-screen": a.token }), owner);
    assert.equal(tampered.status, 400);
    const history = await f.edge.handle(req("GET", "/api/stream?after=0&follow=false"), owner);
    let audit = "";
    if ("stream" in history) history.stream((chunk) => { audit += chunk; }, () => {}, () => {});
    assert.ok(audit.includes(`"id":"${sent.id}"`), "finite owner history retains the target command for audit");
  } finally { a.close(); b.close(); f.ledger.close(); }
});

test("suggest needs target-tab rendered ACK false; missing, disconnected or late ACK never becomes success", async () => {
  const f = await fixture(undefined, 50);
  const a = await tab(f.edge, "Suggestions");
  try {
    const suggestion = await f.world.send(agent, { to: a.screen, kind: "request", word: "ui.open", body: { target: "activity", mode: "suggest" } });
    assert.equal(f.ledger.responseTo(suggestion.id), null, "SSE delivery alone is not a result");
    const ack = await f.edge.handle(req("POST", "/api/send", { to: "agent:main", kind: "response", word: "ui.open", reply_to: suggestion.id, body: { ok: true, result: { opened: false } } }, { "ash-screen": a.token }), owner);
    assert.equal(ack.status, 200);
    assert.equal((f.ledger.responseTo(suggestion.id)?.body.result as { opened: boolean }).opened, false);
    const pending = await f.world.send(agent, { to: a.screen, kind: "request", word: "ui.open", body: { target: "memory", mode: "perform" }, wait: true });
    assert.equal((pending.reply?.body.result as { opened: boolean }).opened, false, "unconfirmed command has a finite false result");
    const late = await f.edge.handle(req("POST", "/api/send", { to: "agent:main", kind: "response", word: "ui.open", reply_to: pending.id, body: { ok: true, result: { opened: true } } }, { "ash-screen": a.token }), owner);
    assert.equal(late.status, 400);
    assert.equal(f.ledger.list().filter((message) => message.reply_to === pending.id).length, 1);
    a.close();
    const offline = await f.world.send(agent, { to: a.screen, kind: "request", word: "ui.open", body: { target: "memory", mode: "perform" }, wait: true });
    assert.equal((offline.reply?.body.result as { opened: boolean }).opened, false);
    assert.equal(f.members.describe("agent", a.screen).members[0].online, false);
  } finally { a.close(); f.ledger.close(); }
});

test("closing a target stream settles its unacknowledged ui.open false without waiting for the general timeout", async () => {
  const f = await fixture(undefined, 5_000);
  const screen = await tab(f.edge, "Closing");
  try {
    const started = Date.now();
    const pending = f.world.send(agent, { to: screen.screen, kind: "request", word: "ui.open", body: { target: "activity", mode: "perform" }, wait: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    screen.close();
    const result = await pending;
    assert.equal((result.reply?.body.result as { opened: boolean }).opened, false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(f.ledger.list().filter((message) => message.reply_to === result.id).length, 1);
  } finally { screen.close(); f.ledger.close(); }
});

test("expired registration and revoked owner proxy cannot ACK; the original command settles once", async () => {
  let now = 10_000;
  const f = await fixture(() => now, 40);
  const a = await tab(f.edge, "Expiry");
  try {
    const sent = await f.world.send(agent, { to: a.screen, kind: "request", word: "ui.open", body: { target: "settings", mode: "perform" } });
    const answer = { to: "agent:main", kind: "response", word: "ui.open", reply_to: sent.id, body: { ok: true, result: { opened: true } } };
    const revoked = await f.edge.handle(req("POST", "/api/send", answer, { "ash-screen": a.token }), { ...owner, ownerProxy: false });
    assert.equal(revoked.status, 403);
    assert.equal(f.ledger.responseTo(sent.id), null);
    now += 86_400_001;
    const expired = await f.edge.handle(req("POST", "/api/send", answer, { "ash-screen": a.token }), owner);
    assert.equal(expired.status, 403);
    const until = Date.now() + 1000;
    while (!f.ledger.responseTo(sent.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((f.ledger.responseTo(sent.id)?.body.result as { opened: boolean }).opened, false);
    assert.equal(f.ledger.list().filter((message) => message.reply_to === sent.id).length, 1);
    assert.equal(f.members.describe("agent").members.some((member) => member.id === a.screen), false);
  } finally { a.close(); f.ledger.close(); }
});

test("visible heartbeats use registered screen identity and expire after sixty seconds", async () => {
  let now = 100_000;
  const f = await fixture(() => now);
  const a = await tab(f.edge, "Presence");
  try {
    assert.equal(f.edge.screens.visible(a.screen), false);
    const visible = await f.edge.handle(req("POST", "/api/send", { to: "service:post", kind: "event", word: "visible", body: {} }, { "ash-screen": a.token }), owner);
    assert.equal(visible.status, 200);
    assert.equal(f.ledger.byId(body(visible).id)?.from, a.screen);
    assert.equal(f.edge.screens.visible(a.screen), true);
    now += 60_001;
    assert.equal(f.edge.screens.visible(a.screen), false);
    const unauth = await f.edge.handle(req("POST", "/api/send", { to: "service:post", kind: "event", word: "visible", body: {} }), owner);
    assert.equal(unauth.status, 403);
    assert.equal(f.edge.screens.visible(a.screen), false);
  } finally { a.close(); f.ledger.close(); }
});

test("owner asks remain router-owned and accept only one offered cross-screen answer", async () => {
  const f = await fixture();
  const a = await tab(f.edge, "Ask A");
  const b = await tab(f.edge, "Ask B");
  try {
    const question = { to: "person:owner", kind: "request" as const, word: "ask", body: { title: "Approval", detail: "Synthetic", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: Date.now() + 60_000, source: { word: "run", to: "device:fake", body_preview: "Synthetic" } } };
    const asked = await f.world.send(agent, question);
    assert.equal(f.ledger.responseTo(asked.id), null);
    const answer = { to: "agent:main", kind: "response", word: "ask", reply_to: asked.id, body: { ok: true, result: { choice: "once" } } };
    const invalid = await f.edge.handle(req("POST", "/api/send", { ...answer, body: { ok: true, result: { choice: "always" } } }, { "ash-screen": a.token }), owner);
    assert.equal(invalid.status, 400);
    assert.equal(f.ledger.responseTo(asked.id), null);
    const accepted = await f.edge.handle(req("POST", "/api/send", answer, { "ash-screen": b.token }), owner);
    assert.equal(accepted.status, 200);
    assert.equal(f.ledger.responseTo(asked.id)?.from, "person:owner");
    assert.equal(f.ledger.responseTo(asked.id)?.origin?.screen, b.screen);
    const second = await f.edge.handle(req("POST", "/api/send", { ...answer, body: { ok: true, result: { choice: "deny" } } }, { "ash-screen": a.token }), owner);
    assert.equal(second.status, 400);
    assert.equal(f.ledger.list().filter((message) => message.reply_to === asked.id).length, 1);
  } finally { a.close(); b.close(); f.ledger.close(); }
});

test("an unanswered ask remains answerable after router restart without a second ask", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-ask-restart-"));
  const file = join(root, "ash.db");
  const firstLedger = await Ledger.open(file);
  const ask = firstLedger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "ask", body: {
    title: "Restart", detail: "Synthetic", options: [{ id: "deny", label: "No" }], expires_at: Date.now() + 60_000,
    source: { word: "run", to: "device:fake", body_preview: "Synthetic" },
  } }, undefined, { deadlineAt: Date.now() + 60_000,
    context: { member: "agent:main", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false } }).message;
  firstLedger.advanceRequest(ask.id, "accepted", "dispatching");
  firstLedger.close();
  const ledger = await Ledger.open(file);
  const world = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(world);
  members.register(new OwnerMember("Owner", ledger));
  const edge = new EdgeRouter(ledger, world, members, { api: {}, mcp: {} });
  const screen = await tab(edge, "After restart");
  try {
    await world.recover();
    assert.equal(ledger.responseTo(ask.id), null);
    const reply = await edge.handle(req("POST", "/api/send", { to: "agent:main", kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { choice: "deny" } } }, { "ash-screen": screen.token }), owner);
    assert.equal(reply.status, 200);
    assert.equal(ledger.responseTo(ask.id)?.body.ok, true);
    assert.equal(ledger.list().filter((message) => message.id === ask.id).length, 1);
    assert.equal(ledger.list().filter((message) => message.reply_to === ask.id).length, 1);
  } finally { screen.close(); ledger.close(); }
});
