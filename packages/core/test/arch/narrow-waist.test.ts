/**
 * The narrow waist (the owner's rule): every interaction, the owner's or an agent's, goes through the hub, and the one
 * checkpoint is the gate's approval. Two ways a person-only path creeps back in that the word contracts cannot show:
 *   1. hub code that tells the owner from an agent and refuses the agent;
 *   2. a page of the app that changes the phone's state itself instead of calling the hub.
 * Each place that does either is listed here with why it is not a refusal; a new one fails until it is justified.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../../../..");

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

/** `file: code` for every line matching [pattern]; the code is trimmed so a moved line does not fail the test. */
function sites(dir: string, ext: RegExp, pattern: RegExp, skip: RegExp = /$^/): string[] {
  const out: string[] = [];
  for (const file of files(dir, ext)) {
    const rel = relative(ROOT, file);
    if (skip.test(rel)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line) => { if (pattern.test(line)) out.push(`${rel}: ${line.trim()}`); });
  }
  return out.sort();
}

// Where the hub tells the owner (or the human channel) from anyone else. None of them refuses an agent what the owner may do.
const OWNER_CHECKS: Record<string, string> = {
  "packages/core/src/kernel/router/record.ts: if (msg.from === OWNER_ID && caller.via === \"human\") return contract.effect !== \"read\";": "what goes in the ledger",
  "packages/core/src/services/semantic/pulse.ts: this.record(\"switch\", { enabled, by: msg.from === \"person:owner\" ? \"owner\" : msg.from });": "who switched it, for the record",
  "packages/core/src/kernel/router/attachments.ts: if (caller.member === OWNER_ID || caller.via === \"agent\") return true;": "the owner and every agent read any attachment; only apps are limited to their own",
  "packages/core/src/services/clock/index.ts: const seesAll = (caller: Caller): boolean => caller.member === OWNER_ID || caller.via === \"service\" || caller.via === \"agent\";": "the owner and agents see all timers; apps their own",
  "packages/core/src/services/clock/index.ts: if (by !== undefined && by !== caller.member && caller.member !== OWNER_ID && caller.via !== \"agent\") {": "the owner and agents cancel any timer; apps their own",
  "packages/core/src/services/widgets/index.ts: private mayChange(card: Card, from: string): boolean { return card.owner === from || from === OWNER_ID || isAgentId(from); }": "the owner and agents change any card; apps their own",
  "packages/core/src/kernel/redact/index.ts: if (caller.member === OWNER_ID) return result;": "masks no field any more (no word marks one); kept for apps",
  "packages/core/src/services/health/index.ts: if (t.from === OWNER_ID && ((t.kind === \"event\" && t.word === \"typing\") ||": "counts the owner's own activity",
  "packages/core/src/edges/agents/manager.ts: return this.inbox.byTurn(caller.turn).some((row) => row.agent === caller.member && row.from === OWNER_ID);": "whether the owner spoke in this turn (who may answer him)",
  "packages/core/src/edges/agents/manager.ts: const asOwner = from === OWNER_ID && word === \"say\";": "routes the owner's words to the front lane",
  "packages/core/src/edges/agents/manager.ts: return pick((f) => f === \"*\" || f === category || (word !== \"wake\" && from !== OWNER_ID && f === from)) ?? (lanes.back ? \"back\" : pick((f) => f === \"wake\")) ?? Object.keys(lanes)[0]!;": "lane routing",
  "packages/core/src/edges/link-server/human/status.ts: if (m.kind === \"request\" && m.to === OWNER_ID && m.word === \"say\" && this.turn && m.turn === this.turn && typeof body.text === \"string\") {": "what the status line shows of a turn's words to the owner",
  "packages/core/src/kernel/ledger/relations.ts: const original = m.kind === \"response\" || m.word === \"turn.started\" || m.word === \"agent.tool\" || fact?.type === \"activity.request\" || fact?.type === \"ask\" || (m.from === \"person:owner\" && m.word === \"say\") || !fact ? safeRecord({ ...m, id, ts, seq }) : fact;": "how a message is kept in the ledger",
  "packages/core/src/kernel/router/authorize.ts: if (msg.to === OWNER_ID && deps.mayTalkToOwner && !deps.mayTalkToOwner(caller, msg.word)) return forbid(\"this agent may speak to the owner only in a turn where it was addressed directly\");": "how many voices reach the owner (a helper agent answers in the turn he addressed it), not an ability of his an agent lacks",
  "packages/core/src/services/clock/index.ts: const caller = stored.member === OWNER_ID && row.target === OWNER_ID ? SELF : stored;": "who a timer the owner set for himself is sent as",
  "packages/core/src/services/history/index.ts: if (!request || request.kind !== \"request\" || !request.from.startsWith(\"agent:\") || !request.turn || request.to === \"person:owner\") throw new WordError(\"not_found\", \"no such activity\");": "a lookup of agent calls, not a permission",
  "packages/core/src/edges/agents/manager.ts: if (row.from === OWNER_ID) {": "the owner's message in an agent's inbox",
  "packages/core/src/edges/agents/manager.ts: const failed = ev.outcome === \"error\" && this.speaks(live.id, ev.key) && rows.some((r) => r.from === OWNER_ID);": "tells the owner when his turn failed",
  "packages/core/src/edges/agents/policy.ts: if (caller.via === \"human\" || caller.via === \"service\") return { unrestricted: true };": "an agent is limited only by its own declaration",
  "packages/core/src/kernel/gate/decide.ts: if (caller.via === \"human\") {": "the human channel is the owner's; nobody else comes in through it",
  "packages/core/src/kernel/gate/decide.ts: return caller.member === OWNER_ID ? { verdict: \"allow\", by: \"human\", offer_always: false } : { verdict: \"deny\", by: \"human\", offer_always: false, reason: \"only the owner comes in through a human channel\" };": "the same",
  "packages/core/src/edges/link-server/human/index.ts: if (m.from === OWNER_ID) recorded.offer(m);": "the owner's own messages to his channels",
  "packages/core/src/edges/link-server/human/index.ts: const acted = m.from === OWNER_ID && m.kind === \"request\" && m.word === \"say\" ? (m.body as { card?: { id?: unknown; data?: unknown } } | null)?.card : undefined;": "what the owner entered on a card stays with the card when he acts on it",
  "packages/core/src/edges/apps/runtime.ts: if (caller.member !== OWNER_ID) {": "an install the gate asked about installs what was approved",
  "packages/core/src/kernel/router/router.ts: const asOwnerService = caller.via === \"service\" && caller.member === OWNER_ID;": "a service speaking for the owner",
};

test("hub code tells the owner from an agent only where that is not a refusal (each place listed with why)", () => {
  const found = sites(join(ROOT, "packages/core/src"), /\.ts$/,
    /caller\.via (===|!==) "human"|caller\.member (===|!==) OWNER_ID|\bfrom (===|!==) OWNER_ID|(===|!==) "person:owner"|=== OWNER_ID &&|local_only/,
    /ui\.generated\.ts$/);
  const unlisted = found.filter((line) => !(line in OWNER_CHECKS));
  assert.deepEqual(unlisted, [], "a new place that tells the owner from an agent: if it refuses the agent, remove it; else list it with why");
  assert.deepEqual(Object.keys(OWNER_CHECKS).filter((line) => !found.includes(line)), [], "a listed place is gone: take it off the list");
});

// What a page of the app may still change on the phone by itself: things that never enter the system, or that only the
// owner's hands can do.
const LOCAL_ONLY_UI: Record<string, string> = {
  "android/app/src/main/java/ai/ash/ui/ChatScreen.kt: private fun save() = prefs.edit().putString(\"items\", JSONArray(list.map(::stored)).toString()).apply()": "the composer's own outbox before a message is sent",
  "android/app/src/main/java/ai/ash/caps/senses/SetupActivity.kt: val problem = runCatching { XiaomiScaleSource.save(this, m, k) }.getOrElse { \"没能保存：${it.javaClass.simpleName}\" }": "the scale's key, typed by the owner: a secret that never enters the system",
  "android/app/src/main/java/ai/ash/ui/OnboardingActivity.kt: prefs.edit().putBoolean(SEEN, true).apply()": "whether the welcome screens were shown: the page's own state",
  "android/app/src/main/java/ai/ash/ui/TaskCapsule.kt: ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(\"resident\", on).apply()": "the switch itself, which the hub word config.switch.set sets",
  "android/app/src/main/java/ai/ash/ui/TaskCapsule.kt: fun setResidentKept(ctx: Context, on: Boolean) {": "the same",
  "android/app/src/main/java/ai/ash/caps/senses/SetupActivity.kt: runCatching { GadgetbridgeSource.setFolder(this, uri) }.onFailure { Toast.makeText(this, \"没能保存文件夹授权：${it.message}\", Toast.LENGTH_LONG).show() }": "the folder grant Android gives only through its own picker",
};

test("the app's pages change the phone's state through the hub, like an agent does (each exception listed with why)", () => {
  const ui = join(ROOT, "android/app/src/main/java/ai/ash");
  const found = sites(ui, /\.kt$/,
    /\.edit\(\)\.put|getSharedPreferences\([^)]*\)\.edit|NotificationSenseSettings\.setEnabled|setResidentKept\(|OwnerWord\.of\([^)]*\)\.(say|clear)|BrowserSession\.clearLogins|XiaomiScaleSource\.(save|remove)|GadgetbridgeSource\.setFolder|\?\.revoke\?\.invoke/,
  ).filter((line) => /\/ui\/|Activity\.kt:/.test(line));
  const unlisted = found.filter((line) => !(line in LOCAL_ONLY_UI));
  assert.deepEqual(unlisted, [], "a page changes the phone by itself: call the hub's word for it (the one an agent calls) instead");
});
