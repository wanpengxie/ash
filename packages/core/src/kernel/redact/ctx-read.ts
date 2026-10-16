/** Context-probe bytes are a caller result, never a control-plane message or stored attachment. */
import type { Reply } from "../../../../sdk/src/message";
import { errorBody, isErrorCode } from "../../../../sdk/src/message";
import type { WordContract } from "../../../../sdk/src/word";

export const isContextRead = (contract: Pick<WordContract, "member" | "word">): boolean =>
  contract.member === "service:host" && contract.word === "ctx.read";

/** Only validated request metadata and a byte count belong in the audit; never trust result metadata or errors. */
export function contextReadAudit(reply: Reply): Reply {
  if (!reply.ok) return { ok: false, error: errorBody(isErrorCode(reply.error.code) ? reply.error.code : "internal", "the context-probe read failed") };
  const data = reply.result?.data as { text?: unknown } | undefined;
  return { ok: true, result: { data: { status: "ok", ...(typeof data?.text === "string" ? { bytes: Buffer.byteLength(data.text, "utf8") } : {}) } } };
}

export function contextReadInput(body: unknown): Record<string, unknown> {
  const input = body as Record<string, unknown>;
  return Object.fromEntries(Object.entries(input).filter(([key]) => ["day", "file", "offset", "limit"].includes(key)));
}
