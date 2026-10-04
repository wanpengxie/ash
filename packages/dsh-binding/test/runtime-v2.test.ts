import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentTurnInput } from "../../core/src/members/agent";
import { Ledger } from "../../core/src/world/ledger";
import { WorldRouter } from "../../core/src/world/router";
import type { DshDoor } from "../src/door";
import type { DshHost, DshRootAgent, DshSessionEvent } from "../src/host";
import { DshTurnRunner, materializeFile, splitAssistantText, turnContent } from "../src/runtime";

test("paragraph splitting preserves fenced code, and materialization is atomic and name-independent", () => {
  assert.deepEqual(splitAssistantText("one\n\ntwo\n\n```ts\na()\n\nb()\n```\n\nlast"), ["one", "two", "```ts\na()\n\nb()\n```", "last"]);
  assert.deepEqual(splitAssistantText("one\n\n````md\n```js\na()\n\nb()\n```\n\nstill fenced\n````\n\nlast"),
    ["one", "````md\n```js\na()\n\nb()\n```\n\nstill fenced\n````", "last"]);
  assert.deepEqual(splitAssistantText("~~~text\nline\n\n~~~ not closed\n\nstill fenced\n~~~  \n\nlast"),
    ["~~~text\nline\n\n~~~ not closed\n\nstill fenced\n~~~  ", "last"]);
  assert.deepEqual(splitAssistantText("   ```js\na()\n\n   ```  \n\nlast"), ["   ```js\na()\n\n   ```  ", "last"]);
  assert.deepEqual(splitAssistantText("    ```\n    a()\n\n    b()\n    ```\n\nlast"), ["    ```\n    a()\n\n    b()\n    ```", "last"]);
  const root = mkdtempSync(join(tmpdir(), "runtime-files-"));
  try {
    const directory = join(root, "inbox");
    const bytes = Buffer.from("synthetic", "utf8");
    const first = materializeFile(directory, "m_abc", 0, bytes);
    assert.deepEqual(materializeFile(directory, "m_abc", 0, bytes), first);
    assert.equal(readFileSync(first.path, "utf8"), "synthetic");
    assert.throws(() => materializeFile(directory, "m_abc", 0, Buffer.from("different")), /differs/);
    writeFileSync(first.path, "changed");
    assert.throws(() => materializeFile(directory, "m_abc", 0, bytes), /differs/);
    assert.throws(() => materializeFile(directory, "../escape", 0, bytes), /identity/);
    const alias = join(root, "alias"); symlinkSync(directory, alias);
    assert.throws(() => materializeFile(alias, "m_abc", 1, bytes), /safe directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("batch content sends bounded rendered text, image block, and sourced file path without raw-batch serialization", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-content-"));
  const saved: unknown[] = [];
  const host = { ctx: { get(name: string) { return name === "attachments" ? { async saveImage(value: unknown) { saved.push(value); return "image-ref"; } } : undefined; } } } as unknown as DshHost;
  const message = { id: "m_abc", seq: 1, ts: 1, from: "person:owner", to: "agent:main", kind: "request", word: "say",
    body: { text: "SECRET_RAW_CONTROL", attachments: [
      { name: "../malicious.txt", mime_type: "text/plain", data: Buffer.from("file bytes").toString("base64") },
      { name: "image.png", mime_type: "image/png", data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") },
    ] } } as AgentTurnInput["messages"][number];
  try {
    const content = await turnContent(host, { turn: "t_1", messages: [message], rendered: "BOUNDED_RENDERED", stopFacts: [] }, join(root, "inbox"), root);
    assert.match((content[0] as { text: string }).text, /^\[ash\] .* · person:owner\nBOUNDED_RENDERED$/);
    const ordered = await turnContent(host, { turn: "t_1", messages: [{ ...message, body: { text: "DYNAMIC_MARKER" } }], rendered: "DYNAMIC_MARKER", stopFacts: [] }, join(root, "inbox"), root,
      "SOUL_MARKER\nRULE_MARKER\nUSER_MARKER");
    const orderedText = (ordered[0] as { text: string }).text;
    const positions = ["SOUL_MARKER", "RULE_MARKER", "USER_MARKER", "DYNAMIC_MARKER"].map((marker) => orderedText.indexOf(marker));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
    assert.equal(JSON.stringify(content).includes("SECRET_RAW_CONTROL"), false);
    assert.equal((content[1] as { type: string }).type, "image");
    assert.equal(saved.length, 1);
    const note = (content[2] as { text: string }).text;
    assert.match(note, /m_abc.*sha256=.*path=/);
    assert.match(note, /image source id=m_abc.*sha256=/);
    assert.equal(note.includes("../malicious.txt"), true); // display metadata only
    const filePath = /path="([^"]+)"/.exec(note)?.[1];
    assert.ok(filePath && existsSync(filePath));
    assert.equal(readFileSync(filePath, "utf8"), "file bytes");
    await assert.rejects(turnContent(host, { turn: "t_2", messages: [{ ...message, body: { text: "", attachments: [{ name: "bad", mime_type: "text/plain", data: "!!!!" }] } }], rendered: "", stopFacts: [] }, join(root, "inbox"), root), /base64/);
    await assert.rejects(turnContent(host, { turn: "t_3", messages: [{ ...message, body: { text: "", attachments: [{ name: "fake.png", mime_type: "image/png", data: Buffer.from("not png").toString("base64") }] } }], rendered: "", stopFacts: [] }, join(root, "inbox"), root), /image attachment/);
    const overflowRoot = join(root, "overflow");
    const many = Array.from({ length: 33 }, (_, index) => ({ name: `file-${index}`, mime_type: "text/plain", data: Buffer.from("x").toString("base64") }));
    await assert.rejects(turnContent(host, { turn: "t_4", messages: [{ ...message, body: { text: "", attachments: many } }], rendered: "", stopFacts: [] }, overflowRoot, root), /too many attachments/);
    assert.equal(existsSync(overflowRoot), false);
    const longName = "x".repeat(250);
    await assert.rejects(turnContent(host, { turn: "t_5", messages: [{ ...message, body: { text: "", attachments: Array.from({ length: 20 }, () => ({ name: longName, mime_type: "text/plain", data: Buffer.from("x").toString("base64") })) } }], rendered: "", stopFacts: [] }, overflowRoot, root), /attachment batch exceeds/);
    assert.equal(existsSync(overflowRoot), false);
    const pathImage = join(root, "legacy.png");
    writeFileSync(pathImage, Buffer.from("89504e470d0a1a0a", "hex"));
    const pathContent = await turnContent(host, { turn: "t_6", messages: [{ ...message, body: { text: "", attachments: [{ name: "old.png", mime_type: "image/png", workspace: "home", path: "legacy.png" }] } }], rendered: "", stopFacts: [] }, overflowRoot, root);
    assert.equal((pathContent[1] as { type: string }).type, "image");
    assert.match((pathContent[2] as { text: string }).text, /workspace="home" path="legacy.png"/);
    assert.equal(existsSync(overflowRoot), false);
    const largeImage = join(root, "large.png");
    writeFileSync(largeImage, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(1_100_000)]));
    const previousSaves = saved.length;
    const repeated = Array.from({ length: 32 }, () => ({ name: "x", mime_type: "image/png", workspace: "home", path: "large.png" }));
    await assert.rejects(turnContent(host, { turn: "t_7", messages: [{ ...message, body: { text: "", attachments: repeated } }], rendered: "", stopFacts: [] }, overflowRoot, root), /byte budget/);
    assert.equal(saved.length, previousSaves);
    assert.equal(existsSync(overflowRoot), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner uses followup once, waits for real idle outside listener, and suppresses late text after abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-turn-"));
  const listeners = new Set<(id: string, event: DshSessionEvent) => void>();
  let idle!: () => void;
  let followups = 0;
  let cancelled = 0;
  const events = (event: DshSessionEvent) => { for (const listener of listeners) listener("session-test", event); };
  const host = { ctx: { get() { return undefined; } }, async modelKeyMissing() { return false; }, onSessionEvent(listener: (id: string, event: DshSessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as DshHost;
  const agent = { id: "root", followup(message: { id: string }) {
    followups++;
    events({ type: "user/message", data: { id: message.id } });
    events({ type: "assistant/message", data: { message: { id: "reply-1", content: [{ type: "text", text: "first\n\nsecond" }] } } });
    events({ type: "assistant/message", data: { message: { id: "reply-1", content: [{ type: "text", text: "duplicate" }] } } });
    events({ type: "turn/end", data: { reason: { kind: "completed" } } });
  }, cancel() { cancelled++; }, whenIdle() { return new Promise<void>((resolve) => { idle = resolve; }); } } as unknown as DshRootAgent;
  const turns: string[] = [];
  const door = { beginTurn(turn: string) { turns.push(`begin:${turn}`); }, endTurn(turn: string) { turns.push(`end:${turn}`); } } as unknown as DshDoor;
  const runner = new DshTurnRunner(host, join(root, "inbox"), root);
  runner.attach(agent, door, "session-test");
  const input: AgentTurnInput = { turn: "t_one", rendered: "bounded", messages: [], stopFacts: [] };
  const outputs: string[] = [];
  try {
    const first = runner.runTurn(input, async (output) => { outputs.push(output.text); }, new AbortController().signal);
    let returned = false; void first.then(() => { returned = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false); // a turn/end event is not a quiescence receipt
    await assert.rejects(runner.runTurn({ ...input, turn: "t_two" }, async () => {}, new AbortController().signal), /still busy/);
    idle();
    assert.deepEqual(await first, { reason: "completed" });
    assert.deepEqual(outputs, ["first", "second"]);
    assert.equal(followups, 1);
    assert.deepEqual(turns, ["begin:t_one", "end:t_one"]);
    const controller = new AbortController();
    const second = runner.runTurn({ ...input, turn: "t_three" }, async (output) => { outputs.push(output.text); }, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    events({ type: "assistant/message", data: { message: { id: "late", content: [{ type: "text", text: "late" }] } } });
    assert.equal(cancelled, 1);
    idle();
    assert.equal((await second).reason, "error");
    assert.deepEqual(outputs, ["first", "second", "first", "second"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DSH runner receives only the current turn's trusted screen execution preference", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-screen-plan-")), texts: string[] = [];
  let listener: ((id: string, event: DshSessionEvent) => void) | undefined;
  const host = { async modelKeyMissing() { return false; }, onSessionEvent(next: typeof listener) { listener = next; return () => { listener = undefined; }; } } as unknown as DshHost;
  const agent = { followup(message: { id: string; content: { text?: string }[] }) {
    texts.push(message.content.map((block) => block.text ?? "").join("\n"));
    listener!("screen-session", { type: "user/message", data: { id: message.id } });
    listener!("screen-session", { type: "turn/end", data: { reason: { kind: "completed" } } });
  }, cancel() {}, async whenIdle() {} } as unknown as DshRootAgent;
  const runner = new DshTurnRunner(host, join(root, "inbox"), root);
  runner.attach(agent, { beginTurn() {}, endTurn() {} } as unknown as DshDoor, "screen-session");
  try {
    const input: AgentTurnInput = { turn: "t_screen", messages: [], rendered: "帮我打开闲鱼", stopFacts: [],
      peripheralContext: "[Ash screen execution decision for THIS turn]\nMode: foreground_handoff; REAL phone screen" };
    assert.equal((await runner.runTurn(input, async () => {}, new AbortController().signal)).reason, "completed");
    assert.equal((await runner.runTurn({ ...input, turn: "t_next", peripheralContext: undefined }, async () => {}, new AbortController().signal)).reason, "completed");
    assert.match(texts[0], /Mode: foreground_handoff/); assert.doesNotMatch(texts[1], /Mode: foreground_handoff/);
    assert.match(texts[1], /Earlier turn-specific screen preferences do not apply/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DSH session tool call and result enter the core ledger under the current turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-tool-ledger-"));
  const ledger = await Ledger.open(join(root, "ash.db"));
  const router = new WorldRouter(ledger, () => true);
  const listeners = new Set<(id: string, event: DshSessionEvent) => void>();
  const events = (event: DshSessionEvent) => { for (const listener of listeners) listener("session-test", event); };
  const host = { ctx: { get() { return undefined; } }, async modelKeyMissing() { return false; }, onSessionEvent(listener: (id: string, event: DshSessionEvent) => void) {
    listeners.add(listener); return () => listeners.delete(listener);
  } } as unknown as DshHost;
  const agent = { id: "root", followup(message: { id: string }) {
    events({ type: "user/message", data: { id: message.id } });
    events({ type: "tool/call", data: { callId: "call-1", name: "read", arguments: '{"file_path":"note.txt"}' } });
    events({ type: "tool/result", data: { message: { toolCallId: "call-1", content: [{ type: "text", text: "read ok" }] } } });
    events({ type: "turn/end", data: { reason: { kind: "completed" } } });
  }, cancel() {}, async whenIdle() {} } as unknown as DshRootAgent;
  const door = { beginTurn() {}, endTurn() {} } as unknown as DshDoor;
  const runner = new DshTurnRunner(host, join(root, "inbox"), root, router);
  runner.attach(agent, door, "session-test");
  try {
    const result = await runner.runTurn({ turn: "t_audit", messages: [], rendered: "read note", stopFacts: [] }, async () => {}, new AbortController().signal);
    assert.deepEqual(result, { reason: "completed" });
    const call = ledger.list().find((item) => item.to === "service:dsh-tool" && item.kind === "request");
    assert.ok(call);
    assert.equal(call.turn, "t_audit");
    assert.equal(call.word, "read");
    assert.equal(call.body.arguments, '{"file_path":"note.txt"}');
    const reply = ledger.responseTo(call.id);
    assert.equal(reply?.body.ok, true);
    assert.equal(reply?.turn, "t_audit");
    const orphan = router.recordDshToolCall("t_audit", "call-2", "write", '{"file_path":"other.txt"}');
    await router.recover();
    assert.equal((ledger.responseTo(orphan.id)?.body.error as { code?: string } | undefined)?.code, "failed");
  } finally { ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a closing message that only retells what ash_say already said is recognised; a real continuation is not", async () => {
  const { retells } = await import("../src/runtime");
  const said = ["标题：Example Domain。可点的只有一处：「Learn more」链接，指向 iana.org/help/example-domains，它在页面下方（要滚动一点才看得到）。页面已关掉。"];
  assert.equal(retells("标题：Example Domain。可点的只有一处：「Learn more」链接，指向 iana.org/help/example-domains，位置在页面下方（要滚动一点才看得到）。页面已关掉。", said), true);
  assert.equal(retells("页面标题是 Example Domain，只有一个「Learn more」链接，指向 iana.org/help/example-domains。", said), true);
  // A short heads-up followed by the actual answer is not a retelling.
  assert.equal(retells("明天 10:00–12:00 读书会，20:00–21:00 健身，下午整段留给家人，没有别的安排。", ["我先查一下你的日历。"]), false);
  assert.equal(retells("好。", said), false);
  assert.equal(retells("根据日历，周六下午 3 点有读书会，周日上午 10 点还有一场，两场都是两个小时。", said), false);
});
