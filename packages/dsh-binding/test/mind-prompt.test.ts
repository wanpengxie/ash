import assert from "node:assert/strict";
import test from "node:test";
import { DshMindRunner } from "../src/mind";
import type { DshHost } from "../src/host";
import type { Message } from "../../sdk/src/api";

/** The text the DSH mind session receives as a followup for one wake. */
async function mindPrompt(reason: string, context: Record<string, unknown>): Promise<string> {
  let listener: ((id: string, event: { type: string; data?: any }) => void) | null = null;
  const sent: string[] = [];
  const host = { onSessionEvent(fn: typeof listener) { listener = fn; return () => { listener = null; }; } } as unknown as DshHost;
  const agent = { followup(message: { id: string; content: { text: string }[] }) {
      sent.push(message.content.map((part) => part.text).join("\n"));
      queueMicrotask(() => { listener?.("mind", { type: "user/message", data: { id: message.id } }); listener?.("mind", { type: "turn/end", data: { reason: { kind: "completed" } } }); });
    }, cancel() {}, async whenIdle() {} };
  const door = { beginTurn() {}, endTurn() {} };
  const runner = new DshMindRunner(host);
  runner.attach(agent as any, door as any, "mind");
  const message = { id: "m1", seq: 1, ts: 1_800_000_000_000, from: "service:pulse", to: "agent:main", kind: "request", word: "wake", body: { reason, context } } as Message;
  await runner.runWake(message, { soul: null, identity: null, user: null, memory: null, heartbeat: null }, new AbortController().signal);
  return sent.join("\n");
}

test("the DSH mind is told what to do for a pulse wake, and for no other reason", async () => {
  const text = await mindPrompt("pulse", { why: "event", scheduled_for: 1_800_000_000_000, today_count: 4, budget_left: 10, event: "arrived at company" });
  assert.match(text, /Reason: pulse\n/);
  assert.match(text, /"event":"arrived at company"/);
  assert.match(text, /For reason pulse: read PULSE\.md \(your own guidance\) and follow it; fetch any data you need yourself with tools; you may update the home-screen card with widget\.card\.put \(look at the returned preview and fix cut-off or overflow before finishing\), or do nothing; record what you did with pulse\.note; your own text here reaches nobody\./);
  assert.ok(text.indexOf("For reason app_event") < text.indexOf("For reason pulse"));
  assert.ok(text.indexOf("For reason pulse") < text.indexOf("For other reasons"));
  assert.match(text, /This is your private mind space\. Do not respond in the main conversation\./);
});
