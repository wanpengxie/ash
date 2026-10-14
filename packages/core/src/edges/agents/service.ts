/**
 * `service:agents`: the words that declare, start, stop, ask and steer agents (HUB-MODULES §2.5). Thin: each word
 * checks who asks, then calls the manager.
 */
import { randomBytes } from "node:crypto";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { DriverMessage, ModuleId } from "../../../../sdk/src/driver";
import type { Member } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { agentCaller, SPAWN_TIMEOUT_S, staticHash, type AgentManager } from "./manager";
import { SERVICE_CALLER } from "./modules";
import { callerPower, MAX_DEPTH, withinPower } from "./policy";
import { DEFAULT_RUNTIME, lanesOf, mergeRuntime, readDecl, readRuntimePatch, type AgentDecl, type Run } from "./runs";
import type { CatalogModel, CatalogProvider, RuntimeCatalog, RuntimeSettings } from "../../../../sdk/src/driver";

export const AGENTS_ID = "service:agents";
const WORKER_MODULES: ModuleId[] = ["rules", "skills", "environment", "lane"];
const WORKER_BRIEF = "You are a temporary worker. Do the one task you are given, then answer with the result in that same turn.";
const FIELDS = ["name", "summary", "brief", "runtime", "native", "tools", "words", "lanes", "modules", "primary"] as const;

const data = (value: unknown): WordResult => ({ data: value });

export function createAgentsService(manager: AgentManager): Member {
  const { runs } = manager;

  /** The caller's own declaration when the caller is an agent. */
  const own = (ctx: HandleContext): AgentDecl | null => (ctx.caller.via === "agent" ? runs.get(ctx.caller.member)?.spec.decl ?? null : null);
  const power = (ctx: HandleContext) => callerPower(ctx.caller, own(ctx));
  const depthOf = (ctx: HandleContext) => own(ctx)?.depth ?? -1;

  const info = (run: Run) => {
    const d = run.spec.decl;
    const state = manager.stateOf(run.id);
    return {
      id: run.id, name: d.name, summary: d.summary, state, available: state === "idle" || state === "working", reachable: manager.reachable(run.id), primary: !!d.primary, ephemeral: !!d.ephemeral,
      brief: d.brief, runtime: d.runtime, ...(d.native ? { native: d.native } : {}), created_by: d.created_by,
      tools: d.tools ?? null, words: d.words ?? null, lanes: lanesOf(d), modules: d.modules ?? null,
    };
  };

  function checkPower(ctx: HandleContext, decl: AgentDecl): void {
    const problem = withinPower(power(ctx), decl);
    if (problem) throw new WordError("forbidden", problem);
  }

  function pick(body: Record<string, any>): Partial<AgentDecl> {
    return Object.fromEntries(FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
  }

  // -- declarations ------------------------------------------------------------------------------------------------

  async function declare(body: Record<string, any>, ctx: HandleContext): Promise<WordResult> {
    const depth = ctx.caller.via === "agent" ? depthOf(ctx) + 1 : 0;
    if (depth > MAX_DEPTH) throw new WordError("forbidden", `delegation goes at most ${MAX_DEPTH} levels deep`);
    const decl = readDecl(body, ctx.caller.member, depth);
    if (runs.get(decl.id)) throw new WordError("conflict", `${decl.id} is already declared; use update`);
    if (decl.primary && runs.primary()) throw new WordError("conflict", "there is a primary agent already; use primary.set to hand it over");
    checkPower(ctx, decl);
    await checkRuntime(decl.id, decl.runtime);
    runs.put({ id: decl.id, spec: { decl, sessions: {}, static_hash: {}, usage_since: 0 } });
    await manager.startAgent(decl.id, "新建").catch((e) => manager.deps.log?.("agents: start after declare:", e));
    return data(info(runs.get(decl.id)!));
  }

  async function update(body: Record<string, any>, ctx: HandleContext): Promise<WordResult> {
    const run = manager.run(body.agent);
    if (body.primary !== undefined && !!body.primary !== !!run.spec.decl.primary) throw new WordError("bad_request", "primary is handed over with primary.set");
    const before = run.spec.decl;
    const { runtime: _asked, ...rest } = pick(body);
    const decl: AgentDecl = { ...before, ...rest };
    let notes: string[] = [];
    if (body.runtime !== undefined) {
      decl.runtime = mergeRuntime(before.runtime, readRuntimePatch(body.runtime));
      notes = await checkRuntime(run.id, decl.runtime);
    }
    if (before.primary) decl.primary = true; else delete decl.primary;
    checkPower(ctx, decl);
    runs.put({ id: run.id, spec: { ...run.spec, decl }, desired: run.desired });
    const sameKind = before.runtime.kind === decl.runtime.kind;
    const placeMoved = JSON.stringify([before.native, Object.keys(lanesOf(before))]) !== JSON.stringify([decl.native, Object.keys(lanesOf(decl))]);
    const runtimeChanged = JSON.stringify(before.runtime) !== JSON.stringify(decl.runtime);
    const live = manager.liveOf(run.id);
    if (live && (placeMoved || !sameKind)) await manager.restartAgent(run.id);
    else if (live && runtimeChanged) {
      // A runtime that takes its settings between turns is told; any other starts again with them.
      if (live.driver.info.abilities.runtime_live) await live.driver.configure(live.id, undefined, { runtime: decl.runtime });
      else await manager.restartAgent(run.id);
    }
    return data({ ...info(runs.get(run.id)!), ...(notes.length ? { notes } : {}) });
  }

  // -- what a runtime can use --------------------------------------------------------------------------------------

  const BIG_LIST = 20;
  const KEY_HOW = (ref: string) => `No key is saved (vault ${ref}). Make one in the provider's console (in the owner's Chrome, where he is signed in) and store it with service:vault/put {ref: "${ref}"}; if you cannot, ask him with service:vault/request {ref: "${ref}", replace: true}: his card opens the keys page. Read this catalog again once it is stored.`;

  /** The catalog of a runtime kind: the driver's own, or a plain list built from the models the runtime reports. */
  async function catalogOf(agent: string, saved: RuntimeSettings, full: boolean): Promise<RuntimeCatalog> {
    const driver = manager.driver(saved.kind);
    if (driver.catalog) return driver.catalog(agent, saved, { full });
    const models: CatalogModel[] = driver.info.models.map((m) => ({ id: m.id, name: m.id, images: false, reasoning: (m.efforts ?? []).length > 0, efforts: m.efforts ?? [] }));
    return { providers: [{ id: saved.kind, name: saved.kind, needs_proxy: false, auth: { kind: "none" }, models }] };
  }

  function providerReady(p: CatalogProvider): { ready: boolean; auth: Record<string, unknown>; how?: string } {
    const a = p.auth;
    if (a.kind === "key") {
      const configured = !!manager.deps.vault.use(a.ref);
      return { ready: configured, auth: { kind: "key", ref: a.ref, configured }, ...(configured ? {} : { how: KEY_HOW(a.ref) }) };
    }
    if (a.kind === "login") return { ready: a.state === "ready", auth: { kind: "login", method: a.method, state: a.state }, ...(a.state === "ready" ? {} : { how: a.how }) };
    return { ready: true, auth: { kind: "none" } };
  }

  /** Mistakes in a declaration's runtime that the runtime's catalog can tell (an unknown model, an effort the model does not take), and what is still missing for it to work. */
  async function checkRuntime(agent: string, runtime: RuntimeSettings): Promise<string[]> {
    if (!manager.kinds().includes(runtime.kind)) return [];
    const driver = manager.driver(runtime.kind);
    if (!driver.catalog) return [];
    const catalog = await driver.catalog(agent, runtime, { full: true });
    const byId = new Map<string, CatalogModel>();
    for (const p of catalog.providers) for (const m of p.models) byId.set(m.id, m);
    const providerIds = catalog.providers.map((p) => p.id);
    const problems: string[] = [];
    const notes: string[] = [];
    const check = (model: string, effort: string | undefined, where: string) => {
      const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : "";
      const known = byId.get(model);
      if (!known) {
        if (provider === "openrouter") notes.push(`${model}: not in the catalog's list of OpenRouter models; it is tried as given.`);
        else problems.push(`${where}: ${JSON.stringify(model)} is not a model of the ${runtime.kind} runtime. Models are written provider/model; providers: ${providerIds.join(", ")}. Read service:agents/runtime.catalog for the list.`);
        return;
      }
      if (effort !== undefined) {
        if (!known.efforts.length) problems.push(`${where}: ${model} does not take an effort (it does not think).`);
        else if (!known.efforts.includes(effort)) problems.push(`${where}: effort ${JSON.stringify(effort)} is not one ${model} takes; choose one of ${known.efforts.join(", ")}.`);
      }
    };
    if (runtime.model) check(runtime.model, runtime.effort, "runtime.model");
    else if (runtime.effort) problems.push("runtime.effort needs runtime.model (the effort belongs to a model).");
    for (const [model, settings] of Object.entries(runtime.models ?? {})) check(model, settings.effort, `runtime.models[${model}]`);
    if (problems.length) throw new WordError("bad_request", problems.join(" "));
    for (const model of new Set([runtime.model, ...Object.keys(runtime.models ?? {})].filter((m): m is string => !!m))) {
      const provider = catalog.providers.find((p) => p.models.some((m) => m.id === model) || model.startsWith(`${p.id}/`));
      if (!provider) continue;
      const state = providerReady(provider);
      if (!state.ready && model === runtime.model) notes.push(`${provider.name} is not ready: ${state.how ?? "not available"} Until then the agent runs on the fallback model.`);
    }
    return notes;
  }

  async function runtimeCatalog(body: Record<string, any>): Promise<WordResult> {
    const run = manager.run(body.agent);
    const saved = run.spec.decl.runtime;
    const catalog = await catalogOf(run.id, saved, false);
    const search = typeof body.search === "string" ? body.search.toLowerCase() : "";
    const only = typeof body.provider === "string" ? body.provider : "";
    const providers = catalog.providers.filter((p) => !only || p.id === only).map((p) => {
      const state = providerReady(p);
      const asked = only === p.id;
      let models = p.models.filter((m) => !search || m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search));
      const hidden = models.length > BIG_LIST && !asked && !search;
      if (hidden) models = [];
      return {
        id: p.id, name: p.name, ready: state.ready, needs_proxy: p.needs_proxy, auth: state.auth, ...(state.how ? { how: state.how } : {}),
        models_total: p.models.length, ...(hidden ? { models_hidden: `${p.models.length} models: ask with provider: ${JSON.stringify(p.id)} (and search) to list them` } : {}),
        models,
      };
    });
    if (only && !providers.length) throw new WordError("bad_request", `${saved.kind} has no provider ${only}; providers: ${catalog.providers.map((p) => p.id).join(", ")}`);
    const notes = providers.filter((p) => !p.ready).map((p) => `${p.name}: ${p.how ?? "not ready"}`);
    return data({
      agent: run.id, runtime: saved.kind, saved, ...(catalog.effective ? { effective: catalog.effective } : {}), ...(catalog.source ? { catalog: catalog.source } : {}), providers, ...(notes.length ? { notes } : {}),
      usage: 'Choose with service:agents/update {agent, runtime: {model: "provider/model", models: {"provider/model": {effort: "<one of the model\'s efforts>"}}}}; only ready providers work now.',
    });
  }

  async function remove(id: string): Promise<WordResult> {
    const run = manager.run(id);
    if (run.spec.decl.primary) throw new WordError("conflict", "the primary agent cannot be removed; hand primary to another agent first");
    await manager.forget(id, "removed");
    return data({ removed: true });
  }

  async function spawn(body: Record<string, any>, ctx: HandleContext): Promise<WordResult> {
    const parent = own(ctx);
    const depth = ctx.caller.via === "agent" ? (parent?.depth ?? 0) + 1 : 1;
    if (depth > MAX_DEPTH) throw new WordError("forbidden", `delegation goes at most ${MAX_DEPTH} levels deep`);
    const template = body.template ? (manager.deps.templates.read(String(body.template)) as Record<string, any> | null) : {};
    if (!template) throw new WordError("not_found", `no such template: ${body.template}`);
    const id = `agent:w-${randomBytes(3).toString("hex")}`;
    const runtime = { ...(template.runtime ?? { kind: DEFAULT_RUNTIME }), ...(body.runtime ?? {}), ...(body.model ? { model: body.model } : {}) };
    const decl = readDecl({
      id, name: `w-${id.slice(8)}`, summary: String(body.task).slice(0, 80), brief: template.brief ?? WORKER_BRIEF, runtime,
      native: body.native ?? template.native ?? { on: "body:main" },
      // What the worker may do is what was asked for, or else what the caller can do itself: never more.
      tools: body.tools ?? template.tools ?? parent?.tools, words: template.words ?? parent?.words,
      lanes: { work: { from: ["*"], speak: false } }, modules: template.modules ?? WORKER_MODULES, ephemeral: true,
    }, ctx.caller.member, depth);
    checkPower(ctx, decl);
    const answer = await manager.runWorker(decl, String(body.task), ctx.caller.member, Number(body.timeout) || SPAWN_TIMEOUT_S);
    return data({ answer, agent: id });
  }

  // -- sessions ----------------------------------------------------------------------------------------------------

  async function session(word: string, body: Record<string, any>): Promise<WordResult> {
    const live = manager.running(body.agent);
    const driver = live.driver;
    const id = live.id;
    if (word === "restart") { await manager.restartAgent(id); return data({ restarted: true }); }
    const lane = manager.lane(live, body.key);
    const key = lane.key;
    const stored = () => runs.get(id)?.spec.sessions[key] ?? null;
    const idle = () => { if (lane.busy) throw new WordError("conflict", "busy: the agent is in a turn on this lane"); };
    const batch = (): DriverMessage[] => (body.messages as { text: string; from?: string }[]).map((m) => ({ id: manager.newId(), from: m.from ?? SERVICE_CALLER.member, word: word === "send" ? "session.send" : "session.followup", text: m.text, lane: key, at: manager.now() }));
    switch (word) {
      case "get": return data({ key, handle: driver.session.get(id, key) ?? stored() });
      case "set":
        await driver.session.set(id, key, body.handle);
        runs.patch(id, (spec) => { spec.sessions[key] = body.handle; });
        manager.forgetInjected(lane);
        return data({ key, handle: body.handle });
      case "new": {
        idle();
        const { handle } = await driver.session.new(id, key);
        const hash = staticHash(await manager.modules.static(runs.get(id)!.spec.decl));
        runs.patch(id, (spec) => { spec.sessions[key] = handle; spec.static_hash[key] = hash; });
        manager.forgetInjected(lane);
        return data({ key, handle });
      }
      case "reload": {
        if (lane.busy) { lane.reloadPending = true; return data({ key, handle: driver.session.get(id, key) ?? stored() }); }
        const out = await manager.reloadLane(live, lane);
        return data({ key, handle: out.handle });
      }
      case "compact": {
        if (lane.busy) { lane.compactPending = true; return data({ compacted: false, detail: "the agent is in a turn; it is compacted when the turn ends" }); }
        try { return data(await driver.session.compact(id, key)); } catch (error) {
          if (error instanceof WordError && error.code === "conflict") { lane.compactPending = true; return data({ compacted: false, detail: "busy; compacted when the turn ends" }); }
          // A runtime that cannot compact gets a new session instead; what it needs comes back through the dynamic modules and the ledger.
          if (error instanceof WordError && error.code === "unavailable") {
            const { handle } = await driver.session.new(id, key);
            runs.patch(id, (spec) => { spec.sessions[key] = handle; });
            manager.forgetInjected(lane);
            return data({ compacted: false, detail: "this runtime cannot compact; a new session was opened instead" });
          }
          throw error;
        }
      }
      case "send": idle(); await driver.send(id, key, batch()); return data({ accepted: true });
      case "followup": await driver.followup(id, key, batch()); return data({ accepted: true });
      case "steer": return data({ accepted: await driver.steer(id, key, body.text) });
      case "inject": {
        if (body.text) await driver.inject(id, key, { text: body.text });
        if (body.modules) await injectNamed(live, lane, body.modules);
        return data({ accepted: true });
      }
      case "interrupt": if (!lane.busy) return data({ interrupted: false }); await driver.interrupt(id, key); return data({ interrupted: true });
    }
    throw new WordError("bad_request", `unknown session word ${word}`);
  }

  /** `inject {modules: [names]}`: put those modules in now, changed or not. */
  async function injectNamed(live: ReturnType<AgentManager["running"]>, lane: ReturnType<AgentManager["lane"]>, names: string[]): Promise<void> {
    const decl = runs.get(live.id)!.spec.decl;
    const wanted = new Set(names);
    const modules = (await manager.modules.dynamic(decl, lane.key)).filter((m) => wanted.has(m.id));
    if (modules.length) await live.driver.inject(live.id, lane.key, { modules });
    for (const m of modules) lane.injected.set(m.id, m.version);
  }

  // -- the words ---------------------------------------------------------------------------------------------------

  async function handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const body = (ctx.raw && typeof ctx.raw === "object" ? ctx.raw : msg.body ?? {}) as Record<string, any>;
    const word = msg.word;
    if (word.startsWith("session.")) return session(word.slice(8), body);
    switch (word) {
      case "list": return data({ agents: runs.list().map(info) });
      case "runtimes": return data({ runtimes: manager.kinds().map((k) => manager.driver(k).info) });
      case "describe": return data(info(manager.run(body.agent)));
      case "runtime.catalog": return runtimeCatalog(body);
      case "declare": return declare(body, ctx);
      case "update": return update(body, ctx);
      case "start": manager.run(body.agent); manager.runs.setDesired(body.agent, "on"); await manager.startAgent(body.agent, "启动"); return data(info(manager.run(body.agent)));
      case "stop":
        await manager.stopAgent(manager.run(body.agent).id, "stopped"); return data(info(manager.run(body.agent)));
      case "restart": manager.run(body.agent); await manager.restartAgent(body.agent); return data(info(manager.run(body.agent)));
      case "remove": return remove(body.agent);
      case "primary.set":
        manager.run(body.agent);
        runs.setPrimary(body.agent);
        return data(info(manager.run(body.agent)));
      case "ask": case "tell": {
        manager.running(body.agent);
        const target = manager.run(body.agent).spec.decl;
        const lane = manager.laneFor(target, msg.from, word, "request");
        const row = { id: msg.id, from: msg.from, word, text: String(body.text), attachments: [], at: msg.ts, ...(msg.thread ? { thread: msg.thread } : {}) };
        if (word === "tell") { manager.enqueue(body.agent, row, lane); return data({ sent: true, message_id: msg.id }); }
        const answer = manager.expect(body.agent, msg.id, msg.from, ctx.signal);
        manager.enqueue(body.agent, row, lane);
        return data({ agent: body.agent, answer: await answer });
      }
      case "answer": return answer(body, ctx);
      case "threads": return data({ threads: manager.threads().map((w) => ({ thread: w.id, from: w.from, to: w.agent, since: w.since })) });
      case "thread.stop": {
        const w = manager.waiter(body.thread);
        if (!w) return data({ cancelled: false });
        const live = manager.liveOf(w.agent);
        const turn = manager.inbox.get(w.id)?.turn;
        manager.rejectWaiter(w.id, new WordError("cancelled", "the owner stopped this thread"));
        if (live && turn) for (const lane of live.lanes.values()) if (lane.turn === turn) await live.driver.interrupt(live.id, lane.key);
        return data({ cancelled: true });
      }
      case "configure": {
        const live = manager.running(body.agent);
        return data({ config: await live.driver.configure(live.id, body.key, body.config) });
      }
      case "plugins": {
        const live = manager.running(body.agent);
        return data(await live.driver.plugins(live.id, body.op, body.name));
      }
      case "spawn": return spawn(body, ctx);
      case "vault.changed": await manager.onVaultChanged(String(body.ref), String(body.action)); return;
      case "settings.changed": if (Array.isArray(body.keys) && body.keys.includes("paused")) await manager.refreshPaused(); return;
      case "env.changed":
        if (body.what === "network") {
          if (body.network) manager.onNetwork(body.network);
          if (body.online !== false) manager.retryNow(); // an agent that waits for its next start try need not wait for the clock
        }
        return;
    }
    throw new WordError("not_found", `service:agents has no word ${word}`);
  }

  /** An agent's own words in the turn that took a question or news. */
  async function answer(body: Record<string, any>, ctx: HandleContext): Promise<WordResult> {
    const row = manager.inbox.get(body.in_reply_to);
    if (!row || row.agent !== ctx.caller.member) throw new WordError("not_found", "no such message was delivered to you");
    if (manager.settle(row.id, String(body.text))) return data({ accepted: true });
    // News (tell): what the agent says back goes to the sender as a message of its own.
    if (row.from.startsWith("agent:") && row.from !== row.agent)
      await manager.deps.router.send({ to: row.from, kind: "request", word: "tell", body: { text: String(body.text) }, ...(row.thread ? { thread: row.thread } : {}) }, agentCaller(row.agent, ctx.caller.turn));
    return data({ accepted: true });
  }

  return {
    id: AGENTS_ID, kind: "service", name: "agents", listens: ["vault.changed", "settings.changed"],
    words: () => wordsOf(AGENTS_ID),
    handle,
  };
}
