import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentTurnInput } from "../../core/src/members/agent";
import type { DshDoor } from "../src/door";
import type { DshHost, DshRootAgent, DshSessionEvent } from "../src/host";
import { DshTurnRunner, materializeFile, splitAssistantText, turnContent } from "../src/runtime";

test("paragraph splitting preserves fenced code, and materialization is atomic and name-independent", () => {
  assert.deepEqual(splitAssistantText("one\n\ntwo\n\n```ts\na()\n\nb()\n```\n\nlast"), ["one", "two", "```ts\na()\n\nb()\n```", "last"]);
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner uses followup once, waits for real idle outside listener, and suppresses late text after abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-turn-"));
  const listeners = new Set<(id: string, event: DshSessionEvent) => void>();
  let idle!: () => void;
  let followups = 0;
  let cancelled = 0;
  const events = (event: DshSessionEvent) => { for (const listener of listeners) listener("session-test", event); };
  const host = { ctx: { get() { return undefined; } }, onSessionEvent(listener: (id: string, event: DshSessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as DshHost;
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
