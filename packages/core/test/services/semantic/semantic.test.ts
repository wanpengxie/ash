import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type HandleContext, type Message } from "../../../../sdk/src/message";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSemantic, DONE_MARK } from "../../../src/services/semantic";
import { fileTemplates } from "../../../src/services/semantic/templates";
import { AGENT, contractOf, DAY1, local, OWNER, SERVICE, startedHub, TEMPLATES, newHub, type Hub } from "./helpers";

const MON = (h: number, m = 0) => local(2026, 10, 12, h, m);
const TUE = (h: number, m = 0) => local(2026, 10, 13, h, m);

const pulseWakes = (hub: Hub) => hub.wakes().filter((w) => w.reason === "pulse");
const dailyWakes = (hub: Hub) => hub.wakes().filter((w) => w.reason === "daily");
const fmt = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Move through a stretch of time in half-hour steps, as the host's alarm would. */
async function run(hub: Hub, from: number, to: number) {
  for (let t = from; t <= to; t += 30 * 60_000) await hub.advanceTo(t);
}

test("a day on a fake clock: hourly pulse, the 21:30 review, and at 04:00 a reload of every lane of every agent", async () => {
  const hub = await startedHub();                      // Monday 06:00, one "Ash 卡片" widget on the home screen
  hub.agents.push({ id: "agent:helper", lanes: { only: {} } }, { id: "agent:w-1", ephemeral: true, lanes: { back: {} } });
  // starting: the first card is the agent's to decide; PULSE.md is seeded into the body
  assert.equal(pulseWakes(hub).length, 1);
  assert.equal(hub.files.get("PULSE.md"), TEMPLATES["PULSE.md"]);

  await run(hub, MON(6, 30), MON(23));
  const hourly = pulseWakes(hub).slice(1);
  assert.deepEqual(hourly.map((w) => fmt(w.at)), Array.from({ length: 15 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`));
  assert.ok(hourly.every((w) => w.lane === "back" && w.agent === "agent:main" && w.context.why === "schedule"));
  assert.deepEqual(pulseWakes(hub).at(-1)!.context, { why: "schedule", scheduled_for: MON(22), today_count: 16, budget_left: 0 });
  // the evening review: once, on the back lane, with the date and the diary path
  assert.equal(dailyWakes(hub).length, 1);
  assert.equal(fmt(dailyWakes(hub)[0]!.at), "21:30");
  assert.deepEqual(dailyWakes(hub)[0]!.context, { date: "2026-10-12", review_time: "21:30", diary: "memory/2026-10-12.md" });
  assert.equal(dailyWakes(hub)[0]!.lane, "back");
  assert.equal(hub.reloads().length, 0);

  // the next day: 04:00 reload, then the same rhythm again with a new budget
  await run(hub, TUE(0), TUE(22));
  const reloads = hub.reloads();
  assert.deepEqual(reloads.map((r) => `${r.agent} ${r.key}`).sort(), ["agent:helper only", "agent:main back", "agent:main front"]);
  assert.ok(reloads.every((r) => fmt(r.at) === "04:00"));
  assert.equal(pulseWakes(hub).length, 1 + 15 + 15);
  assert.deepEqual(dailyWakes(hub).map((w) => w.context.date), ["2026-10-12", "2026-10-13"]);
  assert.deepEqual(hub.invalid, []);
  // every timer was set by the clock's own word, as the service
  const sets = hub.sent.filter((s) => s.msg.to === "service:clock" && s.msg.word === "set");
  assert.ok(sets.length > 10 && sets.every((s) => s.caller.via === "service" && s.caller.member.startsWith("service:")));
});

test("the review time and the reload time are settings; changing one moves its timer", async () => {
  const hub = await startedHub();
  hub.settings["semantic.review_time"] = "20:00";
  await hub.event("service:admin", "settings.changed", { keys: ["semantic.review_time"] });
  await run(hub, MON(6, 30), MON(21, 30));
  assert.deepEqual(dailyWakes(hub).map((w) => fmt(w.at)), ["20:00"]);
  const daily = (await hub.send("service:clock", "list")).ok && hub.sent.filter((s) => s.msg.word === "set" && String((s.msg.body as any).label).startsWith("semantic:daily:"));
  assert.ok(daily && daily.length >= 2);
  assert.deepEqual(hub.invalid, []);
});

test("a review missed while the hub was down is made up once when it comes back, from the clock's late timer", async () => {
  const hub = await startedHub();
  hub.semantic.stop();
  hub.t = TUE(8);                                      // the phone was off from the evening until 08:00
  await hub.restart();
  assert.equal(dailyWakes(hub).length, 1);
  assert.equal(dailyWakes(hub)[0]!.context.date, "2026-10-12");
  assert.equal(dailyWakes(hub)[0]!.context.made_up, true);
  // the late reload timer fired too, and the old hourly pulses were not woken for (too stale); the one due now was
  assert.equal(hub.reloads().length, 2);
  assert.deepEqual(pulseWakes(hub).map((w) => fmt(w.at)), ["06:00", "08:00"]);
  // later, the evening of the new day is reviewed as usual and the old day is not asked for again
  await run(hub, TUE(8, 30), TUE(22));
  assert.deepEqual(dailyWakes(hub).map((w) => w.context.date), ["2026-10-12", "2026-10-13"]);
  assert.deepEqual(hub.invalid, []);
});

test("a missed review is also made up when the timer itself is gone (the catch-up at start)", async () => {
  const hub = await startedHub();
  hub.semantic.stop();
  hub.ledger.db().exec("DELETE FROM timers");
  hub.t = TUE(8);
  await hub.restart();
  assert.equal(dailyWakes(hub).length, 1);
  assert.equal(dailyWakes(hub)[0]!.context.date, "2026-10-12");
  await hub.semantic.tick();                           // a later tick does not send it again
  await hub.idle();
  assert.equal(dailyWakes(hub).length, 1);
});

test("a day whose diary is marked done is not reviewed; a paused hub waits; a fresh install does not review the days before it", async () => {
  const done = await startedHub();
  done.files.set("memory/2026-10-12.md", `# 10 月 12 日\n...\n<!-- ${DONE_MARK} -->\n`);
  await run(done, MON(6, 30), MON(22));
  assert.equal(dailyWakes(done).length, 0);
  assert.equal(done.semantic.daily.woken("2026-10-12"), "already_done");

  const paused = await startedHub();
  paused.paused = true;
  await run(paused, MON(6, 30), MON(22));
  assert.equal(dailyWakes(paused).length, 0);
  paused.paused = false;
  await paused.semantic.tick();                        // the tick makes it up once the pause ends
  await paused.idle();
  assert.equal(dailyWakes(paused).length, 1);

  const fresh = await startedHub({ t: MON(22) });      // installed at 22:00: today's 21:30 was before it
  assert.equal(dailyWakes(fresh).length, 0);
  await run(fresh, MON(22, 30), TUE(22));
  assert.deepEqual(dailyWakes(fresh).map((w) => w.context.date), ["2026-10-13"]);
});

test("the day's sensor statistics come with the review's wake when there are any", async () => {
  const hub = await startedHub();
  hub.sensesDaily = { date: "2026-10-12", counts: { location: 4, activity: 1, health: 0, geofence: 2 }, steps: { total: 8000 } };
  await run(hub, MON(6, 30), MON(22));
  assert.equal(dailyWakes(hub)[0]!.context.senses.steps.total, 8000);
  const asked = hub.sent.find((s) => s.msg.to === "service:senses" && s.msg.word === "daily")!;
  assert.deepEqual(asked.msg.body, { date: "2026-10-12" });
});

/** What the agents module writes on the ledger around a first-meeting turn: the turn starting with the wake's id, its end, the agent's words. */
const agentSide = (hub: Hub) => {
  let n = 0;
  const wakeIds = () => hub.sent.filter((s) => s.msg.word === "wake" && (s.msg.body as any).reason === "first_meeting").map((s) => `m_${hub.sent.indexOf(s) + 1}`);
  const event = (agent: string, word: string, body: object) => hub.ledger.append({ ts: hub.t, from: agent, to: null, kind: "event", word, body, turn: (body as any).turn });
  return {
    wakeIds,
    start: (turn: string, ids: string[] = [wakeIds().at(-1)!], agent = "agent:main") => event(agent, "turn.started", { turn, lane: "back", ids }),
    end: (turn: string, outcome: "completed" | "error", agent = "agent:main") => event(agent, "turn.ended", { turn, lane: "back", outcome, ...(outcome === "error" ? { error: "no key" } : {}) }),
    say: (turn?: string, agent = "agent:main", word = "say", to = "person:owner") => hub.ledger.append({ ts: hub.t, from: agent, to, kind: "request", word, body: word === "say" ? { text: `hello ${++n}` } : { card: { type: "options", prompt: "?", options: [] } }, ...(turn ? { turn } : {}) }),
    /** The agents module's notice for a failed turn: a say and a retry card, in the failed turn, sent as the agent. */
    failureNotice: (turn: string) => { for (const word of ["say", "show"]) hub.ledger.append({ ts: hub.t, from: "agent:main", to: "person:owner", kind: "request", word, body: word === "say" ? { text: "刚才这件事没做成", kind: "reply" } : { card: {} }, turn }); },
  };
};
const connect = (hub: Hub, conn = "c1") => hub.event("service:link", "connected", { hand: "hand1", conn, channels: ["device", "human"] });
const keySaved = (hub: Hub, ref = "DEEPSEEK_API_KEY", action = "saved") => hub.event("service:vault", "vault.changed", { ref, action });
const meetings = (hub: Hub) => hub.wakes().filter((w) => w.reason === "first_meeting");

test("the first meeting: a wake when someone connects through a channel for people, not for any other event", async () => {
  const hub = await startedHub();
  await hub.event("service:link", "connected", { hand: "hand1", conn: "c1", channels: ["device"] });   // a hand only
  assert.equal(meetings(hub).length, 0);
  await hub.event("service:other", "connected", { hand: "hand1", conn: "c1", channels: ["human"] });    // not the link's event
  assert.equal(meetings(hub).length, 0);
  await connect(hub);
  assert.equal(meetings(hub).length, 1);
  assert.deepEqual(meetings(hub)[0], { agent: "agent:main", reason: "first_meeting", lane: "back", context: {}, at: DAY1 });
  assert.equal(hub.semantic.entity["options"].kv.get("first_meeting"), null, "taking the wake is not the meeting");
  assert.deepEqual(hub.invalid, []);
});

test("the first meeting without a key: the turn fails, the key is saved, and the wake comes again; once the agent has spoken it never does", async () => {
  const hub = await startedHub();
  const agent = agentSide(hub);
  await connect(hub);                                                                                   // a new install: no model key yet
  assert.equal(meetings(hub).length, 1);
  agent.start("t1"); agent.end("t1", "error"); agent.failureNotice("t1");                               // the turn failed; the notice is not a greeting
  await connect(hub, "c2");                                                                             // the next trigger tries again
  assert.equal(meetings(hub).length, 2);
  agent.start("t2"); agent.end("t2", "error"); agent.failureNotice("t2");
  await keySaved(hub, "CLOUDFLARE_TOKEN");                                                              // not a model key
  await keySaved(hub, "DEEPSEEK_API_KEY", "removed");
  assert.equal(meetings(hub).length, 2);
  await keySaved(hub);                                                                                  // the model key is set
  assert.equal(meetings(hub).length, 3);
  agent.start("t3"); agent.say("t3"); agent.end("t3", "completed");                                      // it spoke
  await connect(hub, "c3");
  await keySaved(hub);
  assert.equal(meetings(hub).length, 3);
  await hub.restart();                                                                                  // a new process: the ledger and the table remember
  await connect(hub, "c4");
  assert.equal(meetings(hub).length, 3);
  assert.deepEqual(hub.invalid, []);
});

test("the first meeting without any model key: a connection does not wake (the turn could only fail); saving a model key does; an unrelated key does not count", async () => {
  const hub = await startedHub();
  hub.savedKeys = ["CLOUDFLARE_TOKEN"];                                                                 // a key, but not a model's
  await connect(hub);
  await connect(hub, "c2");
  assert.equal(meetings(hub).length, 0);
  assert.equal(hub.sent.filter((s) => s.msg.to === "service:vault" && s.msg.word === "list").length, 2);
  hub.savedKeys = ["CLOUDFLARE_TOKEN", "OPENROUTER_API_KEY"];
  await keySaved(hub, "OPENROUTER_API_KEY");
  assert.equal(meetings(hub).length, 1);
  assert.deepEqual(hub.invalid, []);
});

test("the first meeting when the vault cannot be asked: the connection wakes as before", async () => {
  const hub = await startedHub();
  hub.members.delete("service:vault");
  await connect(hub);
  assert.equal(meetings(hub).length, 1);
});

test("the first meeting is not repeated while the last wake is still being worked on", async () => {
  const hub = await startedHub();
  const agent = agentSide(hub);
  await connect(hub);
  await connect(hub, "c2");                                                                             // taken, no turn has begun yet
  await keySaved(hub);
  assert.equal(meetings(hub).length, 1);
  agent.start("t1");
  await connect(hub, "c3");                                                                             // the turn is running
  await keySaved(hub);
  assert.equal(meetings(hub).length, 1);
  agent.end("t1", "error"); agent.failureNotice("t1");
  await keySaved(hub);                                                                                  // over, and it failed
  assert.equal(meetings(hub).length, 2);
  // a restart does not forget a turn that is running, but does not wait for one that the old process left unended
  agent.start("t2");
  await hub.restart();
  await connect(hub, "c4");
  assert.equal(meetings(hub).length, 2);
  hub.t += 60_000;
  await hub.restart();
  await connect(hub, "c5");
  assert.equal(meetings(hub).length, 3);
  assert.deepEqual(hub.invalid, []);
});

test("the first meeting is held when its own turn ended well, even if the agent said nothing; a turn that failed or was cancelled is not", async () => {
  const hub = await startedHub();
  const agent = agentSide(hub);
  await connect(hub);
  agent.start("t1"); agent.end("t1", "completed");
  await connect(hub, "c2");
  await keySaved(hub);
  assert.equal(meetings(hub).length, 1);
  assert.ok(hub.semantic.entity["options"].kv.get("first_meeting"));
  const other = await startedHub();
  const side = agentSide(other);
  await connect(other);
  side.start("t1"); side.end("t1", "error");
  await connect(other, "c2");
  assert.equal(meetings(other).length, 2);
  side.start("t2"); side.end("t2", "completed");                                                        // the retry went through
  await connect(other, "c3");
  assert.equal(meetings(other).length, 2);
});

test("a turn whose process died has no end: a later turn on the same lane of the same agent overtakes it; a wake nobody took before this start is not waited for", async () => {
  const hub = await startedHub();
  const agent = agentSide(hub);
  await connect(hub);
  agent.start("t1");                                                                                    // never ends
  await connect(hub, "c2");
  assert.equal(meetings(hub).length, 1, "still running");
  agent.start("t2", ["m_other"], "agent:helper");                                                       // another agent's turn: not the same lane owner
  await connect(hub, "c3");
  assert.equal(meetings(hub).length, 1);
  agent.start("t3", ["m_other"]);                                                                       // the same agent, the same lane, a newer turn
  await connect(hub, "c4");
  assert.equal(meetings(hub).length, 2);
  hub.t += 60_000;
  await hub.restart();                                                                                  // the second wake was never taken by a turn
  await connect(hub, "c5");
  assert.equal(meetings(hub).length, 3);
  assert.deepEqual(hub.invalid, []);
});

test("the first meeting is already held when an agent spoke to the owner: said first or showed, even the owner opening and being answered", async () => {
  for (const spoke of [
    (a: ReturnType<typeof agentSide>) => a.say(),
    (a: ReturnType<typeof agentSide>) => a.say(undefined, "agent:helper"),
    (a: ReturnType<typeof agentSide>) => a.say(undefined, "agent:main", "show"),
  ]) {
    const hub = await startedHub();
    spoke(agentSide(hub));
    await connect(hub);
    await keySaved(hub);
    assert.equal(meetings(hub).length, 0);
    assert.ok(hub.semantic.entity["options"].kv.get("first_meeting"));
  }
  const hub = await startedHub();
  const agent = agentSide(hub);
  hub.ledger.append({ ts: hub.t, from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "hi" } });   // the owner spoke first
  await connect(hub);
  assert.equal(meetings(hub).length, 1, "the owner alone speaking is not a meeting");
  agent.start("t1", [agent.wakeIds()[0]!]); agent.say("t1"); agent.end("t1", "completed");
  await connect(hub, "c2");
  assert.equal(meetings(hub).length, 1);
  // what an agent said to another agent, or the hub said, is not a greeting
  const other = await startedHub();
  agentSide(other).say(undefined, "agent:main", "say", "agent:helper");
  other.ledger.append({ ts: other.t, from: "service:agents", to: "person:owner", kind: "request", word: "say", body: { text: "heads up", kind: "heads_up" } });
  await connect(other);
  assert.equal(meetings(other).length, 1);
});

test("the first meeting waits for a primary agent that is there; the primary is whoever the list says, no name in the code", async () => {
  const hub = await startedHub();
  hub.agents = [{ id: "agent:helper", lanes: { back: {} } }];                                            // no primary yet
  await hub.event("service:link", "connected", { hand: "h", conn: "c", channels: ["human"] });
  assert.equal(hub.wakes().filter((w) => w.reason === "first_meeting").length, 0);
  hub.agents = [{ id: "agent:helper", primary: true, lanes: { back: {} } }, { id: "agent:main", lanes: { front: {}, back: {} } }];
  await hub.event("service:link", "connected", { hand: "h", conn: "c", channels: ["human"] });
  assert.deepEqual(hub.wakes().filter((w) => w.reason === "first_meeting").map((w) => w.agent), ["agent:helper"]);
  // pulse follows the primary too
  assert.equal((await hub.send("service:pulse", "pulse.fire", {})).ok, true);
  assert.equal(hub.wakes("agent:helper").filter((w) => w.reason === "pulse").length, 1);
});

// ---- persona ----

test("persona: the templates are the first approved versions and are seeded into the body", async () => {
  const hub = await startedHub();
  const got = await hub.send("service:persona", "get", {});
  const files = (got as any).result.data.files;
  assert.deepEqual(files.map((f: any) => [f.file, f.content]), [["SOUL.md", TEMPLATES["SOUL.md"]], ["IDENTITY.md", TEMPLATES["IDENTITY.md"]]]);
  assert.equal(hub.files.get("SOUL.md"), TEMPLATES["SOUL.md"]);
  assert.equal(hub.semantic.persona.versions("SOUL.md").length, 1);
  assert.equal(hub.semantic.persona.versions("SOUL.md")[0]!.by, "template");
  await hub.restart();                                                                                   // not seeded a second time
  assert.equal(hub.semantic.persona.versions("SOUL.md").length, 1);
});

test("persona: propose is a structure-risk word; an agent's proposal asks the owner; approved, it takes effect for the next session only", async () => {
  const hub = await startedHub();
  const contract = contractOf("service:persona", "propose");
  assert.equal(contract.risk, "structure");
  assert.deepEqual(contract.callers, ["owner", "agent"]);
  assert.equal(hub.semantic.persona.words().find((w) => w.word === "propose")!.risk, "structure");

  const openSession = async () => ((await hub.send("service:persona", "get", {})) as any).result.data.files.find((f: any) => f.file === "SOUL.md").content as string;
  const before = await openSession();                       // the session that is running now loaded this
  hub.ownerChoice = "allow";
  const reply = await hub.send("service:persona", "propose", { file: "SOUL.md", content: "# SOUL\nbe kind and brief\n", reason: "the owner asked me to be brief" }, AGENT);
  assert.equal(reply.ok, true);
  assert.deepEqual(hub.cards, [{ to: "service:persona", word: "propose", from: "agent:main" }]);   // the owner was asked
  assert.deepEqual((reply as any).result.data, { proposed: true, applied: true });
  assert.equal(before, TEMPLATES["SOUL.md"]);                // the running session still has the old text
  assert.equal(await openSession(), "# SOUL\nbe kind and brief\n");   // a session opened after the reload has the new one
  assert.equal(hub.files.get("SOUL.md"), "# SOUL\nbe kind and brief\n");
  assert.equal(hub.semantic.persona.versions("SOUL.md").length, 2);   // both versions are kept
  assert.equal(hub.semantic.persona.versions("SOUL.md")[1]!.by, "agent:main");
  // the 04:00 reload is what opens that next session
  await run(hub, TUE(0), TUE(5));
  assert.ok(hub.reloads().some((r) => r.agent === "agent:main" && r.key === "front"));
  assert.deepEqual(hub.invalid, []);
});

test("persona: a refused proposal changes nothing; the owner's own change goes straight through", async () => {
  const hub = await startedHub();
  hub.ownerChoice = "deny";
  const denied = await hub.send("service:persona", "propose", { file: "IDENTITY.md", content: "# IDENTITY\nSomeone else\n", reason: "I feel like it" }, AGENT);
  assert.equal(denied.ok, false);
  assert.equal(hub.cards.length, 1);
  assert.equal(hub.semantic.persona.current("IDENTITY.md")!.content, TEMPLATES["IDENTITY.md"]);
  assert.equal(hub.semantic.persona.versions("IDENTITY.md").length, 1);

  const own = await hub.send("service:persona", "propose", { file: "IDENTITY.md", content: "# IDENTITY\nAsh, steady\n", reason: "owner edit" }, OWNER);
  assert.deepEqual((own as any).result.data, { proposed: true, applied: true });
  assert.equal(hub.cards.length, 1);                         // no card for the owner's own change
  const same = await hub.send("service:persona", "propose", { file: "IDENTITY.md", content: "# IDENTITY\nAsh, steady\n", reason: "again" }, OWNER);
  assert.deepEqual((same as any).result.data, { proposed: false, applied: false });
  // going back to an older text is proposing it again
  await hub.send("service:persona", "propose", { file: "IDENTITY.md", content: TEMPLATES["IDENTITY.md"], reason: "back" }, OWNER);
  assert.equal(hub.semantic.persona.current("IDENTITY.md")!.content, TEMPLATES["IDENTITY.md"]);
  assert.equal(hub.semantic.persona.versions("IDENTITY.md").length, 3);
});

test("persona: editing SOUL.md in the body changes nothing a session loads", async () => {
  const hub = await startedHub();
  hub.files.set("SOUL.md", "# SOUL\nI rewrote myself\n");   // the agent's native edit, no word involved
  await hub.semantic.tick();
  await hub.restart();
  const files = ((await hub.send("service:persona", "get", {})) as any).result.data.files;
  assert.equal(files.find((f: any) => f.file === "SOUL.md").content, TEMPLATES["SOUL.md"]);
  assert.equal(hub.semantic.persona.versions("SOUL.md").length, 1);
  assert.equal(hub.files.get("SOUL.md"), "# SOUL\nI rewrote myself\n");   // not read, not restored
  // MEMORY.md and USER.md are not persona: this layer never touches them (the agents module injects them as they change)
  assert.ok(!hub.sent.some((s) => s.msg.to === "body:main" && ["MEMORY.md", "USER.md"].includes((s.msg.body as any).path)));
});

test("persona, the Ash app's words: memory files, the diary, notes that wake her, and persona.changed saying who did it", async () => {
  const hub = await startedHub();
  const data = async (word: string, body: unknown = {}, caller = OWNER) => { const r = await hub.send("service:persona", word, body, caller); assert.ok(r.ok, `${word}: ${JSON.stringify(r)}`); return (r as any).result.data; };
  const changes = () => hub.sent.filter((s) => s.msg.word === "persona.changed").map((s) => s.msg.body);

  // memory files: read as they are in the body (a missing one is said so), written whole
  hub.files.set("USER.md", "# 关于你\n- 爱喝美式\n");
  const memory = await data("memory.get");
  assert.deepEqual(memory.files.map((f: any) => [f.file, f.content, !!f.missing]), [["USER.md", "# 关于你\n- 爱喝美式\n", false], ["MEMORY.md", "", true], ["PROACTIVE.md", "", true]]);
  await data("memory.set", { file: "USER.md", content: "# 关于你\n- 不喝咖啡了\n", reason: "主人纠正" });
  assert.equal(hub.files.get("USER.md"), "# 关于你\n- 不喝咖啡了\n");
  const after = (await data("memory.get", { file: "USER.md" })).files[0];
  assert.deepEqual([after.by, after.at], ["person:owner", hub.t]);
  hub.files.set("USER.md", "# 关于你\n- 不喝咖啡了\n- 早睡\n");   // she edits the file herself
  assert.equal((await data("memory.get", { file: "USER.md" })).files[0].by, undefined);

  // the diary: days newest first with their first lines, a page at a time; one day whole
  hub.files.set("memory/2026-10-10.md", "# 10 月 10 日\n## 今天发生了什么\n- 改了会议时间\n- 查了天气\n<!-- review:done -->\n");
  hub.files.set("memory/2026-10-11.md", "# 10 月 11 日\n今天很安静\n");
  hub.files.set("memory/notes.md", "not a day");
  const page = await data("diary.list", { limit: 1 });
  assert.deepEqual(page.days, [{ date: "2026-10-11", excerpt: "今天很安静", done: false, notes: 0 }]);
  assert.equal(page.next_before, "2026-10-11");
  const next = await data("diary.list", { before: page.next_before });
  assert.deepEqual(next.days, [{ date: "2026-10-10", excerpt: "改了会议时间 查了天气", done: true, notes: 0 }]);
  assert.equal(next.next_before, undefined);
  const missing = await hub.send("service:persona", "diary.get", { date: "2026-10-01" });
  assert.equal(!missing.ok && missing.error.code, "not_found");

  // a note from the owner is kept with the day and wakes her on the back lane; her answer shows under it
  const before = hub.wakes("agent:main").length;
  const note = await data("note", { about: "diary:2026-10-10", text: "会议是改到周三，不是周二" });
  assert.equal(note.told, true);
  const wake = hub.wakes("agent:main").slice(before);
  assert.deepEqual(wake.map((w) => [w.reason, w.lane, w.context]), [["owner_note", "back", { note: note.id, about: "diary:2026-10-10", text: "会议是改到周三，不是周二", by: "person:owner" }]]);
  await data("note.reply", { id: note.id, text: "改好了，日记和 USER.md 都更正了" }, AGENT);
  const day = await data("diary.get", { date: "2026-10-10" });
  assert.equal(day.done, true);
  assert.deepEqual(day.notes.map((n: any) => [n.text, n.by, n.reply, n.replied_by]), [["会议是改到周三，不是周二", "person:owner", "改好了，日记和 USER.md 都更正了", "agent:main"]]);
  assert.equal((await data("diary.list", { limit: 5 })).days.find((d: any) => d.date === "2026-10-10").notes, 1);
  // her own note does not wake her
  const own = await data("note", { about: "now", text: "我在试新的提醒节奏" }, AGENT);
  assert.equal(own.told, false);
  assert.deepEqual((await data("notes.list")).notes.map((n: any) => n.about), ["now", "diary:2026-10-10"]);
  const nobody = await hub.send("service:persona", "note.reply", { id: "n_nope", text: "x" }, AGENT);
  assert.equal(!nobody.ok && nobody.error.code, "not_found");

  // the persona's history; every change above was told, with who did it
  await data("propose", { file: "SOUL.md", content: "# SOUL\nbe brief\n", reason: "主人说太啰嗦" });
  const versions = (await data("versions", { file: "SOUL.md" })).versions;
  assert.deepEqual(versions.map((v: any) => [v.by, v.reason]), [["person:owner", "主人说太啰嗦"], ["template", "the starting text shipped with ash"]]);
  assert.deepEqual(changes(), [
    { part: "memory", about: "memory:USER.md", by: "person:owner" },
    { part: "notes", about: "diary:2026-10-10", by: "person:owner" },
    { part: "notes", about: "diary:2026-10-10", by: "agent:main" },
    { part: "notes", about: "now", by: "agent:main" },
    { part: "identity", about: "identity:SOUL.md", by: "person:owner" },
  ]);
  const bad = await hub.send("service:persona", "note", { about: "somewhere", text: "x" });
  assert.equal(!bad.ok && bad.error.code, "bad_request");
  hub.invalid.splice(0);
  assert.deepEqual(hub.invalid, []);
});

test("persona: diary and growth writes are shared, persistent and announce their author", async () => {
  const hub = await startedHub();
  const data = async (word: string, body: unknown = {}, caller = AGENT) => {
    const reply = await hub.send("service:persona", word, body, caller);
    assert.ok(reply.ok, JSON.stringify(reply)); return (reply as any).result.data;
  };
  await data("diary.set", { date: "2026-10-12", content: "# 今天\n## 复盘\n我学会少打扰你。\n<!-- review:done -->" });
  assert.equal((await data("diary.get", { date: "2026-10-12" })).done, true);
  const invalid = await hub.send("service:persona", "diary.set", { date: "2026-02-30", content: "x" });
  assert.equal(!invalid.ok && invalid.error.code, "bad_request");
  const stable = { id: "note-stable", about: "now", text: "相同请求只写一次" };
  await data("note", stable);
  const count = hub.wakes("agent:main").length;
  await data("note", stable);
  assert.equal(hub.wakes("agent:main").length, count);
  assert.equal((await data("notes.list")).notes.filter((n: any) => n.id === "note-stable").length, 1);
  const change = { id: "learn-quiet", title: "少打扰你", why: "你说昨晚提醒太多", did: "我合并了重复提醒", effect: "还在观察", next: "下周回看", evidence: ["m_feedback"] };
  await data("growth.put", change);
  await data("growth.put", { ...change, effect: "减少了三次重复提醒" });
  await hub.restart();
  const items = (await data("growth.list")).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].by, "agent:main");
  assert.deepEqual(items[0].evidence, ["m_feedback"]);
  assert.equal(items[0].effect, "减少了三次重复提醒");
  const note = await data("note", { about: "growth:learn-quiet", text: "请保留早上的提醒" }, OWNER);
  assert.equal(note.told, true);
  assert.ok(hub.sent.some(s => s.msg.word === "persona.changed" && (s.msg.body as any).part === "diary" && (s.msg.body as any).by === "agent:main"));
  const bodyMember = hub.members.get("body:main")!;
  const handle = bodyMember.handle.bind(bodyMember);
  bodyMember.handle = async (msg, ctx) => msg.word === "workspace.read" ? { data: { text: "partial", truncated: true } } : handle(msg, ctx);
  const partial = await hub.send("service:persona", "memory.get", { file: "USER.md" });
  assert.equal(!partial.ok && partial.error.code, "too_large");
  bodyMember.handle = handle;
  hub.bodyUp = false;
  const offline = await hub.send("service:persona", "diary.list", {});
  assert.equal(!offline.ok && offline.error.code, "offline");
  assert.deepEqual(hub.invalid, []);
});

test("persona: a body that was away at start is seeded by a later tick", async () => {
  const hub = newHub();
  hub.bodyUp = false;
  hub.clock.start();
  await hub.semantic.start();
  assert.equal(hub.files.size, 0);
  hub.bodyUp = true;
  await hub.semantic.tick();
  assert.equal(hub.files.get("SOUL.md"), TEMPLATES["SOUL.md"]);
  assert.equal(hub.files.get("IDENTITY.md"), TEMPLATES["IDENTITY.md"]);
  assert.equal(hub.files.get("PULSE.md"), TEMPLATES["PULSE.md"]);
});

// ---- pulse words ----

const ctx: HandleContext = { signal: new AbortController().signal, caller: AGENT, raw: null };
const msg = (word: string, body: unknown, from = "agent:main"): Message => ({ seq: 0, id: "m", ts: 0, from, to: "service:pulse", kind: "request", word, body });
const refused = async (hub: Hub, word: string, body: unknown, from?: string) => {
  try { await hub.semantic.pulse.handle(msg(word, body, from), from === "person:owner" ? { ...ctx, caller: OWNER } : ctx); } catch (e) { assert.ok(e instanceof WordError); return (e as WordError).code; }
  assert.fail("expected a refusal");
};

test("pulse: get, set, note, history; set has no guidance and note has no review kind", async () => {
  const hub = await startedHub();
  const get = (await hub.send("service:pulse", "pulse.get")) as any;
  assert.equal(get.result.data.active, true);
  assert.equal(get.result.data.schedule.length, 15);
  assert.deepEqual(get.result.data.budget, { per_day: 16, today_count: 1, left: 15 });

  assert.equal(await refused(hub, "pulse.set", { reason: "x", guidance: "# new" }), "bad_request");
  assert.equal(await refused(hub, "pulse.set", { reason: "x", review_time: "21:00" }), "bad_request");
  assert.equal(await refused(hub, "pulse.set", { schedule: [{ time: "09:00" }] }), "bad_request");   // no reason
  assert.equal(await refused(hub, "pulse.note", { did: "x", kind: "review" }), "bad_request");

  const set = (await hub.send("service:pulse", "pulse.set", { schedule: [{ time: "09:00", days: "weekdays" }, { time: "13:00" }], reason: "mornings and lunch only" }, AGENT)) as any;
  assert.deepEqual(set.result.data.changed, ["schedule"]);
  assert.equal(set.result.data.next_wakes.length, 4);
  await run(hub, MON(6, 30), MON(23));
  assert.deepEqual(pulseWakes(hub).slice(1).map((w) => fmt(w.at)), ["09:00", "13:00"]);   // the old hourly timers were taken away

  const note = (await hub.send("service:pulse", "pulse.note", { did: "left the card", why: "nothing new", data_used: ["calendar"] }, AGENT)) as any;
  assert.equal(note.result.data.recorded, true);
  const history = (await hub.send("service:pulse", "pulse.history", { limit: 3 })) as any;
  assert.equal(history.result.data.entries.length, 3);
  assert.ok(history.result.data.next_before);
  assert.deepEqual(hub.invalid, []);
});

test("pulse: the owner or an agent switches it; off removes the timers and wakes nothing; on again brings them back", async () => {
  const hub = await startedHub();
  const timers = async () => ((await hub.send("service:clock", "list")) as any).result.data.timers.filter((t: any) => t.label.startsWith("pulse:wake:")).length;
  assert.ok((await timers()) > 20);
  assert.ok(((await hub.send("service:pulse", "pulse.switch", { enabled: false }, AGENT)) as any).ok, "an agent switches it as the owner would");
  assert.equal(await timers(), 0);
  await run(hub, MON(6, 30), MON(12));
  assert.equal(pulseWakes(hub).length, 1);
  const fired = (await hub.send("service:pulse", "pulse.fire", {})) as any;
  assert.deepEqual(fired.result.data, { fired: false, reason: "switched off" });
  await hub.send("service:pulse", "pulse.switch", { enabled: true }, OWNER);
  assert.ok((await timers()) > 20);
});

test("pulse: nothing exists without an Ash card widget; placing one brings it to life, removing it stops it", async () => {
  const hub = await startedHub({ cardWidgets: 0 });
  assert.equal(pulseWakes(hub).length, 0);
  const get = (await hub.send("service:pulse", "pulse.get")) as any;
  assert.deepEqual([get.result.data.active, get.result.data.reason], [false, "no widget"]);
  assert.equal(((await hub.send("service:pulse", "pulse.fire", {})) as any).result.data.reason, "no widget");
  await hub.event("device:ABCDEFGHIJKLMNOPQRSTUV", "widget.placed", { widgets: [{ id: "w1", type: "card" }] });
  assert.equal(pulseWakes(hub).length, 1);
  await hub.advanceTo(MON(8));
  assert.equal(pulseWakes(hub).length, 2);
  await hub.event("device:ABCDEFGHIJKLMNOPQRSTUV", "widget.placed", { widgets: [{ id: "w1", type: "ash" }] });
  await hub.advanceTo(MON(9));
  assert.equal(pulseWakes(hub).length, 2);
});

test("pulse: the budget, a pause and a timer that fired far too late each keep the agent from being woken", async () => {
  const hub = await startedHub({ budget: 3 });
  await run(hub, MON(6, 30), MON(12));
  assert.equal(pulseWakes(hub).length, 3);                   // the first card, 08:00, 09:00; then the budget is spent
  const history = (((await hub.send("service:pulse", "pulse.history", { limit: 100 })) as any).result.data.entries as any[]);
  assert.ok(history.some((e) => e.kind === "skip" && e.reason === "budget"));
  const manual = (await hub.send("service:pulse", "pulse.fire", {})) as any;      // a manual try is not held back by the budget
  assert.equal(manual.result.data.fired, true);

  const paused = await startedHub();
  paused.paused = true;
  await paused.advanceTo(MON(8));
  assert.equal(pulseWakes(paused).length, 1);                // only the one before the pause (the first card is at start)
  const late = (await paused.send("service:pulse", "pulse.due", { kind: "wake", at: MON(1) }, SERVICE("service:pulse")));
  assert.equal(late.ok, true);
  assert.equal(pulseWakes(paused).length, 1);
  assert.equal(await refused(paused, "pulse.due", { kind: "wake", at: MON(8) }, "agent:main"), "forbidden");
});

test("pulse: it hears no sensor (the organ judges those); feedback on a card is only recorded, and wakes nobody", async () => {
  const hub = await startedHub();
  assert.deepEqual(hub.semantic.pulse.listens, ["widget.placed", "widget.action"]);
  const phone = "device:ABCDEFGHIJKLMNOPQRSTUV";
  await hub.event(phone, "sense.geofence", { name: "Home", transition: "exit", ts: hub.t });
  await hub.event(phone, "sense.calendar", { kind: "upcoming", event: { id: "e", title: "t", start: hub.t, end: hub.t + 1 } });
  await hub.event(phone, "sense.source", { source: "watch", state: "stale", ts: hub.t, stale_hours: 30, summary: "x" });
  assert.equal(pulseWakes(hub).length, 1);                    // only the first card, at start
  const before = hub.wakes().length;
  await hub.event("service:widgets", "widget.action", { card: "c1", action: "feedback", owner: "agent:main", title: "t", context: { feedback: "useful" } });
  assert.equal(hub.wakes().length, before);
  const history = (((await hub.send("service:pulse", "pulse.history", { limit: 100 })) as any).result.data.entries as any[]);
  assert.ok(history.some((e) => e.kind === "feedback" && e.feedback === "useful"));
  assert.deepEqual((((await hub.send("service:pulse", "pulse.get")) as any).result.data.events), undefined);
  assert.equal(await refused(hub, "pulse.set", { events: [{ event: "geofence_exit" }], reason: "x" }), "bad_request");
  assert.deepEqual(hub.invalid, []);
});

test("templates: fileTemplates reads <NAME>.template.md from a directory, and createSemantic takes the directory itself", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "semantic-templates-"));
  try {
    for (const name of ["SOUL", "IDENTITY", "PULSE"]) writeFileSync(join(dir, `${name}.template.md`), `# ${name}\n`);
    assert.deepEqual(fileTemplates(dir), { "SOUL.md": "# SOUL\n", "IDENTITY.md": "# IDENTITY\n", "PULSE.md": "# PULSE\n" });
    const send = async () => ({ ok: true as const, result: {} });
    const ledger = { db: () => { throw new Error("not used"); }, tx: () => { throw new Error("not used"); } } as never;
    assert.throws(() => createSemantic({ ledger, router: { send } } as never), /templatesDir/);
    rmSync(join(dir, "PULSE.template.md"));
    assert.throws(() => createSemantic({ ledger, router: { send } as never, templatesDir: dir, modelKeys: [] }), /PULSE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
