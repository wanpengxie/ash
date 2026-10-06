// Word contracts (C3) against the production assembly: every declared word is exposed with
// exactly its declared schema, its authorized sender gets schema rejections before any effect,
// unauthorized senders are refused, read words answer with results that match their result
// schema, and every message a real scenario writes to the ledger matches its contract.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "../../../sdk/src/api";
import { matchesSchema } from "../../../sdk/src/schema";
import { WORD_CONTRACTS, wordContract, type WordContract } from "../../../sdk/src/words";
import { startOwner } from "../../src/main";
import { RouterError, type TrustedRouteContext } from "../../src/world/router";
import { FakeHost } from "../fixtures/fake-host";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

/** A model that always answers with a short text, so turns end without tools. */
async function quietModel(): Promise<{ url: string; server: Server }> {
  let serial = 0;
  const server = createServer(async (req, res) => {
    if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
    let raw = ""; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw) as { model?: string; stream?: boolean };
    const message = { id: `msg_c_${++serial}`, type: "message", role: "assistant", model: input.model,
      content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    if (!input.stream) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { ...message, content: [], stop_reason: null } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好" } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    ev("message_stop", {}); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/anthropic`, server };
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), "ash-contract-"));
  const home = join(root, "home"); mkdirSync(home);
  const model = await quietModel();
  const host = new FakeHost();
  host.manifest = { name: "Contract phone", capabilities: [
    { name: "note.read", description: "Read a note on the phone.", input_schema: { type: "object", properties: {}, additionalProperties: false }, risk: "none", label: "在看便签" },
    { name: "sms.send", description: "Send a text message from the phone.", input_schema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"], additionalProperties: false }, risk: "outward", label: "在发短信" },
  ] };
  await host.start();
  const running = await startOwner({ stateDir: join(root, "state"), listen: "127.0.0.1:0", workspaces: { home },
    agents: [{ id: "agent:main", runtime: "dsh" }], host: { url: host.url, token: host.token },
    dsh: { root: install!, home: join(root, "dsh"), costRoot: join(process.cwd(), "packages/ash-cost"), env: { DSH_TELEMETRY_DISABLED: "1", DSH_PERMISSION_MODE: "danger-full-access",
      DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: model.url } } });
  const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
  const owner: TrustedRouteContext = { member: "person:owner", transport: "api", local: true, remote: false, ownerProxy: true,
    transportPrincipal: `token:${createHash("sha256").update(ownerToken).digest("hex")}` };
  const service = (member: string): TrustedRouteContext => ({ member, transport: "service", transportPrincipal: member, local: true, remote: false, ownerProxy: false });
  const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
  const phone: TrustedRouteContext = { member: "device:phone", transport: "phone", transportPrincipal: "host:phone", local: true, remote: false, ownerProxy: true };
  const registration = running.edge.screens.register({ member: "person:owner", transport: "web_ui", transportPrincipal: owner.transportPrincipal,
    local: true, remote: false, ownerProxy: true }, "contract", "Contract screen");
  const screen: TrustedRouteContext = { member: "person:owner", transport: "web_ui", transportPrincipal: owner.transportPrincipal,
    local: true, remote: false, ownerProxy: true, screenId: registration.screen, screenLabel: registration.label } as TrustedRouteContext;
  return { root, model, host, running, owner, service, agent, phone, screen, registration,
    async close() { await running.close(); await host.close(); model.server.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** A body that violates the word's input schema (missing required field, wrong type, or unknown field). */
function violating(contract: WordContract): Record<string, unknown> | null {
  for (const body of [{ __contract_probe: true }, { text: 42 }, { path: 42 }, { reason: 42 }, {}]) {
    if (!matchesSchema(contract.input_schema!, body)) return body;
  }
  return null;
}
/** Words whose body is deliberately open at the routing layer; their member validates the fields it knows. */
const OPEN_BODIES = new Set(["service:admin/settings.set"]);

const contractOf = (message: Message): WordContract | undefined => message.kind === "event"
  ? wordContract(message.from, message.word) ?? (message.to ? wordContract(message.to, message.word) : undefined)
    ?? (message.from.startsWith("screen:") && message.to ? wordContract(message.to, message.word) : undefined)
    ?? (message.word.startsWith("sense.") ? wordContract("service:senses", message.word) : undefined)
  : message.to?.startsWith("screen:") ? wordContract("screen:*", message.word) : message.to ? wordContract(message.to, message.word) : undefined;

async function expectCode(promise: Promise<unknown>, code: string, label: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RouterError, `${label}: expected RouterError, got ${String(error)}`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    return true;
  }, label);
}

test("every declared word is exposed by the production members with exactly its declared contract", { skip }, async () => {
  const w = await world();
  try {
    const missing: string[] = [];
    // describe lists the words a member receives; outbound events are checked against real ledger rows below.
    for (const contract of WORD_CONTRACTS.filter((item) => item.direction === "in")) {
      if (contract.member === "screen:*") continue; // covered by the screen test below
      if (contract.member === "service:senses") continue; // phone senses are broadcast events (to: null), not addressed words
      const audiences = contract.audience === "agent" ? ["agent"] as const : contract.audience === "owner" ? ["owner"] as const : ["owner", "agent"] as const;
      for (const audience of audiences) {
        let words: { word: string }[] = [];
        try { words = (w.running.members.describe(audience, contract.member).members[0]?.words ?? []) as { word: string }[]; } catch { /* member absent */ }
        const exposed = words.find((item) => item.word === contract.word) as Record<string, unknown> | undefined;
        if (!exposed) { missing.push(`${audience}:${contract.member}/${contract.word}`); continue; }
        for (const field of ["kind", "input_schema", "result_schema", "risk"] as const) {
          assert.deepEqual(exposed[field] ?? null, (contract as unknown as Record<string, unknown>)[field] ?? null, `${contract.member}/${contract.word} ${field}`);
        }
      }
    }
    assert.deepEqual(missing, [], "words declared in the contract but not exposed by describe");
    const screenWords = w.running.members.describe("agent", w.registration.screen).members[0].words as unknown as WordContract[];
    assert.deepEqual(screenWords.map((item) => item.word), ["ui.open"]);
    assert.deepEqual(screenWords[0].input_schema, wordContract("screen:*", "ui.open")!.input_schema);
  } finally { await w.close(); }
});

test("each inbound word rejects a schema-violating body from its authorized sender before any effect, and refuses other senders", { skip }, async () => {
  const w = await world();
  try {
    const world_ = w.running.world;
    const ledger = w.running.ledger;
    const senders: Record<string, TrustedRouteContext> = {
      "agent:main/say": w.owner, "agent:main/cancel_turn": w.service("service:reflex"), "agent:main/wake": w.service("service:clock"),
      "agent:main/typing": w.screen,
      "person:owner/say": w.agent, "person:owner/react": w.agent, "person:owner/show": w.agent, "person:owner/ask": w.agent,
      "screen:*/ui.open": w.agent,
      "service:clock/set": w.owner, "service:clock/cancel": w.owner, "service:clock/list": w.owner,
      "service:post/deliver": w.service("service:work"), "service:post/visible": w.screen, "service:post/hidden": w.screen,
      "service:self/read": w.owner, "service:self/write": w.owner, "service:self/append": w.owner, "service:self/apply_plan": w.owner,
      "service:self/rollback": w.owner, "service:self/history": w.owner,
      "service:work/run": w.owner, "service:work/runs": w.owner,
      "service:cost/usage.get": w.owner, "service:cost/balance.get": w.owner,
      "service:vault/list": w.owner, "service:vault/describe": w.owner,
    };
    for (const word of ["rules.list", "rules.revoke", "rules.set", "mode.set", "history", "audit", "access.list", "access.grant", "access.revoke"]) senders[`service:gate/${word}`] = w.owner;
    for (const word of ["settings.get", "settings.set", "plugins.list", "plugins.op", "gateway.state", "gateway.op", "model.set", "pause"]) senders[`service:admin/${word}`] = w.owner;
    senders["service:admin/resume"] = w.screen;
    for (const word of ["list", "describe", "declare", "update", "start", "stop", "restart", "remove"]) senders[`service:agents/${word}`] = w.owner;
    for (const word of ["ask", "tell", "answer"]) senders[`service:agents/${word}`] = w.agent;
    for (const word of ["extract", "verify_claims", "reconcile", "verify_plan", "proactive", "opener"]) senders[`worker:${word}/${word}`] = w.service("service:work");
    for (const word of ["sense.calendar", "sense.battery", "sense.screen", "sense.notification", "sense.location", "sense.activity", "sense.health", "sense.geofence"]) senders[`service:senses/${word}`] = w.phone;
    const internalOnly = new Set(["agent:main/cancel_turn", "agent:main/wake", "service:post/deliver",
      "service:reflex/before_turn", "service:reflex/surface.get", "service:reflex/screen.get", "service:reflex/screen.return", "service:reflex/virtual.close",
      "worker:extract/extract", "worker:verify_claims/verify_claims", "worker:reconcile/reconcile", "worker:verify_plan/verify_plan",
      "worker:proactive/proactive", "worker:opener/opener"]);
    const unchecked: string[] = [];
    senders["service:reflex/task.stop"] = w.owner;
    senders["service:reflex/task.end"] = w.owner;
    senders["service:reflex/before_turn"] = w.service("service:reflex");
    for (const word of ["surface.get", "screen.get", "screen.return", "virtual.close"]) senders[`service:reflex/${word}`] = w.service("service:reflex");
    for (const contract of WORD_CONTRACTS.filter((item) => item.direction === "in")) {
      const key = `${contract.member}/${contract.word}`;
      const to = contract.member === "screen:*" ? w.registration.screen : contract.member.startsWith("service:senses") ? null : contract.member;
      const kind = contract.kind;
      const bad = violating(contract);
      if (!bad) { assert.ok(OPEN_BODIES.has(key), `${key} accepts any body but is not listed as open`); continue; }
      if (internalOnly.has(key)) {
        await expectCode(world_.send(w.owner, { to, kind, word: contract.word, body: bad }), "forbidden", `${key} from owner`);
      }
      const ctx = senders[key];
      if (!ctx) { if (!internalOnly.has(key)) unchecked.push(key); continue; }
      const before = ledger.list({ limit: 100000 }).length;
      await expectCode(world_.send(ctx, { to, kind, word: contract.word, body: bad }), "bad_request", key);
      assert.equal(ledger.list({ limit: 100000 }).length, before, `${key}: a rejected body must not reach the ledger`);
    }
    assert.deepEqual(unchecked, []);
  } finally { await w.close(); }
});

test("read words answer the owner with results that match their result schema", { skip }, async () => {
  const w = await world();
  try {
    const reads: [string, string, Record<string, unknown>][] = [
      ["service:clock", "list", {}], ["service:gate", "rules.list", {}], ["service:gate", "history", {}], ["service:gate", "access.list", {}],
      ["service:work", "runs", {}], ["service:self", "history", { path: "SOUL.md" }],
      ["service:admin", "settings.get", {}], ["service:admin", "plugins.list", {}], ["service:admin", "gateway.state", {}],
    ];
    for (const [to, word, body] of reads) {
      const sent = await w.running.world.send(w.owner, { to, kind: "request", word, body, wait: true });
      const reply = sent.reply!;
      assert.ok(reply, `${to}/${word} replied`);
      assert.equal(reply.body.ok, true, `${to}/${word}: ${JSON.stringify(reply.body.error)}`);
      const schema = wordContract(to, word)!.result_schema;
      if (schema) assert.ok(matchesSchema(schema, reply.body.result), `${to}/${word} result matches its schema: ${JSON.stringify(reply.body.result).slice(0, 300)}`);
    }
  } finally { await w.close(); }
});

test("a real scenario writes only contract-conforming messages and covers every outbound event", { skip }, async () => {
  const w = await world();
  const world_ = w.running.world;
  const ledger = w.running.ledger;
  const waitFor = async (predicate: (rows: Message[]) => boolean, label: string, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (predicate(ledger.list({ limit: 100000 }))) return; await new Promise((r) => setTimeout(r, 50)); }
    assert.fail(`timed out waiting for ${label}`);
  };
  try {
    // A conversation turn: received/read/turn.start/status/turn.end and a delivered reply.
    const said = await world_.send(w.owner, { to: "agent:main", kind: "request", word: "say", body: { text: "你好" }, wait: true });
    await waitFor((rows) => rows.some((row) => row.word === "turn.end" && rows.find((x) => x.word === "turn.start" && (x.body.ids as string[])?.includes(said.id))), "turn end");
    // A credential saved and removed through the owner route: the ledger gets the names, never a value.
    const ownerToken = Object.entries(w.running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const vaultHeaders = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
    await fetch(`${w.running.url}/api/vault/CONTRACT_PROBE_KEY`, { method: "PUT", headers: vaultHeaders, body: JSON.stringify({ value: "sk-contract-probe" }) });
    await fetch(`${w.running.url}/api/vault/CONTRACT_PROBE_KEY`, { method: "DELETE", headers: vaultHeaders });
    assert.doesNotMatch(JSON.stringify(ledger.list({ limit: 100000 })), /sk-contract-probe/);
    // Presence and visibility from a registered screen.
    await world_.send(w.screen, { to: "agent:main", kind: "event", word: "typing", body: {} });
    await world_.send(w.screen, { to: "service:post", kind: "event", word: "visible", body: {} });
    await world_.send(w.screen, { to: "service:post", kind: "event", word: "hidden", body: {} });
    // Managed file change.
    const read = await world_.send(w.owner, { to: "service:self", kind: "request", word: "read", body: { path: "HEARTBEAT.md" }, wait: true });
    const expected = (read.reply!.body.result as { hash?: string } | undefined)?.hash ?? null;
    const wrote = await world_.send(w.owner, { to: "service:self", kind: "request", word: "write",
      body: { path: "HEARTBEAT.md", content: "# Heartbeat\n", why: "contract", expected_hash: expected }, wait: true });
    assert.equal(wrote.reply!.body.ok, true, JSON.stringify(wrote.reply!.body.error));
    // A timer that fires.
    const set = await world_.send(w.owner, { to: "service:clock", kind: "request", word: "set",
      body: { at: Date.now() + 300, to: "agent:main", word: "wake", body: { reason: "contract", context: {} }, label: "contract" }, wait: true });
    assert.equal(set.reply!.body.ok, true, JSON.stringify(set.reply!.body.error));
    await waitFor((rows) => rows.some((row) => row.word === "clock.fired"), "clock fired");
    // A background run.
    const run = await world_.send(w.owner, { to: "service:work", kind: "request", word: "run", body: { flow: "heartbeat" }, wait: true });
    assert.equal(run.reply!.body.ok, true, JSON.stringify(run.reply!.body.error));
    await waitFor((rows) => rows.some((row) => row.word === "run.end"), "run end");
    // A phone sense.
    await world_.send(w.phone, { to: null, kind: "event", word: "sense.battery", body: { level: 80 } });
    // A risky phone action denied, then allowed once (after the owner lends the capability to her).
    const granted = await world_.send(w.owner, { to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: "device:phone/sms.send" }, wait: true });
    assert.equal(granted.reply!.body.ok, true, JSON.stringify(granted.reply!.body.error));
    for (const choice of ["deny", "once"]) {
      const pending = world_.send(w.agent, { to: "device:phone", kind: "request", word: "sms.send", body: { to: "10086", text: "hi" }, wait: true });
      let ask: Message | undefined;
      await waitFor((rows) => Boolean(ask = rows.filter((row) => row.word === "ask" && row.kind === "request" && row.from === "service:gate").at(-1)) &&
        !rows.some((row) => row.kind === "response" && row.reply_to === ask!.id), `${choice} ask`);
      w.host.queueCall("sms.send", { ok: true, content: [{ type: "text", text: "sent" }] });
      await world_.send(w.screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ask!.id, body: { ok: true, result: { choice } } });
      await pending.catch(() => undefined);
    }
    await waitFor((rows) => rows.some((row) => row.word === "gate.denied") && rows.some((row) => row.word === "gate.passed"), "gate outcomes");
    const question = world_.createHumanQuestion({ ...w.agent, turn: "t_human_contract" }, { type: "confirmation", title: "继续吗？", detail: "确认后再判断是否继续",
      purpose: "验证异步问答", ttlMinutes: 10, options: [{ id: "once", label: "继续" }, { id: "deny", label: "不继续" }] });
    world_.withdrawHuman("agent:main", question.pending_id, "契约测试结束");
    // Held proactive delivery (post.changed) and a reflex judgement come last: pause would stop the world.
    await world_.send(w.owner, { to: "service:admin", kind: "request", word: "settings.set",
      body: { delivery: { quiet: "00:00-23:59" } }, wait: true }).catch(() => undefined);
    await world_.send(w.agent, { to: "person:owner", kind: "request", word: "say", body: { text: "提醒一下", kind: "heads_up" }, wait: true });
    await waitFor((rows) => rows.some((row) => row.word === "post.changed"), "post changed", 5000).catch(() => undefined);
    await world_.send(w.owner, { to: "agent:main", kind: "request", word: "say", body: { text: "暂停" }, wait: true });
    await waitFor((rows) => rows.some((row) => row.word === "reflex.judged"), "reflex judged");

    const rows = ledger.list({ limit: 100000 });
    const violations: string[] = [];
    for (const row of rows) {
      if (row.kind === "response") {
        const request = rows.find((item) => item.id === row.reply_to);
        const contract = request ? contractOf(request) : undefined;
        if (contract?.result_schema && row.body.ok === true && !matchesSchema(contract.result_schema, row.body.result)) violations.push(`${row.seq} ${request!.to}/${request!.word} result`);
        continue;
      }
      const contract = contractOf(row);
      if (!contract) continue; // device capabilities carry their own manifest schemas
      if (!matchesSchema(contract.input_schema!, row.body)) violations.push(`${row.seq} ${contract.member}/${row.word}: ${JSON.stringify(row.body).slice(0, 200)}`);
    }
    assert.deepEqual(violations, [], "ledger rows that do not match their word contract");
    const seen = new Set(rows.filter((row) => row.kind === "event").map((row) => `${contractOf(row)?.member}/${row.word}`));
    const outbound = WORD_CONTRACTS.filter((item) => item.direction === "out").map((item) => `${item.member}/${item.word}`);
    assert.deepEqual(outbound.filter((key) => !seen.has(key)), [], "outbound events never produced by the scenario");
  } finally { await w.close(); }
});
