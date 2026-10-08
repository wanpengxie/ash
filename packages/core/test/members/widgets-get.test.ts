import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchesSchema } from "../../../sdk/src/schema";
import { wordContract } from "../../../sdk/src/words";
import { WidgetsMember, type WidgetState } from "../../src/members/widgets";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const agent = (id: string): TrustedRouteContext => ({ member: id, transport: "agent", transportPrincipal: id, local: true, remote: false, ownerProxy: false });
const phone: TrustedRouteContext = { member: "device:phone", transport: "phone", transportPrincipal: "phone:synthetic", local: true, remote: false, ownerProxy: true };
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 3)]);
const shot = { png: PNG.toString("base64"), width: 720, height: 400, theme: "dark", dp: { width: 360, height: 200 } };

/** A card with an ordinary button and two feedback buttons worded however the agent liked. */
const asking = {
  components: [
    { id: "root", component: "Column", children: ["line", "refresh", "more", "less"] },
    { id: "line", component: "Text", text: "今天走了 8000 步" },
    { id: "refresh", component: "Button", child: "rl", action: { event: { name: "refresh" } } }, { id: "rl", component: "Text", text: "刷新" },
    { id: "more", component: "Button", child: "ml", action: { event: { name: "more", context: { feedback: "多说点这个" } } } }, { id: "ml", component: "Text", text: "多说点" },
    { id: "less", component: "Button", child: "ll", action: { event: { name: "less", context: { feedback: "太啰嗦了" } } } }, { id: "ll", component: "Text", text: "太啰嗦" },
  ],
};

async function fixture(options: { file?: string; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "ash-widget-get-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  const member = new WidgetsMember({ router, file: join(dir, "widgets.json"), now: () => 1_000_000, previewWaitMs: 400,
    push: async (s: WidgetState) => ({ widgets: [], previews: true,
      rendered: s.cards.map((c) => ({ card: c.id, updated_at: c.updated_at, ...(s.previews?.[c.id] !== undefined ? { preview: shot, preview_ask: s.previews[c.id] } : {}) })) }) as any });
  const members = new WorldMembers(router);
  members.register(member);
  const heard: string[] = [];
  members.register({ id: "agent:main", kind: "agent", name: "Main", online: true,
    words: () => [wordContract("agent:main", "say")!],
    handle: (message: any) => { heard.push(String(message.body.text)); return { ok: true, result: { accepted: true } }; } } as any);
  const call = async (ctx: TrustedRouteContext, word: string, body: Record<string, unknown>) =>
    (await router.send(ctx, { to: "service:widgets", kind: "request", word, body, wait: true })).reply!.body as any;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  return { dir, ledger, router, member, call, heard, settle, close: () => { member.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("widget.card.get returns the card's content, size, owner, version, feedback and the latest preview", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(agent("agent:main"), "widget.card.get", { id: "nothing" })).error.code, "not_found");
    const put = await f.call(agent("agent:main"), "widget.card.put", { id: "today", title: "今天", size: "4x2", a2ui: asking });
    assert.equal(put.ok, true, JSON.stringify(put));
    const got = await f.call(agent("agent:main"), "widget.card.get", { id: "today" });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.result.card.size, "4x2");
    assert.equal(got.result.card.owner, "agent:main");
    assert.equal(got.result.card.updated_at, 1_000_000);
    assert.deepEqual(got.result.a2ui, asking);
    assert.deepEqual(got.result.feedback, []);
    assert.deepEqual(got.result.preview, put.result.preview);
    assert.equal(got.result.preview.type, "image");
    assert.equal(matchesSchema(wordContract("service:widgets", "widget.card.get")!.result_schema!, got.result), true);
    // The picture is the same one widget.card.preview shows.
    const look = await f.call(agent("agent:main"), "widget.card.preview", { id: "today" });
    assert.equal(look.result.preview.data, got.result.preview.data);
    // After a restart the picture is drawn again, on request.
    const again = await fixture({ dir: f.dir });
    try { assert.equal((await again.call(agent("agent:main"), "widget.card.get", { id: "today" })).result.preview.type, "image"); }
    finally { again.member.close(); again.ledger.close(); }
  } finally { f.close(); }
});

test("a feedback button is recorded on the card and wakes nobody; an ordinary button still reaches the creator", async () => {
  const f = await fixture();
  try {
    await f.call(agent("agent:main"), "widget.card.put", { id: "today", title: "今天", size: "4x2", a2ui: asking });
    const tap = await f.call(phone, "widget.tap", { card: "today", component: "more" });
    assert.equal(tap.ok, true, JSON.stringify(tap));
    await f.call(phone, "widget.tap", { card: "today", component: "less" });
    await f.settle();
    assert.deepEqual(f.heard, [], "feedback is not a message to the agent");
    // The event is on the ledger with its context, for whoever keeps the history.
    const events = f.ledger.list({ limit: 100 }).filter((m) => m.word === "widget.action");
    assert.deepEqual(events.map((m) => (m.body.context as any).feedback), ["多说点这个", "太啰嗦了"]);
    // The agent reads it back, tied to the version of the card that was answered.
    const got = await f.call(agent("agent:main"), "widget.card.get", { id: "today" });
    assert.deepEqual(got.result.feedback.map((item: any) => [item.feedback, item.action, item.card_updated_at, item.component]),
      [["多说点这个", "more", 1_000_000, "more"], ["太啰嗦了", "less", 1_000_000, "less"]]);
    assert.equal(matchesSchema(wordContract("service:widgets", "widget.card.get")!.result_schema!, got.result), true);
    // Ordinary taps are unchanged.
    await f.call(phone, "widget.tap", { card: "today", component: "refresh" });
    await f.settle();
    assert.equal(f.heard.length, 1);
    assert.match(f.heard[0], /refresh/);
    assert.equal((await f.call(agent("agent:main"), "widget.card.get", { id: "today" })).result.feedback.length, 2);
    // A new version of the card keeps what was said about the old one; removing the card forgets it.
    await f.call(agent("agent:main"), "widget.card.put", { id: "today", title: "今天", size: "4x2", a2ui: { ...asking, components: asking.components.map((c) => c.id === "line" ? { ...c, text: "改过了" } : c) } });
    assert.equal((await f.call(agent("agent:main"), "widget.card.get", { id: "today" })).result.feedback.length, 2);
    await f.call(agent("agent:main"), "widget.card.remove", { id: "today" });
    await f.call(agent("agent:main"), "widget.card.put", { id: "today", title: "今天", size: "4x2", a2ui: asking });
    assert.deepEqual((await f.call(agent("agent:main"), "widget.card.get", { id: "today" })).result.feedback, []);
  } finally { f.close(); }
});

test("feedback survives a restart", async () => {
  const f = await fixture();
  try {
    await f.call(agent("agent:main"), "widget.card.put", { id: "today", title: "今天", size: "4x2", a2ui: asking });
    await f.call(phone, "widget.tap", { card: "today", component: "more" });
    f.member.close();
    const again = new WidgetsMember({ router: f.router, file: join(f.dir, "widgets.json"), now: () => 2_000_000 });
    const state = again.snapshot();
    assert.equal(state.cards.length, 1);
    const reply = await again.handle({ id: "m", seq: 1, ts: 1, from: "agent:main", to: "service:widgets", kind: "request", word: "widget.card.get", body: { id: "today" } }, { signal: new AbortController().signal, recovered: false });
    assert.equal((reply as any).result.feedback[0].feedback, "多说点这个");
    again.close();
  } finally { f.close(); }
});
