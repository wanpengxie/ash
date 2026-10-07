// Production ash-api/2 entrypoint. The retired event writer is test-only.
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuthScopeKey } from "./auth-scope";
import { protectProcessMemory } from "./harden";
import { DshHost } from "../../dsh-binding/src/host";
import { DshMindRunner } from "../../dsh-binding/src/mind";
import { DshTurnRunner } from "../../dsh-binding/src/runtime";
import { dshWorkerModel } from "../../dsh-binding/src/workers";
import { ModelEgress } from "../../agent-container/src/egress";
import { ContainerHost } from "../../agent-container/src/host";
import { CONTAINER_PATH, DEFAULT_MODEL, inContainer, prepareLaunch, provisionCommand, type ContainerConfig } from "../../agent-container/src/launch";
import { AppRuntime, type AppLauncher } from "./apps/runtime";
import { installBuiltinApps } from "./apps/builtin";
import { ContainerMindRunner, ContainerTurnRunner } from "../../agent-container/src/runtime";
import { catalogRates, piWorkerModel } from "../../agent-container/src/workers";
import { AgentMcpServer, TOOL_NAMES, type AgentBinding, type AgentPolicy } from "./agent-mcp/server";
import { AgentSystem, type AgentRuntime } from "./agent-system/system";
import { agentName, resolveAgents, wordAllowed, type AgentDeclaration, type ConfiguredAgent } from "./agents";
import { AGENT_RULES } from "./workers/rules.generated";
import type { Message } from "../../sdk/src/api";
import { resolveWorldConfigV2, type WorldConfigV2 } from "../../sdk/src/config";
import { ClientLink, fileSigner, OwnerLink } from "./gateway/link";
import { HostDeviceLink, type HostConnection } from "./host-v2";
import { TaskStatusBridge } from "./task-status";
import { WidgetsMember } from "./members/widgets";
import { heartbeatFlow } from "./flows/heartbeat";
import { memoryFlow } from "./flows/memory";
import { openerFlow } from "./flows/opener";
import { proactiveFlow } from "./flows/proactive";
import { sensesDailyFlow } from "./flows/senses-daily";
import { tourFlow } from "./flows/tour";
import { createAgentMember } from "./members/agent";
import { AgentMind } from "./members/agent-mind";
import { AdminMember } from "./members/admin";
import { ClockMember } from "./members/clock";
import { GateMember } from "./members/gate";
import { OwnerMember } from "./members/owner";
import { PostMember } from "./members/post";
import { ReflexMember } from "./members/reflex";
import { JevReflexClient } from "./members/reflex-jev";
import { JevClient, type DecisionModel } from "./world/decision/jev";
import { createSelfMember, type SelfMember } from "./members/self";
import { SenseArchive } from "./members/senses-archive";
import { SensesMember } from "./members/senses";
import { CostMember, type UsageRecord } from "./members/cost";
import { VaultMember, VaultStore } from "./members/vault";
import { deepseekReviewer } from "./review/reviewer";
import { progressSummarizer } from "./review/progress";
import { WorkMember } from "./members/work";
import { ownerScreensLine } from "./members/owner-screens";
import { McpCapabilities, type McpServerSpec } from "./mcpclient";
import { EchoTurnRunner } from "./runtimes/echo";
import { EdgeRouter, startEdgeServer, type EdgeTokens } from "./server";
import { Ledger } from "./world/ledger";
import { WorldMembers } from "./world/member";
import { WorldRouter } from "./world/router";
import { registerWorkerMembers } from "./workers/llm";
import { estimateWorkerCost } from "./workers/cost";

export interface Config {
  role?: "owner" | "client";
  name?: string;
  owner?: string;
  listen?: string;
  stateDir: string;
  workspaces?: Record<string, string>;
  /** The main agent (agent:main, with its runtime) and any other declared agents; the keeper is added by default in the container. */
  agents?: (ConfiguredAgent & { runtime?: "echo" | "dsh" | "container" })[];
  /** The agent runtime in its Linux container (runtime "container"); ash stays outside. */
  container?: ContainerConfig;
  dsh?: { root: string; home?: string; skillsRoot?: string; costRoot?: string; vaultRoot?: string; env?: Record<string, string> };
  host?: HostConnection & { coreToken?: string };
  gateway?: { url: string };
  mcp?: Record<string, McpServerSpec>;
  delivery?: WorldConfigV2["delivery"];
  reflex?: WorldConfigV2["reflex"];
  decision?: WorldConfigV2["decision"];
}

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const token = () => randomBytes(24).toString("base64url");

function loadTokens(config: Config): EdgeTokens {
  const file = join(config.stateDir, "tokens.json");
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Partial<EdgeTokens> : {};
  const tokens: EdgeTokens = { api: { ...(previous.api ?? {}) }, mcp: { ...(previous.mcp ?? {}) } };
  if (!Object.values(tokens.api).includes("person:owner")) tokens.api[token()] = "person:owner";
  // A legacy phone token must not silently become an unauthenticated owner proxy.
  for (const [key, member] of Object.entries(tokens.api)) if (member === "device:phone") delete tokens.api[key];
  if (config.host?.coreToken) tokens.api[config.host.coreToken] = "device:phone";
  tokens.mcp["agent:main"] ??= token();
  writeFileSync(file, JSON.stringify(tokens, null, 1), { mode: 0o600 });
  return tokens;
}

export interface Running {
  url: string;
  tokens: EdgeTokens;
  ledger: Ledger;
  world: WorldRouter;
  members: WorldMembers;
  edge: EdgeRouter;
  link: OwnerLink | null;
  dsh: DshHost | null;
  container: ContainerHost | null;
  /** Every agent member, the main one first. */
  agents: () => ReturnType<typeof createAgentMember>[];
  close(): Promise<void>;
}

/**
 * Where apps live and how their MCP servers start: inside the container (proot) at /root/apps/<id>, with the
 * container's own node; in direct mode (tests) next to the workspace on the host. Without a container there are none.
 */
function appLauncher(container: ContainerConfig | undefined): AppLauncher | null {
  if (!container) return null;
  if (container.direct) {
    const root = join(dirname(container.direct.workspace), "apps");
    return { root: () => root, spawn: (app, dir, env) => ({ command: app.server.command, args: app.server.args ?? [], cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", ...(app.server.env ?? {}), ...env, ASH_APP_DIR: dir } }) };
  }
  return {
    // Only once the container is unpacked: an apps folder must not appear inside an image still being installed.
    root: () => existsSync(join(container.root, "ubuntu", "root")) ? join(container.root, "ubuntu", "root", "apps") : null,
    spawn: (app, _dir, env) => {
      const inside = `/root/apps/${app.id}`;
      const run = inContainer(container.root, ["/bin/sh", "-c", 'cd "$0" && exec "$@"', inside, app.server.command, ...(app.server.args ?? [])],
        { HOME: "/root", PATH: CONTAINER_PATH, TMPDIR: "/tmp", TERM: "dumb", LANG: "C.UTF-8", ...(app.server.env ?? {}), ...env, ASH_APP_DIR: inside });
      return { command: run.command, args: run.args, env: run.env };
    },
  };
}

/** No old Store/Core is instantiated here; Ledger.open owns the one-way migration. */
/** One line per device for the agent's turn context: online state and capability names, bounded. */
function deviceSummary(members: WorldMembers): string {
  const summary = members.describe("agent") as { members?: { id: string; kind?: string; name?: string; online?: boolean; words?: (string | { word: string })[] }[] };
  return (summary.members ?? []).filter((member) => member.id.startsWith("device:") || member.id.startsWith("app:")).map((member) => {
    const words = (member.words ?? []).map((word) => typeof word === "string" ? word : word.word).join(", ");
    return `- ${member.id} (${member.name ?? member.id}, ${member.online ? "online" : "offline"}): ${words || "no capabilities"}`;
  }).join("\n").slice(0, 2000);
}

export async function startOwner(config: Config): Promise<Running> {
  // Before any secret is read: the agent container must not be able to read this process's memory.
  protectProcessMemory(log);
  // The phone hands over the vault's seal key, unwrapped by Android Keystore; no child process inherits it.
  const sealText = process.env.ASH_VAULT_SEAL_KEY;
  delete process.env.ASH_VAULT_SEAL_KEY;
  const vaultSealRequired = process.env.ASH_VAULT_SEAL_REQUIRED === "1";
  delete process.env.ASH_VAULT_SEAL_REQUIRED;
  const vaultSealKey = sealText ? Buffer.from(sealText, "base64url") : undefined;
  const mainEntry = (config.agents ?? []).find((item) => item.id === "agent:main") ?? { id: "agent:main", runtime: "dsh" as const };
  const agents = [{ ...mainEntry, runtime: mainEntry.runtime ?? "dsh" }];
  if (agents[0].runtime !== "echo" && agents[0].runtime !== "dsh" && agents[0].runtime !== "container") throw new Error("unsupported agent runtime");
  // Declared agents run in the container next to the main one; the in-process runtimes host only the main agent.
  const declarations = resolveAgents(config.agents, agents[0].runtime === "container");
  if (!config.stateDir) throw new Error("stateDir is required");
  if (agents[0].runtime === "container") {
    if (!config.container?.root && !config.container?.direct) throw new Error("container runtime requires container.root");
    // Persona and memory files live in the agent's own workspace, where the agent reads them like any file.
    const home = config.container.direct?.workspace ?? join(config.container.root, "ubuntu", "root", "work");
    mkdirSync(home, { recursive: true });
    // Once, on the first start in the container: bring the persona, memory and files over from the old home.
    const previous = config.workspaces?.home;
    const moved = join(config.stateDir, "container-home-migrated");
    if (previous && previous !== home && existsSync(previous) && !existsSync(moved)) {
      cpSync(previous, home, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
      mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(moved, `${previous}\n`, { mode: 0o600 });
    }
    config = { ...config, workspaces: { ...(config.workspaces ?? {}), home } };
  }
  if (agents[0].runtime === "dsh" && (!config.dsh?.root || !config.workspaces?.home || !existsSync(join(config.dsh.root, "package.json")) || !existsSync(config.workspaces.home))) {
    throw new Error("DSH runtime requires an installed root and existing home workspace; no database was opened");
  }
  const [host, portText] = (config.listen ?? "127.0.0.1:4700").split(":");
  const port = Number(portText);
  if (!host || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("invalid listen address");
  // Probe before migrating: old host protocols must fail closed without modifying the DB.
  const hostLink = config.host ? await HostDeviceLink.probe(config.host) : null;
  const worldConfig = resolveWorldConfigV2(config as unknown as Record<string, unknown>);
  // Filled once the edge exists; the first turn cannot run before it.
  let screensNow = () => "";
  const delivery = worldConfig.delivery;
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tokens = loadTokens(config);
  const ledger = await Ledger.open(join(config.stateDir, "ash.db"));
  let agent: ReturnType<typeof createAgentMember> | null = null;
  let mind: AgentMind | null = null;
  let clock: ClockMember | null = null;
  let admin: AdminMember | null = null;
  let post: PostMember | null = null;
  let reflex: ReflexMember | null = null;
  let dsh: DshHost | null = null;
  let container: ContainerHost | null = null;
  let egress: ModelEgress | null = null;
  let agentTools: AgentMcpServer | null = null;
  let agentSystem: AgentSystem | null = null;
  let provisioning: ChildProcess | null = null;
  let self: SelfMember | null = null;
  let work: WorkMember | null = null;
  let senses: SensesMember | null = null;
  let cost: CostMember | null = null;
  let stopTour: (() => void) | null = null;
  let taskStatus: TaskStatusBridge | null = null;
  let widgets: WidgetsMember | null = null;
  let stopFirstMeeting: (() => void) | null = null;
  let link: OwnerLink | null = null;
  let server: Awaited<ReturnType<typeof startEdgeServer>> | null = null;
  let apps: AppRuntime | null = null;
  try {
    const world = new WorldRouter(ledger, async (request, caller) => {
      if (caller.remote) return Boolean(caller.pairedDeviceId && link && await link.isBrowserAuthorized(caller.pairedDeviceId));
      // A high-entropy token's digest identifies a credential without persisting it.
      // Current token membership, not a stale snapshot permission, decides recovery.
      if (caller.transportPrincipal?.startsWith("token:")) return Object.entries(tokens.api).some(([key, member]) =>
        member === caller.member && `token:${createHash("sha256").update(key).digest("hex")}` === caller.transportPrincipal);
      if (caller.transportPrincipal === caller.member && agentSystem?.declaration(caller.member) && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:admin" && caller.member === "service:admin" && caller.local && !caller.remote) return true;
      // A running app, within its grants (the router checks them again at dispatch).
      if (caller.member.startsWith("app:") && caller.transportPrincipal === caller.member && caller.local && !caller.remote)
        return Boolean(apps?.isRunning(caller.member.slice(4)));
      if (caller.transportPrincipal === "service:reflex" && caller.member === "service:reflex" && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:cost" && caller.member === "service:cost" && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:post" && caller.member === "service:post" && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:work" && caller.member === "service:work" && caller.local && !caller.remote)
        return Boolean(work?.ownsRequestTurn(request));
      if (caller.transportPrincipal === "service:senses" && caller.member === "service:senses" && caller.local && !caller.remote &&
        request.from === "service:senses" && request.to === "agent:main" && request.word === "wake") return true;
      if (caller.transportPrincipal === "service:gate" && caller.member === "service:gate" && caller.local && !caller.remote &&
        request.from === "service:gate" && (request.to === "person:owner" && request.word === "ask" ||
          request.to?.startsWith("agent:") && request.word === "say")) return true;
      return false;
    });
    const members = new WorldMembers(world);
    members.register(new OwnerMember(config.owner ?? "Owner", ledger));
    members.register(new GateMember(ledger, world, members, { get: () => admin?.journal.approvalMode() ?? "auto", set: (mode) => admin!.journal.setApprovalMode(mode) }));
    world.setMemberNames((id) => { try { return members.describe("owner", id).members[0]?.name; } catch { return undefined; } });
    // Independent apps (contract ash-app/1): found in the container, started once the owner installed them.
    apps = new AppRuntime({ launcher: appLauncher(config.container), stateDir: config.stateDir, world, members, log,
      builtins: (root) => installBuiltinApps(root, log) });
    members.register(apps.member());
    const vaultFile = join(config.stateDir, "vault.json");
    let vaultStore: VaultStore;
    if (vaultSealRequired) {
      vaultStore = VaultStore.secure(vaultFile, Date.now, vaultSealKey);
      if (!vaultStore.availability().available)
        log("secure credential storage is unavailable; the vault was left untouched and credential changes are disabled");
    } else try { vaultStore = new VaultStore(vaultFile, Date.now, vaultSealKey); }
    catch (error) {
      // Legacy non-Android launches did not require a seal. Preserve their recovery behavior; Android takes the secure
      // branch above and never moves or replaces a vault when Keystore access fails.
      if (!readFileSync(vaultFile, "utf8").includes('"sealed"')) throw error;
      const aside = `${vaultFile}.unreadable-${Date.now()}`;
      renameSync(vaultFile, aside);
      log("the sealed vault could not be opened; it was moved aside and ash starts with an empty vault", aside);
      vaultStore = new VaultStore(vaultFile, Date.now, vaultSealKey);
    }
    const vault = new VaultMember(vaultStore, world);
    members.register(vault);
    world.enableDurableGate();
    // ---- Approval: an agent's non-read action is judged by one reviewer call (key from the vault, read per review);
    // the owner's mode lives in the admin journal and is read on every decision. No key, an error or a timeout asks the owner.
    // Each review's tokens join the usage page under their own scope.
    const reviewUsage = new Set<(record: UsageRecord) => void>();
    world.setReviewer(deepseekReviewer(() => vaultStore.get("DEEPSEEK_API_KEY"), { onUsage: (usage) => {
      const record: UsageRecord = { at: Date.now() - usage.ms, ms: usage.ms, scope: "review", provider: "deepseek-official", model: usage.model,
        input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: 0, ok: true };
      for (const listener of reviewUsage) listener(record);
    } }));
    world.setApprovalMode(() => admin?.journal.approvalMode() ?? "auto");
    // ---- end approval
    const containerMode = agents[0].runtime === "container";
    const live = agents[0].runtime !== "echo";
    // Which part of ash a model call belongs to, for the usage page: whoever is running when it is made.
    const running = { chat: 0, mind: 0, background: 0 };
    const modelFile = join(config.stateDir, "container-model.json");
    const containerModel = (): { provider: string; model: string } => {
      try { if (existsSync(modelFile)) { const stored = JSON.parse(readFileSync(modelFile, "utf8")) as { provider?: unknown; model?: unknown };
        if (typeof stored.provider === "string" && typeof stored.model === "string") return { provider: stored.provider, model: stored.model }; } } catch { /* fall back */ }
      return config.container?.model ?? DEFAULT_MODEL;
    };
    let agentPolicy: ((item: AgentDeclaration) => AgentPolicy) | null = null;
    let mainBinding: AgentBinding | null = null;
    let mindBinding: AgentBinding | null = null;
    const otherBindings = new Map<string, AgentBinding>();
    if (containerMode) {
      const containerConfig = config.container!;
      egress = new ModelEgress({ key: () => vaultStore.get("DEEPSEEK_API_KEY"), upstream: containerConfig.modelUpstream });
      const egressBase = await egress.start();
      container = new ContainerHost({ stateDir: config.stateDir, log,
        launch: () => prepareLaunch({ ...containerConfig, model: containerModel() }, egressBase, config.stateDir) });
      const resultRoot = join(config.workspaces!.home, ".ash", "results");
      agentTools = new AgentMcpServer({ router: world, members, ledger, log,
        resultArtifacts: { hostDir: resultRoot, toAgentPath: (path) => containerConfig.direct ? path : `/root/work/.ash/results/${basename(path)}` },
        status: () => ({ paused: clock?.journal.isPaused() ?? false, quiet_hours: admin?.journal.quietHours() ?? delivery.quiet ?? null }) });
      await agentTools.start();
      const mainDeclaration = declarations.find((item) => item.id === "agent:main")!;
      const policyOf = (item: AgentDeclaration) => ({ ...(item.tools ? { tools: item.tools } : {}), ...(item.words ? { words: (member: string, word: string) => wordAllowed(item, member, word) } : {}) });
      mainBinding = agentTools.bind("agent:main", "main", () => null, policyOf(mainDeclaration));
      mindBinding = agentTools.bind("agent:main", "mind", () => null, policyOf(mainDeclaration));
      agentPolicy = policyOf;
    }
    if (agents[0].runtime === "dsh") dsh = new DshHost({ root: config.dsh!.root, home: config.dsh!.home ?? join(config.stateDir, "dsh-home"), skillsRoot: config.dsh!.skillsRoot, costRoot: config.dsh!.costRoot, vaultRoot: config.dsh!.vaultRoot, env: config.dsh!.env });
    const keyMissing = () => !vaultStore.has("DEEPSEEK_API_KEY");
    const containerRunner = container ? new ContainerTurnRunner({ host: container, binding: mainBinding!, router: world, keyMissing, stateDir: config.stateDir, log,
      summarizeProgress: progressSummarizer(() => vaultStore.get("DEEPSEEK_API_KEY"), (usage) => {
        for (const listener of reviewUsage) listener({ at: Date.now() - usage.ms, ms: usage.ms, scope: "progress", provider: "deepseek-official",
          model: usage.model, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: 0, ok: true });
      }),
      mcp: () => ({ url: agentTools!.url, token: mainBinding!.token }), failuresSince: (at, sessionId) => egress!.failuresSince(at, sessionId), labelSession: (sessionId, scope) => egress!.label(sessionId, scope),
      devices: () => `${deviceSummary(members)}\n${screensNow()}`, onActive: (active) => { running.chat += active ? 1 : -1; } }) : null;
    const runner = dsh ? new DshTurnRunner(dsh, join(config.stateDir, "attachments", "inbox"), config.workspaces!.home, world, () => `${deviceSummary(members)}\n${screensNow()}`)
      : containerRunner ?? new EchoTurnRunner();
    const mindRunner = dsh ? new DshMindRunner(dsh) : container ? new ContainerMindRunner({ host: container, binding: mindBinding!, router: world, keyMissing, stateDir: config.stateDir, log,
      mcp: () => ({ url: agentTools!.url, token: mindBinding!.token }), failuresSince: (at, sessionId) => egress!.failuresSince(at, sessionId), labelSession: (sessionId, scope) => egress!.label(sessionId, scope), onActive: (active) => { running.mind += active ? 1 : -1; } }) : null;
    agent = createAgentMember({ ledger, router: world, stateDir: join(config.stateDir, "agent-main"), runner, name: agents[0].name,
      ...(hostLink ? { beforeTurn: async (turn: string) => {
        await world.send({ member: "service:reflex", transport: "service", transportPrincipal: "service:reflex", local: true,
          remote: false, ownerProxy: false, turn }, { to: "service:reflex", kind: "request", word: "before_turn",
          body: { turn }, client_id: `decision:before:${turn}`, wait: true });
        return reflex?.executionContext(turn);
      } } : {}),
      ...(live ? { mind: () => mind } : {}),
      ...(live ? { managedSnapshot: async () => {
        if (!self) throw new Error("managed files unavailable");
        return self.promptSnapshot();
      } } : {}),
      isPaused: () => clock!.journal.isPaused(), currentAdminPauseTargets: (requestId, turn) => admin!.currentPauseTargets(requestId, turn) });
    members.register(agent);
    // ash's Agent system holds the declarations and brings each declared agent to life in the container: its own member,
    // inbox and turns, session, tool credential, workspace and schedule.
    const agentRuntime: AgentRuntime | null = container ? {
      create: (declaration) => {
        const item = declaration();
        const binding = agentTools!.bind(item.id, agentName(item.id), () => null, agentPolicy!(item));
        otherBindings.set(item.id, binding);
        const runner = new ContainerTurnRunner({ host: container!, binding, router: world, keyMissing, stateDir: config.stateDir, log,
          sessionKey: item.id, agentName: agentName(item.id),
          context: () => { const current = declaration(); return `[${current.name}（${current.id}）的职责]\n${current.brief ?? current.summary}\n\n[Ash 的规则]\n${AGENT_RULES}`; },
          mcp: () => ({ url: agentTools!.url, token: binding.token }), failuresSince: (at, sessionId) => egress!.failuresSince(at, sessionId), labelSession: (sessionId, scope) => egress!.label(sessionId, scope),
          onActive: (active) => { running.background += active ? 1 : -1; } });
        return createAgentMember({ id: item.id, ledger, router: world, stateDir: join(config.stateDir, "agents", agentName(item.id)), runner, name: item.name,
          isPaused: () => clock!.journal.isPaused() });
      },
      reopen: async (id) => { await container!.closeSession(id); },
      dispose: async (id) => {
        const binding = otherBindings.get(id);
        if (binding) agentTools!.retire(binding);
        otherBindings.delete(id);
        await container!.closeSession(id, true);
      },
      apply: (item) => { const binding = otherBindings.get(item.id); if (binding) binding.policy = agentPolicy!(item); },
    } : null;
    agentSystem = new AgentSystem({ router: world, members, stateDir: config.stateDir, defaults: declarations, main: agent, runtime: agentRuntime,
      toolNames: TOOL_NAMES, isPaused: () => clock!.journal.isPaused(), log });
    members.register(agentSystem);
    agentSystem.prepare();
    // The JEV key lives in the vault and is read on each judgement, so saving or removing it needs no restart.
    const jevRef = "OPENROUTER_API_KEY";
    const decisions = worldConfig.decision;
    const jevUrl = decisions.jev.url;
    const decisionModel: DecisionModel | undefined = jevUrl && decisions.jev.key_credential === "jev" ? {
      available: () => vaultStore.has(jevRef),
      evaluate: (state, questions, signal) => new JevClient(jevUrl, vaultStore.get(jevRef) ?? "", decisions.jev.timeout_ms, fetch,
        decisions.jev.model || undefined).evaluate(state, questions, signal),
    } : undefined;
    const jev = decisionModel ? {
      available: () => vaultStore.has(jevRef),
      judge: (state: Parameters<JevReflexClient["judge"]>[0], signal?: AbortSignal) => new JevReflexClient(jevUrl, "adapter", decisions.jev.timeout_ms, fetch, decisionModel).judge(state, signal),
    } : undefined;
    reflex = new ReflexMember(world, () => agent!.inbox.activeTurn()?.id ?? null, { jev, model: decisionModel,
      ...(hostLink ? { screenHost: hostLink } : {}),
      conversationEnabled: decisions.routes["conversation.control"].enabled,
      screenEnabled: decisions.routes["screen.reconcile"].enabled,
      screenExecutionEnabled: decisions.routes["screen.execution"].enabled,
      ready: () => !agent!.inbox.activeTurn() && !agent!.waitingForQuiescence,
      paused: () => clock?.journal.isPaused() ?? false,
      threshold: decisions.routes["conversation.control"].threshold,
      context: (message, turn) => {
        const first = agent!.inbox.turnIds(turn).map((id) => ledger.byId(id)).find((item) => item?.word === "say");
        return { current_task: String(first?.body.text ?? "").slice(0, 500),
          latest_user_message: String(message.body.text ?? "").slice(0, 500),
          recent_messages: ledger.list({ before: message.seq, limit: 50 })
            .filter((item) => item.word === "say" && ["person:owner", "agent:main"].includes(item.from) && typeof item.body.text === "string")
            .slice(-2).map((item) => String(item.body.text).slice(0, 500)) };
      } });
    members.register(reflex);
    world.setDeviceExecutionGuard((message) => reflex?.executionViolation(message) ?? null);
    clock = new ClockMember({ ledger, router: world, dbFile: join(config.stateDir, "ash.db"),
      isPaused: () => clock!.journal.isPaused(),
      ...(hostLink ? { alarm: (at: number | null) => hostLink.scheduleAlarm(at) } : {}) });
    members.register(clock);
    // Batched phone facts are kept as files in the owner's home, where the agent reads them like any file.
    const senseArchive = live && config.workspaces?.home ? new SenseArchive({ home: config.workspaces.home }) : null;
    work = new WorkMember({ ledger, router: world, isPaused: () => clock!.journal.isPaused(),
      flows: live && config.workspaces?.home ? [memoryFlow(ledger, (run) => {
        try { work!.trigger("proactive", "event", `memory:${run}`); } catch { /* a suggestion cannot undo committed memory */ }
      }), proactiveFlow(ledger), heartbeatFlow(), openerFlow(ledger), tourFlow(ledger), ...(senseArchive ? [sensesDailyFlow(senseArchive)] : [])] : [] });
    members.register(work);
    if (live) senses = new SensesMember({ router: world, heartbeat: async () => (await self!.promptSnapshot()).heartbeat,
      isPaused: () => clock!.journal.isPaused(), ...(senseArchive ? { archive: senseArchive } : {}), log,
      opener: (slot) => { try { work!.trigger("opener", "event", slot); } catch { /* no run while paused or active */ } },
      proactive: (slot) => { try { work!.trigger("proactive", "event", slot); } catch { /* no run while paused or active */ } } });
    if (senses) members.register(senses);
    stopTour = live ? world.subscribe((message) => {
      if (message.from !== "agent:main" || message.to !== "person:owner" || message.kind !== "request" || message.word !== "say") return;
      try { work!.trigger("tour", "event", `reply:${createHash("sha256").update(message.id).digest("hex").slice(0, 32)}`); }
      catch { /* no duplicate daily hint */ }
    }) : null;
    if (config.workspaces?.home) {
      self = createSelfMember({ home: config.workspaces.home, stateDir: join(config.stateDir, "self"), ledger, router: world });
      members.register(self);
    }
    if (live && self) stopFirstMeeting = world.subscribe((message) => {
      if (message.to !== "service:post" || message.word !== "visible" || message.kind !== "event" || !message.from.startsWith("screen:")) return;
      void (async () => {
        if ((await self!.promptSnapshot()).identity !== null) return;
        await world.send({ member: "service:senses", transport: "service", transportPrincipal: "service:senses",
          local: true, remote: false, ownerProxy: false }, { to: "agent:main", kind: "request", word: "wake",
          body: { reason: "first_meeting", context: {} }, client_id: "first-meeting:v1", wait: true });
      })().catch((error) => log("first meeting wake failed", error));
    });
    widgets = new WidgetsMember({ router: world, file: join(config.stateDir, "widgets.json"),
      ...(hostLink ? { push: (state) => hostLink.widgets(state) } : {}) });
    members.register(widgets);
    if (hostLink) members.registerDevice(hostLink.device());
    const edge = new EdgeRouter(ledger, world, members, tokens, { workspaces: config.workspaces, authScopeKey: loadAuthScopeKey(config.stateDir), vault,
      fileWorkspaces: () => {
        if (!container || !config.workspaces?.home) return {};
        const home = config.workspaces.home;
        return Object.fromEntries([
          ["home", { root: home, directory: config.container?.direct ? home : "/root/work" }],
          ...(agentSystem?.all() ?? []).filter((item) => item.id !== "agent:main").map((item) => {
            const name = agentName(item.id), root = join(dirname(home), "agents", name);
            return [`agent_${name}`, { root, directory: config.container?.direct ? root : `/root/agents/${name}` }];
          }),
        ]);
      },
      ...(config.host ? { nativeUiToken: createHash("sha256").update(`${config.host.token}:home`).digest("hex") } : {}) });
    screensNow = () => ownerScreensLine(edge.screens);
    edge.attachApps(apps);
    admin = new AdminMember({ ledger, router: world, dbFile: join(config.stateDir, "ash.db"), delivery,
      onPauseChanged: () => { agent!.resamplePause(); work!.resamplePause(); },
      gatewayState: () => link ? { configured: true, ...link.state() } : { configured: false },
      gatewayOp: async (body: Record<string, unknown>) => {
        if (!link) throw new Error("gateway unavailable");
        switch (body.op) {
          case "approve":
            await link.approve(body.request_id as string, body.permissions as Parameters<OwnerLink["approve"]>[1]);
            await link.refreshDevices().catch((error) => log("gateway device refresh failed", error));
            return { approved: true };
          case "reject": await link.reject(body.request_id as string); return { rejected: true };
          case "ticket": return { ...(await link.ticket()) };
          case "revoke": await link.revoke(body.device as string);
            await link.refreshDevices().catch((error) => log("gateway device refresh failed", error)); // the next state read no longer lists it
            return { revoked: true };
          case "sync": await link.refreshDevices(); return { configured: true, ...link.state() };
          default: throw new Error("unsupported gateway operation");
        }
      },
      ...(dsh ? { modelGet: () => dsh!.agentOptions() ?? {}, modelSet: async (provider: string, model: string) => {
        const selector = dsh!.ctx?.get("agentDefaultModel");
        if (!selector) throw new Error("DSH model selection unavailable");
        await selector.saveSelection({ provider, model });
        return { provider, model, restart_required: true };
      } } : {}),
      ...(container ? { modelGet: () => containerModel(), modelSet: async (provider: string, model: string) => {
        if (!catalogRates(provider, model) && provider !== "deepseek-official") throw new Error("unknown model");
        writeFileSync(modelFile, JSON.stringify({ provider, model }), { mode: 0o600 });
        // Live sessions switch now; new sessions start with it from the launch patch.
        let applied = true;
        for (const sessionId of container!.openSessions()) {
          try { await container!.setModel(sessionId, provider, model); }
          catch (error) { applied = false; log("model switch for", sessionId, "failed", error); }
        }
        return { provider, model, restart_required: !applied };
      } } : {}),
      ...(container ? { pluginsList: async () => container!.plugins({ op: "list" }), pluginsOp: async (body: Record<string, unknown>) => {
        if (body.op === "enable" || body.op === "disable") {
          if (body.name === "@deepseek-ai/dsh-base" || body.name === "@deepseek-ai/dsh-acp-app") throw new Error("this bundle is required");
          if (body.name === "dsh-ash-control" || body.name === "ash-skills") throw new Error("ash's own plugins are required");
        }
        const result = await container!.plugins({ op: body.op, name: body.name, id: body.id, enabled: body.enabled });
        // A changed plugin set takes effect when the runtime starts again; restart it now, between turns if possible.
        const restart = result?.application === "restart-required";
        if (restart && !agent!.inbox.activeTurn()) await container!.restart();
        return { ...result, restart_required: restart && Boolean(agent!.inbox.activeTurn()) };
      } } : {}),
      ...(dsh ? { pluginsList: async () => {
        const manager = dsh!.ctx?.get("pluginManager");
        if (!manager) throw new Error("DSH plugin manager unavailable");
        const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()]);
        return { bundles, plugins };
      }, pluginsOp: async (body: Record<string, unknown>) => {
        const manager = dsh!.ctx?.get("pluginManager");
        if (!manager) throw new Error("DSH plugin manager unavailable");
        const value = (field: string) => {
          const item = body[field];
          if (typeof item !== "string" || !item.trim()) throw new Error(`${field} required`);
          return item.trim();
        };
        let result: Record<string, unknown>;
        switch (body.op) {
          case "enable":
          case "disable": {
            const name = value("name");
            if (name === "@deepseek-ai/dsh-base") throw new Error("base bundle is required");
            result = await manager.setBundleEnabled(name, body.op === "enable");
            break;
          }
          case "plugin":
            if (typeof body.enabled !== "boolean") throw new Error("enabled required");
            result = await manager.setPluginEnabled(value("id"), body.enabled);
            break;
          default: throw new Error("unsupported plugin operation");
        }
        return { ...result, restart_required: result?.application === "restart-required" };
      } } : {}),
      currentAgentTurn: () => agent!.inbox.activeTurn()?.id ?? null,
      currentScreenBinding: (screen, principal) => edge.screens.currentBinding(screen, principal) });
    delivery.quiet = admin.journal.quietHours() ?? delivery.quiet;
    members.register(admin);
    post = new PostMember({ ledger, router: world, screens: edge.screens, delivery, ...(hostLink ? { host: hostLink, island: () => hostLink.islandShown() } : {}) });
    members.register(post);
    edge.attachPostJournal(post.journal);
    const gatewayFile = join(config.stateDir, "gateway.json");
    const gatewayUrl = existsSync(gatewayFile) ? (JSON.parse(readFileSync(gatewayFile, "utf8")) as { url?: string }).url : config.gateway?.url;
    if (gatewayUrl) {
      const signer = hostLink ? await hostLink.signer() : await fileSigner(config.stateDir);
      link = new OwnerLink(gatewayUrl, signer, edge, log);
      await link.claimIfNeeded(join(config.stateDir, "bootstrap-secret"), config.name ?? "Ash owner");
      void link.run();
      await link.waitConnected(); // remote recovery requires current grants, not an old snapshot
    }
    // Reconcile durable stop intents before router recovery can replay an old tool request.
    const committedPause = admin.currentCommittedPause();
    if (committedPause) agent.reconcileCommittedPause(committedPause.requestId, committedPause.targetTurn);
    agent.prepareRecovery();
    await self?.prepareRecovery();
    post.prepareRecovery();
    admin.prepareRecovery();
    work.prepareRecovery();
    // Install Python in the background once per container image; she can use apt herself for anything else.
    const provision = () => {
      const run = config.container ? provisionCommand(config.container) : null;
      if (!run || provisioning) return;
      const out = openSync(join(config.stateDir, "container-provision.log"), "a", 0o600);
      provisioning = spawn(run.command, run.args, { env: run.env, stdio: ["ignore", out, out] });
      provisioning.on("exit", (code) => { log("container provisioning finished", code); closeSync(out); provisioning = null; });
      provisioning.on("error", (error) => log("container provisioning failed", error));
    };
    if (container) {
      registerWorkerMembers(members, piWorkerModel(() => vaultStore.get("DEEPSEEK_API_KEY"), () => worldConfig.workers.model ?? containerModel()), ledger);
      cost = new CostMember({ ledger, router: world, priceSource: "pi-ai-model-catalog", collector: { onUsage: (listener) => {
        const stop = egress!.onUsage(listener);
        reviewUsage.add(listener);
        return () => { stop(); reviewUsage.delete(listener); };
      }, balance: () => egress!.balance() },
        price: async (record) => {
          const rates = catalogRates(record.provider, record.model);
          return rates ? estimateWorkerCost({ provider: record.provider, model: record.model, inputTokens: record.input, outputTokens: record.output,
            cacheReadTokens: record.cacheRead, cacheWriteTokens: record.cacheWrite }, rates) : null;
        } });
      members.register(cost);
      if (!self) throw new Error("managed files unavailable");
      containerRunner!.primeManagedSnapshot(await self.promptSnapshot());
      mind = new AgentMind(mindRunner!, () => self!.promptSnapshot());
      // Start the runtime and open her session now, so the first message does not wait for it. A failure here is
      // reported on that message instead of stopping ash.
      void container.session("main", { url: agentTools!.url, token: mainBinding!.token })
        .then(() => { log("agent runtime ready", JSON.stringify(container!.timings)); provision(); })
        .catch((error) => { if (!container!.isClosed) log("agent runtime failed to start", error); });
    }
    if (dsh) {
      const { startedTurns, completedTurns } = ledger.agentTurnHistory("agent:main");
      await dsh.boot();
    registerWorkerMembers(members, dshWorkerModel(dsh, () => worldConfig.workers.model), ledger);
      dsh.attachVault(async (ref) => vaultStore.get(ref));
      const collector = dsh.cost();
      if (collector) { cost = new CostMember({ ledger, router: world, collector, price: async (record) => {
        const rates = await dsh!.modelRates(record.provider, record.model);
        return rates ? estimateWorkerCost({ provider: record.provider, model: record.model, inputTokens: record.input, outputTokens: record.output,
          cacheReadTokens: record.cacheRead, cacheWriteTokens: record.cacheWrite }, rates) : null;
      } }); members.register(cost); }
      if (!self) throw new Error("managed files unavailable");
      (runner as DshTurnRunner).primeManagedSnapshot(await self.promptSnapshot());
      await dsh.startMain({ members, router: world, workspace: config.workspaces!.home, managedRoot: config.workspaces!.home,
        protectedRoots: [config.stateDir, config.dsh!.home ?? join(config.stateDir, "dsh-home")], adapter: runner as DshTurnRunner,
        nativeMode: "audited", resume: { file: join(config.stateDir, "dsh-main-session.json"), startedTurns, completedTurns } });
      await dsh.startMind({ members, router: world, workspace: config.workspaces!.home, managedRoot: config.workspaces!.home,
        protectedRoots: [config.stateDir, config.dsh!.home ?? join(config.stateDir, "dsh-home")], nativeMode: "disabled", adapter: mindRunner as DshMindRunner });
      mind = new AgentMind(mindRunner!, () => self!.promptSnapshot());
    }
    await reflex.runtime.recover();
    await world.recover();
    await post.start();
    if (hostLink) taskStatus = new TaskStatusBridge(world, (frame) => hostLink.taskStatus(frame));
    widgets.start();
    await agent.start();
    await agentSystem.start();
    await clock.start();
    work.start();
    server = await startEdgeServer(edge, host, port);
    const address = server.address();
    const url = `http://${host}:${typeof address === "object" && address ? address.port : port}`;
    const ownerToken = Object.entries(tokens.api).find(([, member]) => member === "person:owner")![0];
    writeFileSync(join(config.stateDir, "ui-url"), `${url}/?token=${ownerToken}\n`, { mode: 0o600 });
    hostLink?.startHealthChecks(members);
    link?.enable();
    // Apps start in the background: a slow or broken app never delays ash.
    void apps.start().catch((error) => log("apps failed to start", error));
    return { url, tokens, ledger, world, members, edge, link, dsh, container, agents: () => [agent!, ...(agentSystem?.agents() ?? [])], async close() {
      stopTour?.(); stopFirstMeeting?.(); senses?.close(); cost?.close();
      link?.stop(); await taskStatus?.close(); widgets?.close(); hostLink?.close();
      if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
      await reflex?.close(); await post?.close(); await clock?.close(); work?.close(); await agent?.close(); await agentSystem?.close(); await mind?.close(); admin?.close(); await dsh?.close(); (provisioning as ChildProcess | null)?.kill(); await container?.close(); await agentTools?.close(); await apps?.close(); await egress?.close(); await self?.close(); world.dispose(); ledger.close();
    } };
  } catch (error) {
    stopTour?.(); stopFirstMeeting?.(); senses?.close(); cost?.close();
    link?.stop(); await taskStatus?.close(); widgets?.close(); hostLink?.close();
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
    await reflex?.close(); await post?.close(); await clock?.close(); work?.close(); await agent?.close(); await agentSystem?.close(); await mind?.close(); admin?.close(); await dsh?.close(); (provisioning as ChildProcess | null)?.kill(); await container?.close(); await agentTools?.close(); await apps?.close(); await egress?.close(); await self?.close(); ledger.close();
    throw error;
  }
}

export async function startClient(config: Config, pairCode?: string): Promise<{ close(): void }> {
  if (!config.gateway?.url) throw new Error("client role needs gateway.url");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const signer = await fileSigner(config.stateDir);
  const mcp = new McpCapabilities(config.mcp ?? {}, log);
  const name = config.name ?? hostname();
  const link = new ClientLink(config.gateway.url, signer, {
    manifest: async () => ({ name, kind: "laptop", capabilities: await mcp.capabilities() }),
    call: (capability, args) => mcp.call(capability, args),
  }, log);
  await link.pair(config.stateDir, pairCode, name);
  void link.run();
  return { close() { link.stop(); mcp.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1]) throw new Error("usage: ash-core --config ash.json [--pair code]");
  const config = JSON.parse(readFileSync(process.argv[index + 1], "utf8")) as Config;
  const role = config.role ?? "owner";
  const pairIndex = process.argv.indexOf("--pair");
  const pairCode = pairIndex >= 0 ? process.argv[pairIndex + 1] : undefined;
  const running = role === "client" ? await startClient(config, pairCode) : await startOwner(config);
  const stop = () => { void Promise.resolve(running.close()).then(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
