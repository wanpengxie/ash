import assert from "node:assert/strict";
import test from "node:test";
import type { HostNetwork } from "../../../../sdk/src/host";
import { fixture, FakeDriver, settle, waitFor } from "./helpers";

const M = "agent:main";
const OLD: HostNetwork = { proxy: { http: "http://10.0.2.2:7890" } };
const changed = (f: ReturnType<typeof fixture>, network: HostNetwork) => f.service("env.changed", { what: "network", network, online: true });
const starts = (f: ReturnType<typeof fixture>, agent = M) => f.driver().of("start").filter((c) => c[1] === agent).length;
const sends = (d: FakeDriver, key: string) => d.of("send").filter((c) => c[2] === key);

test("the proxy changed: an idle agent's process is restarted and its sessions resume", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  const handles = { ...f.agents.manager.runs.get(M)!.spec.sessions };
  await changed(f, { proxy: null });
  await settle();
  assert.equal(starts(f), 2);
  assert.deepEqual(f.driver().of("stop").map((c) => c[1]), [M]);
  assert.deepEqual((f.driver().of("start")[1]![2] as any).sessions, handles, "the same sessions are resumed");
  assert.ok(f.registry.members.has(M));
});

test("the proxy did not change: nothing restarts, whether the host says so again or only the power state changed", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  await changed(f, { proxy: { http: "http://10.0.2.2:7890" } });
  await changed(f, { proxy: { http: "http://10.0.2.2:7890", no_proxy: "  " } });
  await f.service("env.changed", { what: "power", saver: true });
  await settle();
  assert.equal(starts(f), 1);
  // no proxy before and none now is no change either; a later change back to the first one is a change
  const g = fixture();
  await g.start();
  await changed(g, { proxy: null });
  await changed(g, { proxy: {} });
  await settle();
  assert.equal(starts(g), 1);
  await changed(g, OLD);
  await settle();
  assert.equal(starts(g), 2);
  await changed(g, OLD);
  await settle();
  assert.equal(starts(g), 2);
});

const OWNER_C = { member: "person:owner", via: "human" as const, local: true, client: "client:a" };
const PULSE = { member: "service:pulse", via: "service" as const, local: true };
const OTHER = { member: "agent:other", via: "agent" as const, local: true };

test("an agent in a turn is restarted at once: it is told the turn was cut, and what waits goes to the new process", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  const d = f.driver();
  await f.call(M, "wake", { reason: "pulse" }, PULSE);
  await waitFor(() => sends(d, "back").length === 1);
  await f.call(M, "say", { text: "hello" }, OWNER_C); // front is idle: this turn is running too
  await waitFor(() => sends(d, "front").length === 1);
  await changed(f, { proxy: { http: "http://10.0.2.2:7891" } });
  await waitFor(() => starts(f) === 2);
  assert.equal(d.of("stop").length, 1, "no waiting for the turns to end");
  const told = () => d.of("send").filter((c) => c[2] === "back" && ((c[3] as any[])[0].text as string).includes("被中断"));
  await waitFor(() => told().length === 1);
  assert.match(((told()[0]![3]) as any[])[0].text, /代理换了/);
  // the words that came after are delivered in the new process like any others
  await f.call(M, "say", { text: "still there?" }, OWNER_C);
  await waitFor(() => sends(d, "front").length === 2);
  assert.match(((sends(d, "front")[1]![3]) as any[])[0].text, /被中断.*hello/s); // the cut turn goes on first
  await waitFor(() => [...d.of("send"), ...d.of("followup")].some((c) => ((c[3] as any[]).some((m) => m.text === "still there?"))));
});

test("an ask queued behind a running turn is not refused by the restart: the new process gets the question and answers it", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  const d = f.driver();
  await f.call(M, "wake", { reason: "pulse" }, PULSE);
  await waitFor(() => sends(d, "back").length === 1);
  let outcome: unknown = "waiting";
  const asked = (f.call(M, "ask", { text: "q" }, OTHER) as Promise<any>).then((v) => { outcome = v; return v; }, (e) => { outcome = e; throw e; });
  await settle();
  await changed(f, { proxy: null });
  await waitFor(() => starts(f) === 2);
  await waitFor(() => d.of("send").some((c) => c[2] === "back" && ((c[3] as any[]).some((m) => m.text === "q"))));
  assert.equal(outcome, "waiting", "the asker is still waiting, not refused");
  d.say(M, "back", "the answer");
  d.finish(M, "back");
  assert.deepEqual(await asked, { data: { answer: "the answer" } });
});

test("an ask that was in the turn that got cut is answered result_unknown at once, by a proxy restart and by a crash alike", async () => {
  for (const cut of ["proxy", "crash"] as const) {
    const f = fixture({ network: OLD });
    await f.start();
    const d = f.driver();
    // the ask is handed to the idle back lane, so it is in the running turn
    const asked = (f.call(M, "ask", { text: "q" }, OTHER) as Promise<any>).then((v) => ({ v }), (e) => ({ e }));
    await waitFor(() => sends(d, "back").length === 1);
    if (cut === "proxy") await changed(f, { proxy: null }); else d.die(M);
    const r: any = await asked;
    assert.equal(r.e?.code, "result_unknown", cut);
    assert.match(r.e.message, /not known whether it was done/);
    await waitFor(() => starts(f) === 2);
  }
});

test("a temporary worker is not restarted, and an agent that is off is not started by the change", async () => {
  const f = fixture({ network: OLD });
  await f.start();
  const d = f.driver();
  await f.service("declare", { id: "agent:b", name: "b", summary: "a helper agent", brief: "help" });
  await f.service("stop", { agent: "agent:b" });
  const job = f.service("spawn", { task: "look it up" });
  await waitFor(() => d.of("start").some((c) => String(c[1]).startsWith("agent:w_") || (c[1] !== M && c[1] !== "agent:b")));
  const worker = d.of("start").map((c) => c[1] as string).find((id) => id !== M && id !== "agent:b")!;
  await waitFor(() => d.of("send").some((c) => c[1] === worker));
  await changed(f, { proxy: null });
  await waitFor(() => d.of("start").filter((c) => c[1] === M).length === 2);
  await settle();
  assert.equal(d.of("stop").filter((c) => c[1] === worker).length, 0, "the worker keeps its process");
  assert.equal(d.of("start").filter((c) => c[1] === "agent:b").length, 1, "an agent that is off stays off");
  d.say(worker, "work", "found");
  d.finish(worker, "work");
  assert.equal(((await job)!.data as any).answer, "found");
});

test("an agent that runs on a computer is left alone", async () => {
  const made: FakeDriver[] = [];
  const make = (report: ConstructorParameters<typeof FakeDriver>[0]) => { const d = new FakeDriver(report); made.push(d); return d; };
  const f = fixture({ network: OLD, drivers: { dsh: make, codex: make } });
  await f.start();
  await f.service("declare", { id: "agent:far", name: "far", summary: "on a computer", brief: "work", runtime: { kind: "codex" }, native: { on: "computer:laptop" } });
  const of = (agent: string) => made.flatMap((d) => d.of("start")).filter((c) => c[1] === agent).length;
  await changed(f, { proxy: null });
  await settle();
  assert.equal(of(M), 2);
  assert.equal(of("agent:far"), 1);
  assert.equal(made.flatMap((d) => d.of("stop")).filter((c) => c[1] === "agent:far").length, 0);
});
