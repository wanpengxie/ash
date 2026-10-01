// Production ash-api/2 entrypoint. The retired event writer is test-only.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DshHost } from "../../dsh-binding/src/host";
import { DshTurnRunner } from "../../dsh-binding/src/runtime";
import { ClientLink, fileSigner, OwnerLink } from "./gateway/link";
import { HostDeviceLink, type HostConnection } from "./host-v2";
import { createAgentMember, type AgentTurnRunner } from "./members/agent";
import { ClockMember } from "./members/clock";
import { OwnerMember } from "./members/owner";
import { PostPresenceMember } from "./members/post";
import { createSelfMember, type SelfMember } from "./members/self";
import { McpCapabilities, type McpServerSpec } from "./mcpclient";
import { EdgeRouter, startEdgeServer, type EdgeTokens } from "./server";
import { Ledger } from "./world/ledger";
import { WorldMembers } from "./world/member";
import { WorldRouter } from "./world/router";

export interface Config {
  role?: "owner" | "client";
  name?: string;
  owner?: string;
  listen?: string;
  stateDir: string;
  workspaces?: Record<string, string>;
  agents?: { id: "agent:main"; name?: string; runtime: "echo" | "dsh" }[];
  dsh?: { root: string; home?: string; env?: Record<string, string> };
  host?: HostConnection & { coreToken?: string };
  gateway?: { url: string };
  mcp?: Record<string, McpServerSpec>;
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

function echoRunner(): AgentTurnRunner {
  return { async runTurn({ rendered }, emit, signal) {
    if (signal.aborted) return { reason: "error", error: "cancelled" };
    await emit({ id: token(), text: `echo: ${rendered}` });
    return { reason: "completed" };
  } };
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
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tokens = loadTokens(config);
  const ledger = await Ledger.open(join(config.stateDir, "ash.db"));
  let agent: ReturnType<typeof createAgentMember> | null = null;
  let clock: ClockMember | null = null;
  let dsh: DshHost | null = null;
  let self: SelfMember | null = null;
  let link: OwnerLink | null = null;
  let server: Awaited<ReturnType<typeof startEdgeServer>> | null = null;
  try {
    const world = new WorldRouter(ledger, async (_request, caller) => {
      if (caller.remote) return Boolean(caller.pairedDeviceId && link && await link.isBrowserAuthorized(caller.pairedDeviceId));
      // A high-entropy token's digest identifies a credential without persisting it.
      // Current token membership, not a stale snapshot permission, decides recovery.
      if (caller.transportPrincipal?.startsWith("token:")) return Object.entries(tokens.api).some(([key, member]) =>
        member === caller.member && `token:${createHash("sha256").update(key).digest("hex")}` === caller.transportPrincipal);
      if (caller.transportPrincipal === "agent:main" && caller.member === "agent:main") return true;
      return false;
    });
    const members = new WorldMembers(world);
    members.register(new OwnerMember(config.owner ?? "Owner", ledger));
    if (agents[0].runtime === "dsh") dsh = new DshHost({ root: config.dsh!.root, home: config.dsh!.home ?? join(config.stateDir, "dsh-home"), env: config.dsh!.env });
    const runner = dsh ? new DshTurnRunner(dsh, join(config.stateDir, "attachments", "inbox"), config.workspaces!.home) : echoRunner();
    agent = createAgentMember({ ledger, router: world, stateDir: join(config.stateDir, "agent-main"), runner, name: agents[0].name,
      isPaused: () => clock!.journal.isPaused() });
    members.register(agent);
    clock = new ClockMember({ ledger, router: world, dbFile: join(config.stateDir, "ash.db"),
      isPaused: () => clock!.journal.isPaused(),
      ...(hostLink ? { alarm: (at: number | null) => hostLink.scheduleAlarm(at) } : {}) });
    members.register(clock);
    if (config.workspaces?.home) {
      self = createSelfMember({ home: config.workspaces.home, stateDir: join(config.stateDir, "self"), ledger, router: world });
      members.register(self);
    }
    if (hostLink) members.registerDevice(hostLink.device());
    const edge = new EdgeRouter(ledger, world, members, tokens, { workspaces: config.workspaces });
    members.register(new PostPresenceMember((screen) => edge.screens.markVisible(screen)));
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
    agent.prepareRecovery();
    await self?.prepareRecovery();
    await world.recover();
    if (dsh) {
      const { startedTurns, completedTurns } = ledger.agentTurnHistory("agent:main");
      await dsh.boot();
      await dsh.startMain({ members, router: world, workspace: config.workspaces!.home, managedRoot: config.workspaces!.home,
        protectedRoots: [config.stateDir, config.dsh!.home ?? join(config.stateDir, "dsh-home")], adapter: runner as DshTurnRunner,
        nativeMode: "disabled", resume: { file: join(config.stateDir, "dsh-main-session.json"), startedTurns, completedTurns } });
    }
    await agent.start();
    await clock.start();
    server = await startEdgeServer(edge, host, port);
    const address = server.address();
    const url = `http://${host}:${typeof address === "object" && address ? address.port : port}`;
    const ownerToken = Object.entries(tokens.api).find(([, member]) => member === "person:owner")![0];
    writeFileSync(join(config.stateDir, "ui-url"), `${url}/?token=${ownerToken}\n`, { mode: 0o600 });
    hostLink?.startHealthChecks(members);
    link?.enable();
    return { url, tokens, ledger, world, members, edge, link, dsh, async close() {
      link?.stop(); hostLink?.close();
      if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
      await clock?.close(); await agent?.close(); await dsh?.close(); await self?.close(); ledger.close();
    } };
  } catch (error) {
    link?.stop(); hostLink?.close();
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
    await clock?.close(); await agent?.close(); await dsh?.close(); await self?.close(); ledger.close();
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
