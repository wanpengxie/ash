import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import type { WorldMembers } from "../world/member";
import type { RouteHandlerContext, WorldRouter } from "../world/router";

const words = ["rules.list", "rules.revoke", "rules.set", "history", "audit", "access.list", "access.grant", "access.revoke"].map((word) => wordContract("service:gate", word));
const AGENT = /^agent:[a-z][a-z0-9_-]{0,31}$/;
const TARGETED = new Set(["browser.click", "browser.type", "browser.run", "calendar.create", "message.send"]);
if (words.some((word) => !word)) throw new TypeError("gate word contracts unavailable");
const error = (code: "forbidden" | "not_found", message: string): ResponseBody => ({ ok: false, error: { code, message } });

/** Owner-facing inspection of durable rules and decisions; automatic gating stays in WorldRouter. */
export class GateMember implements Member {
  readonly id = "service:gate";
  readonly kind = "service" as const;
  readonly name = "Approval gate";
  readonly online = true;
  readonly idempotentRecovery = ["rules.list", "history", "audit", "access.list"] as const;
  constructor(private readonly ledger: Ledger, private readonly router: WorldRouter, private readonly members: WorldMembers) {}
  words(): readonly WordSpec[] { return words as WordSpec[]; }
  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody | void> {
    // An agent reads evidence and rules, and changes rules only through a request the owner approved (the gate always asks).
    if (AGENT.test(message.from) && context.caller?.member === message.from && !context.signal.aborted &&
      ["audit", "history", "rules.list", "rules.set", "rules.revoke"].includes(message.word)) return this.forAgent(message);
    if (message.to !== this.id || message.kind !== "request" || message.from !== "person:owner" ||
      context.caller?.member !== "person:owner" || context.signal.aborted ||
      !await this.router.currentlyAuthorized(message, context.caller) || context.signal.aborted)
      return error("forbidden", "current owner authorization unavailable");
    if (message.word === "audit") return { ok: true, result: this.ledger.gateAudit(message.body as Parameters<Ledger["gateAudit"]>[0]) };
    if (message.word === "rules.set") return this.setRule(message, "person:owner");
    if (message.word === "rules.list") return { ok: true, result: this.ledger.gateRulesPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
    if (message.word === "history") return { ok: true, result: this.ledger.gateHistoryPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
    if (message.word === "rules.revoke") {
      if (!context.caller.local || context.caller.remote) return error("forbidden", "rule revocation requires local owner");
      return { ok: true, result: { revoked: this.ledger.revokeGateRule(String(message.body.id), "person:owner") } };
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

  private forAgent(message: Message): ResponseBody {
    switch (message.word) {
      case "audit": return { ok: true, result: this.ledger.gateAudit(message.body as Parameters<Ledger["gateAudit"]>[0]) };
      case "history": return { ok: true, result: this.ledger.gateHistoryPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
      case "rules.list": return { ok: true, result: this.ledger.gateRulesPage(message.body.before as number | undefined, message.body.limit as number | undefined) };
      // The router only delivers these after the owner said yes on a card; the request id is the record of who made the change.
      case "rules.set": return this.setRule(message, message.id);
      case "rules.revoke": return { ok: true, result: { revoked: this.ledger.revokeGateRule(String(message.body.id), message.id) } };
    }
    return error("not_found", "gate word unavailable");
  }

  private setRule(message: Message, by: string): ResponseBody {
    const body = message.body as { agent: string; member: string; word: string; target?: string; days?: number };
    const identity = this.router.ruleIdentity(body.agent, body.member, body.word);
    if (!identity) return error("not_found", "rules cover one agent and one capability of a device that exists");
    // Commands and payments are asked about every time; no rule can cover them.
    if (identity.effect === "execute" || identity.payment) return error("forbidden", "running commands and payments always ask the owner");
    if (identity.effect === "read") return error("forbidden", "reading needs no rule");
    // Only capabilities that act on a site, a calendar or a recipient have targets; a rule naming another would never match.
    if (body.target !== undefined && !TARGETED.has(body.word)) return error("not_found", `${body.word} has no target; leave target out to cover every use`);
    return { ok: true, result: this.ledger.addGateRule({ subject: identity.subject, alias: body.agent, target: body.member, word: body.word,
      pattern: body.target ?? "*", risk: identity.risk, contractFingerprint: identity.fingerprint, days: body.days ?? 30, createdBy: by }) };
  }
}
