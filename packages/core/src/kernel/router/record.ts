import { OWNER_ID } from "../../../../sdk/src/ids";
import type { Caller, Message, WordContract } from "../types";
import { isContextRead } from "../redact/ctx-read";

/**
 * What goes into the ledger (HUB-MODULES §1.2): the ledger holds events of life, not a stream of data. The one place
 * this is decided; a response follows its request.
 *
 *   event    only if the contract says `record: true`
 *   request  anything the owner sends from a channel that is not a plain read; anything an agent asks (a read too);
 *            anything that has an effect (write, act, execute) whoever asks — which covers what is said or asked of the
 *            owner. Left out: a service, hand or app only reading (polling), even when it reads on the owner's behalf.
 *
 * Context-probe reads keep an access audit for every caller, with the raw result excluded by redaction.
 * The owner's other reads (words whose contract says `effect: "read"`) are not kept: reading changes
 * nothing, so a row for it has no value as a record, and the owner's pages read all the time to draw themselves. A row
 * for each would grow on every open and refresh and come back to the page that follows the ledger, which would read again.
 */
export function shouldRecord(msg: Pick<Message, "from" | "to" | "kind">, contract: WordContract, caller: Caller): boolean {
  if (msg.kind === "event") return contract.record === true;
  if (isContextRead(contract)) return true;
  if (msg.from === OWNER_ID && caller.via === "human") return contract.effect !== "read";
  if (caller.via === "agent") return true;
  return contract.effect !== "read";
}
