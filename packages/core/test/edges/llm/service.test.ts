import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { WordError, type Caller, type Message } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { createLlm, type Complete, type LlmUsageReport } from "../../../src/edges/llm";
import { createLlmService } from "../../../src/edges/llm/service";

const reply = (text = "four", patch: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }],
  api: "openai-completions", provider: "deepseek", model: "m", stopReason: "stop", timestamp: 1,
  usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...patch });

function service(complete: Complete = async () => reply(), key: string | null = "fake-key-0001", fetch?: typeof globalThis.fetch) {
  const reports: LlmUsageReport[] = [];
  const seen: { model: Model<Api>; context: Context; options: Record<string, unknown> }[] = [];
  const llm = createLlm({ key: () => key, report: (usage) => { reports.push(usage); }, clock: { now: () => 5 }, ...(fetch ? { fetch } : {}),
    complete: async (model, context, options) => { seen.push({ model, context, options }); return complete(model, context, options); } });
  return { member: createLlmService(llm), llm, reports, seen };
}
const msg = (word: string, body: unknown): Message => ({ seq: 1, id: "m_1", ts: 1, from: "app:fixture", to: "service:llm", kind: "request", word, body });
const ctx = (member: string, via: Caller["via"]) => ({ signal: new AbortController().signal, caller: { member, via, local: false } as Caller, raw: undefined });
const ask = { messages: [{ role: "user" as const, content: "2+2?" }], max_tokens: 20 };

test("service:llm speaks the words of its contract", () => {
  const { member } = service();
  assert.equal(member.id, "service:llm");
  assert.equal(member.kind, "service");
  assert.deepEqual(member.words().map((word) => word.word), ["complete", "keys.status", "keys.check", "usage.recorded"]);
  assert.deepEqual(member.words(), wordsOf("service:llm"));
});

test("complete: the text comes back, the model is the default one, and the use is counted against the caller", async () => {
  const { member, reports, seen } = service();
  const out = await member.handle(msg("complete", ask), ctx("app:fixture", "app"));
  assert.deepEqual(out, { data: { text: "four", model: "deepseek-flash", usage: { input_tokens: 11, output_tokens: 7 } } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.caller, "app:fixture");
  assert.equal(reports[0]!.ok, true);
  assert.equal(seen[0]!.options.maxTokens, 20);
  const check = compileSchema(wordsOf("service:llm")[0]!.result_schema!);
  assert.equal(check((out as { data: unknown }).data), true, JSON.stringify(check.errors));
});

test("complete: whoever calls, the use is theirs (the owner, an agent, an app)", async () => {
  const { member, reports } = service();
  for (const [who, via] of [["person:owner", "human"], ["agent:main", "agent"], ["app:sense-rules", "app"]] as const) await member.handle(msg("complete", ask), ctx(who, via));
  assert.deepEqual(reports.map((report) => report.caller), ["person:owner", "agent:main", "app:sense-rules"]);
});

test("complete: a named model is used and echoed back", async () => {
  const { member, seen } = service();
  const out = await member.handle(msg("complete", { ...ask, model: "openrouter:vendor/small" }), ctx("agent:main", "agent")) as { data: { model: string } };
  assert.equal(out.data.model, "openrouter:vendor/small");
  assert.equal(seen[0]!.model.id, "vendor/small");
  assert.equal(seen[0]!.model.provider, "openrouter");
});

test("complete: failures carry the contract's error codes", async () => {
  const code = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { assert.ok(error instanceof WordError); return error.code; } return "none"; };
  const ok = service();
  assert.equal(await code(() => ok.member.handle(msg("complete", { messages: [] }), ctx("app:a", "app"))), "bad_request");
  assert.equal(await code(() => ok.member.handle(msg("complete", { ...ask, model: "nonsense" }), ctx("app:a", "app"))), "bad_request");
  assert.equal(await code(() => service(undefined, null).member.handle(msg("complete", ask), ctx("app:a", "app"))), "unavailable");
  assert.equal(await code(() => service(async () => { throw new Error("upstream down"); }).member.handle(msg("complete", ask), ctx("app:a", "app"))), "failed");
  assert.equal(await code(() => ok.member.handle(msg("nothing", ask), ctx("app:a", "app"))), "not_found");
  const failed = service(async () => { throw new Error("upstream down"); });
  await failed.member.handle(msg("complete", ask), ctx("app:a", "app")).catch(() => {});
  assert.equal(failed.reports[0]!.ok, false, "a failed call is still reported");
});

test("complete: no key is ever in an error", async () => {
  const { member } = service(async () => { throw new Error("401 bad key fake-key-0001"); });
  try { await member.handle(msg("complete", ask), ctx("app:a", "app")); assert.fail("should throw"); } catch (error) { assert.doesNotMatch((error as Error).message, /fake-key-0001/); }
});

// ---- model key health -----------------------------------------------------------------------------------------------
const event = (word: string, body: unknown): Message => ({ seq: 2, id: "m_2", ts: 1, from: "service:vault", to: "service:llm", kind: "event", word, body });
function checked(answer: () => Response | Promise<Response>, key: string | null = "fake-key-0001") {
  const urls: string[] = [];
  const f = service(async () => reply(), key, (async (url: unknown) => { urls.push(String(url)); return answer(); }) as unknown as typeof fetch);
  return { ...f, urls };
}

test("keys.status: both keys with their standing, no key anywhere, and no network", async () => {
  const f = checked(() => new Response("{}"));
  const out = await f.member.handle(msg("keys.status", {}), ctx("agent:main", "agent")) as { data: { keys: unknown[] } };
  assert.deepEqual(out.data.keys, [{ provider: "deepseek", ref: "DEEPSEEK_API_KEY", configured: true, status: "unknown" }, { provider: "openrouter", ref: "OPENROUTER_API_KEY", configured: true, status: "unknown" }]);
  assert.equal(f.urls.length, 0);
  const contract = wordsOf("service:llm");
  for (const word of ["keys.status", "keys.check"]) assert.deepEqual(contract.find((w) => w.word === word)!.callers, ["owner", "agent"]);
  const check = compileSchema(contract.find((w) => w.word === "keys.status")!.result_schema!);
  assert.equal(check(out.data), true, JSON.stringify(check.errors));
});

test("keys.check: asks the provider now (one, or both) and answers like keys.status", async () => {
  const f = checked(() => new Response('{"error":{"message":"API key expired"}}', { status: 401 }));
  const one = await f.member.handle(msg("keys.check", { provider: "openrouter" }), ctx("person:owner", "human")) as { data: { keys: { provider: string; status: string; reason?: string }[] } };
  assert.deepEqual(one.data.keys.map((k) => [k.provider, k.status, k.reason]), [["openrouter", "rejected", "已过期"]]);
  assert.deepEqual(f.urls, ["https://openrouter.ai/api/v1/key"]);
  const both = await f.member.handle(msg("keys.check", {}), ctx("agent:main", "agent")) as { data: { keys: { provider: string; status: string }[] } };
  assert.deepEqual(both.data.keys.map((k) => [k.provider, k.status]), [["deepseek", "rejected"], ["openrouter", "rejected"]]);
  const schema = compileSchema(wordsOf("service:llm").find((w) => w.word === "keys.check")!.input_schema);
  assert.equal(schema({ provider: "nobody" }), false);
  assert.equal(schema({}), true);
});

test("saving a model key in the vault checks it at once; saving another ref does nothing; removing forgets", async () => {
  let accepted = false;
  const f = checked(() => accepted ? new Response("{}") : new Response("no", { status: 401 }));
  await f.member.handle(event("vault.changed", { ref: "CLOUDFLARE_TOKEN", action: "saved" }), ctx("service:vault", "service"));
  assert.equal(f.urls.length, 0);
  await f.member.handle(event("vault.changed", { ref: "DEEPSEEK_API_KEY", action: "saved" }), ctx("service:vault", "service"));
  assert.deepEqual(f.urls, ["https://api.deepseek.com/user/balance"]);
  assert.equal(f.llm.keys()[0]!.status, "rejected");
  accepted = true;
  await f.member.handle(event("vault.changed", { ref: "DEEPSEEK_API_KEY", action: "saved" }), ctx("service:vault", "service"));
  assert.equal(f.llm.keys()[0]!.status, "ok", "a new key does not inherit the old key's verdict");
  await f.member.handle(event("vault.changed", { ref: "DEEPSEEK_API_KEY", action: "removed" }), ctx("service:vault", "service"));
  assert.equal(f.llm.keys()[0]!.status, "unknown");
  assert.equal(f.urls.length, 2, "removal asks nobody");
});

test("the member listens for vault.changed", () => {
  assert.deepEqual(service().member.listens, ["vault.changed"]);
});

test("keys.check: an agent asks the provider every time, the same as the owner", async () => {
  const f = checked(() => new Response("{}"));
  const call = (who: string, via: Caller["via"]) => f.member.handle(msg("keys.check", { provider: "deepseek" }), ctx(who, via)) as Promise<{ data: { keys: { checked_at?: number; status: string }[] } }>;
  const first = await call("agent:main", "agent");
  assert.deepEqual([first.data.keys[0]!.status, first.data.keys[0]!.checked_at], ["ok", 5]);
  await call("agent:main", "agent");
  assert.equal(f.urls.length, 2, "no cooldown for an agent");
  await call("person:owner", "human");
  assert.equal(f.urls.length, 3);
});
