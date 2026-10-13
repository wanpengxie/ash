/**
 * The runtime catalog and the lasting runtime settings of service:agents: the catalog word (what is usable, why not, how to make it so),
 * `update` with a runtime patch (merged, checked against the catalog, saved, taken live where the runtime can), and the plain list for a
 * runtime without a catalog.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStartSpec, CatalogOptions, CatalogProvider, RuntimeCatalog, RuntimeSettings } from "../../../../sdk/src/driver";
import { FakeDriver, fixture, caller } from "./helpers";

const M = "agent:main";
const code = (c: string) => (e: any) => e?.code === c;
const model = (id: string, efforts: string[]) => ({ id, name: id, images: true, reasoning: efforts.length > 0, efforts });
const many = Array.from({ length: 25 }, (_, i) => model(`openrouter/v/m${i}`, i % 2 ? ["low", "high"] : []));

/** A driver with a catalog of three providers: a key one, a login one, and a big list behind a key. */
class CatalogDriver extends FakeDriver {
  live = true;
  login: "ready" | "none" = "none";
  constructor(report: ConstructorParameters<typeof FakeDriver>[0]) {
    super(report);
    this.info = { ...this.info, kind: "dsh", abilities: { ...this.info.abilities, runtime_live: true } } as typeof this.info;
  }
  async catalog(agent: string, saved: RuntimeSettings, options?: CatalogOptions): Promise<RuntimeCatalog> {
    this.calls.push(["catalog", agent, saved, options]);
    const providers: CatalogProvider[] = [
      { id: "deepseek", name: "DeepSeek", needs_proxy: false, auth: { kind: "key", ref: "DEEPSEEK_API_KEY" }, models: [model("deepseek/flash", ["off", "low", "high"]), model("deepseek/plain", [])] },
      { id: "codex", name: "Codex", needs_proxy: true, auth: { kind: "login", method: "browser", state: this.login, how: "Ask the owner to log in." }, models: [model("codex/gpt", ["low", "medium", "high"])] },
      { id: "openrouter", name: "OpenRouter", needs_proxy: false, auth: { kind: "key", ref: "OPENROUTER_API_KEY" }, models: many },
    ];
    return { providers, effective: { model: "deepseek/flash" }, source: { checked_at: 1_700_000_100_000, upstream_at: 1_700_000_000_000, refreshing: false } };
  }
}

function setup(over: { live?: boolean; secrets?: Record<string, string> } = {}) {
  let driver!: CatalogDriver;
  const f = fixture({ secrets: over.secrets, drivers: { dsh: (report) => { driver = new CatalogDriver(report); driver.info = { ...driver.info, abilities: { ...driver.info.abilities, runtime_live: over.live ?? true } } as typeof driver.info; return driver; } } });
  return { f, driver: () => driver };
}
const data = async (f: ReturnType<typeof fixture>, word: string, body: unknown, who = undefined as ReturnType<typeof caller> | undefined): Promise<any> => ((await (who ? f.service(word, body, who) : f.service(word, body)))!.data);

test("runtime.catalog: providers with ready flag, auth, what to do when not ready; a big list is not listed until asked for; search and provider narrow it", async () => {
  const { f } = setup({ secrets: { DEEPSEEK_API_KEY: "sk-x" } });
  await f.start();
  const out = await data(f, "runtime.catalog", { agent: M });
  assert.equal(out.runtime, "dsh");
  assert.deepEqual(out.saved, { kind: "dsh" });
  assert.deepEqual(out.effective, { model: "deepseek/flash" });
  assert.deepEqual(out.catalog, { checked_at: 1_700_000_100_000, upstream_at: 1_700_000_000_000, refreshing: false }, "how new the lists are");
  const by = Object.fromEntries(out.providers.map((p: any) => [p.id, p]));
  assert.equal(by.deepseek.ready, true);
  assert.deepEqual(by.deepseek.auth, { kind: "key", ref: "DEEPSEEK_API_KEY", configured: true });
  assert.equal(by.deepseek.how, undefined);
  assert.deepEqual(by.deepseek.models.map((m: any) => m.id), ["deepseek/flash", "deepseek/plain"]);
  assert.deepEqual(by.deepseek.models[0].efforts, ["off", "low", "high"]);
  assert.equal(by.codex.ready, false);
  assert.equal(by.codex.needs_proxy, true);
  assert.deepEqual(by.codex.auth, { kind: "login", method: "browser", state: "none" });
  assert.equal(by.codex.how, "Ask the owner to log in.");
  assert.equal(by.openrouter.ready, false);
  assert.match(by.openrouter.how, /Only the owner can save it.*幕后 → 密钥/);
  assert.deepEqual(by.openrouter.models, []);
  assert.equal(by.openrouter.models_total, 25);
  assert.match(by.openrouter.models_hidden, /provider: "openrouter"/);
  assert.equal(out.notes.length, 2, "one note per provider that is not ready");
  assert.match(out.usage, /service:agents\/update/);

  const only = await data(f, "runtime.catalog", { agent: M, provider: "openrouter" });
  assert.deepEqual(only.providers.map((p: any) => p.id), ["openrouter"]);
  assert.equal(only.providers[0].models.length, 25);
  const searched = await data(f, "runtime.catalog", { agent: M, provider: "openrouter", search: "M1" });
  assert.deepEqual(searched.providers[0].models.map((m: any) => m.id).sort(), ["openrouter/v/m1", "openrouter/v/m10", "openrouter/v/m11", "openrouter/v/m12", "openrouter/v/m13", "openrouter/v/m14", "openrouter/v/m15", "openrouter/v/m16", "openrouter/v/m17", "openrouter/v/m18", "openrouter/v/m19"]);
  await assert.rejects(f.service("runtime.catalog", { agent: M, provider: "nope" }), code("bad_request"));
});

test("runtime.catalog: once the key is saved and the login is done, the providers are ready", async () => {
  const { f, driver } = setup();
  await f.start();
  f.secrets.OPENROUTER_API_KEY = "sk-or";
  driver().login = "ready";
  const out = await data(f, "runtime.catalog", { agent: M });
  const by = Object.fromEntries(out.providers.map((p: any) => [p.id, p]));
  assert.equal(by.openrouter.ready, true);
  assert.equal(by.codex.ready, true);
  assert.equal(by.deepseek.ready, false, "no DeepSeek key was saved");
  assert.equal(by.openrouter.models.length, 0, "ready or not, a big list waits for being asked");
});

test("runtimes without a catalog get a plain list from the models they report", async () => {
  const f = fixture();
  await f.start();
  f.driver().info = { ...f.driver().info, models: [{ id: "deepseek-flash", efforts: ["low", "high"] }] } as never;
  const out = await data(f, "runtime.catalog", { agent: M });
  assert.equal(out.providers.length, 1);
  assert.equal(out.providers[0].ready, true);
  assert.deepEqual(out.providers[0].models.map((m: any) => [m.id, m.efforts]), [["deepseek-flash", ["low", "high"]]]);
});

test("update with a runtime patch: merged over the declaration (kind may be left out, models merged model by model, null forgets), checked against the catalog, and saved", async () => {
  const { f } = setup({ secrets: { DEEPSEEK_API_KEY: "k" } });
  await f.start();
  const saved = () => f.agents.manager.run(M).spec.decl.runtime;
  await f.service("update", { agent: M, runtime: { model: "deepseek/flash", models: { "deepseek/flash": { effort: "high" } } } });
  assert.deepEqual(saved(), { kind: "dsh", model: "deepseek/flash", models: { "deepseek/flash": { effort: "high" } } });
  await f.service("update", { agent: M, runtime: { models: { "codex/gpt": { effort: "low" }, "deepseek/flash": { effort: "off" } } } });
  assert.deepEqual(saved().models, { "codex/gpt": { effort: "low" }, "deepseek/flash": { effort: "off" } });
  assert.equal(saved().model, "deepseek/flash", "the model stays when the patch does not name one");
  await f.service("update", { agent: M, runtime: { effort: "low", models: { "codex/gpt": null } } });
  assert.deepEqual(saved(), { kind: "dsh", model: "deepseek/flash", effort: "low", models: { "deepseek/flash": { effort: "off" } } });
  // a model of a provider that is not ready is allowed, with a note saying what is missing
  const noted = await data(f, "update", { agent: M, runtime: { model: "codex/gpt" } });
  assert.match(noted.notes.join(" "), /Codex is not ready: Ask the owner to log in\. Until then the agent runs on the fallback model/);
  // what was saved is what describe says, and it survives the module being read again
  assert.equal((await data(f, "describe", { agent: M })).runtime.model, "codex/gpt");
});

test("update refuses a model the runtime does not have and an effort the model does not take, with what to choose from; nothing is saved", async () => {
  const { f } = setup();
  await f.start();
  const before = JSON.stringify(f.agents.manager.run(M).spec.decl.runtime);
  await assert.rejects(f.service("update", { agent: M, runtime: { model: "nope/x" } }), (e: any) => e.code === "bad_request" && /providers: deepseek, codex, openrouter/.test(e.message) && /runtime\.catalog/.test(e.message));
  await assert.rejects(f.service("update", { agent: M, runtime: { model: "deepseek/flash", effort: "ultra" } }), (e: any) => e.code === "bad_request" && /choose one of off, low, high/.test(e.message));
  await assert.rejects(f.service("update", { agent: M, runtime: { models: { "deepseek/plain": { effort: "high" } } } }), (e: any) => e.code === "bad_request" && /does not take an effort/.test(e.message));
  await assert.rejects(f.service("update", { agent: M, runtime: { effort: "high" } }), (e: any) => e.code === "bad_request" && /needs runtime\.model/.test(e.message));
  await assert.rejects(f.service("update", { agent: M, runtime: { models: { "deepseek/flash": { speed: "fast" } } } }), code("bad_request"));
  await assert.rejects(f.service("update", { agent: M, runtime: "pi" }), code("bad_request"));
  assert.equal(JSON.stringify(f.agents.manager.run(M).spec.decl.runtime), before);
  // an OpenRouter model the list does not have is tried as given, with a note
  const out = await data(f, "update", { agent: M, runtime: { model: "openrouter/brand/new-model" } });
  assert.match(out.notes.join(" "), /not in the catalog's list of OpenRouter models/);
});

test("a runtime change is taken live where the runtime can (configure {runtime}, no restart) and by a restart where it cannot; a change of kind restarts", async () => {
  const live = setup({ live: true });
  await live.f.start();
  await live.f.service("update", { agent: M, runtime: { model: "deepseek/flash", models: { "deepseek/flash": { effort: "high" } } } });
  const configured = live.driver().of("configure");
  assert.equal(configured.length, 1);
  assert.deepEqual((configured[0]![3] as { runtime: RuntimeSettings }).runtime, { kind: "dsh", model: "deepseek/flash", models: { "deepseek/flash": { effort: "high" } } });
  assert.equal(live.driver().of("stop").length, 0);
  await live.f.service("update", { agent: M, brief: "only the brief" });
  assert.equal(live.driver().of("configure").length, 1, "nothing about the runtime changed");

  const slow = setup({ live: false });
  await slow.f.start();
  const starts = slow.driver().of("start").length;
  await slow.f.service("update", { agent: M, runtime: { model: "deepseek/flash" } });
  assert.equal(slow.driver().of("configure").length, 0);
  assert.ok(slow.driver().of("start").length > starts || slow.driver().of("stop").length > 0, "a runtime that cannot take it live is started again");
});

test("an agent that is not the owner may update its own runtime like any field (the delegation rule is about tools and words)", async () => {
  const { f } = setup();
  await f.start();
  const out = await data(f, "update", { agent: M, runtime: { model: "deepseek/flash" } }, caller(M));
  assert.equal(out.runtime.model, "deepseek/flash");
});
