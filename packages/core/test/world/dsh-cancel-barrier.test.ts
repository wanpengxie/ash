import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { DshHost } from "../../../dsh-binding/src/host";
import { startOwner } from "../../src/main";
import type { TrustedRouteContext } from "../../src/world/router";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (check()) return; await sleep(20); }
  throw new Error(`${label} was not reached`);
}
const caller = (member: string, transport: TrustedRouteContext["transport"]): TrustedRouteContext =>
  ({ transport, transportPrincipal: member, member, local: true, remote: false, ownerProxy: false });

test("real session becomes idle after cancelling a tool while its external device remains busy", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-cancel-barrier-"));
  const home = join(root, "home"); mkdirSync(home);
  const deviceEntered = deferred();
  const deviceRelease = deferred();
  const modelRequests: string[] = [];
  let deviceSettled = false;
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { messages?: unknown[]; tools?: unknown[]; model?: string };
      const hasTools = Boolean(request.tools?.length);
      const source = JSON.stringify(request.messages ?? []);
      if (hasTools) modelRequests.push(source);
      const first = hasTools && modelRequests.length === 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_barrier_${modelRequests.length}`, type: "message", role: "assistant", model: request.model,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (first) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_barrier_1", name: "ash_send", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ to: "device:probe", word: "hold", body: {} }) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "new batch answer" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {}); res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install!, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      } } });
    running.members.registerDevice({ id: "device:probe", kind: "device", name: "Synthetic probe", online: true,
      capabilities: () => [{ name: "hold", description: "Wait for a synthetic device result",
        input_schema: { type: "object" as const, additionalProperties: false }, result_schema: { type: "object" as const,
          properties: { done: { type: "boolean" as const } }, required: ["done"], additionalProperties: false }, risk: "none" as const, label: "Waiting" }],
      handle: async () => { deviceEntered.resolve(); await deviceRelease.promise; deviceSettled = true; return { ok: true, result: { done: true } }; } });
    const owner = caller("person:owner", "api");
    const reflex = caller("service:reflex", "service");
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "start hold" }, wait: true });
    await deviceEntered.promise;
    const hold = running.ledger.list().find((message) => message.from === "agent:main" && message.word === "hold" && message.kind === "request");
    assert.ok(hold?.turn);
    const modelCallsBeforeCancel = modelRequests.length;
    const started = performance.now();
    const cancelled = await running.world.send(reflex, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "stop synthetic hold" }, wait: true });
    await until(() => running!.ledger.list().some((message) => message.word === "turn.end" && message.body.reason === "cancelled"), "cancelled turn");
    assert.ok(performance.now() - started < 1_000, "cancellation waited on the external device");
    assert.deepEqual(cancelled.reply?.body.result, { cancelled: true });
    assert.equal(deviceSettled, false, "the external effect has not reached a terminal outcome");
    assert.equal((running.ledger.responseTo(hold.id)?.body.error as { code?: string })?.code, "cancelled");
    await sleep(100);
    assert.equal(modelRequests.length, modelCallsBeforeCancel, "the cancelled DSH turn continued into another model request");
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "next batch" }, wait: true });
    await until(() => running!.ledger.list().some((message) => message.from === "agent:main" && message.word === "say" && message.body.text === "new batch answer"), "next batch");
    assert.equal(deviceSettled, false, "the new DSH turn follows session idle, not the external device promise");
    assert.equal(running.ledger.list().filter((message) => message.from === "agent:main" && message.word === "hold" && message.kind === "request").length, 1);
    const nextModelRequest = modelRequests.find((request) => request.includes("next batch"));
    assert.ok(nextModelRequest);
    assert.match(nextModelRequest, /stop synthetic hold/, "the next actual model input omitted the stop reason");
    assert.match(nextModelRequest, /device:probe\/hold/, "the next actual model input omitted the stopped action");
    await until(() => running!.ledger.list().some((message) => message.word === "turn.end" && message.body.reason === "completed"), "second completed turn");
    const modelCallsBeforeIdleCancel = modelRequests.length;
    const idle = await running.world.send(reflex, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "idle retry" }, wait: true });
    assert.deepEqual(idle.reply?.body.result, { cancelled: false });
    assert.equal(modelRequests.length, modelCallsBeforeIdleCancel, "idle cancellation drove the DSH session");
    assert.equal(deviceSettled, false, "idle cancellation must not be inferred from the external effect");
    deviceRelease.resolve(); await sleep(40);
    assert.equal(running.ledger.list().filter((message) => message.word === "hold" && message.kind === "response" && message.reply_to === hold.id).length, 1,
      "late device success cannot replace or duplicate the cancelled terminal");
    assert.equal(running.ledger.list().filter((message) => message.word === "turn.end" && message.body.reason === "cancelled").length, 1);
    assert.equal(running.ledger.list().filter((message) => message.from === "agent:main" && message.word === "say" && message.turn === hold.turn).length, 0);
    assert.ok(modelRequests.some((request) => request.includes("next batch")));
  } finally {
    deviceRelease.resolve();
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the root session resumes its prior model history after a clean restart", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-history-"));
  const home = join(root, "home"); mkdirSync(home);
  const stateDir = join(root, "state");
  const requests: string[] = [];
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { messages?: unknown[]; tools?: unknown[]; model?: string };
      const history = JSON.stringify(request.messages ?? []);
      const current = history.includes("second history input") ? "second" : history.includes("first history input") ? "first" : "auxiliary";
      if (current !== "auxiliary" && request.tools?.length) requests.push(history);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_history_${requests.length}`, type: "message", role: "assistant", model: request.model,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: current === "first" ? "first remembered answer" : current === "second" ? "second remembered answer" : "title" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {}); res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const config = { stateDir, workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "dsh" as const }],
    dsh: { root: install!, home: join(root, "dsh"), env: { DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic` } } };
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner(config);
    const oldOwnerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    await running.world.send(caller("person:owner", "api"), { to: "agent:main", kind: "request", word: "say", body: { text: "first history input" }, wait: true });
    await until(() => running!.ledger.list().some((message) => message.from === "agent:main" && message.body.text === "first remembered answer"),
      `first answer (model calls=${requests.length}; rows=${JSON.stringify(running.ledger.list().map((message) => [message.from, message.word, message.body.reason, message.body.error, message.body.text]))})`);
    await running.close(); running = null;
    const journal = JSON.parse(readFileSync(join(stateDir, "dsh-main-session.json"), "utf8")) as { id: string };
    assert.match(journal.id, /^session-/);
    const tokenFile = join(stateDir, "tokens.json");
    const tokens = JSON.parse(readFileSync(tokenFile, "utf8")) as { api: Record<string, string> };
    delete tokens.api[oldOwnerToken];
    writeFileSync(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
    running = await startOwner(config);
    const sendAtEdge = (token: string, text: string) => fetch(`${running!.url}/api/send`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({
        to: "agent:main", kind: "request", word: "say", body: { text }, client_id: `history-${text.replaceAll(" ", "-")}`,
      }) });
    assert.equal((await sendAtEdge(oldOwnerToken, "revoked input")).status, 401);
    const newOwnerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    assert.notEqual(newOwnerToken, oldOwnerToken);
    assert.equal((await sendAtEdge(newOwnerToken, "second history input")).status, 200);
    await until(() => running!.ledger.list().some((message) => message.from === "agent:main" && message.body.text === "second remembered answer"), "second answer");
    await until(() => running!.ledger.list().filter((message) => message.from === "agent:main" && message.word === "turn.end" && message.body.reason === "completed").length === 2,
      "two completed core turns");
    const secondTurn = running.ledger.list().filter((message) => message.from === "agent:main" && message.word === "turn.end" && message.body.reason === "completed").at(-1)!.body.turn as string;
    assert.ok(requests.length >= 2);
    const resumedRequest = requests.find((request) => request.includes("second history input"));
    assert.ok(resumedRequest);
    assert.match(resumedRequest, /first history input/);
    assert.match(resumedRequest, /first remembered answer/);
    assert.match(resumedRequest, /second history input/);
    assert.equal((JSON.parse(readFileSync(join(stateDir, "dsh-main-session.json"), "utf8")) as { id: string }).id, journal.id);
    await running.close(); running = null;
    const journalFile = join(stateDir, "dsh-main-session.json");
    const refusal = (expected: RegExp) => {
      const child = spawnSync(process.execPath, ["--expose-internals", "--import", "tsx", fileURLToPath(new URL("./fixtures/dsh-resume-refusal-child.ts", import.meta.url))], {
        cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
        env: { ...process.env, TEST_ROOT: root, ASH_TEST_DSH_ROOT: install!, TEST_MODEL_URL: `http://127.0.0.1:${port}/anthropic` },
      });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stdout, expected);
    };
    // A valid physical tail with queued DSH input must not self-drive at resume.
    const storageHost = new DshHost(config.dsh);
    await storageHost.boot();
    try {
      const persistence = storageHost.ctx.get("sessionPersistence");
      const writer = await persistence.open(journal.id, "write");
      try {
        const events = (await writer.read()).events as { seq: number }[];
        await writer.append([{ type: "agent/inbox/spliced", seq: events.length, time: Date.now(),
          data: { target: "next-turn", start: 0, inserted: [{ id: "untrusted-replay", role: "user", content: [{ type: "text", text: "do not replay" }], source: { kind: "user" } }] } }]);
        await writer.flush();
      } finally { await writer.close(); }
    } finally { await storageHost.close(); }
    refusal(/queued work that cannot be automatically resumed/);
    // Keep the physical header frame but delete the event tail. A completed
    // core turn is not evidence that DSH still has the corresponding prompt.
    const findSessionFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? findSessionFiles(path) : entry.isFile() && /session(?:\.v\d+)?\.jsonl\.zstd$/.test(entry.name) ? [path] : [];
    });
    const files = findSessionFiles(config.dsh.home).filter((path) => path.includes(journal.id));
    assert.equal(files.length, 1, "synthetic root must have one canonical session artifact");
    const file = files[0];
    const original = readFileSync(file);
    const frameMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const frameEnds: number[] = [];
    for (let index = 1; index + 4 < original.length; index++) if (original.subarray(index, index + 4).equals(frameMagic)) frameEnds.push(index);
    frameEnds.push(original.length);
    let headerLength = 0;
    let promptOnlyLength = 0;
    let decoded = "";
    let frameStart = 0;
    for (const size of frameEnds) {
      try {
        decoded += zstdDecompressSync(original.subarray(frameStart, size)).toString("utf8");
        frameStart = size;
        if (!decoded.endsWith("\n")) continue;
        const rows = decoded.trim().split("\n").map((line) => JSON.parse(line) as { type?: string; data?: { id?: string; turn?: number } });
        if (!headerLength && rows.length === 1) headerLength = size;
        let active: number | null = null;
        let promptTurn: number | null = null;
        let promptEnded = false;
        for (const row of rows) {
          if (row.type === "turn/start") active = row.data?.turn ?? null;
          if (row.type === "user/message" && row.data?.id === `core-${secondTurn}`) promptTurn = active;
          if (row.type === "turn/end") { if (promptTurn === row.data?.turn) promptEnded = true; active = null; }
        }
        if (!promptOnlyLength && promptTurn !== null && !promptEnded) promptOnlyLength = size;
      } catch { /* incomplete frame */ }
    }
    assert.ok(headerLength > 0 && headerLength < original.length, "failed to locate the persisted header frame");
    assert.ok(promptOnlyLength > headerLength && promptOnlyLength < original.length, "no complete persisted frame ends after the second prompt and before its turn end");
    writeFileSync(file, original.subarray(0, promptOnlyLength));
    refusal(/completed core turn lacks a matching completed DSH turn/);
    writeFileSync(file, original.subarray(0, headerLength));
    refusal(/history missing for existing core turns|completed core turn is missing from DSH history/);
    writeFileSync(file, Buffer.concat([original.subarray(0, headerLength), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]));
    refusal(/history|session|frame|storage|format|corrupt|truncated/i);
    unlinkSync(file);
    refusal(/history missing for existing core turns/);
    writeFileSync(journalFile, "{broken", { mode: 0o600 });
    refusal(/invalid DSH session journal/);
    unlinkSync(journalFile);
    refusal(/journal missing for existing core turns/);
    writeFileSync(journalFile, JSON.stringify({ version: 1, id: `session-${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}` }), { mode: 0o600 });
    refusal(/history missing for existing core turns/);
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL in a real tool call closes uncertain history without replaying the external request", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-tool-kill-"));
  mkdirSync(join(root, "home"));
  let deviceCalls = 0;
  let modelCalls = 0;
  const deviceEntered = deferred();
  const host = createServer((req, res) => {
    if (req.url === "/manifest") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      name: "Synthetic host", capabilities: [{ name: "hold", description: "Wait for a synthetic device result",
        input_schema: { type: "object", additionalProperties: false }, risk: "none", label: "Waiting" }],
    }));
    if (req.url === "/alarm") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.url === "/call") { deviceCalls++; deviceEntered.resolve(); return; }
    res.writeHead(404).end("{}");
  });
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: unknown[]; model?: string };
      const useTool = Boolean(request.tools?.length);
      if (useTool) modelCalls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_toolkill_${modelCalls}`, type: "message", role: "assistant", model: request.model,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (useTool) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_toolkill_1", name: "ash_send", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ to: "device:phone", word: "hold", body: {} }) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "title" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: useTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {}); res.end();
    });
  });
  await Promise.all([new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))]);
  const childFile = fileURLToPath(new URL("./fixtures/dsh-tool-kill-child.ts", import.meta.url));
  const launch = (phase: string) => fork(childFile, [], { execArgv: ["--expose-internals", "--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, TEST_ROOT: root, TEST_PHASE: phase, ASH_TEST_DSH_ROOT: install!,
      TEST_HOST_URL: `http://127.0.0.1:${(host.address() as { port: number }).port}`,
      TEST_MODEL_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/anthropic` } });
  let child = launch("first");
  let childError = "";
  child.stderr?.on("data", (part) => { childError += String(part).slice(0, 1000); });
  const timeout = async <T>(label: string, promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout: ${childError}`)), 15_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  try {
    const accepted = new Promise<{ type: string; status: number }>((resolve) => child.once("message", (value) => resolve(value as { type: string; status: number })));
    assert.deepEqual(await timeout("accepted", accepted), { type: "accepted", status: 200 });
    await timeout("device entry", deviceEntered.promise);
    assert.equal(deviceCalls, 1);
    child.kill("SIGKILL");
    await timeout("first exit", new Promise<void>((resolve) => child.once("exit", () => resolve())));
    child = launch("second");
    child.stderr?.on("data", (part) => { childError += String(part).slice(0, 1000); });
    const recovered = new Promise<{ type: string; holdCount: number; replyCount: number; replyCode: string; turnReasons: string[]; dshUnknownToolResults: number }>((resolve) =>
      child.once("message", (value) => resolve(value as { type: string; holdCount: number; replyCount: number; replyCode: string; turnReasons: string[]; dshUnknownToolResults: number })));
    const result = await timeout("recovery", recovered);
    assert.equal(result.type, "recovered");
    assert.equal(result.holdCount, 1);
    assert.equal(result.replyCount, 1);
    assert.equal(result.replyCode, "failed"); // outcome unknown, not a fabricated success
    assert.deepEqual(result.turnReasons, ["error"]);
    assert.ok(result.dshUnknownToolResults >= 1, "DSH history did not close the interrupted call as unknown");
    await timeout("second exit", new Promise<void>((resolve) => child.once("exit", () => resolve())));
    assert.equal(deviceCalls, 1, "the external device call was replayed");
    assert.equal(modelCalls, 1, "DSH resumed an old prompt rather than waiting for a new core batch");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    host.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => host.close(() => resolve())), new Promise<void>((resolve) => model.close(() => resolve()))]);
    rmSync(root, { recursive: true, force: true });
  }
});
