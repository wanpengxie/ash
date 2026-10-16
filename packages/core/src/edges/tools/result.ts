/**
 * What a tool call gives back (the coordinator's decision 5 of BUILD-PROGRESS §7, SPEC-02 §3.5):
 *
 *   success   {content: WordResult.content ?? [the data as JSON text], structuredContent: data}
 *   failure   {isError: true, content: [the error as JSON text], structuredContent: {error: ErrorBody}}
 *   receipt   a success whose data is {status, request_id | pending_id, ...}
 *
 * Images: at most 8, each at most 10 MB, 20 MB together, the bytes must be a PNG, JPEG, GIF or WebP; a failed call carries
 * none. A result over 60000 characters is kept as an attachment: the caller gets a 40000 character preview and the
 * reference to read the rest with `service:blobs/read`.
 */
import { errorBody, isErrorCode, type ErrorBody, type ErrorCode, type WordResult } from "../../../../sdk/src/message";
import type { ContentPart } from "../../../../sdk/src/link";

export const MAX_RESULT_CHARS = 60_000;
export const PREVIEW_CHARS = 40_000;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;

export type McpPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
/** The MCP `CallToolResult`. */
export interface Shaped { content: McpPart[]; structuredContent?: Record<string, unknown>; isError?: boolean }

/** An attachment of the recorded response (the ledger moved long content out of the message). */
export interface Attachment { hash: string; mime: string; size: number; path?: string }

const text = (value: string): McpPart => ({ type: "text", text: value });
const json = (value: unknown): string => JSON.stringify(value) ?? "null";

/** `structuredContent` must be an object; anything else a word returns is carried as `{value}`. */
const structured = (data: unknown): Record<string, unknown> | undefined =>
  data === undefined ? undefined : data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { value: data };

/** The image format the bytes are, whatever the part claims. */
function sniffImage(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function failure(code: ErrorCode, message: string, extra: { detail?: unknown; recovery_hint?: string } = {}): Shaped {
  return shapeError(errorBody(code, message.slice(0, 1000), extra));
}

/** An error, with a recovery hint, in the shape every tool failure has. A code that is not one of the fourteen becomes `internal`; a very long detail is cut. */
export function shapeError(error: ErrorBody): Shaped {
  const code = isErrorCode(error.code) ? error.code : "internal";
  let body = errorBody(code, String(error.message ?? "").slice(0, 2000), { detail: error.detail, recovery_hint: error.recovery_hint || undefined });
  if (json({ error: body }).length > MAX_RESULT_CHARS) body = { ...body, detail: { truncated: true, preview: json(error.detail).slice(0, PREVIEW_CHARS) } };
  return { isError: true, content: [text(json({ error: body }))], structuredContent: { error: body } };
}

/**
 * A word's result: images taken out under the limits. An over-long result is cut to a preview; `recorded` gives the
 * pieces of it the ledger kept when it recorded the response (none when it was not recorded: then only the preview).
 * The bounded ctx.read chunk travels inline without a raw attachment; only its live caller may receive those bytes.
 */
export function shapeSuccess(result: WordResult | undefined, recorded: () => Attachment[] = () => [], inlineContextRead = false): Shaped {
  const data = result?.data;
  const parts: ContentPart[] | undefined = result?.content;
  const content: McpPart[] = [];
  const images: McpPart[] = [];
  const textual: { type: "text"; text: string }[] = [];
  let chars = data === undefined ? 0 : json(data).length;
  let imageBytes = 0;

  for (const part of parts ?? []) {
    if (part.type === "text") { const p = text(part.text) as { type: "text"; text: string }; content.push(p); textual.push(p); chars += part.text.length; continue; }
    if (part.type === "resource") {
      const p = text(`[resource: stream ${part.stream}, ${part.mime}, ${part.size} bytes; it is not carried here]`) as { type: "text"; text: string };
      content.push(p); textual.push(p); continue;
    }
    const omitted = (why: string) => { const p = text(`[image omitted: ${why}]`) as { type: "text"; text: string }; content.push(p); textual.push(p); };
    const bytes = Buffer.from(String(part.b64).replace(/\s+/g, ""), "base64");
    const mimeType = sniffImage(bytes);
    if (!mimeType) omitted("not a PNG, JPEG, GIF or WebP image");
    else if (images.length >= MAX_IMAGES) omitted(`only the first ${MAX_IMAGES} images of one result are shown`);
    else if (bytes.length > MAX_IMAGE_BYTES || imageBytes + bytes.length > MAX_IMAGES_TOTAL_BYTES) omitted("too large to show");
    else { images.push({ type: "image", data: bytes.toString("base64"), mimeType }); imageBytes += bytes.length; }
  }
  if (!parts) content.push(text(json(data ?? {})));

  if (inlineContextRead || chars <= MAX_RESULT_CHARS) return { content: [...content, ...images], ...optional(structured(data)) };

  const full = json(textual.length ? { data, content: textual } : { data });
  const preview = full.slice(0, PREVIEW_CHARS);
  const attachments = recorded();
  const cut = { truncated: true, preview, ...(attachments.length ? { attachments } : {}),
    note: attachments.length ? "The result was too long to carry. Read the rest in pieces with service:blobs/read, using the hash of an attachment." : "The result was too long to carry and was not kept; ask for a smaller piece." };
  return { content: [text(json(cut)), ...images], structuredContent: cut };
}

const optional = (value: Record<string, unknown> | undefined) => (value ? { structuredContent: value } : {});

/** A success that is only data (a receipt, a list). */
export function plain(data: Record<string, unknown>): Shaped {
  return { content: [text(json(data))], structuredContent: data };
}

/** The same result without its image bytes, for the copy kept in the table. */
export function withoutImages(shaped: Shaped): Shaped {
  return { ...shaped, content: shaped.content.map((part) => (part.type === "image" ? text("[image: delivered with the first answer only]") : part)) };
}
