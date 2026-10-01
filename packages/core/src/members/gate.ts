import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import type { RouteHandlerContext, WorldRouter } from "../world/router";

const words = ["rules.list", "rules.revoke", "history"].map((word) => wordContract("service:gate", word));
if (words.some((word) => !word)) throw new TypeError("gate word contracts unavailable");
const error = (code: "forbidden" | "not_found", message: string): ResponseBody => ({ ok: false, error: { code, message } });

/** Owner-facing inspection of durable rules and decisions; automatic gating stays in WorldRouter. */
export class GateMember implements Member {
  readonly id = "service:gate";
  readonly kind = "service" as const;
  readonly name = "Approval gate";
  readonly online = true;
  readonly idempotentRecovery = ["rules.list", "history"] as const;
  constructor(private readonly ledger: Ledger, private readonly router: WorldRouter) {}
  words(): readonly WordSpec[] { return words as WordSpec[]; }
  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    if (message.to !== this.id || message.kind !== "request" || message.from !== "person:owner" ||
      context.caller?.member !== "person:owner" || !await this.router.currentlyAuthorized(message, context.caller))
      return error("forbidden", "current owner authorization unavailable");
    if (message.word === "rules.list") return { ok: true, result: this.ledger.gateRulesPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
    if (message.word === "history") return { ok: true, result: this.ledger.gateHistoryPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
    if (message.word === "rules.revoke") {
      if (!context.caller.local || context.caller.remote) return error("forbidden", "rule revocation requires local owner");
      return { ok: true, result: { revoked: this.ledger.revokeGateRule(String(message.body.id)) } };
    }
    return error("not_found", "gate word unavailable");
  }
}
