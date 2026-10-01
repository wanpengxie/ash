const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function safeName(name) {
  return typeof name === "string" ? [...name.replace(/[\\/\x00-\x1f\x7f]/g, "_")].slice(0, 180).join("") || "attachment" : "attachment";
}

function rasterBytes(type, bytes) {
  if (type === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((part, i) => bytes[i] === part);
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)));
  if (type === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

/** Decode only original authorized ledger bytes, never a projected or guessed file path. */
export function decodeInlineAttachment(item) {
  if (!item || typeof item.data !== "string" || typeof item.mime_type !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) || item.data.length % 4 !== 0 || item.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) throw new Error("invalid attachment data");
  const binary = atob(item.data);
  if (btoa(binary) !== item.data || binary.length > MAX_FILE_BYTES) throw new Error("invalid attachment encoding or size");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const declared = item.mime_type.toLowerCase();
  const preview = RASTER.has(declared) && rasterBytes(declared, bytes);
  return { name: safeName(item.name), bytes, mime_type: preview ? declared : "application/octet-stream", preview };
}

export function openInlineBlob(item) {
  const decoded = decodeInlineAttachment(item);
  const url = URL.createObjectURL(new Blob([decoded.bytes], { type: decoded.mime_type }));
  let revoked = false;
  return { url, name: decoded.name, preview: decoded.preview, revoke() { if (!revoked) { URL.revokeObjectURL(url); revoked = true; } } };
}
