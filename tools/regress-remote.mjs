#!/usr/bin/env node
// Temporary paired-browser regression against the production v2 routes.
// GATEWAY_TICKET is a five-minute owner ticket supplied by the test setup.
import { randomUUID } from "node:crypto";
import { DeviceKey, GatewayClient } from "ash-gateway/client/client.ts";

const [cmd] = process.argv.slice(2);
const GW = (process.env.GATEWAY_URL ?? "").replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stdin = async () => JSON.parse(await new Promise((resolve) => {
  let value = "";
  process.stdin.on("data", (chunk) => { value += chunk; }).on("end", () => resolve(value));
}));

async function admin(word, body) {
  const response = await fetch(`${process.env.ASH_URL}/api/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.ASH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "service:admin", kind: "request", word, body, wait: true, client_id: randomUUID() }),
  });
  if (!response.ok) throw new Error(`local ${word}: HTTP ${response.status}`);
  const reply = (await response.json()).reply?.body;
  if (reply?.ok !== true) throw new Error(`local ${word} was not accepted`);
  return reply.result;
}

async function pair(name) {
  if (!process.env.GATEWAY_TICKET) throw new Error("GATEWAY_TICKET is required");
  const key = await DeviceKey.generate();
  const gateway = new GatewayClient(GW, key);
  const request = await gateway.requestPairing(process.env.GATEWAY_TICKET, name);
  let pending;
  for (let attempt = 0; attempt < 40 && !pending; attempt++) {
    pending = (await admin("gateway.state", {}))?.pending?.find((item) => item.request_id === request.request_id);
    if (!pending) await sleep(500);
  }
  if (!pending) throw new Error("pairing request not seen by owner");
  await admin("gateway.op", { op: "approve", request_id: pending.request_id, permissions: ["chat", "web_ui"] });
  await gateway.waitForApproval(request.request_id, request.owner_key);
  return { id: key.id, jwk: await key.exportJwk() };
}

async function cookieFor(pairing) {
  const key = await DeviceKey.fromJwk(pairing.jwk);
  const session = await new GatewayClient(GW, key).authenticate();
  return `ash_session=${session.token}`;
}

async function* frames(response) {
  if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const lines = buffer.slice(0, boundary).split("\n");
      buffer = buffer.slice(boundary + 2);
      const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (!data) continue;
      yield { type: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message",
        id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? "", data: JSON.parse(data) };
    }
  }
}

async function latestSeq(cookie) {
  const response = await fetch(`${GW}/api/stream?follow=false&limit=1`, { headers: { cookie, accept: "text/event-stream" } });
  let last = 0;
  for await (const frame of frames(response)) if (frame.id && Number.isSafeInteger(Number(frame.id))) last = Math.max(last, Number(frame.id));
  return last;
}

async function web() {
  const pairing = await pair(`regress browser ${Date.now() % 100000}`);
  const controller = new AbortController();
  try {
    const cookie = await cookieFor(pairing);
    const page = await fetch(`${GW}/`, { headers: { cookie, accept: "text/html" } });
    if (page.status !== 200 || !(await page.text()).includes("<title>Ash</title>")) throw new Error(`UI HTTP ${page.status}`);
    const after = await latestSeq(cookie);
    const stream = await fetch(`${GW}/api/stream?follow=true&after=${after}&label=Regression`, {
      headers: { cookie, accept: "text/event-stream" }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]),
    });
    const events = frames(stream)[Symbol.asyncIterator]();
    let registration;
    while (!registration) {
      const event = await events.next();
      if (event.done) throw new Error("screen stream ended before registration");
      if (event.value.type === "screen.registered") registration = event.value.data;
    }
    if (!registration?.token || !registration?.screen || registration.local_management !== false) throw new Error("bad remote screen registration");
    const sent = await fetch(`${GW}/api/send`, {
      method: "POST",
      headers: { cookie, origin: new URL(GW).origin, "content-type": "application/json", "Ash-Screen": registration.token },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "只回复两个字：收到" }, client_id: randomUUID() }),
    });
    if (!sent.ok) throw new Error(`remote send HTTP ${sent.status}`);
    const id = (await sent.json()).id;
    if (!id) throw new Error("remote message not accepted");
    let turn = "", answer = "", ended;
    while (!ended) {
      const event = await events.next();
      if (event.done) throw new Error("screen stream ended before reply");
      const row = event.value.data;
      if (row.word === "turn.start" && row.body?.ids?.includes(id)) turn = row.body.turn;
      if (turn && row.turn === turn && row.from === "agent:main" && row.to === "person:owner" && row.word === "say") answer += row.body?.text ?? "";
      if (turn && row.word === "turn.end" && row.body?.turn === turn) ended = row;
    }
    if (!answer) throw new Error(`remote turn ended without answer (${ended.body?.reason})`);
    console.log(`    streamed answer: ${answer.slice(0, 80)} (screen: ${registration.screen})`);
  } finally {
    controller.abort();
    await admin("gateway.op", { op: "revoke", device: `device:${pairing.id}` }).catch(() => {});
  }
}

// S14: two screens at once. A local screen (the phone's API) and a remote browser through the gateway see each
// other's messages with the right source label, and the remote one cannot reach administration.
async function cross() {
  const pairing = await pair(`regress cross ${Date.now() % 100000}`);
  const controller = new AbortController();
  const local = new AbortController();
  try {
    const cookie = await cookieFor(pairing);
    const remoteStream = await fetch(`${GW}/api/stream?follow=true&label=Mac%20browser`, { headers: { cookie, accept: "text/event-stream" }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
    const remoteEvents = frames(remoteStream)[Symbol.asyncIterator]();
    let remote;
    while (!remote) { const e = await remoteEvents.next(); if (e.done) throw new Error("remote stream ended"); if (e.value.type === "screen.registered") remote = e.value.data; }
    const localStream = await fetch(`${process.env.ASH_URL}/api/stream?follow=true&label=Phone%20screen`, { headers: { authorization: `Bearer ${process.env.ASH_TOKEN}`, accept: "text/event-stream" }, signal: AbortSignal.any([local.signal, AbortSignal.timeout(120_000)]) });
    const localEvents = frames(localStream)[Symbol.asyncIterator]();
    let phone;
    while (!phone) { const e = await localEvents.next(); if (e.done) throw new Error("local stream ended"); if (e.value.type === "screen.registered") phone = e.value.data; }
    const waitFor = async (events, match, label) => { const end = Date.now() + 30_000; while (Date.now() < end) { const e = await Promise.race([events.next(), sleep(30_000).then(() => ({ done: true }))]); if (e.done) break; if (e.value.data && match(e.value.data)) return e.value.data; } throw new Error(`${label} was not seen`); };
    const fromPhone = `phone-${randomUUID().slice(0, 6)}`, fromMac = `mac-${randomUUID().slice(0, 6)}`;
    const sendLocal = await fetch(`${process.env.ASH_URL}/api/send`, { method: "POST", headers: { authorization: `Bearer ${process.env.ASH_TOKEN}`, "Ash-Screen": phone.token, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: `只回复ok ${fromPhone}` }, client_id: randomUUID() }) });
    if (!sendLocal.ok) throw new Error(`phone send HTTP ${sendLocal.status}`);
    const seenOnMac = await waitFor(remoteEvents, (row) => row.word === "say" && row.body?.text?.includes(fromPhone), "the phone's message on the Mac browser");
    const sendRemote = await fetch(`${GW}/api/send`, { method: "POST", headers: { cookie, origin: new URL(GW).origin, "Ash-Screen": remote.token, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: `只回复ok ${fromMac}` }, client_id: randomUUID() }) });
    if (!sendRemote.ok) throw new Error(`mac send HTTP ${sendRemote.status}`);
    const seenOnPhone = await waitFor(localEvents, (row) => row.word === "say" && row.body?.text?.includes(fromMac), "the Mac browser's message on the phone");
    const adminAttempt = await fetch(`${GW}/api/send`, { method: "POST", headers: { cookie, origin: new URL(GW).origin, "Ash-Screen": remote.token, "content-type": "application/json" },
      body: JSON.stringify({ to: "service:admin", kind: "request", word: "pause", body: {}, client_id: randomUUID() }) });
    console.log(JSON.stringify({ phone_message_on_mac: { origin: seenOnMac.origin?.label ?? null }, mac_message_on_phone: { origin: seenOnPhone.origin?.label ?? null },
      mac_admin_status: adminAttempt.status, mac_management: remote.local_management }));
  } finally {
    controller.abort(); local.abort();
    await admin("gateway.op", { op: "revoke", device: `device:${pairing.id}` }).catch(() => {});
  }
}

// Keeps a remote browser screen in front of Ash for a while (visible heartbeats) so a test can ask what Ash does when the owner is elsewhere.
async function hold() {
  const seconds = Number(process.env.HOLD_SECONDS ?? 120);
  const pairing = await pair(`regress hold ${Date.now() % 100000}`);
  const controller = new AbortController();
  try {
    const cookie = await cookieFor(pairing);
    const stream = await fetch(`${GW}/api/stream?follow=true&label=Computer%20browser`, { headers: { cookie, accept: "text/event-stream" }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(seconds * 1000 + 15_000)]) });
    const events = frames(stream)[Symbol.asyncIterator]();
    let remote;
    while (!remote) { const e = await events.next(); if (e.done) throw new Error("stream ended"); if (e.value.type === "screen.registered") remote = e.value.data; }
    console.log("holding", remote.screen);
    const end = Date.now() + seconds * 1000;
    (async () => { while (Date.now() < end) { await events.next().catch(() => ({})); } })();
    while (Date.now() < end) {
      await fetch(`${GW}/api/send`, { method: "POST", headers: { cookie, origin: new URL(GW).origin, "Ash-Screen": remote.token, "content-type": "application/json" },
        body: JSON.stringify({ to: "service:post", kind: "event", word: "visible", body: {}, client_id: randomUUID() }) });
      await sleep(20_000);
    }
  } finally { controller.abort(); await admin("gateway.op", { op: "revoke", device: `device:${pairing.id}` }).catch(() => {}); }
}

if (cmd === "web") await web();
else if (cmd === "hold") await hold();
else if (cmd === "cross") await cross();
else if (cmd === "pair") console.log(JSON.stringify(await pair(`regress offline ${Date.now() % 100000}`)));
else if (cmd === "status") {
  const pairing = await stdin();
  const cookie = await cookieFor(pairing).catch(() => "");
  console.log((await fetch(`${GW}/`, { headers: { cookie, accept: "text/html" } })).status);
} else if (cmd === "unpair") {
  const pairing = await stdin();
  await admin("gateway.op", { op: "revoke", device: `device:${pairing.id}` });
} else {
  console.error("usage: regress-remote.mjs web|pair|status|unpair");
  process.exitCode = 1;
}
