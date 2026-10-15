import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HelloChannels } from "../../sdk/src/link";
import { HandClient } from "../../link/src/hand";
import { secureConnector } from "../../link/src/secure";
import { createWorkspace } from "./workspace";
import { createHand } from "./hand";
import { GatewayLine, PairingFile, TunnelPort, helloHand, loadIdentity } from "./link";
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
import { CodexApp, CODEX_EVENTS, type CodexAppOptions } from "./codex-app";
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
  /** The Codex desktop app's channel: `false` leaves it out (tests), options replace the real socket and runtime. */
  codexApp?: false | CodexAppOptions;
  /** How long agents keep running without the hub. */
  graceMs?: number;
  /** Installs a release (default: from GitHub, [installRelease]); replaced in tests. */
  install?: (root: string, version: string, sha256: string) => Promise<unknown>;
}

export interface RunningDevice {
  readonly client: HandClient;
  readonly agents: AgentChannel;
  /** The hand's id: how the hub names this computer. */
  readonly handId: string;
  /** Where the hub's tunnels arrive. */
  readonly port: TunnelPort;
  /** Why the last connection could not be secured (the hub did not prove itself), if it could not. */
  readonly lastRefusal: { message: string; pairing: boolean } | null;
  /** Ends when the connection is over for good (stopped, revoked, or refused). */
  run: Promise<void>;
  close(): Promise<void>;
}

const defaultFactory = (kind: Kind, options: OpenOptions): Promise<AgentSession> =>
  ({ codex: CodexSession, claude: ClaudeSession, workbuddy: WorkBuddySession })[kind].open(options);

/** [pair]: the code and the one-time secret of the install command, on the first run only. */
export async function startDevice(config: DeviceConfig, pair?: { code: string; secret: string }, dependencies: DeviceDeps = {}): Promise<RunningDevice> {
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
  // The Codex desktop app, if it is running here: joined through its own local channel, and joined again when it restarts.
  const codex = dependencies.codexApp === false ? null : new CodexApp({
    ...dependencies.codexApp, log: (message, error) => console.error(message, error ?? ""),
    onChange: () => declare(),
    onEvent: (word, body) => { void client.emit(word, body).catch(() => {}); },
  });

  // The hand (device channel).
  let client!: HandClient;
  const workspace = createWorkspace({ workdir, stateDir, stream: (data, mime) => client.sendStream("device", data, { mime }) });
  let updating = false;
  const install = dependencies.install ?? ((root: string, version: string, sha256: string) => installRelease(root, version, sha256));
  const hand = createHand({
    workspace, ego, kimi, codex,
    busy: () => agents.busy || workspace.busy || kimi.busy || !!ego?.running || updating,
    update: config.installRoot && dependencies.restart
      ? async (version, sha256) => {
        updating = true;
        try { const result = await install(config.installRoot!, version, sha256); setTimeout(dependencies.restart!, 1000); return result; }
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

  // The connection: the relay's tunnels, secured end to end, the hub judged by the owner key pinned at pairing.
  const port = new TunnelPort();
  const pairing = new PairingFile(join(stateDir, "paired.json"));
  const line = dependencies.relay === false ? null : new GatewayLine(config.gateway, identity, port, log);
  let lastRefusal: RunningDevice["lastRefusal"] = null;
  // The hub closed with 4008 and named the release it needs (inside TLS, so it is the hub's): install it, then restart.
  let installing: Promise<boolean> | null = null;
  const platform = `${process.platform}-${process.arch}`;
  const connector = secureConnector(port.connector, {
    key: identity.link,
    trust: () => pairing.trust(),
    paired: (ownerKey) => { pairing.pin(ownerKey); log("the hub proved the pairing secret; its owner key is pinned"); },
    refused: (refusal) => { lastRefusal = { message: refusal.message, pairing: refusal.pairing }; log("the connection was not secured:", refusal.message); },
    update: (release) => {
      const sha256 = release.sha256[platform];
      if (installing) return;
      if (!config.installRoot || !sha256) { log(`the hub needs release ${release.version}, which this copy cannot install here (${config.installRoot ? `no package for ${platform}` : "not installed by install.sh"})`); return; }
      log(`the hub needs release ${release.version}: installing it from GitHub`);
      updating = true;
      installing = install(config.installRoot, release.version, sha256).then(() => true, (error) => {
        log(`installing ${release.version} failed; the current version stays`, error instanceof Error ? error.message : error);
        updating = false;
        return false;
      });
    },
  });
  // `agent` is asked for only while some runtime is installed; it is read again on every handshake.
  const channels = { device: {} } as HelloChannels;
  Object.defineProperty(channels, "agent", { enumerable: true, get: () => { const list = runtimeInfos(runtimes.get()); return list.length ? { runtimes: list } : undefined; } });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  client = new HandClient({
    url: "relay://tunnel/link",
    connector,
    hand: helloHand(identity, { name: config.name, version: DEVICE_VERSION }),
    channels,
    sign: (nonce) => identity.signNonce(nonce),
    handlers: {
      call: hand.handlers.call,
      assess: hand.handlers.assess,
      agent: (frame) => void agents.handle(frame),
      welcome: (welcome) => { lastRefusal = null; if (welcome.channels.agent && "accepted" in welcome.channels.agent && welcome.channels.agent.accepted) agents.opened(); },
      closed: ({ code, reason, willReconnect }) => {
        agents.closed();
        log("hub connection closed", code, reason);
        if (willReconnect) return;
        if (code === 4008 && installing) {
          // Restart into the new release; if it did not install, end as before (the service starts this copy again).
          void installing.then((ok) => { if (ok && dependencies.restart) dependencies.restart(); else { line?.stop(); finish(); } });
          return;
        }
        if (code === 4003) line?.markRevoked();
        line?.stop();
        finish();
      },
      log: (message, error) => log(message, error ?? ""),
    },
  });
  port.onIdleTunnel = () => { if (client.state === "waiting") client.reconnectNow(); };
  const declare = () => void client.setManifest(hand.manifest(), codex?.online ? CODEX_EVENTS : []).then((ack) => { if (ack.rejected.length) log("the hub did not take some capabilities", JSON.stringify(ack.rejected)); }, () => {});
  bridge.onChange(declare);

  // The Codex App's `ash-device mcp` comes in here and goes to the hub on the connection above.
  const local = await serveLocal(join(stateDir, "mcp.sock"), (tool, args, session) => agents.attached(tool, args, session), (message, error) => log(message, error ?? ""))
    .catch((error) => { log("the local door for `ash-device mcp` is not open:", error instanceof Error ? error.message : error); return null; });

  const stopAll = async () => {
    local?.close();
    client.stop(); line?.stop(); port.close();
    await agents.close(); await workspace.close(); await bridge.close(); await codex?.close(); await runtimes.close();
    finish();
  };
  try { if (line) await line.pair(pairing, pair, config.name); } catch (error) { await stopAll(); throw error; }
  declare();
  client.start();
  codex?.start();
  const run = Promise.all([line ? line.run() : Promise.resolve(), finished]).then(() => {});
  return { client, agents, handId: identity.id, port, get lastRefusal() { return lastRefusal; }, run, close: stopAll };
}

if (process.argv[1] && /(?:^|[/\\])(?:main\.ts|ash-device\.mjs)$/.test(process.argv[1])) {
  try { await deviceCli(startDevice); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
