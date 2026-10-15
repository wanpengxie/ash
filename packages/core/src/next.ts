/**
 * The new hub's assembly point (ASH-HUB §7.1 rule 4: the one place that imports every module and only creates and wires
 * them). Every scenario in `test/scenarios/` reaches the hub through `startHub` and the one port it opens (`/link`, `/mcp`,
 * the web page).
 *
 * Order: host boot, ledger, vault, kernel (registry, redact, gate, router), services, edges, then everybody into the
 * registry, then start (the port first, because the agents are given the tool address on it).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { HOST_EXIT_CONFIG } from "../../sdk/src/host";
import { fileURLToPath } from "node:url";
import type { AgentDriverFactory } from "../../sdk/src/driver";
import type { HostNetwork } from "../../sdk/src/host";
import { MAIN_BODY_ID } from "../../sdk/src/ids";
import { WordError, type Caller } from "../../sdk/src/message";
import { createAgents, bodyFileWriter } from "./edges/agents";
import { DEFAULT_CREDENTIAL_REFS } from "./edges/agents/manager";
import { createDshDriver, type DriverProcess } from "./edges/agents/dsh";
import { createPiDriver } from "./edges/agents/pi";
import { forgetScriptAgent, SCRIPT_RUNTIME, scriptDriver } from "./edges/agents/script";
import { createRemoteDrivers } from "./edges/agents/remote";
import { AttachedCallers } from "./edges/agents/attached";
import { createApps, installBuiltinOrgans, installContractDoc, newBuiltinReport } from "./edges/apps";
import { createLocalBody, mainBodyKind } from "./edges/body/local";
import { createHostPipe, createHostService, createVirtualScreen, HostClient, loadHostBoot } from "./edges/host";
import { createLlm } from "./edges/llm";
import { createReviewer } from "./edges/llm/review";
import { createLlmService } from "./edges/llm/service";
import { createSummarizer } from "./edges/llm/summary";
import { createLinkServer } from "./edges/link-server";
import { createLinkControl } from "./edges/link-server/control/words";
import { Devices } from "./edges/link-server/hands/devices";
import { createBodies, splitBodyCapabilities } from "./edges/link-server/hands/bodies";
import { HandRegistry } from "./edges/link-server/hands/registry";
import { createHuman } from "./edges/link-server/human";
import { staticWeb } from "./edges/link-server/web";
import { createToolsEdge, TOOL_NAMES, toolWords } from "./edges/tools";
import { APP_CONTRACT_DOC } from "./prompts/app-contract.generated";
import { AGENT_RULES, MAIN_RULES } from "./prompts/rules.generated";
import { createGate, GateStore, needsLease } from "./kernel/gate";
import { Ledger } from "./kernel/ledger";
import { createRedact } from "./kernel/redact";
import { createRegistry } from "./kernel/registry";
import { createRouter } from "./kernel/router";
import { openVault } from "./kernel/vault";
import { bodySecrets, refsIn } from "./kernel/vault/refs";
import type { Vault } from "./kernel/types";
import { createAdminService, tailFile } from "./services/admin";
import { createHealthService } from "./services/health";
import { createBlobsService } from "./services/blobs";
import { createClockService } from "./services/clock";
import { createCostService } from "./services/cost";
import { createDirectoryService } from "./services/directory";
import { createNameOf } from "./services/gate/names";
import { createGateService } from "./services/gate";
import { createHistoryService } from "./services/history";
import { createJev, createReflexService } from "./services/reflex";
import { createSemantic } from "./services/semantic";
import { createSensesService } from "./services/senses";
import { createVaultService } from "./services/vault";
import { createWidgetsService } from "./services/widgets";

export type {
  AgentDriver, AgentDriverFactory, AgentEvent, AgentStartSpec, DriverMessage,
} from "../../sdk/src/driver";

export interface HubOptions {
  /** The hub's state directory (ledger, blobs, vault file). The caller owns it; starting again on the same one is a restart. Absent: the host's `dirs.state`. */
  dataDir?: string;
  /** The one port the hub opens on 127.0.0.1. 0 or absent: any free port. */
  port?: number;
  /** The environment the host started the hub with (SPEC-07: `ASH_HOST_SPEC`, no secrets). Absent: `process.env`. The hub reads host.json itself. */
  env?: NodeJS.ProcessEnv;
  /**
   * The hub's end of the private pipe to its host (SPEC-07): `stdin` brings the secrets first, then answers and host events;
   * `stdout` carries the hub's calls. Absent: `process.stdin` / `process.stdout`. One pair per start.
   */
  stdin?: Readable;
  stdout?: Writable;
  /** Where the hub's small model lives; overrides the providers' own addresses (BUILD-PROGRESS §7, decision 1). Absent: the real ones. */
  llm?: { baseUrl: string };
  /** Drivers by runtime kind (`dsh`, `codex`, ...). Absent: the real ones. */
  drivers?: Record<string, AgentDriverFactory>;
  /** The clock of everything that waits for a time (timers, approval expiry, pulse). Absent: the system clock. */
  now?: () => number;
  /** The time between the health meter's ticks in ms (default 10 000; scenarios shorten it). */
  healthTickMs?: number;
}

export interface Hub {
  /** `http://127.0.0.1:<port>`. `/link` (WebSocket, `ash-link/2`), `/mcp` and the web page hang off it. */
  url: string;
  /** Stops the hub; the second call waits for the first. */
  stop(): Promise<void>;
  /** Resolves when the hub has stopped, whoever asked for it (`stop()`, or the host's `lifecycle.stop`). The entry program waits for it, then exits. */
  closed: Promise<void>;
}

const log = (...args: unknown[]): void => console.error(new Date().toISOString(), "[hub]", ...args.map((a) => (a instanceof Error ? a.message : a)));
const service = (member: string): Caller => ({ member, via: "service", local: true });
/** `packages/ash-skills` next to the sources; `<payload>/ash-skills` next to the bundle (`<payload>/ash/ash-core.mjs`, payload/assemble.mjs). */
const SKILLS = [new URL("../ash-skills/", import.meta.url), new URL("../../ash-skills/", import.meta.url)]
  .map((url) => fileURLToPath(url)).find((dir) => existsSync(join(dir, "agents", "main.json"))) ?? fileURLToPath(new URL("../../ash-skills/", import.meta.url));
/**
 * The first-party apps, already bundled (`<payload>/ash-apps/<id>/`, payload/assemble.mjs). Only the payload has them: a
 * source tree has `packages/apps/<id>` unbundled, which cannot run as it is.
 */
const FIRST_PARTY_APPS = fileURLToPath(new URL("../ash-apps/", import.meta.url));

/** Burned into the bundle by `build:core` (esbuild --define, from package.json); absent when running from the sources. */
declare const __ASH_VERSION__: string | undefined;

function hubVersion(): string {
  if (typeof __ASH_VERSION__ === "string") return __ASH_VERSION__;
  try { return String((JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "dev"); } catch { return "dev"; }
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const now = opts.now ?? Date.now;
  const startedAt = now();

  // 1. host boot: host.json, then the secrets on the first line of the pipe
  const booted = loadHostBoot({ env: opts.env ?? process.env });
  if (!booted.ok) throw Object.assign(new Error(`cannot start: ${booted.reason}`), { exitCode: booted.exitCode });
  const { spec } = booted.boot;
  const pipe = createHostPipe(opts.stdin ?? process.stdin, opts.stdout ?? process.stdout, (line) => log(line));
  let secrets: { sealKey: Buffer };
  try { secrets = await pipe.boot(); } catch (error) {
    pipe.close();
    throw Object.assign(new Error(`cannot start: ${(error as Error).message}`), { exitCode: HOST_EXIT_CONFIG });
  }
  const host = new HostClient({ pipe, capabilities: spec.capabilities });
  const virtual = createVirtualScreen(host);

  // 2. ledger  3. vault (the host boot has already refused a start without the seal key: nothing is stored unsealed)
  const dataDir = opts.dataDir ?? spec.dirs.state;
  mkdirSync(dataDir, { recursive: true });
  const ledger = Ledger.open(join(dataDir, "ash.db"));
  let vault: Vault;
  try { vault = openVault({ file: join(dataDir, "vault.json"), sealKey: secrets.sealKey, now }); } catch (error) { ledger.close(); throw error; }

  // 4. kernel. The gate needs the hands and the main body, the router needs the agents and the apps: they come later.
  const late: { hands?: HandRegistry; body?: ReturnType<typeof createLocalBody>; gateService?: ReturnType<typeof createGateService>; apps?: ReturnType<typeof createApps>; health?: ReturnType<typeof createHealthService>; agents?: ReturnType<typeof createAgents>; human?: ReturnType<typeof createHuman> } = {};
  const registry = createRegistry();
  const redact = createRedact();
  const store = new GateStore(ledger, now);
  const llm = createLlm({
    key: (ref) => vault.use(ref),
    report: (usage) => void router.send({ to: "service:cost", kind: "event", word: "usage.recorded", body: usage }, service("service:llm"))
      .then((reply) => { if (!reply.ok) log(`usage.recorded: ${reply.error.code}`); }, (error) => log("usage.recorded failed", error)),
    ...(opts.llm ? { baseUrl: opts.llm.baseUrl } : {}),
  });
  const review = createReviewer({ llm });
  const gate = createGate({
    tier: (target) => late.hands!.tier(target),
    mode: () => store.mode(),
    assess: (req) => (req.to === MAIN_BODY_ID ? late.body!.assess(req) : late.hands!.assess(req)),
    // A command that uses vault entries by name: which, in the owner's words, and on which body.
    vaultUse: (req) => {
      const names = req.to?.startsWith("body:") && req.word === "workspace.bash" ? refsIn((req.body as { env?: unknown } | null)?.env) : [];
      if (!names.length) return null;
      const where = req.to === MAIN_BODY_ID ? "手机" : late.hands?.get(req.to!.slice("body:".length))?.name ?? req.to!;
      return { names: names.map((ref) => ({ ref, label: vaultService.labelOf(ref) })), where };
    },
    review,
  }, store, { now });
  // The Codex App on a computer calls as an agent that Ash does not run (edges/agents/attached.ts).
  const attached = new AttachedCallers();
  const policyOf = (id: string) => late.agents?.policyOf(id) ?? attached.policyOf(id);
  const router = createRouter({
    ledger, registry, gate, redact, store, now,
    // The hub setting `approval.fast_seconds`: how long an agent's call that needs the owner waits for their answer (default 30; 0 turns the fast path off).
    fastWaitMs: () => { const v = admin.settings(["approval.fast_seconds"])["approval.fast_seconds"]; return (typeof v === "number" && v >= 0 ? Math.min(v, 45) : 30) * 1000; },
    onParked: (pending) => late.gateService!.issueCard(pending),
    onError: (where, error) => { late.health?.noteError(where); log(where, error); },
    tap: (traffic) => late.health?.tap(traffic),
    agentPolicy: policyOf, toolWords,
    mayTalkToOwner: (caller, word) => late.agents?.mayTalkToOwner(caller, word) ?? true,
    mayAnswer: (caller, body) => late.agents?.mayAnswer(caller, body) ?? true,
    appGranted: (app, to, word) => late.apps!.runtime.granted(app, to, word),
    // $vault.<name> in a command's environment: the value goes in on the way to the body and is masked in what comes back.
    secrets: bodySecrets((ref) => vaultService.resolve(ref), (ref) => vaultService.usable(ref)),
  });

  // 5. services
  // A long attachment goes back to the channel that asked for it, as a stream on that connection (the human edge is made below).
  const blobs = createBlobsService(ledger, { openStream: (bytes, mime, ctx) => late.human!.openStream(ctx.caller.client, bytes, mime) });
  const gateService = late.gateService = createGateService({
    ownerSay: (askId, to, body) => late.human!.sayAfterAnswer(askId, to, body),
    // A screen lease ended: the fingers the agent still holds on the phone are let go, and what it has on the way to the screen is cancelled.
    releaseScreen: async () => {
      const hand = registry.findByWord("screen.touch", { kind: "device" })[0];
      if (hand) await router.send({ to: hand.id, kind: "request", word: "screen.touch", body: { action: "release_all" } }, service("service:gate"));
    },
    cancelScreen: (agent) => router.cancelWhere((r) => r.from === agent && r.to !== null && needsLease(registry.find(r.to, r.word)?.contract ?? ({} as never))),
    store, gate, send: (msg, caller, o) => router.send(msg, caller, o), redeem: (id, caller, o) => router.redeem(id, caller, o),
    contractOf: (member, word) => registry.find(member, word)?.contract ?? null, nameOf: createNameOf({
      memberName: (id) => registry.get(id)?.name, handName: (hand) => late.hands?.get(hand)?.name,
      mainAgentName: () => { const primary = late.agents?.primary(); return primary ? registry.get(primary)?.name : null; },
    }),
    onError: (where, error) => log(where, error),
  });
  const clock = createClockService({ ledger, router, now });
  const senses = createSensesService({ dataDir, now });
  const cost = createCostService({ ledger, now });
  const reflex = createReflexService({ ledger, router, jev: createJev({ post: (req) => llm.post("service:reflex", req) }) });
  const history = createHistoryService({ ledger, now });
  const admin = createAdminService({
    ledger, router, registry, version: hubVersion(), now, startedAt,
    readLogs: ({ lines }) => tailFile(join(spec.dirs.logs, "core.log"), lines),
  });
  const health = late.health = createHealthService({ ledger, router, registry, now, log: (message) => log(`health: ${message}`), viewing: () => late.human?.viewing() ?? false, ...(opts.healthTickMs ? { tickMs: opts.healthTickMs } : {}) });
  const widgets = createWidgetsService({ ledger, router, now });
  const directory = createDirectoryService({ registry, agentPolicy: policyOf, toolWords, appGranted: (app, member, word) => late.apps!.runtime.granted(app, member, word) });
  // The host's network, for the hub's own calls out (the service connections go through the phone's proxy when it has one).
  let network: HostNetwork | null = null;
  const vaultService = createVaultService({ vault, ledger, router, network: () => network, now, log, appCredential: (app, ref) => late.apps!.runtime.credential(app, ref) });
  const semantic = createSemantic({
    ledger, router, now, log,
    templatesDir: join(SKILLS, "persona"), modelKeys: DEFAULT_CREDENTIAL_REFS,
  });

  // 6. edges
  const isolation = spec.isolation;
  // A binary or large file of this body goes to the channel that asked for it, as the long attachments do.
  const body = late.body = createLocalBody({
    isolation, stateDir: dataDir, streams: (bytes, mime, ctx) => late.human!.openStream(ctx.caller.client, bytes, mime),
    ...(spec.network ? { network: spec.network } : {}),
  });
  const hands = late.hands = new HandRegistry({
    db: ledger.db(), registry, router, now, splitBodyCapabilities,
    bodies: { isBound: (id) => bodies.isBound(id), forget: (id) => bodies.forget(id) },
  });
  const bodies = createBodies({
    db: ledger.db(), hands: { get: (id) => hands.view(id) }, rebind: (id) => hands.rebind(id), now, mainKind: mainBodyKind(isolation),
    call: async (to, word, input) => {
      const reply = await router.send({ to, kind: "request", word, body: input }, service("service:bodies"));
      if (!reply.ok) throw new WordError(reply.error.code, reply.error.message);
      return reply.result;
    },
  });
  const link = createLinkServer({ hands, hostClient: host, ...(opts.port ? { port: opts.port } : {}), log });
  link.observe((event) => {
    if (event.type === "connected") health.noteLink("open", event.conn.hand);
    else health.noteLink(event.type, event.code);
  });
  const linkControl = createLinkControl({
    db: ledger.db(), router, link, hands, vault, now, log,
    identity: { key: () => host.identityKey(), sign: (data) => host.identitySign(data) },
  });
  const devices = new Devices({
    hands, router, bodies, gateway: linkControl.pairing, now, log, primaryAgent: () => late.agents?.primary() ?? null,
    autoUpdate: () => admin.settings(["devices.auto_update"])["devices.auto_update"] !== false,
  });
  linkControl.bindDevices(devices);
  const remote = createRemoteDrivers({ router, log, attached: {
    declare: (computer, name) => attached.declare(computer, name), drop: (computer) => attached.drop(computer),
    tools: (agent) => tools.attachedTools(agent), call: (agent, turn, tool, args, signal) => tools.callAttached(agent, turn, tool, args, signal),
  } });
  link.onChannel("agent", remote.attach);

  let url = "";
  const tools = createToolsEdge({ router, registry, ledger, now, log, agentPolicy: policyOf, attached, currentTurn: (id, lane) => late.agents?.currentTurn(id, lane) ?? null,
    turnActive: (id, turn) => late.agents?.turnActive(id, turn) ?? false });
  const drivers: Record<string, AgentDriverFactory> = {
    dsh: (report) => createDshDriver({ report, spawn: (argv, o) => body.spawn(argv, o) as DriverProcess, writeFile: bodyFileWriter(router), runtimePath: (cwd) => body.runtimePath(cwd), readBlob: (ref) => ledger.blob.get(ref) }),
    // pi, the other agent runtime: it works through the same body.
    pi: (report) => {
      const spawn = (argv: string[], o?: { env?: Record<string, string>; cwd?: string }) => body.spawn(argv, o) as DriverProcess;
      return createPiDriver({ report, spawn, writeFile: bodyFileWriter(router), runtimePath: (cwd) => body.runtimePath(cwd), readBlob: (ref) => ledger.blob.get(ref), log });
    },
    // The script agent exists only for a host that says it is a debug build (host.json `dev.script_agent`).
    ...(spec.dev?.script_agent === true ? { [SCRIPT_RUNTIME]: scriptDriver({ spawn: (argv, o) => body.spawn(argv, o) as DriverProcess, writeFile: bodyFileWriter(router), runtimePath: (cwd) => body.runtimePath(cwd), readBlob: (ref) => ledger.blob.get(ref) }) } : {}),
    ...remote.factories,
    ...opts.drivers,
  };
  let provisioned = false;
  const agents = late.agents = createAgents({
    router, registry, ledger, vault: { use: (ref) => vault.use(ref) }, vaultRef: (ref) => vaultService.resolve(ref), drivers, now, log,
    ...(spec.dev?.script_agent === true ? { declare: forgetScriptAgent } : {}),
    templatesDir: join(SKILLS, "agents"),
    rules: (decl) => (decl.primary ? MAIN_RULES : AGENT_RULES),
    channels: () => late.human?.channels() ?? [],
    tools: (agent, lanes, allowed) => ({ mcp_url: `${url}/mcp`, tokens: tools.issueTokens(agent, lanes), allowed: allowed ?? [...TOOL_NAMES] }),
    revokeTools: (agent) => tools.revoke(agent),
    started: (agent) => {
      tools.catchUp(agent);
      // The main agent is up: now the container may spend its time on python3. Only after its first successful start, on purpose:
      // while it cannot start (a container still not ready) the provisioning would only compete with it.
      if (!provisioned && agent === late.agents?.primary()) { provisioned = true; body.provisionLater(); }
    },
    ...(spec.network ? { network: spec.network } : {}),
  });
  const launcher = body.appLauncher();
  if (launcher) installContractDoc(launcher.root, APP_CONTRACT_DOC);
  const builtin = newBuiltinReport();
  const apps = late.apps = createApps({
    router, registry, ledger, primaryAgent: () => agents.primary() ?? "", launcher, clock: { now }, log, contract: { doc: APP_CONTRACT_DOC }, vaultRef: (ref) => vaultService.resolve(ref),
    ...(launcher ? { builtinKept: builtin.kept, builtinExact: builtin.exact,
      builtinApps: [...installBuiltinOrgans(join(SKILLS, "organs"), launcher.root, builtin, log), ...installBuiltinOrgans(FIRST_PARTY_APPS, launcher.root, builtin, log)] } : {}),
  });
  const human = late.human = createHuman({
    router, ledger, settings: () => admin.settings(), primary: () => agents.primary(), now, log,
    summarize: createSummarizer({ llm }), vaultHas: (ref) => vault.list().some((entry) => entry.ref === ref),
  });
  const hostService = createHostService({ client: host, router, registry, virtual, vault, recordings: { hostDir: join(spec.dirs.home, "recordings"), bodyDir: "/root/work/recordings" }, onStop: (deadline) => stop(deadline), onNetwork: (next) => { network = next; body.setNetwork(next); }, log });
  link.onChannel("human", human.attach);
  link.mount("/mcp", tools.handler);
  link.mount("/", staticWeb());

  // 7. everybody into the registry
  for (const member of [
    blobs, gateService, clock, senses, cost, reflex, history, admin, health, widgets, directory, vaultService, ...semantic.members,
    body, devices, bodies, linkControl.member, human.member, human.cards, agents.service, apps.service, createLlmService(llm), hostService.member,
  ]) registry.add(member);

  // 8. start. The agents are told the tool address, so the port opens first; the registry already holds the services
  // and the main body, which an agent needs from its first turn.
  let stopping: Promise<void> | null = null;
  let stopHeartbeat: () => void = () => {};
  let events: { close(): void } | null = null;
  let closed!: () => void;
  const done = new Promise<void>((resolve) => { closed = resolve; });
  // Everything that makes work stops first (no new connections, no timers, no agents, no apps); the ledger is closed last.
  const stop = (deadline = now() + 5000): Promise<void> => stopping ??= (async () => {
    events?.close();
    stopHeartbeat();
    health.stop();
    await link.stop();
    semantic.stop();
    linkControl.stop();
    clock.stop();
    gateService.stop();
    vaultService.oauth.stop();
    await agents.stopAll();
    await apps.stopAll(deadline);
    human.close();
    tools.close();
    await body.close();
    ledger.close();
    pipe.close();
  })().finally(closed);

  try {
    health.start();
    const { port } = await link.start();
    url = `http://127.0.0.1:${port}`;
    await agents.startAll(); // does not wait for the agents: they come up on their own time and take messages meanwhile
    router.recover();
    tools.recover();
    gateService.start();
    router.subscribe({}, (m) => gateService.observe(m));
    clock.start();
    widgets.start();
    await linkControl.start();
    await semantic.start();
    await apps.start();
    await host.lifecycleReady(hubVersion(), port);
    stopHeartbeat = host.startHeartbeat(() => health.heartbeat());
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  const reader = events = hostService.listen(pipe);
  // The host's end of the pipe closed: the host is gone, and a kernel nobody supervises stops the way it would on lifecycle.stop.
  void reader.done.then(() => { if (!stopping) { log("the host closed standard input: stopping"); return stop(); } }).catch((error) => log("stop failed", error));

  return { url, stop: () => stop(), closed: done };
}
