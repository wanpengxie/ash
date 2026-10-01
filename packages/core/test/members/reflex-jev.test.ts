import assert from "node:assert/strict";
import test from "node:test";
import { JevReflexClient } from "../../src/members/reflex-jev";

const state = { current_task: "Looking at the calendar", latest_user_message: "stop that search",
  recent_messages: ["Check tomorrow", "I am checking"] };

test("JEV second stage posts three typed control questions and uses only a confident current-task answer", async () => {
  const client = new JevReflexClient("https://jev.example.invalid/systemone", "synthetic-key", 300,
    (async (_url, init) => {
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer synthetic-key");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.state, state);
      assert.deepEqual(Object.keys(body.questions), ["intent", "targets_current", "urgency"]);
      return { ok: true, json: async () => ({ answers: {
        intent: { choice: "stop_current", confidence: 0.97 }, targets_current: { noul: 0.93 }, urgency: { score: 2 },
      } }) } as Response;
    }) as typeof fetch);
  assert.deepEqual(await client.judge(state), { intent: "stop", confidence: 0.93 });
});

test("JEV malformed answer and timeout cannot authorize a stop", async () => {
  const malformed = new JevReflexClient("https://jev.example.invalid", "synthetic-key", 300,
    (async () => ({ ok: true, json: async () => ({ answers: { intent: { choice: "stop_current", confidence: 1 } } }) }) as Response) as typeof fetch);
  await assert.rejects(malformed.judge(state), /answer unavailable/);
  const slow = new JevReflexClient("https://jev.example.invalid", "synthetic-key", 20,
    ((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
    })) as typeof fetch);
  await assert.rejects(slow.judge(state), /synthetic timeout/);
});
