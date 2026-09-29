#!/usr/bin/env node
// Regression helper: a temporary "browser" paired through the phone's ash core.
//   web     pair, load the UI and /api through the gateway, send a message, read the streamed answer, unpair
//   pair    pair and print {id, key(jwk), cookie} to stdout
//   status  (stdin: pair output) → HTTP status of GET / through the gateway
//   unpair  (stdin: pair output) → revoke it on the phone
// ASH_URL/ASH_TOKEN reach the phone's core (adb forward), GATEWAY_URL the gateway.

import { DeviceKey, GatewayClient } from "ash-gateway/client/client";

const [cmd] = process.argv.slice(2);
const GW = (process.env.GATEWAY_URL ?? "").replace(/\/$/, "");
const core = async (method, path, body) => {
  const r = await fetch(process.env.ASH_URL + path, { method, headers: { authorization: `Bearer ${process.env.ASH_TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stdin = async () => JSON.parse(await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => r(s)); }));

async function pair(name) {
  const { ticket } = await core("POST", "/api/gateway/ticket", {});
  const key = await DeviceKey.generate();
  const gw = new GatewayClient(GW, key);
  const pr = await gw.requestPairing(ticket, name);
  let pending;
  for (let i = 0; i < 40 && !pending; i++) {
    await sleep(500);
    pending = (await core("GET", "/api/gateway")).pending?.find((p) => p.name === name);
  }
  if (!pending) throw new Error("pairing request not seen by the phone");
  await core("POST", "/api/gateway/approve", { request_id: pending.request_id, permissions: ["chat", "web_ui"] });
  await gw.waitForApproval(pr.request_id, pr.owner_key);
  return { id: key.id, jwk: await key.exportJwk() };
}
async function cookieFor(p) {
  const key = await DeviceKey.fromJwk(p.jwk);
  const s = await new GatewayClient(GW, key).authenticate();
  return `ash_session=${s.token}`;
}

if (cmd === "web") {
  const p = await pair(`regress browser ${Date.now() % 100000}`);
  try {
    const cookie = await cookieFor(p);
    const H = { cookie, "content-type": "application/json", origin: new URL(GW).origin };
    const page = await fetch(`${GW}/`, { headers: { cookie, accept: "text/html" } });
    if (page.status !== 200 || !(await page.text()).includes("<title>Ash</title>")) throw new Error(`UI: ${page.status}`);
    const m = await (await fetch(`${GW}/api/manifest`, { headers: H })).json();
    if (m.me !== `device:${p.id}`) throw new Error(`manifest me=${m.me}`);
    const after = m.lastSeq;
    const ac = new AbortController();
    const sse = await fetch(`${GW}/api/events/stream?after=${after}`, { headers: { cookie, accept: "text/event-stream" }, signal: ac.signal });
    const id = `regress-web-${Date.now()}`;
    const d = await fetch(`${GW}/api/agents/agent:main/deliver`, { method: "POST", headers: H, body: JSON.stringify({ text: "只回复两个字：收到", message_id: id }) });
    if (d.status !== 200) throw new Error(`deliver: ${d.status}`);
    const dec = new TextDecoder();
    let buf = "", text = "", origin = "";
    const deadline = Date.now() + 240_000;
    for await (const chunk of sse.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
        buf = buf.slice(i + 2);
        if (!line) continue;
        const e = JSON.parse(line.slice(6));
        if (e.type === "message.delivered" && e.data.message_id === id) origin = e.data.origin;
        if (e.type === "agent.text" && e.data.message_id === id) text += e.data.text;
        if (e.type === "agent.turn.ended" && e.data.message_id === id) {
          ac.abort();
          console.log(`    streamed answer: ${text.slice(0, 80)} (origin: ${origin})`);
          if (!text) throw new Error(`turn ended without text: ${e.data.reason} ${e.data.error ?? ""}`);
          await core("POST", "/api/gateway/revoke", { device: `device:${p.id}` });
          process.exit(0);
        }
      }
      if (Date.now() > deadline) throw new Error("no answer in time");
    }
    throw new Error("stream ended early");
  } catch (e) {
    await core("POST", "/api/gateway/revoke", { device: `device:${p.id}` }).catch(() => {});
    console.error("    " + (e.message ?? e));
    process.exit(1);
  }
} else if (cmd === "pair") {
  console.log(JSON.stringify(await pair(`regress offline ${Date.now() % 100000}`)));
} else if (cmd === "status") {
  const p = await stdin();
  const cookie = await cookieFor(p).catch(() => "");
  const r = await fetch(`${GW}/`, { headers: { cookie, accept: "text/html" } });
  console.log(r.status);
} else if (cmd === "unpair") {
  const p = await stdin();
  await core("POST", "/api/gateway/revoke", { device: `device:${p.id}` });
} else {
  console.error("usage: regress-remote.mjs web|pair|status|unpair");
  process.exit(1);
}
