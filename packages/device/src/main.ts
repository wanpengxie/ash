import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClientLink, fileSigner } from "./link";
import { Workspace, WORKSPACE_CAPABILITIES } from "./workspace";
import { AgentHost } from "./agents/host";
import { detectRuntimes } from "./agents/detect";

export interface DeviceConfig { gateway: string; name: string; kind?: "laptop" | "server"; stateDir: string; workdir: string }
export async function startDevice(config: DeviceConfig, pairCode?: string, dependencies: { agentFactory?: ConstructorParameters<typeof AgentHost>[2]; detect?: typeof detectRuntimes } = {}): Promise<{ close(): Promise<void>; run: Promise<void> }> {
  if (!config.gateway || !config.name || !config.stateDir || !config.workdir) throw new Error("gateway, name, stateDir and workdir are required");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); mkdirSync(config.workdir, { recursive: true });
  const workspace = new Workspace(resolve(config.workdir), resolve(config.stateDir));
  const agents = new AgentHost(resolve(config.stateDir), resolve(config.workdir), dependencies.agentFactory);
  const runtimes = await (dependencies.detect ?? detectRuntimes)();
  const link = new ClientLink(config.gateway, await fileSigner(config.stateDir), {
    manifest: async () => ({ protocol: "ash-dev/1", version: "0.1.0", kind: config.kind ?? "laptop", name: config.name, capabilities: WORKSPACE_CAPABILITIES, agents: runtimes }),
    call: (name, args, _caller, signal) => workspace.call(name, args, signal),
    stream: stream => agents.attach(stream),
  }, (...args) => console.error(...args));
  await link.pair(config.stateDir, pairCode, config.name);
  return { run: link.run(), close: async () => { link.stop(); await agents.close(); await workspace.close(); } };
}

// Kept small until the installer adds service-manager commands.
if (process.argv[1] && /(?:^|[/\\])(?:main\.ts|ash-device\.mjs)$/.test(process.argv[1])) {
  const option = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
  const path = option("--config");
  if (!path) throw new Error("Usage: ash-device --config /path/device.json [--pair CODE]");
  const device = await startDevice(JSON.parse(readFileSync(path, "utf8")), option("--pair"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void device.close().then(() => process.exit(0)); });
  await device.run;
}
