import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { lintWords } from "../../../../sdk/src/word";
import type { Message, Outgoing, Reply, WordResult } from "../../../../sdk/src/message";
import { createHostPipe, createHostService, createVirtualScreen } from "../../../src/edges/host";
import type { PhoneRelease, ReleaseOptions } from "../../../src/edges/host/release";
import { HostCallError } from "../../../src/edges/host/client";

const capOfMethod = (m: string) => (m.startsWith("vscreen.") ? "vscreen" : m === "input.key" ? "input" : "apps");
const PHONE_RESULTS: Record<string, unknown> = {
  "vscreen.create": { displayId: 3, width: 720, height: 1280, dpi: 320, reused: false, message: "Virtual screen created." },
  "vscreen.see": { jpeg: "AAAA", displayId: 3, screenW: 720, screenH: 1280, imageW: 360, imageH: 640 },
  "vscreen.tap": { message: "Tapped." },
  "input.key": { message: "Media key play_pause sent." },
  "apps.open": { package: "com.x", opened: true, message: "started and confirmed in front (com.x)" },
};
const RELEASE: PhoneRelease = { version: "0.4.49", packages: [{ package: "ai.ash.agent", url: "https://api.github.com/a/1", sha256: "a".repeat(64) }, { package: "ai.ash.kernel", url: "https://api.github.com/a/2", sha256: "b".repeat(64) }] };
const setup = (offline: string[] = [], onNetwork?: (network: unknown, online: boolean) => void, phoneCaps: string[] = ["vscreen", "input", "apps"], hands: string[] = ["device:h1"], vault: Record<string, string> = {}) => {
  const asked: ReleaseOptions[] = [];
  const sent: { msg: Outgoing; from: string }[] = [];
  const calls: unknown[][] = [];
  const stops: unknown[][] = [];
  const logs: string[] = [];
  const supported = <R>(result: R) => ({ supported: true as const, result });
  const caps = new Set<string>(["wake", "power", "hands", "update", ...phoneCaps]);
  const client = {
    wakeAt: async (at: number) => { calls.push(["wakeAt", at]); return supported({}); },
    wakeClear: async () => { calls.push(["wakeClear"]); return { supported: false as const }; },
    powerHold: async (ms: number, reason: string) => { calls.push(["powerHold", ms, reason]); return supported({}); },
    powerRelease: async () => supported({}),
    handsHandoff: async (port: number, token: string) => { calls.push(["handoff", port, token]); return supported({ delivered: ["x"] }); },
    updateInstall: async (req: unknown) => { calls.push(["updateInstall", req]); return supported({ started: true as const, via: "shell" as const }); },
    updateStatus: async () => supported({ state: "downloading", version: "0.4.49" }),
    ctxList: async () => caps.has("ctx") ? supported({ probe: { state: "running" as const, since: 1 }, days: [] }) : { supported: false as const },
    ctxRead: async (req: any) => {
      calls.push(["ctxRead", req]);
      if (!caps.has("ctx")) return { supported: false as const };
      if (req.day === "bad") throw new HostCallError("bad_request", "day must be YYYY-MM-DD", "ctx.read");
      return supported({ day: req.day, file: req.file, offset: 0, next_offset: 3, size: 3, eof: true, text: "{}\n" });
    },
    has: (cap: string) => caps.has(cap),
    phone: async (method: string, req: unknown): Promise<any> => {
      calls.push(["phone", method, req]);
      if (!caps.has(capOfMethod(method))) return { supported: false as const };
      return supported(PHONE_RESULTS[method] ?? { message: "ok" });
    },
    lifecycleRestart: async (reason: string) => { calls.push(["restart", reason]); return {}; },
  };
  const router = {
    send: async (msg: Outgoing, caller: { member: string }): Promise<Reply> => {
      sent.push({ msg, from: caller.member });
      if (msg.word === "apps.open_direct") return msg.body && (msg.body as { app?: string }).app === "blocked"
        ? { ok: false, error: { code: "unavailable", message: "cannot open the screen", recovery_hint: "turn on accessibility" } }
        : { ok: true, result: { data: { opened: true, package: "com.x" }, content: [{ type: "text", text: "Opened X: started." }] } };
      return offline.includes(msg.to ?? "") ? { ok: false, error: { code: "offline", message: "off" } } : { ok: true };
    },
  };
  const registry = { findByWord: (word: string) => (word === "apps.open_direct" ? hands.map((id) => ({ id })) : []) as never[] };
  const virtual = createVirtualScreen(client);
  const service = createHostService({
    client, router, registry, virtual, onStop: (deadline, reason) => { stops.push([deadline, reason]); }, ...(onNetwork ? { onNetwork } : {}), log: (m) => logs.push(m),
    vault: { use: (ref) => vault[ref] ?? null }, release: async (o) => { asked.push(o); return { ...RELEASE, version: o.version?.replace(/^v/, "") ?? RELEASE.version }; },
  });
  return { service, sent, calls, stops, logs, virtual, asked };
};
const msg = (word: string, body: unknown): Message => ({ seq: 1, id: "m1", ts: 1, from: "service:clock", to: "service:host", kind: "request", word, body });
const ctx = { signal: new AbortController().signal, caller: { member: "service:clock", via: "service" as const, local: true }, raw: undefined };
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("service:host: its words are the host client's calls; what the host lacks answers unavailable", async () => {
  const s = setup();
  assert.equal(s.service.member.id, "service:host");
  assert.deepEqual(lintWords(s.service.member.words()), []);
  assert.deepEqual(await s.service.member.handle(msg("wake.at", { at: 5 }), ctx), { data: {} });
  assert.deepEqual(await s.service.member.handle(msg("hands.handoff", { port: 9, token: "t" }), ctx), { data: { delivered: ["x"] } });
  await assert.rejects(s.service.member.handle(msg("wake.clear", {}), ctx), (e: any) => e.code === "unavailable");
  await assert.rejects(s.service.member.handle(msg("nope", {}), ctx), (e: any) => e.code === "not_found");
  assert.deepEqual(s.calls, [["wakeAt", 5], ["handoff", 9, "t"], ["wakeClear"]]);
});

test("service:host: phone actions are forwarded to the host and shaped (data, the host's message, the see JPEG)", async () => {
  const s = setup();
  assert.deepEqual(await s.service.member.handle(msg("input.key", { key: "play_pause" }), ctx), { content: [{ type: "text", text: "Media key play_pause sent." }] });
  assert.deepEqual(await s.service.member.handle(msg("apps.open", { app: "x" }), ctx), { data: { package: "com.x", opened: true }, content: [{ type: "text", text: "started and confirmed in front (com.x)" }] });
  assert.deepEqual(await s.service.member.handle(msg("vscreen.create", { short_edge: 720 }), ctx), { data: { displayId: 3, width: 720, height: 1280, dpi: 320, reused: false }, content: [{ type: "text", text: "Virtual screen created." }] });
  const see = await s.service.member.handle(msg("vscreen.see", {}), ctx) as WordResult;
  assert.deepEqual(see.content?.[1], { type: "image", mime: "image/jpeg", b64: "AAAA" });
  assert.match((see.content?.[0] as { text: string }).text, /display 3\) 720x1280; image 360x640: multiply image coordinates by 2\.0000/);
  assert.deepEqual(s.calls, [["phone", "input.key", { key: "play_pause" }], ["phone", "apps.open", { app: "x" }], ["phone", "vscreen.create", { short_edge: 720 }], ["phone", "vscreen.see", {}]]);
});

test("service:host: a phone word is listed only while the host has its group, and answers unavailable otherwise", async () => {
  const s = setup([], undefined, ["input"]); // host can do media/volume keys (unpaired), but no virtual screen, no launching
  const listed = s.service.member.words().map((w) => w.word);
  assert.ok(listed.includes("input.key"), "input.key is listed");
  assert.ok(!listed.some((w) => w.startsWith("vscreen.") && w !== "vscreen.state"), "no vscreen action is listed");
  assert.ok(listed.includes("apps.open") && !listed.includes("apps.open_url") && !listed.includes("apps.open_direct"), "apps.open is listed once, the hand's own word is not");
  await assert.rejects(s.service.member.handle(msg("vscreen.create", {}), ctx), (e: any) => e.code === "unavailable");
  assert.deepEqual(await s.service.member.handle(msg("input.key", { key: "play_pause" }), ctx), { content: [{ type: "text", text: "Media key play_pause sent." }] });
});

test("host events become words sent as service:host; a missing service:link is not an error; lifecycle.stop reaches onStop", async () => {
  const s = setup(["service:link"]);
  const input = new PassThrough();
  const reader = s.service.listen(createHostPipe(input, new PassThrough(), (line) => s.logs.push(line)));
  input.write('{"event":"wake.fired","at":1791234567000}\n');
  input.write('{"event":"env.changed","what":"power","saver":true}\n');
  input.write('{"event":"lifecycle.stop","deadline":1791234597000,"reason":"system_shutdown"}\n');
  input.write("not json\n");
  await settle();
  reader.close();
  assert.deepEqual(s.sent.map((x) => [x.from, x.msg.kind, x.msg.to, x.msg.word, x.msg.body]), [
    ["service:host", "event", "service:clock", "wake.fired", { at: 1791234567000 }],
    ["service:host", "event", "service:agents", "env.changed", { what: "power", saver: true }],
    ["service:host", "event", "service:link", "env.changed", { what: "power", saver: true }],
  ]);
  assert.deepEqual(s.stops, [[1791234597000, "system_shutdown"]]);
  assert.equal(s.logs.length, 1, "only the bad line is logged");
});

test("env.changed/network also reaches onNetwork, with the proxy as the host gave it; power changes do not", async () => {
  const seen: unknown[][] = [];
  const s = setup([], (network, online) => seen.push([network, online]));
  const input = new PassThrough();
  const reader = s.service.listen(createHostPipe(input, new PassThrough(), (line) => s.logs.push(line)));
  input.write('{"event":"env.changed","what":"network","network":{"proxy":{"http":"http://10.0.2.2:7890","no_proxy":"a.b"}},"online":true}\n');
  input.write('{"event":"env.changed","what":"power","saver":true}\n');
  input.write('{"event":"env.changed","what":"network","network":{"proxy":null},"online":false}\n');
  await settle();
  reader.close();
  assert.deepEqual(seen, [[{ proxy: { http: "http://10.0.2.2:7890", no_proxy: "a.b" } }, true], [{ proxy: null }, false]]);
  assert.equal(s.sent.filter((x) => x.msg.to === "service:agents").length, 3, "the words still go out as before");
});

test("service:host restart: the answer goes first, the host is asked to restart a moment later; the owner, an agent and an app may all ask", async () => {
  const s = setup();
  assert.deepEqual(await s.service.member.handle(msg("restart", { reason: "the owner asked in her status" }), ctx), { data: { restarting: true } });
  assert.deepEqual(s.calls, [], "not before the answer is out");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(s.calls, [["restart", "the owner asked in her status"]]);
  assert.deepEqual(s.service.member.words().find((w) => w.word === "restart")!.callers, ["owner", "agent", "app"]);
  assert.equal(s.service.member.words().find((w) => w.word === "restart")!.risk, "structure", "an agent's restart goes through the gate");
});

test("service:host apps.open: unpaired it goes to the hand app (one word for the agent), paired it goes to the host", async () => {
  const unpaired = setup([], undefined, ["input"]);
  const turnCtx = { ...ctx, caller: { ...ctx.caller, turn: "t7" } };
  assert.deepEqual(await unpaired.service.member.handle(msg("apps.open", { app: "x" }), turnCtx), { data: { opened: true, package: "com.x" }, content: [{ type: "text", text: "Opened X: started." }] });
  assert.deepEqual(unpaired.sent.map((x) => [x.from, x.msg.to, x.msg.kind, x.msg.word, x.msg.body]), [["service:host", "device:h1", "request", "apps.open_direct", { app: "x" }]]);
  assert.deepEqual(unpaired.calls, [], "the host was not asked");
  assert.equal(unpaired.virtual.screenChanges(), 1, "the hub counts the change itself");
  await assert.rejects(unpaired.service.member.handle(msg("apps.open", { app: "blocked" }), ctx), (e: any) => e.code === "unavailable" && e.recovery_hint === "turn on accessibility");
  assert.equal(unpaired.virtual.screenChanges(), 1, "a start that did not happen is not a change");
  const none = setup([], undefined, ["input"], []);
  await assert.rejects(none.service.member.handle(msg("apps.open", { app: "x" }), ctx), (e: any) => e.code === "unavailable");
  const paired = setup();
  await paired.service.member.handle(msg("apps.open", { app: "x" }), ctx);
  assert.deepEqual(paired.sent, []);
  assert.deepEqual(paired.calls, [["phone", "apps.open", { app: "x" }]]);
  assert.equal(paired.virtual.screenChanges(), 1);
  await paired.service.member.handle(msg("input.key", { key: "back" }), ctx);
  assert.equal(paired.virtual.screenChanges(), 2);
});

test("service:host: the virtual screen being made or closed is told to the owner's screens", async () => {
  const s = setup();
  await s.service.member.handle(msg("vscreen.create", {}), ctx);
  await s.service.member.handle(msg("vscreen.tap", { x: 1, y: 1 }), ctx);
  await s.service.member.handle(msg("vscreen.close", {}), ctx);
  await settle();
  assert.deepEqual(s.sent.map((x) => [x.from, x.msg.to, x.msg.kind, x.msg.word, x.msg.body]), [
    ["service:host", "person:owner", "event", "vscreen.state", { open: true }],
    ["service:host", "person:owner", "event", "vscreen.state", { open: false }],
  ]);
});

test("vscreen.record.stop: the host's video is copied into the main body's work directory; the owner's stop also shows a file card, an agent's does not", async () => {
  const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rec-"));
  const video = join(dir, "host.mp4");
  await writeFile(video, "not really a video");
  const sent: Outgoing[] = [];
  const client = {
    wakeAt: async () => ({ supported: false as const }), wakeClear: async () => ({ supported: false as const }), powerHold: async () => ({ supported: false as const }),
    powerRelease: async () => ({ supported: false as const }), handsHandoff: async () => ({ supported: false as const }), updateInstall: async () => ({ supported: false as const }), updateStatus: async () => ({ supported: false as const }),
    ctxList: async () => ({ supported: false as const }), ctxRead: async () => ({ supported: false as const }),
    lifecycleRestart: async () => ({}), has: (cap: string) => cap === "vscreen",
    phone: async (method: string): Promise<any> => ({ supported: true as const, result: method === "vscreen.record.stop" ? { path: video, seconds: 4.5, bytes: 18, reason: "stopped" } : { message: "ok" } }),
  };
  const router = { send: async (msg: Outgoing): Promise<Reply> => { sent.push(msg); return { ok: true }; } };
  const service = createHostService({ client, router, registry: { findByWord: () => [] }, virtual: createVirtualScreen(client), recordings: { hostDir: join(dir, "work", "recordings"), bodyDir: "/root/work/recordings" }, onStop: () => {} });
  const agent = { ...ctx, caller: { member: "agent:main", via: "service" as const, local: true } };
  const owner = { ...ctx, caller: { member: "person:owner", via: "service" as const, local: true } };

  const byAgent = await service.member.handle(msg("vscreen.record.stop", {}), agent) as { data: { path: string; name: string; seconds: number; reason: string } };
  assert.match(byAgent.data.path, /^\/root\/work\/recordings\/vscreen-\d{8}T\d{6}\.mp4$/);
  assert.equal(byAgent.data.seconds, 4.5);
  assert.equal(await readFile(join(dir, "work", "recordings", byAgent.data.name), "utf8"), "not really a video");
  assert.equal(sent.filter((m) => m.word === "show").length, 0);

  await service.member.handle(msg("vscreen.record.stop", {}), owner);
  const shows = sent.filter((m) => m.word === "show");
  assert.equal(shows.length, 1);
  assert.deepEqual((shows[0]!.body as { card: Record<string, unknown> }).card, { type: "file", workspace: "body:main", path: shows[0] && (shows[0].body as any).card.path, name: (shows[0]!.body as any).card.name, mime_type: "video/mp4", size: 18 });
  assert.equal(shows[0]!.to, "person:owner");
});

test("service:host update.install: only the version is asked; the release comes from GitHub and the token goes to the host, never into the answer", async () => {
  const s = setup([], undefined, undefined, undefined, { GITHUB_TOKEN: "ghp_readonly" });
  const answer = await s.service.member.handle(msg("update.install", { version: "v0.4.49" }), ctx) as WordResult;
  assert.deepEqual(answer, { data: { started: true, version: "0.4.49", via: "shell", packages: ["ai.ash.agent", "ai.ash.kernel"] } });
  assert.deepEqual(s.asked, [{ repo: "wanpengxie/ash-drop", version: "v0.4.49", token: "ghp_readonly" }]);
  assert.deepEqual(s.calls.at(-1), ["updateInstall", { version: "0.4.49", packages: RELEASE.packages, token: "ghp_readonly" }]);
  assert.ok(!JSON.stringify(answer).includes("ghp_"));
  assert.deepEqual(await s.service.member.handle(msg("update.status", {}), ctx), { data: { state: "downloading", version: "0.4.49" } });

  // Without a token: the latest public release, and no token sent.
  const open = setup();
  await open.service.member.handle(msg("update.install", {}), ctx);
  assert.deepEqual(open.asked, [{ repo: "wanpengxie/ash-drop", token: null }]);
  assert.deepEqual(open.calls.at(-1), ["updateInstall", { version: "0.4.49", packages: RELEASE.packages }]);
});

test("service:host ctx.list / ctx.read: the probe's files through the host; the host's bad_request is the word's; without ctx unavailable", async () => {
  const s = setup([], undefined, ["ctx"]);
  assert.deepEqual(await s.service.member.handle(msg("ctx.list", {}), ctx), { data: { probe: { state: "running", since: 1 }, days: [] } });
  const read = await s.service.member.handle(msg("ctx.read", { day: "2026-10-15", file: "events", offset: 0, limit: 10, path: "/etc/passwd" }), ctx) as WordResult;
  assert.equal((read.data as { text: string }).text, "{}\n");
  assert.deepEqual(s.calls.at(-1), ["ctxRead", { day: "2026-10-15", file: "events", offset: 0, limit: 10 }], "only day, file, offset and limit go to the host");
  await assert.rejects(s.service.member.handle(msg("ctx.read", { day: "bad", file: "events" }), ctx), (e: any) => e.code === "bad_request");
  const without = setup();
  await assert.rejects(without.service.member.handle(msg("ctx.list", {}), ctx), (e: any) => e.code === "unavailable");
  await assert.rejects(without.service.member.handle(msg("ctx.read", { day: "2026-10-15", file: "events" }), ctx), (e: any) => e.code === "unavailable");
});
