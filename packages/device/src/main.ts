import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClientLink, fileSigner } from "./link";
import { Workspace, WORKSPACE_CAPABILITIES } from "./workspace";
import { AgentHost } from "./agents/host";
import { detectRuntimes } from "./agents/detect";
import { deviceCli } from "./cli";
import { DEVICE_VERSION, installRelease } from "./install";
import { Browser, detectEgo, EGO_CAPABILITY } from "./browser";
import { KimiBridge, KIMI_CAPABILITIES } from "./kimi";
import { runtimeCatalog } from "./agents/catalog";

export interface DeviceConfig { gateway: string; name: string; kind?: "laptop" | "server"; stateDir: string; workdir: string; installRoot?: string }
export async function startDevice(config: DeviceConfig, pairCode?: string, dependencies: { agentFactory?: ConstructorParameters<typeof AgentHost>[2]; detect?: typeof detectRuntimes; restart?: () => void } = {}): Promise<{ close(): Promise<void>; run: Promise<void> }> {
  if (!config.gateway || !config.name || !config.stateDir || !config.workdir) throw new Error("gateway, name, stateDir and workdir are required");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); mkdirSync(config.workdir, { recursive: true });
  const workspace = new Workspace(resolve(config.workdir), resolve(config.stateDir));
  const agents = new AgentHost(resolve(config.stateDir), resolve(config.workdir), dependencies.agentFactory);
  const runtimes = await runtimeCatalog(config.stateDir, dependencies.detect ?? detectRuntimes);
  const ego = await detectEgo(), browser = ego ? new Browser(resolve(config.stateDir), ego) : null;
  const kimi = new KimiBridge(resolve(config.stateDir));
  await kimi.start().then(() => console.error("Browser extension endpoint:", kimi.url), () => console.error("Browser extension listener unavailable"));
  let updating = false;
  const link = new ClientLink(config.gateway, await fileSigner(config.stateDir), {
    manifest: async () => ({ protocol: "ash-dev/1", version: DEVICE_VERSION, kind: config.kind ?? "laptop", name: config.name, workdir: resolve(config.workdir), capabilities: [...WORKSPACE_CAPABILITIES, ...(browser ? [EGO_CAPABILITY] : []), ...(kimi.online ? KIMI_CAPABILITIES : [])], agents: runtimes.get() }),
    call: (name, args, caller, signal) => updating ? Promise.resolve({ ok: false, error: "Device update is in progress", content: [] }) : name === "browser.script" && browser ? browser.call(args, caller, signal) : name.startsWith("browser.") ? kimi.call(name, args, caller, signal) : workspace.call(name, args, signal),
    stream: stream => agents.attach(stream),
    update: async (version, sha256) => {
      if (!config.installRoot || !dependencies.restart) throw new Error("This device was not installed with the service installer");
      if (updating || agents.busy || workspace.busy || browser?.running || kimi.busy) throw new Error("Finish or stop active tasks before updating");
      updating = true; agents.accepting = false;
      try { const result = await installRelease(config.installRoot, version, sha256); setTimeout(dependencies.restart, 1000); return result; }
      catch (error) { updating = false; agents.accepting = true; throw error; }
    },
  }, (...args) => console.error(...args));
  try { await link.pair(config.stateDir, pairCode, config.name); }
  catch (error) { await kimi.close(); await runtimes.close(); throw error; }
  return { run: link.run(), close: async () => { link.stop(); await agents.close(); await workspace.close(); await kimi.close(); await runtimes.close(); } };
}

if (process.argv[1] && /(?:^|[/\\])(?:main\.ts|ash-device\.mjs)$/.test(process.argv[1])) {
  try { await deviceCli(startDevice); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
