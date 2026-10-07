import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { startOwner } from "../../core/src/main";
import { ContainerHost } from "../src/host";
import { VaultStore } from "../../core/src/members/vault";
import type { Message } from "../../sdk/src/api";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "lib", "bin.js")) ? "ASH_TEST_DSH_ROOT is not a DSH install" : false;
const plugin = fileURLToPath(new URL("../../dsh-ash-control/index.mjs", import.meta.url));
const VAULT_KEY = "sk-vault-only-test-value-0123456789";

test("deleting an agent forgets its persisted DSH session while restart keeps it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-session-cleanup-"));
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "container-sessions.json"), JSON.stringify({ main: "s-main", "agent:helper": "s-old" }));
  const host = new ContainerHost({ stateDir: state, launch: () => { throw new Error("must not boot"); } });
  await host.closeSession("main");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "container-sessions.json"), "utf8")), { main: "s-main", "agent:helper": "s-old" });
  await host.closeSession("agent:helper", true);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "container-sessions.json"), "utf8")), { main: "s-main" });
  await host.close();
});

type Seen = { headers: IncomingHttpHeaders; tools: string[]; user: string; toolResult: boolean; mind: boolean; raw: string };

/** An Anthropic-style model that scripts each step from what it is asked. */
function fakeModel(script: (request: Seen, index: number) => { tool?: { name: string; input: object }; text?: string }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: { name: string }[]; messages?: { role: string; content: unknown }[]; model?: string };
      const last = request.messages?.at(-1);
      const user = (request.messages ?? []).filter((message) => message.role === "user").flatMap((message) => typeof message.content === "string" ? [message.content] :
        Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "") : []).join("\n");
      const entry: Seen = { headers: req.headers, tools: (request.tools ?? []).map((tool) => tool.name), user,
        toolResult: Array.isArray(last?.content) && last.content.some((part: { type?: string }) => part.type === "tool_result"),
        mind: user.includes("This is your private mind space"), raw };
      seen.push(entry);
      const step = entry.mind ? { text: "ok" } : script(entry, seen.filter((item) => !item.mind).length);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_${seen.length}`, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20 } } });
      if (step.tool) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${seen.length}`, name: step.tool.name, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: step.text ?? "done" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: step.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 7 } });
      event("message_stop", {});
      res.end();
    });
  });
  return { seen, server };
}

function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.size < 5_000_000 && readFileSync(path).includes(needle)) hits.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}

test("the container runtime answers through ACP, uses ash tools over MCP, takes a steer, and keeps the key outside", { skip, timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-container-"));
  const latest = (user: string) => ["hello container", "slow job", "after restart"].map((key) => [key, user.lastIndexOf(key)] as const)
    .sort((a, b) => b[1] - a[1])[0]!;
  const { seen, server } = fakeModel((request) => {
    const [topic, at] = latest(request.user);
    if (at < 0) return { text: "plain" };
    if (topic === "hello container") return request.toolResult ? { text: "first\n\nsecond" } : { tool: { name: "mcp__ash__human_say", input: { text: "tool said" } } };
    if (topic === "slow job") return request.toolResult ? { text: request.user.includes("ALSO-BANANA") ? "saw the steer" : "missed the steer" }
      : { tool: { name: "bash", input: { command: "sleep 6; echo slept", description: "Wait six seconds" } } };
    return { text: "plain" };
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = { stateDir: join(root, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "container" as const }],
    container: { root: "", modelUpstream: upstream, direct: { dshBin: join(install!, "lib", "bin.js"), dshHome: join(root, "dsh-home"), workspace: join(root, "work"), pluginPath: plugin } } };
  new VaultStore(join(root, "state", "vault.json")).set("DEEPSEEK_API_KEY", VAULT_KEY);
  let running: Awaited<ReturnType<typeof startOwner>> | null = await startOwner(config);
  const owner = { transport: "api" as const, member: "person:owner", transportPrincipal: "token:test", local: true, remote: false, ownerProxy: true };
  const turnEnd = (r: NonNullable<typeof running>) => new Promise<Message>((resolve) => { const off = r.world.subscribe((m) => { if (m.word === "turn.end") { off(); resolve(m); } }); });
  const sayToOwner = (r: NonNullable<typeof running>, after: number) => r.ledger.list({ after, limit: 1000 })
    .filter((m) => m.from === "agent:main" && m.to === "person:owner" && m.word === "say" && m.kind === "request").map((m) => String(m.body.text));
  try {
    // 1. A turn: the agent speaks through human_say, then its closing text; both reach the owner once, in order.
    let mark = running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1 }).at(-1)!.seq;
    let ended = turnEnd(running);
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "hello container" } });
    assert.equal((await ended).body.reason, "completed");
    assert.deepEqual(sayToOwner(running, mark), ["tool said", "first", "second"]);
    const call = running.ledger.list({ after: mark, limit: 1000 }).find((m) => m.to === "service:dsh-tool" && m.word === "mcp__ash__human_say");
    assert.ok(call, "the agent's tool call is in the ledger");
    const main = seen.filter((item) => !item.mind);
    assert.ok(main[0]!.tools.includes("mcp__ash__capability_call") && main[0]!.tools.includes("mcp__ash__human_confirm") && main[0]!.tools.includes("bash"),
      "the agent has its own tools and ash's fixed MCP tools");
    assert.match(main[0]!.user, /Now: /, "the clock is injected");
    assert.match(main[0]!.user, /Current Ash context/, "the managed context is injected");
    // The provider sees the vault key; the agent's side only ever had the placeholder.
    assert.ok(seen.every((item) => item.headers["x-api-key"] === VAULT_KEY));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const usage = running.ledger.list({ after: mark, limit: 1000 }).filter((m) => m.word === "usage.recorded");
    assert.ok(usage.some((m) => m.body.scope === "chat" && m.body.input_tokens === 100 && m.body.output_tokens === 7));
    assert.deepEqual(filesContaining(join(root, "dsh-home"), VAULT_KEY), [], "the key is nowhere in the agent's home");
    assert.deepEqual(filesContaining(join(root, "work"), VAULT_KEY), [], "the key is nowhere in the agent's workspace");

    // 2. Words sent while she works join that turn at her next step.
    mark = running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1 }).at(-1)!.seq;
    ended = turnEnd(running);
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "slow job please" } });
    const startedAt = Date.now();
    while (!running.ledger.list({ after: mark, limit: 1000 }).some((m) => m.to === "service:dsh-tool" && m.word === "bash") && Date.now() - startedAt < 30_000)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const steer = await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "ALSO-BANANA" } });
    const end = await ended;
    assert.equal(end.body.reason, "completed");
    assert.deepEqual(sayToOwner(running, mark), ["saw the steer"]);
    const read = running.ledger.list({ after: mark, limit: 1000 }).filter((m) => m.word === "read" && Array.isArray(m.body.ids) && (m.body.ids as string[]).includes(steer.id));
    assert.equal(read.length, 1);
    assert.equal(read[0]!.body.turn, end.body.turn, "the steered message belongs to the running turn");
    assert.equal(running.ledger.list({ after: mark, limit: 1000 }).filter((m) => m.word === "turn.start").length, 1);

    // 3. Without a key the owner is told plainly, and nothing reaches the model.
    const before = seen.filter((item) => !item.mind).length;
    new VaultStore(join(root, "state", "vault.json")).remove("DEEPSEEK_API_KEY");
    await running.close();
    running = await startOwner(config);
    mark = running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1 }).at(-1)!.seq;
    ended = turnEnd(running);
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "anyone there" } });
    await ended;
    assert.match(sayToOwner(running, mark).join(""), /Key/);
    assert.equal(seen.filter((item) => !item.mind).length, before, "no model call without a key");

    // 4. After a restart the same session is resumed, not replaced.
    const sessions = JSON.parse(readFileSync(join(root, "state", "container-sessions.json"), "utf8")) as Record<string, string>;
    new VaultStore(join(root, "state", "vault.json")).set("DEEPSEEK_API_KEY", VAULT_KEY);
    await running.close();
    running = await startOwner(config);
    mark = running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1 }).at(-1)!.seq;
    ended = turnEnd(running);
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "after restart" } });
    await ended;
    assert.deepEqual(sayToOwner(running, mark), ["plain"]);
    assert.equal(JSON.parse(readFileSync(join(root, "state", "container-sessions.json"), "utf8")).main, sessions.main);
    assert.ok(running.container!.timings["resume:main"] !== undefined, "the main session was resumed");
  } finally {
    await running?.close();
    server.close();
  }
});

test("agents work together: the main agent asks the keeper, which answers from its own session and tools", { skip, timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-agents-"));
  const keeperTurns: Seen[] = [];
  const { seen, server } = fakeModel((request) => {
    if (request.user.includes("后台整理者")) {
      keeperTurns.push(request);
      if (!request.toolResult) return { tool: { name: "mcp__ash__capability_call", input: { member: "service:self", word: "read", body: { path: "MEMORY.md" } } } };
      return { text: "记录里写的是 3 月 4 日" };
    }
    if (request.user.includes("我生日哪天") && !request.toolResult) return { tool: { name: "mcp__ash__agent_ask", input: { agent: "agent:keeper", text: "主人的生日记的是哪天？" } } };
    if (request.user.includes("我生日哪天")) return { text: request.raw.includes("3 月 4 日") ? "你的生日是 3 月 4 日" : `我没问到 ${request.raw.slice(-600)}` };
    return { text: "plain" };
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const work = join(root, "work");
  const config = { stateDir: join(root, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "container" as const }],
    container: { root: "", modelUpstream: upstream, direct: { dshBin: join(install!, "lib", "bin.js"), dshHome: join(root, "dsh-home"), workspace: work, pluginPath: plugin } } };
  new VaultStore(join(root, "state", "vault.json")).set("DEEPSEEK_API_KEY", VAULT_KEY);
  const running = await startOwner(config);
  const owner = { transport: "api" as const, member: "person:owner", transportPrincipal: "token:test", local: true, remote: false, ownerProxy: true };
  try {
    assert.deepEqual(running.agents().map((agent) => agent.id), ["agent:main", "agent:keeper"]);
    const ended = new Promise<Message>((resolve) => { const off = running.world.subscribe((m) => { if (m.from === "agent:main" && m.word === "turn.end") { off(); resolve(m); } }); });
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "我生日哪天来着？" } });
    assert.equal((await ended).body.reason, "completed");
    const toOwner = running.ledger.list({ after: 0, limit: 1000 }).filter((m) => m.kind === "request" && m.from === "agent:main" && m.to === "person:owner" && m.word === "say").map((m) => String(m.body.text));
    assert.deepEqual(toOwner, ["你的生日是 3 月 4 日"]);
    // The keeper has its own brief/workspace and can inspect its own approvals, but cannot speak to the owner.
    assert.ok(keeperTurns.length >= 2);
    assert.ok(!keeperTurns[0]!.tools.some((tool) => /human_(say|ask|confirm|notify|show)$/.test(tool)), "the keeper cannot speak to the owner");
    assert.ok(keeperTurns[0]!.tools.includes("mcp__ash__human_pending"));
    assert.ok(keeperTurns[0]!.tools.includes("mcp__ash__agent_tell"));
    assert.ok(seen.find((item) => item.user.includes("我生日哪天"))!.tools.includes("mcp__ash__human_say"));
    assert.ok(existsSync(join(root, "agents", "keeper")), "the keeper has its own workspace");
    const keeperCall = running.ledger.list({ after: 0, limit: 1000 }).find((m) => m.from === "agent:keeper" && m.to === "service:dsh-tool");
    assert.ok(keeperCall, "the keeper's tool calls are recorded as the keeper's");
    const keeperRead = running.ledger.list({ after: 0, limit: 1000 }).find((m) => m.from === "agent:keeper" && m.to === "service:self" && m.word === "read");
    assert.ok(keeperRead, "the keeper reached service:self as itself");
    const sessions = JSON.parse(readFileSync(join(root, "state", "container-sessions.json"), "utf8")) as Record<string, string>;
    assert.ok(sessions.main && sessions["agent:keeper"] && sessions.main !== sessions["agent:keeper"]);
  } finally {
    await running.close();
    server.close();
  }
});

/** A real, decodable PNG of one colour, so the runtime's image pipeline accepts it. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])));
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0))]);
}

test("the model sees images: the owner's photo in the prompt and a screen capability's image in the tool result", { skip, timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-vision-"));
  type Block = { type?: string; text?: string; source?: { type?: string }; content?: Block[] | string };
  const requests: { model: string; messages: { role: string; content: Block[] | string }[] }[] = [];
  const files: { key: unknown; bytes: number }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const json = (status: number, value: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.url?.includes("/v1/files")) {
        if (req.method !== "POST") return json(404, { error: { message: "not found" } });
        // The provider's Files API: a multipart upload answered with the stored file's facts.
        const file = (await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData()).get("file") as File;
        files.push({ key: req.headers["x-api-key"], bytes: file.size });
        return json(200, { id: `file-${files.length}`, type: "file", filename: file.name, mime_type: file.type, size_bytes: file.size, created_at: new Date().toISOString() });
      }
      if (!req.url?.endsWith("/messages")) return json(404, {});
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof requests)[number];
      const text = JSON.stringify(request.messages);
      const mind = text.includes("This is your private mind space");
      if (!mind) requests.push(request);
      const last = request.messages.at(-1);
      const toolResult = Array.isArray(last?.content) && last.content.some((part) => part.type === "tool_result");
      const tool = !mind && text.includes("what is in this photo") && !toolResult;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 } } });
      if (tool) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_see", name: "mcp__ash__capability_call", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ member: "device:test", word: "screen.see", body: {} }) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: mind ? "ok" : "a red square, and a blue screen" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 7 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = { stateDir: join(root, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "container" as const }],
    container: { root: "", modelUpstream: upstream, direct: { dshBin: join(install!, "lib", "bin.js"), dshHome: join(root, "dsh-home"), workspace: join(root, "work"), pluginPath: plugin } } };
  new VaultStore(join(root, "state", "vault.json")).set("DEEPSEEK_API_KEY", VAULT_KEY);
  // An install that stored the retired default id comes back on the current one.
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(join(config.stateDir, "container-model.json"), JSON.stringify({ provider: "deepseek-official", model: "deepseek-v4-flash" }));
  const running = await startOwner(config);
  const screen = solidPng(32, 48, [0, 0, 255]);
  running.members.registerDevice({ id: "device:test", kind: "device", name: "Test phone", online: true,
    capabilities: () => [{ name: "screen.see", label: "See the screen", description: "Look at the screen. Read-only.", risk: "none",
      input_schema: { type: "object", properties: {}, additionalProperties: false } }],
    handle: async () => ({ ok: true, result: { content: [{ type: "text", text: "Screen 32x48 px" }, { type: "image", data: screen.toString("base64"), mimeType: "image/png" }] } }) });
  const owner = { transport: "api" as const, member: "person:owner", transportPrincipal: "token:test", local: true, remote: false, ownerProxy: true };
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(config.stateDir, "container-model.json"), "utf8")), { provider: "deepseek-official", model: "deepseek-flash" });
    await running.container!.boot();
    assert.equal(running.container!.imageInput, true, "the runtime declares image input for deepseek-flash");
    const ended = new Promise<Message>((resolve) => { const off = running.world.subscribe((m) => { if (m.from === "agent:main" && m.word === "turn.end") { off(); resolve(m); } }); });
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "what is in this photo?",
      attachments: [{ name: "red.png", mime_type: "image/png", data: solidPng(40, 30, [255, 0, 0]).toString("base64") }] } });
    assert.equal((await ended).body.reason, "completed");
    assert.ok(requests.every((request) => request.model === "deepseek-flash"));
    const images = (blocks: Block[] | string | undefined): Block[] => Array.isArray(blocks) ? blocks.flatMap((block) => block.type === "image" ? [block] : images(block.content)) : [];
    const first = requests.find((request) => JSON.stringify(request.messages).includes("what is in this photo"))!;
    const userImages = first.messages.filter((message) => message.role === "user").flatMap((message) => images(message.content));
    assert.equal(userImages.length, 1, "the owner's photo is an image in the prompt, not only a path");
    const after = requests.find((request) => JSON.stringify(request.messages).includes("toolu_see"))!;
    const toolResult = after.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((part) => part.type === "tool_result")!;
    assert.equal(images(toolResult.content).length, 1, "the screen image is an image in the tool result");
    const toolText = (toolResult.content as Block[]).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.match(toolText, /Screen 32x48 px/);
    assert.ok(toolText.length < 2000 && !toolText.includes(screen.toString("base64").slice(0, 40)), "and not as base64 text");
    assert.ok(files.length >= 2 && files.every((file) => file.key === VAULT_KEY && file.bytes > 0), "images are uploaded through the egress with the vault key");
    assert.ok([userImages[0]!, ...images(toolResult.content)].every((image) => image.source?.type === "file"), "requests reference the uploaded files");
  } finally {
    await running.close();
    server.close();
  }
});
