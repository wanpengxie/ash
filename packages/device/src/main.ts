import type { ReadServiceOptions } from "./collaboration/read-service";
import type { DeviceControlRuntimeOptions } from "./collaboration/control-runtime";
import type { DeviceCreateRuntimeOptions } from "./collaboration/create-runtime";
import type { captureProtectedReadSource } from "./collaboration/read-source";
import { controlOperation, createOperation } from "./collaboration/capabilities";
import { DeviceMaterialRelay } from "./collaboration/relay";
import { createDeviceCollaboration } from "./collaboration/device";
export { createDeviceCollaboration } from "./collaboration/device";
import { openDeviceSetup } from "./setup/device";
import type { CapabilitySpec } from "../../sdk/src/link";
import type { CallOutcome } from "../../link/src/hand";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HelloChannels } from "../../sdk/src/link";
import { HandClient } from "../../link/src/hand";
import { createWorkspace } from "./workspace";
import { createHand } from "./hand";
import { GatewayLine, TunnelPort, helloHand, loadIdentity } from "./link";
import { detectRuntimes } from "./agents/detect";
import { runtimeCatalog } from "./agents/catalog";
import { AgentChannel } from "./agents/channel";
import { createComputerDriver } from "./agents/driver";
import { KINDS, abilitiesOf, runtimeInfos, type Kind } from "./agents/info";
import { CodexSession } from "./agents/codex";
import { ClaudeSession } from "./agents/claude";
import { WorkBuddySession } from "./agents/workbuddy";
import type { AgentSession, OpenOptions } from "./agents/types";
import { deviceCli } from "./cli";
import { DEVICE_VERSION, installRelease } from "./install";
import { Browser, detectEgo } from "./browser";
import { KimiBridge, KimiBrowser } from "./kimi";

export interface DeviceConfig { gateway: string; name: string; stateDir: string; workdir: string; installRoot?: string }

export interface DeviceDeps {
  /** Inject isolated Codex sources for protocol tests; production uses the protected source. */
  collaborationFactory?: typeof createDeviceCollaboration;
  collaboration?: Parameters<typeof createDeviceCollaboration>[2];
  readFactory?: ReadServiceOptions["factory"];
  controlTesting?: DeviceControlRuntimeOptions["testing"];
  controlDeadlineMs?: number;
  createTesting?: DeviceCreateRuntimeOptions["testing"];
  createDeadlineMs?: number;
  testing?: { sourceHome?: string; readSource?: Parameters<typeof captureProtectedReadSource>[0]["testing"]; read?: ReadServiceOptions["testing"]; detectBrowser?: typeof detectEgo; install?: typeof installRelease };
  /** Opens a runtime session (default: the real Codex, Claude Code or WorkBuddy). */
  agentFactory?: (kind: Kind, options: OpenOptions) => Promise<AgentSession>;
  detect?: typeof detectRuntimes;
  restart?: () => void;
  /** False: no relay sign-in and no pairing; the caller hands tunnels to `port` itself (tests). */
  relay?: boolean;
  relayFactory?: (url: string, identity: Awaited<ReturnType<typeof loadIdentity>>, port: TunnelPort, log: (...args: unknown[]) => void) => GatewayLine;
  kimiPorts?: number[];
  /** ego-browser's path; null: none (default: look for it). */
  ego?: string | null;
  /** How long agents keep running without the hub. */
  graceMs?: number;
}

export interface RunningDevice {
  readonly client: HandClient;
  readonly agents: AgentChannel;
  readonly collaboration: ReturnType<typeof createDeviceCollaboration>;
  readonly material: DeviceMaterialRelay | null;
  /** The hand's id: how the hub names this computer. */
  readonly handId: string;
  /** Where the hub's tunnels arrive. */
  readonly port: TunnelPort;
  /** Ends when the connection is over for good (stopped, revoked, or refused). */
  run: Promise<void>;
  close(): Promise<void>;
}

const defaultFactory = (kind: Kind, options: OpenOptions): Promise<AgentSession> =>
  ({ codex: CodexSession, claude: ClaudeSession, workbuddy: WorkBuddySession })[kind].open(options);

export async function startDevice(config: DeviceConfig, pairCode?: string, dependencies: DeviceDeps = {}): Promise<RunningDevice> {
  if (!config.name || !config.stateDir || !config.workdir || (!config.gateway && dependencies.relay !== false)) throw new Error("gateway, name, stateDir and workdir are required");
  let stateDir = resolve(config.stateDir); const workdir = resolve(config.workdir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 }); mkdirSync(workdir, { recursive: true });
  stateDir = realpathSync(stateDir);
  const log = (...args: unknown[]) => console.error(...args);
  const identity = await loadIdentity(stateDir);

  const runtimes = await runtimeCatalog(stateDir, dependencies.detect ?? detectRuntimes);
  const egoCommand = dependencies.ego === undefined ? await (dependencies.testing?.detectBrowser ?? detectEgo)() : dependencies.ego ?? undefined;
  const ego = egoCommand ? new Browser(stateDir, egoCommand) : null;
  const bridge = new KimiBridge();
  await bridge.start(dependencies.kimiPorts).then(() => console.error("Browser extension endpoint:", bridge.url), () => console.error("Browser extension listener unavailable"));
  const kimi = new KimiBrowser(bridge, stateDir);

  // The hand (device channel).
  let client!: HandClient;
  const workspace = createWorkspace({ workdir, stateDir, stream: (data, mime) => client.sendStream("device", data, { mime }) });
  let updating = false, stopping = false;
  const port = new TunnelPort();
  const context = () => port.captureContext(stateDir, () => !stopping && !updating && client?.state === "ready" && client.welcome?.channels.device?.accepted === true);
  const material = dependencies.relay === false ? null : new DeviceMaterialRelay({stateDir, gateway: config.gateway, identity});
  const collaboration = (dependencies.collaborationFactory ?? createDeviceCollaboration)(stateDir, identity.id, {readFactory: dependencies.readFactory, controlTesting: dependencies.controlTesting, controlDeadlineMs: dependencies.controlDeadlineMs, createTesting: dependencies.createTesting, createDeadlineMs: dependencies.createDeadlineMs, testing: {read: dependencies.testing?.read}, ...dependencies.collaboration, materialInputReader: material?.reader ?? dependencies.collaboration?.materialInputReader});
  let setup: Awaited<ReturnType<typeof openDeviceSetup>> | undefined;
  const hand = createHand({
    workspace, ego, kimi,
    busy: () => agents.busy || workspace.busy || kimi.busy || !!ego?.running || updating || collaboration.busy || !!setup?.changing || !!material?.busy,
    update: config.installRoot && dependencies.restart
      ? async (version, sha256) => {
        updating = true; collaboration.invalidate(); material?.invalidate();
        try { const result = await (dependencies.testing?.install ?? installRelease)(config.installRoot!, version, sha256); setTimeout(dependencies.restart!, 1000); return result; }
        catch (error) { updating = false; throw error; }
      }
      : null,
  });

  // The agent drivers (agent channel).
  const open = dependencies.agentFactory ?? defaultFactory;
  const agents = new AgentChannel({
    drivers: Object.fromEntries(KINDS.map((kind) => [kind, (report, outbound) => createComputerDriver({
      kind, report, outbound, workdir,
      open: (options) => open(kind, options),
      info: () => runtimeInfos(runtimes.get()).find((r) => r.kind === kind) ?? { kind, models: [], abilities: abilitiesOf(kind) },
    })])),
    offers: (kind) => runtimeInfos(runtimes.get()).some((r) => r.kind === kind),
    send: (frame) => { try { client.sendAgent(frame); return true; } catch { return false; } },
    graceMs: dependencies.graceMs,
    log,
  });

  // The connection.
  let line: GatewayLine | null;
  try { line = dependencies.relay === false ? null : (dependencies.relayFactory ?? ((...args) => new GatewayLine(...args)))(config.gateway, identity, port, log); }
  catch (error) {
    await Promise.allSettled([collaboration.close(), material?.close(), agents.close(), workspace.close(), bridge.close(), runtimes.close()]);
    throw error;
  }
  if (line && material) material.attach(line, collaboration.control);
  material?.work.setAdmissionFence(() => { if (stopping || updating || setup?.changing) throw new Error("Local permission setup is in progress"); return undefined; });
  // `agent` is asked for only while some runtime is installed; it is read again on every handshake.
  const channels = { device: {} } as HelloChannels;
  Object.defineProperty(channels, "agent", { enumerable: true, get: () => { const list = runtimeInfos(runtimes.get()); return list.length ? { runtimes: list } : undefined; } });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  client = new HandClient({
    url: "relay://tunnel/link",
    connector: port.connector,
    hand: helloHand(identity, { name: config.name, version: DEVICE_VERSION }),
    channels,
    sign: (nonce) => identity.signNonce(nonce),
    handlers: {
      call: async (frame, ctx): Promise<CallOutcome> => {
        if (stopping || updating || setup?.changing) return {ok: false, error: {code: "conflict", message: frame.capability === "x.ash.update" ? "Finish or stop active tasks before updating" : "Local permission setup or update is in progress"}};
        if (!frame.capability.startsWith("collaboration.")) return hand.handlers.call(frame, ctx);
        if ((controlOperation(frame.capability) || createOperation(frame.capability)) && frame.caller.member !== "person:owner") return {ok: false, error: {code: "forbidden", message: "Only the owner controls Codex conversations"}};
        if (setup?.changing) return {ok: false, error: {code: "conflict", message: "Local permission setup is in progress"}};
        let trusted; try { trusted = context(); } catch { return {ok: false, error: {code: "forbidden", message: "Hub connection is unavailable"}}; }
        if (frame.capability === "collaboration.endpoint.describe") return {ok: true, content: [], data: collaboration.manifest(trusted)};
        const result = await collaboration.call(frame.capability, frame.args, ctx.signal, trusted);
        return result.ok ? {ok: true, content: result.content, data: result.data} : {ok: false, error: {code: "failed", message: result.error ?? "Collaboration request failed", detail: result.data}};
      },
      assess: hand.handlers.assess,
      agent: (frame) => {
        if ((stopping || updating || setup?.changing) && "op" in frame && typeof frame.id === "string" && typeof frame.op === "string") {
          client.sendAgent({t: "agent", id: frame.id, op_result: frame.op, ok: false, error: {code: "conflict", message: "Local permission setup or update is in progress"}});
          return;
        }
        void agents.handle(frame);
      },
      welcome: (welcome) => { declare(); if (welcome.channels.agent && "accepted" in welcome.channels.agent && welcome.channels.agent.accepted) agents.opened(); },
      closed: ({ code, reason, willReconnect }) => {
        agents.closed(); collaboration.invalidate();
        log("hub connection closed", code, reason);
        if (willReconnect) return;
        if (code === 4003) line?.markRevoked();
        line?.stop();
        finish();
      },
      log: (message, error) => log(message, error ?? ""),
    },
  });
  port.onIdleTunnel = () => { if (client.state === "waiting") client.reconnectNow(); };
  const describe: CapabilitySpec = {name: "collaboration.endpoint.describe", description: "Describe this computer's locally authorized Codex read, control and create scopes", input_schema: {type: "object", additionalProperties: false}, effect: "read", risk: "none", timeout_ms: 30000};
  const declare = () => {
    let trusted; try { trusted = context(); } catch { /* Paired offline is a normal manifest state. */ }
    const capabilities: CapabilitySpec[] = collaboration.manifest(trusted).capabilities.map(spec => ({...spec, risk: spec.risk ?? "none", effect: spec.risk === "outward" ? "act" : spec.risk === "structure" ? "write" : "read"}));
    void client.setManifest([...hand.manifest(), describe, ...capabilities]).then((ack) => { if (ack.rejected.length) log("the hub did not take some capabilities", JSON.stringify(ack.rejected)); }, () => {});
  };
  bridge.onChange(declare);

  const stopAll = async () => {
    stopping = true; client.stop(); line?.stop(); port.close();
    const results = await Promise.allSettled([
      (async () => { await setup?.close(); await collaboration.close(); await material?.close(); })(),
      agents.close(), workspace.close(), bridge.close(), runtimes.close(),
    ]);
    finish();
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  };
  try { if (line) await line.pair(stateDir, pairCode, config.name); } catch (error) { await stopAll(); throw error; }
  try { setup = await openDeviceSetup({stateDir, nodeId: identity.id, collaboration, context, testing: {readSource: dependencies.testing?.readSource, sourceHome: dependencies.testing?.sourceHome, control: dependencies.controlTesting}, material: material ?? undefined,
    busy: () => agents.busy || workspace.busy || kimi.busy || !!ego?.running || collaboration.busy || !!material?.busy,
    current: () => { if (stopping || updating) throw new Error("Device is unavailable"); return undefined; }, changed: declare}); }
  catch (error) { await stopAll(); throw error; }
  declare();
  client.start();
  const run = Promise.all([line ? line.run() : Promise.resolve(), finished]).then(() => {});
  return { client, agents, collaboration, material, handId: identity.id, port, run, close: stopAll };
}

if (process.argv[1] && /(?:^|[/\\])(?:main\.ts|ash-device\.mjs)$/.test(process.argv[1])) {
  try { await deviceCli(startDevice); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
