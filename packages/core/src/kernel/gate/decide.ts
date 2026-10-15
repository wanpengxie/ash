/**
 * The gate (HUB-MODULES §1.5, SPEC-01 §6): one request in, allow / ask / deny out. A decision only; asking the owner
 * is the router's job. Every request comes through `decide`, and there is no way around it.
 *
 *   person:owner via a human channel -> allow        service -> allow       hand -> deny (a hand only sends events)
 *   app   -> allow only a read or a risk-none word; everything else is refused (an app cannot be asked about)
 *   agent -> SPEC-01 §6.4, steps 2 to 11
 */
import { OWNER_ID } from "../../../../sdk/src/ids";
import type { Risk } from "../../../../sdk/src/word";
import type { Caller, Decision, Gate, GateDeps, Message, WordContract } from "../types";
import { Carry } from "./carry";
import { contractFingerprint, objectOf, stable, type GateStore } from "./store";


/** Words an agent can never get approved for good: it asks the owner every time, and 「以后都可以」 is not offered. Installing an app grants an organ its powers, so the review model cannot pass it either. */
export const ALWAYS_ASK: ReadonlySet<string> = new Set([]);

const PAYMENT = /\b(pay|payment|purchase|checkout|transfer)\b|支付|付款|购买|下单|转账|充值|买单/i;
/** Payments always reach the owner: no review, no carry-over, no 「以后都可以」. A click on the browser is judged by the button's text. */
export const isPayment = (contract: WordContract, body?: unknown): boolean =>
  PAYMENT.test(contract.word.replace(/[._-]/g, " ")) || PAYMENT.test(contract.label.doing)
  || (contract.word === "browser.click" && PAYMENT.test(String((body as { label?: unknown } | null)?.label ?? "")));

/** Words that touch the screen the owner is looking at (the contract's `foreground`) and change something: only a lease lets an agent use them. */
export const needsLease = (contract: WordContract): boolean => contract.foreground === true && contract.effect !== "read";
const clock = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** How a 「以后都可以」 for a vault entry on a body is kept: a rule for everyone, on that body, for the word `vault:<name>`. */
export const VAULT_SUBJECT = "*";
export const VAULT_FINGERPRINT = "vault";
export const vaultWord = (ref: string): string => `vault:${ref}`;

export const ASSESS_MS = 10_000;
/** The outer limit on the review model; the reviewer gives itself less, more for a long request. */
export const REVIEW_MS = 30_000;
/** The default time a question to the owner stays open. */
export const DEFAULT_TTL_MINUTES = 10;
export const RULE_DAYS = 30;

export interface GateOptions {
  now?: () => number;
  assessMs?: number;
  reviewMs?: number;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise.catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

export function createGate(deps: GateDeps, store: GateStore, options: GateOptions = {}): Gate & { carry: Carry } {
  const now = options.now ?? store.now;
  const carry = new Carry(now);

  const evidence = (req: Message, contract: WordContract, caller: Caller, risk: Risk, extra: { by: string; decision?: string; reason?: string; rule_id?: string; offer_always?: boolean }) => {
    const text = stable(req.body);
    store.record({
      request_id: req.id, at: now(), requester: caller.member, member: req.to ?? contract.member, word: req.word, label: contract.label.doing, effect: contract.effect, risk,
      ...(req.turn ? { turn: req.turn } : {}), content: text.length > 500 ? `${text.slice(0, 500)}…` : text,
      object: objectOf(req.body) ?? "*", fingerprint: contractFingerprint(contract), decided_by: extra.by,
      ...(extra.decision ? { decision: extra.decision } : {}), ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.rule_id ? { rule_id: extra.rule_id } : {}), ...(extra.offer_always !== undefined ? { offer_always: extra.offer_always } : {}),
    });
  };
  const carryKey = (req: Message, contract: WordContract, caller: Caller) =>
    [caller.member, req.to, req.word, contractFingerprint(contract), objectOf(req.body) ?? `exact:${stable(req.body)}`].join("\0");

  /** An agent's screen word: allowed while it holds a lease; otherwise refused with what happened and how to ask. */
  function leased(req: Message, contract: WordContract, caller: Caller, risk: Risk): Decision {
    const deny = (reason: string, by = "lease_none"): Decision => {
      evidence(req, contract, caller, risk, { by, decision: "lease_deny", reason });
      return { verdict: "deny", by, offer_always: false, reason };
    };
    const lease = store.activeLease(caller.member);
    if (lease) {
      evidence(req, contract, caller, risk, { by: "lease", decision: "lease" });
      return { verdict: "allow", by: "lease", offer_always: false };
    }
    const how = "需要的话先在对话里和主人说明要做什么，再调 service:gate/lease.request {minutes, purpose} 重新申请；主人点了之后会有一条主人的消息，之后再动手。";
    if (store.askingLease(caller.member)) return deny("屏幕授权还在等主人回答，先别操作，也不要重复申请；主人答复后会有一条主人的消息。", "lease_asking");
    const ended = store.lastEnded(caller.member);
    if (ended && ended.ended_at && now() - ended.ended_at < 3_600_000) {
      const at = clock(ended.ended_at);
      if (ended.ended_reason === "revoked") return deny(`主人在 ${at} 收回了屏幕授权。不要继续操作屏幕。${how}`, "lease_revoked");
      if (ended.ended_reason === "expired") return deny(`屏幕授权在 ${at} 到期了。${how}`, "lease_expired");
      if (ended.ended_reason === "turn_ended") return deny(`「本次任务」的屏幕授权随那一轮在 ${at} 结束了。${how}`, "lease_expired");
    }
    return deny(`现在没有屏幕授权，不能操作主人的屏幕。${how}`);
  }

  async function decide(req: Message, contract: WordContract, caller: Caller): Promise<Decision> {
    // 1. who is asking (SPEC-01 §6.1)
    if (caller.via === "human") {
      return caller.member === OWNER_ID ? { verdict: "allow", by: "human", offer_always: false } : { verdict: "deny", by: "human", offer_always: false, reason: "only the owner comes in through a human channel" };
    }
    if (caller.via === "service") {
      if (contract.effect !== "read") evidence(req, contract, caller, contract.risk, { by: "service", decision: "service" });
      return { verdict: "allow", by: "service", offer_always: false };
    }
    if (caller.via === "hand") return { verdict: "deny", by: "hand", offer_always: false, reason: "a hand sends events, not requests" };

    // risk: the declared one, or what the hand or member says about this call (SPEC-01 §6.3)
    let risk: Risk = contract.risk;
    let assessed = false;
    if (contract.per_call_risk && deps.assess && !isPayment(contract, req.body)) {
      const answer = await within(deps.assess(req), options.assessMs ?? ASSESS_MS);
      if (answer === "none" || answer === "outward" || answer === "structure") { risk = answer; assessed = true; }
    }

    // An app's call from a card the owner just pressed is judged like an agent's (below): he is there to be asked.
    if (caller.via === "app" && !caller.card) {
      if (contract.effect === "read" || risk === "none") return { verdict: "allow", by: "app", offer_always: false };
      return { verdict: "deny", by: "app", offer_always: false, reason: "needs_approval: an app cannot ask the owner; leave it to an agent or the owner" };
    }

    // 1b. a vault entry used by name on a body: the owner allows each name on each body once, or for good (a rule, revocable like any)
    const target = req.to ?? "";
    const vault = deps.vaultUse?.(req) ?? null;
    const unasked = vault ? vault.names.filter((n) => !store.matchRule(VAULT_SUBJECT, target, vaultWord(n.ref), VAULT_FINGERPRINT, null)) : [];
    if (vault && unasked.length) {
      const note = `用保险箱里的${unasked.map((n) => `『${n.label}』`).join("、")}在 ${vault.where} 上执行`;
      evidence(req, contract, caller, risk, { by: "vault", reason: note, offer_always: true });
      return { verdict: "ask", by: "vault", offer_always: true, reason: note, note };
    }

    // 2. a read
    if (contract.effect === "read") return { verdict: "allow", by: "read", offer_always: false };

    const payment = isPayment(contract, req.body);
    const ask = (by: string, reason: string, offer: boolean): Decision => {
      evidence(req, contract, caller, risk, { by, reason, offer_always: offer });
      return { verdict: "ask", by, offer_always: offer, reason };
    };
    const allow = (by: string, decision: string, extra: { reason?: string; rule_id?: string } = {}): Decision => {
      evidence(req, contract, caller, risk, { by, decision, ...extra });
      return { verdict: "allow", by, offer_always: false, ...(extra.reason ? { reason: extra.reason } : {}) };
    };
    // 3. a payment   4. the words that always ask
    if (payment) return ask("payment", "a payment", false);
    if (ALWAYS_ASK.has(`${req.to}/${req.word}`)) return ask("always_ask", "this word always asks the owner", false);
    // 4b. the owner's real screen: a lease, or nothing. It replaces rules, carry-over, the review model and the approval mode for these words;
    // a payment (above) still asks, every time.
    if (needsLease(contract)) return leased(req, contract, caller, risk);
    // 5. no risk
    if (risk === "none") return allow(assessed ? "assessed_none" : "declared_none", assessed ? "assessed_none" : "declared_none");
    // 6. a hand, or a computer lent as a body, that the owner trusts fully (body:main is always "ask")
    if ((target.startsWith("device:") || target.startsWith("body:")) && deps.tier(target) === "full") return allow("hand_full", "hand_full");
    // 7. the owner wants every outward action asked about
    const execute = contract.effect === "execute";
    if (deps.mode() === "always") return ask("mode_always", "the approval mode is always", !execute);

    const fingerprint = contractFingerprint(contract);
    // 8. a rule (never for a command)
    if (!execute) {
      const rule = store.matchRule(caller.member, target, req.word, fingerprint, objectOf(req.body));
      if (rule) return allow("rule", "rule", { rule_id: rule.id });
    }
    // 9. carry-over (never for a command)
    if (!execute && carry.has(carryKey(req, contract, caller))) return allow("carry", "carry");
    // 10. the review model: a command goes here too, and nothing it says is remembered
    const review = await within(deps.review(req, contract), options.reviewMs ?? REVIEW_MS);
    if (review?.verdict === "allow") {
      if (!execute) carry.remember(carryKey(req, contract, caller));
      return allow("review", "review", { reason: "the review model found it fine" });
    }
    // 11. the review model refused (plainly malicious, or too long to review): the agent is told why and what to do instead
    if (review?.verdict === "deny") {
      const reason = review.reason || "the review model refused";
      evidence(req, contract, caller, risk, { by: "review", decision: "review_deny", reason });
      return { verdict: "deny", by: "review", offer_always: false, reason };
    }
    // 12. everything else: the owner decides, and the card leads with the review model's sentence
    const decision = ask("ask", review === null ? "the review model gave no answer" : "the review model asked", !execute);
    return review?.reason ? { ...decision, review_reason: review.reason } : decision;
  }

  return {
    carry,
    decide,
    answered(req, answer) {
      const e = store.evidence(req.id);
      if (!e) return;
      const t = now();
      if (answer === "deny") { store.amend(req.id, { decision: "deny", answered_at: t }); return; }
      const always = answer === "always" && e.offer_always === true;
      store.amend(req.id, { decision: always ? "always" : "once", answered_at: t });
      // A vault entry on a body: 「以后都可以」 allows these names there; the command itself is never remembered.
      if (e.decided_by === "vault") {
        if (always) for (const { ref } of deps.vaultUse?.(req)?.names ?? []) store.addRule({ subject: VAULT_SUBJECT, to: e.member, word: vaultWord(ref), object_pattern: "*", risk: e.risk,
          contract_fingerprint: VAULT_FINGERPRINT, expires_at: t + RULE_DAYS * 86_400_000, created_by: OWNER_ID });
        return;
      }
      if (!e.offer_always) return;
      const subject = e.requester;
      if (always) {
        store.addRule({ subject, to: e.member, word: e.word, object_pattern: e.object ?? "*", risk: e.risk, contract_fingerprint: e.fingerprint ?? "",
          expires_at: t + RULE_DAYS * 86_400_000, created_by: OWNER_ID });
      } else {
        carry.remember([subject, e.member, e.word, e.fingerprint, e.object && e.object !== "*" ? e.object : `exact:${stable(req.body)}`].join("\0"));
      }
    },
  };
}
