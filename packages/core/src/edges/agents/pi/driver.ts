/**
 * The pi driver (SPEC-08 §2): pi (https://github.com/earendil-works/pi) as an agent runtime next to DSH. pi is spoken to in its
 * RPC mode (JSON lines on stdin/stdout, see `rpc.ts`). Everything pi-specific is in this folder; the agents module sees an
 * ordinary `AgentDriver`.
 *
 * Processes are held per turn, not per agent. A pi process has one session, and an agent has several lanes, so keeping one
 * process per lane would be a hundred and thirty megabytes each, for lanes that are idle nearly all the time:
 *   - the `front` lane (the owner's conversation) has a slot of its own: the process of the session being talked in, kept warm
 *     for `hotMs` after a turn and then ended;
 *   - every other lane of every agent shares one slot, a turn at a time, in the order they came. A new turn on a different
 *     session ends the process and starts one on that session (`--session-id` picks the session up again from its file); the
 *     same session twice in a row reuses the warm process.
 * So there are at most two pi processes, and none while nothing is going on. `start` starts nothing: it records the
 * agent's lanes, tokens and modules. A process that dies fails the turn it was in (`turn.ended` with `error`), never the agent
 * (no `ended`, which would make the agents module restart the whole agent).
 *
 * DeepSeek is the default model and needs nothing: no login, no proxy, no probe (the key is the one DSH uses). A Codex model is used only
 * once the owner has logged in; the way to it is chosen when a process is taken (`route.ts`): v2rayA's proxy if it answers, else straight out
 * (the phone's VPN is on), else nothing, and then this turn goes to DeepSeek, which is always direct. A network error in a turn is checked the
 * same way and, when the way is really shut, the session goes on with DeepSeek (`set_model`: the history stays) and the owner is told;
 * while it is on DeepSeek the way is tried again every minute, and the session goes back when it is open. Codex's login is a
 * `configure` of the driver (see `configure`).
 *
 * How the contract's operations map:
 *   send / followup   prompt (a followup waits in the driver until the turn ends)   steer      steer
 *   interrupt         abort                                                         compact    compact (on the lane's slot, briefly)
 *   session.new       a new session id (--session-id)                              configure  set_model, set_thinking_level; login; read-back
 */
import { randomBytes } from "node:crypto";
import { localStamp } from "../../../../../sdk/src/time";
import { WordError } from "../../../../../sdk/src/message";
import type { AgentDriver, AgentEvent, AgentStartSpec, AgentStatus, CatalogModel, CatalogOptions, CatalogProvider, DriverMessage, PromptModule, RuntimeCatalog, RuntimeInfo, RuntimeSettings } from "../../../../../sdk/src/driver";
import type { DriverProcess, SpawnFn } from "../dsh/acp";
import { toolSummary } from "../dsh/tool-label";
import { PiRpc, type PiRecord } from "./rpc";
import { AUTH_ERROR, DEFAULT_PROXY_URL, NETWORK_ERROR, chooseRoute, probeDirect, probeProxy, type Route } from "./route";

/** `pi` is a name the main body resolves: /opt/pi/... in the container, the machine's own pi in development. */
export const PI_ARGV = ["pi", "--mode", "rpc", "--no-approve"];
/** Ash's helper for Codex's login (`packages/pi-login`), as the container carries it. */
export const LOGIN_ARGV = ["node", "/opt/ash/pi-login/index.mjs"];
export const BASELINE_FILE = "AGENTS.md";
/** The model of a fresh pi agent, and where a Codex model goes when the way to it is shut. */
export const DEFAULT_MODEL = "deepseek/deepseek-flash";
export const CODEX_PROVIDER = "openai-codex";
/**
 * The providers Ash offers on pi. `key`: the vault key the provider needs; `login`: it needs the owner's login (Codex); `proxy`: it is
 * reached through v2rayA or the phone's VPN. The others are reached directly. The models of each come from pi's own tables (`packages/pi-login`).
 */
const PROVIDERS: Record<string, { name: string; key?: string; login?: boolean; proxy?: boolean }> = {
  deepseek: { name: "DeepSeek", key: "DEEPSEEK_API_KEY" },
  openrouter: { name: "OpenRouter", key: "OPENROUTER_API_KEY" },
  [CODEX_PROVIDER]: { name: "OpenAI Codex（ChatGPT 订阅）", login: true, proxy: true },
};
const DIRECT_HOSTS = "api.deepseek.com,.deepseek.com";
const LOOPBACK = "127.0.0.1,localhost,::1";
const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const KEY_ENV: Record<string, string> = { DEEPSEEK_API_KEY: "DEEPSEEK_API_KEY", OPENROUTER_API_KEY: "OPENROUTER_API_KEY" };

export const PI_INFO: RuntimeInfo = {
  kind: "pi", version: "1",
  models: [{ id: "deepseek/deepseek-flash" }, { id: "deepseek/deepseek-v4-pro" }, { id: "openai-codex/gpt-5.5" }, { id: "openai-codex/gpt-6-sol" }],
  abilities: { resume: true, steer: true, inject_live: false, images: true, compact: true, configure: ["model", "effort", "login", "runtime", "*"], plugins: false, mcp: true, system_prompt: "file", credentials: true, usage: false, runtime_live: true },
};

export interface PiDriverDeps {
  report(event: AgentEvent): void;
  spawn: SpawnFn;
  /** Write a file on the main body (the baseline instruction file, pi's MCP configuration). */
  writeFile(path: string, content: string): Promise<void>;
  readBlob?(ref: string): { bytes: Uint8Array; mime: string } | null;
  argv?: string[];
  loginArgv?: string[];
  /** The place a body path is for the runtime itself. Absent: the path as it is (the container). */
  runtimePath?(cwd: string): string;
  timeZone?(): string;
  log?(...args: unknown[]): void;
  /** v2rayA's HTTP proxy. */
  proxyUrl?: string;
  /** Is this way open? (tests give their own; the default knocks on the proxy and on OpenAI's host). */
  probe?(route: "proxy" | "direct"): Promise<boolean>;
  /** The model a shut way falls back to. */
  fallbackModel?: string;
  /** How long a process stays warm after its turn. */
  hotMs?: number;
  /** How often a shut way is tried again while the session is on the fallback. */
  recoverMs?: number;
  /** How long a probe's answer is trusted. */
  routeTtlMs?: number;
  /** How old the model tables may get before they are asked for again from upstream (pi.dev), and how often while the hub runs. */
  catalogRefreshMs?: number;
  /** After a refresh that got nothing, how long before a read of the catalog tries again. */
  catalogRetryMs?: number;
  /** How long after an agent starts the tables are first looked at (so a start does not wait for it). */
  catalogStartDelayMs?: number;
}

type Fallback = { reason: "network" | "login" | "key" };
interface Lane { key: string; session: string; turn?: Turn; followups: DriverMessage[]; held: string[] }
interface Agent {
  id: string; spec: AgentStartSpec; cwd: string; lanes: Map<string, Lane>;
  /** The declaration's runtime settings: what is lasting. */
  saved: RuntimeSettings;
  /** What a temporary `configure` changed (forgotten when the declaration is changed): the model, and efforts by model. */
  temp: { model?: string; efforts: Record<string, string> };
  fallback: Fallback | null; recover?: NodeJS.Timeout;
}
interface Turn {
  id: string; ag: Agent; lane: Lane; batch: DriverMessage[]; state: "queued" | "running"; cancelled: boolean; dropped: boolean;
  /** A piece of work on the slot that is not a turn (compact): it reports nothing. */
  job?: (proc: Proc) => Promise<unknown>; done?: { resolve(v: unknown): void; reject(e: unknown): void };
  proc?: Proc;
}
interface Proc { rpc: PiRpc; agentId: string; laneKey: string; session: string; route: Route; model: string; effort?: string; busy: boolean; hot?: NodeJS.Timeout }
interface Slot { name: "front" | "shared"; queue: Turn[]; current?: Turn; proc?: Proc }

const errorText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const dirOf = (cwd: string) => cwd.replace(/\/+$/, "");
const sessionId = () => `s_${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;

/** `provider/id`, or a bare id (deepseek-* is DeepSeek, anything else Codex), or DSH's JSON pair `["provider","model"]`. */
export function normalizeModel(model?: string): string {
  const m = (model ?? "").trim();
  if (!m) return DEFAULT_MODEL;
  if (m.startsWith("[")) {
    try { const pair = JSON.parse(m); if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") return `${pair[0]}/${pair[1]}`; } catch { /* not a pair */ }
  }
  if (m.includes("/")) return m;
  return /^deepseek/i.test(m) ? `deepseek/${m}` : `${CODEX_PROVIDER}/${m}`;
}
const split = (model: string): { provider: string; id: string } => { const i = model.indexOf("/"); return { provider: model.slice(0, i), id: model.slice(i + 1) }; };
const providerOf = (model: string) => PROVIDERS[split(model).provider];
const needsRoute = (model: string): boolean => providerOf(model)?.proxy === true;
/** The generic list of thinking levels, for when pi\'s own tables cannot be read. */
const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function createPiDriver(deps: PiDriverDeps): AgentDriver {
  const log = deps.log ?? (() => {});
  const report = deps.report;
  const argv = deps.argv ?? PI_ARGV;
  const loginArgv = deps.loginArgv ?? LOGIN_ARGV;
  const proxyUrl = deps.proxyUrl ?? DEFAULT_PROXY_URL;
  const fallbackModel = normalizeModel(deps.fallbackModel ?? DEFAULT_MODEL);
  const hotMs = deps.hotMs ?? 60_000;
  const recoverMs = deps.recoverMs ?? 60_000;
  const routeTtlMs = deps.routeTtlMs ?? 15_000;
  const catalogRefreshMs = deps.catalogRefreshMs ?? 24 * 60 * 60 * 1000;
  const catalogRetryMs = deps.catalogRetryMs ?? 30 * 60 * 1000;
  const catalogStartDelayMs = deps.catalogStartDelayMs ?? 20_000;
  const probe = deps.probe ?? ((route: "proxy" | "direct") => (route === "proxy" ? probeProxy(proxyUrl) : probeDirect()));
  const runtimeDir = () => deps.runtimePath?.("/root/.pi/agent") ?? "/root/.pi/agent";

  const agents = new Map<string, Agent>();
  const slots: Record<"front" | "shared", Slot> = { front: { name: "front", queue: [] }, shared: { name: "shared", queue: [] } };
  /** The keys the hub gave (by name): they go to a process through its environment and are never written to a file. */
  const keys = new Map<string, string>();
  let routeCache: { at: number; route: Route } | null = null;
  let routeProbe: Promise<Route> | null = null;
  const login: { state: "none" | "pending" | "ready" | "unknown"; info?: Record<string, unknown>; child?: DriverProcess } = { state: "unknown" };

  // -- the way to the model ----------------------------------------------------------------------------------------

  /** Which way is open now. Probes are shared and trusted for a short while; `fresh` asks again. */
  function routeNow(fresh = false): Promise<Route> {
    if (!fresh && routeCache && Date.now() - routeCache.at < routeTtlMs) return Promise.resolve(routeCache.route);
    if (!routeProbe) {
      routeProbe = chooseRoute(probe).then((route) => { routeCache = { at: Date.now(), route }; return route; }).finally(() => { routeProbe = null; });
    }
    return routeProbe;
  }

  /** The model asked for: a temporary choice, else the declaration's. */
  const wantedModel = (ag: Agent): string => ag.temp.model ?? normalizeModel(ag.saved.model);
  /** The effort for a model: a temporary choice, else the model's own entry in the declaration, else the declaration's effort when it is for this model. */
  const effortFor = (ag: Agent, model: string): string | undefined =>
    ag.temp.efforts[model] ?? ag.saved.models?.[model]?.effort ?? (model === normalizeModel(ag.saved.model) ? ag.saved.effort : undefined);

  function notice(ag: Agent, words: string, key?: string): void { report({ event: "notice", agent: ag.id, ...(key ? { key } : {}), text: words }); }

  function enterFallback(ag: Agent, reason: Fallback["reason"]): void {
    if (ag.fallback?.reason === reason) return;
    ag.fallback = { reason };
    const name = providerOf(wantedModel(ag))?.name ?? "这个模型";
    if (reason === "network") {
      notice(ag, `连不上 ${split(wantedModel(ag)).provider === CODEX_PROVIDER ? "Codex" : name}（代理或网络不通），先用 DeepSeek 接着做；通了会自动切回来。`);
      watchRecovery(ag);
    } else if (reason === "key") {
      notice(ag, `${name} 的密钥还没配好，或者不对，先用 DeepSeek 接着做。在 幕后 → 密钥 里保存后会自动用上。`);
    } else {
      notice(ag, "Codex 还没登录，或登录已失效，先用 DeepSeek 接着做。要用 Codex 的话，让我帮你登录。");
    }
  }

  function leaveFallback(ag: Agent, words: string): void {
    if (!ag.fallback) return;
    ag.fallback = null;
    if (ag.recover) { clearInterval(ag.recover); ag.recover = undefined; }
    notice(ag, words);
  }

  /** While the session is on the fallback because the way was shut, try the way again every `recoverMs`. */
  function watchRecovery(ag: Agent): void {
    if (ag.recover) return;
    ag.recover = setInterval(() => {
      if (ag.fallback?.reason !== "network") { if (ag.recover) { clearInterval(ag.recover); ag.recover = undefined; } return; }
      routeNow(true).then((route) => { if (route !== "none") leaveFallback(ag, "Codex 又连上了，已切回。"); }).catch(() => {});
    }, recoverMs);
    ag.recover.unref();
  }

  /**
   * The model this agent's next turn runs on, and the way to it. A DeepSeek model needs neither a login nor a way: it is direct, and
   * v2rayA is not involved. A Codex model is used once the owner has logged in; before that the turn goes to DeepSeek (told once).
   * From then on the way is chosen as above, and a shut way sends the turn to DeepSeek.
   */
  async function plan(ag: Agent): Promise<{ model: string; route: Route }> {
    let model = wantedModel(ag);
    let route: Route = "none";
    const info = providerOf(model);
    if (info?.login) {
      if (!ag.fallback) {
        const state = login.state === "ready" ? "ready" : await loginStatus(ag);
        if (state === "none" || state === "pending") enterFallback(ag, "login");
        else {
          route = await routeNow();
          if (route === "none") enterFallback(ag, "network");
        }
      } else if (ag.fallback.reason === "network") {
        route = await routeNow();
        if (route !== "none") leaveFallback(ag, "Codex 又连上了，已切回。");
      }
    } else if (info?.key && split(model).provider !== split(fallbackModel).provider) {
      // A provider that needs a key the owner has not saved (OpenRouter): this turn goes to the fallback, told once; the key arriving ends it.
      if (!keys.has(info.key)) enterFallback(ag, "key");
      else if (ag.fallback?.reason === "key") leaveFallback(ag, `${info.name} 的密钥有了，已切回。`);
    }
    if (ag.fallback) { model = fallbackModel; route = "none"; }
    return { model, route };
  }

  // -- processes ---------------------------------------------------------------------------------------------------

  function envFor(ag: Agent, laneKey: string, route: Route): Record<string, string> {
    const env: Record<string, string> = {
      ...(ag.spec.native?.env ?? {}),
      PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: runtimeDir(),
      ASH_TOKEN: ag.spec.tools.tokens[laneKey] ?? "",
      NO_PROXY: `${LOOPBACK},${DIRECT_HOSTS}`, no_proxy: `${LOOPBACK},${DIRECT_HOSTS}`,
    };
    // Set in every case: what the hub puts in for the phone's own proxy must not reach pi.
    const proxy = route === "proxy" ? proxyUrl : "";
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env[k] = proxy;
    for (const [ref, name] of Object.entries(KEY_ENV)) { const v = keys.get(ref); if (v) env[name] = v; }
    return env;
  }

  async function closeProc(slot: Slot): Promise<void> {
    const p = slot.proc;
    if (!p) return;
    slot.proc = undefined;
    if (p.hot) clearTimeout(p.hot);
    if (!p.rpc.alive) return;
    const gone = new Promise<void>((resolve) => { p.rpc.onExit(() => resolve()); setTimeout(resolve, 5000).unref(); });
    p.rpc.close();
    await gone;
  }

  async function spawnProc(slot: Slot, ag: Agent, lane: Lane, route: Route, model: string): Promise<Proc> {
    const { provider, id } = split(model);
    const args = [...argv, "--session-id", lane.session, "--provider", provider, "--model", id];
    const child = deps.spawn(args, { env: envFor(ag, lane.key, route), cwd: ag.cwd });
    const rpc = new PiRpc(child, log);
    const p: Proc = { rpc, agentId: ag.id, laneKey: lane.key, session: lane.session, route, model, busy: false };
    slot.proc = p;
    rpc.onExit((reason) => {
      if (slot.proc === p) { slot.proc = undefined; if (p.hot) clearTimeout(p.hot); }
      if (!p.busy) log(`pi: ${ag.id}/${lane.key}: process ended (${reason})`);
    });
    try {
      await rpc.request({ type: "get_state" }, 90_000);
      await applyEffort(p, ag, model);
    } catch (error) {
      rpc.close();
      if (slot.proc === p) slot.proc = undefined;
      throw new WordError("failed", `pi did not start: ${errorText(error)}`);
    }
    return p;
  }

  /** The process for this turn: the warm one when it is the same session and way, else a new one. */
  async function acquire(slot: Slot, t: Turn): Promise<Proc> {
    const { ag, lane } = t;
    const { model, route } = await plan(ag);
    let p = slot.proc;
    const reusable = p && p.rpc.alive && !p.busy && p.agentId === ag.id && p.laneKey === lane.key && p.session === lane.session && p.route === route;
    if (reusable) { clearTimeout(p!.hot); }
    else { await closeProc(slot); p = await spawnProc(slot, ag, lane, route, model); }
    p = p!;
    p.busy = true;
    try {
      if (p.model !== model) await switchModel(p, model);
      await applyEffort(p, ag, model);
    } catch (error) { p.busy = false; throw error; }
    return p;
  }

  /** The thinking effort of the model in use, from the settings of that model; nothing to set means the model's own default stays. */
  async function applyEffort(p: Proc, ag: Agent, model: string): Promise<void> {
    const effort = effortFor(ag, model);
    if (!effort || p.effort === effort) return;
    await p.rpc.request({ type: "set_thinking_level", level: effort }).then(() => { p.effort = effort; }).catch((e) => log(`pi: effort ${effort}: ${errorText(e)}`));
  }

  async function switchModel(p: Proc, model: string): Promise<void> {
    const { provider, id } = split(model);
    await p.rpc.request({ type: "set_model", provider, modelId: id });
    p.model = model;
  }

  function release(slot: Slot, p: Proc): void {
    p.busy = false;
    if (!p.rpc.alive || slot.proc !== p) return;
    p.hot = setTimeout(() => { if (slot.proc === p && !p.busy) closeProc(slot).catch(() => {}); }, hotMs);
    p.hot.unref();
  }

  // -- turns -------------------------------------------------------------------------------------------------------

  const envelope = (m: DriverMessage) =>
    `[ash] ${localStamp(m.at, deps.timeZone?.())} · ${m.origin?.label ?? m.from} · lane ${m.lane} · ${m.word} · id ${m.id}${m.thread ? ` · thread ${m.thread}` : ""}`;

  function promptOf(lane: Lane, batch: DriverMessage[]): { message: string; images: unknown[] } {
    const parts: string[] = lane.held.splice(0);
    const images: unknown[] = [];
    for (const m of batch) {
      const notes: string[] = [];
      for (const a of m.attachments ?? []) {
        const blob = IMAGE.test(a.mime_type) ? deps.readBlob?.(a.ref) : null;
        if (blob) images.push({ type: "image", data: Buffer.from(blob.bytes).toString("base64"), mimeType: blob.mime });
        notes.push(`[attachment name=${JSON.stringify(a.name)} type=${a.mime_type} ref=${a.ref}]`);
      }
      parts.push([envelope(m), m.text, ...notes].join("\n"));
    }
    return { message: parts.join("\n\n"), images };
  }

  function enqueue(t: Turn): void {
    const slot = t.lane.key === "front" ? slots.front : slots.shared;
    t.lane.turn = t;
    slot.queue.push(t);
    pump(slot);
  }

  function pump(slot: Slot): void {
    if (slot.current) return;
    const t = slot.queue.shift();
    if (!t) return;
    slot.current = t;
    runTurn(slot, t).catch((e) => log(`pi: turn ${t.id}: ${errorText(e)}`)).finally(() => { slot.current = undefined; pump(slot); });
  }

  const alive = (t: Turn) => !t.dropped && agents.get(t.ag.id) === t.ag;

  async function runTurn(slot: Slot, t: Turn): Promise<void> {
    const { ag, lane } = t;
    if (!alive(t)) { finishLane(t); t.done?.reject(new WordError("offline", `${ag.id} was stopped`)); return; }
    t.state = "running";
    if (t.job) {
      let p: Proc | undefined;
      try { p = await acquire(slot, t); t.proc = p; t.done?.resolve(await t.job(p)); }
      catch (error) { t.done?.reject(error instanceof WordError ? error : new WordError("failed", errorText(error))); }
      finally { if (p) release(slot, p); finishLane(t); }
      return;
    }
    report({ event: "turn.started", agent: ag.id, key: lane.key, turn: t.id, ids: t.batch.map((m) => m.id) });
    let outcome: "completed" | "cancelled" | "error" = "completed";
    let error: string | undefined;
    let p: Proc | undefined;
    try {
      if (t.cancelled) outcome = "cancelled";
      else {
        p = await acquire(slot, t);
        t.proc = p;
        if (t.cancelled) outcome = "cancelled";
        else {
          const result = await drive(slot, t, p);
          outcome = result.outcome;
          error = result.error;
        }
      }
    } catch (e) {
      outcome = "error";
      error = errorText(e);
    } finally {
      if (p) release(slot, p);
    }
    const next = lane.followups.splice(0);
    finishLane(t);
    if (!alive(t)) return; // the agent was stopped: the agents module cuts the turn itself
    report({ event: "turn.ended", agent: ag.id, key: lane.key, turn: t.id, outcome, ...(error ? { error } : {}) });
    if (next.length && outcome !== "cancelled") enqueue(newTurn(ag, lane, next));
  }

  function finishLane(t: Turn): void { if (t.lane.turn === t) t.lane.turn = undefined; }

  /** One prompt, to its settling. A network error that is real (the way is shut) is answered by a switch to the fallback and one more try. */
  async function drive(slot: Slot, t: Turn, p: Proc): Promise<{ outcome: "completed" | "cancelled" | "error"; error?: string }> {
    const { ag, lane } = t;
    let { message, images } = promptOf(lane, t.batch);
    let switched = false;
    for (;;) {
      const run = await promptOnce(t, p, message, images);
      if (run.outcome !== "error" || switched || !alive(t)) return run;
      // Which kind of failure was it? Only a Codex model's own trouble is answered with a switch.
      const reason = run.error ?? "";
      const model = p.model;
      if (model === fallbackModel || !providerOf(model)) return run;
      const login = AUTH_ERROR.test(reason);
      const net = !login && needsRoute(model) && NETWORK_ERROR.test(reason);
      if (!login && !net) return run;
      if (net && (await routeNow(true)) !== "none") return run; // the way is open: this was something else
      enterFallback(ag, login ? (providerOf(model)!.login ? "login" : "key") : "network");
      try { await switchModel(p, fallbackModel); await applyEffort(p, ag, fallbackModel); } catch (e) { return { outcome: "error", error: errorText(e) }; }
      switched = true;
      message = `[ash] The model you were using could not be reached, so this session now runs on ${fallbackModel}. Carry on with the message above where it stopped.`;
      images = [];
    }
  }

  async function promptOnce(t: Turn, p: Proc, message: string, images: unknown[]): Promise<{ outcome: "completed" | "cancelled" | "error"; error?: string }> {
    const { ag, lane } = t;
    const key = lane.key;
    const open = new Map<string, { name: string; summary: string }>();
    let lastError: string | undefined;
    let aborted = false;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    let died: string | undefined;
    const offExit = p.rpc.onExit((reason) => { died = reason; settle(); });
    const off = p.rpc.onEvent((ev: PiRecord) => {
      switch (ev.type) {
        case "message_end": {
          const m = ev.message;
          if (m?.role !== "assistant") return;
          const blocks: any[] = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
          for (const b of blocks) {
            if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) report({ event: "thought", agent: ag.id, key, turn: t.id, text: b.thinking });
          }
          const said = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
          if (said) report({ event: "output", agent: ag.id, key, turn: t.id, text: said });
          lastError = m.stopReason === "error" ? String(m.errorMessage ?? "the model failed") : undefined;
          return;
        }
        case "tool_execution_start": {
          const name = String(ev.toolName ?? "tool");
          const summary = toolSummary(name, undefined, ev.args);
          if (ev.toolCallId) open.set(String(ev.toolCallId), { name, summary });
          report({ event: "tool", agent: ag.id, key, turn: t.id, phase: "start", name, summary });
          return;
        }
        case "tool_execution_end": {
          const o = ev.toolCallId ? open.get(String(ev.toolCallId)) : undefined;
          const name = o?.name ?? String(ev.toolName ?? "tool");
          report({ event: "tool", agent: ag.id, key, turn: t.id, phase: "end", name, summary: o?.summary ?? toolSummary(name), ok: ev.isError !== true });
          return;
        }
        case "auto_retry_end":
          if (ev.success === false && typeof ev.finalError === "string") lastError = ev.finalError;
          return;
        case "agent_settled":
          aborted = ev.aborted === true;
          settle();
          return;
        default:
      }
    });
    try {
      await p.rpc.request({ type: "prompt", message, ...(images.length ? { images } : {}) }, 60_000);
      if (t.cancelled) p.rpc.request({ type: "abort" }, 15_000).catch(() => {});
      await settled;
    } catch (error) {
      return { outcome: "error", error: errorText(error) };
    } finally { off(); offExit(); }
    if (died) return { outcome: "error", error: died };
    if (aborted || t.cancelled) return { outcome: "cancelled" };
    return lastError ? { outcome: "error", error: lastError } : { outcome: "completed" };
  }

  const newTurn = (ag: Agent, lane: Lane, batch: DriverMessage[]): Turn =>
    ({ id: `t_${randomBytes(6).toString("base64url")}`, ag, lane, batch, state: "queued", cancelled: false, dropped: false });

  // -- the agent and its lanes -------------------------------------------------------------------------------------

  const agentOf = (id: string): Agent => { const ag = agents.get(id); if (!ag) throw new WordError("offline", `${id} is not running`); return ag; };
  const laneOf = (id: string, key: string): { ag: Agent; lane: Lane } => {
    const ag = agentOf(id);
    const lane = ag.lanes.get(key);
    if (!lane) throw new WordError("not_found", `${id} has no session ${key}`);
    return { ag, lane };
  };
  const busyLane = (lane: Lane) => new WordError("conflict", `busy: ${lane.key} is in a turn`);

  /** End the processes this agent is using, and drop its waiting turns. `drop`: the turns running in them end without a word (the agents module cuts them). */
  async function halt(id: string): Promise<void> {
    const ag = agents.get(id);
    if (ag?.recover) { clearInterval(ag.recover); ag.recover = undefined; }
    for (const slot of Object.values(slots)) {
      for (const t of slot.queue.filter((q) => q.ag.id === id)) { t.dropped = true; t.done?.reject(new WordError("offline", `${id} was stopped`)); finishLane(t); }
      slot.queue = slot.queue.filter((q) => q.ag.id !== id);
      if (slot.current?.ag.id === id) slot.current.dropped = true;
      if (slot.proc?.agentId === id) await closeProc(slot);
    }
  }

  async function writeConfig(ag: Agent): Promise<void> {
    if (ag.spec.modules.static.length) await deps.writeFile(`${dirOf(ag.cwd)}/${BASELINE_FILE}`, ag.spec.modules.static.map((m) => m.content).join("\n\n---\n\n") + "\n");
    // The tool surface: one server, `ash`. Each process puts its lane's token into ASH_TOKEN, and pi expands it in the header.
    const config = { mcpServers: { ash: { url: ag.spec.tools.mcp_url, headers: { Authorization: "Bearer ${ASH_TOKEN}" }, exposure: "direct", timeout: 900 } } };
    await deps.writeFile(`/root/.pi/agent/mcp.json`, JSON.stringify(config, null, 2) + "\n");
  }

  // -- Codex's login -----------------------------------------------------------------------------------------------

  /** One run of the login helper to its end; its last JSON line. */
  function runHelper(args: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
      let child: DriverProcess;
      try { child = deps.spawn([...loginArgv, ...args], { env, cwd }); } catch { resolve(null); return; }
      let out = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => { out += c; });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("exit", () => {
        clearTimeout(timer);
        const last = out.trim().split("\n").filter(Boolean).pop();
        try { resolve(last ? JSON.parse(last) : null); } catch { resolve(null); }
      });
    });
  }

  async function loginStatus(ag?: Agent): Promise<"none" | "pending" | "ready" | "unknown"> {
    if (login.state === "pending") return "pending";
    const got = await runHelper(["status"], ag ? envFor(ag, "front", "none") : { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: runtimeDir() }, ag?.cwd ?? "/root", 20_000);
    if (got && typeof got.ready === "boolean") login.state = got.ready ? "ready" : "none";
    else login.state = "unknown";
    return login.state;
  }

  /** Start Codex's device-code login: the link and code for the owner. The rest (the owner types the code, the token is stored) goes on in the background. */
  async function startLogin(ag: Agent, provider: string): Promise<Record<string, unknown>> {
    if (provider !== CODEX_PROVIDER) throw new WordError("bad_request", `only ${CODEX_PROVIDER} has a login here`);
    if (login.state === "pending" && login.info) return login.info;
    const route = await routeNow(true);
    if (route === "none") throw new WordError("unavailable", "OpenAI cannot be reached: turn on the phone's VPN for the time of the login, or set up the v2rayA app (see apps.describe v2raya and v2raya.status; its page is http://127.0.0.1:2017 on the phone)");
    const child = deps.spawn([...loginArgv, "login"], { env: envFor(ag, "front", route), cwd: ag.cwd });
    login.child = child;
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { for (const line of c.split("\n")) if (line.trim()) log("[pi-login]", line.slice(0, 300)); });
    child.stdout.setEncoding("utf8");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = "";
      let first = true;
      const wait = setTimeout(() => { if (first) { first = false; try { child.kill("SIGKILL"); } catch { /* gone */ } login.state = "unknown"; reject(new WordError("failed", "the login did not give its link in time")); } }, 45_000);
      wait.unref();
      const finish = (ev: Record<string, any>) => {
        if (ev.event === "auth_url" && first) {
          first = false;
          clearTimeout(wait);
          login.state = "pending";
          login.info = { url: ev.url, note: "pi's browser login: the owner opens url in the phone's browser and signs in with the ChatGPT account (the browser must reach OpenAI: the phone's VPN on); OpenAI sends the browser back to localhost:1455, where the login waits. Read the state back with configure." };
          resolve(login.info);
        } else if (ev.event === "done") {
          login.state = "ready"; login.info = undefined;
          for (const slot of Object.values(slots)) if (slot.proc && !slot.proc.busy) closeProc(slot).catch(() => {}); // they read the login at start
          if (ag.fallback) leaveFallback(ag, "Codex 登录成功，已切回 Codex。");
          else notice(ag, "Codex 登录成功。");
        } else if (ev.event === "error") {
          login.state = "none"; login.info = undefined;
          if (first) { first = false; clearTimeout(wait); reject(new WordError("failed", String(ev.message ?? "the login failed"))); }
          else notice(ag, `Codex 登录没成功：${String(ev.message ?? "").slice(0, 120)}`);
        }
      };
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue; try { finish(JSON.parse(line)); } catch { /* not ours */ } }
      });
      child.on("exit", () => {
        if (login.child === child) login.child = undefined;
        if (first) { first = false; clearTimeout(wait); login.state = "none"; reject(new WordError("failed", "the login helper ended before it gave its link")); }
        else if (login.state === "pending") { login.state = "none"; login.info = undefined; notice(ag, "Codex 登录没有完成（码过期或被中断）。需要的话再发起一次。"); }
      });
    });
  }

  /** `effective`: what is in force now (the model that runs, the effort set for it, a fallback and why, the route); `saved`: the declaration's lasting settings. */
  function readBack(ag: Agent): Record<string, unknown> {
    const current = [slots.front.proc, slots.shared.proc].find((p) => p?.agentId === ag.id)?.model;
    const wanted = wantedModel(ag);
    const model = ag.fallback ? fallbackModel : wanted;
    const effort = effortFor(ag, model);
    const route = routeCache?.route ?? "unknown";
    const temporary = ag.temp.model || Object.keys(ag.temp.efforts).length ? { ...(ag.temp.model ? { model: ag.temp.model } : {}), ...(Object.keys(ag.temp.efforts).length ? { efforts: ag.temp.efforts } : {}) } : undefined;
    return {
      effective: { model, ...(effort ? { effort } : {}), wanted, fallback: ag.fallback?.reason ?? null, route, ...(current ? { running: current } : {}) },
      saved: ag.saved, ...(temporary ? { temporary } : {}),
      model, model_wanted: wanted, ...(current ? { model_running: current } : {}), ...(effort ? { effort } : {}),
      route, fallback: ag.fallback?.reason ?? null,
      codex_login: login.state, ...(login.info ? { login: login.info } : {}), proxy: proxyUrl,
    };
  }

  // -- the catalog -------------------------------------------------------------------------------------------------

  const LOGIN_HOW = "Codex needs the owner's login (ChatGPT subscription). Ask the owner to turn on the phone's VPN for a minute, then call service:agents/configure {agent, config: {login: \"openai-codex\"}}: it returns a link and a code. Send both to the owner with human_say and ask them to open the link in the phone's browser and type the code. You are told when it is done; do not poll. The VPN can be turned off afterwards.";
  let tables: Promise<Array<{ id: string; name: string; models: CatalogModel[] }>> | null = null;
  /** What pi's store says of the tables it holds: when upstream was last asked and the date of the newest list received. Null: never asked. */
  let tableStore: { checked_at?: number | null; upstream_at?: number | null } | null = null;
  let refreshing: Promise<void> | null = null;
  let lastRefreshTry = 0;
  let dailyTimer: NodeJS.Timeout | undefined;

  /** pi's own model tables, read once by the helper in the container; a short built-in list when that cannot be done. */
  function modelTables(): Promise<Array<{ id: string; name: string; models: CatalogModel[] }>> {
    tables ??= runHelper(["catalog"], { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: runtimeDir() }, "/root", 90_000).then((got) => {
      const providers = Array.isArray(got?.providers) ? (got!.providers as Array<{ id: string; name: string; models: CatalogModel[] }>) : null;
      if (providers && providers.length) { tableStore = (got!.store as typeof tableStore) ?? null; return providers; }
      tables = null; // try again next time
      log("pi: the model tables could not be read; a short list is used");
      const byProvider = new Map<string, CatalogModel[]>();
      for (const m of PI_INFO.models) {
        const provider = split(m.id).provider;
        byProvider.set(provider, [...(byProvider.get(provider) ?? []), { id: m.id, name: m.id, images: false, reasoning: true, efforts: ALL_EFFORTS }]);
      }
      return [...byProvider].map(([id, models]) => ({ id, name: PROVIDERS[id]?.name ?? id, models }));
    });
    return tables;
  }

  // -- keeping the tables up with upstream ------------------------------------------------------------------------

  const tablesStale = () => !tableStore?.checked_at || Date.now() - tableStore.checked_at > catalogRefreshMs;

  /** The helper's environment for asking upstream: the proxy when it is the way, nothing of the phone's own proxy otherwise. pi must not be offline for it. */
  function refreshEnv(viaProxy: boolean): Record<string, string> {
    const proxy = viaProxy ? proxyUrl : "";
    return { PI_CODING_AGENT_DIR: runtimeDir(), HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: LOOPBACK, no_proxy: LOOPBACK };
  }

  /**
   * Ask upstream (pi.dev) for newer model tables. Direct first; when that does not get through, through v2rayA if it answers (it is not
   * started for this); when neither does, nothing happens and the tables stay as they are: no error anywhere. One at a time.
   */
  function refreshTables(): Promise<void> {
    if (refreshing) return refreshing;
    lastRefreshTry = Date.now();
    refreshing = (async () => {
      let got = await runHelper(["refresh"], refreshEnv(false), "/root", 120_000);
      let ok = got?.ok === true;
      if (!ok && (await (probe("proxy").catch(() => false)))) { got = await runHelper(["refresh"], refreshEnv(true), "/root", 120_000); ok = got?.ok === true; }
      const store = (got?.store as typeof tableStore) ?? null;
      if (store?.checked_at && store.checked_at !== tableStore?.checked_at) { tables = null; tableStore = store; }
      if (!ok) log("pi: the model tables could not be refreshed from upstream; the ones held are used");
    })().catch((error) => log(`pi: refreshing the model tables: ${errorText(error)}`)).finally(() => { refreshing = null; });
    return refreshing;
  }

  /** A stale table is asked for again, in the background, at most once in `catalogRetryMs`. */
  function refreshIfStale(): void {
    if (tablesStale() && !refreshing && Date.now() - lastRefreshTry >= catalogRetryMs) void refreshTables();
  }

  /** On the first agent: look at the tables a little later (refresh when stale), and once a day after that. */
  function watchTables(): void {
    if (dailyTimer) return;
    const first = setTimeout(() => { modelTables().then(refreshIfStale).catch(() => {}); }, catalogStartDelayMs);
    first.unref();
    dailyTimer = setInterval(() => { void refreshTables(); }, catalogRefreshMs);
    dailyTimer.unref();
  }

  // -- the driver --------------------------------------------------------------------------------------------------

  const driver: AgentDriver = {
    info: PI_INFO,

    async start(id, spec) {
      if (agents.has(id)) return;
      watchTables();
      const cwd = spec.native?.cwd ?? `/root/agents/${id.slice("agent:".length)}`;
      const ag: Agent = { id, spec, cwd, lanes: new Map(), saved: spec.runtime, temp: { efforts: {} }, fallback: null };
      for (const key of spec.lanes) ag.lanes.set(key, { key, session: spec.sessions[key] ?? sessionId(), followups: [], held: [] });
      agents.set(id, ag);
      try { await writeConfig(ag); } catch (error) { agents.delete(id); throw new WordError("failed", `${id} did not start: ${errorText(error)}`); }
      for (const lane of ag.lanes.values()) report({ event: "handle.updated", agent: id, key: lane.key, handle: lane.session });
    },
    async stop(id) { await halt(id); agents.delete(id); },
    status(id): AgentStatus { return agents.has(id) ? { state: "running" } : { state: "exited", detail: "not started" }; },
    async restart(id) {
      const ag = agents.get(id);
      if (!ag) throw new WordError("not_found", `${id} was never started`);
      await halt(id);
      const live: Agent = { ...ag, lanes: new Map([...ag.lanes].map(([k, l]) => [k, { ...l, turn: undefined, followups: [] }])), temp: { efforts: {} }, fallback: null, recover: undefined };
      agents.set(id, live);
      await writeConfig(live);
    },

    session: {
      get(id, key) { return agents.get(id)?.lanes.get(key)?.session ?? null; },
      async set(id, key, handle) {
        const { lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        lane.session = handle;
        report({ event: "handle.updated", agent: id, key, handle });
      },
      async new(id, key) {
        const { lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        lane.session = sessionId();
        report({ event: "handle.updated", agent: id, key, handle: lane.session });
        return { handle: lane.session };
      },
      async reload(id, key, modules) {
        const { ag, lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        ag.spec = { ...ag.spec, modules };
        await writeConfig(ag);
        lane.session = sessionId();
        report({ event: "handle.updated", agent: id, key, handle: lane.session });
        return { handle: lane.session };
      },
      async compact(id, key) {
        const { ag, lane } = laneOf(id, key);
        if (lane.turn) throw busyLane(lane);
        const t = newTurn(ag, lane, []);
        const done = new Promise<unknown>((resolve, reject) => { t.done = { resolve, reject }; });
        t.job = async (p) => {
          try { await p.rpc.request({ type: "compact" }, 180_000); return { compacted: true }; }
          catch (error) { return { compacted: false, detail: errorText(error) }; }
        };
        enqueue(t);
        return (await done) as { compacted: boolean; detail?: string };
      },
    },

    async send(id, key, batch) {
      const { ag, lane } = laneOf(id, key);
      if (lane.turn) throw busyLane(lane);
      enqueue(newTurn(ag, lane, [...lane.followups.splice(0), ...batch]));
    },
    async followup(id, key, batch) {
      const { ag, lane } = laneOf(id, key);
      if (lane.turn) lane.followups.push(...batch);
      else enqueue(newTurn(ag, lane, [...lane.followups.splice(0), ...batch]));
    },
    async steer(id, key, words) {
      const { lane } = laneOf(id, key);
      const t = lane.turn;
      if (!t || t.state !== "running" || !t.proc) return false;
      try { await t.proc.rpc.request({ type: "steer", message: words }); return true; } catch { return false; }
    },
    async inject(id, key, what) {
      const { lane } = laneOf(id, key);
      const parts = [...(what.modules ?? []).map((m: PromptModule) => m.content), ...(what.text ? [what.text] : [])];
      lane.held.push(...parts);
    },
    async interrupt(id, key) {
      const { lane } = laneOf(id, key);
      const t = lane.turn;
      if (!t) return;
      t.cancelled = true;
      if (t.state === "running" && t.proc) { t.proc.rpc.request({ type: "abort" }, 15_000).catch(() => {}); return; }
      // Still waiting for the slot: it ends where it stands, and says so.
      for (const slot of Object.values(slots)) {
        const i = slot.queue.indexOf(t);
        if (i < 0) continue;
        slot.queue.splice(i, 1);
        finishLane(t);
        report({ event: "turn.started", agent: id, key, turn: t.id, ids: t.batch.map((m) => m.id) });
        report({ event: "turn.ended", agent: id, key, turn: t.id, outcome: "cancelled" });
      }
    },

    async catalog(id, _saved, _options?: CatalogOptions): Promise<RuntimeCatalog> {
      const ag = agents.get(id);
      const loginState = await loginStatus(ag);
      const providers: CatalogProvider[] = (await modelTables()).filter((t) => PROVIDERS[t.id]).map((t) => {
        const info = PROVIDERS[t.id]!;
        return {
          id: t.id, name: info.name, needs_proxy: info.proxy === true, models: t.models,
          auth: info.login ? { kind: "login", method: "browser", state: loginState, how: loginState === "pending" ? "A login is under way: wait for the owner to finish it (the link and code were given when it started)." : LOGIN_HOW } : { kind: "key", ref: info.key! },
        } as CatalogProvider;
      });
      refreshIfStale();
      return { providers, source: { checked_at: tableStore?.checked_at ?? null, upstream_at: tableStore?.upstream_at ?? null, refreshing: !!refreshing }, ...(ag ? { effective: readBack(ag).effective as Record<string, unknown> } : {}) };
    },

    async configure(id, _key, config) {
      const ag = agentOf(id);
      const clearFallback = () => { ag.fallback = null; if (ag.recover) { clearInterval(ag.recover); ag.recover = undefined; } };
      if (config && Object.keys(config).length) {
        if (config.runtime && typeof config.runtime === "object") {
          // The declaration changed (service:agents/update): its settings are the lasting ones again, and a temporary choice is let go.
          const before = wantedModel(ag);
          ag.saved = config.runtime as RuntimeSettings;
          ag.temp = { efforts: {} };
          if (wantedModel(ag) !== before) clearFallback();
        }
        if (typeof config.model === "string" && config.model) { ag.temp.model = normalizeModel(config.model); clearFallback(); }
        if (typeof config.effort === "string" && config.effort) ag.temp.efforts[wantedModel(ag)] = config.effort;
        if (typeof config.login === "string" && config.login) { const card = await startLogin(ag, config.login); return { ...readBack(ag), ...card }; }
      } else if (providerOf(wantedModel(ag))?.login) {
        await loginStatus(ag);
        if (!routeCache) await routeNow().catch(() => {});
      }
      return readBack(ag);
    },
    async plugins() { throw new WordError("unavailable", "pi has no plugins here"); },

    async credentialsHas(_id, ref) { return keys.has(ref); },
    async credentialsSet(_id, ref, value) {
      if (!(ref in KEY_ENV)) throw new WordError("bad_request", `pi does not take the key ${ref}`);
      const changed = keys.get(ref) !== value;
      keys.set(ref, value);
      // A process that is only being kept warm has the old key in its environment: end it, the next turn starts one with the new.
      if (changed) for (const slot of Object.values(slots)) if (slot.proc && !slot.proc.busy) await closeProc(slot);
    },
  };
  return driver;
}
