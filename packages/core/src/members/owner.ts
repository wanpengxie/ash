import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";

const say = wordContract("person:owner", "say");
if (!say) throw new Error("owner say contract unavailable");

/** Receipt is real: the router has already durably recorded the owner-targeted message. */
export class OwnerMember implements Member {
  readonly id = "person:owner";
  readonly kind = "person" as const;
  readonly name: string;
  readonly online = true;
  constructor(name = "Owner") { this.name = name; }
  words(): readonly WordSpec[] { return [say!]; }
  handle(message: Message): ResponseBody {
    if (message.to !== this.id || message.word !== "say" || message.kind !== "request") return { ok: false, error: { code: "not_found", message: "owner word not available" } };
    return { ok: true, result: { accepted: true } };
  }
}
