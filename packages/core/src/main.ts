// Production ash-api/2 entrypoint. The retired event writer is test-only.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuthScopeKey } from "./auth-scope";
import { DshHost } from "../../dsh-binding/src/host";
import { DshMindRunner } from "../../dsh-binding/src/mind";
import { DshTurnRunner } from "../../dsh-binding/src/runtime";
import { dshWorkerModel } from "../../dsh-binding/src/workers";
import { resolveWorldConfigV2, type WorldConfigV2 } from "../../sdk/src/config";
import { ClientLink, fileSigner, OwnerLink } from "./gateway/link";
import { HostDeviceLink, type HostConnection } from "./host-v2";
import { heartbeatFlow } from "./flows/heartbeat";
import { memoryFlow } from "./flows/memory";
import { openerFlow } from "./flows/opener";
import { proactiveFlow } from "./flows/proactive";
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
import { createSelfMember, type SelfMember } from "./members/self";
import { SensesMember } from "./members/senses";
import { CostMember } from "./members/cost";
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
  agents?: { id: "agent:main"; name?: string; runtime: "echo" | "dsh" }[];
  dsh?: { root: string; home?: string; skillsRoot?: string; costRoot?: string; env?: Record<string, string> };
  host?: HostConnection & { coreToken?: string };
  gateway?: { url: string };
  mcp?: Record<string, McpServerSpec>;
  delivery?: WorldConfigV2["delivery"];
  reflex?: WorldConfigV2["reflex"];
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
  close(): Promise<void>;
}

/** No old Store/Core is instantiated here; Ledger.open owns the one-way migration. */
/** One line per device for the agent's turn context: online state and capability names, bounded. */
function deviceSummary(members: WorldMembers): string {
  const summary = members.describe("agent") as { members?: { id: string; kind?: string; name?: string; online?: boolean; words?: (string | { word: string })[] }[] };
  return (summary.members ?? []).filter((member) => member.id.startsWith("device:")).map((member) => {
    const words = (member.words ?? []).map((word) => typeof word === "string" ? word : word.word).join(", ");
    return `- ${member.id} (${member.name ?? member.id}, ${member.online ? "online" : "offline"}): ${words || "no capabilities"}`;
  }).join("\n").slice(0, 2000);
}

export async function startOwner(config: Config): Promise<Running> {
  const agents = config.agents ?? [{ id: "agent:main" as const, runtime: "dsh" as const }];
  if (agents.length !== 1 || agents[0].id !== "agent:main") throw new Error("v2 requires one real agent:main member");
  if (agents[0].runtime !== "echo" && agents[0].runtime !== "dsh") throw new Error("unsupported agent runtime");
  if (!config.stateDir) throw new Error("stateDir is required");
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
  let self: SelfMember | null = null;
  let work: WorkMember | null = null;
  let senses: SensesMember | null = null;
  let cost: CostMember | null = null;
  let stopTour: (() => void) | null = null;
  let stopFirstMeeting: (() => void) | null = null;
  let link: OwnerLink | null = null;
  let server: Awaited<ReturnType<typeof startEdgeServer>> | null = null;
  try {
    const world = new WorldRouter(ledger, async (request, caller) => {
      if (caller.remote) return Boolean(caller.pairedDeviceId && link && await link.isBrowserAuthorized(caller.pairedDeviceId));
      // A high-entropy token's digest identifies a credential without persisting it.
      // Current token membership, not a stale snapshot permission, decides recovery.
      if (caller.transportPrincipal?.startsWith("token:")) return Object.entries(tokens.api).some(([key, member]) =>
        member === caller.member && `token:${createHash("sha256").update(key).digest("hex")}` === caller.transportPrincipal);
      if (caller.transportPrincipal === "agent:main" && caller.member === "agent:main") return true;
      if (caller.transportPrincipal === "service:admin" && caller.member === "service:admin" && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:reflex" && caller.member === "service:reflex" && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:cost" && caller.member === "service:cost" && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:post" && caller.member === "service:post" && caller.local && !caller.remote) return true;
      if (caller.transportPrincipal === "service:work" && caller.member === "service:work" && caller.local && !caller.remote)
        return Boolean(work?.ownsRequestTurn(request));
      if (caller.transportPrincipal === "service:senses" && caller.member === "service:senses" && caller.local && !caller.remote &&
        request.from === "service:senses" && request.to === "agent:main" && request.word === "wake") return true;
      if (caller.transportPrincipal === "service:gate" && caller.member === "service:gate" && caller.local && !caller.remote &&
        request.from === "service:gate" && request.to === "person:owner" && request.word === "ask") return true;
      return false;
    });
    const members = new WorldMembers(world);
    members.register(new OwnerMember(config.owner ?? "Owner", ledger));
    members.register(new GateMember(ledger, world, members));
    world.enableDurableGate();
    if (agents[0].runtime === "dsh") dsh = new DshHost({ root: config.dsh!.root, home: config.dsh!.home ?? join(config.stateDir, "dsh-home"), skillsRoot: config.dsh!.skillsRoot, costRoot: config.dsh!.costRoot, env: config.dsh!.env });
    const runner = dsh ? new DshTurnRunner(dsh, join(config.stateDir, "attachments", "inbox"), config.workspaces!.home, world, () => `${deviceSummary(members)}\n${screensNow()}`) : new EchoTurnRunner();
    const mindRunner = dsh ? new DshMindRunner(dsh) : null;
    agent = createAgentMember({ ledger, router: world, stateDir: join(config.stateDir, "agent-main"), runner, name: agents[0].name,
      ...(dsh ? { mind: () => mind } : {}),
      ...(dsh ? { managedSnapshot: async () => {
        if (!self) throw new Error("managed files unavailable");
        return self.promptSnapshot();
      } } : {}),
      isPaused: () => clock!.journal.isPaused(), currentAdminPauseTargets: (requestId, turn) => admin!.currentPauseTargets(requestId, turn) });
    members.register(agent);
    const jevKey = worldConfig.reflex.jev.key_credential === "jev"
      ? process.env.OPENROUTER_API_KEY ?? process.env.TYPESAFE_API_KEY : undefined;
    const jev = worldConfig.reflex.jev.url && jevKey
      ? new JevReflexClient(worldConfig.reflex.jev.url, jevKey, worldConfig.reflex.timeout_ms) : undefined;
    reflex = new ReflexMember(world, () => agent!.inbox.activeTurn()?.id ?? null, { jev,
      threshold: worldConfig.reflex.threshold,
      context: (message, turn) => {
        const first = agent!.inbox.turnIds(turn).map((id) => ledger.byId(id)).find((item) => item?.word === "say");
        return { current_task: String(first?.body.text ?? "").slice(0, 500),
          latest_user_message: String(message.body.text ?? "").slice(0, 500),
          recent_messages: ledger.list({ before: message.seq, limit: 50 })
            .filter((item) => item.word === "say" && ["person:owner", "agent:main"].includes(item.from) && typeof item.body.text === "string")
            .slice(-2).map((item) => String(item.body.text).slice(0, 500)) };
      } });
    members.register(reflex);
    clock = new ClockMember({ ledger, router: world, dbFile: join(config.stateDir, "ash.db"),
      isPaused: () => clock!.journal.isPaused(),
      ...(hostLink ? { alarm: (at: number | null) => hostLink.scheduleAlarm(at) } : {}) });
    members.register(clock);
    work = new WorkMember({ ledger, router: world, isPaused: () => clock!.journal.isPaused(),
      flows: dsh && config.workspaces?.home ? [memoryFlow(ledger, (run) => {
        try { work!.trigger("proactive", "event", `memory:${run}`); } catch { /* a suggestion cannot undo committed memory */ }
      }), proactiveFlow(ledger), heartbeatFlow(), openerFlow(ledger), tourFlow(ledger)] : [] });
    members.register(work);
    if (dsh) senses = new SensesMember({ router: world, heartbeat: async () => (await self!.promptSnapshot()).heartbeat,
      isPaused: () => clock!.journal.isPaused(),
      opener: (slot) => { try { work!.trigger("opener", "event", slot); } catch { /* no run while paused or active */ } },
      proactive: (slot) => { try { work!.trigger("proactive", "event", slot); } catch { /* no run while paused or active */ } } });
    if (senses) members.register(senses);
    stopTour = dsh ? world.subscribe((message) => {
      if (message.from !== "agent:main" || message.to !== "person:owner" || message.kind !== "request" || message.word !== "say") return;
      try { work!.trigger("tour", "event", `reply:${createHash("sha256").update(message.id).digest("hex").slice(0, 32)}`); }
      catch { /* no duplicate daily hint */ }
    }) : null;
    if (config.workspaces?.home) {
      self = createSelfMember({ home: config.workspaces.home, stateDir: join(config.stateDir, "self"), ledger, router: world });
      members.register(self);
    }
    if (dsh && self) stopFirstMeeting = world.subscribe((message) => {
      if (message.to !== "service:post" || message.word !== "visible" || message.kind !== "event" || !message.from.startsWith("screen:")) return;
      void (async () => {
        if ((await self!.promptSnapshot()).identity !== null) return;
        await world.send({ member: "service:senses", transport: "service", transportPrincipal: "service:senses",
          local: true, remote: false, ownerProxy: false }, { to: "agent:main", kind: "request", word: "wake",
          body: { reason: "first_meeting", context: {} }, client_id: "first-meeting:v1", wait: true });
      })().catch((error) => log("first meeting wake failed", error));
    });
    if (hostLink) members.registerDevice(hostLink.device());
    const edge = new EdgeRouter(ledger, world, members, tokens, { workspaces: config.workspaces, authScopeKey: loadAuthScopeKey(config.stateDir) });
    screensNow = () => ownerScreensLine(edge.screens);
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
    post = new PostMember({ ledger, router: world, screens: edge.screens, delivery, ...(hostLink ? { host: hostLink } : {}) });
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
    if (dsh) {
      const { startedTurns, completedTurns } = ledger.agentTurnHistory("agent:main");
      await dsh.boot();
    registerWorkerMembers(members, dshWorkerModel(dsh, () => worldConfig.workers.model), ledger);
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
        protectedRoots: [config.stateDir, config.dsh!.home ?? join(config.stateDir, "dsh-home")], nativeMode: "disabled", adapter: mindRunner! });
      mind = new AgentMind(mindRunner!, () => self!.promptSnapshot());
    }
    await world.recover();
    await post.start();
    await agent.start();
    await clock.start();
    work.start();
    server = await startEdgeServer(edge, host, port);
    const address = server.address();
    const url = `http://${host}:${typeof address === "object" && address ? address.port : port}`;
    const ownerToken = Object.entries(tokens.api).find(([, member]) => member === "person:owner")![0];
    writeFileSync(join(config.stateDir, "ui-url"), `${url}/?token=${ownerToken}\n`, { mode: 0o600 });
    hostLink?.startHealthChecks(members);
    link?.enable();
    return { url, tokens, ledger, world, members, edge, link, dsh, async close() {
      stopTour?.(); stopFirstMeeting?.(); senses?.close(); cost?.close();
      link?.stop(); hostLink?.close();
      if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
      await reflex?.close(); await post?.close(); await clock?.close(); work?.close(); await agent?.close(); await mind?.close(); admin?.close(); await dsh?.close(); await self?.close(); ledger.close();
    } };
  } catch (error) {
    stopTour?.(); stopFirstMeeting?.(); senses?.close(); cost?.close();
    link?.stop(); hostLink?.close();
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
    await reflex?.close(); await post?.close(); await clock?.close(); work?.close(); await agent?.close(); await mind?.close(); admin?.close(); await dsh?.close(); await self?.close(); ledger.close();
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
