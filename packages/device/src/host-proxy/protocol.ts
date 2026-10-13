import type { Frame } from "./types";
export function decodeFrame(data: unknown, maxBytes = 1024 * 1024): Frame {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (Buffer.byteLength(text) > maxBytes) throw Error("frame budget");
  const v = JSON.parse(text); depth(v);
  if (!v || typeof v !== "object" || Array.isArray(v) || ("method" in v && ("result" in v || "error" in v)) || ("result" in v && "error" in v)) throw Error("invalid frame");
  if ("id" in v && !(typeof v.id === "string" || (typeof v.id === "number" && Number.isSafeInteger(v.id)))) throw Error("invalid id");
  if ("method" in v) { if (typeof v.method !== "string") throw Error("invalid method"); }
  else if (!("id" in v) || !("result" in v || "error" in v)) throw Error("invalid response");
  return v;
}
function depth(v: unknown, n = 0): void { if (n > 24) throw Error("frame depth"); if (v && typeof v === "object") for (const x of Object.values(v)) depth(x, n + 1); }
export function identity(v: unknown): v is string { return typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 1024 && !/[\x00-\x1f]/.test(v); }
export function keys(v: unknown, allowed: readonly string[]): asserts v is Record<string, any> { if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw Error("parameters denied"); }
