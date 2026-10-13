import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { serveLocal } from "./local";

export interface DeviceConfig { gateway: string; name: string; stateDir: string; workdir: string; installRoot?: string }

export interface DeviceDeps {
  /** Opens a runtime session (default: the real Codex, Claude Code or WorkBuddy). */
  agentFactory?: (kind: Kind, options: OpenOptions) => Promise<AgentSession>;
  detect?: typeof detectRuntimes;
  restart?: () => void;
  /** False: no relay sign-in and no pairing; the caller hands tunnels to `port` itself (tests). */
  relay?: boolean;
  kimiPorts?: number[];
  /** ego-browser's path; null: none (default: look for it). */
  ego?: string | null;
  /** How long agents keep running without the hub. */
  graceMs?: number;
}

export interface RunningDevice {
  readonly client: HandClient;
  readonly agents: AgentChannel;
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
  const stateDir = resolve(config.stateDir), workdir = resolve(config.workdir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 }); mkdirSync(workdir, { recursive: true });
  const log = (...args: unknown[]) => console.error(...args);
  const identity = await loadIdentity(stateDir);

  const runtimes = await runtimeCatalog(stateDir, dependencies.detect ?? detectRuntimes);
  const egoCommand = dependencies.ego === undefined ? await detectEgo() : dependencies.ego ?? undefined;
  const ego = egoCommand ? new Browser(stateDir, egoCommand) : null;
  const bridge = new KimiBridge();
  await bridge.start(dependencies.kimiPorts).then(() => console.error("Browser extension endpoint:", bridge.url), () => console.error("Browser extension listener unavailable"));
  const kimi = new KimiBrowser(bridge, stateDir);

  // The hand (device channel).
  let client!: HandClient;
  const workspace = createWorkspace({ workdir, stateDir, stream: (data, mime) => client.sendStream("device", data, { mime }) });
  let updating = false;
  const hand = createHand({
    workspace, ego, kimi,
    busy: () => agents.busy || workspace.busy || kimi.busy || !!ego?.running || updating,
    update: config.installRoot && dependencies.restart
      ? async (version, sha256) => {
        updating = true;
        try { const result = await installRelease(config.installRoot!, version, sha256); setTimeout(dependencies.restart!, 1000); return result; }
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
  const port = new TunnelPort();
  const line = dependencies.relay === false ? null : new GatewayLine(config.gateway, identity, port, log);
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
      call: hand.handlers.call,
      assess: hand.handlers.assess,
      agent: (frame) => void agents.handle(frame),
      welcome: (welcome) => { if (welcome.channels.agent && "accepted" in welcome.channels.agent && welcome.channels.agent.accepted) agents.opened(); },
      closed: ({ code, reason, willReconnect }) => {
        agents.closed();
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
  const declare = () => void client.setManifest(hand.manifest()).then((ack) => { if (ack.rejected.length) log("the hub did not take some capabilities", JSON.stringify(ack.rejected)); }, () => {});
  bridge.onChange(declare);

  // The Codex App's `ash-device mcp` comes in here and goes to the hub on the connection above.
  const local = await serveLocal(join(stateDir, "mcp.sock"), (tool, args, session) => agents.attached(tool, args, session), (message, error) => log(message, error ?? ""))
    .catch((error) => { log("the local door for `ash-device mcp` is not open:", error instanceof Error ? error.message : error); return null; });

  const stopAll = async () => {
    local?.close();
    client.stop(); line?.stop(); port.close();
    await agents.close(); await workspace.close(); await bridge.close(); await runtimes.close();
    finish();
  };
  try { if (line) await line.pair(stateDir, pairCode, config.name); } catch (error) { await stopAll(); throw error; }
  declare();
  client.start();
  const run = Promise.all([line ? line.run() : Promise.resolve(), finished]).then(() => {});
  return { client, agents, handId: identity.id, port, run, close: stopAll };
}

if (process.argv[1] && /(?:^|[/\\])(?:main\.ts|ash-device\.mjs)$/.test(process.argv[1])) {
  try { await deviceCli(startDevice); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
