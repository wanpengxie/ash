import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("wake uses a second DSH session; only explicit ash_say reaches the owner", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-mind-"));
  const home = join(root, "home"); mkdirSync(home);
  const requests: { user: string; mind: boolean; worker: boolean; tools: string[] }[] = [];
  let serial = 0;
  const model = createServer(async (request, response) => {
    if (!request.url?.endsWith("/messages")) return void response.writeHead(404).end("{}");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as { model?: string; messages?: { role: string; content: unknown }[]; tools?: { name: string }[] };
    const user = (input.messages ?? []).filter((item) => item.role === "user").map((item) => JSON.stringify(item.content)).join("\n");
    const current = JSON.stringify((input.messages ?? []).filter((item) => item.role === "user").at(-1)?.content ?? "");
    const tour = current.includes("Reason: first_week_tour");
    const firstMeeting = current.includes("Reason: first_meeting");
    const mind = user.includes("This is your private mind space");
    const proactive = user.includes("worker:proactive/input");
    const worker = user.includes("worker:extract/input") || proactive;
    requests.push({ user, mind, worker, tools: (input.tools ?? []).map((item) => item.name) });
    const last = input.messages?.at(-1);
    const toolResult = JSON.stringify(last?.content ?? "").includes("tool_result");
    const callTool = firstMeeting || mind && !toolResult;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (kind: string, data: object) => response.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
    event("message_start", { message: { id: `msg_mind_${++serial}`, type: "message", role: "assistant", model: input.model,
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (callTool) {
      for (let i = 0; i < (firstMeeting ? 3 : 1); i++) {
        event("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_mind_say_${i + 1}`, name: "ash_say", input: {} } });
        event("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify({
          text: firstMeeting ? `FIRST_MEETING_${i + 1}` : tour ? "TOUR_PUBLIC_MESSAGE" : "MIND_PUBLIC_MESSAGE",
          kind: firstMeeting ? "reply" : "heads_up" }) } });
        event("content_block_stop", { index: i });
      }
    } else {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: proactive ? JSON.stringify({ suggestion: {
        kind: "heads_up", title: "Passport", text: "Passport renewal is due soon.", urgency: "regular", facts: [1],
      } }) : worker ? JSON.stringify({ no_change: { checked: [], details: "No new claims" } }) :
        mind ? "MIND_PRIVATE_OUTPUT" : "MAIN_VISIBLE_OUTPUT" } });
      event("content_block_stop", { index: 0 });
    }
    event("message_delta", { delta: { stop_reason: callTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } });
    event("message_stop", {}); response.end();
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install!, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      } } });
    const sessions = new Map<string, unknown[]>();
    const off = running.dsh!.onSessionEvent((id, event) => sessions.set(id, [...(sessions.get(id) ?? []), event]));
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const owner = { transport: "api" as const, transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}`,
      member: "person:owner", local: true, remote: false, ownerProxy: true };
    const clock = { transport: "service" as const, transportPrincipal: "service:clock", member: "service:clock", local: true, remote: false, ownerProxy: false };
    const first = await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "MAIN_FIRST" }, wait: true });
    assert.equal(first.reply?.body.ok, true);
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(check(), true, "timed out waiting for a DSH turn");
    };
    await until(() => running!.ledger.list().some((item) => item.word === "turn.end" && item.body.reason === "completed"));
    await until(() => running!.ledger.workRuns("tour").some((item) => item.state === "done"));
    assert.equal(requests.some((item) => item.user.includes("Reason: first_week_tour") && item.tools.includes("ash_say")), true);
    const wake = await running.world.send(clock, { to: "agent:main", kind: "request", word: "wake",
      body: { reason: "calendar", context: { marker: "MIND_WAKE_MARKER" } }, wait: true });
    assert.equal(wake.reply?.body.ok, true);
    const publicSays = running.ledger.list().filter((item) => item.from === "agent:main" && item.to === "person:owner" && item.kind === "request" && item.word === "say");
    assert.deepEqual(publicSays.map((item) => [item.body.text, item.body.kind]), [["MAIN_VISIBLE_OUTPUT", "reply"],
      ["TOUR_PUBLIC_MESSAGE", "heads_up"], ["MIND_PUBLIC_MESSAGE", "heads_up"]]);
    assert.equal(JSON.stringify(running.ledger.list()).includes("MIND_PRIVATE_OUTPUT"), false);
    const mainId = [...sessions].find(([, events]) => events.some((event) => JSON.stringify(event).includes(`core-`)))?.[0];
    const mindId = [...sessions].find(([, events]) => events.some((event) => JSON.stringify(event).includes(`wake-${wake.id}`)))?.[0];
    assert.ok(mainId && mindId && mainId !== mindId);
    assert.equal(JSON.stringify(sessions.get(mainId)).includes("MIND_WAKE_MARKER"), false);
    const second = await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "MAIN_AFTER" }, wait: true });
    assert.equal(second.reply?.body.ok, true);
    await until(() => requests.filter((item) => !item.mind && !item.worker).length >= 2);
    assert.equal(requests.filter((item) => !item.mind && !item.worker).some((item) => item.user.includes("MIND_WAKE_MARKER")), false);
    const extract = await running.world.send(owner, { to: "worker:extract", kind: "request", word: "extract",
      body: { run: "r_production", input: { chunk: [], summary: "", known: [] } }, wait: true });
    assert.equal(extract.reply?.body.ok, true);
    assert.deepEqual(extract.reply?.body.result, { no_change: { checked: [], details: "No new claims" } });
    assert.deepEqual(requests.find((item) => item.worker)?.tools, []);
    const memory = await running.world.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "memory" }, wait: true });
    assert.equal(memory.reply?.body.ok, true, JSON.stringify({ reply: memory.reply?.body, runs: running.ledger.workRuns("memory") }));
    const memoryRun = (memory.reply?.body.result as { run: string }).run;
    await until(() => running!.ledger.workRuns("memory").some((item) => item.run === memoryRun && item.state !== "running"));
    assert.equal(running.ledger.workRuns("memory").find((item) => item.run === memoryRun)?.state, "no_change");
    writeFileSync(join(home, "MEMORY.md"), "Passport expires on 2026-11-01\n");
    const suggestion = await running.world.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "proactive" }, wait: true });
    assert.equal(suggestion.reply?.body.ok, true);
    const suggestionRun = (suggestion.reply?.body.result as { run: string }).run;
    await until(() => running!.ledger.workRuns("proactive").some((item) => item.run === suggestionRun && item.state !== "running"));
    assert.equal(running.ledger.workRuns("proactive").find((item) => item.run === suggestionRun)?.state, "done");
    assert.deepEqual(requests.find((item) => item.user.includes("worker:proactive/input"))?.tools, []);
    const headsUp = running.ledger.list({ limit: 1000 }).filter((item) => item.from === "agent:main" && item.to === "person:owner" &&
      item.word === "say" && item.body.kind === "heads_up");
    assert.equal(headsUp.length, 3);
    await until(() => running!.ledger.list({ limit: 1000 }).some((item) => item.from === "service:post" && item.word === "post.delivery" &&
      item.body.message_id === headsUp[2].id));
    const registration = running.edge.screens.register({ member: "person:owner", transportPrincipal: owner.transportPrincipal,
      local: true, remote: false, ownerProxy: true, transport: "api" }, "test-scope", "Test screen");
    const visible = () => running!.edge.handle({ method: "POST", url: new URL("/api/send", running!.url),
      headers: { [SCREEN_TOKEN_HEADER.toLowerCase()]: registration.token }, body: Buffer.from(JSON.stringify({
        to: "service:post", kind: "event", word: "visible", body: {} })) },
      { member: "person:owner", transportPrincipal: owner.transportPrincipal, local: true, remote: false,
        ownerProxy: true, transport: "api" });
    assert.equal((await visible()).status, 200);
    const firstMeetingDone = () => running!.ledger.list({ limit: 1000 }).filter((item) => item.from === "agent:main" &&
      item.to === "person:owner" && item.word === "say" && String(item.body.text).startsWith("FIRST_MEETING_")).length === 3;
    const firstMeetingDeadline = Date.now() + 15_000;
    while (Date.now() < firstMeetingDeadline && !firstMeetingDone()) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(firstMeetingDone(), true, JSON.stringify({
      wake: running.ledger.list({ limit: 1000 }).filter((item) => item.word === "wake" && item.body.reason === "first_meeting")
        .map((item) => ({ id: item.id, reply: running!.ledger.responseTo(item.id)?.body })),
      says: running.ledger.list({ limit: 1000 }).filter((item) => String(item.body.text).startsWith("FIRST_MEETING_"))
        .map((item) => item.body.text) }));
    assert.deepEqual(running.ledger.list({ limit: 1000 }).filter((item) => String(item.body.text).startsWith("FIRST_MEETING_"))
      .map((item) => [item.body.text, item.body.kind]), [["FIRST_MEETING_1", "reply"], ["FIRST_MEETING_2", "reply"], ["FIRST_MEETING_3", "reply"]]);
    assert.equal((await visible()).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(running.ledger.list({ limit: 1000 }).filter((item) => String(item.body.text).startsWith("FIRST_MEETING_")).length, 3);
    off();
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
