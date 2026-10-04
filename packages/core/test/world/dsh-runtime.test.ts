import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

type JsonPost = (url: string, init: RequestInit) => Promise<Response>;

/** A lost transport response may be retried only with the identical durable client_id and JSON bytes. */
async function postWithOneResetRetry(url: string, token: string, payload: { client_id: string; [key: string]: unknown }, post: JsonPost = fetch): Promise<{ response: Response; retried: boolean }> {
  if (!payload.client_id) throw new TypeError("retry requires a stable client_id");
  const init: RequestInit = { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) };
  try { return { response: await post(url, init), retried: false }; }
  catch (first) {
    if (!(first instanceof TypeError) || (first as TypeError & { cause?: { code?: string } }).cause?.code !== "ECONNRESET") throw first;
    try { return { response: await post(url, init), retried: true }; }
    catch (second) { throw new AggregateError([first, second], "POST retry failed after ECONNRESET"); }
  }
}

test("an ambiguous reset retries one identical send and does not retry other failures", async () => {
  const calls: { body: string; auth: string }[] = [];
  const body = { to: "agent:main", kind: "request", word: "say", body: { text: "fixture" }, client_id: "one-stable-id" };
  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  const post: JsonPost = async (_url, init) => {
    calls.push({ body: String(init.body), auth: (init.headers as Record<string, string>).authorization });
    if (calls.length === 1) throw reset;
    return new Response(JSON.stringify({ id: "accepted" }), { status: 200 });
  };
  const recovered = await postWithOneResetRetry("http://127.0.0.1/fixture", "synthetic", body, post);
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.retried, true);
  assert.deepEqual(calls, [{ body: JSON.stringify(body), auth: "Bearer synthetic" }, { body: JSON.stringify(body), auth: "Bearer synthetic" }]);
  let resetCalls = 0;
  await assert.rejects(postWithOneResetRetry("http://127.0.0.1/fixture", "synthetic", body, async () => { resetCalls++; throw reset; }),
    (failure: unknown) => failure instanceof AggregateError && failure.errors.length === 2 && failure.errors[0] === reset && failure.errors[1] === reset);
  assert.equal(resetCalls, 2);
  await assert.rejects(postWithOneResetRetry("http://127.0.0.1/fixture", "synthetic", { client_id: "" }, post), /stable client_id/);
  let failedCalls = 0;
  await assert.rejects(postWithOneResetRetry("http://127.0.0.1/fixture", "synthetic", body, async () => {
    failedCalls++;
    throw new TypeError("unrelated failure");
  }), /unrelated failure/);
  assert.equal(failedCalls, 1);
});

test("an accepted send with a lost HTTP acknowledgement retries without a second inbox message", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "send-ack-loss-"));
  const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  try {
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const payload = { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic ACK loss" }, client_id: "accepted-before-reset" };
    const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    let firstId: string | null = null;
    let attempts = 0;
    const post: JsonPost = async (url, init) => {
      attempts++;
      const response = await fetch(url, init);
      if (attempts === 1) {
        assert.equal(response.status, 200);
        firstId = (await response.json() as { id: string }).id;
        throw reset; // The server accepted it, but this caller did not receive the acknowledgement.
      }
      return response;
    };
    const { response, retried } = await postWithOneResetRetry(`${running.url}/api/send`, token, payload, post);
    assert.equal(response.status, 200);
    assert.equal(retried, true);
    const retriedMessage = await response.json() as { id: string };
    assert.equal(attempts, 2);
    assert.equal(retriedMessage.id, firstId);
    const principal = running.edge.localCaller({ authorization: `Bearer ${token}` })!.transportPrincipal;
    assert.equal(running.ledger.retryMessage(principal, payload.client_id)?.id, retriedMessage.id);
    const received = running.ledger.list().filter((message) => message.from === "person:owner" && message.to === "agent:main" && message.word === "say" && message.kind === "request");
    assert.equal(received.length, 1, JSON.stringify(received.map((message) => ({ id: message.id, kind: message.kind }))));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !running.ledger.list().some((message) => message.from === "agent:main" && message.to === "person:owner" && message.word === "say"))
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(running.ledger.list().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.word === "say" && message.kind === "request").length, 1);
  } finally { await running.close(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("production DSH main uses one bounded followup, routes its tool once, and splits only assistant text", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-main-"));
  const home = join(root, "home"); mkdirSync(home);
  writeFileSync(join(home, "fixture.txt"), "NATIVE_READ_FIXTURE\n");
  writeFileSync(join(home, "SOUL.md"), "SOUL_ORIGINAL\n");
  const captured: { tools: string[]; user: string; toolResult: boolean; resultText: string }[] = [];
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: { name: string }[]; messages?: { role: string; content: unknown }[]; model?: string };
      const tools = (request.tools ?? []).map((tool) => tool.name);
      const last = request.messages?.at(-1);
      const toolResult = Array.isArray(last?.content) && last.content.some((part: { type?: string }) => part.type === "tool_result");
      const user = (request.messages ?? []).filter((message) => message.role === "user").flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "") : []).join("\n");
      // The first main say may independently wake the first-week tour mind; it is not a main turn step.
      const isMind = user.includes("This is your private mind space");
      if (tools.length && !isMind)
        captured.push({ tools, user, toolResult, resultText: JSON.stringify(last?.content ?? "") });
      const step = captured.length;
      const privateRead = tools.length > 0 && !isMind && user.includes("read core private") && !toolResult;
      const nativeWrite = tools.length > 0 && !isMind && !privateRead && user.includes("write soul directly") && !toolResult;
      const nativeRead = tools.length > 0 && !isMind && !privateRead && !nativeWrite && user.includes("read my fixture") && !toolResult;
      const toolUse = Boolean(tools.length && !isMind && (step <= 3 || nativeRead || nativeWrite || privateRead));
      const messageId = /\bid=([A-Za-z0-9_-]+)/.exec(user)?.[1] ?? "missing";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_main", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (toolUse) {
        const tool = privateRead || nativeRead ? "read" : nativeWrite ? "write" : step === 1 ? "ash_say" : "ash_react";
        const input = privateRead ? { file_path: join(root, "state", "private-fixture.txt") }
          : nativeRead ? { file_path: "fixture.txt" } : nativeWrite ? { file_path: "SOUL.md", content: "WRONG\n" }
          : step === 1 ? { text: "tool said" } : { message_id: step === 2 ? messageId : "missing", emoji: "❤" };
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_main_${step}`, name: tool, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "first\n\nsecond\n\n```js\na()\n\nb()\n```" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: toolUse ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  let soulWatcher: ReturnType<typeof watch> | null = null;
  const soulChanges: string[] = [];
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install!, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      } } });
    writeFileSync(join(root, "state", "private-fixture.txt"), "PRIVATE_CORE_SECRET\n");
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const response = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "synthetic input" }, client_id: "dsh-main-input" }) });
    assert.equal(response.status, 200);
    await response.json();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && running.ledger.list().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.kind === "request" && message.word === "say").length < 4)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(captured.length, 4);
    assert.deepEqual(captured[0].tools.sort(), ["ash_describe", "ash_react", "ash_say", "ash_send", "ash_show",
      "edit", "glob", "grep", "read", "read_image", "web_fetch", "web_search", "write"]);
    assert.equal(captured[1].toolResult, true);
    assert.match(captured[3].resultText, /not_found/);
    assert.match(captured[0].user, /synthetic input/);
    const says = running.ledger.list().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.word === "say" && message.kind === "request");
    assert.deepEqual(says.map((message) => message.body.text), ["tool said", "first", "second", "```js\na()\n\nb()\n```"]);
    assert.equal(new Set(says.map((message) => message.turn)).size, 1);
    const reacts = running.ledger.list().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.word === "react" && message.kind === "request");
    assert.equal(reacts.length, 2);
    assert.deepEqual(reacts.map((message) => running!.ledger.responseTo(message.id)?.body.ok), [true, false]);
    assert.equal(running.ledger.list().filter((message) => message.word === "turn.end" && message.body.reason === "completed").length, 1);
    const inline = { name: "fixture.txt", mime_type: "text/plain", data: Buffer.from("SYNTHETIC_FILE_BYTES").toString("base64") };
    const { response: onlyAttachment, retried } = await postWithOneResetRetry(`${running.url}/api/send`, token,
      { to: "agent:main", kind: "request", word: "say", body: { text: "", attachments: [inline] }, client_id: "dsh-attachment-only" });
    if (retried) console.error("attachment POST recovered one ECONNRESET with the same client_id");
    assert.equal(onlyAttachment.status, 200);
    const accepted = await onlyAttachment.json() as { id: string };
    assert.deepEqual(running.ledger.byId(accepted.id)?.body, { text: "", attachments: [inline] });
    const principal = running.edge.localCaller({ authorization: `Bearer ${token}` })!.transportPrincipal;
    assert.equal(running.ledger.retryMessage(principal, "dsh-attachment-only")?.id, accepted.id);
    assert.equal(running.ledger.list().filter((message) => message.id === accepted.id).length, 1);
    const nextDeadline = Date.now() + 15_000;
    while (Date.now() < nextDeadline && captured.length < 5) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(captured.length, 5);
    assert.match(captured[4].user, /fixture\.txt/);
    assert.match(captured[4].user, /attachment source id=/);
    assert.ok(!captured[4].user.includes("SYNTHETIC_FILE_BYTES"));
    assert.ok(!captured[4].user.includes(inline.data));
    const readResponse = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "read my fixture" }, client_id: "dsh-native-read" }) });
    assert.equal(readResponse.status, 200);
    const readDeadline = Date.now() + 15_000;
    while (Date.now() < readDeadline && !running.ledger.list().some((message) => message.to === "service:dsh-tool" && message.word === "read"))
      await new Promise((resolve) => setTimeout(resolve, 30));
    const readCall = running.ledger.list().find((message) => message.to === "service:dsh-tool" && message.word === "read");
    assert.ok(readCall, "native DSH read entered the core ledger");
    while (Date.now() < readDeadline && !running.ledger.responseTo(readCall.id)) await new Promise((resolve) => setTimeout(resolve, 30));
    const readResult = running.ledger.responseTo(readCall.id);
    assert.equal(readResult?.body.ok, true);
    assert.match(JSON.stringify(readResult?.body), /NATIVE_READ_FIXTURE/);
    assert.equal(readResult?.turn, readCall.turn);
    // Tool completion is not turn completion: a probe sent here would race with
    // the followup and be steered into the old turn instead of starting its own.
    const ended = async (turn: string | undefined) => {
      const until = Date.now() + 15_000;
      while (Date.now() < until && !running!.ledger.list().some((m) => m.word === "turn.end" && m.turn === turn))
        await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(running!.ledger.list().some((m) => m.word === "turn.end" && m.turn === turn), "probe turn completed before the next native-tool probe");
    };
    await ended(readCall.turn);
    const soulBefore = readFileSync(join(home, "SOUL.md"), "utf8");
    soulWatcher = watch(join(home, "SOUL.md"), (kind) => soulChanges.push(kind));
    const writeResponse = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "write soul directly" }, client_id: "dsh-native-write-probe" }) });
    assert.equal(writeResponse.status, 200);
    const writeDeadline = Date.now() + 15_000;
    while (Date.now() < writeDeadline && !running.ledger.list().some((message) => message.to === "service:dsh-tool" && message.word === "write"))
      await new Promise((resolve) => setTimeout(resolve, 30));
    const writeCall = running.ledger.list().find((message) => message.to === "service:dsh-tool" && message.word === "write");
    assert.ok(writeCall, "native write attempt entered the core ledger");
    while (Date.now() < writeDeadline && !running.ledger.responseTo(writeCall.id)) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(running.ledger.responseTo(writeCall.id)?.body.ok, false);
    assert.equal(readFileSync(join(home, "SOUL.md"), "utf8"), soulBefore);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(soulChanges, [], "native write caused no managed-file change event");
    await ended(writeCall.turn);
    const privateResponse = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "read core private" }, client_id: "dsh-private-read-probe" }) });
    assert.equal(privateResponse.status, 200);
    const privateDeadline = Date.now() + 15_000;
    let privateCall;
    while (Date.now() < privateDeadline && !privateCall) {
      privateCall = running.ledger.list().find((message) => message.to === "service:dsh-tool" && message.word === "read" &&
        String(message.body.arguments).includes("private-fixture.txt"));
      if (!privateCall) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(privateCall, "private read attempt entered the core ledger");
    while (Date.now() < privateDeadline && !running.ledger.responseTo(privateCall.id)) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(running.ledger.responseTo(privateCall.id)?.body.ok, false);
    assert.equal(readFileSync(join(root, "state", "private-fixture.txt"), "utf8"), "PRIVATE_CORE_SECRET\n");
  } finally {
    soulWatcher?.close();
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL during a real model request leaves a read turn trace and never blindly replays it", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-kill-"));
  mkdirSync(join(root, "home"));
  let requests = 0;
  let firstRequest!: () => void;
  const requested = new Promise<void>((resolve) => { firstRequest = resolve; });
  const model = createServer((req, res) => {
    if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      const request = JSON.parse(raw || "{}") as { tools?: unknown[]; model?: string };
      if (request.tools?.length) { requests++; firstRequest(); return; } // hold the actual turn, not a helper title request
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_title", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "title" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      event("message_stop", {}); res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const childPath = fileURLToPath(new URL("./fixtures/dsh-kill-child.ts", import.meta.url));
  const launch = (phase: string) => fork(childPath, [], { execArgv: ["--expose-internals", "--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, TEST_ROOT: root, TEST_PHASE: phase, TEST_MODEL_URL: `http://127.0.0.1:${port}/anthropic`,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`, DEEPSEEK_API_KEY: "sk-synthetic", ASH_TEST_DSH_ROOT: install! } });
  let child = launch("first");
  let childError = "";
  child.stderr?.on("data", (part) => { childError += String(part).slice(0, 1000); });
  const timeout = async <T>(label: string, promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout: ${childError}`)), 12_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  try {
    const accepted = new Promise<{ type: string; status: number }>((resolve) => child.once("message", (message) => resolve(message as { type: string; status: number })));
    assert.deepEqual(await timeout("accepted", accepted), { type: "accepted", status: 200 });
    await timeout("provider request", requested);
    child.kill("SIGKILL");
    await timeout("first exit", new Promise<void>((resolve) => child.once("exit", () => resolve())));
    child = launch("second");
    child.stderr?.on("data", (part) => { childError += String(part).slice(0, 1000); });
    const recovered = new Promise<{ type: string; turns: string[]; replies: unknown[] }>((resolve) => child.once("message", (message) => resolve(message as { type: string; turns: string[]; replies: unknown[] })));
    const result = await timeout("recovered", recovered);
    assert.equal(result.type, "recovered");
    assert.deepEqual(result.turns, ["error"]);
    assert.deepEqual(result.replies, []);
    await timeout("second exit", new Promise<void>((resolve) => child.once("exit", () => resolve())));
    assert.equal(requests, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
