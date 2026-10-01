import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import type { WorldMembers } from "../world/member";
import type { RouteHandlerContext, WorldRouter } from "../world/router";

const words = ["rules.list", "rules.revoke", "history", "access.list", "access.grant", "access.revoke"].map((word) => wordContract("service:gate", word));
if (words.some((word) => !word)) throw new TypeError("gate word contracts unavailable");
const error = (code: "forbidden" | "not_found", message: string): ResponseBody => ({ ok: false, error: { code, message } });

/** Owner-facing inspection of durable rules and decisions; automatic gating stays in WorldRouter. */
export class GateMember implements Member {
  readonly id = "service:gate";
  readonly kind = "service" as const;
  readonly name = "Approval gate";
  readonly online = true;
  readonly idempotentRecovery = ["rules.list", "history", "access.list"] as const;
  constructor(private readonly ledger: Ledger, private readonly router: WorldRouter, private readonly members: WorldMembers) {}
  words(): readonly WordSpec[] { return words as WordSpec[]; }
  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody | void> {
    if (message.to !== this.id || message.kind !== "request" || message.from !== "person:owner" ||
      context.caller?.member !== "person:owner" || context.signal.aborted ||
      !await this.router.currentlyAuthorized(message, context.caller) || context.signal.aborted)
      return error("forbidden", "current owner authorization unavailable");
    if (message.word === "rules.list") return { ok: true, result: this.ledger.gateRulesPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
    if (message.word === "history") return { ok: true, result: this.ledger.gateHistoryPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
    if (message.word === "rules.revoke") {
      if (!context.caller.local || context.caller.remote) return error("forbidden", "rule revocation requires local owner");
      return { ok: true, result: { revoked: this.ledger.revokeGateRule(String(message.body.id)) } };
    }
    if (message.word.startsWith("access.")) {
      if (!context.caller.local || context.caller.remote || !context.caller.ownerProxy || !context.caller.transportPrincipal)
        return error("forbidden", "device access requires current local owner");
      if (message.word === "access.list") return { ok: true, result: this.ledger.gateAccessPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
      if (message.word === "access.grant") {
        const member = String(message.body.member);
        const scope = String(message.body.scope);
        const split = scope.lastIndexOf("/");
        if (split < 1 || !this.members.canGrantDeviceAccess(member, scope.slice(0, split), scope.slice(split + 1)))
          return error("not_found", "registered agent or device capability unavailable");
        this.ledger.gateAccessGrant(message.id, member, scope);
        return;
      }
      if (message.word === "access.revoke") {
        this.ledger.gateAccessRevoke(message.id, String(message.body.id));
        return;
      }
    }
    return error("not_found", "gate word unavailable");
  }
}
