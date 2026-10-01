import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ledger } from "../../src/world/ledger";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;
const childFile = fileURLToPath(new URL("./fixtures/gate-handoff-child.ts", import.meta.url));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => { resolve = ready; });
  return { promise, resolve };
}

async function bounded<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), 20_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function marker(file: string): Promise<void> {
  const expires = Date.now() + 20_000;
  while (Date.now() < expires) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("commit barrier timeout");
}

for (const stage of ["answered-before-cas", "cas-before-handoff", "handoff-before-effect", "effect-after-fsync", "policy-after-handoff", "acl-after-handoff"] as const) {
  test(`installed DSH ${stage.endsWith("-after-handoff") ? `effect-time ${stage}` : `SIGKILL at ${stage}`} never replays a synthetic committed effect`, { skip }, async () => {
    const root = mkdtempSync(join(tmpdir(), "ash-gate-handoff-"));
    mkdirSync(join(root, "home"));
    const effects = join(root, "effect-count");
    let modelCalls = 0;
    let effectCount = 0;
    const effectEntered = deferred<void>();
    const host = createServer((req, res) => {
      if (req.url === "/manifest") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        name: "Synthetic host", capabilities: [{ name: "hold", description: "Synthetic irreversible counter",
          input_schema: { type: "object", additionalProperties: false }, risk: "none", label: "Synthetic hold" }],
      }));
      if (req.url === "/alarm") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      if (req.url === "/call") {
        effectCount++;
        const fd = openSync(effects, "w", 0o600);
        try { writeSync(fd, String(effectCount)); fsyncSync(fd); } finally { closeSync(fd); }
        effectEntered.resolve();
        // The fake external side effect is committed, but the device ACK is
        // deliberately withheld until the child is killed.
        return;
      }
      res.writeHead(404).end("{}");
    });
    const model = createServer((req, res) => {
      let raw = "";
      req.on("data", (part) => { raw += part; });
      req.on("end", () => {
        if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
        const request = JSON.parse(raw || "{}") as { model?: string };
        modelCalls++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
        event("message_start", { message: { id: `msg_handoff_${modelCalls}`, type: "message", role: "assistant", model: request.model,
          content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        if (modelCalls === 1) {
          event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_handoff_1", name: "ash_send", input: {} } });
          event("content_block_delta", { index: 0, delta: { type: "input_json_delta",
            partial_json: JSON.stringify({ to: "device:phone", word: "hold", body: {} }) } });
        } else {
          event("content_block_start", { index: 0, content_block: { type: "text", text: "synthetic completion" } });
        }
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: modelCalls === 1 ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
        event("message_stop", {}); res.end();
      });
    });
    await Promise.all([new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))]);
    let child: ChildProcess | null = null;
    let stderr = "";
    const launch = (phase: string) => {
      const running = fork(childFile, [], { execArgv: ["--expose-internals", "--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, TEST_ROOT: root, TEST_STAGE: phase, ASH_TEST_DSH_ROOT: install!, TEST_HOST_URL: `http://127.0.0.1:${(host.address() as { port: number }).port}`,
          TEST_MODEL_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/anthropic` } });
      running.stderr?.on("data", (part) => { stderr += String(part).slice(0, 2000); });
      return running;
    };
    const message = (running: ChildProcess, type: string) => bounded(type, new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (value: unknown) => {
        if ((value as { type?: string })?.type === "error") { cleanup(); reject(new Error(String((value as { message?: string }).message))); }
        else if ((value as { type?: string })?.type === type) { cleanup(); resolve(value as Record<string, unknown>); }
      };
      const onExit = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`child exited ${code}/${signal}: ${stderr}`)); };
      const cleanup = () => { running.off("message", onMessage); running.off("exit", onExit); };
      running.on("message", onMessage); running.on("exit", onExit);
    }));
    try {
      child = launch(stage);
      const ready = await message(child, "ask-ready");
      assert.equal(typeof ready.parentId, "string");
      assert.equal(typeof ready.askId, "string");
      const executionBarrier = stage === "handoff-before-effect" ? message(child, "barrier") : null;
      const turnEnded = stage === "policy-after-handoff" || stage === "acl-after-handoff" ? message(child, "turn-ended") : null;
      child.send({ type: "answer" });
      if (stage === "answered-before-cas" || stage === "cas-before-handoff")
        await marker(join(root, "commit-barrier"));
      else if (executionBarrier) await executionBarrier;
      else if (turnEnded) {
        const outcome = await bounded("revocation/execute outcome", Promise.race([turnEnded, effectEntered.promise]));
        if (outcome) {
          assert.equal(outcome.parentResponseCount, 1);
          assert.equal(outcome.askResponseCount, 1);
        }
      }
      else await bounded("synthetic effect", effectEntered.promise);
      assert.equal(effectCount, stage === "effect-after-fsync" ? 1 : 0,
        "a policy change after allowed-once but before tool execution reached the synthetic effect");
      if (stage === "policy-after-handoff" || stage === "acl-after-handoff") return; // effect-time oracle, not crash replay
      child.kill("SIGKILL");
      await bounded("killed child", new Promise<void>((resolve) => child!.once("exit", () => resolve())));
      const callsAtKill = modelCalls;
      child = launch("recover");
      const recovered = await message(child, "recovered");
      assert.equal(recovered.parentCount, 1);
      assert.equal(recovered.parentResponseCount, 1);
      assert.equal(recovered.parentOutcome, stage === "answered-before-cas" || stage === "cas-before-handoff" ? null : "allowed-once");
      await bounded("recovered child exit", child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
        new Promise<void>((resolve) => child!.once("exit", () => resolve())));
      assert.equal(effectCount, stage === "effect-after-fsync" ? 1 : 0);
      assert.equal(existsSync(effects) ? Number(readFileSync(effects, "utf8")) : 0, effectCount);
      assert.equal(modelCalls, callsAtKill, "restart resumed the old synthetic model/tool call");
      const ledger = await Ledger.open(join(root, "state", "ash.db"));
      try {
        const parent = ledger.list().find((item) => item.kind === "request" && item.word === "internal.approval")!;
        assert.equal(ledger.list().filter((item) => item.kind === "response" && item.reply_to === parent.id).length, 1);
        const gate = ledger.gateCase(parent.id)!;
        assert.equal(ledger.list().filter((item) => item.kind === "response" && item.reply_to === gate.askId).length, 1);
      } finally { ledger.close(); }
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      host.closeAllConnections(); model.closeAllConnections();
      await Promise.all([new Promise<void>((resolve) => host.close(() => resolve())), new Promise<void>((resolve) => model.close(() => resolve()))]);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
