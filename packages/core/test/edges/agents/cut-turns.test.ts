/**
 * T17h: a turn that was running when its process went away is ended by the hub, once. A driver cannot report the end of a
 * turn its process took with it (kill -9: no reply, no word), so the manager ends every turn still open in a `Live` it
 * discards: `error` when the process died (the owner's turn gets the failure notice and the retry card), `interrupted` when
 * it was stopped on purpose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, settle, waitFor, type FakeDriver } from "./helpers";

const M = "agent:main";
const sends = (d: FakeDriver, key: string) => d.of("send").filter((c) => c[2] === key);
const texts = (call: unknown[]) => (call[3] as { text: string }[]).map((m) => m.text);
const ended = (f: ReturnType<typeof fixture>) => f.router.events("turn.ended").map((e) => e.msg.body as { turn: string; lane: string; outcome: string; error?: string });

test("the process dies in the middle of a front turn: the turn ends once as error, no failure card; the new process is given the recovery prompt and finishes it", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "做一件长任务" }, undefined);
  await waitFor(() => sends(d, "front").length === 1);
  const turn = d.running.get(`${M}/front`)!.turn;

  d.die(M, "process exited (SIGKILL)"); // no turn.ended from the driver: the process took the turn with it
  await waitFor(() => d.of("start").length === 2); // restarted at once
  await waitFor(() => sends(d, "front").length === 2); // and the cut turn goes on

  const gone = ended(f).filter((e) => e.turn === turn);
  assert.equal(gone.length, 1);
  assert.equal(gone[0]!.outcome, "error");
  assert.match(gone[0]!.error!, /SIGKILL/);
  assert.equal(f.router.to("person:owner", "show").length, 0, "no failure card: it is picked up again");
  assert.match(texts(sends(d, "front")[1]!)[0]!, /上一轮在 .* 被中断.*做一件长任务/s);
  assert.match(f.router.says()[0]!.text, /刚才中断了.*正在接着做：做一件长任务/);

  // a late word of the dead process about the same turn (a prompt that was rejected at its exit) ends nothing a second time
  d.report({ event: "turn.ended", agent: M, key: "front", turn, outcome: "error", error: "process exited" });
  await settle();
  assert.equal(ended(f).filter((e) => e.turn === turn).length, 1);

  // the new turn took the owner's message over: it is not delivered again, and it ends on its own
  const now = d.running.get(`${M}/front`)!.turn;
  assert.deepEqual(f.agents.manager.inbox.byTurn(now).map((r) => r.id).filter((i) => !i.startsWith("resume:")).length, 1);
  assert.equal(f.agents.manager.journal.get(turn)!.state, "resumed");
  assert.equal(f.agents.manager.journal.get(now)!.resumed_from, turn);
  d.say(M, "front", "做完了");
  d.finish(M, "front");
  await waitFor(() => ended(f).length === 2);
  assert.equal(ended(f)[1]!.outcome, "completed");
  assert.equal(f.agents.manager.journal.get(now)!.state, "done");
  assert.equal(sends(d, "front").length, 2, "never sent as a new message");
});

test("a back turn cut by a dead process ends as error without a word to the owner; the new process is given the recovery prompt", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "wake", { text: "整理一下记忆" }, undefined);
  await waitFor(() => sends(d, "back").length === 1);
  const turn = d.running.get(`${M}/back`)!.turn;

  d.die(M);
  await waitFor(() => sends(d, "back").length === 2);

  assert.deepEqual(ended(f).filter((e) => e.turn === turn).map((e) => e.outcome), ["error"]);
  assert.equal(f.router.to("person:owner", "show").length, 0);
  assert.match(texts(sends(d, "back")[1]!)[0]!, /上一轮在 .* 被中断.*原任务：「Wake/s);
});

test("a stop on purpose in the middle of a turn ends it as interrupted, with no failure notice", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "忙着" }, undefined);
  await waitFor(() => sends(d, "front").length === 1);
  const turn = d.running.get(`${M}/front`)!.turn;

  await f.agents.manager.stopAgent(M, "by hand");
  await settle();

  assert.deepEqual(ended(f).filter((e) => e.turn === turn).map((e) => e.outcome), ["interrupted"]);
  assert.equal(f.router.to("person:owner", "show").length, 0);
});

test("an ask that was in the cut turn is answered result_unknown once", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const asked = (f.call(M, "ask", { text: "q" }, { member: "agent:other", via: "agent", local: true }) as Promise<any>).then((v) => ({ v }), (e) => ({ e }));
  await waitFor(() => sends(d, "back").length === 1);
  d.die(M);
  const r: any = await asked;
  assert.equal(r.e?.code, "result_unknown");
});
