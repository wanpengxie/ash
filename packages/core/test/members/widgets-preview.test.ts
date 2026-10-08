import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentMcpServer } from "../../src/agent-mcp/server";
import { WidgetsMember, type WidgetState } from "../../src/members/widgets";
import { OwnerMember } from "../../src/members/owner";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { wordContract } from "../../../sdk/src/words";
import { matchesSchema } from "../../../sdk/src/schema";

const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const phone: TrustedRouteContext = { member: "device:phone", transport: "phone", transportPrincipal: "phone:synthetic", local: true, remote: false, ownerProxy: true };
const ownerCtx: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "owner-login", local: true, remote: false, ownerProxy: true };

const card = { components: [{ id: "root", component: "Column", children: ["t"] }, { id: "t", component: "Text", text: "你好" }] };
/** A real (tiny) PNG: signature, IHDR, IDAT, IEND. */
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 3)]);
const shot = (extra: Record<string, unknown> = {}) => ({ png: PNG.toString("base64"), width: 720, height: 400, theme: "dark", dp: { width: 360, height: 200 }, ...extra });

type Answer = (state: WidgetState) => Record<string, unknown> | void;

async function fixture(answer?: Answer) {
  const dir = mkdtempSync(join(tmpdir(), "ash-preview-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  const state = { answer, pushes: [] as WidgetState[] };
  const member = new WidgetsMember({ router, file: join(dir, "widgets.json"), now: () => 1_000_000, previewWaitMs: 400,
    ...(answer ? { push: async (s: WidgetState) => { state.pushes.push(s); return (state.answer?.(s) ?? {}) as any; } } : {}) });
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  members.register(member);
  const call = async (ctx: TrustedRouteContext, word: string, body: Record<string, unknown>) =>
    (await router.send(ctx, { to: "service:widgets", kind: "request", word, body, wait: true })).reply!.body as any;
  return { dir, ledger, router, members, member, state, call, close: () => { member.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** What a phone that can draw previews answers: drawn, with a picture for every card it was asked about. */
const capable = (extra: Record<string, unknown> = {}): Answer => (s) => ({ widgets: [], previews: true,
  rendered: s.cards.map((c) => ({ card: c.id, updated_at: c.updated_at, ...(s.previews?.[c.id] !== undefined ? { preview: shot(extra), preview_ask: s.previews[c.id] } : {}) })) });

test("put returns the phone's preview as an image part and asks the phone for it", async () => {
  const f = await fixture(capable());
  try {
    const put = await f.call(agent, "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card });
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.equal(put.result.phone, "drawn");
    assert.deepEqual(put.result.preview, { type: "image", data: PNG.toString("base64"), mimeType: "image/png", width: 720, height: 400, theme: "dark", size: "4x2",
      layout_dp: { width: 360, height: 200 }, drawn_at: 1_000_000 });
    assert.equal(put.result.fresh, undefined);
    assert.deepEqual(f.state.pushes.at(-1)!.previews, { w: 1 });
    // The word contract accepts exactly this result.
    assert.equal(matchesSchema(wordContract("service:widgets", "widget.card.put")!.result_schema!, put.result), true);
    // Once the phone has answered, the request is not repeated by later pushes.
    await f.call(agent, "widget.card.remove", { id: "other" });
    await f.call(agent, "widget.card.put", { id: "w2", title: "x", size: "2x2", a2ui: card });
    assert.deepEqual(f.state.pushes.at(-1)!.previews, { w2: 2 });
  } finally { f.close(); }
});

test("an older phone that never sends a preview does not delay put, and the result has no preview keys", async () => {
  const f = await fixture((s) => ({ widgets: [], rendered: s.cards.map((c) => ({ card: c.id, updated_at: c.updated_at })) }));
  try {
    const started = Date.now();
    const put = await f.call(agent, "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card });
    assert.ok(Date.now() - started < 2000);
    assert.equal(put.result.phone, "drawn");
    assert.equal("preview" in put.result, false);
    assert.equal("preview_problem" in put.result, false);
    const look = await f.call(agent, "widget.card.preview", { id: "w" });
    assert.equal(look.ok, true);
    assert.equal(look.result.fresh, false);
    assert.match(look.result.preview_problem, /cannot draw card previews/);
  } finally { f.close(); }
});

test("a phone that could not draw the preview says so instead of sending an image", async () => {
  const f = await fixture((s) => ({ widgets: [], previews: true,
    rendered: s.cards.map((c) => ({ card: c.id, updated_at: c.updated_at, preview_problem: "预览画不出来：超时", preview_ask: s.previews?.[c.id] ?? 0 })) }));
  try {
    const put = await f.call(agent, "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card });
    assert.equal(put.result.preview, undefined);
    assert.equal(put.result.preview_problem, "预览画不出来：超时");
    assert.equal(matchesSchema(wordContract("service:widgets", "widget.card.put")!.result_schema!, put.result), true);
  } finally { f.close(); }
});

test("a preview that is not a PNG, is too large or has absurd sizes is refused", async () => {
  for (const bad of [{ png: Buffer.from("not a png at all, no signature here").toString("base64") }, { png: "A".repeat(400_000) }, { width: 5000 }, { theme: "sepia" }]) {
    const f = await fixture(capable(bad));
    try {
      const put = await f.call(agent, "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card });
      assert.equal(put.result.preview, undefined);
      assert.match(put.result.preview_problem, /not a valid image/);
    } finally { f.close(); }
  }
});

test("widget.card.preview asks the phone again, returns the new picture, and falls back to the last one when the phone is silent", async () => {
  let theme = "dark";
  const f = await fixture((s) => ({ widgets: [], previews: true,
    rendered: s.cards.map((c) => ({ card: c.id, updated_at: c.updated_at, ...(s.previews?.[c.id] !== undefined ? { preview: shot({ theme }), preview_ask: s.previews[c.id] } : {}) })) }));
  try {
    await f.call(agent, "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card });
    theme = "light";
    const look = await f.call(agent, "widget.card.preview", { id: "w" });
    assert.equal(look.ok, true, JSON.stringify(look));
    assert.equal(look.result.fresh, true);
    assert.equal(look.result.preview.theme, "light");
    assert.equal(look.result.card.id, "w");
    assert.equal(matchesSchema(wordContract("service:widgets", "widget.card.preview")!.result_schema!, look.result), true);
    assert.equal((await f.call(agent, "widget.card.preview", { id: "nope" })).error.code, "not_found");
    // The phone stops answering: the last picture comes back, marked as not fresh.
    f.state.answer = (s) => ({ widgets: [], previews: true, rendered: s.cards.map((c) => ({ card: c.id, updated_at: c.updated_at })) });
    const stale = await f.call(agent, "widget.card.preview", { id: "w" });
    assert.equal(stale.result.fresh, false);
    assert.equal(stale.result.preview.theme, "light");
    assert.match(stale.result.note, /last preview/);
  } finally { f.close(); }
});

test("a preview belongs to one version of the card: replacing the card drops it", async () => {
  const f = await fixture(capable());
  try {
    await f.call(agent, "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card });
    f.state.answer = (s) => ({ widgets: [], previews: true, rendered: s.cards.map((c) => ({ card: c.id, updated_at: c.updated_at })) });
    const again = await f.call(agent, "widget.card.put", { id: "w", title: "天气2", size: "4x2", a2ui: card });
    assert.equal(again.result.preview, undefined);
    assert.match(again.result.preview_problem, /did not finish/);
  } finally { f.close(); }
});

test("a late preview from the phone arrives with widget.placed (owner only) and a stale version is ignored", async () => {
  const f = await fixture(capable());
  try {
    await f.call(agent, "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card });
    const c = (await f.call(agent, "widget.list", {})).result.cards[0];
    f.state.answer = () => ({ widgets: [], previews: true });
    const ask = (await f.call(agent, "widget.card.preview", { id: "w" })).result;
    assert.equal(ask.fresh, false);
    await assert.rejects(f.call(phone, "widget.placed", { rendered: [{ card: "w", updated_at: c.updated_at, preview: shot({ width: 99999 }) }] }), /word schema/, "the contract bounds the picture size");
    const sent = await f.call(phone, "widget.placed", { rendered: [{ card: "w", updated_at: c.updated_at, preview: shot({ theme: "light" }), preview_ask: 99 }] });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    f.state.answer = () => ({ widgets: [], previews: true });
    assert.equal((await f.call(agent, "widget.card.preview", { id: "w" })).result.preview.theme, "light");
    await f.call(phone, "widget.placed", { rendered: [{ card: "w", updated_at: c.updated_at - 1, preview: shot({ theme: "dark" }), preview_ask: 100 }] });
    assert.equal((await f.call(agent, "widget.card.preview", { id: "w" })).result.preview.theme, "light");
    assert.equal((await f.call(agent, "widget.placed", { rendered: [] })).ok, false);
  } finally { f.close(); }
});

test("the preview reaches the agent over MCP as an image block, not as base64 text", async () => {
  const f = await fixture(capable());
  const server = new AgentMcpServer({ router: f.router, members: f.members, ledger: f.ledger, status: () => ({ paused: false }) });
  const url = await server.start();
  const binding = server.bind("agent:main", "main", () => null);
  const turn = new AbortController();
  binding.begin("t_widget", turn.signal);
  const client = new Client({ name: "agent", version: "1" });
  try {
    f.members.register({ id: "agent:main", kind: "agent", name: "Main", online: true, words: () => [], handle: () => ({ ok: true, result: {} }) } as any);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${binding.token}` } } }));
    for (const [word, body] of [["widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: card }], ["widget.card.preview", { id: "w" }]] as const) {
      const response = await client.callTool({ name: "capability_call", arguments: { member: "service:widgets", word, body } });
      const content = response.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      assert.equal(response.isError, undefined, JSON.stringify(content[0]));
      assert.equal(content.length, 2, `${word}: one text block and one image`);
      assert.deepEqual(content[1], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
      assert.doesNotMatch(content[0]!.text!, new RegExp(PNG.toString("base64").slice(0, 40).replace(/[+/]/g, "\\$&")));
      const result = (JSON.parse(content[0]!.text!) as { result: { result?: { preview: Record<string, unknown> }; preview?: Record<string, unknown> } }).result;
      const preview = (result.result ?? result).preview!;
      assert.match(String(preview.shown), /image 1 after this text/);
      assert.equal(preview.width, 720);
    }
  } finally { turn.abort(); await client.close(); await server.close(); f.close(); }
});

test("the put description tells the agent to look at the preview and fix what is cut off", () => {
  const description = wordContract("service:widgets", "widget.card.put")!.description;
  assert.match(description, /preview image/);
  assert.match(description, /cut-off text, overflow and empty lists/);
  const preview = wordContract("service:widgets", "widget.card.preview")!;
  assert.equal(preview.effect, "read");
  assert.match(preview.label ?? "", /[一-鿿]/);
});
