import type { Message } from "../../../sdk/src/api";

export type EffectKind = "device_call" | "notification" | "intrinsic_write" | "gate_release";
export interface ObservedEffect {
  id: string;
  kind: EffectKind;
  ledger_id: string;
  to: string | null;
  word: string;
  body: Record<string, unknown>;
  result?: unknown;
}

const allKinds: readonly EffectKind[] = ["device_call", "notification", "intrinsic_write", "gate_release"];
const intrinsicWrites = new Set(["write", "append", "apply_plan", "rollback"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Detector only: callers must independently observe effects, not derive them from the ledger. */
export function auditEffectLedger(messages: readonly Message[], effects: readonly ObservedEffect[], requiredKinds: readonly EffectKind[] = allKinds): string[] {
  const errors: string[] = [];
  if (!messages.length) errors.push("ledger has no messages");
  if (!effects.length) errors.push("no externally observed effects");
  for (const kind of requiredKinds) if (!effects.some(effect => effect.kind === kind)) errors.push(`no observed ${kind}`);

  const byId = new Map<string, Message>();
  let previousSeq = -1;
  for (const message of messages) {
    if (byId.has(message.id)) errors.push(`duplicate ledger id ${message.id}`);
    byId.set(message.id, message);
    if (!Number.isSafeInteger(message.seq) || message.seq <= previousSeq) errors.push(`ledger sequence is not strictly increasing at ${message.id}`);
    previousSeq = message.seq;
  }

  const seenEffects = new Set<string>();
  const claimedMessages = new Set<string>();
  for (const effect of effects) {
    if (seenEffects.has(effect.id)) errors.push(`duplicate observed effect ${effect.id}`);
    seenEffects.add(effect.id);
    if (claimedMessages.has(effect.ledger_id)) errors.push(`multiple effects claim ledger id ${effect.ledger_id}`);
    claimedMessages.add(effect.ledger_id);
    const cause = byId.get(effect.ledger_id);
    if (!cause) { errors.push(`effect ${effect.id} has no ledger cause`); continue; }
    if (cause.to !== effect.to || cause.word !== effect.word || canonical(cause.body) !== canonical(effect.body)) errors.push(`effect ${effect.id} does not match ledger target, word, and body`);

    if (effect.kind === "gate_release") {
      if (cause.kind !== "event" || cause.from !== "service:gate" || cause.word !== "gate.passed") errors.push(`effect ${effect.id} lacks gate.passed event`);
      continue;
    }
    if (cause.kind !== "request") errors.push(`effect ${effect.id} cause is not a request`);
    if (effect.kind === "device_call" && !cause.to?.startsWith("device:")) errors.push(`effect ${effect.id} is not a device request`);
    if (effect.kind === "notification" && (cause.to !== "service:post" || cause.word !== "deliver")) errors.push(`effect ${effect.id} is not post delivery`);
    if (effect.kind === "intrinsic_write" && (cause.to !== "service:self" || !intrinsicWrites.has(cause.word))) errors.push(`effect ${effect.id} is not an intrinsic write`);

    const replies = messages.filter(message => message.kind === "response" && message.reply_to === cause.id);
    if (replies.length !== 1 || replies[0].seq <= cause.seq) errors.push(`effect ${effect.id} has no unique later response`);
    else {
      if (effect.result !== undefined && canonical(replies[0].body) !== canonical(effect.result)) errors.push(`effect ${effect.id} result differs from ledger response`);
      if (effect.kind === "notification" && (replies[0].body as { result?: { channel?: string } }).result?.channel !== "notification") errors.push(`effect ${effect.id} was not recorded as notification delivery`);
    }
    if (effect.kind === "intrinsic_write") {
      const changed = messages.filter(message => message.kind === "event" && message.from === "service:self" && message.word === "self.changed" && message.seq > cause.seq && message.body.path === effect.body.path);
      if (!changed.length) errors.push(`effect ${effect.id} has no self.changed event`);
    }
  }
  return errors;
}
