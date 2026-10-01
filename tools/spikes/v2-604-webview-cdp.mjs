// Probe only an isolated WebView debugging socket and a disposable owner database.
// Arguments: local CDP port and the temporary fixture directory. No bearer value is printed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [portText, directory] = process.argv.slice(2);
const port = Number(portText);
const marker = `webview synthetic attachment ${randomUUID()}`;
if (!Number.isInteger(port) || port !== 14765 || !directory?.startsWith("/tmp/ash-cross-device-"))
  throw new Error("isolated CDP port and temporary fixture directory required");

async function until(check, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
assert.equal(targets.length, 1, "debug port must expose exactly one isolated page");
const target = targets[0];
const pageUrl = new URL(target.url);
assert.equal(pageUrl.origin, "http://127.0.0.1:14762");
assert.equal(pageUrl.pathname, "/");
assert.ok(target.webSocketDebuggerUrl);
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let next = 1;
socket.addEventListener("message", (event) => {
  const packet = JSON.parse(event.data);
  const callback = pending.get(packet.id);
  if (!callback) return;
  pending.delete(packet.id);
  packet.error ? callback.reject(new Error("CDP command failed")) : callback.resolve(packet.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const answer = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (answer.exceptionDetails) throw new Error("WebView evaluation failed");
  return answer.result?.value;
};
let db;
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("isolated CDP connection failed")), { once: true });
  });
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await until(() => evaluate("document.querySelector('#connection')?.dataset.transport === 'online'"), "isolated WebView registration");

  const originalBytes = await evaluate(`(async () => {
    const canvas=document.createElement('canvas');canvas.width=4096;canvas.height=1024;
    const context=canvas.getContext('2d');const pixels=context.createImageData(canvas.width,canvas.height);
    let random=0x12345678;
    for(let i=0;i<pixels.data.length;i+=4){random^=random<<13;random^=random>>>17;random^=random<<5;
      pixels.data[i]=random&255;pixels.data[i+1]=(random>>>8)&255;pixels.data[i+2]=(random>>>16)&255;pixels.data[i+3]=255;}
    context.putImageData(pixels,0,0);
    const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const files=new DataTransfer();
    files.items.add(new File([image],'webview-synthetic.png',{type:'image/png'}));
    files.items.add(new File(['WEBVIEW_SYNTHETIC_BYTES'],'webview-note.txt',{type:'text/plain'}));
    document.querySelector('#file').files=files.files;
    document.querySelector('#t').value=${JSON.stringify(marker)};
    document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    return image.size;
  })()`);
  assert.ok(originalBytes > 1_000_000);

  db = new DatabaseSync(join(directory, "ash.db"), { readOnly: true });
  const row = await until(() => db.prepare("SELECT id,body FROM messages WHERE \"from\"='person:owner' AND word='say' AND json_extract(body,'$.text')=? ORDER BY seq DESC LIMIT 1").get(marker), "durable attachment message");
  const body = JSON.parse(row.body);
  assert.equal(body.attachments.length, 2);
  const [image, file] = body.attachments;
  assert.equal(image.name, "webview-synthetic.jpg");
  assert.equal(image.mime_type, "image/jpeg");
  assert.ok(Buffer.from(image.data, "base64").length < originalBytes, "WebView image should compact without increasing bytes");
  assert.equal(file.name, "webview-note.txt");
  assert.equal(file.mime_type, "text/plain");
  assert.equal(Buffer.from(file.data, "base64").toString(), "WEBVIEW_SYNTHETIC_BYTES");
  await until(() => evaluate(`(() => { const owner=[...document.querySelectorAll('#log .msg.me')].find(x=>x.textContent.includes(${JSON.stringify(marker)})); return !!owner && [...owner.querySelectorAll('button.attachment')].some(x=>x.textContent==='webview-synthetic.jpg') && [...owner.querySelectorAll('button.attachment')].some(x=>x.textContent==='webview-note.txt'); })()`), "WebView attachment references");
  await evaluate(`(() => { const owner=[...document.querySelectorAll('#log .msg.me')].find(x=>x.textContent.includes(${JSON.stringify(marker)})); [...owner.querySelectorAll('button.attachment')].find(x=>x.textContent==='webview-synthetic.jpg').click(); })()`);
  await until(() => evaluate("[...document.querySelectorAll('#log .atts img')].some(x=>x.naturalWidth===2048&&x.naturalHeight===512)"), "WebView image preview");

  // A blocked history/stream request after reload is an explicit connection failure,
  // not evidence that the OS reports an already-open but silent socket as offline.
  await call("Network.setBlockedURLs", { urls: ["*api/stream*"] });
  await call("Page.reload", { ignoreCache: true });
  await until(() => evaluate("document.querySelector('#connection')?.dataset.transport === 'offline'"), "explicit stream failure indicator");
  await call("Network.setBlockedURLs", { urls: [] });
  await until(() => evaluate("document.querySelector('#connection')?.dataset.transport === 'online'"), "stream retry after unblock");
  await until(() => evaluate(`[...document.querySelectorAll('#log .msg.me')].filter(x=>x.textContent.includes(${JSON.stringify(marker)})).length===1`), "replayed attachment bubble once");
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE id=?").get(row.id).n, 1);
  console.log(JSON.stringify({ result: "PASS", browser: "isolated Android WebView", imageOriginalBytes: originalBytes,
    imageStoredBytes: Buffer.from(image.data, "base64").length, previewDimensions: [2048, 512], fileBytesPreserved: true,
    explicitStreamFailureIndicator: true, reconnectDeduplicated: true }));
} finally {
  db?.close();
  socket.close();
}
