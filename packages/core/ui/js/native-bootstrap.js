// This file is embedded only in the APK's appassets page. The native listener is
// origin/main-frame bound; the owner credential never enters this page.
(() => {
  const native = globalThis.AshNative;
  if (!native || location.origin !== "https://appassets.androidplatform.net") return;
  const pending = new Map();
  let nextId = 0;
  let ready = false;
  const decode = (value) => Uint8Array.from(atob(value || ""), (char) => char.charCodeAt(0));
  const post = (value) => native.postMessage(JSON.stringify(value));

  globalThis.__ashJevKey = (operation, key) => {
    if (!ready || !["status", "save"].includes(operation)) return Promise.reject(new Error("native settings unavailable"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { jev: true, finish() { pending.delete(id); }, resolve, reject });
      post({ type: "jev", id, operation, ...(operation === "save" ? { key } : {}) });
    });
  };

  globalThis.__ashGatewayConfig = (operation, url = "", secret = "") => {
    if (!ready || !["status", "save"].includes(operation)) return Promise.reject(new Error("native settings unavailable"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      pending.set(id, { gatewayConfig: true, finish() { pending.delete(id); }, resolve, reject });
      post({ type: "gateway_config", id, operation, ...(operation === "save" ? { url, secret } : {}) });
    });
  };

  function request(operation, path, options = {}) {
    if (!ready) return Promise.reject(new Error("native transport unavailable"));
    const id = String(++nextId);
    const live = operation === "stream" && new URL(path, "http://ui.invalid").searchParams.get("follow") === "true";
    let resolve, reject, controller;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const signal = options.signal;
    const abort = () => {
      if (!pending.delete(id)) return;
      post({ type: "cancel", id });
      const error = new DOMException("Aborted", "AbortError");
      controller?.error(error);
      reject(error);
    };
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return result; }
    signal?.addEventListener("abort", abort, { once: true });
    pending.set(id, {
      finish() { pending.delete(id); signal?.removeEventListener("abort", abort); },
      started() {
        if (!live) return;
        resolve(new Response(new ReadableStream({ start(value) { controller = value; } }),
          { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
      chunk(value) { controller?.enqueue(decode(value)); },
      done(message) {
        this.finish();
        if (live) controller?.close();
        else resolve(new Response([204, 205, 304].includes(message.status) ? null : decode(message.body), { status: message.status,
          headers: { "content-type": message.content_type || "application/octet-stream" } }));
      },
      error() { this.finish(); const error = new Error("core request unavailable"); controller?.error(error); reject(error); },
    });
    post({ type: "request", id, operation, path, method: options.method || "GET",
      headers: Object.fromEntries(new Headers(options.headers || {}).entries()), body: options.body || null });
    return result;
  }

  native.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ready" && !ready) {
      ready = true;
      globalThis.__ashNativeBoot(request, message.endpoint);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    if (item.jev) {
      if (message.type === "jev_result") { item.finish(); item.resolve({ ok: message.ok === true, configured: message.configured === true }); }
      return;
    }
    if (item.gatewayConfig) {
      if (message.type === "gateway_config_result") { item.finish(); item.resolve({ ok: message.ok === true,
        configured: message.configured === true, url: typeof message.url === "string" ? message.url : "" }); }
      return;
    }
    if (message.type === "started") item.started();
    else if (message.type === "chunk") item.chunk(message.body);
    else if (message.type === "done") item.done(message);
    else if (message.type === "error") item.error();
  };
  post({ type: "hello" });
})();
