/**
 * Redaction (HUB-MODULES §1.6, SPEC-01 §10.0). The ledger holds only the masked version; the original of a sensitive
 * result goes to the owner alone, from memory; a secret-only result remains available to the authorized caller.
 * What counts as sensitive is what the contract says (`x-ash-secret`,
 * `x-ash-sensitive`), never a guess from the content.
 */
import type { Reply } from "../../../../sdk/src/message";
import { OWNER_ID } from "../../../../sdk/src/ids";
import { SECRET_KEYWORD, SENSITIVE_KEYWORD, type JsonSchema, type SensitiveMask } from "../../../../sdk/src/word";
import type { Caller, Message, Redact, WordContract } from "../types";

const HIDDEN = "[仅主人可见]";

function mask(kind: SensitiveMask, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => mask(kind, item));
  if (typeof value !== "string" || value === "") return HIDDEN;
  switch (kind) {
    case "email": {
      const at = value.lastIndexOf("@");
      return at < 1 ? HIDDEN : `${value[0]}***${value.slice(at)}`;
    }
    case "tail4": return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
    case "ip": {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `${value.split(".").slice(0, 2).join(".")}.*.*`;
      return value.includes(":") ? `${value.split(":")[0]}:*` : HIDDEN;
    }
    default: return HIDDEN;
  }
}

/** Walk a value along its schema and replace what the markers name. `secrets` also replaces x-ash-secret. */
function walk(value: unknown, schema: unknown, secrets: boolean): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || value === undefined || value === null) return value;
  const node = schema as JsonSchema;
  if (secrets && node[SECRET_KEYWORD] === true) return { set: true, length: typeof value === "string" ? value.length : JSON.stringify(value).length };
  const marker = node[SENSITIVE_KEYWORD] as { mask?: SensitiveMask } | undefined;
  if (marker?.mask) return mask(marker.mask, value);
  if (Array.isArray(value)) {
    const mapped = value.map((item) => walk(item, node.items, secrets));
    return mapped.some((item, i) => item !== value[i]) ? mapped : value;
  }
  if (typeof value === "object") {
    const props = (node.properties ?? {}) as Record<string, unknown>;
    const rest = node.additionalProperties;
    let copy: Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = walk(child, Object.hasOwn(props, key) ? props[key] : rest, secrets);
      if (next !== child) { copy ??= { ...(value as Record<string, unknown>) }; copy[key] = next; }
    }
    return copy ?? value;
  }
  return value;
}

export function createRedact(): Redact {
  return {
    forLedger(m: Message, contract: WordContract): Message {
      if (m.kind === "response") {
        const reply = m.body as Reply | undefined;
        if (!reply || reply.ok !== true || !reply.result || reply.result.data === undefined) return m;
        const data = walk(reply.result.data, contract.result_schema, true);
        return data === reply.result.data ? m : { ...m, body: { ...reply, result: { ...reply.result, data } } };
      }
      const body = walk(m.body, contract.input_schema, true);
      return body === m.body ? m : { ...m, body };
    },
    forCaller(result: unknown, contract: WordContract, caller: Caller): unknown {
      if (caller.member === OWNER_ID) return result;
      return walk(result, contract.result_schema, false);
    },
  };
}
