import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";

const words = ["say", "react", "show", "ask"].map((word) => wordContract("person:owner", word));
if (words.some((word) => !word)) throw new Error("owner word contracts unavailable");

/** Receipt is real: the router has already durably recorded the owner-targeted message. */
export class OwnerMember implements Member {
  readonly id = "person:owner";
  readonly kind = "person" as const;
  readonly name: string;
  readonly online = true;
  /** An ask has no external effect to replay: its durable router request remains answerable after restart. */
  readonly idempotentRecovery = ["ask"] as const;
  constructor(name = "Owner", private readonly ledger?: Ledger) { this.name = name; }
  words(): readonly WordSpec[] { return words as WordSpec[]; }
  handle(message: Message): ResponseBody | void {
    if (message.to !== this.id || message.kind !== "request") return { ok: false, error: { code: "not_found", message: "owner word not available" } };
    if (message.word === "ask") return; // WorldRouter owns expiry, first answer, and its durable terminal response.
    if (message.word === "react" && (!this.ledger || !this.ledger.byId(String(message.body.message_id))))
      return { ok: false, error: { code: "not_found", message: "reaction target not found" } };
    if (!["say", "react", "show"].includes(message.word)) return { ok: false, error: { code: "not_found", message: "owner word not available" } };
    return { ok: true, result: { accepted: true } };
  }
}
