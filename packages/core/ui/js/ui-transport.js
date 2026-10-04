import { workspaceFileUrl } from "./conversation.js";

const CORE_HOST = "127.0.0.1";

/** The page may only name a path on the core it was loaded from; which paths exist and who may use them is the core's call. */
function approved(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) throw new Error("unapproved UI route");
  const url = new URL(path, "http://ui.invalid");
  if (url.origin !== "http://ui.invalid" || url.username || url.password || url.pathname !== path.split("?")[0]) throw new Error("unapproved UI route");
  return url.pathname === "/api/stream" ? "stream" : "request";
}

export function validateCoreEndpoint(endpoint) {
  if (typeof endpoint !== "string") throw new Error("logical core endpoint required");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== CORE_HOST || !url.port || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || url.origin !== endpoint) throw new Error("invalid logical core endpoint");
  return endpoint;
}

/** Browser requests remain same-origin; the injected mode has no implicit fetch fallback. */
export function browserUiTransport(fetchImpl = globalThis.fetch.bind(globalThis)) {
  return {
    embedded: false,
    isReady: () => true,
    allowsQueueFlush: () => true,
    whenReady: () => Promise.resolve(),
    request(path, options) { approved(path); return fetchImpl(path, options); },
  };
}

/** Only the trusted native asset page bootstrap releases this latch. */
export function embeddedUiTransport({ request, endpoint }) {
  if (typeof request !== "function") throw new Error("native transport required");
  const logicalEndpoint = validateCoreEndpoint(endpoint);
  let state = "waiting";
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return Object.freeze({
    embedded: true,
    endpoint: logicalEndpoint,
    isReady: () => state === "ready",
    allowsQueueFlush: () => state === "ready",
    whenReady: () => ready,
    authorizeReady() { if (state !== "waiting") throw new Error("transport latch already settled"); state = "ready"; release(); },
    hold() { if (state === "ready") throw new Error("ready transport cannot return to hold"); state = "held"; },
    request(path, options) {
      const operation = approved(path);
      if (state !== "ready") throw new Error("native transport not ready");
      return request(operation, path, options);
    },
  });
}

export async function readWorkspaceFile(transport, ref) {
  const path = workspaceFileUrl(ref);
  if (!path) throw new Error("invalid workspace file reference");
  const response = await transport.request(path, { method: "GET", credentials: "same-origin" });
  if (!response.ok) throw new Error(`file HTTP ${response.status}`);
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > 20 * 1024 * 1024) throw new Error("workspace file too large");
  if (!response.body) throw new Error("workspace file unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 20 * 1024 * 1024) throw new Error("workspace file too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Blob(chunks, { type: response.headers?.get?.("content-type") || "application/octet-stream" });
}
