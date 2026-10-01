const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const COMPACTABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/bmp"]);
const MAX_REQUEST_BYTES = 28 * 1024 * 1024;

function safeName(name) {
  return typeof name === "string" ? [...name.replace(/[\\/\x00-\x1f\x7f]/g, "_")].slice(0, 180).join("") || "attachment" : "attachment";
}

function rasterBytes(type, bytes) {
  if (type === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((part, i) => bytes[i] === part);
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)));
  if (type === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (type === "image/bmp") return bytes.length >= 2 && bytes[0] === 66 && bytes[1] === 77;
  if (type === "image/heic" || type === "image/heif") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
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

export function openInlineBlob(item, expected = null) {
  const decoded = decodeInlineAttachment(item);
  if (expected && (item.name !== expected.name || item.mime_type !== expected.mime_type || decoded.bytes.length !== expected.size || RASTER.has(expected.mime_type.toLowerCase()) && !decoded.preview)) throw new Error("attachment differs from ledger summary");
  const url = URL.createObjectURL(new Blob([decoded.bytes], { type: decoded.mime_type }));
  let revoked = false;
  return { url, name: decoded.name, preview: decoded.preview, revoke() { if (!revoked) { URL.revokeObjectURL(url); revoked = true; } } };
}

async function compactImage(file) {
  if (!COMPACTABLE.has(file.type) || typeof createImageBitmap !== "function" || typeof document === "undefined") return { selected: file, name: file.name };
  let image;
  try {
    image = await createImageBitmap(file);
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 32768 || image.height > 32768) throw new Error("image dimensions unsupported");
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image canvas unavailable");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const compacted = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (compacted?.type !== "image/jpeg" || !compacted.size || compacted.size >= file.size) return { selected: file, name: file.name };
    const stem = file.name.replace(/\.[^./\\]+$/, "") || "image";
    return { selected: compacted, name: `${stem}.jpg` };
  } catch { return { selected: file, name: file.name }; }
  finally { image?.close(); }
}

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(binary);
}

/** Preserve files and animation; shrink decodable static images only when the result is smaller. */
export async function prepareUploads(files, text = "") {
  if (files.length > 32) throw new Error("too many attachments");
  const attachments = [];
  for (const file of files) {
    if (!file || typeof file.arrayBuffer !== "function" || file.size > 80 * 1024 * 1024) throw new Error("attachment too large");
    const original = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const image = COMPACTABLE.has(file.type) && rasterBytes(file.type, original);
    const { selected, name } = image ? await compactImage(file) : { selected: file, name: file.name };
    if (selected.size < 1 || selected.size > MAX_FILE_BYTES) throw new Error("attachment exceeds 20 MiB");
    attachments.push({ name: safeName(name), mime_type: typeof selected.type === "string" && selected.type ? selected.type : "application/octet-stream", data: base64(new Uint8Array(await selected.arrayBuffer())) });
  }
  const body = { text, ...(attachments.length ? { attachments } : {}) };
  const wire = { to: "agent:main", kind: "request", word: "say", body, client_id: "0".repeat(36) };
  if (new TextEncoder().encode(JSON.stringify(wire)).byteLength > MAX_REQUEST_BYTES) throw new Error("message exceeds request limit");
  return attachments;
}
