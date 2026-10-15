/**
 * docs/CARD-RUNTIME.md, end to end through the hub's port: a card that belongs to an app (written with apps.scaffold, a list
 * that changes) shows the app's data live, a button calls the app's word and writes the result on the card, the card goes
 * idle and dormant off screen (its temporary app sleeps), and seeing it again wakes it all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accepted, byOwnerText, dataOf, OWNER, resultOf, startScenario, toOwner, type ToolResult } from "./harness";
import { eventually } from "../fixtures/wait";

const CARD = "tally-live";
const a2ui = {
  data: { items: [] },
  sources: { "/items": { member: "app:tally", word: "tally.list", every_s: 5, pick: "/items" } },
  components: [
    { id: "root", component: "Column", gap: 8, children: ["count", "add"] },
    { id: "count", component: "Text", text: { call: "formatString", args: { value: "共 ${/items} 条" } } },
    { id: "add", component: "Button", child: "add.t", action: { call: { member: "app:tally", word: "tally.add", body: { text: "牛奶" }, result: "/added" } } },
    { id: "add.t", component: "Text", text: "加一条" },
  ],
};

test("a card of an app: live data from the app, a button calling its word, idle and dormant off screen, woken when seen", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"], fakeNow: true });
  const state: { shown?: ToolResult } = {};
  s.driver.script(byOwnerText({ "记一下": async (turn) => { state.shown = await turn.call(OWNER, "show", { id: CARD, app: "tally", temporary_app: true, a2ui, text: "计数卡" }); } }));
  const owner = await s.human();
  owner.presence({ visible: true });

  // The backend: an app written for the card (as an agent would with build-app), installed by the owner.
  const made = await owner.call("service:apps", "apps.scaffold", { id: "tally", name: "计数" });
  assert.ok(made.ok, JSON.stringify(made));
  // This hub's body is the machine's own folder (native), where the app's folder is not at /root/apps: the server reads its cwd.
  const edited = await owner.call("body:main", "workspace.edit", { path: "/root/apps/tally/server.mjs", edits: [{ oldText: "process.env.ASH_APP_DIR || process.cwd()", newText: "process.cwd()" }] });
  assert.ok(edited.ok, JSON.stringify(edited));
  // Written by the agent (as with build-app): only such an app may be a card's temporary app (removed with its cards).
  const byAgent = await owner.call("body:main", "workspace.edit", { path: "/root/apps/tally/app.json", edits: [{ oldText: '"publisher": "person:owner"', newText: '"publisher": "agent:main"' }] });
  assert.ok(byAgent.ok, JSON.stringify(byAgent));
  const installed = await owner.call("service:apps", "apps.install", { id: "tally" });
  assert.ok(installed.ok, JSON.stringify(installed));
  assert.ok(dataOf(installed).running, "the app runs");
  assert.ok((await owner.call("app:tally", "tally.add", { text: "鸡蛋" })).ok);

  accepted(await owner.say("记一下"));
  await eventually(() => state.shown, "the card shown");
  assert.equal(state.shown!.isError, false, JSON.stringify(state.shown));
  const message = await owner.seen(toOwner("show", "agent:main"), "the card in the conversation");
  assert.ok((await owner.call("service:cards", "seen", { cards: [CARD] })).ok);

  // Live data: the source read the app's list (pushed to the screen as card.patch, not written to the ledger).
  const patch = await owner.nextPresent((f) => f.surface === "chat" && f.op === "card.patch" && JSON.stringify(f.body).includes("鸡蛋"), "the live data pushed to the screen");
  assert.ok(patch);
  const describe = async () => dataOf(await owner.call("service:cards", "describe", { id: CARD })) as { card: { life: string; app: string; sources: string[] }; actions: Record<string, { state: string; text: string }> };
  assert.deepEqual((await describe()).card.sources, ["/items"]);
  assert.equal((await describe()).card.life, "active");

  // A button: the app's word runs as app:tally (the owner pressed it), the result is on the card.
  const pressed = await owner.call("service:cards", "act", { card: CARD, component: "add", data: {} });
  assert.ok(pressed.ok, JSON.stringify(pressed));
  assert.equal(dataOf(pressed).state, "ok", JSON.stringify(dataOf(pressed)));
  assert.equal((await describe()).actions.add!.state, "ok");
  const window = dataOf(await owner.call("service:history", "window", { limit: 40 })) as { items: { id: string; card?: { plan: { data: { added?: { item?: { text?: string } } } }; life?: string } }[] };
  const item = window.items.find((x) => x.id === message.id)!;
  assert.equal(item.card!.plan.data.added?.item?.text, "牛奶", "the call's result is in the card's data");
  assert.equal(item.card!.life, "active");
  const list = dataOf(await owner.call("app:tally", "tally.list", {})) as { items: { text: string }[] };
  assert.deepEqual(list.items.map((i) => i.text), ["鸡蛋", "牛奶"]);

  // Off screen: idle after 2 minutes, dormant after 30 more; its temporary app sleeps.
  owner.presence({ visible: false });
  s.advance(3 * 60_000);
  await owner.call("service:cards", "seen", { cards: [] });
  assert.equal((await describe()).card.life, "idle");
  s.advance(31 * 60_000);
  await owner.call("service:cards", "seen", { cards: [] });
  assert.equal((await describe()).card.life, "dormant");
  await eventually(async () => (dataOf(await owner.call("service:apps", "apps.describe", { id: "tally" })) as { running: boolean }).running === false || undefined, "the temporary app asleep");

  // Seen again: woken, its app runs, and a call reaches it.
  owner.presence({ visible: true });
  const seen = dataOf(await owner.call("service:cards", "seen", { cards: [CARD] })) as { active: string[] };
  assert.deepEqual(seen.active, [CARD]);
  await eventually(async () => (dataOf(await owner.call("service:apps", "apps.describe", { id: "tally" })) as { running: boolean }).running || undefined, "the app awake again");
  const again = await owner.call("service:cards", "act", { card: CARD, component: "add", data: {} });
  assert.equal(dataOf(again).state, "ok");

  // Closed: the buttons stop, and the temporary app goes.
  assert.ok((await owner.call("service:cards", "close", { id: CARD })).ok);
  const late = await owner.call("service:cards", "act", { card: CARD, component: "add", data: {} });
  assert.equal(late.ok === false && late.error.code, "conflict");
  await eventually(async () => (await owner.call("service:apps", "apps.describe", { id: "tally" })).ok === false || undefined, "the temporary app removed");
  void resultOf;
});
