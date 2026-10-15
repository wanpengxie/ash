/**
 * docs/GENUI.md: cards in the conversation, forms with a password box, and vault entries used by name. Everything through
 * the hub's port: an agent shows and changes a card, the owner acts on it; an agent asks with a form, the owner's screen
 * saves the password in the vault and answers with a mask, the agent runs a command with `$vault.<name>`, and the value
 * is nowhere in the ledger.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../sdk/src/message";
import { accepted, bodyOf, byOwnerText, dataOf, errorCode, isApprovalAsk, OWNER, resultOf, startScenario, toOwner, type ToolResult } from "./harness";
import { eventually } from "../fixtures/wait";

const SECRET = "hunter2-Very-Secret-9f3k";
const REF = "WB_VPS_PASSWORD";
const plan = (item: { card?: { plan?: { components?: { id: string; component: string; text?: string; value?: number }[] } } }) => item.card?.plan?.components ?? [];

/** The conversation item of message [id], as every channel draws it. */
async function itemOf(owner: { call(to: string, word: string, body?: Record<string, unknown>): Promise<unknown> }, id: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const window = dataOf(await owner.call("service:history", "window", { limit: 40 }) as never) as { items: { id: string }[] };
  return window.items.find((item) => item.id === id);
}

test("an agent shows a card it designed, changes it in place, and hears the owner's action with the card's values", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { shown?: ToolResult; updated?: ToolResult; bad?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "做张卡": async (turn) => {
      state.bad = await turn.call(OWNER, "show", { a2ui: { components: [{ id: "root", component: "Video", url: "x" }] } });
      state.shown = await turn.call(OWNER, "show", { id: "trip", a2ui: {
        components: [
          { id: "root", component: "Column", children: ["title", "n", "count", "go", "later", "nope"] },
          { id: "title", component: "Text", text: "**订几张票？**" },
          { id: "n", component: "Slider", label: "张数", min: 1, max: 6, value: { path: "/n" } },
          { id: "count", component: "Text", text: { call: "formatString", args: { value: "共 ${/n} 张" } } },
          { id: "go", component: "Button", child: "go.t", action: { event: { name: "book", context: { what: "train" } } } },
          { id: "go.t", component: "Text", text: "帮我订" },
          { id: "nope", component: "Marquee", text: "x" },
        ],
        data: { n: 2 },
      } });
      state.updated = await turn.call(OWNER, "card.update", { id: "trip", data: { "/n": 3 } });
    },
  }));
  const owner = await s.human();
  accepted(await owner.say("做张卡"));
  await eventually(() => state.updated, "the card shown and updated");

  assert.equal(errorCode(state.bad!), "bad_request", "a card whose root cannot be drawn is refused before anything is recorded");
  assert.equal(state.shown!.isError, false);
  const shown = resultOf(state.shown!) as { card: string; problems: string[] };
  assert.equal(shown.card, "trip");
  assert.ok(shown.problems.some((p) => p.includes("Marquee")), "an unknown component is left out and reported");
  assert.ok(shown.problems.some((p) => p.includes("later") && p.includes("placeholder")), "a missing child is a placeholder");
  assert.deepEqual((resultOf(state.shown!) as { hints?: string[] }).hints, undefined, "a plain card gets no design hints");
  assert.equal(owner.messages.filter((m) => m.to === OWNER && m.word === "show" && m.from === "agent:main").length, 1, "the refused card never reached the conversation");

  const message = await owner.seen(toOwner("show", "agent:main"), "the card in the conversation");
  let item = await itemOf(owner, message.id);
  assert.equal(item.card.type, "a2ui");
  assert.equal(item.card.id, "trip");
  assert.equal(item.card.state, "open");
  assert.equal(item.card.plan.reactive, true, "a text reads the slider's path: the card follows the slider on the phone");
  assert.equal(plan(item).find((c) => c.id === "count")?.text, "共 3 张", "card.update changed the card where it is");
  assert.ok(plan(item).some((c) => c.component === "Skeleton"), "the placeholder is drawn");

  // The owner slides to 5: the draft is kept and the card drawn again with it, without the agent.
  const draft = await owner.call(OWNER, "card.draft", { card: "trip", data: { n: 5 } });
  assert.ok(draft.ok, JSON.stringify(draft));
  assert.equal((dataOf(draft) as { plan: { components: { id: string; text?: string }[] } }).plan.components.find((c) => c.id === "count")?.text, "共 5 张");
  item = await itemOf(owner, message.id);
  assert.equal(plan(item).find((c) => c.id === "count")?.text, "共 5 张", "a refresh shows what the owner entered");

  accepted(await owner.send({ to: "agent:main", kind: "request", word: "say", body: { text: "帮我订", card: { id: "trip", action: "book", context: { what: "train" }, data: { n: 5 } } } }));
  const { message: told } = await s.driver.delivery((m) => m.text.startsWith("[card trip, action book]"), "the action reaches the agent");
  assert.ok(told.text.includes("\"n\":5") && told.text.includes("\"what\":\"train\""), "with the card's values and the action's context");

  // 👍 reaches the creator as the owner's taste, and stays with the card.
  accepted(await owner.send({ to: "agent:main", kind: "request", word: "say", body: { text: "👍", card: { id: "trip", action: "feedback", context: { feedback: "up" } } } }));
  await s.driver.delivery((m) => m.text.startsWith("[card trip, feedback up]"), "the feedback reaches the agent");
  item = await eventually(async () => { const it = await itemOf(owner, message.id); return it.card.feedback === "up" ? it : undefined; }, "the feedback kept with the card");
});

test("a form with a password box: the value goes into the vault, the agent uses it by name, and it is nowhere in the ledger", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { form?: ToolResult; ran?: ToolResult; again?: ToolResult; missing?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "登 VPS": async (turn) => {
      state.form = await turn.call(OWNER, "form", {
        title: "登录 wb VPS", why: "替你在上面跑命令",
        schema: { type: "object", properties: { host: { type: "string", title: "地址", examples: ["1.2.3.4"] }, port: { type: "integer", title: "端口", default: 22 }, password: { type: "string", title: "密码" } }, required: ["host", "password"] },
        secret: { password: REF },
      }, { wait: true });
      const env = { SSHPASS: `$vault.${REF}` };
      const command = "echo pass=$SSHPASS; printf %s \"$SSHPASS\" | base64; echo done";
      let ran = await turn.call("body:main", "workspace.bash", { command, env }, { wait: true });
      const pending = (resultOf(ran) as { status?: string; pending_id?: string } | undefined);
      if (pending?.status === "waiting_owner") {
        await eventually(() => s.driver.deliveries.length > 1 || undefined, "the owner's answer", 20_000).catch(() => undefined);
        ran = await turn.tool("human_pending_redeem", { id: pending.pending_id });
      }
      state.ran = ran;
      // The second time on the same body: no card (the owner chose 「以后都可以」).
      state.again = await turn.call("body:main", "workspace.bash", { command: "echo again=$SSHPASS", env }, { wait: true });
      state.missing = await turn.call("body:main", "workspace.bash", { command: "echo x", env: { X: "$vault.NOT_THERE" } }, { wait: true });
    },
  }));
  const owner = await s.human();
  accepted(await owner.say("登 VPS"));

  const form = await owner.seen(toOwner("form", "agent:main"), "the form card");
  let item = await itemOf(owner, form.id);
  assert.equal(item.card.type, "a2ui");
  assert.deepEqual(item.card.form.secret, { password: REF });
  const password = plan(item).find((c) => c.component === "TextField" && (c as { variant?: string }).variant === "obscured");
  assert.ok(password, "the password field is a password box");
  assert.equal(JSON.stringify(item.card.plan.data).includes("password"), false, "a password is never part of the card's data");

  // The owner's screen: the password into the vault first, then the answer with the mask only.
  const saved = await owner.call("service:vault", "set", { ref: REF, value: SECRET, label: "密码" });
  assert.ok(saved.ok, JSON.stringify(saved));
  accepted(await owner.send({ to: "agent:main", kind: "response", word: "form", reply_to: form.id,
    body: { ok: true, result: { data: { values: { host: "1.2.3.4", port: "2222" }, secret: { password: { ref: REF, masked: `****${SECRET.slice(-4)}` } } } } } }));

  await eventually(() => state.form, "the form's answer");
  assert.equal(state.form!.isError, false, JSON.stringify(state.form));
  assert.deepEqual(resultOf(state.form!), { values: { host: "1.2.3.4", port: 2222 }, secret: { password: { ref: REF, masked: `****${SECRET.slice(-4)}` } } });
  item = await itemOf(owner, form.id);
  assert.equal(item.card.state, "sent");

  // The first use of the name on the phone's body asks the owner once; 「以后都可以」 remembers it.
  const card = await owner.seen(isApprovalAsk, "the approval card for the vault entry");
  assert.ok(String(bodyOf(card).detail).includes("用保险箱里的『密码』在 手机 上执行"), String(bodyOf(card).detail));
  accepted(await owner.answer(card, "always"));

  await eventually(() => state.missing, "the commands", 120_000);
  // Approved in time it is this call's result; approved later, the redeem's.
  const ran = resultOf(state.ran!) as { output?: string; result?: { output: string } };
  const out = (ran.result ?? ran) as { output: string };
  assert.ok(out.output !== undefined, JSON.stringify(state.ran));
  assert.ok(out.output.includes("pass=***"), out.output);
  assert.ok(out.output.includes("done"));
  assert.equal(out.output.includes(SECRET), false);
  assert.equal(out.output.includes(Buffer.from(SECRET).toString("base64")), false, "its base64 is masked too");
  // The command itself is still the gate's to judge (a command is never remembered), but the vault entry is not asked about again.
  const second = owner.messages.filter(isApprovalAsk)[1];
  assert.equal((resultOf(state.again!) as { status?: string }).status, "waiting_owner");
  assert.equal(String(bodyOf(second!).detail).includes("保险箱"), false, "the name is not asked about again on this body");
  assert.equal(owner.messages.filter(isApprovalAsk).length, 2, "and a name the vault does not have is refused without a card");
  assert.equal(errorCode(state.missing!), "not_found", "a name the vault does not have");

  const ledger = JSON.stringify(await owner.ledger());
  assert.equal(ledger.includes(SECRET), false, "the value is nowhere in the ledger");
  assert.equal(ledger.includes(Buffer.from(SECRET).toString("base64")), false);
  assert.ok(ledger.includes(`$vault.${REF}`), "the ledger keeps the name");
});

test("a form the owner cancels fails with cancelled; service:vault/request asks with a form in the conversation", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { form?: ToolResult; asked?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "填表": async (turn) => { state.form = await turn.call(OWNER, "form", { title: "选个日子", schema: { type: "object", properties: { day: { type: "string", format: "date" } } } }, { wait: true }); },
    "要钥匙": async (turn) => { state.asked = await turn.call("service:vault", "request", { ref: "SOME_KEY", label: "某服务的密钥", why: "调它的接口", help_url: "https://example.com/keys" }); },
  }));
  const owner = await s.human();
  accepted(await owner.say("填表"));
  const form = await owner.seen(toOwner("form", "agent:main"), "the form");
  accepted(await owner.send({ to: "agent:main", kind: "response", word: "form", reply_to: form.id, body: { ok: false, error: { code: "cancelled", message: "主人取消了" } } }));
  await eventually(() => state.form, "the cancelled form");
  assert.equal(errorCode(state.form!), "cancelled");

  accepted(await owner.say("要钥匙"));
  const asked = await owner.seen((m: Message) => m.to === OWNER && m.word === "form" && m.from === "service:vault", "the key's form card");
  const item = await itemOf(owner, asked.id);
  assert.deepEqual(item.card.form.secret, { value: "SOME_KEY" });
  assert.ok(String(bodyOf(asked).why).includes("https://example.com/keys"), "where to get it is on the card");
  assert.equal((resultOf(state.asked!) as { status: string }).status, "waiting");
  const saved = await owner.call("service:vault", "set", { ref: "SOME_KEY", value: "k-123456789" });
  assert.ok(saved.ok);
  accepted(await owner.send({ to: "service:vault", kind: "response", word: "form", reply_to: asked.id, body: { ok: true, result: { data: { values: {}, secret: { value: { ref: "SOME_KEY", masked: "****6789" } } } } } }));
  const { message } = await s.driver.delivery((m) => m.text.includes("主人存好了 SOME_KEY"), "the agent is told the key is saved");
  assert.ok(message);
});
