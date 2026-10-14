/**
 * Who may read an attachment: whoever may see a message that holds it (SPEC-01 §4.3). The owner sees everything; any
 * other member sees the messages it sent or received. An attachment no message holds is let through: `service:blobs`
 * answers it with `not_found`, the same as for a hash that does not exist.
 */
import { OWNER_ID } from "../../../../sdk/src/ids";
import { referencingMessages, type Ledger } from "../ledger";
import type { Caller } from "../types";

export function mayReadAttachment(ledger: Pick<Ledger, "db" | "get">, caller: Caller, hash: string): boolean {
  if (caller.member === OWNER_ID || caller.via === "agent") return true;
  const ids = referencingMessages(ledger, hash);
  if (ids.length === 0) return true;
  return ids.some((id) => {
    const m = ledger.get(id);
    return m !== null && (m.from === caller.member || m.to === caller.member);
  });
}
